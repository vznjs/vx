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
})

describe('resolveOtelConfig', () => {
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
    expect(m['cicd.pipeline.task.run.result']).toBe('failed')
    expect(m['vx.cache.source']).toBe('miss')
    expect(m['vx.task.hash']).toBe('deadbeef')
    expect(m['vx.peak_rss_bytes']).toBe('2048')
    expect(taskStatusCode(t)).toBe(2)
    expect(taskStatusCode({ ...t, status: 'success' })).toBe(0)
    expect(taskStatusCode({ ...t, status: 'cache-hit' })).toBe(0)
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

  it('the metrics request: every counter with its value, cumulative and monotonic, and the gauge', () => {
    const summary: RunSummaryRecord = {
      v: 1,
      run: RUN,
      startedAt: 0,
      endedAt: 1000,
      totalDurationMs: 1234,
      taskCount: 5,
      failedCount: 1,
      hitCount: 3,
      hitLocalCount: 2,
      hitRemoteCount: 1,
      exitOk: false,
      tasks: [],
    }
    const sum = (name: string, v: number, attributes: unknown[] = []) => ({
      name,
      sum: {
        dataPoints: [{ asInt: String(v), timeUnixNano: '9', attributes }],
        aggregationTemporality: 2,
        isMonotonic: true,
      },
    })
    expect(buildMetricsRequest('vx', summary, '9')).toEqual({
      resourceMetrics: [
        {
          resource: { attributes: resource },
          scopeMetrics: [
            {
              scope: { name: 'vx', version: '1.2.3' },
              metrics: [
                sum('vx.tasks.total', 5),
                sum('vx.tasks.failed', 1),
                sum('vx.tasks.cache_hits', 2, [{ key: 'source', value: { stringValue: 'local' } }]),
                sum('vx.tasks.cache_hits', 1, [
                  { key: 'source', value: { stringValue: 'remote' } },
                ]),
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
})
