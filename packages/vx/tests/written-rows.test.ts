// A run writes each green miss's `runs` row while it goes, a block at a
// time, so its end writes only the rest: held here, that a task late in the
// run already reads the early rows, and that the run's rows are each there
// once, as a bundle written whole at the end leaves them.
import { Database } from 'bun:sqlite'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { Logger } from '../src/report/index.js'
import { run } from './helpers/orchestrator.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

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
  const probe = `${process.execPath} -e 'const { Database } = require("bun:sqlite"); console.log(new Database(${JSON.stringify(db)}, { readonly: true }).query("SELECT COUNT(*) AS n FROM runs").get().n)' > seen.txt`
  await addProject(
    root,
    'p',
    `export default { tasks: { ${names.map((t) => `${t}: { exec: { command: 'true' } }`).join(', ')}, last: { dependsOn: ${JSON.stringify(names)}, exec: { command: ${JSON.stringify(probe)} } } } }`,
  )
  expect((await run({ cwd: root, tasks: ['last'], log: quiet })).ok).toBe(true)
  const seen = Number(await readFile(path.join(root, 'packages/p/seen.txt'), 'utf8'))
  // Written in blocks of 256 while the run went; none before it.
  expect(seen).toBe(256)
  const read = new Database(db, { readonly: true })
  const rows = read.query('SELECT task, COUNT(*) AS n FROM runs GROUP BY task').all() as {
    n: number
  }[]
  expect([rows.length, rows.every((r) => r.n === 1)]).toEqual([n + 1, true])
  expect(read.query('SELECT task_count FROM invocations').all()).toEqual([{ task_count: n + 1 }])
  read.close()
})
