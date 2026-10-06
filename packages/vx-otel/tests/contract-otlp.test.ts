// What vx-otel sends is a 1.0 contract surface (docs/design/versioning-1.0.md):
// dashboards, alerts and queries key on its span names, attribute keys and
// metric names, so a renamed attribute breaks a user as surely as a renamed
// export. The sink is driven through one run whose every telemetry field is
// set (`Required<…>`, so a new field must be given a value before this
// compiles), its OTLP bodies are captured through the injected POST, and
// their shape — never a time, an id or a measured value — is compared with
// `tests/contract/otlp.txt`, one line per path. A lost line is a break the
// break law sees.
//
// Regenerate after a deliberate change, then review the diff:
//   VX_UPDATE_CONTRACT=1 bun test tests/contract-otlp.test.ts

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'bun:test'
import type { RunContextRecord, TaskTelemetry, TelemetryRecord } from '@vzn/vx'
import { OtelSink } from '../src/sink.js'

const RECORD = path.join(import.meta.dir, 'contract', 'otlp.txt')

/** Fields whose value is the contract (an enum, a unit), not only its type. */
const VALUE_KEYS = new Set([
  'kind',
  'unit',
  'aggregationTemporality',
  'isMonotonic',
  'severityText',
  'severityNumber',
])

/** One `path: type` line per leaf; attributes by key, spans and metrics by name. */
function shape(v: unknown, at: string, out: Set<string>): void {
  if (Array.isArray(v)) {
    for (const x of v) {
      if (x !== null && typeof x === 'object' && 'key' in x && 'value' in x) {
        const value = (x as { value: Record<string, unknown> }).value
        out.add(`${at}.${String((x as { key: unknown }).key)}: ${Object.keys(value).join('|')}`)
      } else if (
        x !== null &&
        typeof x === 'object' &&
        typeof (x as { name?: unknown }).name === 'string'
      ) {
        shape(x, `${at}[${(x as { name: string }).name}]`, out)
      } else shape(x, `${at}[]`, out)
    }
  } else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (k === 'name' && at.endsWith(']')) continue
      const p = at === '' ? k : `${at}.${k}`
      if (VALUE_KEYS.has(k)) out.add(`${p} = ${JSON.stringify(x)}`)
      else shape(x, p, out)
    }
  } else out.add(`${at}: ${typeof v}`)
}

const RUN: Required<RunContextRecord> = {
  runId: 'r',
  vxVersion: '1.0.0',
  workspaceId: 'w',
  workspaceName: 'ws',
  repository: 'github.com/o/r',
  workspacePath: '.',
  command: 'vx run build',
  requestedTasks: ['build'],
  cachePolicy: 'lR,lW',
  concurrency: 2,
  flow: 'focused',
  commitSha: 'c0ffee',
  branch: 'feature',
  defaultBranch: 'main',
  dirty: false,
  ci: true,
  ciProvider: 'github',
  host: 'box',
  os: 'linux',
  arch: 'x64',
  tags: { env: 'prod' },
}

const TASK: Required<TaskTelemetry> = {
  taskId: 'a#build',
  project: 'a',
  task: 'build',
  status: 'failed',
  cacheSource: 'miss',
  exitCode: 1,
  durationMs: 40,
  hash: 'h1',
  cpuMs: 30,
  peakRssBytes: 1024,
  where: 'local',
  outputs: 'deferred',
  attempts: 2,
  blockedBy: 'b#build',
  timedOut: true,
  sandboxViolations: 1,
  notReady: 'timeout',
  failedAttempts: [{ endedAt: 1030, exitCode: 1, timedOut: true }],
  flaky: { passes: 1, failures: 1 },
  sandboxViolationLines: ['deny file-write /x'],
  storedDurationMs: 900,
  storedCpuMs: 800,
  storedPeakRssBytes: 2048,
  admissionHeldMs: 5,
  // Every field, so each one's path is recorded; a hit alone carries it.
  restored: false,
  wallclockStartNs: '1000000000',
  wallclockEndNs: '1040000000',
}

it('the OTLP traces, metrics and logs vx-otel sends are shaped as tests/contract/otlp.txt records', async () => {
  const bodies: Record<string, unknown[]> = {}
  const sink = new OtelSink({
    tracesUrl: 'traces',
    metricsUrl: 'metrics',
    logsUrl: 'logs',
    serviceName: 'vx',
    headers: {},
    metricsEnabled: true,
    logsEnabled: true,
    // Live: its lifecycle records are a shape the run's-end export has not.
    live: true,
    timeoutMs: 1000,
    post: async (url, body) => {
      ;(bodies[url] ??= []).push(JSON.parse(body))
    },
  })
  const records: TelemetryRecord[] = [
    { v: 3, kind: 'run.start', run: RUN, total: 2, ts: 1000, startedAt: 1000 },
    {
      v: 3,
      kind: 'task.start',
      runId: 'r',
      taskId: 'b#build',
      project: 'b',
      task: 'build',
      ts: 1001,
    },
    {
      v: 3,
      kind: 'task.end',
      runId: 'r',
      ts: 1005,
      taskId: 'b#build',
      project: 'b',
      task: 'build',
      status: 'success',
      cacheSource: 'miss',
      exitCode: 0,
      durationMs: 4,
    },
    {
      v: 3,
      kind: 'task.start',
      runId: 'r',
      taskId: 'a#build',
      project: 'a',
      task: 'build',
      command: 'tsc',
      dependsOn: ['b#build'],
      ts: 1010,
    },
    {
      v: 3,
      kind: 'task.sample',
      runId: 'r',
      taskId: 'a#build',
      ts: 1030,
      cpuMs: 15,
      rssBytes: 2048,
    },
    {
      v: 3,
      kind: 'task.log',
      runId: 'r',
      taskId: 'a#build',
      stream: 'stderr',
      chunk: 'error\n',
      ts: 1020,
    },
    { v: 3, kind: 'task.end', runId: 'r', ts: 1050, ...TASK },
    { v: 3, kind: 'run.end', runId: 'r', ts: 1100 },
  ] as TelemetryRecord[]
  for (const r of records) sink.onRecord(r)
  sink.onRunSummary({
    v: 3,
    run: RUN,
    startedAt: 1000,
    endedAt: 1100,
    totalDurationMs: 100,
    taskCount: 1,
    failedCount: 1,
    abortedCount: 0,
    hitCount: 0,
    hitLocalCount: 0,
    hitRemoteCount: 0,
    upToDateCount: 0,
    restoredLocalCount: 0,
    restoredRemoteCount: 0,
    exitOk: false,
    tasks: [TASK],
    stages: [{ name: 'classify + probe', startedAt: 1000.25, endedAt: 1008.5 }],
  })
  await sink.flush()
  expect(Object.keys(bodies).sort()).toEqual(['logs', 'metrics', 'traces'])

  const lines = new Set<string>()
  for (const [signal, list] of Object.entries(bodies)) for (const b of list) shape(b, signal, lines)
  const text = [...lines].sort().join('\n') + '\n'
  if (process.env['VX_UPDATE_CONTRACT'] === '1' && process.env['CI'] !== 'true') {
    writeFileSync(RECORD, text)
  }
  expect(text).toBe(readFileSync(RECORD, 'utf8'))
})
