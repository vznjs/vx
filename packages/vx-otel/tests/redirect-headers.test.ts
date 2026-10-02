// An OTLP header is often the vendor's API key (`x-honeycomb-team`,
// `dd-api-key`). Bun's fetch follows a redirect and drops only
// `Authorization` across origins, so a collector that answered 307 to
// another origin had the key sent there (probed, Bun 1.4.2; L-43). The
// OTel SDK exporters follow no redirect; neither does this one.
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { OtelSink } from '../src/sink.js'
import type { RunContextRecord } from '@vzn/vx'

const RUN: RunContextRecord = {
  runId: 'r',
  vxVersion: '1.2.3',
  workspaceId: 'ws',
  workspaceName: 'ws',
  command: 'vx run b',
  requestedTasks: ['b'],
  cachePolicy: 'lR,lW',
  concurrency: 1,
  flow: 'focused',
  commitSha: 'abc',
  branch: 'main',
  defaultBranch: 'main',
  dirty: false,
  ci: false,
  ciProvider: null,
  host: 'h',
  os: 'linux',
  arch: 'x64',
  tags: {},
}

let srv: ReturnType<typeof Bun.serve>
const moved: (string | null)[] = []

beforeAll(() => {
  srv = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url)
      if (u.pathname === '/moved') {
        moved.push(req.headers.get('x-honeycomb-team'))
        return new Response('{}')
      }
      // 127.0.0.1 and localhost on one port are two origins.
      return Response.redirect(`http://localhost:${srv.port}/moved`, 307)
    },
  })
})
afterAll(() => srv.stop(true))

it('a collector that redirects is refused, and the key never leaves for the new origin', async () => {
  const warnings: string[] = []
  const sink = new OtelSink({
    tracesUrl: `http://127.0.0.1:${srv.port}/v1/traces`,
    metricsUrl: '',
    logsUrl: '',
    serviceName: 'vx',
    headers: { 'x-honeycomb-team': 'HCKEY' },
    metricsEnabled: false,
    logsEnabled: false,
    timeoutMs: 5_000,
    warn: (m) => void warnings.push(m),
  })
  sink.onRecord({ v: 1, kind: 'run.start', run: RUN, total: 1, ts: 1, startedAt: 1 } as never)
  sink.onRecord({
    v: 1,
    kind: 'task.end',
    runId: 'r',
    ts: 2,
    taskId: 'a#b',
    project: 'a',
    task: 'b',
    status: 'success',
    cacheSource: 'miss',
    exitCode: 0,
    durationMs: 1,
  } as never)
  await sink.flush(new AbortController().signal)
  expect(moved).toEqual([])
  expect(warnings.map((w) => w.replace(/127\.0\.0\.1:\d+|localhost:\d+/g, 'H'))).toEqual([
    '[vx-otel] export failed for http://H/v1/traces: HTTP 307: the collector redirected to http://H/moved; OTLP exporters follow no redirect — set the endpoint to where it points',
  ])
})
