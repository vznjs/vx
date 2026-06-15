// Dynamic status display: a fixed-height worker region redrawn in
// place, only on TTY stdout outside CI. The writer is the
// serialization point — any ordinary write erases the region first,
// writes its content, then redraws — and the run-end erase is
// permanent.

import { describe, expect, it } from 'bun:test'
import {
  createOutputWriter,
  formatFailureLine,
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
    const w = createOutputWriter(s, { minRedrawMs: 100, forceFloorMs: 0, now: () => nowMs })
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

  it('forced redraws are coalesced: a burst within the floor lands as ONE trailing draw', async () => {
    let nowMs = 0
    const s = tty()
    const w = createOutputWriter(s, { forceFloorMs: 30, now: () => nowMs })
    // First draw after idle is immediate.
    w.setStatus('v1', { force: true })
    expect(s.text()).toBe(`${CLEAR}v1`)
    nowMs = 10
    w.setStatus('v2', { force: true })
    w.setStatus('v3', { force: true })
    // Burst suppressed synchronously...
    expect(s.text()).toBe(`${CLEAR}v1`)
    // ...but the final state always lands via one trailing draw.
    await Bun.sleep(45)
    expect(s.text()).toBe(`${CLEAR}v1${CLEAR}v3`)
  })

  it('the force floor is on by default: back-to-back forced draws coalesce', async () => {
    const s = tty()
    const w = createOutputWriter(s)
    w.setStatus('v1', { force: true })
    w.setStatus('v2', { force: true })
    expect(s.text()).toBe(`${CLEAR}v1`)
    await Bun.sleep(45)
    expect(s.text()).toBe(`${CLEAR}v1${CLEAR}v2`)
  })

  it('a forced set after the floor expires draws immediately', () => {
    let nowMs = 0
    const s = tty()
    const w = createOutputWriter(s, { forceFloorMs: 30, now: () => nowMs })
    w.setStatus('v1', { force: true })
    nowMs = 31
    w.setStatus('v2', { force: true })
    expect(s.text()).toBe(`${CLEAR}v1${CLEAR}v2`)
  })

  it('clearStatus cancels the pending trailing draw', async () => {
    let nowMs = 0
    const s = tty()
    const w = createOutputWriter(s, { forceFloorMs: 30, now: () => nowMs })
    w.setStatus('v1', { force: true })
    nowMs = 10
    w.setStatus('v2', { force: true })
    w.clearStatus()
    const len = s.chunks.length
    await Bun.sleep(45)
    expect(s.chunks.length).toBe(len)
  })

  it('a content write redraws the latest state and cancels the trailing draw', async () => {
    let nowMs = 0
    const s = tty()
    const w = createOutputWriter(s, { forceFloorMs: 30, now: () => nowMs })
    w.setStatus('v1', { force: true })
    nowMs = 10
    w.setStatus('v2', { force: true })
    w.write('content\n')
    // The write's own redraw already painted v2 — no trailing draw.
    expect(s.chunks.at(-1)).toBe(`${CLEAR}v2`)
    const len = s.chunks.length
    await Bun.sleep(45)
    expect(s.chunks.length).toBe(len)
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

function mkNode(
  id: string,
  opts: { requested?: boolean; group?: boolean; persistent?: boolean } = {},
): TaskNode {
  const [project, task] = id.split('#')
  return {
    id,
    projectName: project,
    taskName: task,
    requested: opts.requested ?? false,
    deps: [],
    config: opts.group
      ? {}
      : { exec: { command: 'noop', ...(opts.persistent ? { persistent: {} } : {}) } },
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

/** Region rows from a redraw chunk, with the erase prefix stripped. */
function regionRows(chunk: string): string[] {
  let c = chunk
  if (c.startsWith(CLEAR)) c = c.slice(CLEAR.length)
  else if (c.startsWith('\r')) c = c.slice(c.indexOf('\x1b[J') + '\x1b[J'.length)
  return c.split('\n')
}

describe('defaultLogger status line integration', () => {
  it('non-TTY: lifecycle hooks are completely inert (no escapes, no ticker)', () => {
    const s = pipe()
    const log = defaultLogger(NO_COLORS, { mode: 'broad' }, s, { forceFloorMs: 0 })
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
    const log = defaultLogger(NO_COLORS, { mode: 'broad' }, s, { forceFloorMs: 0 })
    log.runStart?.({ total: 2, concurrency: 2 })
    // Region from the start: idle slots + the live summary section.
    expect(s.text()).toContain('idle')
    expect(s.text()).toContain('─ vx ')
    expect(s.text()).toContain('▱')
    const a = mkNode('one#a')
    log.taskStart?.(a)
    expect(s.chunks[s.chunks.length - 1]).toContain('one#a')
    log.taskComplete(a, mkOutcome(a, 'success'))
    const after = s.chunks[s.chunks.length - 1]!
    // The live section speaks the summary's language as it fills in.
    expect(after).toContain('1 success')
    expect(after).toContain('1 miss')
    expect(after).toContain('▱')
    expect(after).toContain('  time  ')
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
    const log = defaultLogger(NO_COLORS, { mode: 'broad' }, s, { forceFloorMs: 0 })
    log.runStart?.({ total: 4, concurrency: 2 })
    const a = mkNode('aa#x')
    const b = mkNode('bb#x')
    log.taskStart?.(a)
    log.taskStart?.(b)
    // rows[0] is the region's leading blank separator; slots start at [1].
    let rows = regionRows(s.chunks[s.chunks.length - 1]!)
    expect(rows[1]).toContain('aa#x')
    expect(rows[2]).toContain('bb#x')
    // a finishes; b must stay in row 2; c reuses row 1.
    log.taskComplete(a, mkOutcome(a, 'success'))
    const c = mkNode('cc#x')
    log.taskStart?.(c)
    rows = regionRows(s.chunks[s.chunks.length - 1]!)
    expect(rows[1]).toContain('cc#x')
    expect(rows[2]).toContain('bb#x')
    log.runEnd?.()
  })

  it('broad region: overflow beyond displayed slots surfaces as "+k more" and queues for a freed slot', () => {
    const s = tty()
    const log = defaultLogger(NO_COLORS, { mode: 'broad' }, s, { forceFloorMs: 0 })
    log.runStart?.({ total: 4, concurrency: 2 })
    const nodes = ['a#x', 'b#x', 'c#x'].map((id) => mkNode(id))
    for (const n of nodes) log.taskStart?.(n)
    let last = s.chunks[s.chunks.length - 1]!
    expect(last).toContain('+1 more')
    expect(last).not.toContain('c#x')
    log.taskComplete(nodes[0]!, mkOutcome(nodes[0]!, 'success'))
    last = s.chunks[s.chunks.length - 1]!
    // rows[0] is the leading blank; the freed slot's task is the first row.
    expect(regionRows(last)[1]).toContain('c#x')
    expect(last).not.toContain('more')
    log.runEnd?.()
  })

  it('broad region: every cache bucket lands in the stats line', () => {
    const s = tty()
    const log = defaultLogger(NO_COLORS, { mode: 'broad' }, s, { forceFloorMs: 0 })
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
    expect(last).toContain('1 failed · 3 success')
    expect(last).toContain('1 miss · 1 up-to-date · 1 local · 1 remote')
    log.runEnd?.()
  })

  it('focused: status lives only while deps run; a requested start kills it for good', () => {
    const s = tty()
    const log = defaultLogger(NO_COLORS, { mode: 'focused' }, s, { forceFloorMs: 0 })
    log.runStart?.({ total: 2 })
    const dep = mkNode('lib#build')
    log.taskStart?.(dep)
    expect(s.text()).toContain('lib#build')
    log.taskComplete(dep, mkOutcome(dep, 'success'))
    const req = mkNode('one#test', { requested: true })
    log.taskStart?.(req)
    // Permanently cleared: after the frame-open, streamed output
    // flows raw with no status rewrites around it.
    const before = s.chunks.length
    log.taskStdout(req, 'raw output\n')
    expect(s.chunks.slice(before)).toEqual(['raw output\n'])
    log.taskComplete(req, mkOutcome(req, 'success'))
    log.runEnd?.()
    expect(s.text().endsWith('└─ one#test ── (100ms) success\n\n')).toBe(true)
  })

  it('group-task starts do not disturb the status line', () => {
    const s = tty()
    const log = defaultLogger(NO_COLORS, { mode: 'focused' }, s, { forceFloorMs: 0 })
    log.runStart?.({ total: 1 })
    const group = mkNode('one#ci', { requested: true, group: true })
    log.taskStart?.(group)
    // Still alive: a dep starting after the group keeps drawing.
    const dep = mkNode('lib#build')
    log.taskStart?.(dep)
    expect(s.text()).toContain('lib#build')
    log.runEnd?.()
  })

  it('a failure logs a permanent ✗ line; its frame replays at runEnd', () => {
    const s2 = tty()
    const log = defaultLogger(NO_COLORS, { mode: 'broad' }, s2, { forceFloorMs: 0 })
    log.runStart?.({ total: 2, concurrency: 1 })
    const bad = mkNode('one#boom')
    log.taskStart?.(bad)
    log.taskStderr(bad, 'kaput\n')
    log.taskComplete(bad, mkOutcome(bad, 'failed'))
    // ✗ marker is permanent scrollback, not a region pin.
    expect(s2.text()).toContain('failed  miss   one#boom')
    expect(s2.text()).not.toContain('┌─ one#boom')
    log.runEnd?.()
    // Full frame replays after the region is gone, above the summary.
    expect(s2.text()).toContain('┌─ one#boom > failed (exit 1)')
    expect(s2.text()).toContain('kaput')
  })

  it('a ready persistent task pins as running until runEnd', () => {
    const s = tty()
    const log = defaultLogger(NO_COLORS, { mode: 'broad' }, s, { forceFloorMs: 0 })
    log.runStart?.({ total: 2, concurrency: 1 })
    const dev = mkNode('web#dev', { persistent: true })
    log.taskStart?.(dev)
    // Persistent outcome arrives at READY while the child keeps
    // running — from here the pin is the visible evidence it's alive.
    log.taskComplete(dev, mkOutcome(dev, 'success'))
    // [0] is the region's leading blank separator; the pin is [1].
    expect(regionRows(s.chunks[s.chunks.length - 1]!)[1]).toBe(' ▸         running        web#dev')
    log.runEnd?.()
  })

  it('a non-persistent success never pins', () => {
    const s = tty()
    const log = defaultLogger(NO_COLORS, { mode: 'broad' }, s, { forceFloorMs: 0 })
    log.runStart?.({ total: 1, concurrency: 1 })
    const ok = mkNode('one#x')
    log.taskStart?.(ok)
    log.taskComplete(ok, mkOutcome(ok, 'success'))
    const last = s.chunks[s.chunks.length - 1]!
    expect(last).not.toContain('▸')
    expect(last).not.toContain('✗')
    log.runEnd?.()
  })

  it('rapid task events coalesce into a trailing redraw (forced floor)', async () => {
    const s = tty()
    const log = defaultLogger(NO_COLORS, { mode: 'broad' }, s, { forceFloorMs: 30 })
    log.runStart?.({ total: 2, concurrency: 2 })
    const a = mkNode('one#a')
    log.taskStart?.(a)
    // Within the floor: the start event marks dirty, no draw yet...
    expect(s.text()).not.toContain('one#a')
    // ...and the trailing draw lands the latest state.
    await Bun.sleep(45)
    expect(s.text()).toContain('one#a')
    log.runEnd?.()
  })

  it('runEnd is idempotent', () => {
    const s = tty()
    const log = defaultLogger(NO_COLORS, { mode: 'broad' }, s, { forceFloorMs: 0 })
    log.runStart?.({ total: 1 })
    log.runEnd?.()
    const len = s.chunks.length
    log.runEnd?.()
    expect(s.chunks.length).toBe(len)
  })
})

describe('formatStatusRegion', () => {
  const SUMMARY = ['', '─ vx ──', '  tasks   …']
  const base = {
    pinnedPersistent: [],
    overflow: 0,
    nowMs: 10_000,
    summaryLines: SUMMARY,
  }
  const slot = (id: string, startedMs = 8000): WorkerSlot => ({ id, startedMs })

  // The region leads with a blank line separating it from the
  // completed-task list scrolling above (owner request).
  it('renders slot rows then the live summary section verbatim', () => {
    const lines = formatStatusRegion({ ...base, slots: [slot('a#build'), null] })
    expect(lines).toHaveLength(6)
    expect(lines[0]).toBe('')
    expect(lines[1]).toContain('a#build')
    // Live elapsed (right-aligned) + the `running` tag, no spinner.
    expect(lines[1]).toContain('2.00s')
    expect(lines[1]).toContain('running')
    expect(lines[2]).toContain('idle')
    expect(lines.slice(3)).toEqual(SUMMARY)
  })

  it('idle rows hold their place so the slot zone height never changes', () => {
    const slots = Array.from({ length: 10 }, () => null)
    const lines = formatStatusRegion({ ...base, slots })
    expect(lines).toHaveLength(14)
    expect(lines.slice(1, 11).every((l) => l.includes('idle'))).toBe(true)
  })

  it('overflow gets its own dim line between slots and summary', () => {
    const lines = formatStatusRegion({ ...base, slots: [slot('a#x')], overflow: 3 })
    expect(lines[2]).toBe('… +3 more running')
    expect(lines.slice(3)).toEqual(SUMMARY)
  })

  it('long ids are shown in full (never truncated — name is the last column)', () => {
    const long = '@scope/very-long-package-name-here#build-something-long'
    const lines = formatStatusRegion({ ...base, slots: [slot(long)] })
    expect(lines[1]).toContain(long)
    expect(lines[1]).not.toContain('…')
  })

  it('pinned persistent tasks render above the worker rows', () => {
    const lines = formatStatusRegion({
      ...base,
      pinnedPersistent: ['web#dev', 'api#dev'],
      slots: [null],
    })
    expect(lines).toHaveLength(7)
    expect(lines[1]).toBe(' ▸         running        web#dev')
    expect(lines[2]).toBe(' ▸         running        api#dev')
    expect(lines[3]).toContain('idle')
    expect(lines.slice(4)).toEqual(SUMMARY)
  })

  it('persistent pins keep ids identity-colored, never status-colored', () => {
    const lines = formatStatusRegion(
      { ...base, pinnedPersistent: ['web#dev'], slots: [null] },
      { enabled: true },
    )
    expect(lines[1]).toContain('running')
    expect(lines[1]).toContain('\x1b[')
  })

  it('formatFailureLine: red ◼︎ glyph + exec time + failed + miss + id (no exit code)', () => {
    expect(formatFailureLine('a#build', 100)).toBe(' ◼︎   100ms failed  miss   a#build')
    const colored = formatFailureLine('a#build', 100, { enabled: true })
    expect(colored).toContain('◼︎')
    expect(colored).toContain('failed')
    expect(colored).toContain('\x1b[')
  })
})

describe('createOutputWriter region mechanics', () => {
  it('multi-line redraw moves to the region top and clears to screen end', () => {
    const s = tty()
    const w = createOutputWriter(s, { forceFloorMs: 0 })
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

  it('variable region height: erase always uses the previously drawn height', () => {
    const s = tty()
    const w = createOutputWriter(s, { forceFloorMs: 0 })
    w.setRegion(['l1', 'l2'], { force: true })
    expect(s.chunks.at(-1)).toBe(`${CLEAR}l1\nl2`)
    // Grow 2 → 4: erase moves up 1 (old height 2), draws 4 lines.
    w.setRegion(['g1', 'g2', 'g3', 'g4'], { force: true })
    expect(s.chunks.at(-1)).toBe('\r\x1b[1A\x1b[Jg1\ng2\ng3\ng4')
    // Shrink 4 → 1: erase moves up 3 (old height 4), draws 1 line.
    w.setRegion(['solo'], { force: true })
    expect(s.chunks.at(-1)).toBe('\r\x1b[3A\x1b[Jsolo')
    // A foreign write after the shrink erases exactly the 1-line region.
    w.write('content\n')
    expect(s.chunks.slice(-3)).toEqual([CLEAR, 'content\n', `${CLEAR}solo`])
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
    const log = defaultLogger(NO_COLORS, { mode: 'focused' }, s, { forceFloorMs: 0 })
    log.runStart?.({ total: 1, concurrency: 1 })
    const req = mkNode('one#build', { requested: true })
    log.taskStart?.(req)
    // The orchestrator replays hit.stdout through taskStdout for every
    // hit kind — up-to-date included (execute-task.ts replay is
    // unconditional). The logger must pass it through verbatim.
    log.taskStdout(req, 'replayed build output\n')
    log.taskComplete(req, mkOutcome(req, 'cache-hit', { restored: false }))
    log.runEnd?.()
    expect(s.text()).toContain('┌─ one#build > $ noop')
    expect(s.text()).toContain('replayed build output\n')
    // Full frame even for an up-to-date hit (owner rule).
    expect(s.text()).toContain('└─ one#build ── (100ms) up-to-date')
  })
})
