// A restore writes only the task's declared outputs. An artifact in the
// local store holding any other name (one its save could not have packed)
// fails whole: nothing lands, the entry is dropped and the task runs.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { ArtifactVanishedError, Cache } from '../src/cache/index.js'
import { tarPack } from '../src/cache/tar-stream.js'
import { withSum } from './helpers/artifact-sum.js'
import { vx } from './helpers/parity.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'
import { TAR_STORE } from './helpers/tar-store.js'

const HASH = '0123456789abcdef'
let root = ''
afterEach(() => rmSync(root, { recursive: true, force: true }))

// Past the inline threshold, so the artifact is a file a test can replace.
const BIG = crypto.getRandomValues(new Uint8Array(48 * 1024)).toBase64()

async function tarOf(files: Record<string, string>): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  const inputs = Object.entries(files).map(([name, body]) => ({
    name,
    size: Buffer.byteLength(body),
    body,
  }))
  for await (const c of tarPack(inputs)) parts.push(c)
  return withSum(new Uint8Array(await new Blob(parts).arrayBuffer()))
}

/** A saved entry for `out/a.txt`, its artifact replaced by one carrying `extra` too. */
async function forged(extra: Record<string, string>): Promise<{ cache: Cache; dest: string }> {
  root = mkdtempSync(path.join(tmpdir(), 'vx-declared-only-'))
  const src = path.join(root, 'src')
  mkdirSync(path.join(src, 'out'), { recursive: true })
  writeFileSync(path.join(src, 'out', 'a.txt'), BIG)
  const cache = new Cache(
    path.join(root, 'cache'),
    { read: true, write: true },
    undefined,
    undefined,
    undefined,
    undefined,
    TAR_STORE,
  )
  await cache.save({
    hash: HASH,
    entry: { taskId: 'p#build', command: 'build', durationMs: 1, stdout: '' },
    projectDir: src,
    outputFiles: [path.join(src, 'out', 'a.txt')],
  })
  const tar = await tarOf({ 'outputs/out/a.txt': BIG, ...extra })
  writeFileSync(cache.outputsPath(HASH), Bun.zstdCompressSync(tar))
  const dest = path.join(root, 'repo')
  mkdirSync(path.join(dest, '.git', 'hooks'), { recursive: true })
  writeFileSync(path.join(dest, 'package.json'), '{"name":"repo"}\n')
  return { cache, dest }
}

const OUT = { files: ['out/**'], workspaceFiles: [] }

for (const [what, extra, outputs, landed] of [
  [
    'a project file and a git hook',
    {
      'outputs/package.json': '{"scripts":{"build":"x"}}\n',
      'outputs/.git/hooks/pre-commit': 'x\n',
    },
    OUT,
    ['package.json', '.git/hooks/pre-commit'],
  ],
  [
    'a git hook a root-wide glob selects',
    { 'outputs/.git/hooks/pre-commit': 'x\n' },
    { files: ['**'], workspaceFiles: [] },
    ['.git/hooks/pre-commit'],
  ],
  ['a path beside the glob', { 'outputs/out2/x': 'x\n' }, OUT, ['out2/x']],
  [
    'a path a ! entry takes back',
    { 'outputs/out/secret.txt': 'x\n' },
    { files: ['out/**', '!out/secret.txt'], workspaceFiles: [] },
    ['out/secret.txt'],
  ],
  [
    'an installed file no glob names',
    { 'outputs/node_modules/x/index.js': 'x\n' },
    { files: ['**/*.js', 'out/**'], workspaceFiles: [] },
    ['node_modules/x/index.js'],
  ],
  [
    'a workspace path outside the workspace globs',
    { 'workspace-outputs/.vx/workspace.ts': 'x\n' },
    { files: ['out/**'], workspaceFiles: ['**'] },
    ['.vx/workspace.ts'],
  ],
] as const) {
  it(`an artifact carrying ${what} restores nothing and is dropped`, async () => {
    const { cache, dest } = await forged(extra)
    try {
      const err = await cache.restoreOutputs(HASH, dest, dest, outputs as never).then(
        () => null,
        (e: unknown) => e,
      )
      expect(err).toBeInstanceOf(ArtifactVanishedError)
      expect(landed.filter((p) => existsSync(path.join(dest, p)) && p !== 'package.json')).toEqual(
        [],
      )
      expect(readFileSync(path.join(dest, 'package.json'), 'utf8')).toBe('{"name":"repo"}\n')
      expect(existsSync(path.join(dest, 'out', 'a.txt'))).toBe(false)
      expect(await cache.has(HASH)).toBeFalsy()
    } finally {
      cache.close()
    }
  })
}

it('an artifact holding only declared outputs restores', async () => {
  const { cache, dest } = await forged({ 'outputs/out/b.txt': 'b\n' })
  try {
    await cache.restoreOutputs(HASH, dest, dest, OUT)
    expect(readFileSync(path.join(dest, 'out', 'b.txt'), 'utf8')).toBe('b\n')
  } finally {
    cache.close()
  }
})

it('a run whose hit carries an undeclared file runs the task instead', async () => {
  root = await makeWorkspace({ prefix: 'vx-declared-run-' })
  const dir = await addProject(root, 'app', {
    config: `
      export default {
        tasks: {
          build: {
            exec: { command: 'mkdir -p out && head -c 40000 /dev/urandom | base64 > out/a.txt' },
            inputs: { files: ['src/**'] }, cache: { outputs: { files: ['out/**'] } },
          },
        },
      }
    `,
    files: { 'src/in.txt': 'v1\n' },
  })
  const git = gitIn(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  const cacheDir = path.join(root, '.cache')
  const first = await vx(root, ['run', 'build', '--all', '--cache-dir', cacheDir], {
    VX_CACHE_STORE_COMPRESS: 'true',
  })
  expect(`${first.code}\n${first.err}`).toStartWith('0\n')
  const artifact = readdirSync(cacheDir).find((f) => f.endsWith('.tar.zst'))!
  const body = readFileSync(path.join(dir, 'out', 'a.txt'), 'utf8')
  writeFileSync(
    path.join(cacheDir, artifact),
    Bun.zstdCompressSync(
      await tarOf({ 'outputs/out/a.txt': body, 'outputs/package.json': '{"name":"x"}\n' }),
    ),
  )
  rmSync(path.join(dir, 'out'), { recursive: true })
  const pkg = readFileSync(path.join(dir, 'package.json'), 'utf8')
  const second = await vx(root, ['run', 'build', '--all', '--cache-dir', cacheDir], {
    VX_CACHE_STORE_COMPRESS: 'true',
  })
  expect(`${second.code}\n${second.err}`).toStartWith('0\n')
  expect(second.out).toContain('1↑')
  expect(readFileSync(path.join(dir, 'package.json'), 'utf8')).toBe(pkg)
  expect(existsSync(path.join(dir, 'out', 'a.txt'))).toBe(true)
}, 30_000)
