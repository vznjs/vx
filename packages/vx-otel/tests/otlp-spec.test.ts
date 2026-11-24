// Every payload a run exports, read by a receiver that holds it to the OTLP
// JSON encoding (opentelemetry-proto, OTLP/HTTP JSON): ids as lowercase hex
// of the right width, 64-bit integers as decimal strings, enums as numbers,
// one trace per run, each task a child of the run's span, each link to a
// span the trace holds, semantic-convention resource values, and at most
// 1 000 records in one request (hardening, 2026-11-24).

import { afterAll, beforeAll, expect, it } from 'bun:test'
import type { RunContextRecord, RunSummaryRecord, TelemetryRecord } from '@vzn/vx'
import { OtelSink } from '../src/sink.js'

const RUN = {
  runId: 'run-1',
  vxVersion: '1.2.3',
  workspaceId: 'ws',
  workspaceName: 'ws',
  command: 'vx run build',
  requestedTasks: ['build'],
  cachePolicy: 'local:rw,remote:',
  concurrency: 4,
  flow: 'broad',
  commitSha: 'abc',
  branch: 'main',
  defaultBranch: 'main',
  dirty: false,
  ci: true,
  ciProvider: 'github',
  ciAttempt: 2,
  host: 'h',
  os: 'darwin',
  arch: 'x64',
} satisfies RunContextRecord

type Json = Record<string, unknown>
const bodies: Record<string, Json[]> = {}
let server: ReturnType<typeof Bun.serve>

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const kind = new URL(req.url).pathname
      expect(req.headers.get('content-type')).toBe('application/json')
      ;(bodies[kind] ??= []).push((await req.json()) as Json)
      return new Response('{}', { headers: { 'content-type': 'application/json' } })
    },
  })
})
afterAll(() => server.stop(true))

/** A value as a fault message shows it. */
const j = (x: unknown): string => (typeof x === 'string' ? x : JSON.stringify(x))

const HEX32 = /^[0-9a-f]{32}$/
const HEX16 = /^[0-9a-f]{16}$/
const UINT64 = /^(0|[1-9][0-9]*)$/

/** What a spec-holding receiver refuses in one AnyValue, as messages. */
function anyValueFaults(v: Json, at: string): string[] {
  const keys = Object.keys(v)
  if (keys.length !== 1) return [`${at}: AnyValue has ${keys.length} fields`]
  const [k] = keys as [string]
  const x = v[k]
  switch (k) {
    case 'stringValue':
      return typeof x === 'string' ? [] : [`${at}: stringValue ${typeof x}`]
    case 'boolValue':
      return typeof x === 'boolean' ? [] : [`${at}: boolValue ${typeof x}`]
    case 'intValue':
      return typeof x === 'string' && /^-?(0|[1-9][0-9]*)$/.test(x)
        ? []
        : [`${at}: intValue ${JSON.stringify(x)}`]
    case 'doubleValue':
      return typeof x === 'number' && Number.isFinite(x) ? [] : [`${at}: doubleValue ${j(x)}`]
    case 'arrayValue':
      return ((x as { values?: Json[] }).values ?? []).flatMap((e, i) =>
        anyValueFaults(e, `${at}[${i}]`),
      )
    case 'kvlistValue':
      return attributeFaults((x as { values?: Json[] }).values ?? [], at)
    default:
      return [`${at}: unknown AnyValue field ${k}`]
  }
}

function attributeFaults(attrs: Json[], at: string): string[] {
  const seen = new Set<string>()
  return attrs.flatMap((a) => {
    const key = a['key'] as string
    const out: string[] = []
    if (typeof key !== 'string' || key === '') out.push(`${at}: attribute without a key`)
    if (seen.has(key)) out.push(`${at}: attribute ${key} twice`)
    seen.add(key)
    return [...out, ...anyValueFaults(a['value'] as Json, `${at}.${key}`)]
  })
}

function nanosFaults(start: unknown, end: unknown, at: string): string[] {
  if (typeof end !== 'string' || !UINT64.test(end)) return [`${at}: time ${JSON.stringify(end)}`]
  if (start === undefined) return []
  if (typeof start !== 'string' || !UINT64.test(start))
    return [`${at}: start ${JSON.stringify(start)}`]
  return BigInt(start) <= BigInt(end) ? [] : [`${at}: starts after it ends`]
}

function resourceOf(r: Json): Map<string, unknown> {
  const attrs = (r['resource'] as { attributes: Json[] }).attributes
  return new Map(attrs.map((a) => [a['key'] as string, Object.values(a['value'] as Json)[0]]))
}

it('every exported request holds to the OTLP JSON encoding and one trace', async () => {
  for (const k of Object.keys(bodies)) delete bodies[k]
  const warnings: string[] = []
  const base = `http://127.0.0.1:${server.port}`
  const sink = new OtelSink({
    tracesUrl: `${base}/v1/traces`,
    metricsUrl: `${base}/v1/metrics`,
    logsUrl: `${base}/v1/logs`,
    serviceName: 'vx',
    headers: {},
    metricsEnabled: true,
    logsEnabled: true,
    timeoutMs: 5_000,
    warn: (m) => warnings.push(m),
  })
  const rec = (r: Json) => sink.onRecord({ v: 4, runId: 'run-1', ...r } as TelemetryRecord)
  const N = 3000
  rec({ kind: 'run.start', run: RUN, total: N + 2, ts: 1000, startedAt: 1000 })
  const ends: Json[] = []
  for (let i = 0; i < N; i++) {
    const taskId = `p${i}#build`
    const dependsOn = i === 0 ? [] : [`p${j(i - 1)}#build`]
    rec({ kind: 'task.start', taskId, project: `p${i}`, task: 'build', ts: 1001 + i, dependsOn })
    rec({ kind: 'task.sample', taskId, ts: 1002 + i, cpuMs: 5, rssBytes: 4096 })
    rec({ kind: 'task.log', taskId, stream: 'stdout', chunk: `built ${i}\n`, ts: 1002 + i })
    const end = {
      kind: 'task.end',
      ts: 1003 + i,
      taskId,
      project: `p${i}`,
      task: 'build',
      status: i === N - 1 ? 'failed' : 'success',
      cacheSource: 'miss',
      exitCode: i === N - 1 ? 1 : 0,
      durationMs: 2,
      hash: 'h'.repeat(16),
    }
    ends.push(end)
    rec(end)
  }
  const skip = {
    kind: 'task.end',
    ts: 1003 + N,
    taskId: 'q#build',
    project: 'q',
    task: 'build',
    status: 'skipped',
    cacheSource: 'miss',
    exitCode: null,
    durationMs: 0,
  }
  ends.push(skip)
  rec(skip)
  sink.onRunSummary({
    v: 4,
    run: RUN,
    startedAt: 1000,
    endedAt: 1100 + N,
    totalDurationMs: 100 + N,
    taskCount: ends.length,
    failedCount: 1,
    abortedCount: 0,
    hitCount: 0,
    hitLocalCount: 0,
    hitRemoteCount: 0,
    upToDateCount: 0,
    restoredLocalCount: 0,
    restoredRemoteCount: 0,
    exitOk: false,
    tasks: ends,
  } as unknown as RunSummaryRecord)
  rec({ kind: 'run.end', ts: 1100 + N })
  await sink.flush()

  const faults: string[] = []
  const traces = bodies['/v1/traces'] ?? []
  const spans: Json[] = []
  let perRequest = 0
  for (const body of traces) {
    let n = 0
    for (const rs of body['resourceSpans'] as Json[]) {
      const res = resourceOf(rs)
      if (res.get('service.name') !== 'vx') faults.push('service.name')
      if (res.get('os.type') !== 'darwin') faults.push(`os.type ${j(res.get('os.type'))}`)
      if (res.get('host.arch') !== 'amd64') faults.push(`host.arch ${j(res.get('host.arch'))}`)
      faults.push(...attributeFaults((rs['resource'] as { attributes: Json[] }).attributes, 'res'))
      for (const ss of rs['scopeSpans'] as Json[]) {
        if (typeof (ss['scope'] as Json | undefined)?.['name'] !== 'string') faults.push('scope')
        for (const s of ss['spans'] as Json[]) {
          n++
          spans.push(s)
        }
      }
    }
    perRequest = Math.max(perRequest, n)
  }
  const traceIds = new Set(spans.map((s) => s['traceId']))
  const ids = new Set(spans.map((s) => s['spanId']))
  const root = spans.find((s) => s['name'] === 'vx.run')
  const taskSpans = spans.filter((s) => s['name'] === 'vx.task')
  for (const s of spans) {
    const at = `${j(s['name'])}`
    if (!HEX32.test(s['traceId'] as string) || /^0+$/.test(s['traceId'] as string))
      faults.push(`${at}: traceId ${j(s['traceId'])}`)
    if (!HEX16.test(s['spanId'] as string) || /^0+$/.test(s['spanId'] as string))
      faults.push(`${at}: spanId ${j(s['spanId'])}`)
    if (s['parentSpanId'] !== undefined && !ids.has(s['parentSpanId']))
      faults.push(`${at}: parent not in the trace`)
    if (!Number.isInteger(s['kind'])) faults.push(`${at}: kind ${j(s['kind'])}`)
    const code = (s['status'] as Json | undefined)?.['code']
    if (code !== undefined && ![0, 1, 2].includes(code as number))
      faults.push(`${at}: status ${j(code)}`)
    faults.push(...nanosFaults(s['startTimeUnixNano'], s['endTimeUnixNano'], at))
    faults.push(...attributeFaults((s['attributes'] as Json[]) ?? [], at))
    for (const e of (s['events'] as Json[]) ?? []) {
      faults.push(...nanosFaults(undefined, e['timeUnixNano'], `${at} event`))
      faults.push(...attributeFaults((e['attributes'] as Json[]) ?? [], `${at} event`))
    }
    for (const l of (s['links'] as Json[]) ?? []) {
      if (l['traceId'] !== s['traceId']) faults.push(`${at}: link to another trace`)
      if (!ids.has(l['spanId'])) faults.push(`${at}: link to a span the trace lacks`)
      faults.push(...attributeFaults((l['attributes'] as Json[]) ?? [], `${at} link`))
    }
  }
  const unparented = taskSpans.filter((s) => s['parentSpanId'] !== root?.['spanId']).length
  const linked = taskSpans.filter((s) => ((s['links'] as Json[]) ?? []).length === 1).length

  let logs = 0
  let logsPerRequest = 0
  for (const body of bodies['/v1/logs'] ?? []) {
    let n = 0
    for (const rl of body['resourceLogs'] as Json[])
      for (const sl of rl['scopeLogs'] as Json[])
        for (const l of sl['logRecords'] as Json[]) {
          n++
          logs++
          faults.push(...nanosFaults(undefined, l['timeUnixNano'], 'log'))
          if (l['observedTimeUnixNano'] !== undefined)
            faults.push(...nanosFaults(undefined, l['observedTimeUnixNano'], 'log observed'))
          if (!Number.isInteger(l['severityNumber'])) faults.push('log severityNumber')
          if (l['traceId'] !== undefined && !traceIds.has(l['traceId'])) faults.push('log traceId')
          if (l['spanId'] !== undefined && !ids.has(l['spanId'])) faults.push('log spanId')
          faults.push(...attributeFaults((l['attributes'] as Json[]) ?? [], 'log'))
          if (l['body'] !== undefined) faults.push(...anyValueFaults(l['body'] as Json, 'log body'))
        }
    logsPerRequest = Math.max(logsPerRequest, n)
  }

  let points = 0
  for (const body of bodies['/v1/metrics'] ?? [])
    for (const rm of body['resourceMetrics'] as Json[])
      for (const sm of rm['scopeMetrics'] as Json[])
        for (const m of sm['metrics'] as Json[]) {
          if (typeof m['name'] !== 'string') faults.push('metric name')
          const data = (m['sum'] ?? m['gauge'] ?? m['histogram']) as Json | undefined
          if (data === undefined) {
            faults.push(`metric ${j(m['name'])}: no data`)
            continue
          }
          const temporality = data['aggregationTemporality']
          if (m['gauge'] === undefined && ![1, 2].includes(temporality as number))
            faults.push(`metric ${j(m['name'])}: temporality ${j(temporality)}`)
          for (const p of data['dataPoints'] as Json[]) {
            points++
            faults.push(
              ...nanosFaults(p['startTimeUnixNano'], p['timeUnixNano'], `${j(m['name'])}`),
            )
            faults.push(...attributeFaults((p['attributes'] as Json[]) ?? [], `${j(m['name'])}`))
            if (
              p['asInt'] !== undefined &&
              (typeof p['asInt'] !== 'string' || !/^-?\d+$/.test(p['asInt'] as string))
            )
              faults.push(`${j(m['name'])}: asInt ${JSON.stringify(p['asInt'])}`)
            if (
              p['count'] !== undefined &&
              (typeof p['count'] !== 'string' || !UINT64.test(p['count'] as string))
            )
              faults.push(`${j(m['name'])}: count ${JSON.stringify(p['count'])}`)
            for (const c of (p['bucketCounts'] as unknown[]) ?? [])
              if (typeof c !== 'string' || !UINT64.test(c)) {
                faults.push(`${j(m['name'])}: bucketCount ${JSON.stringify(c)}`)
                break
              }
          }
        }

  expect({
    faults: [...new Set(faults)].slice(0, 20),
    warnings,
    traceIds: traceIds.size,
    rootIsTop: root !== undefined && root['parentSpanId'] === undefined,
    taskSpans: taskSpans.length,
    uniqueSpanIds: ids.size === spans.length,
    unparented,
    linked,
    spansPerRequestAtMost1000: perRequest <= 1000,
    logs,
    logsPerRequestAtMost1000: logsPerRequest <= 1000,
    metrics: points > 0,
  }).toEqual({
    faults: [],
    warnings: [],
    traceIds: 1,
    rootIsTop: true,
    taskSpans: N + 1,
    uniqueSpanIds: true,
    unparented: 0,
    linked: N - 1,
    spansPerRequestAtMost1000: true,
    logs: N,
    logsPerRequestAtMost1000: true,
    metrics: true,
  })
}, 60_000)
