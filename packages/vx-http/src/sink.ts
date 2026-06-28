// The HTTP telemetry sink — ships canonical vx records to any endpoint.
//
// Two modes:
//   summary — POST one RunSummaryRecord (the whole run in one body) at
//             run:end. The smallest contract: one request per run. Default.
//   stream  — batch TelemetryRecords and POST them (NDJSON or JSON), flushing
//             on batchSize and at run:end. For per-task / live granularity.
//
// Observe-only (implements core's TelemetrySink) and never-fail: every POST is
// time-bounded, errors are swallowed (a down endpoint can't affect a run), and
// the flush is idempotent.

import type { RunSummaryRecord, TelemetryRecord, TelemetrySink } from '@vzn/vx'

export type PostFn = (url: string, body: string, headers: Record<string, string>) => Promise<void>

export type TelemetryFormat = 'ndjson' | 'json'
export type TelemetryMode = 'summary' | 'stream'

export interface HttpSinkConfig {
  url: string
  token?: string
  format: TelemetryFormat
  mode: TelemetryMode
  batchSize: number
  timeoutMs: number
  includeLogs: boolean
  post?: PostFn
  warn?: (message: string) => void
}

function makeDefaultPost(timeoutMs: number): PostFn {
  return async (url, body, headers) => {
    await fetch(url, { method: 'POST', body, headers, signal: AbortSignal.timeout(timeoutMs) })
  }
}

const ALL_STREAM_KINDS: ReadonlyArray<TelemetryRecord['kind']> = [
  'run.start',
  'task.start',
  'task.end',
  'task.log',
  'run.end',
]
const STREAM_KINDS_NO_LOG: ReadonlyArray<TelemetryRecord['kind']> = [
  'run.start',
  'task.start',
  'task.end',
  'run.end',
]

export class HttpSink implements TelemetrySink {
  readonly name = 'vzn/http'
  readonly wants: ReadonlyArray<TelemetryRecord['kind']>

  private readonly cfg: HttpSinkConfig
  private readonly post: PostFn
  private readonly buffer: TelemetryRecord[] = []
  private summary: RunSummaryRecord | undefined
  private readonly inflight: Promise<void>[] = []
  private flushed = false

  constructor(config: HttpSinkConfig) {
    this.cfg = config
    this.post = config.post ?? makeDefaultPost(config.timeoutMs)
    // summary mode receives no streaming records; stream mode receives all
    // (optionally including the large task.log chunks).
    this.wants =
      config.mode === 'summary' ? [] : config.includeLogs ? ALL_STREAM_KINDS : STREAM_KINDS_NO_LOG
  }

  onRecord(record: TelemetryRecord): void {
    if (this.cfg.mode !== 'stream') return
    this.buffer.push(record)
    if (this.buffer.length >= this.cfg.batchSize) {
      // Kick a batch POST without blocking the event path; flush awaits it.
      this.inflight.push(this.shipRecords(this.buffer.splice(0, this.buffer.length)))
    }
  }

  onRunSummary(summary: RunSummaryRecord): void {
    if (this.cfg.mode === 'summary') this.summary = summary
  }

  async flush(): Promise<void> {
    if (this.flushed) return
    this.flushed = true
    if (this.cfg.mode === 'summary') {
      if (this.summary !== undefined) await this.shipSummary(this.summary)
      return
    }
    // stream: ship the tail, then await every in-flight batch.
    if (this.buffer.length > 0) {
      this.inflight.push(this.shipRecords(this.buffer.splice(0, this.buffer.length)))
    }
    await Promise.all(this.inflight)
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'content-type': this.cfg.format === 'ndjson' ? 'application/x-ndjson' : 'application/json',
    }
    if (this.cfg.token) h['authorization'] = `Bearer ${this.cfg.token}`
    return h
  }

  private async shipSummary(summary: RunSummaryRecord): Promise<void> {
    // A single summary is one object either way; ndjson = one line.
    await this.send(JSON.stringify(summary))
  }

  private async shipRecords(records: TelemetryRecord[]): Promise<void> {
    if (records.length === 0) return
    const body =
      this.cfg.format === 'ndjson'
        ? records.map((r) => JSON.stringify(r)).join('\n')
        : JSON.stringify(records)
    await this.send(body)
  }

  private async send(body: string): Promise<void> {
    try {
      await this.post(this.cfg.url, body, this.headers())
    } catch (err) {
      // export is fully optional — a down endpoint never affects a run
      this.cfg.warn?.(
        `[vx-http] export failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
}
