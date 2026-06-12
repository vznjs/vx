// Dynamic status display: a fixed-height worker region redrawn in
// place, only on TTY stdout outside CI. The writer is the
// serialization point — any ordinary write erases the region first,
// writes its content, then redraws — and the run-end erase is
// permanent.

import { describe, expect, it } from 'bun:test'
import {
  createOutputWriter,
  formatStatusRegion,
  type StatusStream,
  type WorkerSlot,
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

  it('TTY broad run: worker region appears, tracks progress, and is erased before the summary', () => {
    const s = tty()
    const log = defaultLogger(NO_COLORS, { mode: 'broad' }, s)
    log.runStart?.({ total: 2, concurrency: 2 })
    // Fixed-height region from the start: idle slots + stats line.
    expect(s.text()).toContain('idle')
    expect(s.text()).toContain('idle')
    expect(s.text()).toContain('▶ 0 failed · 0 success · 2 left · 2 total')
    const a = mkNode('one#a')
    log.taskStart?.(a)
    expect(s.chunks[s.chunks.length - 1]).toContain('one#a')
    log.taskComplete(a, mkOutcome(a, 'success'))
    const after = s.chunks[s.chunks.length - 1]!
    expect(after).toContain('▶ 0 failed · 1 success · 1 left · 2 total')
    log.runEnd?.()
    log.status(' Tasks:    1 successful, 1 total')
    const text = s.text()
    // The run-end erase is permanent: the summary is written plainly
    // after the final region erase (cursor-up + ESC[J), no redraw.
    const tail = text.slice(text.lastIndexOf('\x1b[J') + '\x1b[J'.length)
    expect(tail).toBe(' Tasks:    1 successful, 1 total\n')
  })

  it('broad region: slots are stable — finishing one task never moves the others', () => {
    const s = tty()
    const log = defaultLogger(NO_COLORS, { mode: 'broad' }, s)
    log.runStart?.({ total: 4, concurrency: 2 })
    const a = mkNode('aa#x')
    const b = mkNode('bb#x')
    log.taskStart?.(a)
    log.taskStart?.(b)
    let rows = s.chunks[s.chunks.length - 1]!.split('\n')
    expect(rows[0]).toContain('aa#x')
    expect(rows[1]).toContain('bb#x')
    // a finishes; b must stay in row 2; c reuses row 1.
    log.taskComplete(a, mkOutcome(a, 'success'))
    const c = mkNode('cc#x')
    log.taskStart?.(c)
    rows = s.chunks[s.chunks.length - 1]!.split('\n')
    expect(rows[0]).toContain('cc#x')
    expect(rows[1]).toContain('bb#x')
    log.runEnd?.()
  })

  it('broad region: overflow beyond displayed slots surfaces as "+k more" and queues for a freed slot', () => {
    const s = tty()
    const log = defaultLogger(NO_COLORS, { mode: 'broad' }, s)
    log.runStart?.({ total: 4, concurrency: 2 })
    const nodes = ['a#x', 'b#x', 'c#x'].map((id) => mkNode(id))
    for (const n of nodes) log.taskStart?.(n)
    let last = s.chunks[s.chunks.length - 1]!
    expect(last).toContain('+1 more')
    expect(last).not.toContain('c#x')
    log.taskComplete(nodes[0]!, mkOutcome(nodes[0]!, 'success'))
    last = s.chunks[s.chunks.length - 1]!
    expect(last.split('\n')[0]).toContain('c#x')
    expect(last).not.toContain('more')
    log.runEnd?.()
  })

  it('broad region: every cache bucket lands in the stats line', () => {
    const s = tty()
    const log = defaultLogger(NO_COLORS, { mode: 'broad' }, s)
    log.runStart?.({ total: 4, concurrency: 1 })
    const finish = (id: string, status: TaskOutcome['status'], restored?: boolean): void => {
      const n = mkNode(id)
      log.taskStart?.(n)
      log.taskComplete(n, mkOutcome(n, status, restored === undefined ? {} : { restored }))
    }
    finish('a#x', 'cache-hit', false)
    finish('b#x', 'cache-hit', true)
    finish('c#x', 'cache-hit-remote', true)
    finish('d#x', 'failed')
    const last = s.chunks[s.chunks.length - 1]!
    expect(last).toContain('1 failed · 0 success · 0 left · 4 total')
    expect(last).toContain('1 miss · 1 up-to-date · 1 local · 1 remote')
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

describe('formatStatusRegion', () => {
  const base = {
    done: 0,
    total: 8,
    succeeded: 0,
    upToDate: 0,
    restoredLocal: 0,
    restoredRemote: 0,
    failed: 0,
    overflow: 0,
    elapsedMs: 5000,
    nowMs: 10_000,
    spinnerFrame: 0,
  }
  const slot = (id: string, startedMs = 8000): WorkerSlot => ({ id, startedMs })

  it('renders one row per slot plus the stats line, idle slots dimmed-but-present', () => {
    const lines = formatStatusRegion({ ...base, slots: [slot('a#build'), null] })
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('a#build')
    expect(lines[0]).toContain('2.0s')
    expect(lines[1]).toContain('idle')
    expect(lines[2]).toBe(
      '▶ 0 failed · 0 success · 8 left · 8 total │ 0 miss · 0 up-to-date · 0 local · 0 remote │ 5s',
    )
  })

  it('idle rows hold their place so the region height never changes', () => {
    const slots = Array.from({ length: 10 }, () => null)
    const lines = formatStatusRegion({ ...base, slots })
    expect(lines).toHaveLength(11)
    expect(lines.slice(0, 10).every((l) => l.includes('idle'))).toBe(true)
  })

  it('every bucket is always present in fixed order — no layout shift', () => {
    const lines = formatStatusRegion({
      ...base,
      slots: [null],
      done: 7,
      succeeded: 2,
      upToDate: 3,
      restoredLocal: 1,
      restoredRemote: 1,
      failed: 0,
    })
    expect(lines.at(-1)).toBe(
      '▶ 0 failed · 2 success · 1 left · 8 total │ 2 miss · 3 up-to-date · 1 local · 1 remote │ 5s',
    )
  })

  it('overflow appends "+k more"', () => {
    const lines = formatStatusRegion({ ...base, slots: [slot('a#x')], overflow: 3 })
    expect(lines.at(-1)).toContain('· +3 more')
  })

  it('long ids middle-truncate to keep the column stable', () => {
    const long = '@scope/very-long-package-name-here#build-something-long'
    const lines = formatStatusRegion({ ...base, slots: [slot(long)] })
    expect(lines[0]).toContain('…')
    expect(lines[0]!.length).toBeLessThan(60)
  })
})

describe('createOutputWriter region mechanics', () => {
  it('multi-line redraw moves to the region top and clears to screen end', () => {
    const s = tty()
    const w = createOutputWriter(s)
    w.setRegion(['l1', 'l2', 'l3'], { force: true })
    expect(s.chunks.at(-1)).toBe(`${CLEAR}l1\nl2\nl3`)
    w.setRegion(['x1', 'x2', 'x3'], { force: true })
    expect(s.chunks.at(-1)).toBe('\r\x1b[2A\x1b[Jx1\nx2\nx3')
  })

  it('a foreign write erases the whole region, prints, then redraws', () => {
    const s = tty()
    const w = createOutputWriter(s)
    w.setRegion(['l1', 'l2'], { force: true })
    const before = s.chunks.length
    w.write('content\n')
    expect(s.chunks.slice(before)).toEqual(['\r\x1b[1A\x1b[J', 'content\n', `${CLEAR}l1\nl2`])
  })

  it('clearStatus erases the region permanently', () => {
    const s = tty()
    const w = createOutputWriter(s)
    w.setRegion(['l1', 'l2'], { force: true })
    w.clearStatus()
    expect(s.chunks.at(-1)).toBe('\r\x1b[1A\x1b[J')
    w.setRegion(['again'], { force: true })
    expect(s.chunks.at(-1)).toBe('\r\x1b[1A\x1b[J')
  })

  it('focused replay pin: a requested cache hit streams its stored stdout raw', () => {
    const s = tty()
    const log = defaultLogger(NO_COLORS, { mode: 'focused' }, s)
    log.runStart?.({ total: 1, concurrency: 1 })
    const req = mkNode('one#build', { requested: true })
    log.taskStart?.(req)
    // The orchestrator replays hit.stdout through taskStdout for every
    // hit kind — up-to-date included (execute-task.ts replay is
    // unconditional). The logger must pass it through verbatim.
    log.taskStdout(req, 'replayed build output\n')
    log.taskComplete(req, mkOutcome(req, 'cache-hit', { restored: false }))
    log.runEnd?.()
    expect(s.text()).toContain('replayed build output\n')
    // No one-liner duplication for a streamed hit.
    expect(s.text()).not.toContain('──')
  })
})
