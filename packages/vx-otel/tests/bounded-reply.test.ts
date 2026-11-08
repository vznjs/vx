// A collector's reply was read whole: a 200 whose body never ended grew vx
// to 2.1 GB RSS within the flush deadline, then warned the records lost
// though the export had landed. The reply is read only as far as vx needs.
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
  cachePolicy: 'local:rw,remote:',
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
}

let srv: ReturnType<typeof Bun.serve>
let sent = 0

beforeAll(() => {
  srv = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      await req.arrayBuffer()
      return new Response(
        new ReadableStream({
          pull(c) {
            sent += 1 << 20
            c.enqueue(new Uint8Array(1 << 20).fill(97))
          },
        }),
      )
    },
  })
})
afterAll(() => srv.stop(true))

it("a collector's endless reply is read no further than vx needs, and the export counts", async () => {
  const warnings: string[] = []
  const sink = new OtelSink({
    tracesUrl: `http://127.0.0.1:${srv.port}/v1/traces`,
    metricsUrl: '',
    logsUrl: '',
    serviceName: 'vx',
    headers: {},
    metricsEnabled: false,
    logsEnabled: false,
    timeoutMs: 3_000,
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
  expect(warnings).toEqual([])
  expect(sent).toBeLessThan(64 << 20)
})
