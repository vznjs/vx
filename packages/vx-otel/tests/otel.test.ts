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
    expect(mb['vx.task.verify.changed']).toBe('dist/a.js,dist/a.js.map')
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
    expect(ml['vx.task.verify.undeclared']).toBe('pkg/a/secret.txt,pkg/b/x.env')
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
    serviceName: 'vx',
    headers: {},
    metricsEnabled: true,
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
    sink.onRecord({ v: 1, kind: 'run.start', run: RUN, total: 1, ts: 1000 } as TelemetryRecord)
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

  it('only requests the trace+metric kinds (not task.log)', () => {
    const sink = new OtelSink(mkConfig().cfg)
    expect(sink.wants).not.toContain('task.log')
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
