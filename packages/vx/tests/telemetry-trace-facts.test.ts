// What a trace is drawn from: which tasks a task waited on (a group seen
// through) and the run's stages, as a telemetry sink receives them.
import { rm } from 'node:fs/promises'
import { afterAll, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import type { RunSummaryRecord, TelemetryRecord } from '../src/orchestrator/index.js'
import { run } from '../src/orchestrator/index.js'

const roots: string[] = []
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true })
})

it('a task names the tasks with a command it waited on, through a group, and the summary its stages', async () => {
  const root = await makeWorkspace({ prefix: 'vx-trace-' })
  roots.push(root)
  await addProject(
    root,
    'p',
    `export default {
      tasks: {
        a: { exec: { command: 'true' } },
        b: { exec: { command: 'true' } },
        grp: { dependsOn: ['a', 'b'] },
        top: { dependsOn: ['grp', 'a'], exec: { command: 'true' } },
      },
    }
    `,
  )
  const records: TelemetryRecord[] = []
  let summary: RunSummaryRecord | undefined
  const r = await run({
    cwd: root,
    tasks: ['top'],
    projects: ['p'],
    log: { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} },
    telemetrySinks: [
      { onRecord: (rec) => void records.push(rec), onRunSummary: (s) => void (summary = s) },
    ],
  })
  expect(r.ok).toBe(true)
  const starts = new Map(
    records.flatMap((rec) => (rec.kind === 'task.start' ? [[rec.taskId, rec.dependsOn]] : [])),
  )
  expect([...starts].sort(([a], [b]) => a.localeCompare(b))).toEqual([
    ['p#a', undefined],
    ['p#b', undefined],
    ['p#top', ['p#a', 'p#b']],
  ])
  // Stages in the order run() marks them, each a forward window, the ones
  // after the run lock inside the run.
  const stages = summary!.stages!
  const names = stages.map((s) => s.name)
  expect(names.indexOf('classify + probe')).toBeLessThan(names.indexOf('run graph'))
  expect(names.at(-1)).toBe('record history')
  for (const [i, s] of stages.entries()) {
    expect(s.endedAt).toBeGreaterThanOrEqual(s.startedAt)
    if (i > 0) expect(s.startedAt).toBe(stages[i - 1]!.endedAt)
  }
  // A second run in this process draws its own stages, none of the first's.
  const first = summary!
  await run({
    cwd: root,
    tasks: ['top'],
    projects: ['p'],
    log: { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} },
    telemetrySinks: [{ onRunSummary: (s) => void (summary = s) }],
  })
  expect(summary!.stages!.map((s) => s.name)).toEqual(names)
  expect(summary!.stages![0]!.startedAt).toBeGreaterThanOrEqual(first.endedAt)
  const runGraph = first.stages!.find((s) => s.name === 'run graph')!
  expect(runGraph.startedAt).toBeGreaterThanOrEqual(first.startedAt)
  // `endedAt` is Date.now(), whole ms truncated: the stage's fraction may pass it.
  expect(runGraph.endedAt).toBeLessThan(first.endedAt + 1)
}, 20_000)
