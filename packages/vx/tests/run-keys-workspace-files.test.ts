// A task declaring `inputs.workspaceFiles` takes its keys from the run key
// memo (orchestrator/run-keys.ts) too: the token folds the workspace files
// its declaration lists, through the same git facts as its project files.
// Refused outright, every key of solid and vueuse derived again on every
// no-op (vueuse: 107 of 230 ms, Turbo 101, 2026-11-10). Each case below
// changes a workspace file a key folds and expects the task to run.

import { Database } from 'bun:sqlite'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { gitIn, makeWorkspace } from './helpers/workspace.js'
import { GitFilesCache } from '../src/cache/index.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')

let root = ''
let git: (...args: string[]) => string

// a reads the root tsconfig; b reads it and the shared directory.
const config = (name: string, ws: string[]): string =>
  `export default { tasks: { build: { inputs: { files: ['src/**'], workspaceFiles: ${JSON.stringify(ws)} }, exec: { command: 'cat ../../tsconfig.json src/x.txt ${ws.length > 1 ? '../../shared/*.txt ' : ''}> out.txt && echo ${name} >> ../../runs.log' }, outputs: { files: ['out.txt'] }, cache: true } } }\n`

beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-run-keys-ws-' })
  const ws = { a: ['tsconfig.json'], b: ['tsconfig.json', 'shared/**'] }
  for (const name of ['a', 'b'] as const) {
    const pkg = path.join(root, 'packages', name)
    await mkdir(path.join(pkg, 'src'), { recursive: true })
    await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name }))
    await writeFile(path.join(pkg, 'vx.config.mjs'), config(name, ws[name]))
    await writeFile(path.join(pkg, 'src', 'x.txt'), `${name}1\n`)
  }
  await mkdir(path.join(root, 'shared'), { recursive: true })
  await writeFile(path.join(root, 'shared', 's.txt'), 's1\n')
  await writeFile(path.join(root, 'tsconfig.json'), '{"v":1}\n')
  await writeFile(path.join(root, 'other.txt'), 'o1\n')
  await writeFile(path.join(root, '.gitignore'), 'runs.log\nout.txt\n')
  git = gitIn(root)
  git('add', '-A')
  git('commit', '-qm', 'init')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** The run, and how many keys it derived (`task hash` spans). */
const build = (): number => {
  const p = Bun.spawnSync({
    cmd: [process.execPath, BIN, 'run', 'build', '--all'],
    cwd: root,
    env: { ...process.env, NO_COLOR: '1', VX_DEBUG_TIMING: '1' },
  })
  if (p.exitCode !== 0) throw new Error(p.stdout.toString() + p.stderr.toString())
  const m = /^\s*task hash\s+\S+\s+(\d+)$/m.exec(p.stderr.toString())
  return m === null ? 0 : Number(m[1])
}
const runs = async (): Promise<string[]> =>
  (await readFile(path.join(root, 'runs.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean)
const out = (name: string): Promise<string> =>
  readFile(path.join(root, 'packages', name, 'out.txt'), 'utf8')

it('a warm run takes the keys of workspaceFiles tasks from the run memo', async () => {
  expect(build()).toBe(2)
  // CONTROL: the second run is the one that remembered nothing yet derived.
  build()
  expect((await runs()).sort()).toEqual(['a', 'b'])
  expect(build()).toBe(0)
  const db = new Database(path.join(root, '.vx', 'cache', 'cache.db'))
  try {
    const rows = db.query("SELECT key FROM fold_memo WHERE task_id LIKE char(0) || 'run%'").all()
    expect(rows.length).toBeGreaterThan(0)
  } finally {
    db.close()
  }
  expect((await runs()).length).toBe(2)
}, 60_000)

it('an edit to a workspace file runs every task that declares it, and only those', async () => {
  build()
  build()
  // Committed: both read the tsconfig.
  await writeFile(path.join(root, 'tsconfig.json'), '{"v":2}\n')
  git('commit', '-qam', 'v2')
  build()
  expect((await runs()).slice(2).sort()).toEqual(['a', 'b'])
  expect(await out('a')).toBe('{"v":2}\na1\n')
  // Dirty, twice: the first leaves a run row the second would read.
  await writeFile(path.join(root, 'shared', 's.txt'), 's2\n')
  build()
  await writeFile(path.join(root, 'shared', 's.txt'), 's3\n')
  build()
  expect((await runs()).slice(4)).toEqual(['b', 'b'])
  expect(await out('b')).toBe('{"v":2}\nb1\ns3\n')
  // An untracked file the glob takes in.
  await writeFile(path.join(root, 'shared', 'new.txt'), 'n1\n')
  build()
  expect((await runs()).slice(6)).toEqual(['b'])
  expect(await out('b')).toBe('{"v":2}\nb1\nn1\ns3\n')
  // A file it took in, gone: the key is the one before it, a hit.
  await rm(path.join(root, 'shared', 'new.txt'))
  expect(build()).toBe(1)
  expect((await runs()).length).toBe(7)
  expect(await out('b')).toBe('{"v":2}\nb1\ns3\n')
  // A workspace file no declaration names derives nothing again.
  await writeFile(path.join(root, 'other.txt'), 'o2\n')
  git('commit', '-qm', 'o2', '--', 'other.txt')
  expect(build()).toBe(0)
  expect((await runs()).length).toBe(7)
}, 120_000)

it('a workspace file a project output also matches is not keyed for that task', async () => {
  // b writes shared/gen.txt, which its own shared/** would read back.
  await writeFile(
    path.join(root, 'packages', 'b', 'vx.config.mjs'),
    `export default { tasks: { build: { inputs: { files: ['src/**'], workspaceFiles: ['shared/**'] }, exec: { command: 'cat src/x.txt > ../../shared/gen.txt && echo b >> ../../runs.log' }, outputs: { files: [], workspaceFiles: ['shared/gen.txt'] }, cache: true } } }\n`,
  )
  await writeFile(path.join(root, '.gitignore'), 'runs.log\nout.txt\nshared/gen.txt\n')
  git('add', '-A')
  git('commit', '-qm', 'gen')
  build()
  build()
  build()
  expect((await runs()).filter((r) => r === 'b')).toEqual(['b'])
}, 60_000)

it('a declaration walks only the paths under its heads, untracked ones listed last too', () => {
  // Untracked paths follow the tracked ones, so the snapshot is not in
  // order, and the walk took every workspace path for each declaration
  // (vueuse with its configs untracked: 8 ms of a no-op, 2026-11-10).
  const oidsOf = (paths: readonly string[]) =>
    new Map(paths.map((rel) => [`/w/${rel}`, `100644:${rel.replace(/\W/g, '')}`]))
  const cache = new GitFilesCache()
  const snapshot = ['a/x.ts', 'b/y.ts', 'c/z.ts', 'b/new.ts']
  cache.set('/w', snapshot)
  cache.setOids('/w', oidsOf(snapshot))
  const asked: string[] = []
  const takes = (rel: string): boolean => {
    asked.push(rel)
    return rel.startsWith('b/')
  }
  const digest = cache.declarationDigest('/w', snapshot, 'b', takes, ['b'])
  expect(asked).toEqual(['b/new.ts', 'b/y.ts'])
  // CONTROL: the digest is the same paths' whatever order git listed them in.
  const other = new GitFilesCache()
  const sorted = [...snapshot].sort()
  other.set('/w', sorted)
  other.setOids('/w', oidsOf(sorted))
  expect(other.declarationDigest('/w', sorted, 'b', takes, ['b'])).toBe(digest!)
})
