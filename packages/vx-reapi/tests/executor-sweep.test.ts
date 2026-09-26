// Item 827's sweep of executor.ts's run path: each row fails with one line
// of `reapiExecutor` undone. The fake (helpers/fake-reapi.ts) scripts what
// each Execute answers; its CAS holds what a worker would have uploaded.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as grpc from '@grpc/grpc-js'
import protobuf from 'protobufjs'
import type { ExecuteRequest } from '@vzn/vx'
import { execDigestFor } from '../src/cache.js'
import { reapiExecutor } from '../src/executor.js'
import { concat, decodeDirectory, encodeDirectory, encodeTree, sha256 } from '../src/merkle.js'
import { reapi } from '../src/index.js'
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
  root = await mkdtemp(path.join(tmpdir(), 'vx-exec-sweep-'))
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

async function withExecutor<T>(
  f: (
    run: (req: ExecuteRequest) => ReturnType<ReturnType<typeof reapiExecutor>['execute']>,
    warns: string[],
  ) => Promise<T>,
  opts: Record<string, unknown> = {},
): Promise<T> {
  const client = new ReapiClient({ endpoint: fake.endpoint })
  const warns: string[] = []
  const ex = reapiExecutor(client, { warn: (m) => warns.push(m), ...opts })
  try {
    return await f((req) => ex.execute(req), warns)
  } finally {
    client.close()
  }
}
const executes = () => fake.calls.filter((c) => c.method === 'Execute').length
/** A rejection's message. Not `expect(…).rejects`: under bun test that held a
 *  call needing gRPC I/O until its deadline (15 s here, 30 s in 823's row). */
const refusal = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'resolved',
    (e: Error) => e.message,
  )

// The Action the last Execute named, decoded by protobufjs.
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
const lastAction = () => {
  const call = fake.calls.filter((c) => c.method === 'Execute').at(-1)!
  const digest = call.request['action_digest'] as { hash: string }
  return pb
    .lookupType('build.bazel.remote.execution.v2.Action')
    .toObject(
      pb.lookupType('build.bazel.remote.execution.v2.Action').decode(fake.blobs.get(digest.hash)!),
      {
        longs: Number,
        bytes: String,
      },
    ) as Record<string, unknown>
}

describe.if(CHUNKING_SUPPORTED)('the execution record', () => {
  it('a record whose blobs exist is replayed: no Execute, stdout and outputs restored', async () => {
    const out = put('from the record')
    const stdout = put('recorded stdout')
    fake.actions.set(execDigestFor('k-hit').hash, {
      exit_code: 0,
      stdout_digest: stdout,
      output_files: [
        { path: 'pkg/out.txt', digest: out, is_executable: false },
        // Empty: no blob stored, and its size reads back as the string "0".
        { path: 'pkg/empty.txt', digest: sha256(new Uint8Array()), is_executable: false },
      ],
    })
    let printed = ''
    const before = executes()
    const res = await withExecutor((run) =>
      run(request({ cacheKey: 'k-hit', onStdout: (c: string) => (printed += c) })),
    )
    expect(executes()).toBe(before)
    expect([res.exitCode, res.stdout, printed]).toEqual([0, 'recorded stdout', 'recorded stdout'])
    expect(await readFile(path.join(root, 'pkg', 'out.txt'), 'utf8')).toBe('from the record')
    expect(await readFile(path.join(root, 'pkg', 'empty.txt'), 'utf8')).toBe('')
  })

  it('a record with a blob gone, an unreadable record, and --force each execute', async () => {
    fake.actions.set(execDigestFor('k-gone').hash, {
      exit_code: 0,
      output_files: [
        { path: 'pkg/out.txt', digest: sha256(bytes('evicted')), is_executable: false },
      ],
    })
    await withExecutor(async (run, warns) => {
      const before = executes()
      await run(request({ cacheKey: 'k-gone' }))
      fake.fail('GetActionResult', 7) // PERMISSION_DENIED
      await run(request({ cacheKey: 'k-unreadable' }))
      fake.actions.set(execDigestFor('k-forced').hash, { exit_code: 0 })
      await run(request({ cacheKey: 'k-forced', refresh: true }))
      expect(executes()).toBe(before + 3)
      expect(
        warns.some((w) => w.startsWith('vx/reapi: pkg#gen could not read its execution record (')),
      ).toBe(true)
    })
  })

  it('a replay whose stdout Read fails transiently executes instead of failing the task', async () => {
    fake.actions.set(execDigestFor('k-stdout').hash, {
      exit_code: 0,
      stdout_digest: put('recorded stdout'),
    })
    let printed = ''
    await withExecutor(async (run, warns) => {
      const before = executes()
      fake.fail('Read', grpc.status.UNAVAILABLE, 1)
      const res = await refusal(
        run(request({ cacheKey: 'k-stdout', onStdout: (c: string) => (printed += c) })),
      )
      expect([res, executes() - before, printed]).toEqual(['resolved', 1, ''])
      expect(
        warns.filter((w) =>
          w.startsWith('vx/reapi: pkg#gen could not replay its execution record ('),
        ),
      ).toHaveLength(1)
    })
  })

  it('a replay that fails part-way takes back what it created, and only that', async () => {
    const tree = put('never read')
    fake.actions.set(execDigestFor('k-part').hash, {
      exit_code: 0,
      stdout_raw: bytes('recorded stdout'),
      output_files: [
        { path: 'pkg/out.txt', digest: put('replayed'), is_executable: false },
        { path: 'pkg/fresh/deep.txt', digest: put('replayed deep'), is_executable: false },
        // A whole-tree capture's record lists the inputs too; they were on
        // disk before the replay and must survive its undo.
        { path: 'pkg/src/in.txt', digest: put('in\n'), is_executable: false },
      ],
      output_directories: [{ path: 'pkg/gen', tree_digest: tree }],
    })
    let printed = ''
    await withExecutor(async (run) => {
      // The tree is the replay's first ByteStream Read, after the files landed.
      fake.fail('Read', grpc.status.UNAVAILABLE, 1)
      const res = await run(
        request({
          cacheKey: 'k-part',
          outputs: { files: ['out.txt', 'fresh', 'gen'], workspaceFiles: [] },
          onStdout: (c: string) => (printed += c),
        }),
      )
      expect(res.exitCode).toBe(0)
    })
    const on = async (rel: string) => Bun.file(path.join(root, 'pkg', rel)).exists()
    expect({
      in: await readFile(path.join(root, 'pkg', 'src', 'in.txt'), 'utf8'),
      out: await on('out.txt'),
      deep: await on('fresh/deep.txt'),
      fresh: await stat(path.join(root, 'pkg', 'fresh')).then(
        () => true,
        () => false,
      ),
      printed,
    }).toEqual({ in: 'in\n', out: false, deep: false, fresh: false, printed: '' })
  })

  it('a remote-only replay restores nothing; a deferred one hands core the restore', async () => {
    const out = put('deferred bytes')
    fake.actions.set(execDigestFor('k-def').hash, {
      exit_code: 0,
      output_files: [{ path: 'pkg/out.txt', digest: out, is_executable: false }],
    })
    await withExecutor(async (run) => {
      await run(request({ cacheKey: 'k-def', remoteOnly: true }))
      expect(await Bun.file(path.join(root, 'pkg', 'out.txt')).exists()).toBe(false)
      const res = await run(request({ cacheKey: 'k-def', download: 'deferred' }))
      expect(await Bun.file(path.join(root, 'pkg', 'out.txt')).exists()).toBe(false)
      expect(res.outputs?.kind).toBe('deferred')
      await (res.outputs as { materialize: () => Promise<void> }).materialize()
      expect(await readFile(path.join(root, 'pkg', 'out.txt'), 'utf8')).toBe('deferred bytes')
    })
  })
})

describe.if(CHUNKING_SUPPORTED)('the Action it builds', () => {
  it('platform, timeout, salt and priority reach the Action and the request', async () => {
    await withExecutor(
      async (run) => {
        await run(request({ timeoutMs: 1500 }))
      },
      { platform: { OSFamily: 'linux', 'container-image': 'x' }, salt: 's1', priority: 4 },
    )
    const action = lastAction()
    expect({
      timeout: (action['timeout'] as { seconds: number }).seconds,
      salt: action['salt'],
      platform: (action['platform'] as { properties: { name: string }[] }).properties.map(
        (p) => p.name,
      ),
    }).toEqual({
      timeout: 2,
      salt: Buffer.from('s1').toString('base64'),
      platform: ['OSFamily', 'container-image'],
    })
    const req = fake.calls.filter((c) => c.method === 'Execute').at(-1)!.request
    expect((req['execution_policy'] as { priority: number }).priority).toBe(4)
  })

  it('the reapi() plugin hands its platform and execute timeout to the executor', async () => {
    fake.caps.execEnabled = true
    let release!: () => void
    fake.onExecute = () => ({
      stages: ['EXECUTING'],
      hold: new Promise<void>((r) => {
        release = r
      }),
    })
    const p = reapi({
      endpoint: fake.endpoint,
      execute: true,
      platform: { pool: 'p1' },
      executeTimeoutMs: 200,
    })
    const ex = (await p.executor!({ warn: () => undefined } as never))!
    try {
      const refused = await ex.execute(request()).then(
        () => 'resolved',
        (e: Error) => e.message,
      )
      expect(refused).toContain('was still executing 200ms after the worker started it')
      expect(
        (lastAction()['platform'] as { properties: { name: string; value: string }[] }).properties,
      ).toEqual([{ name: 'pool', value: 'p1' }])
    } finally {
      release()
      await p.teardown?.()
    }
  })
})

describe.if(CHUNKING_SUPPORTED)('what the response means', () => {
  it('an operation error, a failed status with its logs, and a response with no result each refuse', async () => {
    const log = put('worker said no')
    await withExecutor(async (run) => {
      fake.onExecute = () => ({
        response: { status: { code: 13, message: 'boom' }, message: 'why', serverLogs: {} },
      })
      expect(await refusal(run(request()))).toContain(
        'vx/reapi: pkg#gen execution failed: boom — why',
      )
      fake.onExecute = () => ({
        response: {
          status: { code: 13, message: 'boom' },
          server_logs: { worker: { digest: D(log), human_readable: true } },
        },
      })
      expect(await refusal(run(request()))).toContain('--- server log worker ---\nworker said no')
      fake.onExecute = () => ({ response: { message: 'nothing' } })
      expect(await refusal(run(request()))).toContain(
        'vx/reapi: pkg#gen returned no ActionResult: nothing',
      )
    })
  })

  it('stdout and stderr are delivered even when capture keeps no copy; the worker is reported', async () => {
    fake.onExecute = () => ({
      response: {
        result: {
          exit_code: 3,
          stdout_raw: bytes('out'),
          stderr_digest: D(put('err')),
          execution_metadata: { worker: 'w-9' },
        },
      },
    })
    let out = ''
    let err = ''
    const res = await withExecutor((run) =>
      run(
        request({
          capture: { stdout: false, stderr: false },
          onStdout: (c: string) => (out += c),
          onStderr: (c: string) => (err += c),
        }),
      ),
    )
    expect([res.exitCode, res.stdout, res.stderr, out, err, res.where]).toEqual([
      3,
      '',
      '',
      'out',
      'err',
      'w-9',
    ])
  })

  it('a success is recorded under the key, paths workspace-relative, with its stdout', async () => {
    const out = put('made')
    fake.onExecute = () => ({
      response: {
        result: {
          exit_code: 0,
          stdout_raw: bytes('said'),
          output_files: [{ path: 'out.txt', digest: D(out) }],
        },
      },
    })
    await withExecutor((run) => run(request({ cacheKey: 'k-rec' })))
    const record = fake.actions.get(execDigestFor('k-rec').hash) as {
      output_files: { path: string }[]
      stdout_digest: { hash: string }
    }
    expect(record.output_files.map((f) => f.path)).toEqual(['pkg/out.txt'])
    expect(record.stdout_digest.hash).toBe(sha256(bytes('said')).hash)
  })
})

describe.if(CHUNKING_SUPPORTED)('upstream outputs', () => {
  const upstream = (over: Record<string, unknown>) => ({
    taskId: 'lib#build',
    hash: 'up-key',
    outputs: ['lib/dist/a.js'],
    ...over,
  })

  it('outputs on disk go in the tree; a partial set warns and uses what is here', async () => {
    await mkdir(path.join(root, 'lib', 'dist'), { recursive: true })
    await writeFile(path.join(root, 'lib', 'dist', 'a.js'), 'a')
    await withExecutor(async (run, warns) => {
      const base = request()
      await run(
        request({
          inputs: {
            ...base.inputs!,
            upstream: [upstream({ outputs: ['lib/dist/a.js', 'lib/dist/b.js'] })],
          },
        }),
      )
      expect(warns).toContain(
        'vx/reapi: lib#build has 1 output(s) recorded but missing on disk — grafting is not possible for a partial set, using what is here',
      )
    })
  })

  it('a remote upstream grafts from its record; an evicted blob or tree refuses', async () => {
    const a = put('remote a')
    fake.actions.set(execDigestFor('up-key').hash, {
      exit_code: 0,
      output_files: [{ path: 'lib/dist/a.js', digest: a, is_executable: true }],
    })
    await withExecutor(async (run) => {
      const base = request()
      const withUp = (hash: string) =>
        request({ inputs: { ...base.inputs!, upstream: [upstream({ hash })] } })
      await run(withUp('up-key'))
      fake.actions.set(execDigestFor('up-gone').hash, {
        exit_code: 0,
        output_files: [
          { path: 'lib/dist/a.js', digest: sha256(bytes('evicted')), is_executable: false },
        ],
      })
      expect(await refusal(run(withUp('up-gone')))).toContain(
        'vx/reapi: upstream lib#build outputs evicted from the remote store (1 blob(s)) and never materialised locally',
      )
    })
  })

  it('a grafted upstream Tree whose child bytes are not ours still ships a whole input root', async () => {
    const file = { name: 'f', digest: sha256(new Uint8Array()), is_executable: false }
    const raw = concat([
      encodeDirectory({ files: [], directories: [], symlinks: [{ name: 'l', target: 't' }] }),
      encodeDirectory({ files: [file], directories: [], symlinks: [] }),
    ])
    const treeRoot: Directory = {
      files: [],
      directories: [{ name: 'sub', digest: sha256(raw) }],
      symlinks: [],
    }
    const treeBlob = concat([encodeTree(treeRoot, []), new Uint8Array([0x12, raw.length]), raw])
    const tree = fake.put(treeBlob)
    fake.actions.set(execDigestFor('up-tree').hash, {
      exit_code: 0,
      output_directories: [{ path: 'lib/dist', tree_digest: tree }],
    })
    await withExecutor(async (run) => {
      const base = request()
      await run(
        request({
          inputs: { ...base.inputs!, upstream: [upstream({ hash: 'up-tree', outputs: [] })] },
        }),
      )
    })
    const action = lastAction() as { inputRootDigest: { hash: string } }
    const missing: string[] = []
    const walk = (hash: string, at: string) => {
      const data = fake.blobs.get(hash)
      if (data === undefined) return void missing.push(at)
      for (const d of decodeDirectory(data).directories) walk(d.digest.hash, `${at}/${d.name}`)
    }
    walk(action.inputRootDigest.hash, '')
    expect(missing).toEqual([])
  })
})

describe.if(CHUNKING_SUPPORTED)('materialising an output directory', () => {
  it('a Tree whose child bytes are not ours materialises whole', async () => {
    const data = put('deep')
    const raw = concat([
      encodeDirectory({ files: [], directories: [], symlinks: [{ name: 'l', target: 't' }] }),
      encodeDirectory({
        files: [{ name: 'f.txt', digest: data, is_executable: false }],
        directories: [],
        symlinks: [],
      }),
    ])
    const treeRoot: Directory = {
      files: [],
      directories: [{ name: 'sub', digest: sha256(raw) }],
      symlinks: [],
    }
    const tree = fake.put(
      concat([encodeTree(treeRoot, []), new Uint8Array([0x12, raw.length]), raw]),
    )
    fake.onExecute = () => ({
      response: {
        result: { exit_code: 0, output_directories: [{ path: 'dist', tree_digest: D(tree) }] },
      },
    })
    await withExecutor((run) =>
      run(request({ outputs: { files: ['dist/**'], workspaceFiles: [] } })),
    )
    expect(await readFile(path.join(root, 'pkg', 'dist', 'sub', 'f.txt'), 'utf8')).toBe('deep')
  })
})

const lastCommand = () => {
  const action = lastAction() as { commandDigest: { hash: string } }
  const T = pb.lookupType('build.bazel.remote.execution.v2.Command')
  return T.toObject(T.decode(fake.blobs.get(action.commandDigest.hash)!)) as Record<string, unknown>
}
/** Every entry of the last Execute's input root, by path. */
const inputRoot = () => {
  const action = lastAction() as { inputRootDigest: { hash: string } }
  const entries = new Map<string, { is_executable: boolean } | 'dir'>()
  const walk = (hash: string, at: string) => {
    // An empty Directory is the empty blob, which the spec says is never uploaded.
    const dir = decodeDirectory(fake.blobs.get(hash) ?? new Uint8Array())
    for (const f of dir.files) entries.set(at + f.name, f)
    for (const d of dir.directories) {
      entries.set(at + d.name, 'dir')
      walk(d.digest.hash, `${at}${d.name}/`)
    }
  }
  walk(action.inputRootDigest.hash, '')
  return entries
}
const exists = (rel: string) =>
  readFile(path.join(root, rel)).then(
    () => true,
    () => false,
  )

describe.if(CHUNKING_SUPPORTED)('the execution record, what a replay hands back', () => {
  it('a probe that cannot run is a miss; a replay delivers stdout but keeps no copy when capture says so', async () => {
    const out = put('probed')
    const said = put('said before')
    fake.actions.set(execDigestFor('k-probe').hash, {
      exit_code: 0,
      stdout_digest: said,
      output_files: [{ path: 'pkg/out.txt', digest: out, is_executable: false }],
    })
    await withExecutor(async (run) => {
      const before = executes()
      let printed = ''
      const res = await run(
        request({
          cacheKey: 'k-probe',
          capture: { stdout: false, stderr: true },
          onStdout: (c: string) => (printed += c),
        }),
      )
      expect([executes(), res.stdout, printed]).toEqual([before, '', 'said before'])
      fake.fail('FindMissingBlobs', 7) // PERMISSION_DENIED: not retried
      await run(request({ cacheKey: 'k-probe' }))
      expect(executes()).toBe(before + 1)
    })
  })

  it('a remote-only replay asked to defer still hands core nothing to restore', async () => {
    fake.actions.set(execDigestFor('k-only').hash, {
      exit_code: 0,
      output_files: [{ path: 'pkg/out.txt', digest: put('only'), is_executable: false }],
    })
    const res = await withExecutor((run) =>
      run(request({ cacheKey: 'k-only', remoteOnly: true, download: 'deferred' })),
    )
    expect([res.outputs, await exists('pkg/out.txt')]).toEqual([undefined, false])
  })
})

describe.if(CHUNKING_SUPPORTED)('where an executed task’s outputs go', () => {
  beforeEach(() => {
    const made = put('made')
    fake.onExecute = () => ({
      response: { result: { exit_code: 0, output_files: [{ path: 'out.txt', digest: D(made) }] } },
    })
  })

  it('remote-only: not onto this disk, and nothing deferred', async () => {
    await withExecutor(async (run) => {
      const only = await run(request({ remoteOnly: true }))
      const onlyDeferred = await run(request({ remoteOnly: true, download: 'deferred' }))
      expect([only.outputs, onlyDeferred.outputs, await exists('pkg/out.txt')]).toEqual([
        undefined,
        undefined,
        false,
      ])
    })
  })

  it('deferred: not yet, and the closure core gets restores them', async () => {
    await withExecutor(async (run) => {
      const res = await run(request({ download: 'deferred' }))
      expect(await exists('pkg/out.txt')).toBe(false)
      await (res.outputs as { materialize: () => Promise<void> }).materialize()
    })
    expect(await readFile(path.join(root, 'pkg', 'out.txt'), 'utf8')).toBe('made')
  })

  it('a root-anchored output runs at the input root, keeps the project dir, lands at the root', async () => {
    await mkdir(path.join(root, 'shared'), { recursive: true })
    await writeFile(path.join(root, 'shared', 'x.txt'), 'x')
    const mod = put('module')
    fake.onExecute = () => ({
      response: {
        result: { exit_code: 0, output_files: [{ path: 'node_modules/.m', digest: D(mod) }] },
      },
    })
    const base = request()
    await withExecutor((run) =>
      run(
        request({
          outputs: { files: [], workspaceFiles: ['node_modules/.m'] },
          inputs: { ...base.inputs!, files: [{ path: 'shared/x.txt', digest: 'unused' }] },
        }),
      ),
    )
    expect(lastCommand()['workingDirectory'] ?? '').toBe('')
    expect(inputRoot().get('pkg')).toBe('dir')
    expect(await readFile(path.join(root, 'node_modules', '.m'), 'utf8')).toBe('module')
  })
})

describe.if(CHUNKING_SUPPORTED)('the Action it builds, beyond the Action', () => {
  it('the Command carries the platform too, and every call names the action', async () => {
    await withExecutor((run) => run(request()), { platform: { OSFamily: 'linux' } })
    const properties = (lastCommand()['platform'] as { properties: unknown[] }).properties
    expect(properties).toEqual([{ name: 'OSFamily', value: 'linux' }])
    const call = fake.calls.filter((c) => c.method === 'Execute').at(-1)!
    const actionHash = (call.request['action_digest'] as { hash: string }).hash
    const header = call.metadata.get('build.bazel.remote.execution.v2.requestmetadata-bin')[0]
    expect(Buffer.from(header as Buffer).includes(actionHash)).toBe(true)
  })

  it('a task’s own timeout bounds the stall before the plugin’s', async () => {
    let release!: () => void
    fake.onExecute = () => ({
      stages: ['EXECUTING'],
      hold: new Promise<void>((r) => {
        release = r
      }),
    })
    try {
      const refused = await withExecutor(
        (run) =>
          refusal(
            Promise.race([
              run(request({ timeoutMs: 200 })),
              Bun.sleep(5000).then(() => {
                throw new Error('the task’s timeout was not the bound')
              }),
            ]),
          ),
        { executeTimeoutMs: 60_000 },
      )
      expect(refused).toContain('was still executing 200ms after the worker started it')
    } finally {
      release()
    }
  })

  it('a stall that fires during the re-attach backoff still bounds the task', async () => {
    // Execute and the first WaitExecution each drop at once, so the stall
    // (200 ms from Execute's EXECUTING) fires inside the second backoff,
    // 100 → 500 ms; the WaitExecution after it would hold forever. Heard in
    // the backoff it lands near 200 ms; heard only when the backoff ends,
    // near 500.
    let release!: () => void
    const forever = new Promise<void>((r) => {
      release = r
    })
    let waits = 0
    let t0 = 0
    fake.onExecute = (_r, method) => {
      if (method === 'Execute') t0 = Date.now()
      return method === 'Execute' || waits++ === 0
        ? { stages: ['EXECUTING'], error: { code: grpc.status.UNAVAILABLE, details: 'drop' } }
        : { stages: ['EXECUTING'], hold: forever }
    }
    try {
      const refused = await withExecutor(
        (run) =>
          refusal(
            Promise.race([
              run(request()),
              Bun.sleep(1000).then(() => {
                throw new Error('the stall was lost in the backoff')
              }),
            ]),
          ),
        { executeTimeoutMs: 200 },
      )
      const elapsed = Date.now() - t0
      expect(refused).toContain('was still executing 200ms after the worker started it')
      expect([waits, elapsed < 350]).toEqual([1, true])
    } finally {
      release()
    }
  })

  it('an operation that ends in an error refuses with its message', async () => {
    fake.onExecute = () => ({ opError: { code: 9, message: 'precondition' } })
    expect(await withExecutor((run) => refusal(run(request())))).toContain(
      'vx/reapi: execution failed for pkg#gen: precondition',
    )
  })
})

describe.if(CHUNKING_SUPPORTED)('the record a success writes', () => {
  it('a failure writes none', async () => {
    fake.onExecute = () => ({ response: { result: { exit_code: 3 } } })
    await withExecutor((run) => run(request({ cacheKey: 'k-failed' })))
    expect(fake.actions.has(execDigestFor('k-failed').hash)).toBe(false)
  })

  it('the executable bit and symlinks are recorded, rebased; a failed write warns', async () => {
    const tool = put('#!/bin/sh')
    fake.onExecute = () => ({
      response: {
        result: {
          exit_code: 0,
          output_files: [{ path: 'bin/tool', digest: D(tool), is_executable: true }],
          output_symlinks: [{ path: 'bin/alias', target: 'tool' }],
        },
      },
    })
    await withExecutor(async (run, warns) => {
      await run(request({ cacheKey: 'k-bits' }))
      fake.fail('UpdateActionResult', 13)
      await run(request({ cacheKey: 'k-unwritten' }))
      expect(warns.filter((w) => w.startsWith('vx/reapi: could not record execution'))).toEqual([
        'vx/reapi: could not record execution for pkg#gen: 13 INTERNAL: injected INTERNAL',
      ])
    })
    const record = fake.actions.get(execDigestFor('k-bits').hash) as {
      output_files: { path: string; is_executable: boolean }[]
      output_symlinks: { path: string; target: string }[]
    }
    expect(record.output_files).toMatchObject([{ path: 'pkg/bin/tool', is_executable: true }])
    expect(record.output_symlinks).toMatchObject([{ path: 'pkg/bin/alias', target: 'tool' }])
  })

  it('a project glob with a wildcard mid-path is recorded one entry per match', async () => {
    const gen = (file: string): Directory => ({
      files: [{ name: file, digest: put(file), is_executable: false }],
      directories: [],
      symlinks: [],
    })
    const via = (dir: Directory): Directory => ({
      files: [],
      directories: [{ name: 'gen', digest: sha256(encodeDirectory(dir)) }],
      symlinks: [],
    })
    const [ga, gb] = [gen('ga'), gen('gb')]
    const [a, b] = [via(ga), via(gb)]
    const treeRoot: Directory = {
      files: [],
      directories: [
        { name: 'a', digest: sha256(encodeDirectory(a)) },
        { name: 'b', digest: sha256(encodeDirectory(b)) },
      ],
      symlinks: [],
    }
    const tree = fake.put(encodeTree(treeRoot, [a, b, ga, gb]))
    fake.onExecute = () => ({
      response: {
        result: { exit_code: 0, output_directories: [{ path: 'mods', tree_digest: D(tree) }] },
      },
    })
    await withExecutor((run) =>
      run(request({ cacheKey: 'k-mods', outputs: { files: ['mods/*/gen'], workspaceFiles: [] } })),
    )
    const record = fake.actions.get(execDigestFor('k-mods').hash) as {
      output_directories: { path: string }[]
    }
    expect(record.output_directories.map((d) => d.path)).toEqual([
      'pkg/mods/a/gen',
      'pkg/mods/b/gen',
    ])
  })
})

describe.if(CHUNKING_SUPPORTED)('upstream outputs, the edges', () => {
  const upstream = (hash: string, outputs: string[] = []) => ({
    taskId: 'lib#build',
    hash,
    outputs,
  })
  const withUpstream = (...ups: ReturnType<typeof upstream>[]) => {
    const base = request()
    return request({ inputs: { ...base.inputs!, upstream: ups } })
  }
  const emptyTree = () => fake.put(new Uint8Array())
  const oneLinkTree = () =>
    fake.put(encodeTree({ files: [], directories: [], symlinks: [{ name: 'l', target: 't' }] }, []))

  it('a record graft keeps the executable bit', async () => {
    fake.actions.set(execDigestFor('up-x').hash, {
      exit_code: 0,
      output_files: [{ path: 'lib/dist/a.js', digest: put('x'), is_executable: true }],
    })
    await withExecutor((run) => run(withUpstream(upstream('up-x', ['lib/dist/a.js']))))
    expect(inputRoot().get('lib/dist/a.js')).toMatchObject({ is_executable: true })
  })

  it('an upstream with no record, or a record whose Tree is empty, adds nothing and runs', async () => {
    fake.actions.set(execDigestFor('up-empty').hash, {
      exit_code: 0,
      output_directories: [{ path: 'lib/dist', tree_digest: emptyTree() }],
    })
    const res = await withExecutor((run) =>
      run(withUpstream(upstream('up-none'), upstream('up-empty'))),
    )
    expect([res.exitCode, inputRoot().has('lib')]).toEqual([0, false])
  })

  it('a Tree evicted between the probe and the read refuses', async () => {
    const tree = oneLinkTree()
    fake.actions.set(execDigestFor('up-race').hash, {
      exit_code: 0,
      output_directories: [{ path: 'lib/dist', tree_digest: tree }],
    })
    fake.fail('Read', 5) // NOT_FOUND
    expect(await withExecutor((run) => refusal(run(withUpstream(upstream('up-race')))))).toBe(
      `vx/reapi: upstream lib#build tree ${tree.hash.slice(0, 12)} evicted from CAS — re-run it (e.g. --force)`,
    )
  })

  it('a Tree grafted over the task’s own input directory says so', async () => {
    fake.actions.set(execDigestFor('up-over').hash, {
      exit_code: 0,
      output_directories: [{ path: 'pkg/src', tree_digest: oneLinkTree() }],
    })
    const warns = await withExecutor(async (run, w) => {
      await run(withUpstream(upstream('up-over')))
      return w
    })
    expect(warns).toEqual([
      'vx/reapi: pkg#gen declares input files under pkg/src, which an upstream graft replaces — those files are NOT in the input tree',
    ])
  })
})
