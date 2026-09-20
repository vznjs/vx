// The transport, against a real collector. The suite next door injects
// `post`, so `defaultPost` — the code every adopter actually runs — was
// never exercised: a collector that ANSWERS a refusal (401 from a wrong
// token, 404 from a wrong path, 500 from a wedged pipeline) does not make
// `fetch` throw, and the sink's own catch never fired. Every run exported
// nothing and said nothing (walked the adopter's path, 2026-09-20).
//
// One real server per case, and the run driven through the sink rather
// than the CLI: the claim is about what the transport does with a response.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { OtelSink } from '../src/sink.js'
import type { RunContextRecord, TaskTelemetry, TelemetryRecord } from '@vzn/vx'

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
  tags: {},
}

type Reply = { status: number; body: string }
let reply: Reply = { status: 200, body: '{}' }
let server: ReturnType<typeof Bun.serve>
let url: string

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      await req.text()
      return new Response(reply.body, { status: reply.status })
    },
  })
  url = `http://127.0.0.1:${server.port}`
})
afterAll(async () => {
  await server.stop(true)
})

/** A sink wired to the real transport, collecting what it warns. */
function sinkAgainst(warnings: string[]): OtelSink {
  return new OtelSink({
    tracesUrl: `${url}/v1/traces`,
    metricsUrl: `${url}/v1/metrics`,
    logsUrl: `${url}/v1/logs`,
    serviceName: 'vx',
    headers: {},
    metricsEnabled: false,
    logsEnabled: false,
    timeoutMs: 2_000,
    warn: (m) => warnings.push(m),
  })
}

function driveOneTask(sink: OtelSink): void {
  sink.onRecord({
    v: 1,
    kind: 'run.start',
    run: RUN,
    total: 1,
    ts: 1000,
    startedAt: 1000,
  } as unknown as TelemetryRecord)
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
  sink.onRecord({
    v: 1,
    kind: 'task.end',
    runId: 'run-1',
    ts: 1050,
    ...t,
  } as unknown as TelemetryRecord)
  sink.onRecord({ v: 1, kind: 'run.end', runId: 'run-1', ts: 1100 } as unknown as TelemetryRecord)
}

async function exportWith(r: Reply): Promise<string[]> {
  reply = r
  const warnings: string[] = []
  const sink = sinkAgainst(warnings)
  driveOneTask(sink)
  await sink.flush()
  return warnings
}

describe('the OTLP transport reports a collector that refuses the export', () => {
  it('CONTROL: a collector that accepts it says nothing', async () => {
    expect(await exportWith({ status: 200, body: '{}' })).toEqual([])
  })

  it('a 401 names the status and the collector’s own explanation', async () => {
    const warnings = await exportWith({
      status: 401,
      body: JSON.stringify({ message: 'invalid token' }),
    })
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('/v1/traces')
    expect(warnings[0]).toContain('HTTP 401')
    expect(warnings[0]).toContain('invalid token')
  })

  it('a 500 with no body still names the status', async () => {
    const warnings = await exportWith({ status: 500, body: '' })
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('HTTP 500')
  })

  it('a 200 that is not JSON is a success — the body is the collector’s business', async () => {
    expect(await exportWith({ status: 200, body: '<html>hello</html>' })).toEqual([])
  })

  it('a partialSuccess that dropped records is reported with the count', async () => {
    const warnings = await exportWith({
      status: 200,
      body: JSON.stringify({
        partialSuccess: { rejectedSpans: '2', errorMessage: 'quota exceeded' },
      }),
    })
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('dropped part of the export: 2 spans')
    expect(warnings[0]).toContain('quota exceeded')
  })

  it('CONTROL: a partialSuccess with nothing rejected is the spec’s plain success', async () => {
    // The OTLP spec's own example of a full success carries the field with
    // zeroes, so treating its PRESENCE as a failure would warn on every
    // export against such a collector.
    expect(
      await exportWith({
        status: 200,
        body: JSON.stringify({ partialSuccess: { rejectedSpans: '0', errorMessage: '' } }),
      }),
    ).toEqual([])
  })

  it('an error body rides the message bounded and on one line', async () => {
    const warnings = await exportWith({ status: 413, body: `${'x'.repeat(500)}\n\nsecond line` })
    expect(warnings.length).toBe(1)
    expect(warnings[0]!.includes('\n')).toBe(false)
    expect(warnings[0]!.length).toBeLessThan(320)
  })
})
