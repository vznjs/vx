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

/** Run context every task span carries so it is readable on its own. */
const TASK_RUN = { runId: 'run-1', workspaceId: 'ws-test', startedAt: 1_700_000_000_000 }

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
  // Item 923: the spec's format is W3C Baggage's, percent-encoded.
  it('percent-decodes keys and values, and keeps a malformed escape as written', () => {
    expect(parseOtlpHeaders('Authorization=Basic%20dTpw,x%2Dscope=a%2Cb,bad=100%')).toEqual({
      Authorization: 'Basic dTpw',
      'x-scope': 'a,b',
      bad: '100%',
    })
  })
})

describe('resolveOtelConfig', () => {
  // A curl-style `Authorization: Basic …=` splits at its first `=` into a
  // NAME holding the credential; fetch refused it quoting the name, so the
  // secret reached the log and every export failed (item 1056).
  it('a header name no request can carry is dropped, neither name nor value printed', () => {
    const warns: string[] = []
    const c = resolveOtelConfig(
      {},
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c',
        OTEL_EXPORTER_OTLP_HEADERS: 'Authorization: Basic dXNlcjpwYXNz==,x-ok=1',
      },
      (m) => warns.push(m),
    )!
    expect([c.headers, warns]).toEqual([
      { 'x-ok': '1' },
      [
        '[vx-otel] a header name holds a character no HTTP header name can carry (a space, a colon, …) — not sent (neither its name nor its value is printed)',
      ],
    ])
  })

  // `Authorization` and `authorization` were two keys, and fetch joined
  // them into one header: `Bearer shared, Bearer traces-only` (item 1056).
  it('header names merge case-insensitively, the later spelling winning', () => {
    const c = resolveOtelConfig(
      {},
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c',
        OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer%20shared',
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'authorization=Bearer%20traces-only',
      },
    )!
    const sent = { ...c.headers, ...c.signalHeaders?.traces }
    expect(sent).toEqual({ authorization: 'Bearer traces-only' })
    // The option stays on top of the env, in any spelling.
    const o = resolveOtelConfig(
      { headers: { authorization: 'Bearer option' } },
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c',
        OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer%20env',
      },
    )!
    expect(o.headers).toEqual({ authorization: 'Bearer option' })
  })

  // Only `OTEL_LOGS_EXPORTER=none` was read; the rest still exported
  // (item 1056).
  it('the SDK opt-outs are honoured: disabled, and traces or metrics none', () => {
    const base = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c' }
    expect(resolveOtelConfig({}, { ...base, OTEL_SDK_DISABLED: 'true' })).toBeUndefined()
    const t = resolveOtelConfig({}, { ...base, OTEL_TRACES_EXPORTER: 'none' })!
    expect([t.tracesEnabled, t.metricsEnabled]).toEqual([false, true])
    const m = resolveOtelConfig({}, { ...base, OTEL_METRICS_EXPORTER: 'none' })!
    expect([m.tracesEnabled, m.metricsEnabled]).toEqual([undefined, false])
    // CONTROL: the plugin's own option still wins over the env.
    expect(
      resolveOtelConfig({ metrics: true }, { ...base, OTEL_METRICS_EXPORTER: 'none' })!
        .metricsEnabled,
    ).toBe(true)
  })

  // Item 928: fetch refuses a header no request can carry and QUOTES its
  // value in the error the export warning printed — an auth secret.
  it('a header value no request can carry is dropped by name, its value unprinted', () => {
    const warns: string[] = []
    const c = resolveOtelConfig(
      {},
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c',
        OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer%20SECRET%0Aline2,x-ok=1',
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'Authorization=Bearer%20SECRET%0Aline2',
      },
      (m) => warns.push(m),
    )!
    expect([c.headers, c.signalHeaders?.traces, warns]).toEqual([
      { 'x-ok': '1' },
      {},
      [
        '[vx-otel] header "Authorization" holds a line break or NUL, which no HTTP header can carry — not sent (its value is not printed)',
      ],
    ])
  })

  it('an EMPTY env var declines like a missing one, on every signal', () => {
    // A CI workflow writing `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: ${{ secrets.X }}`
    // with the secret unset exports an EMPTY STRING, not an unset var. `??`
    // only falls through on null/undefined, so an empty signal URL sailed past
    // the `tracesUrl === undefined` guard and produced a sink that POSTed to
    // '' on every run. The base endpoint was already safe by accident (a
    // falsy `base` skips joinSignal), which is what hid the asymmetry.
    expect(resolveOtelConfig({}, { OTEL_EXPORTER_OTLP_ENDPOINT: '' })).toBeUndefined()
    expect(resolveOtelConfig({}, { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: '' })).toBeUndefined()
    // An empty per-signal override falls back to the base rather than
    // poisoning that one signal's URL.
    const c = resolveOtelConfig(
      {},
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: '',
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: '',
      },
    )!
    expect(c.metricsUrl).toBe('http://collector:4318/v1/metrics')
    expect(c.logsUrl).toBe('http://collector:4318/v1/logs')
    // Same rule for a non-URL string: an empty service name is not a name.
    expect(
      resolveOtelConfig(
        {},
        { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318', OTEL_SERVICE_NAME: '' },
      )!.serviceName,
    ).toBe('vx')
  })

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
    const m = attrMap(taskSpanAttributes(t, TASK_RUN))
    expect(m['cicd.pipeline.task.name']).toBe('a#build')
    expect(m['cicd.pipeline.task.run.result']).toBe('failure')
    expect(m['vx.cache.source']).toBe('miss')
    expect(m['vx.task.hash']).toBe('deadbeef')
    expect(m['vx.peak_rss_bytes']).toBe('2048')
    expect(taskStatusCode(t)).toBe(2)
    expect(taskStatusCode({ ...t, status: 'success' })).toBe(0)
    expect(taskStatusCode({ ...t, status: 'cache-hit' })).toBe(0)
  })

  it('a hit says on its span whether it restored outputs; a miss says nothing', () => {
    const hit = (restored: boolean): TaskTelemetry => ({
      taskId: 'a#build',
      project: 'a',
      task: 'build',
      status: 'cache-hit',
      cacheSource: 'local',
      exitCode: 0,
      durationMs: 3,
      restored,
    })
    const restoredOf = (t: TaskTelemetry): unknown =>
      attrMap(taskSpanAttributes(t, TASK_RUN))['vx.cache.restored']
    const miss: TaskTelemetry = { ...hit(true), status: 'success', cacheSource: 'miss' }
    delete miss.restored
    expect([restoredOf(hit(true)), restoredOf(hit(false)), restoredOf(miss)]).toEqual([
      true,
      false,
      undefined,
    ])
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
    expect(attrMap(taskSpanAttributes(t, TASK_RUN))['vx.task.attempts']).toBe('3')
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
      abortedCount: 0,
      hitCount: 3,
      hitLocalCount: 2,
      hitRemoteCount: 1,
      upToDateCount: 1,
      restoredLocalCount: 1,
      restoredRemoteCount: 1,
      exitOk: false,
      tasks: [],
    }
    const req = buildMetricsRequest('vx', summary, '1000000000', '0') as {
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
    abortedCount: 0,
    hitCount: 0,
    hitLocalCount: 0,
    hitRemoteCount: 0,
    upToDateCount: 0,
    restoredLocalCount: 0,
    restoredRemoteCount: 0,
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
    // Item 927: a delta over the run itself, from its start to its end.
    const metrics = calls.find((c) => c.url === 'http://c/v1/metrics')!.body as {
      resourceMetrics: {
        scopeMetrics: {
          metrics: { sum?: { dataPoints: { startTimeUnixNano: string; timeUnixNano: string }[] } }[]
        }[]
      }[]
    }
    const point = metrics.resourceMetrics[0]!.scopeMetrics[0]!.metrics[0]!.sum!.dataPoints[0]!
    expect([point.startTimeUnixNano, point.timeUnixNano]).toEqual(['0', '100000000'])
  })

  it('skips metrics when disabled', async () => {
    const { cfg, calls } = mkConfig({ metricsEnabled: false })
    const sink = new OtelSink(cfg)
    driveOneTask(sink)
    await sink.flush()
    expect(calls.some((c) => c.url.endsWith('/v1/metrics'))).toBe(false)
  })

  // `OTEL_TRACES_EXPORTER=none` resolved to `tracesEnabled: false`, and the
  // sink shipped traces regardless (item 1056).
  it('a sink with traces off POSTs no traces, and the other signals as before', async () => {
    const urls: string[] = []
    const sink = new OtelSink({
      ...mkConfig().cfg,
      tracesEnabled: false,
      post: async (url) => {
        urls.push(url)
      },
    })
    driveOneTask(sink)
    await sink.flush()
    expect(urls.some((u) => u.endsWith('/v1/traces'))).toBe(false)
    expect(urls.length).toBeGreaterThan(0)
  })

  // F-49: with traces off, each log record still named the run's trace and
  // its task's span, which were never exported: the links led nowhere.
  it('with traces off, log records name no trace or span; with them on, they do', async () => {
    const linked = async (tracesEnabled: boolean) => {
      const { cfg, calls } = mkConfig({ tracesEnabled })
      const sink = new OtelSink(cfg)
      const { onRecord } = sink
      // Each executed task's output is one record: give the task some.
      sink.onRecord = (r) => {
        onRecord.call(sink, r)
        if (r.kind === 'task.start') {
          onRecord.call(sink, {
            v: 1,
            kind: 'task.log',
            runId: 'run-1',
            taskId: 'a#build',
            stream: 'stdout',
            chunk: 'built\n',
            ts: 1020,
          } as TelemetryRecord)
        }
      }
      driveOneTask(sink)
      await sink.flush()
      const body = calls.find((c) => c.url.endsWith('/v1/logs'))!.body as {
        resourceLogs: { scopeLogs: { logRecords: Record<string, unknown>[] }[] }[]
      }
      const rec = body.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!
      return ['traceId' in rec, 'spanId' in rec]
    }
    expect([await linked(false), await linked(true)]).toEqual([
      [false, false],
      [true, true],
    ])
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
    // Three signals ship CONCURRENTLY and each is caught on its own, so
    // "export failed" alone leaves the reader unable to tell which one — and
    // whether the collector is down or only one signal path is misconfigured.
    // Every warning names its URL.
    expect(warnings.every((w) => w.includes('http'))).toBe(true)
    expect(warnings.some((w) => w.includes('/v1/traces'))).toBe(true)
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
    expect(sink!.name).toBe('@vzn/vx-otel')
  })
})

// --- losslessness -------------------------------------------------------
//
// A trace is only useful as THE export if every telemetry field survives it.
// These are the tripwires: adding a field to `RunContextRecord` forces it into
// the typed fixture, which fails the key pin, which forces someone to decide
// how it maps — instead of the field quietly never arriving.

const FULL_TASK: Required<TaskTelemetry> = {
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
  where: 'worker-7',
  outputs: 'deferred',
  attempts: 2,
  blockedBy: 'lib#build',
  timedOut: true,
  sandboxViolations: 2,
  notReady: 'timeout',
  restored: true,
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

  it('pins the TaskTelemetry field set the task span must carry', () => {
    // The other half of the tripwire above, and the half the additive fields
    // keep landing in. `Required<TaskTelemetry>` already makes a new field a
    // type error in FULL_TASK — but until this pin existed the fix for that
    // error was to add the field to the fixture and stop, and a field added
    // that way rode NOTHING while every test here passed (probed with a
    // `probeField?: string`, 2026-09-19).
    expect(Object.keys(FULL_TASK).sort()).toEqual([
      'attempts',
      'blockedBy',
      'cacheSource',
      'cpuMs',
      'durationMs',
      'exitCode',
      'hash',
      'notReady',
      'outputs',
      'peakRssBytes',
      'project',
      'restored',
      'sandboxViolations',
      'status',
      'task',
      'taskId',
      'timedOut',
      'wallclockEndNs',
      'wallclockStartNs',
      'where',
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
    expect(a['vx.telemetry.schema']).toBe('3')
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
      abortedCount: 4,
      hitCount: 3,
      hitLocalCount: 2,
      hitRemoteCount: 1,
      upToDateCount: 1,
      restoredLocalCount: 1,
      restoredRemoteCount: 1,
      exitOk: false,
      tasks: [],
    }
    const a = attrMap(runSpanAttributes(RUN, summary) as never)
    expect(a['vx.run.started_at']).toBe('1700000000000')
    expect(a['vx.run.ended_at']).toBe('1700000009000')
    expect(a['vx.run.duration_ms']).toBe('9000')
    expect(a['vx.run.task_count']).toBe('7')
    expect(a['vx.run.failed_count']).toBe('1')
    expect(a['vx.run.aborted_count']).toBe('4')
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

  // F-12: the semconv attribute is an enum; vx's status went out verbatim.
  it('maps each vx status onto the cicd.pipeline.task.run.result enum, and keeps it', () => {
    const { timedOut: _, ...untimed } = FULL_TASK
    const got = (
      [
        ['success', false],
        ['cache-hit', false],
        ['cache-hit-remote', false],
        ['failed', false],
        ['failed', true],
        ['skipped', false],
        ['aborted', false],
      ] as const
    ).map(([status, timedOut]) => {
      const a = attrMap(
        taskSpanAttributes(
          { ...untimed, status, ...(timedOut ? { timedOut: true as const } : {}) },
          TASK_RUN,
        ) as never,
      )
      return [a['cicd.pipeline.task.run.result'], a['vx.task.status']]
    })
    expect(got).toEqual([
      ['success', 'success'],
      ['success', 'cache-hit'],
      ['success', 'cache-hit-remote'],
      ['failure', 'failed'],
      ['timeout', 'failed'],
      ['skip', 'skipped'],
      ['cancellation', 'aborted'],
    ])
  })

  it('carries every task field on the task span', () => {
    const a = attrMap(taskSpanAttributes(FULL_TASK, TASK_RUN) as never)
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
    expect(a['vx.task.where']).toBe('worker-7')
    expect(a['vx.task.outputs']).toBe('deferred')
    expect(a['vx.task.blocked_by']).toBe('lib#build')
    expect(a['vx.task.timed_out']).toBe(true)
    expect(a['vx.task.sandbox_violations']).toBe('2')
    expect(a['vx.task.not_ready']).toBe('timeout')
    expect(a['vx.cache.restored']).toBe(true)
  })

  it('makes a task span readable without its root span', () => {
    // OTLP is re-batched in transit, so a task span can arrive in a payload
    // its root span is not in. Without these it is unattributable and a
    // collector can strand it silently.
    const a = attrMap(taskSpanAttributes(FULL_TASK, TASK_RUN) as never)
    expect(a['cicd.pipeline.run.id']).toBe('run-1')
    expect(a['vx.workspace.id']).toBe('ws-test')
    // The storage key's base: a receiver must derive the same key from a
    // stranded task span that it would from the complete trace, or the two
    // arrival orders store the task twice instead of converging.
    expect(a['vx.task.run_started_at']).toBe('1700000000000')
  })

  it('preserves wallclock nanoseconds past the float-safe range', () => {
    const a = attrMap(taskSpanAttributes(FULL_TASK, TASK_RUN) as never)
    // The whole point of the int64-as-string path: 9007199254740993 is the
    // first integer a JS number cannot represent, and a receiver derives a
    // dedup key from it.
    expect(a['vx.task.wallclock_start_ns']).toBe('9007199254740993')
    expect(a['vx.task.wallclock_end_ns']).toBe('9007199254742000')
  })

  it('omits every optional task attribute when the field is absent', () => {
    const a = attrMap(
      taskSpanAttributes(
        {
          taskId: 'app#lint',
          project: 'app',
          task: 'lint',
          status: 'cache-hit',
          cacheSource: 'local',
          exitCode: 0,
          durationMs: 4,
        },
        TASK_RUN,
      ) as never,
    )
    for (const key of [
      'vx.task.hash',
      'vx.cpu_ms',
      'vx.peak_rss_bytes',
      'vx.task.attempts',
      'vx.task.wallclock_start_ns',
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

// --- the configured timeout --------------------------------------------

describe('OtelSink request timeout', () => {
  it('aborts a hanging collector at timeoutMs, not at a hardcoded 15 s', async () => {
    // A collector that accepts the connection and never answers. `timeoutMs`
    // was resolved, defaulted and stored and then read by nobody, so this
    // POST used to abort on a literal 15 s whatever the option said.
    // The handler is released in `finally`, never left pending: an
    // unresolved one makes `server.stop(true)` itself hang forever, which
    // turned this test into a 30 s timeout the moment the floating-promise
    // lint made that stop awaited (2026-09-19).
    let release = (): void => undefined
    const hanging = new Promise<Response>((resolve) => {
      release = () => resolve(new Response('late'))
    })
    const server = Bun.serve({ port: 0, fetch: () => hanging })
    try {
      const warned: string[] = []
      const sink = new OtelSink({
        tracesUrl: `http://localhost:${server.port}/v1/traces`,
        metricsUrl: `http://localhost:${server.port}/v1/metrics`,
        logsUrl: `http://localhost:${server.port}/v1/logs`,
        serviceName: 'vx',
        headers: {},
        metricsEnabled: false,
        logsEnabled: false,
        timeoutMs: 100,
        warn: (m) => warned.push(m),
      })
      sink.onRecord({ v: 2, kind: 'run.start', run: RUN, total: 1, ts: 0, startedAt: 0 })
      sink.onRecord({ v: 2, kind: 'run.end', runId: RUN.runId, ts: 10 })
      const started = Date.now()
      await sink.flush()
      const elapsed = Date.now() - started
      // The window is the claim: the honest path is ~100 ms and the broken one
      // is 15 s, so anything between proves which ran. Two seconds leaves a
      // loaded box twenty times its budget and still fails 7.5x short of the
      // literal.
      expect(elapsed).toBeLessThan(2_000)
      // Never-fail: the abort is swallowed and named, not thrown.
      expect(warned.join('\n')).toContain('/v1/traces')
    } finally {
      release()
      await server.stop(true)
    }
  }, 30_000)
})

// Item 807's sweep: each row fails with one line of otlp.ts undone. The
// builders' envelopes are the wire, so they are pinned whole.
describe('OTLP envelopes, exactly', () => {
  const resource = [
    { key: 'service.name', value: { stringValue: 'vx' } },
    { key: 'service.version', value: { stringValue: '1.2.3' } },
  ]

  it('the metrics request: every counter with its value, a delta over the run, and the gauge', () => {
    const summary: RunSummaryRecord = {
      v: 1,
      run: RUN,
      startedAt: 0,
      endedAt: 1000,
      totalDurationMs: 1234,
      taskCount: 8,
      failedCount: 1,
      abortedCount: 0,
      hitCount: 6,
      hitLocalCount: 4,
      hitRemoteCount: 2,
      upToDateCount: 3,
      restoredLocalCount: 2,
      restoredRemoteCount: 1,
      exitOk: false,
      tasks: [],
    }
    // Item 927: each count is the run's own, a DELTA from the run's start;
    // the cache hits are one metric with a point per source.
    const point = (v: number, attributes: unknown[] = []) => ({
      asInt: String(v),
      startTimeUnixNano: '4',
      timeUnixNano: '9',
      attributes,
    })
    const sum = (name: string, dataPoints: unknown[]) => ({
      name,
      sum: { dataPoints, aggregationTemporality: 1, isMonotonic: true },
    })
    expect(buildMetricsRequest('vx', summary, '9', '4')).toEqual({
      resourceMetrics: [
        {
          resource: { attributes: resource },
          scopeMetrics: [
            {
              scope: { name: 'vx', version: '1.2.3' },
              metrics: [
                sum('vx.tasks.total', [point(8)]),
                sum('vx.tasks.failed', [point(1)]),
                sum('vx.tasks.cache_hits', [
                  point(4, [{ key: 'source', value: { stringValue: 'local' } }]),
                  point(2, [{ key: 'source', value: { stringValue: 'remote' } }]),
                ]),
                // What the hits did to the disk: restored, by layer, or up to date.
                sum('vx.tasks.cache_restored', [
                  point(2, [{ key: 'source', value: { stringValue: 'local' } }]),
                  point(1, [{ key: 'source', value: { stringValue: 'remote' } }]),
                ]),
                sum('vx.tasks.cache_up_to_date', [point(3)]),
                {
                  name: 'vx.run.duration_ms',
                  gauge: { dataPoints: [{ asDouble: 1234, timeUnixNano: '9', attributes: [] }] },
                },
              ],
            },
          ],
        },
      ],
    })
  })

  it('the trace request names its scope with the vx version', () => {
    expect(buildTraceRequest('vx', '1.2.3', [])).toEqual({
      resourceSpans: [
        {
          resource: { attributes: resource },
          scopeSpans: [{ scope: { name: 'vx', version: '1.2.3' }, spans: [] }],
        },
      ],
    })
  })

  it('a failed task’s log record is ERROR, observed when made, and names its workspace', async () => {
    const { buildLogsRequest } = await import('../src/otlp.js')
    const req = buildLogsRequest({
      serviceName: 'vx',
      vxVersion: '1.2.3',
      runId: 'run-1',
      workspaceId: 'ws-test',
      entries: [
        {
          taskId: 'a#build',
          status: 'failed',
          content: 'boom',
          charsFull: 4,
          truncatedHeadChars: 0,
        } as never,
      ],
      timeUnixNano: '7',
    }) as { resourceLogs: { scopeLogs: { logRecords: unknown[] }[] }[] }
    expect(req.resourceLogs[0]!.scopeLogs[0]!.logRecords).toEqual([
      {
        timeUnixNano: '7',
        observedTimeUnixNano: '7',
        severityNumber: 17,
        severityText: 'ERROR',
        body: { stringValue: 'boom' },
        attributes: [
          { key: 'cicd.pipeline.run.id', value: { stringValue: 'run-1' } },
          { key: 'vx.workspace.id', value: { stringValue: 'ws-test' } },
          { key: 'cicd.pipeline.task.name', value: { stringValue: 'a#build' } },
          { key: 'vx.log.status', value: { stringValue: 'failed' } },
          { key: 'vx.log.chars_full', value: { intValue: '4' } },
          { key: 'vx.log.truncated_head', value: { intValue: '0' } },
        ],
      },
    ])
  })

  it('an int attribute is an integer string: a fractional duration is truncated', () => {
    // OTLP's intValue is an int64 in decimal; "12.7" is not one, and a
    // collector rejects the attribute (or the span).
    const attrs = attrMap(
      taskSpanAttributes(
        {
          taskId: 'a#build',
          project: 'a',
          task: 'build',
          status: 'success',
          cacheSource: 'miss',
          exitCode: 0,
          durationMs: 12.7,
        } as TaskTelemetry,
        TASK_RUN,
      ),
    )
    expect(attrs['vx.task.duration_ms']).toBe('12')
  })
})

describe('a signal ships only to its own url (item 807)', () => {
  it('a traces-only endpoint exports traces alone: no metrics or logs POSTed to the traces url', () => {
    const warns: string[] = []
    const c = resolveOtelConfig(
      {},
      { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://t/v1/traces' },
      (m) => warns.push(m),
    )!
    // Off by default and nothing asked for: nothing said.
    expect({ metrics: c.metricsEnabled, logs: c.logsEnabled, warns }).toEqual({
      metrics: false,
      logs: false,
      warns: [],
    })
  })

  it('a metrics-only or logs-only endpoint exports that signal alone (F-45)', async () => {
    // Only a traces url kept the plugin in: a pipeline that set just a
    // metrics or logs endpoint declined whole and exported nothing.
    const posted = async (env: Record<string, string>): Promise<string[] | undefined> => {
      const urls: string[] = []
      const cfg = resolveOtelConfig({ post: async (url) => void urls.push(url) }, env)
      if (cfg === undefined) return undefined
      const sink = new OtelSink(cfg)
      sink.onRecord({ v: 1, kind: 'run.start', run: RUN, total: 0, ts: 1000 } as TelemetryRecord)
      sink.onRecord({ v: 1, kind: 'run.end', runId: 'run-1', ts: 1100 } as TelemetryRecord)
      sink.onRunSummary(summaryFor(RUN, []))
      await sink.flush()
      return urls.sort()
    }
    expect([
      await posted({ OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://m/v1/metrics' }),
      await posted({}),
    ]).toEqual([['http://m/v1/metrics'], undefined])
    // A logs-only endpoint: logs on, the others off (a log needs task output to post).
    const logs = resolveOtelConfig({}, { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://l/v1/logs' })
    expect([logs?.tracesEnabled, logs?.metricsEnabled, logs?.logsEnabled, logs?.logsUrl]).toEqual([
      false,
      false,
      true,
      'http://l/v1/logs',
    ])
  })

  it('a signal asked for by name with no url says so once, and stays off', () => {
    const warns: string[] = []
    const c = resolveOtelConfig(
      { metrics: true, logs: true },
      { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://t/v1/traces' },
      (m) => warns.push(m),
    )!
    expect({ metrics: c.metricsEnabled, logs: c.logsEnabled }).toEqual({
      metrics: false,
      logs: false,
    })
    expect(warns).toEqual([
      '[vx-otel] metrics: true but no metrics endpoint (OTEL_EXPORTER_OTLP_ENDPOINT or OTEL_EXPORTER_OTLP_METRICS_ENDPOINT) — metrics are not exported',
      '[vx-otel] logs: true but no logs endpoint (OTEL_EXPORTER_OTLP_ENDPOINT or OTEL_EXPORTER_OTLP_LOGS_ENDPOINT) — logs are not exported',
    ])
  })

  it('CONTROL: each signal with its own url is on, and nothing is said', () => {
    const warns: string[] = []
    const c = resolveOtelConfig(
      { metrics: true, logs: true },
      {
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://t/v1/traces',
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://m/v1/metrics',
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://l/v1/logs',
      },
      (m) => warns.push(m),
    )!
    expect([c.metricsEnabled, c.logsEnabled, c.metricsUrl, c.logsUrl, warns]).toEqual([
      true,
      true,
      'http://m/v1/metrics',
      'http://l/v1/logs',
      [],
    ])
  })
})

describe('what the vx-otel sweep found unheld (item 807)', () => {
  const BASE = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318' }

  it('headers: a key that is only whitespace is dropped; keys and values are trimmed', () => {
    expect(parseOtlpHeaders(' =v, k = v2 ,=x')).toEqual({ k: 'v2' })
  })

  it('a whitespace-only endpoint is as absent as an empty one', () => {
    expect(resolveOtelConfig({}, { OTEL_EXPORTER_OTLP_ENDPOINT: '  \n' })).toBeUndefined()
  })

  it('each per-signal option wins over its env var and the base', () => {
    const c = resolveOtelConfig(
      { tracesEndpoint: 'http://ot/t', metricsEndpoint: 'http://om/m' },
      {
        ...BASE,
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://et/t',
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://em/m',
      },
    )!
    expect([c.tracesUrl, c.metricsUrl]).toEqual(['http://ot/t', 'http://om/m'])
  })

  it('OTEL_LOGS_EXPORTER=none is read trimmed and in any case', () => {
    expect(resolveOtelConfig({}, { ...BASE, OTEL_LOGS_EXPORTER: ' NONE ' })!.logsEnabled).toBe(
      false,
    )
  })

  it('metrics: false, timeoutMs and post reach the config', () => {
    const post = async () => undefined
    const c = resolveOtelConfig({ metrics: false, timeoutMs: 1234, post }, BASE)!
    expect([c.metricsEnabled, c.timeoutMs, c.post]).toEqual([false, 1234, post])
  })
})

describe('OtelSink: the times, the headers and the version it ships (item 807)', () => {
  type Span = { name: string; startTimeUnixNano: string; endTimeUnixNano: string }
  const spansOf = (calls: { url: string; body: Record<string, unknown> }[]) =>
    (
      calls.find((c) => c.url === 'http://c/v1/traces')!.body as {
        resourceSpans: { scopeSpans: { scope: { version: string }; spans: Span[] }[] }[]
      }
    ).resourceSpans[0]!.scopeSpans[0]!
  const start = (sink: OtelSink, startedAt: number) =>
    sink.onRecord({
      v: 1,
      kind: 'run.start',
      run: RUN,
      total: 1,
      ts: startedAt,
      startedAt,
    } as TelemetryRecord)
  const end = (sink: OtelSink, ts: number, durationMs: number) =>
    sink.onRecord({
      v: 1,
      kind: 'task.end',
      runId: 'run-1',
      ts,
      taskId: 'a#build',
      project: 'a',
      task: 'build',
      status: 'success',
      cacheSource: 'miss',
      exitCode: 0,
      durationMs,
    } as TelemetryRecord)

  it('with no summary the root spans run.start to run.end; a task without task.start ends at ts, began durationMs before', async () => {
    const { cfg, calls } = mkConfig({ metricsEnabled: false, logsEnabled: false })
    const sink = new OtelSink(cfg)
    start(sink, 1000)
    end(sink, 1050.7, 40)
    sink.onRecord({ v: 1, kind: 'run.end', runId: 'run-1', ts: 1100 } as TelemetryRecord)
    await sink.flush()
    const { spans, scope } = spansOf(calls)
    expect(spans.map((s) => [s.name, s.startTimeUnixNano, s.endTimeUnixNano])).toEqual([
      ['vx.run', '1000000000', '1100000000'],
      ['vx.task', '1010000000', '1050000000'],
    ])
    expect(scope.version).toBe('1.2.3')
  })

  it('with no summary and no run.end the root ends where it began', async () => {
    const { cfg, calls } = mkConfig({ metricsEnabled: false, logsEnabled: false })
    const sink = new OtelSink(cfg)
    start(sink, 1000)
    end(sink, 1050, 40)
    await sink.flush()
    const root = spansOf(calls).spans[0]!
    expect([root.startTimeUnixNano, root.endTimeUnixNano]).toEqual(['1000000000', '1000000000'])
  })

  it('a summary’s own start and end win over the records’ times, for the root and the logs', async () => {
    const { cfg, calls } = mkConfig({ metricsEnabled: false })
    const sink = new OtelSink(cfg)
    start(sink, 1000)
    sink.onRecord({
      v: 2,
      kind: 'task.log',
      runId: 'run-1',
      taskId: 'a#build',
      stream: 'stdout',
      chunk: 'x',
      ts: 1020,
    } as TelemetryRecord)
    end(sink, 1050, 40)
    sink.onRecord({ v: 1, kind: 'run.end', runId: 'run-1', ts: 1100 } as TelemetryRecord)
    sink.onRunSummary({ ...summaryFor(RUN, []), startedAt: 900, endedAt: 2000 })
    await sink.flush()
    const root = spansOf(calls).spans[0]!
    expect([root.startTimeUnixNano, root.endTimeUnixNano]).toEqual(['900000000', '2000000000'])
    const logs = calls.find((c) => c.url === 'http://c/v1/logs')!.body as {
      resourceLogs: { scopeLogs: { logRecords: { timeUnixNano: string }[] }[] }[]
    }
    expect(logs.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!.timeUnixNano).toBe('2000000000')
  })

  it('a run that recorded nothing POSTs nothing', async () => {
    const { cfg, calls } = mkConfig()
    await new OtelSink(cfg).flush()
    expect(calls).toEqual([])
  })

  it('the configured headers ride every POST beside the content type', async () => {
    const seen: Record<string, string>[] = []
    const { cfg } = mkConfig({
      metricsEnabled: false,
      logsEnabled: false,
      headers: { authorization: 'Bearer k' },
      post: async (_u, _b, headers) => void seen.push(headers),
    })
    const sink = new OtelSink(cfg)
    start(sink, 1000)
    end(sink, 1050, 40)
    await sink.flush()
    expect(seen).toEqual([{ 'content-type': 'application/json', authorization: 'Bearer k' }])
  })

  // Item 923: `OTEL_EXPORTER_OTLP_<SIGNAL>_HEADERS` was not read.
  it('a signal’s own headers ride its POSTs over the shared ones; the option tops both', async () => {
    const seen: Record<string, Record<string, string>> = {}
    const cfg = resolveOtelConfig(
      {
        logs: false,
        headers: { 'x-top': 'opt' },
        post: async (url, _b, headers) => void (seen[url] = headers),
      },
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c',
        OTEL_EXPORTER_OTLP_HEADERS: 'a=shared,x-top=env',
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'a=traces%20only',
      },
    )!
    const sink = new OtelSink(cfg)
    start(sink, 1000)
    end(sink, 1050, 40)
    await sink.flush()
    // `a` is the traces header's, over the shared one; `x-top` the option's.
    expect(seen).toEqual({
      'http://c/v1/traces': {
        'content-type': 'application/json',
        a: 'traces only',
        'x-top': 'opt',
      },
    })
  })
})

// F-16: the root span was always UNSET with no `cicd.pipeline.result`, so a
// red run read as a clean one to a backend.
describe('the run span says how the run ended', () => {
  const task = (status: TaskTelemetry['status']): TaskTelemetry => ({
    taskId: 'a#build',
    project: 'a',
    task: 'build',
    status,
    cacheSource: 'miss',
    exitCode: status === 'failed' ? 1 : 0,
    durationMs: 40,
  })
  const ended = async (exitOk: boolean, abortedCount: number, tasks: TaskTelemetry[]) => {
    const { cfg, calls } = mkConfig({ metricsEnabled: false, logsEnabled: false })
    const sink = new OtelSink(cfg)
    sink.onRecord({ v: 1, kind: 'run.start', run: RUN, total: 1, ts: 1000 } as TelemetryRecord)
    sink.onRecord({ v: 1, kind: 'run.end', runId: 'run-1', ts: 1100 } as TelemetryRecord)
    sink.onRunSummary({ ...summaryFor(RUN, tasks), exitOk, abortedCount })
    await sink.flush()
    const spans = (
      calls[0]!.body as {
        resourceSpans: {
          scopeSpans: {
            spans: {
              name: string
              kind: number
              status: { code: number }
              attributes: { key: string; value: { stringValue?: string } }[]
            }[]
          }[]
        }[]
      }
    ).resourceSpans[0]!.scopeSpans[0]!.spans
    const root = spans.find((s) => s.name === 'vx.run')!
    const result = root.attributes.find((a) => a.key === 'cicd.pipeline.result')?.value.stringValue
    return [root.status.code, result, root.kind]
  }

  it('green, failed, stopped, and red with nothing failed', async () => {
    expect([
      await ended(true, 0, [task('success')]),
      await ended(false, 0, [task('failed')]),
      await ended(false, 1, [task('aborted')]),
      await ended(false, 0, []),
    ]).toEqual([
      [0, 'success', 1],
      [2, 'failure', 1],
      [2, 'cancellation', 1],
      [2, 'failure', 1],
    ])
  })
})

// Rows the vx-otel mutation sweep found missing (F-16).
describe('config the sweep left unpinned', () => {
  it('a header value keeps an `=` past the first (base64 padding)', () => {
    expect(parseOtlpHeaders('authorization=Basic%20dXNlcjpwYXNz==,x=a=b')).toEqual({
      authorization: 'Basic dXNlcjpwYXNz==',
      x: 'a=b',
    })
  })

  it('OTEL_SDK_DISABLED is read case- and space-insensitively', () => {
    const base = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c' }
    expect(
      ['TRUE', ' true ', 'false'].map((v) =>
        resolveOtelConfig({}, { ...base, OTEL_SDK_DISABLED: v }) === undefined ? 'off' : 'on',
      ),
    ).toEqual(['off', 'off', 'on'])
  })

  it('each signal reads its own headers variable; options top env for endpoint and name', () => {
    const c = resolveOtelConfig(
      { logsEndpoint: 'http://opt/logs', serviceName: 'svc-opt' },
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c',
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://env/logs',
        OTEL_SERVICE_NAME: 'svc-env',
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: 't=1',
        OTEL_EXPORTER_OTLP_METRICS_HEADERS: 'm=1',
        OTEL_EXPORTER_OTLP_LOGS_HEADERS: 'l=1',
      },
    )!
    expect([c.logsUrl, c.serviceName, c.signalHeaders]).toEqual([
      'http://opt/logs',
      'svc-opt',
      { traces: { t: '1' }, metrics: { m: '1' }, logs: { l: '1' } },
    ])
  })
})

// F-17: the standard OTLP env vars below were not read.
describe('the standard OTLP env a pipeline already sets', () => {
  const base = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c' }

  it('OTEL_RESOURCE_ATTRIBUTES reaches every signal’s resource, under vx’s identity', async () => {
    const bodies: Record<string, { resource: { attributes: unknown[] } }> = {}
    const cfg = resolveOtelConfig(
      {
        post: async (url, body) => {
          const b = JSON.parse(body) as Record<string, { resource: { attributes: unknown[] } }[]>
          bodies[url] = Object.values(b)[0]![0]!
        },
      },
      {
        ...base,
        OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment=ci,team=a%20b,service.version=9',
      },
    )!
    const sink = new OtelSink(cfg)
    const t: TaskTelemetry = {
      taskId: 'a#build',
      project: 'a',
      task: 'build',
      status: 'success',
      cacheSource: 'miss',
      exitCode: 0,
      durationMs: 40,
    }
    sink.onRecord({ v: 1, kind: 'run.start', run: RUN, total: 1, ts: 1000 } as TelemetryRecord)
    sink.onRecord({
      v: 1,
      kind: 'task.start',
      runId: 'run-1',
      taskId: 'a#build',
      ts: 1010,
    } as TelemetryRecord)
    sink.onRecord({
      v: 1,
      kind: 'task.log',
      runId: 'run-1',
      taskId: 'a#build',
      stream: 'stdout',
      chunk: 'hi',
      ts: 1020,
    } as TelemetryRecord)
    sink.onRecord({ v: 1, kind: 'task.end', runId: 'run-1', ts: 1050, ...t } as TelemetryRecord)
    sink.onRecord({ v: 1, kind: 'run.end', runId: 'run-1', ts: 1100 } as TelemetryRecord)
    sink.onRunSummary(summaryFor(RUN, [t]))
    await sink.flush()
    const expected = [
      { key: 'deployment.environment', value: { stringValue: 'ci' } },
      { key: 'team', value: { stringValue: 'a b' } },
      { key: 'service.name', value: { stringValue: 'vx' } },
      { key: 'service.version', value: { stringValue: '1.2.3' } },
    ]
    expect(Object.keys(bodies).sort()).toEqual([
      'http://c/v1/logs',
      'http://c/v1/metrics',
      'http://c/v1/traces',
    ])
    for (const b of Object.values(bodies)) expect(b.resource.attributes).toEqual(expected)
  })

  it('service.name: option, then OTEL_SERVICE_NAME, then the resource attribute', () => {
    const env = { ...base, OTEL_RESOURCE_ATTRIBUTES: 'service.name=from-res' }
    expect([
      resolveOtelConfig({}, env)!.serviceName,
      resolveOtelConfig({}, { ...env, OTEL_SERVICE_NAME: 'from-env' })!.serviceName,
      resolveOtelConfig({ serviceName: 'opt' }, { ...env, OTEL_SERVICE_NAME: 'from-env' })!
        .serviceName,
    ]).toEqual(['from-res', 'from-env', 'opt'])
  })

  it('OTEL_EXPORTER_OTLP_TIMEOUT sets the timeout; the option tops it; junk is unset', () => {
    expect([
      resolveOtelConfig({}, { ...base, OTEL_EXPORTER_OTLP_TIMEOUT: '2500' })!.timeoutMs,
      resolveOtelConfig({ timeoutMs: 100 }, { ...base, OTEL_EXPORTER_OTLP_TIMEOUT: '2500' })!
        .timeoutMs,
      resolveOtelConfig({}, { ...base, OTEL_EXPORTER_OTLP_TIMEOUT: 'soon' })!.timeoutMs,
      resolveOtelConfig({}, { ...base, OTEL_EXPORTER_OTLP_TIMEOUT: '0' })!.timeoutMs,
    ]).toEqual([2500, 100, 15_000, 15_000])
  })

  // F-49: the spec appends `v1/<signal>` to the base URL's PATH; a base with
  // a query had it stuck onto the query's last value.
  it('a base endpoint with a query keeps it after the signal path', () => {
    const urls = (endpoint: string) => {
      const c = resolveOtelConfig({}, { OTEL_EXPORTER_OTLP_ENDPOINT: endpoint })!
      return [c.tracesUrl, c.metricsUrl, c.logsUrl]
    }
    expect([
      urls('https://c/otlp?tenant=a'),
      urls('https://c/?t=a'),
      urls('http://c:4318/'),
    ]).toEqual([
      [
        'https://c/otlp/v1/traces?tenant=a',
        'https://c/otlp/v1/metrics?tenant=a',
        'https://c/otlp/v1/logs?tenant=a',
      ],
      ['https://c/v1/traces?t=a', 'https://c/v1/metrics?t=a', 'https://c/v1/logs?t=a'],
      ['http://c:4318/v1/traces', 'http://c:4318/v1/metrics', 'http://c:4318/v1/logs'],
    ])
  })

  it('OTEL_EXPORTER_OTLP_<SIGNAL>_TIMEOUT wins for its signal; the option tops both (F-49)', () => {
    const t = (opts: Parameters<typeof resolveOtelConfig>[0], env: Record<string, string>) =>
      resolveOtelConfig(opts, { ...base, ...env })!.signalTimeoutMs
    expect([
      t({}, { OTEL_EXPORTER_OTLP_TIMEOUT: '2500', OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: '2000' }),
      t({}, { OTEL_EXPORTER_OTLP_LOGS_TIMEOUT: 'soon' }),
      t({ timeoutMs: 100 }, { OTEL_EXPORTER_OTLP_METRICS_TIMEOUT: '2000' }),
    ]).toEqual([
      { traces: 2000, metrics: 2500, logs: 2500 },
      { traces: 15_000, metrics: 15_000, logs: 15_000 },
      { traces: 100, metrics: 100, logs: 100 },
    ])
  })

  // F-49: the Resource SDK spec discards the whole variable on a decoding
  // error; a malformed escape was sent as written.
  it('a malformed OTEL_RESOURCE_ATTRIBUTES is dropped whole and warned', () => {
    const warns: string[] = []
    const res = (raw: string) =>
      resolveOtelConfig({}, { ...base, OTEL_RESOURCE_ATTRIBUTES: raw }, (m) => warns.push(m))!
        .resource
    expect([res('team=a%ZZb,env=ci'), res('team,env=ci'), res('team=a%20b,env=ci')]).toEqual([
      {},
      {},
      { team: 'a b', env: 'ci' },
    ])
    expect(warns).toEqual([
      '[vx-otel] OTEL_RESOURCE_ATTRIBUTES is malformed (team=a%ZZb) — none of it is used',
      '[vx-otel] OTEL_RESOURCE_ATTRIBUTES is malformed (team) — none of it is used',
    ])
  })

  it('OTEL_EXPORTER_OTLP_COMPRESSION: a signal’s own wins, the option tops both, junk warns', () => {
    const warns: string[] = []
    const gzipOf = (opts: Parameters<typeof resolveOtelConfig>[0], env: Record<string, string>) =>
      resolveOtelConfig(opts, { ...base, ...env }, (m) => warns.push(m))!.gzip
    expect([
      gzipOf({}, {}),
      gzipOf({}, { OTEL_EXPORTER_OTLP_COMPRESSION: 'GZIP' }),
      gzipOf(
        {},
        {
          OTEL_EXPORTER_OTLP_COMPRESSION: 'gzip',
          OTEL_EXPORTER_OTLP_LOGS_COMPRESSION: 'none',
          OTEL_EXPORTER_OTLP_METRICS_COMPRESSION: ' ',
        },
      ),
      gzipOf({}, { OTEL_EXPORTER_OTLP_TRACES_COMPRESSION: 'gzip' }),
      gzipOf({ compression: 'none' }, { OTEL_EXPORTER_OTLP_COMPRESSION: 'gzip' }),
      gzipOf({ compression: 'gzip' }, {}),
      gzipOf({}, { OTEL_EXPORTER_OTLP_COMPRESSION: 'zstd' }),
    ]).toEqual([
      [],
      ['traces', 'metrics', 'logs'],
      ['traces', 'metrics'],
      ['traces'],
      [],
      ['traces', 'metrics', 'logs'],
      [],
    ])
    expect(warns).toEqual(['[vx-otel] compression "zstd" is not gzip or none — sent uncompressed'])
  })

  it('a gzip export reaches the collector gzipped, and decodes to the same OTLP', async () => {
    // The env was not read: a pipeline set for gzip sent raw JSON (F-33).
    const got: { encoding: string | null; spans: number }[] = []
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const raw = new Uint8Array(await req.arrayBuffer())
        const encoding = req.headers.get('content-encoding')
        const text = new TextDecoder().decode(encoding === 'gzip' ? Bun.gunzipSync(raw) : raw)
        const body = JSON.parse(text) as {
          resourceSpans: { scopeSpans: { spans: unknown[] }[] }[]
        }
        got.push({ encoding, spans: body.resourceSpans[0]!.scopeSpans[0]!.spans.length })
        return new Response('{}')
      },
    })
    try {
      const sink = new OtelSink(
        resolveOtelConfig(
          { metrics: false, logs: false },
          {
            OTEL_EXPORTER_OTLP_ENDPOINT: `http://localhost:${server.port}`,
            OTEL_EXPORTER_OTLP_COMPRESSION: 'gzip',
          },
        )!,
      )
      sink.onRecord({ v: 2, kind: 'run.start', run: RUN, total: 1, ts: 0, startedAt: 0 })
      sink.onRecord({ v: 2, kind: 'run.end', runId: RUN.runId, ts: 10 })
      await sink.flush()
      expect(got).toEqual([{ encoding: 'gzip', spans: 1 }])
    } finally {
      await server.stop(true)
    }
  })

  it('a failed export under a gRPC protocol says vx sends OTLP/HTTP only', async () => {
    const warns: string[] = []
    const cfg = resolveOtelConfig(
      {
        logs: false,
        post: async () => {
          throw new Error('socket closed')
        },
      },
      {
        ...base,
        OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
        OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: 'http/protobuf',
      },
      (m) => warns.push(m),
    )!
    const sink = new OtelSink(cfg)
    sink.onRecord({ v: 1, kind: 'run.start', run: RUN, total: 0, ts: 1000 } as TelemetryRecord)
    sink.onRecord({ v: 1, kind: 'run.end', runId: 'run-1', ts: 1100 } as TelemetryRecord)
    sink.onRunSummary(summaryFor(RUN, []))
    await sink.flush()
    expect(warns.sort()).toEqual([
      '[vx-otel] export failed for http://c/v1/metrics: socket closed',
      "[vx-otel] export failed for http://c/v1/traces: socket closed — the env asks for OTLP over gRPC, and vx sends OTLP/HTTP JSON only: point it at the collector's HTTP endpoint (port 4318)",
    ])
  })
})

// F-22: a run's spans (and its logs) went in ONE request each; 20 000 tasks
// made a 23 MiB trace, refused whole by a collector's 20 MiB default.
describe('a large run ships in requests a collector accepts', () => {
  const drive = async (n: number, post: (url: string, body: string) => Promise<void>) => {
    const warns: string[] = []
    const { cfg } = mkConfig({ metricsEnabled: false, post, warn: (m) => warns.push(m) })
    const sink = new OtelSink(cfg)
    sink.onRecord({
      v: 1,
      kind: 'run.start',
      run: RUN,
      total: n,
      ts: 1000,
      startedAt: 1000,
    } as TelemetryRecord)
    const tasks: TaskTelemetry[] = []
    for (let i = 0; i < n; i++) {
      const t: TaskTelemetry = {
        taskId: `p${i}#build`,
        project: `p${i}`,
        task: 'build',
        status: 'success',
        cacheSource: 'miss',
        exitCode: 0,
        durationMs: 1,
      }
      tasks.push(t)
      sink.onRecord({
        v: 1,
        kind: 'task.start',
        runId: 'run-1',
        taskId: t.taskId,
        ts: 1001,
      } as TelemetryRecord)
      sink.onRecord({
        v: 1,
        kind: 'task.log',
        runId: 'run-1',
        taskId: t.taskId,
        stream: 'stdout',
        chunk: 'ok',
        ts: 1002,
      } as TelemetryRecord)
      sink.onRecord({ v: 1, kind: 'task.end', runId: 'run-1', ts: 1050, ...t } as TelemetryRecord)
    }
    sink.onRecord({ v: 1, kind: 'run.end', runId: 'run-1', ts: 1100 } as TelemetryRecord)
    sink.onRunSummary(summaryFor(RUN, tasks))
    await sink.flush()
    return warns
  }

  it('at most 1 000 spans or log records per request, none lost', async () => {
    const per: Record<string, number[]> = {}
    await drive(2500, async (url, body) => {
      const b = JSON.parse(body) as Record<
        string,
        { scopeSpans?: { spans: unknown[] }[]; scopeLogs?: { logRecords: unknown[] }[] }[]
      >
      const r = Object.values(b)[0]![0]!
      const n = r.scopeSpans?.[0]!.spans.length ?? r.scopeLogs?.[0]!.logRecords.length ?? 0
      ;(per[url] ??= []).push(n)
    })
    expect(
      Object.fromEntries(Object.entries(per).map(([u, ns]) => [u, ns.sort((a, b) => b - a)])),
    ).toEqual({
      'http://c/v1/traces': [1000, 1000, 501],
      'http://c/v1/logs': [1000, 1000, 500],
    })
  })

  it('a down collector warns once per signal, with how many requests failed', async () => {
    const warns = await drive(1500, async () => {
      throw new Error('refused')
    })
    expect(warns.sort()).toEqual([
      '[vx-otel] export failed for http://c/v1/logs: refused (2 of 2 requests)',
      '[vx-otel] export failed for http://c/v1/traces: refused (2 of 2 requests)',
    ])
  })
})

// F-23: a sweep of sink.ts (114 mutants) — its byte-bound bug and the rows
// its real survivors lacked.
describe('the sink, past its sweep', () => {
  type Span = {
    traceId: string
    spanId: string
    parentSpanId?: string
    name: string
    startTimeUnixNano: string
    status: { code: number }
    attributes: { key: string; value: { stringValue?: string; intValue?: string } }[]
  }
  const spansOf = (calls: { url: string; body: Record<string, unknown> }[]): Span[] =>
    calls
      .filter((c) => c.url.endsWith('/v1/traces'))
      .flatMap(
        (c) =>
          (c.body as { resourceSpans: { scopeSpans: { spans: Span[] }[] }[] }).resourceSpans[0]!
            .scopeSpans[0]!.spans,
      )
  const attr = (s: Span, k: string) => {
    const v = s.attributes.find((a) => a.key === k)?.value
    return v?.stringValue ?? v?.intValue
  }
  const task = (over: Partial<TaskTelemetry> = {}): TaskTelemetry => ({
    taskId: 'a#build',
    project: 'a',
    task: 'build',
    status: 'success',
    cacheSource: 'miss',
    exitCode: 0,
    durationMs: 1000,
    ...over,
  })
  const start = (sink: OtelSink) =>
    sink.onRecord({
      v: 1,
      kind: 'run.start',
      run: RUN,
      total: 1,
      ts: 900,
      startedAt: 900,
    } as TelemetryRecord)

  // F-53: the limit is BYTES; an ASCII escape is one byte a character, so a
  // cut that counted characters passed. `€` is three.
  it.each([
    ['\x01', 'an escaped control'],
    ['€', 'a multibyte character'],
  ])('one logs request stays under 4 MiB however the tails escape (%#: %s)', async (ch) => {
    const sizes: number[] = []
    const { cfg } = mkConfig({
      tracesEnabled: false,
      metricsEnabled: false,
      post: async (url, body) =>
        void (url.endsWith('/v1/logs') && sizes.push(Buffer.byteLength(body))),
    })
    const sink = new OtelSink(cfg)
    start(sink)
    for (let i = 0; i < 64; i++) {
      const t = task({ taskId: `p${i}#build`, status: 'failed', exitCode: 1 })
      sink.onRecord({
        v: 1,
        kind: 'task.start',
        runId: 'run-1',
        taskId: t.taskId,
        ts: 901,
      } as TelemetryRecord)
      sink.onRecord({
        v: 1,
        kind: 'task.log',
        runId: 'run-1',
        taskId: t.taskId,
        stream: 'stdout',
        chunk: ch.repeat(128 * 1024),
        ts: 902,
      } as TelemetryRecord)
      sink.onRecord({ v: 1, kind: 'task.end', runId: 'run-1', ts: 903, ...t } as TelemetryRecord)
    }
    await sink.flush()
    expect([sizes.length > 1, sizes.every((n) => n <= 4 * 1024 * 1024)]).toEqual([true, true])
  })

  it('ids, a task span’s start, status and run attributes, as the sink ships them', async () => {
    const { cfg, calls } = mkConfig({ metricsEnabled: false, logsEnabled: false })
    const sink = new OtelSink(cfg)
    start(sink)
    sink.onRecord({
      v: 1,
      kind: 'task.start',
      runId: 'run-1',
      taskId: 'a#build',
      ts: 1000,
    } as TelemetryRecord)
    sink.onRecord({
      v: 1,
      kind: 'task.end',
      runId: 'run-1',
      ts: 5000,
      ...task({ status: 'failed', exitCode: 1 }),
    } as TelemetryRecord)
    // A skipped task ends with no start: it still gets a span id.
    sink.onRecord({
      v: 1,
      kind: 'task.end',
      runId: 'run-1',
      ts: 5000,
      ...task({ taskId: 'b#build', status: 'skipped' }),
    } as TelemetryRecord)
    sink.onRecord({ v: 1, kind: 'run.end', runId: 'run-1', ts: 6000 } as TelemetryRecord)
    await sink.flush()
    const spans = spansOf(calls)
    const a = spans.find(
      (s) => s.name === 'vx.task' && attr(s, 'cicd.pipeline.task.name') === 'a#build',
    )!
    const b = spans.find(
      (s) => s.name === 'vx.task' && attr(s, 'cicd.pipeline.task.name') === 'b#build',
    )!
    expect([
      spans.every((s) => /^[0-9a-f]{32}$/.test(s.traceId) && /^[0-9a-f]{16}$/.test(s.spanId)),
      spans
        .filter((s) => s.name === 'vx.task')
        .every((s) => /^[0-9a-f]{16}$/.test(s.parentSpanId ?? '')),
      /^[0-9a-f]{16}$/.test(b.spanId),
      a.startTimeUnixNano,
      a.status.code,
      [
        attr(a, 'cicd.pipeline.run.id'),
        attr(a, 'vx.workspace.id'),
        attr(a, 'vx.task.run_started_at'),
      ],
    ]).toEqual([true, true, true, '1000000000', 2, ['run-1', RUN.workspaceId, '900']])
  })

  it('what the sink asks core for, with logs on and off', () => {
    const on = new OtelSink(mkConfig().cfg)
    const off = new OtelSink(mkConfig({ logsEnabled: false }).cfg)
    expect([on.wants, off.wants]).toEqual([
      ['run.start', 'task.start', 'task.log', 'task.end', 'run.end'],
      ['run.start', 'task.start', 'task.end', 'run.end'],
    ])
  })

  it('a part-failed export, a throwing transport and an unparsable URL each warn once, right', async () => {
    const run = async (
      n: number,
      post: (url: string, body: string) => Promise<void>,
      over = {},
    ) => {
      const warns: string[] = []
      const { cfg } = mkConfig({
        metricsEnabled: false,
        logsEnabled: false,
        post,
        warn: (m: string) => warns.push(m),
        ...over,
      })
      const sink = new OtelSink(cfg)
      start(sink)
      for (let i = 0; i < n; i++) {
        sink.onRecord({
          v: 1,
          kind: 'task.end',
          runId: 'run-1',
          ts: 1000,
          ...task({ taskId: `p${i}#build` }),
        } as TelemetryRecord)
      }
      sink.onRecord({ v: 1, kind: 'run.end', runId: 'run-1', ts: 2000 } as TelemetryRecord)
      await sink.flush()
      return warns
    }
    let posts = 0
    const partly = await run(2499, async () => {
      if (++posts === 2) throw new Error('second refused')
    })
    let exact = 0
    await run(999, async () => void exact++)
    const sync = await run(1, (() => {
      throw new Error('sync')
    }) as never)
    const unparsable = await run(
      1,
      async () => {
        throw new Error('down')
      },
      { tracesUrl: 'http://u:tok@h:99999/v1/traces' },
    )
    expect([partly, exact, sync, unparsable]).toEqual([
      ['[vx-otel] export failed for http://c/v1/traces: second refused (1 of 3 requests)'],
      1,
      ['[vx-otel] export failed for http://c/v1/traces: sync'],
      ['[vx-otel] export failed for (an unparsable URL): down'],
    ])
  })
})

// F-56: a mutation sweep of plugin.ts (226 mutants, 157 caught) found these
// unheld, and one bug (the timeout past a timer's range).
describe('the OTLP env, as its second sweep found it unheld', () => {
  const base = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c' }

  it('a metrics or logs header no request can carry is dropped too', () => {
    const warns: string[] = []
    const c = resolveOtelConfig(
      {},
      {
        ...base,
        OTEL_EXPORTER_OTLP_METRICS_HEADERS: 'Authorization=a%0Ab,x-m=1',
        OTEL_EXPORTER_OTLP_LOGS_HEADERS: 'Authorization=a%0Ab,x-l=1',
      },
      (m) => warns.push(m),
    )!
    expect([c.signalHeaders?.metrics, c.signalHeaders?.logs, warns.length > 0]).toEqual([
      { 'x-m': '1' },
      { 'x-l': '1' },
      true,
    ])
  })

  it('a header value: CR, NUL and past Latin-1 are dropped; é and a trailing newline kept', () => {
    const warns: string[] = []
    const c = resolveOtelConfig(
      {
        headers: { cr: 'a\rb', nul: 'a\0b', wide: 'aĀb', both: 'Ā\nb', latin: 'é', trail: 'v\n' },
      },
      base,
      (m) => warns.push(m),
    )!
    expect([c.headers, warns.sort()]).toEqual([
      { latin: 'é', trail: 'v\n' },
      [
        '[vx-otel] header "both" holds a line break or NUL, which no HTTP header can carry — not sent (its value is not printed)',
        '[vx-otel] header "cr" holds a line break or NUL, which no HTTP header can carry — not sent (its value is not printed)',
        '[vx-otel] header "nul" holds a line break or NUL, which no HTTP header can carry — not sent (its value is not printed)',
        '[vx-otel] header "wide" holds a character past Latin-1, which no HTTP header can carry — not sent (its value is not printed)',
      ],
    ])
  })

  it('OTEL_TRACES_EXPORTER=otlp keeps traces on (control for =none)', () => {
    expect(resolveOtelConfig({}, { ...base, OTEL_TRACES_EXPORTER: 'otlp' })!.tracesEnabled).toBe(
      undefined,
    )
  })

  it('OTEL_RESOURCE_ATTRIBUTES: decoded, trimmed keys; a value may hold =; the last duplicate wins', () => {
    const warns: string[] = []
    const res = (raw: string) =>
      resolveOtelConfig({}, { ...base, OTEL_RESOURCE_ATTRIBUTES: raw }, (m) => warns.push(m))!
        .resource
    expect([res(' team%20a = x ,'), res('q=a=b'), res('k=1,k=2'), res('=v,env=ci')]).toEqual([
      { 'team a': 'x' },
      { q: 'a=b' },
      { k: '2' },
      {},
    ])
    expect(warns).toEqual([
      '[vx-otel] OTEL_RESOURCE_ATTRIBUTES is malformed (=v) — none of it is used',
    ])
  })

  it('an empty endpoint option falls back like an empty env var', () => {
    const c = resolveOtelConfig({ tracesEndpoint: '', endpoint: '' }, base)!
    expect(c.tracesUrl).toBe('http://c/v1/traces')
  })
})
