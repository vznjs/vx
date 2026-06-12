// Dynamic bottom status line: a single \r + ESC[2K rewrite, only on
// TTY stdout outside CI. The writer is the serialization point — any
// ordinary write clears the line first, writes its content, then
// redraws — and the run-end clear is permanent.

import { describe, expect, it } from 'bun:test'
import {
  createOutputWriter,
  formatStatusLine,
  type StatusStream,
} from '../src/orchestrator/status-line.js'
import { defaultLogger } from '../src/orchestrator/logger.js'
import type { TaskNode, TaskOutcome } from '../src/graph/index.js'

const CLEAR = '\x1b[2K\r'

function tty(): StatusStream & { chunks: string[]; text(): string } {
  const chunks: string[] = []
  return {
    isTTY: true,
    chunks,
    write(c: string) {
      chunks.push(String(c))
      return true
    },
    text() {
      return chunks.join('')
    },
  }
}

function pipe(): StatusStream & { chunks: string[]; text(): string } {
  const chunks: string[] = []
  return {
    chunks,
    write(c: string) {
      chunks.push(String(c))
      return true
    },
    text() {
      return chunks.join('')
    },
  }
}

describe('createOutputWriter', () => {
  it('is inert on non-TTY streams: pure passthrough, zero escapes', () => {
    const s = pipe()
    const w = createOutputWriter(s)
    expect(w.enabled).toBe(false)
    w.setStatus('▶ 1 running', { force: true })
    w.write('hello\n')
    w.clearStatus()
    expect(s.text()).toBe('hello\n')
    expect(s.text()).not.toContain('\x1b')
  })

  it('is inert when disabled (CI), even on a TTY', () => {
    const s = tty()
    const w = createOutputWriter(s, { enabled: false })
    expect(w.enabled).toBe(false)
    w.setStatus('▶ 1 running', { force: true })
    w.write('hello\n')
    expect(s.text()).toBe('hello\n')
  })

  it('draws the status line as one clear+rewrite', () => {
    const s = tty()
    const w = createOutputWriter(s)
    w.setStatus('▶ 1 running', { force: true })
    expect(s.text()).toBe(`${CLEAR}▶ 1 running`)
  })

  it('serializes content writes: clear → content → redraw', () => {
    const s = tty()
    const w = createOutputWriter(s)
    w.setStatus('STATUS', { force: true })
    s.chunks.length = 0
    w.write('a line\n')
    expect(s.chunks).toEqual([CLEAR, 'a line\n', `${CLEAR}STATUS`])
  })

  it('throttles unforced redraws to minRedrawMs; force always draws', () => {
    let nowMs = 0
    const s = tty()
    const w = createOutputWriter(s, { minRedrawMs: 100, now: () => nowMs })
    w.setStatus('v1', { force: true })
    nowMs = 50
    w.setStatus('v2')
    expect(s.text()).toBe(`${CLEAR}v1`) // throttled
    nowMs = 150
    w.setStatus('v3')
    expect(s.text()).toBe(`${CLEAR}v1${CLEAR}v3`)
    w.setStatus('v4', { force: true })
    expect(s.text()).toBe(`${CLEAR}v1${CLEAR}v3${CLEAR}v4`)
  })

  it('clearStatus is permanent: erases the line and ignores later setStatus', () => {
    const s = tty()
    const w = createOutputWriter(s)
    w.setStatus('STATUS', { force: true })
    w.clearStatus()
    expect(s.text()).toBe(`${CLEAR}STATUS${CLEAR}`)
    s.chunks.length = 0
    w.setStatus('AGAIN', { force: true })
    expect(s.text()).toBe('')
    w.write('after\n')
    expect(s.chunks).toEqual(['after\n'])
  })

  it('holds the redraw while a streamed chunk leaves the cursor mid-line', () => {
    const s = tty()
    const w = createOutputWriter(s)
    w.setStatus('STATUS', { force: true })
    s.chunks.length = 0
    w.write('partial')
    // No redraw — rewriting the line would wipe the partial output.
    expect(s.chunks).toEqual([CLEAR, 'partial'])
    w.write(' ...done\n')
    // The newline restores column 0; the status line comes back.
    expect(s.chunks).toEqual([CLEAR, 'partial', ' ...done\n', `${CLEAR}STATUS`])
  })
})

describe('formatStatusLine', () => {
  it('renders running count, progress, ids, and elapsed seconds', () => {
    expect(
      formatStatusLine({
        running: ['one#build', 'two#build'],
        done: 5,
        total: 12,
        failed: 0,
        elapsedMs: 4321,
      }),
    ).toBe('▶ 2 running · 5/12 · one#build, two#build · 4s')
  })

  it('caps the id list at two', () => {
    const line = formatStatusLine({
      running: ['a#x', 'b#x', 'c#x'],
      done: 0,
      total: 9,
      failed: 0,
      elapsedMs: 0,
    })
    expect(line).toContain('a#x, b#x')
    expect(line).not.toContain('c#x')
  })

  it('omits the id segment when nothing is running', () => {
    expect(formatStatusLine({ running: [], done: 3, total: 3, failed: 0, elapsedMs: 1000 })).toBe(
      '▶ 0 running · 3/3 · 1s',
    )
  })

  it('appends a failed tail when failures exist', () => {
    expect(
      formatStatusLine({ running: [], done: 4, total: 8, failed: 2, elapsedMs: 9999 }),
    ).toContain(' · 2 failed')
  })
})

function mkNode(id: string, opts: { requested?: boolean; group?: boolean } = {}): TaskNode {
  const [project, task] = id.split('#')
  return {
    id,
    projectName: project,
    taskName: task,
    requested: opts.requested ?? false,
    deps: [],
    config: opts.group ? {} : { exec: { command: 'noop' } },
  } as unknown as TaskNode
}

function mkOutcome(
  node: TaskNode,
  status: TaskOutcome['status'],
  extra: Partial<TaskOutcome> = {},
): TaskOutcome {
  return {
    node,
    status,
    exitCode: status === 'failed' ? 1 : 0,
    durationMs: 100,
    hash: 'abcdef0123456789',
    ...extra,
  }
}

const NO_COLORS = { enabled: false }

describe('defaultLogger status line integration', () => {
  it('non-TTY: lifecycle hooks are completely inert (no escapes, no ticker)', () => {
    const s = pipe()
    const log = defaultLogger(NO_COLORS, { mode: 'broad' }, s)
    log.runStart?.({ total: 2 })
    const n = mkNode('one#build')
    log.taskStart?.(n)
    log.taskComplete(n, mkOutcome(n, 'success'))
    log.runEnd?.()
    expect(s.text()).not.toContain('\x1b')
  })

  it('CI view: status line suppressed even on a TTY', () => {
    const s = tty()
    const log = defaultLogger(NO_COLORS, { mode: 'full', ci: true }, s)
    log.runStart?.({ total: 1 })
    log.taskStart?.(mkNode('one#build'))
    log.runEnd?.()
    expect(s.text()).not.toContain('\x1b[2K')
  })

  it('TTY broad run: status appears, tracks progress, and is cleared before the summary', () => {
    const s = tty()
    const log = defaultLogger(NO_COLORS, { mode: 'broad' }, s)
    log.runStart?.({ total: 2 })
    expect(s.text()).toContain('▶ 0 running · 0/2')
    const a = mkNode('one#a')
    log.taskStart?.(a)
    expect(s.text()).toContain('▶ 1 running · 0/2 · one#a')
    log.taskComplete(a, mkOutcome(a, 'success'))
    expect(s.text()).toContain('▶ 0 running · 1/2')
    log.runEnd?.()
    log.status(' Tasks:    1 successful, 1 total')
    const text = s.text()
    // The run-end clear is permanent: the summary is written plainly
    // after the final CLEAR, with no redraw after it.
    const tail = text.slice(text.lastIndexOf(CLEAR) + CLEAR.length)
    expect(tail).toBe(' Tasks:    1 successful, 1 total\n')
  })

  it('failed counter reaches the line', () => {
    const s = tty()
    const log = defaultLogger(NO_COLORS, { mode: 'broad' }, s)
    log.runStart?.({ total: 2 })
    const a = mkNode('one#a')
    log.taskStart?.(a)
    log.taskComplete(a, mkOutcome(a, 'failed'))
    expect(s.text()).toContain('· 1 failed')
    log.runEnd?.()
  })

  it('focused: status lives only while deps run; a requested start kills it for good', () => {
    const s = tty()
    const log = defaultLogger(NO_COLORS, { mode: 'focused' }, s)
    log.runStart?.({ total: 2 })
    const dep = mkNode('lib#build')
    log.taskStart?.(dep)
    expect(s.text()).toContain('lib#build')
    log.taskComplete(dep, mkOutcome(dep, 'success'))
    const req = mkNode('one#test', { requested: true })
    log.taskStart?.(req)
    // Permanently cleared: streamed output flows raw with no status
    // rewrites around it.
    const before = s.chunks.length
    log.taskStdout(req, 'raw output\n')
    expect(s.chunks.slice(before)).toEqual(['raw output\n'])
    log.taskComplete(req, mkOutcome(req, 'success'))
    log.runEnd?.()
    expect(s.text().endsWith('raw output\n')).toBe(true)
  })

  it('group-task starts do not disturb the status line', () => {
    const s = tty()
    const log = defaultLogger(NO_COLORS, { mode: 'focused' }, s)
    log.runStart?.({ total: 1 })
    const group = mkNode('one#ci', { requested: true, group: true })
    log.taskStart?.(group)
    // Still alive: a dep starting after the group keeps drawing.
    const dep = mkNode('lib#build')
    log.taskStart?.(dep)
    expect(s.text()).toContain('lib#build')
    log.runEnd?.()
  })

  it('runEnd is idempotent', () => {
    const s = tty()
    const log = defaultLogger(NO_COLORS, { mode: 'broad' }, s)
    log.runStart?.({ total: 1 })
    log.runEnd?.()
    const len = s.chunks.length
    log.runEnd?.()
    expect(s.chunks.length).toBe(len)
  })
})
