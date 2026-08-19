// @vzn/vx-otel — the OTLP exporter plugin. Tests the pure OTLP builders, the
// env/option config resolution, and the sink's end-to-end projection of a
// run's telemetry records into OTLP trace + metric payloads (via an injected
// POST transport — no real collector, no OTel SDK).

import { describe, expect, it } from 'bun:test'
import type {
  RunContextRecord,
  RunSummaryRecord,
  TaskTelemetry,
  TelemetryRecord,
  TelemetrySink,
} from '@vzn/vx'
import {
  buildMetricsRequest,
  buildTraceRequest,
  runSpanAttributes,
  taskSpanAttributes,
  taskStatusCode,
} from '../src/otlp.js'
import { otel, parseOtlpHeaders, resolveOtelConfig } from '../src/plugin.js'
import { OtelSink } from '../src/sink.js'

const RUN: RunContextRecord = {
  runId: 'run-1',
  vxVersion: '1.2.3',
  workspaceId: 'ws-test',
  workspaceName: 'fixture-ws',
  command: 'vx run build',
  requestedTasks: ['build'],
  cachePolicy: 'lR,lW,rR,rW',
  concurrency: 4,
  flow: 'focused',
  commitSha: 'abc123',
  branch: 'main',
  defaultBranch: 'main',
  dirty: false,
  ci: true,
  ciProvider: 'github',
  host: 'ci-box',
  os: 'linux',
  arch: 'x64',
  tags: { env: 'prod' },
}

function attrMap(
  attrs: { key: string; value: Record<string, unknown> }[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const a of attrs) out[a.key] = Object.values(a.value)[0]
  return out
}

describe('parseOtlpHeaders', () => {
  it('parses a k=v,k=v header string', () => {
    expect(parseOtlpHeaders('a=1,b=2')).toEqual({ a: '1', b: '2' })
  })
  it('trims, ignores blanks + malformed pairs', () => {
    expect(parseOtlpHeaders(' a = 1 , , bad , b=2')).toEqual({ a: '1', b: '2' })
  })
  it('returns {} for undefined/empty', () => {
    expect(parseOtlpHeaders(undefined)).toEqual({})
    expect(parseOtlpHeaders('')).toEqual({})
  })
})

describe('resolveOtelConfig', () => {
  it('declines (undefined) when no endpoint is configured', () => {
    expect(resolveOtelConfig({}, {})).toBeUndefined()
  })
  it('derives /v1/traces + /v1/metrics from the base endpoint', () => {
    const c = resolveOtelConfig({}, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' })!
    expect(c.tracesUrl).toBe('http://collector:4318/v1/traces')
    expect(c.metricsUrl).toBe('http://collector:4318/v1/metrics')
  })
  it('strips a trailing slash on the base endpoint', () => {
    const c = resolveOtelConfig({}, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://x:4318/' })!
    expect(c.tracesUrl).toBe('http://x:4318/v1/traces')
  })
  it('honors per-signal endpoint overrides + OTEL_SERVICE_NAME + headers', () => {
    const c = resolveOtelConfig(
      {},
      {
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://t/v1/traces',
        OTEL_SERVICE_NAME: 'svc',
        OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer x',
      },
    )!
    expect(c.tracesUrl).toBe('http://t/v1/traces')
    expect(c.serviceName).toBe('svc')
    expect(c.headers['authorization']).toBe('Bearer x')
  })
  it('options override env, headers merge over env', () => {
    const c = resolveOtelConfig(
      { endpoint: 'http://opt:4318', serviceName: 'optsvc', headers: { x: 'opt' } },
      { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://env', OTEL_EXPORTER_OTLP_HEADERS: 'x=env,y=env' },
    )!
    expect(c.tracesUrl).toBe('http://opt:4318/v1/traces')
    expect(c.serviceName).toBe('optsvc')
    expect(c.headers).toEqual({ x: 'opt', y: 'env' })
  })
})

describe('OTLP builders', () => {
  it('runSpanAttributes carries semconv + vx attrs', () => {
    const m = attrMap(runSpanAttributes(RUN))
    expect(m['cicd.pipeline.run.id']).toBe('run-1')
    expect(m['vcs.ref.head.revision']).toBe('abc123')
    expect(m['vcs.ref.head.name']).toBe('main')
    expect(m['vx.ci']).toBe(true)
    expect(m['vx.ci.provider']).toBe('github')
    expect(m['vx.concurrency']).toBe('4') // intValue as string
    expect(m['vx.tag.env']).toBe('prod')
  })

  it('omits null git fields', () => {
    const m = attrMap(runSpanAttributes({ ...RUN, commitSha: null, branch: null, dirty: null }))
    expect(m['vcs.ref.head.revision']).toBeUndefined()
    expect(m['vcs.ref.head.name']).toBeUndefined()
    expect(m['vx.dirty']).toBeUndefined()
  })

  it('taskSpanAttributes + status maps failed → ERROR(2), else UNSET(0)', () => {
    const t: TaskTelemetry = {
      taskId: 'a#build',
      project: 'a',
      task: 'build',
      status: 'failed',
      cacheSource: 'miss',
      exitCode: 1,
      durationMs: 50,
      hash: 'deadbeef',
      cpuMs: 30,
      peakRssBytes: 2048,
    }
    const m = attrMap(taskSpanAttributes(t))
    expect(m['cicd.pipeline.task.name']).toBe('a#build')
    expect(m['cicd.pipeline.task.run.result']).toBe('failed')
    expect(m['vx.cache.source']).toBe('miss')
    expect(m['vx.task.hash']).toBe('deadbeef')
    expect(m['vx.peak_rss_bytes']).toBe('2048')
    expect(taskStatusCode(t)).toBe(2)
    expect(taskStatusCode({ ...t, status: 'success' })).toBe(0)
    expect(taskStatusCode({ ...t, status: 'cache-hit' })).toBe(0)
  })

  it('surfaces the --verify verdict as span attributes + status', () => {
    const base: TaskTelemetry = {
      taskId: 'a#build',
      project: 'a',
      task: 'build',
      status: 'success',
      cacheSource: 'miss',
      exitCode: 0,
      durationMs: 50,
    }
    // A non-hermetic task: verdict attribute + changed paths + span ERROR
    // (even though it exited 0 — its cache entry is unsound).
    const bad: TaskTelemetry = {
      ...base,
      verify: { kind: 'nondeterministic', changed: ['dist/a.js', 'dist/a.js.map'] },
    }
    const mb = attrMap(taskSpanAttributes(bad))
    expect(mb['vx.task.verify']).toBe('nondeterministic')
    expect(mb['vx.task.verify.changed']).toBe('["dist/a.js","dist/a.js.map"]')
    expect(taskStatusCode(bad)).toBe(2)
    // A proven task: verdict attribute, no changed paths, span UNSET.
    const good: TaskTelemetry = { ...base, verify: { kind: 'proven-deterministic' } }
    const mg = attrMap(taskSpanAttributes(good))
    expect(mg['vx.task.verify']).toBe('proven-deterministic')
    expect(mg['vx.task.verify.changed']).toBeUndefined()
    expect(taskStatusCode(good)).toBe(0)
    // No --verify → no verdict attribute at all.
    expect(attrMap(taskSpanAttributes(base))['vx.task.verify']).toBeUndefined()
  })

  it('surfaces the Phase-2 (inputs) verdicts: undeclared-inputs is ERROR with paths', () => {
    const base: TaskTelemetry = {
      taskId: 'a#build',
      project: 'a',
      task: 'build',
      status: 'success',
      cacheSource: 'miss',
      exitCode: 0,
      durationMs: 50,
    }
    // Incomplete declared inputs: verdict attr + the undeclared paths +
    // span ERROR (the task exited 0 but its cache entry is unsound).
    const leaky: TaskTelemetry = {
      ...base,
      verify: { kind: 'undeclared-inputs', paths: ['pkg/a/secret.txt', 'pkg/b/x.env'] },
    }
    const ml = attrMap(taskSpanAttributes(leaky))
    expect(ml['vx.task.verify']).toBe('undeclared-inputs')
    expect(ml['vx.task.verify.undeclared']).toBe('["pkg/a/secret.txt","pkg/b/x.env"]')
    expect(taskStatusCode(leaky)).toBe(2)
    // proven-complete: verdict attr, no path attrs, span UNSET.
    const complete: TaskTelemetry = { ...base, verify: { kind: 'proven-complete' } }
    const mc = attrMap(taskSpanAttributes(complete))
    expect(mc['vx.task.verify']).toBe('proven-complete')
    expect(mc['vx.task.verify.undeclared']).toBeUndefined()
    expect(taskStatusCode(complete)).toBe(0)
  })

  it('surfaces retry attempts on the task span', () => {
    const t: TaskTelemetry = {
      taskId: 'a#flaky',
      project: 'a',
      task: 'flaky',
      status: 'success',
      cacheSource: 'miss',
      exitCode: 0,
      durationMs: 50,
      attempts: 3,
    }
    expect(attrMap(taskSpanAttributes(t))['vx.task.attempts']).toBe('3')
  })

  it('buildTraceRequest nests resource → scope → spans', () => {
    const req = buildTraceRequest('vx', '1.2.3', [
      {
        traceId: 'aa',
        spanId: 'bb',
        name: 'vx.run',
        kind: 1,
        startTimeUnixNano: '1',
        endTimeUnixNano: '2',
        attributes: [],
        status: { code: 0 },
      },
    ]) as { resourceSpans: { scopeSpans: { spans: unknown[] }[] }[] }
    expect(req.resourceSpans[0]!.scopeSpans[0]!.spans).toHaveLength(1)
  })

  it('buildMetricsRequest emits totals, failed, per-source hits, duration gauge', () => {
    const summary: RunSummaryRecord = {
      v: 1,
      run: RUN,
      startedAt: 0,
      endedAt: 1000,
      totalDurationMs: 1000,
      taskCount: 5,
      failedCount: 1,
      hitCount: 3,
      hitLocalCount: 2,
      hitRemoteCount: 1,
      exitOk: false,
      tasks: [],
    }
    const req = buildMetricsRequest('vx', summary, '1000000000') as {
      resourceMetrics: { scopeMetrics: { metrics: { name: string }[] }[] }[]
    }
    const names = req.resourceMetrics[0]!.scopeMetrics[0]!.metrics.map((m) => m.name)
    expect(names).toContain('vx.tasks.total')
    expect(names).toContain('vx.tasks.failed')
    expect(names).toContain('vx.tasks.cache_hits')
    expect(names).toContain('vx.run.duration_ms')
  })
})

// --- the sink end-to-end (injected POST transport) ---------------------

function mkConfig(over: Partial<ConstructorParameters<typeof OtelSink>[0]> = {}) {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  const post = async (url: string, body: string) => {
    calls.push({ url, body: JSON.parse(body) })
  }
  const cfg = {
    tracesUrl: 'http://c/v1/traces',
    metricsUrl: 'http://c/v1/metrics',
    logsUrl: 'http://c/v1/logs',
    serviceName: 'vx',
    headers: {},
    metricsEnabled: true,
    logsEnabled: true,
    timeoutMs: 1000,
    post,
    ...over,
  }
  return { cfg, calls }
}

function summaryFor(run: RunContextRecord, tasks: TaskTelemetry[]): RunSummaryRecord {
  return {
    v: 1,
    run,
    startedAt: 0,
    endedAt: 100,
    totalDurationMs: 100,
    taskCount: tasks.length,
    failedCount: tasks.filter((t) => t.status === 'failed').length,
    hitCount: 0,
    hitLocalCount: 0,
    hitRemoteCount: 0,
    exitOk: true,
    tasks,
  }
}

describe('OtelSink end-to-end', () => {
  function driveOneTask(sink: OtelSink): void {
    sink.onRecord({
      v: 1,
      kind: 'run.start',
      run: RUN,
      total: 1,
      ts: 1000,
      startedAt: 1000,
    } as TelemetryRecord)
    sink.onRecord({
      v: 1,
      kind: 'task.start',
      runId: 'run-1',
      taskId: 'a#build',
      project: 'a',
      task: 'build',
      command: 'tsc',
      ts: 1010,
    } as TelemetryRecord)
    const t: TaskTelemetry = {
      taskId: 'a#build',
      project: 'a',
      task: 'build',
      status: 'success',
      cacheSource: 'miss',
      exitCode: 0,
      durationMs: 40,
      hash: 'h1',
    }
    sink.onRecord({ v: 1, kind: 'task.end', runId: 'run-1', ts: 1050, ...t } as TelemetryRecord)
    sink.onRecord({ v: 1, kind: 'run.end', runId: 'run-1', ts: 1100 } as TelemetryRecord)
    sink.onRunSummary(summaryFor(RUN, [t]))
  }

  it('POSTs a trace with a vx.run root span + vx.task child linked by parentSpanId', async () => {
    const { cfg, calls } = mkConfig()
    const sink = new OtelSink(cfg)
    driveOneTask(sink)
    await sink.flush()

    const trace = calls.find((c) => c.url === 'http://c/v1/traces')!
    expect(trace).toBeDefined()
    const spans = (
      trace.body as {
        resourceSpans: {
          scopeSpans: { spans: { name: string; spanId: string; parentSpanId?: string }[] }[]
        }[]
      }
    ).resourceSpans[0]!.scopeSpans[0]!.spans
    const root = spans.find((s) => s.name === 'vx.run')!
    const task = spans.find((s) => s.name === 'vx.task')!
    expect(root).toBeDefined()
    expect(task).toBeDefined()
    expect(task.parentSpanId).toBe(root.spanId)
    expect(root.parentSpanId).toBeUndefined()
  })

  it('shares one traceId across root + task spans', async () => {
    const { cfg, calls } = mkConfig()
    const sink = new OtelSink(cfg)
    driveOneTask(sink)
    await sink.flush()
    const spans = (
      calls.find((c) => c.url.endsWith('/v1/traces'))!.body as {
        resourceSpans: { scopeSpans: { spans: { traceId: string }[] }[] }[]
      }
    ).resourceSpans[0]!.scopeSpans[0]!.spans
    const traceIds = new Set(spans.map((s) => s.traceId))
    expect(traceIds.size).toBe(1)
  })

  it('POSTs metrics when enabled', async () => {
    const { cfg, calls } = mkConfig()
    const sink = new OtelSink(cfg)
    driveOneTask(sink)
    await sink.flush()
    expect(calls.some((c) => c.url === 'http://c/v1/metrics')).toBe(true)
  })

  it('skips metrics when disabled', async () => {
    const { cfg, calls } = mkConfig({ metricsEnabled: false })
    const sink = new OtelSink(cfg)
    driveOneTask(sink)
    await sink.flush()
    expect(calls.some((c) => c.url.endsWith('/v1/metrics'))).toBe(false)
  })

  it('is never-fail: a throwing transport does not reject flush', async () => {
    const post = async () => {
      throw new Error('collector down')
    }
    const warnings: string[] = []
    const sink = new OtelSink({
      ...mkConfig().cfg,
      post,
      warn: (m) => warnings.push(m),
    })
    driveOneTask(sink)
    await expect(sink.flush()).resolves.toBeUndefined()
    expect(warnings.some((w) => w.includes('export failed'))).toBe(true)
  })

  it('flush is idempotent (second flush sends nothing)', async () => {
    const { cfg, calls } = mkConfig()
    const sink = new OtelSink(cfg)
    driveOneTask(sink)
    await sink.flush()
    const after = calls.length
    await sink.flush()
    expect(calls.length).toBe(after)
  })

  it('requests task.log only when the logs signal is on', () => {
    // Repinned: the sink used to refuse log chunks unconditionally, because it
    // had nowhere to send them. It now ships them over the OTel Logs signal,
    // so the refusal is conditional — and `logsEnabled: false` must still cost
    // a run nothing, since core checks `wants` before projecting a chunk.
    expect(new OtelSink(mkConfig({ logsEnabled: false }).cfg).wants).not.toContain('task.log')
    const sink = new OtelSink(mkConfig().cfg)
    expect(sink.wants).toContain('task.log')
    expect(sink.wants).toContain('task.end')
  })
})

describe('otel() plugin', () => {
  it('declines when no endpoint is configured', () => {
    const prev = process.env['OTEL_EXPORTER_OTLP_ENDPOINT']
    delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT']
    try {
      const plugin = otel()
      const sink = plugin.telemetry!({
        workspaceRoot: '/ws',
        cacheDir: '/ws/.vx/cache',
        warn: () => undefined,
      })
      expect(sink).toBeUndefined()
    } finally {
      if (prev !== undefined) process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = prev
    }
  })

  it('returns a sink when an endpoint is configured via options', () => {
    const plugin = otel({ endpoint: 'http://c:4318' })
    const sink = plugin.telemetry!({
      workspaceRoot: '/ws',
      cacheDir: '/ws/.vx/cache',
      warn: () => undefined,
    }) as TelemetrySink | undefined
    expect(sink).toBeDefined()
    expect(sink!.name).toBe('vzn/otel')
  })
})

// --- losslessness -------------------------------------------------------
//
// A trace is only useful as THE export if every telemetry field survives it.
// These are the tripwires: adding a field to `RunContextRecord` forces it into
// the typed fixture, which fails the key pin, which forces someone to decide
// how it maps — instead of the field quietly never arriving.

const FULL_TASK: Required<Omit<TaskTelemetry, 'verify'>> & Pick<TaskTelemetry, 'verify'> = {
  taskId: 'app#build',
  project: 'app',
  task: 'build',
  status: 'success',
  cacheSource: 'miss',
  exitCode: 0,
  durationMs: 1234,
  hash: 'deadbeefdeadbeef',
  cpuMs: 900,
  peakRssBytes: 123456789,
  attempts: 2,
  verify: { kind: 'proven-deterministic' },
  outputFp: {
    tree: 'feedfacefeedface',
    fileCount: 3,
    files: [
      ['dist/a.js', 'aaaa'],
      ['dist/b.js', 'bbbb'],
    ],
    truncated: true,
  },
  // Past Number.MAX_SAFE_INTEGER — routing this through a JS number rounds it.
  wallclockStartNs: '9007199254740993',
  wallclockEndNs: '9007199254742000',
}

describe('OTLP losslessness', () => {
  it('pins the RunContextRecord field set the run span must carry', () => {
    // A new field here fails until it is mapped below.
    expect(Object.keys(RUN).sort()).toEqual([
      'arch',
      'branch',
      'cachePolicy',
      'ci',
      'ciProvider',
      'command',
      'commitSha',
      'concurrency',
      'defaultBranch',
      'dirty',
      'flow',
      'host',
      'os',
      'requestedTasks',
      'runId',
      'tags',
      'vxVersion',
      'workspaceId',
      'workspaceName',
    ])
  })

  it('carries every run-context field on the root span', () => {
    const a = attrMap(runSpanAttributes(RUN) as never)
    expect(a['cicd.pipeline.run.id']).toBe('run-1')
    expect(a['vx.workspace.id']).toBe('ws-test')
    expect(a['vx.workspace.name']).toBe('fixture-ws')
    expect(a['vx.default_branch']).toBe('main')
    expect(a['vx.command']).toBe('vx run build')
    expect(a['vx.requested_tasks']).toBe('build')
    expect(a['vx.cache_policy']).toBe('lR,lW,rR,rW')
    expect(a['vx.concurrency']).toBe('4')
    expect(a['vx.flow']).toBe('focused')
    expect(a['vcs.ref.head.revision']).toBe('abc123')
    expect(a['vcs.ref.head.name']).toBe('main')
    expect(a['vx.dirty']).toBe(false)
    expect(a['vx.ci']).toBe(true)
    expect(a['vx.ci.provider']).toBe('github')
    expect(a['vx.host']).toBe('ci-box')
    expect(a['vx.os']).toBe('linux')
    expect(a['vx.arch']).toBe('x64')
    expect(a['vx.version']).toBe('1.2.3')
    expect(a['vx.tag.env']).toBe('prod')
    // The schema version a reader must check before trusting any of the above.
    expect(a['vx.telemetry.schema']).toBe('2')
  })

  it('carries the run tallies when the summary is known', () => {
    const summary: RunSummaryRecord = {
      v: 2,
      run: RUN,
      startedAt: 1_700_000_000_000,
      endedAt: 1_700_000_009_000,
      totalDurationMs: 9000,
      taskCount: 7,
      failedCount: 1,
      hitCount: 3,
      hitLocalCount: 2,
      hitRemoteCount: 1,
      exitOk: false,
      tasks: [],
    }
    const a = attrMap(runSpanAttributes(RUN, summary) as never)
    expect(a['vx.run.started_at']).toBe('1700000000000')
    expect(a['vx.run.ended_at']).toBe('1700000009000')
    expect(a['vx.run.duration_ms']).toBe('9000')
    expect(a['vx.run.task_count']).toBe('7')
    expect(a['vx.run.failed_count']).toBe('1')
    expect(a['vx.run.hit_count']).toBe('3')
    expect(a['vx.run.hit_local_count']).toBe('2')
    expect(a['vx.run.hit_remote_count']).toBe('1')
    expect(a['vx.run.exit_ok']).toBe(false)
  })

  it('omits the tallies when no summary was assembled', () => {
    const a = attrMap(runSpanAttributes(RUN) as never)
    expect(a['vx.run.task_count']).toBeUndefined()
    expect(a['vx.run.exit_ok']).toBeUndefined()
  })

  it('carries every task field on the task span', () => {
    const a = attrMap(taskSpanAttributes(FULL_TASK) as never)
    expect(a['cicd.pipeline.task.name']).toBe('app#build')
    expect(a['cicd.pipeline.task.run.result']).toBe('success')
    expect(a['vx.task.project']).toBe('app')
    expect(a['vx.task.task']).toBe('build')
    expect(a['vx.cache.source']).toBe('miss')
    expect(a['vx.task.exit_code']).toBe('0')
    expect(a['vx.task.duration_ms']).toBe('1234')
    expect(a['vx.task.hash']).toBe('deadbeefdeadbeef')
    expect(a['vx.cpu_ms']).toBe('900')
    expect(a['vx.peak_rss_bytes']).toBe('123456789')
    expect(a['vx.task.attempts']).toBe('2')
    expect(a['vx.task.verify']).toBe('proven-deterministic')
  })

  it('preserves wallclock nanoseconds past the float-safe range', () => {
    const a = attrMap(taskSpanAttributes(FULL_TASK) as never)
    // The whole point of the int64-as-string path: 9007199254740993 is the
    // first integer a JS number cannot represent, and a receiver derives a
    // dedup key from it.
    expect(a['vx.task.wallclock_start_ns']).toBe('9007199254740993')
    expect(a['vx.task.wallclock_end_ns']).toBe('9007199254742000')
  })

  it('carries the output fingerprint, file map included', () => {
    const a = attrMap(taskSpanAttributes(FULL_TASK) as never)
    expect(a['vx.task.output_fp.tree']).toBe('feedfacefeedface')
    expect(a['vx.task.output_fp.file_count']).toBe('3')
    expect(a['vx.task.output_fp.truncated']).toBe(true)
    expect(JSON.parse(String(a['vx.task.output_fp.files']))).toEqual([
      ['dist/a.js', 'aaaa'],
      ['dist/b.js', 'bbbb'],
    ])
  })

  it('emits a fingerprint with no file map as an empty array, not a hole', () => {
    const a = attrMap(
      taskSpanAttributes({
        ...FULL_TASK,
        outputFp: { tree: 'aaaa', fileCount: 0 },
      }) as never,
    )
    // Detection keys on `tree`; the map is allowed to be absent, but the
    // attribute must still parse rather than reading as malformed.
    expect(a['vx.task.output_fp.files']).toBe('[]')
    expect(a['vx.task.output_fp.truncated']).toBe(false)
  })

  it('omits every optional task attribute when the field is absent', () => {
    const a = attrMap(
      taskSpanAttributes({
        taskId: 'app#lint',
        project: 'app',
        task: 'lint',
        status: 'cache-hit',
        cacheSource: 'local',
        exitCode: 0,
        durationMs: 4,
      }) as never,
    )
    for (const key of [
      'vx.task.hash',
      'vx.cpu_ms',
      'vx.peak_rss_bytes',
      'vx.task.attempts',
      'vx.task.verify',
      'vx.task.wallclock_start_ns',
      'vx.task.output_fp.tree',
    ]) {
      expect(a[key]).toBeUndefined()
    }
  })
})

// --- the logs signal ----------------------------------------------------

describe('OtelSink logs', () => {
  function driveLogged(sink: OtelSink, over: Partial<TaskTelemetry> = {}): TaskTelemetry {
    sink.onRecord({
      v: 2,
      kind: 'run.start',
      run: RUN,
      total: 1,
      ts: 1000,
      startedAt: 1000,
    } as TelemetryRecord)
    sink.onRecord({
      v: 2,
      kind: 'task.start',
      runId: RUN.runId,
      taskId: 'a#build',
      project: 'a',
      task: 'build',
      ts: 1010,
    } as TelemetryRecord)
    sink.onRecord({
      v: 2,
      kind: 'task.log',
      runId: RUN.runId,
      taskId: 'a#build',
      stream: 'stdout',
      chunk: 'compiling...\n',
      ts: 1020,
    } as TelemetryRecord)
    sink.onRecord({
      v: 2,
      kind: 'task.log',
      runId: RUN.runId,
      taskId: 'a#build',
      stream: 'stderr',
      chunk: 'boom\n',
      ts: 1030,
    } as TelemetryRecord)
    const t: TaskTelemetry = {
      taskId: 'a#build',
      project: 'a',
      task: 'build',
      status: 'failed',
      cacheSource: 'miss',
      exitCode: 1,
      durationMs: 40,
      hash: 'h1',
      ...over,
    }
    sink.onRecord({ v: 2, kind: 'task.end', runId: RUN.runId, ts: 1050, ...t } as TelemetryRecord)
    sink.onRecord({ v: 2, kind: 'run.end', runId: RUN.runId, ts: 1100 } as TelemetryRecord)
    sink.onRunSummary(summaryFor(RUN, [t]))
    return t
  }

  function logRecords(body: unknown) {
    return (
      body as {
        resourceLogs: {
          scopeLogs: {
            logRecords: {
              body: { stringValue: string }
              severityNumber: number
              severityText: string
              traceId?: string
              spanId?: string
              attributes: { key: string; value: Record<string, unknown> }[]
            }[]
          }[]
        }[]
      }
    ).resourceLogs[0]!.scopeLogs[0]!.logRecords
  }

  it('ships an executed task tail as a log record linked to its span', async () => {
    const { cfg, calls } = mkConfig()
    const sink = new OtelSink(cfg)
    driveLogged(sink)
    await sink.flush()

    const logs = calls.find((c) => c.url === 'http://c/v1/logs')
    expect(logs).toBeDefined()
    const records = logRecords(logs!.body)
    expect(records).toHaveLength(1)
    const r = records[0]!
    // Merged streams in arrival order — what a terminal actually showed.
    expect(r.body.stringValue).toBe('compiling...\nboom\n')
    expect(r.severityText).toBe('ERROR')

    // The link is the point: a viewer opens the output from the task span.
    const spans = (
      calls.find((c) => c.url.endsWith('/v1/traces'))!.body as {
        resourceSpans: { scopeSpans: { spans: { name: string; spanId: string }[] }[] }[]
      }
    ).resourceSpans[0]!.scopeSpans[0]!.spans
    const taskSpan = spans.find((sp) => sp.name === 'vx.task')!
    expect(r.spanId).toBe(taskSpan.spanId)
    expect(r.traceId).toBeDefined()

    const a = attrMap(r.attributes as never)
    expect(a['cicd.pipeline.task.name']).toBe('a#build')
    expect(a['cicd.pipeline.run.id']).toBe(RUN.runId)
    expect(a['vx.task.hash']).toBe('h1')
    expect(a['vx.log.status']).toBe('failed')
    expect(a['vx.log.chars_full']).toBe('18')
    expect(a['vx.log.truncated_head']).toBe('0')
  })

  it('never ships a cache hit tail — those bytes belong to the run that executed', async () => {
    const { cfg, calls } = mkConfig()
    const sink = new OtelSink(cfg)
    driveLogged(sink, { status: 'cache-hit', cacheSource: 'local', exitCode: 0 })
    await sink.flush()
    expect(calls.find((c) => c.url === 'http://c/v1/logs')).toBeUndefined()
  })

  it('posts no logs body when a run captured nothing', async () => {
    const { cfg, calls } = mkConfig()
    const sink = new OtelSink(cfg)
    sink.onRecord({
      v: 2,
      kind: 'run.start',
      run: RUN,
      total: 0,
      ts: 1,
      startedAt: 1,
    } as TelemetryRecord)
    sink.onRunSummary(summaryFor(RUN, []))
    await sink.flush()
    expect(calls.some((c) => c.url === 'http://c/v1/logs')).toBe(false)
  })

  it('declines task.log entirely when logs are off, so core never projects one', () => {
    const off = new OtelSink(mkConfig({ logsEnabled: false }).cfg)
    expect(off.wants).not.toContain('task.log')
    const on = new OtelSink(mkConfig().cfg)
    expect(on.wants).toContain('task.log')
  })

  it('ships no logs body when the signal is off', async () => {
    const { cfg, calls } = mkConfig({ logsEnabled: false })
    const sink = new OtelSink(cfg)
    driveLogged(sink)
    await sink.flush()
    expect(calls.some((c) => c.url === 'http://c/v1/logs')).toBe(false)
    // ...but traces still ship, so turning logs off costs no other signal.
    expect(calls.some((c) => c.url.endsWith('/v1/traces'))).toBe(true)
  })
})

describe('resolveOtelConfig — logs', () => {
  it('derives a logs URL from the base endpoint and enables the signal', () => {
    const cfg = resolveOtelConfig({}, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c' })!
    expect(cfg.logsUrl).toBe('http://c/v1/logs')
    expect(cfg.logsEnabled).toBe(true)
  })

  it('honours the standard OTEL_LOGS_EXPORTER=none opt-out', () => {
    const cfg = resolveOtelConfig(
      {},
      { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c', OTEL_LOGS_EXPORTER: 'none' },
    )!
    expect(cfg.logsEnabled).toBe(false)
    // The URL is still resolved — only the signal is off, so flipping the
    // option back on needs no endpoint change.
    expect(cfg.logsUrl).toBe('http://c/v1/logs')
  })

  it('lets an explicit option override the env opt-out', () => {
    const cfg = resolveOtelConfig(
      { logs: true },
      { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c', OTEL_LOGS_EXPORTER: 'none' },
    )!
    expect(cfg.logsEnabled).toBe(true)
  })

  it('prefers an explicit logs endpoint over the derived one', () => {
    const cfg = resolveOtelConfig(
      { logsEndpoint: 'http://other/logs' },
      { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c' },
    )!
    expect(cfg.logsUrl).toBe('http://other/logs')
  })
})
