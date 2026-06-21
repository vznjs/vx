import { describe, it, expect } from 'bun:test'
import { SeverityNumber } from '@opentelemetry/api-logs'

import { mapToLogRecord } from '../src/index.ts'
import type { WireEvent } from '../src/types.ts'

const ctx = { runId: 'run-test-1' }

const attrs = (record: ReturnType<typeof mapToLogRecord>) =>
  (record.attributes ?? {}) as Record<string, unknown>

describe('mapToLogRecord', () => {
  it('emits run:start with run id under the CI/CD semconv key', () => {
    const event: WireEvent = {
      kind: 'run:start',
      info: { total: 3, concurrency: 4, requestedCount: 1 },
    }
    const record = mapToLogRecord(event, ctx)
    const a = attrs(record)
    expect(record.severityNumber).toBe(SeverityNumber.INFO)
    expect(a['vx.kind']).toBe('run:start')
    expect(a['cicd.pipeline.run.id']).toBe('run-test-1')
    expect(a['cicd.worker.id']).toBe(4)
    expect(a['vx.run.total']).toBe(3)
    expect(a['vx.run.requested_count']).toBe(1)
  })

  it('emits task:start with semconv pipeline.task.name', () => {
    const event: WireEvent = {
      kind: 'task:start',
      task: {
        id: 'pkg-a#build',
        project: 'pkg-a',
        task: 'build',
        isGroup: false,
        requested: true,
        surfaced: false,
        persistent: false,
        command: 'tsc -b',
      },
    }
    const record = mapToLogRecord(event, ctx)
    const a = attrs(record)
    expect(a['cicd.pipeline.task.name']).toBe('build')
    expect(a['vx.task.id']).toBe('pkg-a#build')
    expect(a['vx.task.project']).toBe('pkg-a')
    expect(a['vx.task.command']).toBe('tsc -b')
    expect(a['vx.task.requested']).toBe(true)
    expect(record.body).toBe('task start: pkg-a#build')
  })

  it('emits task:complete success → INFO + run.result attribute', () => {
    const event: WireEvent = {
      kind: 'task:complete',
      outcome: {
        taskId: 'pkg-a#build',
        status: 'success',
        exitCode: 0,
        durationMs: 1234,
        hash: 'deadbeef',
        cpuMs: 800,
      },
    }
    const record = mapToLogRecord(event, ctx)
    const a = attrs(record)
    expect(record.severityNumber).toBe(SeverityNumber.INFO)
    expect(a['cicd.pipeline.task.run.result']).toBe('success')
    expect(a['vx.outcome.status']).toBe('success')
    expect(a['vx.outcome.exit_code']).toBe(0)
    expect(a['vx.outcome.duration_ms']).toBe(1234)
    expect(a['vx.outcome.hash']).toBe('deadbeef')
    expect(a['vx.outcome.cpu_ms']).toBe(800)
    expect(a['vx.task.id']).toBe('pkg-a#build')
  })

  it('emits task:complete failed → ERROR severity', () => {
    const event: WireEvent = {
      kind: 'task:complete',
      outcome: {
        taskId: 'pkg-a#build',
        status: 'failed',
        exitCode: 1,
        durationMs: 50,
      },
    }
    const record = mapToLogRecord(event, ctx)
    const a = attrs(record)
    expect(record.severityNumber).toBe(SeverityNumber.ERROR)
    expect(record.severityText).toBe('error')
    expect(a['cicd.pipeline.task.run.result']).toBe('failed')
  })

  it('emits task:stdout with chunk as body', () => {
    const event: WireEvent = {
      kind: 'task:stdout',
      taskId: 'pkg-a#build',
      chunk: 'hello world',
    }
    const record = mapToLogRecord(event, ctx)
    const a = attrs(record)
    expect(record.body).toBe('hello world')
    expect(record.severityNumber).toBe(SeverityNumber.INFO)
    expect(a['vx.task.id']).toBe('pkg-a#build')
    expect(a['vx.kind']).toBe('task:stdout')
  })

  it('emits task:stderr with WARN severity', () => {
    const event: WireEvent = {
      kind: 'task:stderr',
      taskId: 'pkg-a#build',
      chunk: 'something noisy',
    }
    const record = mapToLogRecord(event, ctx)
    expect(record.severityNumber).toBe(SeverityNumber.WARN)
    expect(record.body).toBe('something noisy')
  })

  it('emits run:end as a body marker', () => {
    const event: WireEvent = { kind: 'run:end' }
    const record = mapToLogRecord(event, ctx)
    expect(record.body).toBe('run end')
    expect((attrs(record))['vx.kind']).toBe('run:end')
    expect((attrs(record))['cicd.pipeline.run.id']).toBe('run-test-1')
  })

  it('attaches a fallback run id when no ctx passed', () => {
    const event: WireEvent = { kind: 'run:end' }
    const record = mapToLogRecord(event)
    expect((attrs(record))['cicd.pipeline.run.id']).toBe('unknown')
  })
})
