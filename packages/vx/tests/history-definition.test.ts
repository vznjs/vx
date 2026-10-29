// A task's history is of the task as it is now (2026-10-23: "task can
// disappear and appear as a completely new one with the same name"): each
// row carries the task's definition (`taskDefinition`), and a reader given
// the run's definitions reads only the matching rows. A changed command
// starts over; an inputs edit keeps the history.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { indexDb, Cache, type InvocationRecord, type RunRecord } from '../src/cache/index.js'
import { taskDefinition, taskDefinitions } from '../src/graph/definition.js'
import type { TaskNode } from '../src/graph/task-graph.js'
import { LocalHistoryProvider } from '../src/history/index.js'

const node = (config: object): TaskNode =>
  ({ id: 'p#t', projectName: 'p', taskName: 't', config }) as TaskNode

const BEFORE = node({ exec: { command: 'bun test' }, inputs: { files: ['src/**'] } })
const INPUTS_EDITED = node({ exec: { command: 'bun test' }, inputs: { files: ['lib/**'] } })
const COMMAND_CHANGED = node({
  exec: { command: 'bun test --coverage' },
  inputs: { files: ['src/**'] },
})
const DEFINE_CHANGED = node({
  exec: { command: 'bun test', env: { define: { MODE: 'slow' } } },
  inputs: { files: ['src/**'] },
})

function invocation(runId: string): InvocationRecord {
  return {
    runId,
    command: 'vx run',
    requestedTasks: '[]',
    cachePolicy: 'local:rw,remote:',
    concurrency: 1,
    flow: null,
    startedAt: 1_000,
    endedAt: 1_001,
    totalDurationMs: 1,
    taskCount: 1,
    failedCount: 0,
    hitCount: 0,
    hitLocalCount: 0,
    hitRemoteCount: 0,
    upToDateCount: 0,
    restoredLocalCount: 0,
    restoredRemoteCount: 0,
    exitOk: true,
    commitSha: null,
    branch: null,
    dirty: null,
    ci: false,
    ciProvider: null,
    host: null,
    os: null,
    arch: null,
    vxVersion: '0.0.0',
  }
}

let dir: string
let cache: Cache
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'vx-def-'))
  cache = new Cache(path.join(dir, 'cache'))
  const run: RunRecord = {
    hash: 'h1',
    project: 'p',
    task: 't',
    status: 'success',
    exitCode: 0,
    durationMs: 4_000,
    startedAt: 1_000,
    endedAt: 5_000,
    runId: 'r1',
    wallclockStartNs: 0n,
    wallclockEndNs: 1n,
    cacheHit: false,
    cpuMs: 8_000,
    peakRssBytes: 1e9,
    def: taskDefinition(BEFORE)!,
  }
  cache.recordRunBundle({ runs: [run], invocation: invocation('r1') })
})
afterEach(() => {
  cache.close()
  rmSync(dir, { recursive: true, force: true })
})

const read = (n: TaskNode) =>
  new LocalHistoryProvider(indexDb(cache), undefined, undefined, taskDefinitions([n]))

it('a changed command or env.define reads no old timings, an inputs edit keeps them', async () => {
  for (const kept of [BEFORE, INPUTS_EDITED]) {
    const h = read(kept)
    expect([...(await h.p50sFor(['p#t']))]).toEqual([['p#t', 4_000]])
    expect((await h.resourcesFor(['p#t'])).get('p#t')?.maxCpuParallelism).toBe(2)
    expect((await h.loadFor(['p#t'])).get('p#t')?.p50DurationMs).toBe(4_000)
  }
  for (const fresh of [COMMAND_CHANGED, DEFINE_CHANGED]) {
    const h = read(fresh)
    expect((await h.p50sFor(['p#t'])).size).toBe(0)
    expect((await h.resourcesFor(['p#t'])).size).toBe(0)
    expect((await h.loadFor(['p#t'])).size).toBe(0)
  }
  // CONTROL: a reader given no definitions reads the row whatever it is of.
  expect([...(await new LocalHistoryProvider(indexDb(cache)).p50sFor(['p#t']))]).toEqual([
    ['p#t', 4_000],
  ])
})

it('an imported timing is read only under the definition it was taken of', async () => {
  const fresh = read(COMMAND_CHANGED)
  fresh.importTimings(
    'abc',
    new Map([['p#t', 9_000]]),
    new Map([['p#t', { p50DurationMs: 9_000, maxCpuParallelism: 3 }]]),
    taskDefinitions([COMMAND_CHANGED]),
  )
  expect([...(await fresh.p50sFor(['p#t']))]).toEqual([['p#t', 9_000]])
  expect((await fresh.resourcesFor(['p#t'])).get('p#t')?.maxCpuParallelism).toBe(3)
  // The local run of the old command still answers only the old command.
  expect([...(await read(BEFORE).p50sFor(['p#t']))]).toEqual([['p#t', 4_000]])
})

it('a definition is the command and env.define, in any key order', () => {
  const a = node({ exec: { command: 'x', env: { define: { A: '1', B: '2' } } } })
  const b = node({ exec: { command: 'x', env: { define: { B: '2', A: '1' } } } })
  expect(taskDefinition(a)).toBe(taskDefinition(b)!)
  expect(taskDefinition(node({}))).toBeUndefined()
  expect(taskDefinition(BEFORE)).toBe(taskDefinition(INPUTS_EDITED)!)
  expect(taskDefinition(BEFORE)).not.toBe(taskDefinition(COMMAND_CHANGED)!)
})

// PR #4150's first run: main's shared timings carried no definitions, and
// every task read as unmeasured.
it('a timing of no definition is read, whatever the task is now', async () => {
  const h = read(COMMAND_CHANGED)
  h.importTimings(
    'old',
    new Map([['p#t', 7_000]]),
    new Map([['p#t', { p50DurationMs: 7_000, maxCpuParallelism: 3 }]]),
  )
  expect([...(await h.p50sFor(['p#t']))]).toEqual([['p#t', 7_000]])
  expect((await h.resourcesFor(['p#t'])).get('p#t')?.maxCpuParallelism).toBe(3)
})
