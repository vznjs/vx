// What a results row shows lands in its `runs` row too, so `vx last --sql`
// reads it: how long the task waited for a slot, its outputs' size (a hit's
// restored files, a miss's saved ones), how many tasks were downstream of
// it, and the flaky record its note quoted. cpu, peak memory and the worker
// already had columns (cpu_ms, peak_rss_bytes, placement).
import { Database } from 'bun:sqlite'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { TaskNode, TaskOutcome } from '../src/graph/index.js'
import { assembleRunRecords } from '../src/orchestrator/run-records.js'
import type { Logger } from '../src/report/index.js'
import { run } from './helpers/orchestrator.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

let root: string
beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-row-cells-' })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const quiet: Logger = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }

interface Row {
  task: string
  status: string
  queued_ms: number | null
  output_bytes: number | null
  blocks: number | null
}
function rows(): Row[][] {
  const db = new Database(path.join(root, '.vx', 'cache', 'cache.db'), { readonly: true })
  try {
    const ids = db.query('SELECT run_id FROM invocations ORDER BY started_at').all() as {
      run_id: string
    }[]
    return ids.map(
      ({ run_id }) =>
        db
          .query(
            'SELECT task, status, queued_ms, output_bytes, blocks FROM runs WHERE run_id = ? ORDER BY task',
          )
          .all(run_id) as Row[],
    )
  } finally {
    db.close()
  }
}

it("a run stores each row's waited, outputs and blocks", async () => {
  await addProject(
    root,
    'p',
    `export default {
      tasks: {
        gen: {
          exec: { command: 'sleep 0.2 && mkdir -p out && printf 12345 > out/x.txt' },
          inputs: { files: ['vx.config.mjs'] },
          cache: { outputs: { files: ['out/**'] } },
        },
        other: { exec: { command: 'sleep 0.2' } },
        use: { exec: { command: 'true' }, dependsOn: ['gen'] },
      },
    }
    `,
  )
  const tasks = ['gen', 'other', 'use']
  expect((await run({ cwd: root, tasks, concurrency: 1, log: quiet })).ok).toBe(true)
  expect((await run({ cwd: root, tasks: ['gen'], log: quiet })).ok).toBe(true)
  const [cold, warm] = rows()
  const by = (rs: Row[]) => new Map(rs.map((r) => [r.task, r]))
  const c = by(cold!)
  // One slot: of gen and other, the second waited for the first.
  expect([c.get('gen')!.queued_ms, c.get('other')!.queued_ms].some((ms) => ms! >= 150)).toBe(true)
  expect(c.get('gen')).toMatchObject({ status: 'success', output_bytes: 5, blocks: 1 })
  expect(c.get('other')).toMatchObject({ output_bytes: null, blocks: 0 })
  expect(c.get('use')).toMatchObject({ output_bytes: null, blocks: 0 })
  // The hit restores (or keeps) the same five bytes. Its wait is not held:
  // a busy runner made even a lone hit wait 2 ms for its slot.
  expect(warm).toHaveLength(1)
  expect(warm![0]).toMatchObject({ task: 'gen', status: 'cache-hit', output_bytes: 5, blocks: 0 })
}, 20_000)

it("an outcome's waited, outputs, blocks and flaky record reach its RunRecord", () => {
  const node = {
    id: 'p#t',
    projectName: 'p',
    taskName: 't',
    config: { exec: { command: 'x' }, cache: {} },
  } as unknown as TaskNode
  const outcome: TaskOutcome = {
    node,
    status: 'success',
    exitCode: 0,
    durationMs: 10,
    queuedMs: 70,
    outputBytes: 900,
    flaky: { passes: 3, failures: 2 },
  }
  const { runs } = assembleRunRecords({
    outcomes: [outcome],
    blocks: new Map([['p#t', 4]]),
    runId: 'r',
    startedAtMs: 0,
    endedAtMs: 10,
    totalMs: 10,
    ok: true,
    command: 'vx run t',
    requestedTasks: ['t'],
    cachePolicy: 'local:rw',
    concurrency: 1,
    flow: null,
    git: {} as never,
    ci: { ci: false } as never,
    host: {} as never,
    withTelemetry: false,
  })
  expect(runs[0]).toMatchObject({
    queuedMs: 70,
    outputBytes: 900,
    blocks: 4,
    flakyPasses: 3,
    flakyFailures: 2,
  })
})
