// A run writes each green miss's `runs` row while it goes, a block at a
// time with the key folds made meanwhile, so its end writes only the rest:
// held here, that a task late in the run already reads the early rows and
// folds, and that the run's rows are each there once, as a bundle written
// whole at the end leaves them.
import { Database } from 'bun:sqlite'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { Logger } from '../src/report/index.js'
import { run } from './helpers/orchestrator.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const quiet: Logger = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vx-written-rows-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

it('a late task reads the rows of the green misses before it, each kept once', async () => {
  const root = await makeWorkspace({ dir })
  const db = path.join(root, '.vx/cache/cache.db')
  const n = 300
  const names = Array.from({ length: n }, (_, i) => `t${i}`)
  const probe = `${process.execPath} -e 'const { Database } = require("bun:sqlite"); console.log(new Database(${JSON.stringify(db)}, { readonly: true }).query("SELECT (SELECT COUNT(*) FROM runs) || char(32) || (SELECT COUNT(*) FROM fold_memo WHERE task_id NOT LIKE char(0) || char(37)) AS n").get().n)' > seen.txt`
  await addProject(
    root,
    'p',
    `export default { tasks: { ${names.map((t) => `${t}: { exec: { command: 'true' }, inputs: { files: ['package.json'] }, outputs: { files: [] }, cache: true }`).join(', ')}, last: { dependsOn: ${JSON.stringify(names)}, exec: { command: ${JSON.stringify(probe)} } } } }`,
  )
  // Tracked-clean, so each task's key fold is remembered (task-hash.ts).
  const git = gitIn(root)
  git('add', '-A')
  git('commit', '-qm', 'init')
  expect((await run({ cwd: root, tasks: ['last'], log: quiet })).ok).toBe(true)
  const seen = (await readFile(path.join(root, 'packages/p/seen.txt'), 'utf8')).trim()
  // Written in blocks of 256 while the run went, with the key folds made
  // meanwhile; none before it.
  const [rowsSeen, foldsSeen] = seen.split(' ').map(Number)
  {
    const r = new Database(db, { readonly: true })
    console.log(
      'FOLDS',
      seen,
      r.query('SELECT task_id FROM fold_memo').all().length,
      process.env.VX_CACHE_DIR,
      process.env.VX_CACHE,
    )
    r.close()
  }
  expect(rowsSeen).toBe(256)
  expect(foldsSeen).toBeGreaterThanOrEqual(256)
  const read = new Database(db, { readonly: true })
  const rows = read.query('SELECT task, COUNT(*) AS n FROM runs GROUP BY task').all() as {
    n: number
  }[]
  expect([rows.length, rows.every((r) => r.n === 1)]).toEqual([n + 1, true])
  expect(read.query('SELECT task_count FROM invocations').all()).toEqual([{ task_count: n + 1 }])
  read.close()
})
