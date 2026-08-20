// The OTLP receiver, guarded DIFFERENTIALLY against the real exporter.
//
// The decoder duplicates `@vzn/vx-otel`'s attribute keys (cloud takes no
// runtime dependency on the exporter, and a wire only one package can write is
// not a wire). These tests are what makes that copy safe: they drive the REAL
// `OtelSink`, take the bytes it would have POSTed, and assert the decode
// reproduces the record that went in. A renamed or dropped attribute fails
// here instead of silently costing a field in production.

import { describe, expect, it } from 'bun:test'
import type { RunContextRecord, RunSummaryRecord, TaskTelemetry } from '@vzn/vx'
import { OtelSink } from '@vzn/vx-otel'
import { decodeLogsRequest, decodeTraceRequest } from '../src/db/otlp-ingest.js'

const BASE_RUN: RunContextRecord = {
  runId: '019e3255-9a99-7000-8000-000000000001',
  vxVersion: '1.2.3',
  command: 'vx run build test',
  requestedTasks: ['build', 'test'],
  cachePolicy: 'lR,lW,rR,rW',
  concurrency: 8,
  flow: 'broad',
  workspaceId: 'abc123def4567890',
  workspaceName: 'acme',
  commitSha: 'f00dcafe',
  branch: 'feature/x',
  defaultBranch: 'main',
  dirty: true,
  ci: true,
  ciProvider: 'github',
  host: 'runner-7',
  os: 'linux',
  arch: 'arm64',
  tags: { env: 'ci', shard: '3' },
}

const TASKS: TaskTelemetry[] = [
  {
    taskId: 'app#build',
    project: 'app',
    task: 'build',
    status: 'success',
    cacheSource: 'miss',
    exitCode: 0,
    durationMs: 2500,
    hash: 'aaaabbbbccccdddd',
    cpuMs: 4100,
    peakRssBytes: 987654321,
    attempts: 2,
    verify: { kind: 'nondeterministic', changed: ['dist/a.js', 'dist/b,with-comma.js'] },
    outputFp: {
      tree: 'feedfacefeedface',
      fileCount: 2,
      files: [
        ['dist/a.js', 'h1'],
        ['dist/b,with-comma.js', 'h2'],
      ],
      truncated: true,
    },
    wallclockStartNs: '1000000',
    wallclockEndNs: '2500000000',
  },
  {
    taskId: 'app#test',
    project: 'app',
    task: 'test',
    status: 'failed',
    cacheSource: 'miss',
    exitCode: 7,
    durationMs: 900,
    hash: 'eeeeffff00001111',
    verify: { kind: 'rerun-failed', exitCode: 42 },
  },
  {
    taskId: 'lib#build',
    project: 'lib',
    task: 'build',
    status: 'cache-hit-remote',
    cacheSource: 'remote',
    exitCode: 0,
    durationMs: 12,
    hash: '2222333344445555',
  },
]

function summaryOf(tasks: TaskTelemetry[], run: RunContextRecord = BASE_RUN): RunSummaryRecord {
  return {
    v: 2,
    run,
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_003_400,
    totalDurationMs: 3400,
    taskCount: tasks.length,
    failedCount: tasks.filter((t) => t.status === 'failed').length,
    hitCount: tasks.filter((t) => t.cacheSource !== 'miss' && t.cacheSource !== 'none').length,
    hitLocalCount: tasks.filter((t) => t.cacheSource === 'local').length,
    hitRemoteCount: tasks.filter((t) => t.cacheSource === 'remote').length,
    exitOk: false,
    tasks,
  }
}

/** Drive the real exporter over a run and return the bodies it would POST. */
async function exportRun(args: {
  tasks: TaskTelemetry[]
  logs?: { taskId: string; chunk: string }[]
  run?: RunContextRecord
}): Promise<{ traces?: unknown; logs?: unknown }> {
  const RUN = args.run ?? BASE_RUN
  const posted: { url: string; body: unknown }[] = []
  const sink = new OtelSink({
    tracesUrl: 'http://c/v1/traces',
    metricsUrl: 'http://c/v1/metrics',
    logsUrl: 'http://c/v1/logs',
    serviceName: 'vx',
    headers: {},
    metricsEnabled: false,
    logsEnabled: true,
    timeoutMs: 1000,
    post: async (url, body) => {
      posted.push({ url, body: JSON.parse(body) })
    },
  })
  const summary = summaryOf(args.tasks, RUN)
  sink.onRecord({
    v: 2,
    kind: 'run.start',
    run: RUN,
    total: args.tasks.length,
    ts: summary.startedAt,
    startedAt: summary.startedAt,
  })
  for (const t of args.tasks) {
    sink.onRecord({
      v: 2,
      kind: 'task.start',
      runId: RUN.runId,
      taskId: t.taskId,
      project: t.project,
      task: t.task,
      ts: summary.startedAt + 1,
    })
    for (const l of args.logs ?? []) {
      if (l.taskId !== t.taskId) continue
      sink.onRecord({
        v: 2,
        kind: 'task.log',
        runId: RUN.runId,
        taskId: t.taskId,
        stream: 'stdout',
        chunk: l.chunk,
        ts: summary.startedAt + 2,
      })
    }
    sink.onRecord({ v: 2, kind: 'task.end', runId: RUN.runId, ts: summary.endedAt, ...t })
  }
  sink.onRecord({ v: 2, kind: 'run.end', runId: RUN.runId, ts: summary.endedAt })
  sink.onRunSummary(summary)
  await sink.flush()
  return {
    traces: posted.find((p) => p.url.endsWith('/v1/traces'))?.body,
    logs: posted.find((p) => p.url.endsWith('/v1/logs'))?.body,
  }
}

describe('OTLP receiver — round trip against the real exporter', () => {
  it('rebuilds the run summary byte-for-byte', async () => {
    const { traces } = await exportRun({ tasks: TASKS })
    const decoded = decodeTraceRequest(traces)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(decoded.value.runs).toHaveLength(1)
    expect(decoded.value.stranded).toEqual([])
    // Task ORDER is not a wire guarantee (spans batch); compare on the record
    // with tasks sorted the same way on both sides.
    const byId = (r: RunSummaryRecord) => ({
      ...r,
      tasks: [...r.tasks].sort((a, b) => a.taskId.localeCompare(b.taskId)),
    })
    expect(byId(decoded.value.runs[0]!)).toEqual(byId(summaryOf(TASKS)))
  })

  it('preserves a path containing a comma through the verify verdict', async () => {
    const { traces } = await exportRun({ tasks: TASKS })
    const decoded = decodeTraceRequest(traces)
    if (!decoded.ok) throw new Error(decoded.error)
    const build = decoded.value.runs[0]!.tasks.find((t) => t.taskId === 'app#build')!
    // A joined string would have split this into two files that do not exist.
    expect(build.verify).toEqual({
      kind: 'nondeterministic',
      changed: ['dist/a.js', 'dist/b,with-comma.js'],
    })
    expect(build.outputFp?.files).toEqual([
      ['dist/a.js', 'h1'],
      ['dist/b,with-comma.js', 'h2'],
    ])
  })

  it('preserves wallclock nanoseconds exactly', async () => {
    const big = '9007199254740993' // first integer a JS number cannot hold
    const { traces } = await exportRun({
      tasks: [{ ...TASKS[0]!, wallclockStartNs: big, wallclockEndNs: big }],
    })
    const decoded = decodeTraceRequest(traces)
    if (!decoded.ok) throw new Error(decoded.error)
    expect(decoded.value.runs[0]!.tasks[0]!.wallclockStartNs).toBe(big)
    expect(decoded.value.runs[0]!.tasks[0]!.wallclockEndNs).toBe(big)
  })

  it('rebuilds log bundles routed by run and workspace', async () => {
    const { logs } = await exportRun({
      tasks: TASKS,
      logs: [
        { taskId: 'app#build', chunk: 'building\n' },
        { taskId: 'app#test', chunk: 'FAIL\n' },
      ],
    })
    const decoded = decodeLogsRequest(logs)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(decoded.value).toHaveLength(1)
    const bundle = decoded.value[0]!
    expect(bundle.runId).toBe(BASE_RUN.runId)
    expect(bundle.workspaceId).toBe(BASE_RUN.workspaceId)
    const test = bundle.tasks.find((t) => t.taskId === 'app#test')!
    expect(test.content).toBe('FAIL\n')
    expect(test.status).toBe('failed')
    expect(test.hash).toBe('eeeeffff00001111')
    expect(test.charsFull).toBe(5)
    expect(test.truncatedHeadChars).toBe(0)
    // The cache hit contributed no record: those bytes belong to the run that
    // executed the task, which is the retention rule the buffer applies.
    expect(bundle.tasks.find((t) => t.taskId === 'lib#build')).toBeUndefined()
  })
})

describe('OTLP receiver — refusals and degradation', () => {
  const rootSpan = (attrs: { key: string; value: unknown }[]) => ({
    resourceSpans: [{ scopeSpans: [{ spans: [{ name: 'vx.run', attributes: attrs }] }] }],
  })

  it('refuses a payload with no vx.run span', () => {
    const r = decodeTraceRequest({
      resourceSpans: [{ scopeSpans: [{ spans: [{ name: 'vx.task', attributes: [] }] }] }],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('no vx.run span')
  })

  it('refuses a trace with no schema attribute', () => {
    const r = decodeTraceRequest(
      rootSpan([{ key: 'cicd.pipeline.run.id', value: { stringValue: 'r1' } }]),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('not a vx trace')
  })

  it('refuses a schema version it does not read', () => {
    const r = decodeTraceRequest(
      rootSpan([
        { key: 'vx.telemetry.schema', value: { intValue: '99' } },
        { key: 'cicd.pipeline.run.id', value: { stringValue: 'r1' } },
        { key: 'vx.workspace.id', value: { stringValue: 'w' } },
      ]),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('schema mismatch')
  })

  it('refuses a run span with no workspace id — there is nowhere to route it', () => {
    const r = decodeTraceRequest(
      rootSpan([
        { key: 'vx.telemetry.schema', value: { intValue: '2' } },
        { key: 'cicd.pipeline.run.id', value: { stringValue: 'r1' } },
      ]),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('workspace id')
  })

  it('recomputes the tallies from the spans that arrived', async () => {
    // A collector dropped one task span. The header must agree with the rows
    // that will actually be stored rather than claim a count that outruns them.
    const { traces } = await exportRun({ tasks: TASKS })
    const t = traces as {
      resourceSpans: { scopeSpans: { spans: { name: string }[] }[] }[]
    }
    const spans = t.resourceSpans[0]!.scopeSpans[0]!.spans
    t.resourceSpans[0]!.scopeSpans[0]!.spans = spans.filter(
      (s, i) => s.name !== 'vx.task' || i !== spans.length - 1,
    )
    const decoded = decodeTraceRequest(t)
    if (!decoded.ok) throw new Error(decoded.error)
    expect(decoded.value.runs[0]!.taskCount).toBe(TASKS.length - 1)
    expect(decoded.value.runs[0]!.tasks).toHaveLength(TASKS.length - 1)
  })

  it('drops a task whose status this build does not recognise', () => {
    const body = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  name: 'vx.run',
                  attributes: [
                    { key: 'vx.telemetry.schema', value: { intValue: '2' } },
                    { key: 'cicd.pipeline.run.id', value: { stringValue: 'r1' } },
                    { key: 'vx.workspace.id', value: { stringValue: 'w' } },
                  ],
                },
                {
                  name: 'vx.task',
                  attributes: [
                    { key: 'cicd.pipeline.task.name', value: { stringValue: 'a#b' } },
                    { key: 'cicd.pipeline.task.run.result', value: { stringValue: 'levitating' } },
                    { key: 'vx.task.project', value: { stringValue: 'a' } },
                    { key: 'vx.task.task', value: { stringValue: 'b' } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }
    const r = decodeTraceRequest(body)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.runs[0]!.tasks).toEqual([])
  })

  it('refuses a logs payload carrying no vx records', () => {
    const r = decodeLogsRequest({
      resourceLogs: [{ scopeLogs: [{ logRecords: [{ body: { stringValue: 'hi' } }] }] }],
    })
    expect(r.ok).toBe(false)
  })

  it('accepts int64 attributes a producer emitted as JSON numbers', () => {
    const r = decodeTraceRequest(
      rootSpan([
        { key: 'vx.telemetry.schema', value: { intValue: 2 } },
        { key: 'cicd.pipeline.run.id', value: { stringValue: 'r1' } },
        { key: 'vx.workspace.id', value: { stringValue: 'w' } },
        { key: 'vx.run.started_at', value: { intValue: 1700000000000 } },
      ]),
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.runs[0]!.startedAt).toBe(1700000000000)
  })
})

// --- what a collector does to a payload ---------------------------------
//
// The exporter sends one complete run per POST. A collector in between does
// not: it batches across producers and re-batches by size and time. These
// pin the two shapes that produces, both driven through the REAL exporter.

const OTHER_RUN: RunContextRecord = {
  ...BASE_RUN,
  runId: '019e3255-9a99-7000-8000-000000000002',
  workspaceId: 'ffff0000ffff0000',
  workspaceName: 'other',
}

const OTHER_TASKS: TaskTelemetry[] = [
  {
    taskId: 'other#build',
    project: 'other',
    task: 'build',
    status: 'success',
    cacheSource: 'miss',
    exitCode: 0,
    durationMs: 5,
    hash: '9999888877776666',
  },
]

type TraceBody = { resourceSpans: { scopeSpans: { spans: unknown[] }[] }[] }

function spansOfBody(body: unknown): unknown[] {
  return (body as TraceBody).resourceSpans[0]!.scopeSpans[0]!.spans
}

function bodyWithSpans(template: unknown, spans: unknown[]): unknown {
  const t = structuredClone(template) as TraceBody
  t.resourceSpans[0]!.scopeSpans[0]!.spans = spans
  return t
}

describe('OTLP receiver — collector batching', () => {
  it('keeps two batched runs apart instead of merging them', async () => {
    const a = await exportRun({ tasks: TASKS })
    const b = await exportRun({ tasks: OTHER_TASKS, run: OTHER_RUN })
    // What a shared collector sends: both producers in ONE export.
    const merged = bodyWithSpans(a.traces, [...spansOfBody(a.traces), ...spansOfBody(b.traces)])

    const decoded = decodeTraceRequest(merged)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return

    expect(decoded.value.runs).toHaveLength(2)
    const byRun = new Map(decoded.value.runs.map((r) => [r.run.runId, r]))
    const first = byRun.get(BASE_RUN.runId)!
    const second = byRun.get(OTHER_RUN.runId)!

    // Neither run borrows the other's tasks — reading a batch as one run is
    // how a workspace acquires tasks it never executed.
    expect(first.taskCount).toBe(TASKS.length)
    expect(first.tasks.map((t) => t.taskId).sort()).toEqual(TASKS.map((t) => t.taskId).sort())
    expect(second.taskCount).toBe(OTHER_TASKS.length)
    expect(second.tasks.map((t) => t.taskId)).toEqual(['other#build'])

    // ...and each still names its own workspace, so each routes on its own.
    expect(first.run.workspaceId).toBe(BASE_RUN.workspaceId)
    expect(second.run.workspaceId).toBe(OTHER_RUN.workspaceId)
    expect(decoded.value.stranded).toEqual([])
  })

  it('strands the task spans of a split batch rather than refusing them', async () => {
    const { traces } = await exportRun({ tasks: TASKS })
    const spans = spansOfBody(traces) as { name: string }[]
    const rootOnly = bodyWithSpans(
      traces,
      spans.filter((sp) => sp.name === 'vx.run'),
    )
    const tasksOnly = bodyWithSpans(
      traces,
      spans.filter((sp) => sp.name === 'vx.task'),
    )

    // The header half still decodes as a run — with the tasks that arrived.
    const head = decodeTraceRequest(rootOnly)
    if (!head.ok) throw new Error(head.error)
    expect(head.value.runs).toHaveLength(1)
    expect(head.value.runs[0]!.taskCount).toBe(0)

    // The task half used to be a 400 — those tasks were simply lost. They now
    // strand, carrying the run they belong to, and go through the incremental
    // ingest instead.
    const tail = decodeTraceRequest(tasksOnly)
    expect(tail.ok).toBe(true)
    if (!tail.ok) return
    expect(tail.value.runs).toEqual([])
    expect(tail.value.stranded).toHaveLength(TASKS.length)
    for (const rec of tail.value.stranded) {
      expect(rec.runId).toBe(BASE_RUN.runId)
      expect(rec.workspaceId).toBe(BASE_RUN.workspaceId)
      // The storage key's base — the same value the complete trace carries, so
      // the two arrival orders converge on one row instead of two.
      expect(rec.runStartedAt).toBe(summaryOf(TASKS).startedAt)
    }
  })

  it('still refuses a payload with no vx spans at all', () => {
    const r = decodeTraceRequest({
      resourceSpans: [{ scopeSpans: [{ spans: [{ name: 'http.request', traceId: 'aa' }] }] }],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('no vx.run span')
  })

  it('reads a single-run payload the same whether or not spans carry a trace id', async () => {
    // A producer that omits traceId degrades to one group — which is still
    // correct for the one-run-per-POST shape the exporter itself sends.
    const { traces } = await exportRun({ tasks: TASKS })
    const spans = spansOfBody(traces) as Record<string, unknown>[]
    const untraced = bodyWithSpans(
      traces,
      spans.map((sp) => {
        const { traceId: _drop, ...rest } = sp
        return rest
      }),
    )
    const r = decodeTraceRequest(untraced)
    if (!r.ok) throw new Error(r.error)
    expect(r.value.runs).toHaveLength(1)
    expect(r.value.runs[0]!.taskCount).toBe(TASKS.length)
  })
})
