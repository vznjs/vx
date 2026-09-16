// The CI guide shows what `@vzn/vx-github` writes to the job summary
// "byte for byte". This renders the run the page describes with the real
// renderer and checks every line of it is on the page, so a renderer
// change turns the guide red before a reader compares it to their job
// page (the sample had drifted to four columns and a status cell the
// renderer never wrote, 2026-09-16, item 265).
import path from 'node:path'
import { expect, it } from 'bun:test'
import { renderJobSummary } from '@vzn/vx-github'
import type { RunSummaryRecord, TaskTelemetry } from '@vzn/vx'

const GUIDE = path.resolve(import.meta.dir, '../src/content/docs/guides/ci.md')

function task(
  taskId: string,
  status: TaskTelemetry['status'],
  exitCode: number,
  durationMs: number,
  cacheSource: TaskTelemetry['cacheSource'],
): TaskTelemetry {
  const [project, task] = taskId.split('#') as [string, string]
  return { taskId, project, task, status, cacheSource, exitCode, durationMs } as TaskTelemetry
}

const tasks = [
  task('@acme/web#build', 'failed', 2, 3100, 'miss'),
  task('@acme/web#test', 'success', 0, 4200, 'miss'),
  task('@acme/api#build', 'cache-hit-remote', 0, 0, 'remote'),
  task('@acme/ui#build', 'cache-hit', 0, 0, 'local'),
  task('@acme/ui#lint', 'skipped', 0, 0, 'none'),
]
const summary = {
  v: 2,
  run: { vxVersion: '0.0.21', command: 'vx run ci --all' },
  startedAt: 0,
  endedAt: 21_400,
  totalDurationMs: 21_400,
  taskCount: 5,
  failedCount: 1,
  hitCount: 2,
  hitLocalCount: 1,
  hitRemoteCount: 1,
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
