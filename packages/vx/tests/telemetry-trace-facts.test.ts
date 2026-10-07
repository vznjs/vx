// What a trace is drawn from: which tasks a task waited on (a group seen
// through) and the run's stages, as a telemetry sink receives them.
import { rm } from 'node:fs/promises'
import path from 'node:path'
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

it('a cacheable task that ran counts the files its key read; a hit and an uncached task count none', async () => {
  const root = await makeWorkspace({ prefix: 'vx-trace-' })
  roots.push(root)
  const dir = await addProject(
    root,
    'p',
    `export default {
      tasks: {
        build: {
          exec: { command: 'true' },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
        },
        plain: { exec: { command: 'true' } },
      },
    }
    `,
  )
  for (const f of ['a.ts', 'b.ts', 'c.ts']) await Bun.write(path.join(dir, 'src', f), f)
  const counts = async () => {
    const records: TelemetryRecord[] = []
    await run({
      cwd: root,
      tasks: ['build', 'plain'],
      projects: ['p'],
      log: { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} },
      telemetrySinks: [{ onRecord: (rec) => void records.push(rec) }],
    })
    return records
      .flatMap((r) => (r.kind === 'task.end' ? [[r.taskId, r.inputFiles] as const] : []))
      .sort(([a], [b]) => a.localeCompare(b))
  }
  expect(await counts()).toEqual([
    ['p#build', 3],
    ['p#plain', undefined],
  ])
  expect(await counts()).toEqual([
    ['p#build', undefined],
    ['p#plain', undefined],
  ])
}, 20_000)

it('a miss names what its key changed since the last entry saved for it', async () => {
  const root = await makeWorkspace({ prefix: 'vx-trace-' })
  roots.push(root)
  const dir = await addProject(
    root,
    'p',
    `export default {
      tasks: {
        build: {
          exec: { command: 'true' },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
        },
      },
    }
    `,
  )
  for (const f of ['a.ts', 'b.ts']) await Bun.write(path.join(dir, 'src', f), f)
  const changes = async () => {
    const records: TelemetryRecord[] = []
    await run({
      cwd: root,
      tasks: ['build'],
      projects: ['p'],
      log: { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} },
      telemetrySinks: [{ onRecord: (rec) => void records.push(rec) }],
    })
    const end = records.find((r) => r.kind === 'task.end')
    return end?.kind === 'task.end' ? end.inputChanges : 'no task.end'
  }
  // Nothing saved yet: nothing to compare with.
  expect(await changes()).toBeUndefined()
  await Bun.write(path.join(dir, 'src', 'a.ts'), 'a2')
  await Bun.write(path.join(dir, 'src', 'c.ts'), 'c')
  await rm(path.join(dir, 'src', 'b.ts'))
  expect(await changes()).toEqual({
    count: 3,
    first: [
      { kind: 'file', name: 'packages/p/src/a.ts', change: 'changed' },
      { kind: 'file', name: 'packages/p/src/b.ts', change: 'removed' },
      { kind: 'file', name: 'packages/p/src/c.ts', change: 'added' },
    ],
  })
  // A hit ran nothing and names nothing.
  expect(await changes()).toBeUndefined()
}, 20_000)
