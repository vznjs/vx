// @vzn/vx-otel-bridge — a thin, one-direction adapter. Subscribes to a vx
// event bus, translates each WireEvent to an OTel LogRecord per the CI/CD
// semantic conventions, and pushes through an OTLP/HTTP exporter. The vx
// core stays free of OTel runtime deps; users wire this bridge themselves.

import { SeverityNumber } from '@opentelemetry/api-logs'
import type { LogRecord } from '@opentelemetry/api-logs'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http'
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs'

import type { EventBus, OtelBridge, OtelBridgeOptions, WireEvent } from './types.js'

export type { EventBus, OtelBridge, OtelBridgeOptions, WireEvent }

const SEMCONV = {
  pipelineRunId: 'cicd.pipeline.run.id',
  taskName: 'cicd.pipeline.task.name',
  taskRunResult: 'cicd.pipeline.task.run.result',
  workerId: 'cicd.worker.id',
} as const

// The bus does not carry a runId; we derive one at attach time. A run begins
// at the first event after attach, ends at run:end. Multiple runs through
// the same bus would each get their own id via a stable counter — but vx
// today emits one run per bus, so this is a simple monotonically-incrementing
// id baked into a closure.
let runCounter = 0

export function mapToLogRecord(event: WireEvent, ctx?: { runId?: string }): LogRecord {
  const timeUnixNano = String(Date.now()) + '000000'
  const traceId = ctx?.runId ?? 'unknown'
  const base: LogRecord = {
    timestamp: Date.now(),
    severityNumber: SeverityNumber.INFO,
    severityText: 'info',
    body: event.kind,
    attributes: {
      'vx.kind': event.kind,
      'vx.time_unix_nano': timeUnixNano,
      [SEMCONV.pipelineRunId]: traceId,
    },
  }
  const attrs = base.attributes as Record<string, unknown>

  switch (event.kind) {
    case 'run:start':
      attrs['vx.run.total'] = event.info.total
      if (event.info.concurrency !== undefined) attrs[SEMCONV.workerId] = event.info.concurrency
      if (event.info.requestedCount !== undefined)
        attrs['vx.run.requested_count'] = event.info.requestedCount
      return base

    case 'task:start':
      attrs['vx.task.id'] = event.task.id
      attrs[SEMCONV.taskName] = event.task.task
      attrs['vx.task.project'] = event.task.project
      attrs['vx.task.requested'] = event.task.requested
      attrs['vx.task.is_group'] = event.task.isGroup
      attrs['vx.task.persistent'] = event.task.persistent
      if (event.task.command !== undefined) attrs['vx.task.command'] = event.task.command
      base.body = `task start: ${event.task.id}`
      return base

    case 'task:stdout':
    case 'task:stderr':
      attrs['vx.task.id'] = event.taskId
      base.body = event.chunk
      if (event.kind === 'task:stderr') {
        base.severityNumber = SeverityNumber.WARN
        base.severityText = 'warn'
      }
      return base

    case 'task:complete': {
      const { outcome } = event
      attrs['vx.task.id'] = outcome.taskId
      attrs[SEMCONV.taskRunResult] = outcome.status
      attrs['vx.outcome.status'] = outcome.status
      attrs['vx.outcome.exit_code'] = outcome.exitCode
      attrs['vx.outcome.duration_ms'] = outcome.durationMs
      if (outcome.hash !== undefined) attrs['vx.outcome.hash'] = outcome.hash
      if (outcome.cpuMs !== undefined) attrs['vx.outcome.cpu_ms'] = outcome.cpuMs
      if (outcome.peakRssBytes !== undefined)
        attrs['vx.outcome.peak_rss_bytes'] = outcome.peakRssBytes
      if (outcome.restored !== undefined) attrs['vx.outcome.restored'] = outcome.restored
      if (outcome.wallclockStartNs !== undefined)
        attrs['vx.outcome.wallclock_start_ns'] = outcome.wallclockStartNs
      if (outcome.wallclockEndNs !== undefined)
        attrs['vx.outcome.wallclock_end_ns'] = outcome.wallclockEndNs
      if (outcome.status === 'failed') {
        base.severityNumber = SeverityNumber.ERROR
        base.severityText = 'error'
      }
      base.body = `task complete: ${outcome.taskId} (${outcome.status})`
      return base
    }

    case 'run:status':
      base.body = event.line
      return base

    case 'run:end':
      base.body = 'run end'
      return base
  }
}

// Minimal duck-typed projection of the in-process RunEvent to a WireEvent.
// Mirrors the shape of `wireForwarder` + `toWireEvent` in vx — the bridge
// reads only the fields that exist post-projection and never touches the
// live config / dep graph the RunEvent's node ref otherwise drags along.
type LiveRunEvent =
  | { kind: 'run:start'; info: WireEvent extends { kind: 'run:start'; info: infer I } ? I : never }
  | { kind: 'task:start'; node: LiveNode }
  | { kind: 'task:stdout'; node: LiveNode; chunk: string }
  | { kind: 'task:stderr'; node: LiveNode; chunk: string }
  | { kind: 'task:complete'; node: LiveNode; outcome: LiveOutcome }
  | { kind: 'run:status'; line: string }
  | { kind: 'run:end' }

type LiveNode = {
  id: string
  projectName: string
  taskName: string
  requested: boolean
  surfaced?: boolean
  config: { exec?: { command?: string; persistent?: unknown } }
}

type LiveOutcome = {
  node: LiveNode
  status: string
  exitCode: number
  durationMs: number
  hash?: string
  cpuMs?: number
  peakRssBytes?: number
  restored?: boolean
  sandboxViolations?: number
  sandboxViolationLines?: string[]
  wallclockStartNs?: bigint
  wallclockEndNs?: bigint
}

const isGroup = (node: LiveNode) => node.config.exec === undefined

function toWire(event: unknown): WireEvent | null {
  const e = event as LiveRunEvent
  switch (e.kind) {
    case 'run:start':
      return { kind: 'run:start', info: e.info }
    case 'task:start':
      if (isGroup(e.node)) return null
      return {
        kind: 'task:start',
        task: {
          id: e.node.id,
          project: e.node.projectName,
          task: e.node.taskName,
          isGroup: false,
          requested: e.node.requested,
          surfaced: e.node.surfaced === true,
          persistent: e.node.config.exec?.persistent !== undefined,
          ...(e.node.config.exec?.command !== undefined && {
            command: e.node.config.exec.command,
          }),
        },
      }
    case 'task:stdout':
      return { kind: 'task:stdout', taskId: e.node.id, chunk: e.chunk }
    case 'task:stderr':
      return { kind: 'task:stderr', taskId: e.node.id, chunk: e.chunk }
    case 'task:complete': {
      if (isGroup(e.node)) return null
      const o = e.outcome
      return {
        kind: 'task:complete',
        outcome: {
          taskId: o.node.id,
          status: o.status as never,
          exitCode: o.exitCode,
          durationMs: o.durationMs,
          ...(o.hash !== undefined && { hash: o.hash }),
          ...(o.cpuMs !== undefined && { cpuMs: o.cpuMs }),
          ...(o.peakRssBytes !== undefined && { peakRssBytes: o.peakRssBytes }),
          ...(o.restored !== undefined && { restored: o.restored }),
          ...(o.sandboxViolations !== undefined && { sandboxViolations: o.sandboxViolations }),
          ...(o.sandboxViolationLines !== undefined && {
            sandboxViolationLines: o.sandboxViolationLines,
          }),
          ...(o.wallclockStartNs !== undefined && {
            wallclockStartNs: o.wallclockStartNs.toString(),
          }),
          ...(o.wallclockEndNs !== undefined && { wallclockEndNs: o.wallclockEndNs.toString() }),
        },
      }
    }
    case 'run:status':
      return { kind: 'run:status', line: e.line }
    case 'run:end':
      return { kind: 'run:end' }
  }
}

export function createOtelBridge(options: OtelBridgeOptions = {}): OtelBridge {
  const endpoint =
    options.endpoint ?? process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? 'http://localhost:4318'
  const serviceName = options.serviceName ?? process.env['OTEL_SERVICE_NAME'] ?? 'vx'

  // Resource attributes live on the LogRecord via the LoggerProvider's
  // resource. We use the SDK default resource and rely on OTEL_RESOURCE_ATTRIBUTES
  // / OTEL_SERVICE_NAME env discovery, then layer our header config on top.
  const exporter = new OTLPLogExporter({
    url: endpoint.replace(/\/$/, '') + '/v1/logs',
    headers: options.headers,
  })
  const processor = new BatchLogRecordProcessor(exporter)
  const provider = new LoggerProvider({ processors: [processor] })
  const logger = provider.getLogger(serviceName)

  return {
    attach(bus: EventBus) {
      const runId = `run-${++runCounter}-${Date.now()}`
      const ctx = { runId }
      // Inline projection of the in-process RunEvent → WireEvent (the same
      // contract as @vzn/vx's `wireForwarder`, replicated here so the bridge
      // has zero runtime imports from vx). Drop group-task lifecycle events
      // (pure scheduling noise) and dedupe the double run:end run() emits.
      let endForwarded = false
      return bus.subscribe((event) => {
        const wire = toWire(event)
        if (wire === null) return
        if (wire.kind === 'run:end') {
          if (endForwarded) return
          endForwarded = true
        }
        logger.emit(mapToLogRecord(wire, ctx))
      })
    },
    async cleanup() {
      await provider.forceFlush()
      await provider.shutdown()
    },
  }
}
