// Item 828's sweep of executor.ts's helpers: the command line a worker runs,
// the action's environment, output decomposition for the record, server
// logs, and materialisation. Each row fails with one line undone. The
// command line is RUN by a real shell, not compared as a string.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import protobuf from 'protobufjs'
import type { ExecuteRequest } from '@vzn/vx'
import { execDigestFor } from '../src/cache.js'
import { commandEnvironment, materialiseOutputs, reapiExecutor } from '../src/executor.js'
import { decodeTreeWithBytes, encodeDirectory, encodeTree, sha256 } from '../src/merkle.js'
import { ReapiClient, type Directory } from '../src/wire.js'
import { CHUNKING_SUPPORTED } from './helpers/bun-floor.js'
import { startFakeReapi, type FakeReapi } from './helpers/fake-reapi.js'

let fake: FakeReapi
let root: string
beforeAll(async () => {
  fake = await startFakeReapi()
})
afterAll(() => fake.stop())
beforeEach(async () => {
  // Canonical: the command's $PWD is compared with it.
  root = realpathSync(await mkdtemp(path.join(tmpdir(), 'vx-exec-help-')))
  await mkdir(path.join(root, 'pkg', 'src'), { recursive: true })
  await writeFile(path.join(root, 'pkg', 'src', 'in.txt'), 'in\n')
  fake.onExecute = () => ({ response: { result: { exit_code: 0 } } })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const bytes = (s: string) => new TextEncoder().encode(s)
const put = (s: string) => fake.put(bytes(s))
const D = (d: { hash: string; size_bytes: number }) => ({ hash: d.hash, sizeBytes: d.size_bytes })
const refusal = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'resolved',
    (e: Error) => e.message,
  )

const request = (over: Record<string, unknown> = {}): ExecuteRequest =>
  ({
    taskId: 'pkg#gen',
    workspaceRoot: root,
    cwd: path.join(root, 'pkg'),
    command: 'gen',
    forwardArgs: [],
    env: {},
    envDefine: {},
    capture: { stdout: true, stderr: true },
    onStdout: () => undefined,
    onStderr: () => undefined,
    outputs: { files: ['out.txt'], workspaceFiles: [] },
    inputs: {
      files: [{ path: 'pkg/src/in.txt', digest: 'unused' }],
      env: [],
      runtime: [],
      workspaceRuntime: [],
      upstream: [],
      packageJsonDigest: 'x',
      configDigest: 'y',
      workspaceFingerprint: 'z',
    },
    ...over,
  }) as unknown as ExecuteRequest

async function withClient<T>(f: (client: ReapiClient, warns: string[]) => Promise<T>): Promise<T> {
  const client = new ReapiClient({ endpoint: fake.endpoint })
  try {
    return await f(client, [])
  } finally {
    client.close()
  }
}
const runOne = (req: ExecuteRequest, warns: string[] = []) =>
  withClient((client) => reapiExecutor(client, { warn: (m) => warns.push(m) }).execute(req))

const pb = new protobuf.Root()
pb.resolvePath = (_o, t) =>
  t.startsWith('google/protobuf/')
    ? path.join(
        path.dirname(
          Bun.resolveSync('protobufjs/google/protobuf/descriptor.proto', import.meta.dir),
        ),
        path.basename(t),
      )
    : path.join(import.meta.dir, '..', 'protos', t)
await pb.load('build/bazel/remote/execution/v2/remote_execution.proto')
const decoded = (type: string, hash: string) => {
  const T = pb.lookupType(`build.bazel.remote.execution.v2.${type}`)
  return T.toObject(T.decode(fake.blobs.get(hash)!)) as Record<string, unknown>
}
/** The `sh -c` script of the last Execute. */
const lastScript = (): string => {
  const call = fake.calls.filter((c) => c.method === 'Execute').at(-1)!
  const action = decoded('Action', (call.request['action_digest'] as { hash: string }).hash)
  const command = decoded('Command', (action['commandDigest'] as { hash: string }).hash)
  return (command['arguments'] as string[])[2]!
}
const sh = (script: string, cwd: string) => {
  const p = Bun.spawnSync(['/bin/sh', '-c', script], { cwd, env: { PATH: '/usr/bin:/bin' } })
  return { code: p.exitCode, out: p.stdout.toString() }
}
const PRINT = `printf '%s\\n' "$VX_ROOT" "$PATH"`

describe.if(CHUNKING_SUPPORTED)('the command line a worker runs', () => {
  it('from the project: the root is climbed to, both bin dirs lead PATH, args are quoted', async () => {
    await runOne(request({ command: PRINT, forwardArgs: ["it's", 'a b'] }))
    const { code, out } = sh(lastScript(), path.join(root, 'pkg'))
    const [vxRoot, PATH, ...args] = out.trimEnd().split('\n')
    expect(code).toBe(0)
    expect(realpathSync(vxRoot!)).toBe(root)
    expect(PATH).toBe(
      `${vxRoot}/node_modules/.bin:${path.join(root, 'pkg')}/node_modules/.bin:/usr/bin:/bin`,
    )
    expect(args).toEqual(["it's", 'a b'])
  })

  it('from the input root: the root is $PWD, and a project dir that is not there stops it', async () => {
    await runOne(
      request({ command: PRINT, outputs: { files: [], workspaceFiles: ['node_modules/.m'] } }),
    )
    const here = sh(lastScript(), root)
    expect([here.code, here.out.split('\n')[0]]).toEqual([0, root])
    const elsewhere = await mkdtemp(path.join(tmpdir(), 'vx-exec-help-nopkg-'))
    try {
      expect(sh(lastScript(), elsewhere)).toEqual({ code: 1, out: '' })
    } finally {
      await rm(elsewhere, { recursive: true, force: true })
    }
  })
})

describe('the action’s environment', () => {
  it('an unset input stays unset; a define wins over an input of its name', () => {
    const inputs = {
      ...request().inputs!,
      env: [
        { name: 'A', value: '1' },
        { name: 'UNSET', value: undefined },
        { name: 'D', value: 'from the host' },
      ],
    }
    expect(commandEnvironment(inputs as never, { D: 'defined' })).toEqual([
      { name: 'A', value: '1' },
      { name: 'D', value: 'defined' },
    ])
  })
})

describe.if(CHUNKING_SUPPORTED)('the record’s output directories', () => {
  const file = (name: string) => ({ name, digest: put(name), is_executable: false })
  const dir = (files: string[], dirs: Record<string, Directory> = {}): Directory => ({
    files: files.map(file),
    directories: Object.entries(dirs).map(([name, d]) => ({
      name,
      digest: sha256(encodeDirectory(d)),
    })),
    symlinks: [],
  })
  const recordOf = (key: string) =>
    (
      fake.actions.get(execDigestFor(key).hash) as {
        output_directories: { path: string; tree_digest: { hash: string } }[]
      }
    ).output_directories
  const executeReturning = (dirPath: string, tree: { hash: string; size_bytes: number }) => {
    fake.onExecute = () => ({
      response: {
        result: { exit_code: 0, output_directories: [{ path: dirPath, tree_digest: D(tree) }] },
      },
    })
  }
  const run = (key: string, files: string[], warns: string[] = []) =>
    runOne(request({ cacheKey: key, outputs: { files, workspaceFiles: [] } }), warns)

  it('a literal glob is recorded whole without reading its Tree', async () => {
    const unstored = sha256(bytes('a tree nobody stored'))
    executeReturning('dist', unstored)
    const warns: string[] = []
    // The output directory is not materialised: nothing is on disk to read.
    await refusal(run('k-literal', ['dist'], warns))
    expect(warns).toEqual([])
    expect(recordOf('k-literal').map((d) => d.path)).toEqual(['pkg/dist'])
  })

  it('an unreadable Tree, or one with no root, is recorded whole', async () => {
    const unstored = sha256(bytes('another tree nobody stored'))
    executeReturning('mods', unstored)
    const warns: string[] = []
    await refusal(run('k-unread', ['mods/*/gen'], warns))
    expect(warns).toContain('vx/reapi: could not read the Tree for pkg/mods — recording it whole')
    expect(recordOf('k-unread').map((d) => d.path)).toEqual(['pkg/mods'])
    executeReturning('mods', fake.put(new Uint8Array()))
    await refusal(run('k-rootless', ['mods/*/gen']))
    expect(recordOf('k-rootless').map((d) => d.path)).toEqual(['pkg/mods'])
  })

  it('a glob that matches nothing, or has a partial wildcard, is recorded whole', async () => {
    // `x*` names a directory literally called so: a partial wildcard is not
    // decomposed even where a name would match it character for character.
    const gen = dir(['g'])
    const star = dir([], { gen })
    const top = dir([], { 'x*': star })
    executeReturning('mods', fake.put(encodeTree(top, [star, gen])))
    await run('k-none', ['mods/*/none'])
    expect(recordOf('k-none').map((d) => d.path)).toEqual(['pkg/mods'])
    await run('k-partial', ['mods/x*/gen'])
    expect(recordOf('k-partial').map((d) => d.path)).toEqual(['pkg/mods'])
  })

  it('each match once, its Tree carrying every descendant and a hole skipped, uploaded', async () => {
    const deeper = dir(['d'])
    const deep = dir([], { deeper })
    const hole = dir(['never stored in the Tree'])
    // `a`'s gen has a hole first and a real child after it.
    const genA = dir(['ga'], { '0-hole': hole, deep })
    const genB = dir(['gb'])
    const a = dir([], { gen: genA })
    const b = dir([], { gen: genB })
    const top = dir([], { a, b })
    executeReturning('mods', fake.put(encodeTree(top, [a, b, genA, genB, deep, deeper])))
    // The decomposition's own probe fails: an upload is the safe answer.
    const planned = fake.onExecute
    fake.onExecute = (req, method) => {
      fake.fail('FindMissingBlobs', 7)
      return planned(req, method)
    }
    // Both globs collapse to `mods`; the second names the same matches again.
    await refusal(run('k-each', ['mods/*/gen', 'mods/*/*']))
    const recorded = recordOf('k-each')
    expect(recorded.map((d) => d.path)).toEqual(['pkg/mods/a/gen', 'pkg/mods/b/gen'])
    const treeA = decodeTreeWithBytes(fake.blobs.get(recorded[0]!.tree_digest.hash)!)
    expect(treeA.children.map((c) => c.files.map((f) => f.name))).toEqual([[], ['d']])
  })
})

describe.if(CHUNKING_SUPPORTED)('server logs on a failed execution', () => {
  it('only human-readable logs up to 64 KiB are read, and one that cannot be read is left out', async () => {
    const logs = {
      hidden: { digest: D(put('not for people')), human_readable: false },
      big: { digest: D(put('x'.repeat(64 * 1024 + 1))), human_readable: true },
      first: { digest: D(put('first log')), human_readable: true },
      second: { digest: D(put('second log')), human_readable: true },
    }
    fake.onExecute = () => {
      fake.fail('Read', 7) // the first log read
      return { response: { status: { code: 13, message: 'boom' }, server_logs: logs } }
    }
    const message = await refusal(runOne(request()))
    expect(message.startsWith('vx/reapi: pkg#gen execution failed: boom\n--- server log ')).toBe(
      true,
    )
    expect(message.match(/--- server log/g)?.length).toBe(1)
    expect(message).not.toMatch(/not for people|xxxx/)
  })
})

describe.if(CHUNKING_SUPPORTED)('materialising outputs', () => {
  const big = 'b'.repeat(1024 * 1024 + 1)
  const batchedHashes = () =>
    fake.calls
      .filter((c) => c.method === 'BatchReadBlobs')
      .flatMap((c) => (c.request['digests'] as { hash: string }[]).map((d) => d.hash))
  const materialise = (result: Record<string, unknown>, files = ['**']) =>
    withClient((client) =>
      materialiseOutputs(
        client,
        request({ outputs: { files, workspaceFiles: [] } }),
        result as never,
        () => undefined,
      ),
    )

  it('a file past 1 MiB is not batched; the executable bit lands; a symlink replaces a file', async () => {
    const d = put(big)
    const tool = put('#!/bin/sh')
    await mkdir(path.join(root, 'pkg'), { recursive: true })
    await writeFile(path.join(root, 'pkg', 'link'), 'stale')
    await materialise(
      {
        output_files: [
          { path: 'big.txt', digest: d, is_executable: false },
          { path: 'tool', digest: tool, is_executable: true },
        ],
        output_symlinks: [{ path: 'link', target: 'tool' }],
      },
      ['big.txt', 'tool', 'link'],
    )
    expect(batchedHashes()).not.toContain(d.hash)
    expect((await readFile(path.join(root, 'pkg', 'big.txt'), 'utf8')).length).toBe(big.length)
    expect((await stat(path.join(root, 'pkg', 'tool'))).mode & 0o777).toBe(0o755)
    expect(await readlink(path.join(root, 'pkg', 'link'))).toBe('tool')
  })

  it('a Tree: big files unbatched, the executable bit and unix mode, a symlink over a file', async () => {
    const d = put(big)
    const x = put('run me')
    const m = put('mode me')
    const top: Directory = {
      files: [
        { name: 'big.txt', digest: d, is_executable: false },
        { name: 'm', digest: m, is_executable: false, node_properties: { unixMode: 0o640 } },
        { name: 'x', digest: x, is_executable: true },
      ],
      directories: [],
      symlinks: [{ name: 'link', target: 'x' }],
    }
    await mkdir(path.join(root, 'pkg', 'dist'), { recursive: true })
    await writeFile(path.join(root, 'pkg', 'dist', 'link'), 'stale')
    await materialise(
      { output_directories: [{ path: 'dist', tree_digest: fake.put(encodeTree(top, [])) }] },
      ['dist/**'],
    )
    const at = (n: string) => path.join(root, 'pkg', 'dist', n)
    expect(batchedHashes()).not.toContain(d.hash)
    expect([(await stat(at('x'))).mode & 0o777, (await stat(at('m'))).mode & 0o777]).toEqual([
      0o755, 0o640,
    ])
    expect((await lstat(at('link'))).isSymbolicLink()).toBe(true)
  })

  it('under a literal capture, a missing Tree, a rootless one, a missing child and a missing file each refuse', async () => {
    const tree = (top: Directory, children: Directory[] = []) => fake.put(encodeTree(top, children))
    const child: Directory = { files: [], directories: [], symlinks: [{ name: 'l', target: 't' }] }
    const cases: [string, { hash: string; size_bytes: number }][] = [
      ['tree', sha256(bytes('no such tree'))],
      ['tree (no root directory)', fake.put(new Uint8Array())],
      [
        `${path.join(root, 'pkg', 'dist', 'sub')} (not present in the Tree blob)`,
        tree({
          files: [],
          directories: [{ name: 'sub', digest: sha256(encodeDirectory(child)) }],
          symlinks: [],
        }),
      ],
      [
        path.join(root, 'pkg', 'dist', 'gone'),
        tree({
          files: [{ name: 'gone', digest: sha256(bytes('evicted')), is_executable: false }],
          directories: [],
          symlinks: [],
        }),
      ],
    ]
    for (const [what, digest] of cases) {
      expect(
        await refusal(
          materialise({ output_directories: [{ path: 'dist', tree_digest: digest }] }, ['dist/**']),
        ),
      ).toStartWith(`vx/reapi: pkg#gen declared output ${what} is missing from the CAS (`)
    }
  })
})
