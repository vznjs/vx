// A warm task's key is read back from the fold memo (cache/fold-memo.ts)
// instead of resolving and folding its files again. The memo must never
// answer for files that moved: each case below changes what the key folds
// and expects the task to run.

import { Database } from 'bun:sqlite'
import { statSync, utimesSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test'
import { FILE_HASH_RACY_MS, racyWindowMs } from '../src/cache/index.js'
import { IndexFoldMemo } from '../src/cache/fold-memo.js'
import { GitFilesCache } from '../src/cache/git-inputs.js'
import type { Logger } from '../src/report/index.js'
import { run } from './helpers/orchestrator.js'
import { gitIn, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')

let root = ''
let pkg = ''
let git: (...args: string[]) => string

const config = (files: string[]): string =>
  `export default { tasks: { build: { inputs: { files: ${JSON.stringify(files)} }, exec: { command: 'cat src/x.txt > out.txt && echo ran >> ../../runs.log' }, outputs: { files: ['out.txt'] }, cache: true } } }\n`

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
// A task's rows: the run's graph and keys are remembered under `\0` names.
const memoRows = (): Array<{ task_id: string; probe: string; key: string }> => {
  const db = new Database(path.join(root, '.vx', 'cache', 'cache.db'))
  try {
    return db
      .query("SELECT task_id, probe, key FROM fold_memo WHERE task_id NOT LIKE char(0) || '%'")
      .all() as never
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

it('an untracked or dirty file no declaration reads keeps the memo', async () => {
  const silent: Logger = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }
  await writeFile(path.join(pkg, 'README.md'), 'one\n')
  git('add', '-A')
  git('commit', '-qm', 'readme')
  expect((await run({ cwd: root, tasks: ['build'], log: silent })).ok).toBe(true)
  // `vx lock`'s review file, left untracked, and an edit outside `src/**`.
  await writeFile(path.join(pkg, 'notes.txt'), 'untracked\n')
  await writeFile(path.join(pkg, 'README.md'), 'two\n')
  // A file's stat vouches for it only outside the racy window: a run
  // inside it remembered no fold, so the next one folded again (4 of 8
  // runs here, CI 2026-11-04).
  for (const f of ['notes.txt', 'README.md']) {
    const c = statSync(path.join(pkg, f)).ctimeMs
    while (Date.now() - c <= racyWindowMs(c, FILE_HASH_RACY_MS)) await Bun.sleep(10)
  }
  expect((await run({ cwd: root, tasks: ['build'], log: silent })).ok).toBe(true)
  const reads = spyOn(GitFilesCache.prototype, 'oidsFor')
  try {
    expect((await run({ cwd: root, tasks: ['build'], log: silent })).ok).toBe(true)
    expect(reads).not.toHaveBeenCalled()
  } finally {
    reads.mockRestore()
  }
  expect(await runs()).toBe(1)
}, 60_000)

it('a dirty input or committed output, edited twice, runs the task twice', async () => {
  // A committed file the outputs name is an input too (resolveFiles keeps it).
  await writeFile(
    path.join(pkg, 'vx.config.mjs'),
    `export default { tasks: { build: { inputs: { files: ['src/**'] }, exec: { command: 'cat src/x.txt src/gen.txt > out.txt && echo ran >> ../../runs.log' }, outputs: { files: ['out.txt', 'src/gen.txt'] }, cache: true } } }\n`,
  )
  await writeFile(path.join(pkg, 'src', 'gen.txt'), 'g1\n')
  git('add', '-A')
  git('commit', '-qm', 'gen')
  build()
  build()
  expect(await runs()).toBe(1)
  // Twice: the first dirty edit leaves a memo row under the records
  // without the file, and the second would read it back.
  await writeFile(path.join(pkg, 'src', 'gen.txt'), 'g2\n')
  build()
  await writeFile(path.join(pkg, 'src', 'gen.txt'), 'g3\n')
  build()
  expect(await runs()).toBe(3)
  expect(await readFile(path.join(pkg, 'out.txt'), 'utf8')).toBe('one\ng3\n')
  await writeFile(path.join(pkg, 'src', 'x.txt'), 'two\n')
  build()
  await writeFile(path.join(pkg, 'src', 'x.txt'), 'three\n')
  build()
  expect(await runs()).toBe(5)
  expect(await readFile(path.join(pkg, 'out.txt'), 'utf8')).toBe('three\ng3\n')
}, 60_000)

it('an untracked input keeps the memo, by its stat; rewriting it runs the task', async () => {
  // Without a stat identity a just-added file turned the memo off for its
  // whole project: +3-5 ms of solid's warm run with uncommitted configs.
  await writeFile(path.join(pkg, 'src', 'y.txt'), 'new\n')
  build()
  await Bun.sleep(FILE_HASH_RACY_MS + 10)
  build()
  expect(await runs()).toBe(1)
  const db = new Database(path.join(root, '.vx', 'cache', 'cache.db'))
  db.run("UPDATE fold_memo SET key = '0123456789abcdef'")
  db.close()
  build()
  // The memo answered, with a key no entry holds: the task ran.
  expect(await runs()).toBe(2)
  // Same size, mtime forged back: the ctime still moves the identity.
  const y = path.join(pkg, 'src', 'y.txt')
  const { mtime } = statSync(y)
  await Bun.sleep(FILE_HASH_RACY_MS + 10)
  await writeFile(y, 'NEW\n')
  utimesSync(y, mtime, mtime)
  await Bun.sleep(FILE_HASH_RACY_MS + 10)
  build()
  expect(await runs()).toBe(3)
  expect(await readFile(path.join(pkg, 'out.txt'), 'utf8')).toBe('one\n')
}, 60_000)

// A warm run whose keys are remembered whole asks only for the run's own
// rows; reading every task's row for them held all of them (9,603 at the
// site's size) to the end of the run.
it("a run's own row is read alone, and every task's row once a task asks", () => {
  const db = new Database(':memory:')
  db.run('CREATE TABLE fold_memo (task_id TEXT PRIMARY KEY, probe TEXT, key TEXT, seen_at INTEGER)')
  const insert = db.prepare('INSERT INTO fold_memo VALUES (?, ?, ?, 0)')
  insert.run('\0run\0x', 'p0', 'k0')
  insert.run('a#build', 'p1', 'k1')
  insert.run('b#build', 'p2', 'k2')
  const memo = new IndexFoldMemo(db, true)
  const asked: string[] = []
  const query = db.query.bind(db)
  spyOn(db, 'query').mockImplementation(((sql: string) => {
    asked.push(sql)
    return query(sql)
  }) as typeof db.query)
  expect(memo.get('\0run\0x', 'p0')).toBe('k0')
  expect(memo.get('\0run\0x', 'p0')).toBe('k0')
  expect(asked).toEqual(['SELECT probe, key FROM fold_memo WHERE task_id = ?'])
  expect(memo.get('a#build', 'p1')).toBe('k1')
  expect(memo.get('b#build', 'p2')).toBe('k2')
  // The bulk read leaves the run's rows to their own read.
  expect(memo.get('\0run\0x', 'p1')).toBeUndefined()
  expect(memo.get('\0run\0y', 'p0')).toBeUndefined()
  expect(asked.length).toBe(3)
  db.close()
})
