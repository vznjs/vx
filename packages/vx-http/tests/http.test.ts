// @vzn/vx-http — the manual-API exporter. Tests config resolution and the
// sink's two modes (summary / stream), format, auth, never-fail, idempotency —
// all via an injected POST transport.

import { describe, expect, it } from 'bun:test'
import type { RunContextRecord, RunSummaryRecord, TelemetryRecord } from '@vzn/vx'
import { httpTelemetry, resolveHttpConfig } from '../src/plugin.js'
import { HttpSink, type HttpSinkConfig } from '../src/sink.js'

const RUN: RunContextRecord = {
  runId: 'run-1',
  vxVersion: '1.0.0',
  command: 'vx run build',
  requestedTasks: ['build'],
  cachePolicy: 'lR,lW,rR,rW',
  concurrency: 4,
  flow: 'focused',
  commitSha: 'abc',
  branch: 'main',
  dirty: false,
  ci: false,
  ciProvider: null,
  host: 'h',
  os: 'linux',
  arch: 'x64',
  tags: {},
}

const SUMMARY: RunSummaryRecord = {
  v: 1,
  run: RUN,
  startedAt: 0,
  endedAt: 100,
  totalDurationMs: 100,
  taskCount: 1,
  failedCount: 0,
  hitCount: 0,
  hitLocalCount: 0,
  hitRemoteCount: 0,
  exitOk: true,
  tasks: [
    {
      taskId: 'a#build',
      project: 'a',
      task: 'build',
      status: 'success',
      cacheSource: 'miss',
      exitCode: 0,
      durationMs: 40,
    },
  ],
}

function mkSink(over: Partial<HttpSinkConfig> = {}) {
  const calls: { url: string; body: string; headers: Record<string, string> }[] = []
  const post = async (url: string, body: string, headers: Record<string, string>) => {
    calls.push({ url, body, headers })
  }
  const cfg: HttpSinkConfig = {
    url: 'http://collector/ingest',
    format: 'ndjson',
    mode: 'summary',
    batchSize: 100,
    timeoutMs: 1000,
    includeLogs: false,
    post,
    ...over,
  }
  return { sink: new HttpSink(cfg), calls }
}

function streamRecords(): TelemetryRecord[] {
  return [
    { v: 1, kind: 'run.start', run: RUN, total: 1, ts: 1 },
    {
      v: 1,
      kind: 'task.start',
      runId: 'run-1',
      taskId: 'a#build',
      project: 'a',
      task: 'build',
      ts: 2,
    },
    {
      v: 1,
      kind: 'task.end',
      runId: 'run-1',
      ts: 3,
      taskId: 'a#build',
      project: 'a',
      task: 'build',
      status: 'success',
      cacheSource: 'miss',
      exitCode: 0,
      durationMs: 1,
    },
    { v: 1, kind: 'run.end', runId: 'run-1', ts: 4 },
  ]
}

describe('resolveHttpConfig', () => {
  it('declines when no URL is set', () => {
    expect(resolveHttpConfig({}, {})).toBeUndefined()
  })
  it('reads VX_TELEMETRY_URL + VX_TELEMETRY_TOKEN with summary/ndjson defaults', () => {
    const c = resolveHttpConfig(
      {},
      { VX_TELEMETRY_URL: 'http://x/ingest', VX_TELEMETRY_TOKEN: 'tok' },
    )!
    expect(c.url).toBe('http://x/ingest')
    expect(c.token).toBe('tok')
    expect(c.mode).toBe('summary')
    expect(c.format).toBe('ndjson')
  })
  it('options override env', () => {
    const c = resolveHttpConfig(
      { url: 'http://opt', mode: 'stream', format: 'json', batchSize: 5 },
      { VX_TELEMETRY_URL: 'http://env' },
    )!
    expect(c.url).toBe('http://opt')
    expect(c.mode).toBe('stream')
    expect(c.format).toBe('json')
    expect(c.batchSize).toBe(5)
  })
})

describe('HttpSink — summary mode', () => {
  it('receives no streaming records (wants is empty)', () => {
    const { sink } = mkSink()
    expect(sink.wants).toEqual([])
  })

  it('POSTs one RunSummaryRecord body at flush', async () => {
    const { sink, calls } = mkSink({ token: 'secret' })
    sink.onRunSummary(SUMMARY)
    await sink.flush()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('http://collector/ingest')
    expect(calls[0]!.headers['authorization']).toBe('Bearer secret')
    const parsed = JSON.parse(calls[0]!.body) as RunSummaryRecord
    expect(parsed.run.runId).toBe('run-1')
    expect(parsed.tasks[0]!.task).toBe('build')
  })

  it('posts nothing if no summary arrived', async () => {
    const { sink, calls } = mkSink()
    await sink.flush()
    expect(calls).toHaveLength(0)
  })

  it('flush is idempotent', async () => {
    const { sink, calls } = mkSink()
    sink.onRunSummary(SUMMARY)
    await sink.flush()
    await sink.flush()
    expect(calls).toHaveLength(1)
  })
})

describe('HttpSink — stream mode', () => {
  it('wants all kinds except task.log by default', () => {
    const { sink } = mkSink({ mode: 'stream' })
    expect(sink.wants).toContain('task.end')
    expect(sink.wants).not.toContain('task.log')
  })

  it('wants task.log when includeLogs is set', () => {
    const { sink } = mkSink({ mode: 'stream', includeLogs: true })
    expect(sink.wants).toContain('task.log')
  })

  it('batches records as NDJSON, flushing the tail at run:end', async () => {
    const { sink, calls } = mkSink({ mode: 'stream' })
    for (const r of streamRecords()) sink.onRecord(r)
    await sink.flush()
    expect(calls).toHaveLength(1)
    const lines = calls[0]!.body.split('\n')
    expect(lines).toHaveLength(4)
    expect(calls[0]!.headers['content-type']).toBe('application/x-ndjson')
    expect((JSON.parse(lines[0]!) as TelemetryRecord).kind).toBe('run.start')
  })

  it('fires a batch POST when batchSize is reached, plus the tail at flush', async () => {
    const { sink, calls } = mkSink({ mode: 'stream', batchSize: 2 })
    const recs = streamRecords()
    sink.onRecord(recs[0]!)
    sink.onRecord(recs[1]!) // hits batchSize=2 → one POST
    sink.onRecord(recs[2]!)
    await sink.flush() // tail → second POST
    expect(calls).toHaveLength(2)
    expect(calls[0]!.body.split('\n')).toHaveLength(2)
    expect(calls[1]!.body.split('\n')).toHaveLength(1)
  })

  it('format json wraps a batch in a JSON array', async () => {
    const { sink, calls } = mkSink({ mode: 'stream', format: 'json' })
    for (const r of streamRecords()) sink.onRecord(r)
    await sink.flush()
    const arr = JSON.parse(calls[0]!.body) as TelemetryRecord[]
    expect(Array.isArray(arr)).toBe(true)
    expect(arr).toHaveLength(4)
    expect(calls[0]!.headers['content-type']).toBe('application/json')
  })
})

describe('HttpSink — never-fail', () => {
  it('a throwing transport does not reject flush', async () => {
    const warnings: string[] = []
    const sink = new HttpSink({
      url: 'http://x',
      format: 'ndjson',
      mode: 'summary',
      batchSize: 100,
      timeoutMs: 100,
      includeLogs: false,
      post: async () => {
        throw new Error('endpoint down')
      },
      warn: (m) => warnings.push(m),
    })
    sink.onRunSummary(SUMMARY)
    await expect(sink.flush()).resolves.toBeUndefined()
    expect(warnings.some((w) => w.includes('export failed'))).toBe(true)
  })
})

describe('httpTelemetry() plugin', () => {
  it('declines when no URL', () => {
    const prev = process.env['VX_TELEMETRY_URL']
    delete process.env['VX_TELEMETRY_URL']
    try {
      const sink = httpTelemetry().telemetry!({
        workspaceRoot: '/ws',
        cacheDir: '/c',
        warn: () => undefined,
      })
      expect(sink).toBeUndefined()
    } finally {
      if (prev !== undefined) process.env['VX_TELEMETRY_URL'] = prev
    }
  })

  it('returns a sink when a URL is configured', () => {
    const sink = httpTelemetry({ url: 'http://x/ingest' }).telemetry!({
      workspaceRoot: '/ws',
      cacheDir: '/c',
      warn: () => undefined,
    })
    expect(sink).toBeDefined()
  })
})
