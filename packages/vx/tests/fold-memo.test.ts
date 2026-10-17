// A warm task's key is read back from the fold memo (cache/fold-memo.ts)
// instead of resolving and folding its files again. The memo must never
// answer for files that moved: each case below changes what the key folds
// and expects the task to run.

import { Database } from 'bun:sqlite'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test'
import { GitFilesCache } from '../src/cache/git-inputs.js'
import type { Logger } from '../src/report/index.js'
import { run } from './helpers/orchestrator.js'
import { gitIn, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')

let root = ''
let pkg = ''
let git: (...args: string[]) => string

const config = (files: string[]): string =>
  `export default { tasks: { build: { inputs: { files: ${JSON.stringify(files)} }, exec: { command: 'cat src/x.txt > out.txt && echo ran >> ../../runs.log' }, cache: { outputs: { files: ['out.txt'] } } } } }\n`

beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-fold-memo-' })
  pkg = path.join(root, 'packages', 'a')
  await mkdir(path.join(pkg, 'src'), { recursive: true })
  await writeFile(path.join(pkg, 'package.json'), '{"name":"a"}')
  await writeFile(path.join(pkg, 'vx.config.mjs'), config(['src/**']))
  await writeFile(path.join(pkg, 'src', 'x.txt'), 'one\n')
  await writeFile(path.join(root, '.gitignore'), 'runs.log\npackages/a/out.txt\n')
  git = gitIn(root)
  git('add', '-A')
  git('commit', '-qm', 'init')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const build = (): void => {
  const p = Bun.spawnSync({
    cmd: [process.execPath, BIN, 'run', 'build', '--all'],
    cwd: root,
    env: { ...process.env, NO_COLOR: '1' },
  })
  if (p.exitCode !== 0) throw new Error(p.stdout.toString() + p.stderr.toString())
}
const runs = async (): Promise<number> =>
  (await readFile(path.join(root, 'runs.log'), 'utf8').catch(() => '')).split('\n').length - 1
const memoRows = (): Array<{ task_id: string; probe: string; key: string }> => {
  const db = new Database(path.join(root, '.vx', 'cache', 'cache.db'))
  try {
    return db.query('SELECT task_id, probe, key FROM fold_memo').all() as never
  } finally {
    db.close()
  }
}

it('a warm run takes its key from the memo', async () => {
  build()
  build()
  expect(await runs()).toBe(1)
  const [row] = memoRows()
  expect(row?.task_id).toBe('a#build')
  // A key no entry holds, under the probe the next run computes: read
  // back, the task misses and runs; folded afresh, it would hit.
  const db = new Database(path.join(root, '.vx', 'cache', 'cache.db'))
  db.run("UPDATE fold_memo SET key = '0123456789abcdef'")
  db.close()
  build()
  expect(await runs()).toBe(2)
}, 60_000)

it('the memo answers the key the whole fold derives', async () => {
  build()
  build()
  const remembered = memoRows()[0]!.key
  const db = new Database(path.join(root, '.vx', 'cache', 'cache.db'))
  db.run('DELETE FROM fold_memo')
  db.close()
  build()
  expect(memoRows()[0]!.key).toBe(remembered)
  expect(await runs()).toBe(1)
}, 60_000)

it('a committed edit, a dirty edit, an untracked input and a new declaration each run the task', async () => {
  build()
  build()
  expect(await runs()).toBe(1)
  await writeFile(path.join(pkg, 'src', 'x.txt'), 'two\n')
  git('commit', '-qam', 'two')
  build()
  expect(await runs()).toBe(2)
  expect(await readFile(path.join(pkg, 'out.txt'), 'utf8')).toBe('two\n')
  await writeFile(path.join(pkg, 'src', 'x.txt'), 'three\n')
  build()
  expect(await runs()).toBe(3)
  expect(await readFile(path.join(pkg, 'out.txt'), 'utf8')).toBe('three\n')
  await writeFile(path.join(pkg, 'src', 'x.txt'), 'two\n')
  build()
  // Back to the committed bytes: the entry the committed edit saved.
  expect(await runs()).toBe(3)
  expect(await readFile(path.join(pkg, 'out.txt'), 'utf8')).toBe('two\n')
  await writeFile(path.join(pkg, 'src', 'y.txt'), 'new\n')
  build()
  expect(await runs()).toBe(4)
  await rm(path.join(pkg, 'src', 'y.txt'))
  await writeFile(path.join(pkg, 'extra.txt'), 'x\n')
  git('add', '-A')
  git('commit', '-qm', 'extra')
  build()
  // extra.txt is outside the declaration: the same key.
  expect(await runs()).toBe(4)
  await writeFile(path.join(pkg, 'vx.config.mjs'), config(['src/**', 'extra.txt']))
  git('commit', '-qam', 'declare extra')
  build()
  expect(await runs()).toBe(5)
  await writeFile(path.join(pkg, 'extra.txt'), 'y\n')
  git('commit', '-qam', 'edit extra')
  build()
  expect(await runs()).toBe(6)
}, 120_000)

it('a key read back from the memo reads no index OID', async () => {
  const silent: Logger = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }
  expect((await run({ cwd: root, tasks: ['build'], log: silent })).ok).toBe(true)
  // Each partition's OID map is built on its first read: 125,000 abs-path
  // entries a warm 5,000-project run never needed were ~90 ms of it.
  const reads = spyOn(GitFilesCache.prototype, 'oidsFor')
  try {
    expect((await run({ cwd: root, tasks: ['build'], log: silent })).ok).toBe(true)
    expect(reads).not.toHaveBeenCalled()
  } finally {
    reads.mockRestore()
  }
  expect(await runs()).toBe(1)
}, 60_000)
