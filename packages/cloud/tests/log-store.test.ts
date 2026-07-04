// The per-workspace task-log store: idempotent ingest, server-side
// re-truncation (the wire is never trusted), zstd round-trip, hash
// resolution, and the schema gate.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { LogStore } from '../src/log-store.js'
import {
  LOG_WIRE_VERSION,
  TASK_LOG_TAIL_CHARS,
  type TaskLogBundle,
} from '../src/task-log-capture.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'vx-logstore-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function bundle(tasks: TaskLogBundle['tasks'], runId = 'run-1'): TaskLogBundle {
  return { v: LOG_WIRE_VERSION, runId, workspaceId: 'ws', tasks }
}

function task(over: Partial<TaskLogBundle['tasks'][number]> = {}): TaskLogBundle['tasks'][number] {
  return {
    taskId: 'p#build',
    status: 'success',
    content: 'built ok\n',
    charsFull: 9,
    truncatedHeadChars: 0,
    ...over,
  }
}

describe('LogStore', () => {
  it('stores and reads back a task log', () => {
    const s = new LogStore(dir)
    expect(s.ingestLogs(bundle([task({ hash: 'h1' })]))).toBe(1)
    const got = s.logFor('run-1', 'p#build')!
    expect(got.content).toBe('built ok\n')
    expect(got.status).toBe('success')
    expect(got.hash).toBe('h1')
    s.close()
  })

  it('is idempotent — a re-delivered bundle stores nothing new', () => {
    const s = new LogStore(dir)
    expect(s.ingestLogs(bundle([task()]))).toBe(1)
    expect(s.ingestLogs(bundle([task()]))).toBe(0)
    s.close()
  })

  it('re-truncates server-side even if the wire claims a smaller drop', () => {
    const s = new LogStore(dir)
    // A hostile body over the per-task cap with a lying truncatedHeadChars: 0.
    const content = 'H'.repeat(TASK_LOG_TAIL_CHARS + 5000) + 'TAILEND'
    s.ingestLogs(bundle([task({ content, charsFull: content.length, truncatedHeadChars: 0 })]))
    const got = s.logFor('run-1', 'p#build')!
    expect(got.content.length).toBeLessThanOrEqual(TASK_LOG_TAIL_CHARS)
    expect(got.content.endsWith('TAILEND')).toBe(true)
    expect(got.truncatedHeadChars).toBeGreaterThan(0) // recomputed, not trusted
    s.close()
  })

  it('round-trips a large (zstd-compressed) body', () => {
    const s = new LogStore(dir)
    const content = 'line of build output\n'.repeat(3000) // well over the 4 KiB threshold
    s.ingestLogs(bundle([task({ content, charsFull: content.length })]))
    expect(s.logFor('run-1', 'p#build')!.content).toBe(content)
    s.close()
  })

  it('resolves the latest log for a cache key (hit → executed run)', () => {
    const s = new LogStore(dir)
    s.ingestLogs(bundle([task({ hash: 'shared', content: 'first\n' })], 'run-1'))
    s.ingestLogs(bundle([task({ hash: 'shared', content: 'second\n' })], 'run-2'))
    // latestByHash returns the most recently stored producing run.
    expect(s.latestByHash('shared')!.content).toBe('second\n')
    expect(s.latestByHash('shared')!.runId).toBe('run-2')
    s.close()
  })

  it('reopens across a restart (WAL persisted)', () => {
    const s = new LogStore(dir)
    s.ingestLogs(bundle([task({ content: 'persisted\n' })]))
    s.close()
    const s2 = new LogStore(dir)
    expect(s2.logFor('run-1', 'p#build')!.content).toBe('persisted\n')
    s2.close()
  })

  it('drops the table and re-creates on a schema-version mismatch (loud)', () => {
    const s = new LogStore(dir)
    s.ingestLogs(bundle([task()]))
    s.close()
    // Simulate an older/newer schema by rewriting the meta version.
    const { Database } = require('bun:sqlite') as typeof import('bun:sqlite')
    const raw = new Database(path.join(dir, 'logs.db'))
    raw.prepare('UPDATE logs_meta SET value = 99 WHERE key = ?').run('schema')
    raw.close()
    const warnings: string[] = []
    const s2 = new LogStore(dir, undefined, (m) => warnings.push(m))
    expect(warnings.some((w) => w.includes('schema'))).toBe(true)
    expect(s2.logFor('run-1', 'p#build')).toBeUndefined() // wiped
    s2.close()
  })
})
