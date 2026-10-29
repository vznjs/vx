// A failed run's kept output lives in cache.db's `failures` (v50), beside
// the run's rows: `vx last` reads it back, `vx last --sql` can query it,
// the newest 50 failed runs are kept, and nothing is written beside the
// index.
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { indexDb, Cache } from '../src/cache/index.js'
import { runFailures, writeRunFailures } from '../src/orchestrator/run-failures.js'
import type { TaskOutcome } from '../src/graph/index.js'

let cacheDir: string
let cache: Cache
beforeEach(() => {
  cacheDir = mkdtempSync(path.join(os.tmpdir(), 'vx-run-failures-'))
  cache = new Cache(cacheDir)
})
afterEach(() => {
  cache.close()
  rmSync(cacheDir, { recursive: true, force: true })
})

const outcome = (): TaskOutcome =>
  ({
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
  }) as unknown as TaskOutcome

const failed = (runId: string): void => {
  const db = indexDb(cache)
  db.run(
    `INSERT INTO invocations (run_id, command, requested_tasks, cache_policy, concurrency,
       started_at, ended_at, total_duration_ms, task_count, failed_count, hit_count,
       hit_local_count, hit_remote_count, exit_ok, ci, vx_version)
     VALUES (?, 'vx run b', '[]', 'full', 1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 'test')`,
    [runId],
  )
  db.run(
    `INSERT INTO runs (hash, run_id, project, task, status, exit_code, duration_ms, started_at, ended_at)
     VALUES ('', ?, 'a', 'b', 'failed', 1, 0, 0, 0)`,
    [runId],
  )
  writeRunFailures(cache, runId, [outcome()], (m) => {
    throw new Error(m)
  })
}

it('a failed task reads back what its run kept, from cache.db only', () => {
  failed('r1')
  expect(runFailures(indexDb(cache))?.tasks).toEqual([
    { taskId: 'a#b', exitCode: 1, inputMoved: 'src/a.ts', output: '', locations: [] },
  ])
  expect(indexDb(cache).query('SELECT run_id, task_id, input_moved FROM failures').all()).toEqual([
    { run_id: 'r1', task_id: 'a#b', input_moved: 'src/a.ts' },
  ])
  expect(readdirSync(cacheDir)).not.toContain('failures')
})

it('a failed task its run kept nothing of reads empty output', () => {
  failed('r1')
  indexDb(cache).run('DELETE FROM failures')
  expect(runFailures(indexDb(cache), 'r1')?.tasks.map((t) => [t.taskId, t.output])).toEqual([
    ['a#b', ''],
  ])
})

it('keeps the newest 50 failed runs', () => {
  for (let i = 1; i <= 52; i++) failed(`r${String(i).padStart(3, '0')}`)
  const runs = indexDb(cache)
    .query('SELECT DISTINCT run_id FROM failures ORDER BY run_id')
    .all() as { run_id: string }[]
  expect(runs.length).toBe(50)
  expect([runs[0]!.run_id, runs[49]!.run_id]).toEqual(['r003', 'r052'])
})
