// Native OTel CI/CD-conventions emit. Lives in core (vs. the deleted
// @vzn/vx-otel-bridge package): when OTEL_EXPORTER_OTLP_ENDPOINT is set
// and the @opentelemetry/* optional peer deps are installed, every
// run subscribes a log-record emitter to the bus and pushes through
// the OTLP/HTTP exporter.
//
// Optional deps via dynamic specifier import — the OTel SDK pulls
// ~30 packages of closure; core stays at ~20 unless users opt in.

import type { EventBus, WireEvent } from './events.js'

const SEMCONV = {
  pipelineRunId: 'cicd.pipeline.run.id',
  taskName: 'cicd.pipeline.task.name',
  taskRunResult: 'cicd.pipeline.task.run.result',
  workerId: 'cicd.worker.id',
} as const

interface SeverityNumberLike {
  INFO: number
  WARN: number
  ERROR: number
}

interface LoggerLike {
  emit(record: {
    timestamp: number
    severityNumber: number
    severityText?: string
    body: string
    attributes: Record<string, unknown>
  }): void
}

let runCounter = 0

/**
 * Attach a native OTel exporter to a vx bus. Returns a detach function.
 * Returns null silently if either the env var is missing or the optional
 * peer deps aren't installed — never blocks a run.
 */
export async function attachOtelEmit(bus: EventBus): Promise<(() => void) | null> {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  if (!endpoint) return null
  const serviceName = process.env.OTEL_SERVICE_NAME ?? 'vx'

  let SeverityNumber: SeverityNumberLike
  let exporter: { shutdown(): Promise<void> }
  let processor: { shutdown(): Promise<void> }
  let logger: LoggerLike
  try {
    // Dynamic specifiers so TS doesn't try to resolve the optional peers
    // at type-check time. Users `bun add @opentelemetry/api-logs
    // @opentelemetry/sdk-logs @opentelemetry/exporter-logs-otlp-http`
    // to opt in.
    const apiLogs = (await import('@opentelemetry/api-logs' as string)) as {
      SeverityNumber: SeverityNumberLike
    }
    const otlpHttp = (await import('@opentelemetry/exporter-logs-otlp-http' as string)) as {
      OTLPLogExporter: new (opts: { url: string }) => { shutdown(): Promise<void> }
    }
    const sdkLogs = (await import('@opentelemetry/sdk-logs' as string)) as {
      LoggerProvider: new () => {
        addLogRecordProcessor(p: unknown): void
        getLogger(name: string): LoggerLike
      }
      BatchLogRecordProcessor: new (e: unknown) => { shutdown(): Promise<void> }
    }
    SeverityNumber = apiLogs.SeverityNumber
    exporter = new otlpHttp.OTLPLogExporter({ url: endpoint })
    processor = new sdkLogs.BatchLogRecordProcessor(exporter)
    const provider = new sdkLogs.LoggerProvider()
    provider.addLogRecordProcessor(processor)
    logger = provider.getLogger(serviceName)
  } catch {
    // Optional peers not installed — silently skip. The env var is the
    // user opt-in; the deps are the technical opt-in.
    return null
  }

  const runId = `run-${++runCounter}-${Date.now()}`
  let endForwarded = false

  const dispose = bus.subscribe((event) => {
    // Project the in-process RunEvent to a WireEvent shape. The bus
    // delivers live nodes; we read only the fields the OTel mapping
    // needs (id, taskName, exec etc.), no graph traversal.
    const wire = projectToWireLite(event)
    if (wire === null) return
    if (wire.kind === 'run:end') {
      if (endForwarded) return
      endForwarded = true
    }
    try {
      logger.emit(mapToLogRecord(wire, { runId, severityNumber: SeverityNumber }))
    } catch {
      // exporter failure must never break the run; degrade silently
    }
  })

  return async () => {
    dispose()
    try {
      await processor.shutdown()
      await exporter.shutdown()
    } catch {
      // best effort
    }
  }
}

interface LiveRunEvent {
  kind: WireEvent['kind']
  info?: { total: number; concurrency?: number; requestedCount?: number }
  node?: {
    id: string
    projectName: string
    taskName: string
    requested: boolean
    surfaced?: boolean
    config: { exec?: { command?: string; persistent?: unknown } }
  }
  chunk?: string
  outcome?: {
    node?: { id: string; projectName: string; taskName: string }
    status: string
    exitCode: number
    durationMs: number
    hash?: string
    cpuMs?: number
    peakRssBytes?: number
    restored?: boolean
    wallclockStartNs?: bigint
    wallclockEndNs?: bigint
  }
  line?: string
}

interface LiteWire {
  kind: WireEvent['kind']
  info?: { total: number; concurrency?: number; requestedCount?: number }
  taskId?: string
  command?: string
  chunk?: string
  line?: string
  outcome?: {
    taskId: string
    status: string
    exitCode: number
    durationMs: number
    hash?: string
    cpuMs?: number
    peakRssBytes?: number
    restored?: boolean
    wallclockStartNs?: string
    wallclockEndNs?: string
  }
}

function projectToWireLite(event: unknown): LiteWire | null {
  const e = event as LiveRunEvent
  switch (e.kind) {
    case 'run:start':
      return { kind: 'run:start', info: e.info ?? { total: 0 } }
    case 'task:start': {
      if (!e.node || e.node.config.exec === undefined) return null
      const lite: LiteWire = { kind: 'task:start', taskId: e.node.id }
      if (e.node.config.exec.command !== undefined) lite.command = e.node.config.exec.command
      return lite
    }
    case 'task:stdout':
      if (!e.node) return null
      return { kind: 'task:stdout', taskId: e.node.id, chunk: e.chunk ?? '' }
    case 'task:stderr':
      if (!e.node) return null
      return { kind: 'task:stderr', taskId: e.node.id, chunk: e.chunk ?? '' }
    case 'task:complete': {
      if (!e.node || !e.outcome || e.node.config.exec === undefined) return null
      const o = e.outcome
      const outcome: NonNullable<LiteWire['outcome']> = {
        taskId: e.node.id,
        status: o.status,
        exitCode: o.exitCode,
        durationMs: o.durationMs,
      }
      if (o.hash !== undefined) outcome.hash = o.hash
      if (o.cpuMs !== undefined) outcome.cpuMs = o.cpuMs
      if (o.peakRssBytes !== undefined) outcome.peakRssBytes = o.peakRssBytes
      if (o.restored !== undefined) outcome.restored = o.restored
      if (o.wallclockStartNs !== undefined) outcome.wallclockStartNs = o.wallclockStartNs.toString()
      if (o.wallclockEndNs !== undefined) outcome.wallclockEndNs = o.wallclockEndNs.toString()
      return { kind: 'task:complete', outcome }
    }
    case 'run:status':
      return { kind: 'run:status', line: e.line ?? '' }
    case 'run:end':
      return { kind: 'run:end' }
  }
  return null
}

/** Translate a projected wire event to an OTel LogRecord. */
export function mapToLogRecord(
  event: LiteWire,
  ctx: { runId: string; severityNumber: SeverityNumberLike },
): {
  timestamp: number
  severityNumber: number
  severityText: string
  body: string
  attributes: Record<string, unknown>
} {
  const base = {
    timestamp: Date.now(),
    severityNumber: ctx.severityNumber.INFO,
    severityText: 'info',
    body: event.kind as string,
    attributes: {
      'vx.kind': event.kind,
      [SEMCONV.pipelineRunId]: ctx.runId,
    } as Record<string, unknown>,
  }

  switch (event.kind) {
    case 'run:start': {
      const info = event.info!
      base.attributes['vx.run.total'] = info.total
      if (info.concurrency !== undefined) base.attributes[SEMCONV.workerId] = info.concurrency
      if (info.requestedCount !== undefined)
        base.attributes['vx.run.requested_count'] = info.requestedCount
      base.body = `vx run start (${info.total} tasks)`
      return base
    }
    case 'task:start':
      if (event.taskId !== undefined) {
        base.attributes[SEMCONV.taskName] = event.taskId
        base.attributes['vx.task.id'] = event.taskId
      }
      if (event.command !== undefined) base.attributes['vx.task.command'] = event.command
      base.body = `task start: ${event.taskId ?? ''}`
      return base
    case 'task:stdout':
    case 'task:stderr':
      base.attributes['vx.task.id'] = event.taskId
      base.body = event.chunk ?? ''
      if (event.kind === 'task:stderr') {
        base.severityNumber = ctx.severityNumber.WARN
        base.severityText = 'warn'
      }
      return base
    case 'task:complete': {
      const o = event.outcome!
      base.attributes[SEMCONV.taskName] = o.taskId
      base.attributes['vx.task.id'] = o.taskId
      base.attributes[SEMCONV.taskRunResult] = o.status
      base.attributes['vx.outcome.status'] = o.status
      base.attributes['vx.outcome.exit_code'] = o.exitCode
      base.attributes['vx.outcome.duration_ms'] = o.durationMs
      if (o.hash !== undefined) base.attributes['vx.outcome.hash'] = o.hash
      if (o.cpuMs !== undefined) base.attributes['vx.outcome.cpu_ms'] = o.cpuMs
      if (o.peakRssBytes !== undefined)
        base.attributes['vx.outcome.peak_rss_bytes'] = o.peakRssBytes
      if (o.restored !== undefined) base.attributes['vx.outcome.restored'] = o.restored
      if (o.wallclockStartNs !== undefined)
        base.attributes['vx.outcome.wallclock_start_ns'] = o.wallclockStartNs
      if (o.wallclockEndNs !== undefined)
        base.attributes['vx.outcome.wallclock_end_ns'] = o.wallclockEndNs
      if (o.status === 'failed') {
        base.severityNumber = ctx.severityNumber.ERROR
        base.severityText = 'error'
      }
      base.body = `task complete: ${o.taskId} (${o.status})`
      return base
    }
    case 'run:status':
      base.body = event.line ?? ''
      return base
    case 'run:end':
      base.body = 'run end'
      return base
  }
}
