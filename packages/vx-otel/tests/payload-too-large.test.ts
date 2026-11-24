// A collector that answers 413 to a body over its limit lost the whole
// request: 1 000 spans is ~1.2 MiB, past a 1 MB intake, so every run's trace
// past its first few hundred tasks was dropped with one warning. A refused
// body is now sent again in halves until each fits or is one item
// (hardening, 2026-11-24).

import { afterAll, beforeAll, expect, it } from 'bun:test'
import type { RunContextRecord, TelemetryRecord } from '@vzn/vx'
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
  ci: false,
  host: 'h',
  os: 'linux',
  arch: 'x64',
} as unknown as RunContextRecord

let limit = 0
let spans = 0
let sizes: number[] = []
let server: ReturnType<typeof Bun.serve>

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.text()
      sizes.push(body.length)
      if (body.length > limit) return new Response('request body too large', { status: 413 })
      const parsed = JSON.parse(body) as {
        resourceSpans: { scopeSpans: { spans: unknown[] }[] }[]
      }
      for (const r of parsed.resourceSpans) for (const s of r.scopeSpans) spans += s.spans.length
      return new Response('{}')
    },
  })
})
afterAll(() => server.stop(true))

async function exportTasks(n: number, max: number): Promise<{ spans: number; warnings: string[] }> {
  limit = max
  spans = 0
  sizes = []
  const warnings: string[] = []
  const sink = new OtelSink({
    tracesUrl: `http://127.0.0.1:${server.port}/v1/traces`,
    metricsUrl: `http://127.0.0.1:${server.port}/v1/metrics`,
    logsUrl: `http://127.0.0.1:${server.port}/v1/logs`,
    serviceName: 'vx',
    headers: {},
    metricsEnabled: false,
    logsEnabled: false,
    timeoutMs: 5_000,
    warn: (m) => warnings.push(m),
  })
  const rec = (r: Record<string, unknown>) =>
    sink.onRecord({ v: 1, ...r } as unknown as TelemetryRecord)
  rec({ kind: 'run.start', run: RUN, total: n, ts: 1000, startedAt: 1000 })
  for (let i = 0; i < n; i++) {
    const taskId = `p${i}#build`
    rec({ kind: 'task.start', runId: 'run-1', taskId, project: `p${i}`, task: 'build', ts: 1001 })
    rec({
      kind: 'task.end',
      runId: 'run-1',
      ts: 1002,
      taskId,
      project: `p${i}`,
      task: 'build',
      status: 'success',
      cacheSource: 'miss',
      exitCode: 0,
      durationMs: 1,
      hash: 'h'.repeat(16),
    })
  }
  rec({ kind: 'run.end', runId: 'run-1', ts: 2000 })
  await sink.flush()
  return { spans, warnings }
}

it('a 413 sends the refused body again in halves until each fits', async () => {
  const got = await exportTasks(1500, 200_000)
  // 1 500 task spans, the run's root and its stages: every one arrives.
  expect({ all: got.spans >= 1501, warnings: got.warnings }).toEqual({ all: true, warnings: [] })
  expect(Math.max(...sizes.filter((s) => s <= limit))).toBeLessThanOrEqual(limit)
}, 30_000)

it('a single item the collector still refuses is warned, the rest delivered', async () => {
  const got = await exportTasks(3, 50)
  expect(got.spans).toBe(0)
  expect(got.warnings.length).toBe(1)
  expect(got.warnings[0]).toContain('HTTP 413')
})
