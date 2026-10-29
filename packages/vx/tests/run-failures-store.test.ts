// The failures/ files `vx last` reads beside cache.db: a file the disk left
// torn (a rename that landed before its data, on power loss) made every
// `vx last` throw a SyntaxError until 50 newer failed runs rotated it out,
// and a crashed writer's temp file stayed for good.
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { runFailures, writeRunFailures } from '../src/orchestrator/run-failures.js'
import type { TaskOutcome } from '../src/graph/index.js'

let cacheDir: string
let db: Database
beforeEach(() => {
  cacheDir = mkdtempSync(path.join(os.tmpdir(), 'vx-run-failures-'))
  db = new Database(':memory:')
  db.run('CREATE TABLE invocations (run_id TEXT, exit_ok INTEGER)')
  db.run(
    'CREATE TABLE runs (id INTEGER PRIMARY KEY, run_id TEXT, project TEXT, task TEXT, exit_code INTEGER, timed_out INTEGER, status TEXT)',
  )
})
afterEach(() => {
  db.close()
  rmSync(cacheDir, { recursive: true, force: true })
})

const failed = (runId: string): void => {
  db.run('INSERT INTO invocations VALUES (?, 0)', [runId])
  db.run(
    "INSERT INTO runs (run_id, project, task, exit_code, status) VALUES (?, 'a', 'b', 1, 'failed')",
    [runId],
  )
}

it('reads a torn failures file as a run that kept no output', () => {
  failed('r1')
  mkdirSync(path.join(cacheDir, 'failures'))
  for (const torn of ['', '{"runId":"r1","tas', 'null']) {
    writeFileSync(path.join(cacheDir, 'failures', 'r1.json'), torn)
    expect(runFailures(cacheDir, db)?.tasks.map((t) => [t.taskId, t.output])).toEqual([['a#b', '']])
  }
})

it('reads no file outside failures/ for a run id the caller typed', () => {
  writeFileSync(
    path.join(cacheDir, 'x.json'),
    JSON.stringify({ tasks: [{ taskId: 'a#b', output: 'not this run', locations: [] }] }),
  )
  failed('../x')
  expect(runFailures(cacheDir, db, '../x')?.tasks.map((t) => t.output)).toEqual([''])
})

it("removes a crashed writer's temp file once its run is past the newest 50", () => {
  const dir = path.join(cacheDir, 'failures')
  mkdirSync(dir)
  writeFileSync(path.join(dir, '000-crashed.json.4242.tmp'), '{')
  const outcome = {
    node: {
      id: 'a#b',
      projectName: 'a',
      taskName: 'b',
      projectDir: cacheDir,
      config: { exec: { command: 'false' } },
    },
    status: 'failed',
    exitCode: 1,
    inputMoved: 'src/a.ts',
  } as unknown as TaskOutcome
  for (let i = 1; i <= 50; i++)
    writeRunFailures(cacheDir, `r${String(i).padStart(3, '0')}`, [outcome], () => {})
  expect(readdirSync(dir)).not.toContain('000-crashed.json.4242.tmp')
  expect(readdirSync(dir).length).toBe(50)
})
