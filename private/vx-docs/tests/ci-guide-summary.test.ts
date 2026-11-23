// The CI guide shows what `@vzn/vx-ci` writes to the job summary
// "byte for byte". This renders the run the page describes with the real
// renderer and checks every line of it is on the page, so a renderer
// change turns the guide red before a reader compares it to their job
// page (the sample had drifted to four columns and a status cell the
// renderer never wrote, 2026-09-16, item 265).
import path from 'node:path'
import { expect, it } from 'bun:test'
import { renderJobSummary } from '@vzn/vx-ci'
import type { RunSummaryRecord, TaskTelemetry } from '@vzn/vx'

const GUIDE = path.resolve(import.meta.dir, '../src/content/docs/docs/ci.mdx')

function task(
  taskId: string,
  status: TaskTelemetry['status'],
  exitCode: number,
  durationMs: number,
  cacheSource: TaskTelemetry['cacheSource'],
  restored?: boolean,
): TaskTelemetry {
  const [project, task] = taskId.split('#') as [string, string]
  return {
    taskId,
    project,
    task,
    status,
    cacheSource,
    exitCode,
    durationMs,
    ...(restored !== undefined ? { restored } : {}),
  } as TaskTelemetry
}

const tasks = [
  task('@demo/web#test', 'failed', 1, 728, 'miss'),
  task('@demo/web#build', 'success', 0, 305, 'miss'),
  task('@demo/web#lint', 'success', 0, 64, 'miss'),
  task('@demo/ui#build', 'cache-hit', 0, 2, 'local', false),
  task('@demo/ui#lint', 'cache-hit', 0, 0, 'local', false),
  task('@demo/ui#test', 'cache-hit', 0, 0, 'local', false),
]
const summary = {
  v: 2,
  run: { vxVersion: '0.0.659', command: 'vx pipeline main' },
  startedAt: 0,
  endedAt: 792,
  totalDurationMs: 792,
  taskCount: 6,
  failedCount: 1,
  hitCount: 3,
  hitLocalCount: 3,
  hitRemoteCount: 0,
  upToDateCount: 3,
  restoredLocalCount: 0,
  restoredRemoteCount: 0,
  exitOk: false,
  tasks,
} as unknown as RunSummaryRecord

it('the CI guide shows the job summary the plugin writes, line for line', async () => {
  const page = await Bun.file(GUIDE).text()
  const lines = renderJobSummary(summary)
    .split('\n')
    .filter((l) => l.trim() !== '')
  expect(lines.length).toBeGreaterThan(10)
  const missing = lines.filter((l) => !page.includes(`> ${l}\n`))
  expect(missing).toEqual([])
})
