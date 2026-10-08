// The live run's forecast (`orchestrator/forecast.ts`), the terminal
// escapes that carry it (`terminal-signals.ts`), and the logger's promise
// that a run ending inside a second never reads history for it.

import { describe, expect, it, spyOn } from 'bun:test'
import type { TaskNode, TaskOutcome } from '../src/graph/index.js'
import { createForecast } from '../src/orchestrator/forecast.js'
import { defaultLogger } from '../src/orchestrator/logger.js'
import { formatStatusRegion, type StatusStream } from '../src/orchestrator/status-line.js'
import { formatSummarySection } from '../src/orchestrator/summary.js'
import {
  notifyEscape,
  PROGRESS_CLEAR,
  progressEscape,
  terminalSignals,
} from '../src/orchestrator/terminal-signals.js'

const node = (id: string, deps: string[] = [], group = false): TaskNode =>
  ({
    id,
    deps,
    projectName: id.split('#')[0]!,
    taskName: id.split('#')[1]!,
    requested: true,
    config: group ? {} : { exec: { command: 'true' } },
  }) as unknown as TaskNode

const graph = (...ns: TaskNode[]) => new Map(ns.map((n) => [n.id, n]))

describe('createForecast', () => {
  // a → b → c, and d beside them.
  const nodes = graph(node('p#a'), node('p#b', ['p#a']), node('p#c', ['p#b']), node('p#d'))
  const p50s = new Map([
    ['p#a', 1000],
    ['p#b', 2000],
    ['p#c', 500],
    ['p#d', 3000],
  ])

  it('is the longest unfinished chain when workers are plenty', () => {
    const f = createForecast(nodes, p50s, 8)
    expect(f(new Set(), new Map(), 0).etaMs).toBe(3500)
    expect(f(new Set(['p#a']), new Map(), 0).etaMs).toBe(3000)
    expect(f(new Set(['p#a', 'p#d']), new Map(), 0).etaMs).toBe(2500)
  })

  it('is the unfinished work over the workers when that is longer', () => {
    // 6,500 ms of work on one worker beats the 3,500 ms chain.
    expect(createForecast(nodes, p50s, 1)(new Set(), new Map(), 0).etaMs).toBe(6500)
    expect(createForecast(nodes, p50s, 2)(new Set(), new Map(), 0).etaMs).toBe(3500)
  })

  it('takes what a running task has spent off its p50, never below zero', () => {
    const f = createForecast(nodes, p50s, 8)
    // b ran 1,500 of its 2,000: 500 left, then c.
    expect(f(new Set(['p#a', 'p#d']), new Map([['p#b', 0]]), 1500).etaMs).toBe(1000)
    // b at 2,400 (within the overrun slack): 0 left, then c.
    expect(f(new Set(['p#a', 'p#d']), new Map([['p#b', 0]]), 2400).etaMs).toBe(500)
  })

  it('gives up once a running task is well past its p50', () => {
    const f = createForecast(nodes, p50s, 8)
    expect(f(new Set(['p#a', 'p#d']), new Map([['p#b', 0]]), 2600).etaMs).toBeUndefined()
  })

  it('names the running task the longest chain waits on, and what each one blocks', () => {
    const f = createForecast(nodes, p50s, 8)
    // a (→ b → c: 3,500) against d (3,000): a heads the critical path.
    const both = f(
      new Set(),
      new Map([
        ['p#a', 0],
        ['p#d', 0],
      ]),
      0,
    )
    expect(both.critical).toBe('p#a')
    expect([...both.blocks]).toEqual([
      ['p#a', 2],
      ['p#d', 0],
    ])
    // 900 ms in, a has 100 left (2,600 chain), d 2,100: still a.
    expect(
      f(
        new Set(),
        new Map([
          ['p#a', 0],
          ['p#d', 0],
        ]),
        900,
      ).critical,
    ).toBe('p#a')
    // With a done and b running, b's chain (2,500) beats d's 3,000 - 1,000 spent.
    const later = f(
      new Set(['p#a']),
      new Map([
        ['p#b', 1000],
        ['p#d', 0],
      ]),
      1000,
    )
    expect(later.critical).toBe('p#b')
    expect(later.blocks.get('p#b')).toBe(1)
    // Past its p50 the time is unknown, and so is the path; what waits is not.
    const over = f(new Set(['p#a', 'p#d']), new Map([['p#b', 0]]), 2600)
    expect(over.critical).toBeUndefined()
    expect(over.blocks.get('p#b')).toBe(1)
  })

  it('costs nothing for a group or a task history never saw', () => {
    const g = graph(node('p#x'), node('p#all', ['p#x', 'p#y'], true), node('p#y'))
    const f = createForecast(
      g,
      new Map([
        ['p#x', 700],
        ['p#all', 9000],
      ]),
      8,
    )
    expect(f(new Set(), new Map(), 0).etaMs).toBe(700)
    // Only tasks history never saw are left: nothing to say.
    expect(f(new Set(['p#x']), new Map(), 0).etaMs).toBeUndefined()
  })
})

describe('terminalSignals', () => {
  it('names each terminal known to read the escapes, and no other', () => {
    expect(terminalSignals({ TERM_PROGRAM: 'ghostty' })).toEqual({ progress: true, notify: true })
    expect(terminalSignals({ TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.6.1' })).toEqual({
      progress: true,
      notify: true,
    })
    expect(terminalSignals({ TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.5.9' })).toEqual({
      progress: false,
      notify: true,
    })
    expect(terminalSignals({ TERM_PROGRAM: 'WezTerm' })).toEqual({ progress: false, notify: true })
    expect(terminalSignals({ WT_SESSION: 'x' })).toEqual({ progress: true, notify: false })
    expect(terminalSignals({ ConEmuPID: '1' })).toEqual({ progress: true, notify: false })
    // tmux renames the program: neither, since OSC 9 there may be a notification.
    expect(terminalSignals({ TERM_PROGRAM: 'tmux' })).toEqual({ progress: false, notify: false })
    expect(terminalSignals({})).toEqual({ progress: false, notify: false })
  })

  it('writes the escapes byte for byte, a notification without control bytes', () => {
    expect(progressEscape(41.6)).toBe('\x1b]9;4;1;42\x07')
    expect(progressEscape(140, true)).toBe('\x1b]9;4;2;100\x07')
    expect(PROGRESS_CLEAR).toBe('\x1b]9;4;0;0\x07')
    expect(notifyEscape('vx: done\x07\x1b]9;x')).toBe('\x1b]9;vx: done  ]9;x\x07')
  })
})

describe('the live time row', () => {
  const stats = {
    failed: 0,
    successful: 0,
    skipped: 0,
    total: 3,
    upToDate: 0,
    restoredLocal: 0,
    restoredRemote: 0,
    miss: 0,
    left: 3,
    spread: null,
  }
  const time = (etaMs?: number): string | undefined =>
    formatSummarySection({ ...stats, ...(etaMs !== undefined ? { etaMs } : {}) }, 1500, {
      enabled: false,
    }).find((l) => l.startsWith('  time'))

  it('says the forecast as coarsely as it is known', () => {
    expect(time()).toBe('  time      1.50s')
    expect(time(400)).toBe('  time      1.50s · <1s left')
    expect(time(3001)).toBe('  time      1.50s · ~4s left')
    expect(time(125_000)).toBe('  time      1.50s · ~2m 05s left')
  })
})

function tty(): StatusStream & { text(): string } {
  const chunks: string[] = []
  return {
    isTTY: true,
    columns: 100,
    write(c: string) {
      chunks.push(String(c))
      return true
    },
    text: () => chunks.join(''),
  }
}

describe('the logger asks for a forecast only a second in', () => {
  const run = async (lastsMs: number, env: Record<string, string>) => {
    const out = tty()
    const log = defaultLogger({ enabled: false }, { mode: 'broad' }, out, { env })
    let asked = 0
    log.runStart?.({ total: 1, concurrency: 1 })
    log.forecast(async () => {
      asked++
      return () => ({ etaMs: 4000, blocks: new Map() })
    })
    const a = node('p#a')
    log.taskStart?.(a)
    await Bun.sleep(lastsMs)
    const region = out.text()
    log.runEnd?.()
    return { asked, region, all: out.text() }
  }

  it('a run that ends sooner never loads history', async () => {
    const r = await run(300, { TERM_PROGRAM: 'ghostty' })
    expect(r.asked).toBe(0)
    expect(r.region).not.toContain('left')
    // CONTROL past the gate: the progress escape did go out, and was cleared.
    expect(r.all).toContain('\x1b]9;4;1;0\x07')
    expect(r.all.lastIndexOf(PROGRESS_CLEAR)).toBeGreaterThan(r.all.lastIndexOf('\x1b]9;4;1;'))
  })

  it('a longer one loads it once and shows what is left', async () => {
    const r = await run(1300, {})
    expect(r.asked).toBe(1)
    expect(r.region).toContain('~4s left')
    // No terminal named: no escape at all.
    expect(r.all).not.toContain('\x1b]9;')
  })
})

describe('a long run ends with a desktop notification', () => {
  const end = (afterMs: number, env: Record<string, string>, failed: boolean): string => {
    const out = tty()
    const log = defaultLogger({ enabled: false }, { mode: 'broad' }, out, { env })
    const t0 = Date.now()
    const now = spyOn(Date, 'now').mockReturnValue(t0)
    try {
      log.runStart?.({ total: 2, concurrency: 2 })
      const a = node('p#a')
      log.taskStart?.(a)
      log.taskComplete(a, {
        node: a,
        status: failed ? 'failed' : 'success',
        exitCode: failed ? 1 : 0,
        durationMs: 5,
      } as TaskOutcome)
      now.mockReturnValue(t0 + afterMs)
      log.runEnd?.()
      // Once: a second runEnd says nothing more.
      log.runEnd?.()
    } finally {
      now.mockRestore()
    }
    return out.text()
  }

  it('after ten seconds, in a terminal that posts OSC 9, once', () => {
    const ok = end(10_000, { TERM_PROGRAM: 'WezTerm' }, false)
    expect(ok.split('\x1b]9;vx:').length).toBe(2)
    expect(ok).toContain(notifyEscape('vx: 2 tasks done'))
    expect(end(10_000, { TERM_PROGRAM: 'ghostty' }, true)).toContain(
      notifyEscape('vx: 1 of 2 tasks failed'),
    )
  })

  it('never sooner, and never where OSC 9 is not a notification', () => {
    expect(end(9_999, { TERM_PROGRAM: 'WezTerm' }, false)).not.toContain('\x1b]9;vx')
    expect(end(10_000, { WT_SESSION: 'x' }, false)).not.toContain('\x1b]9;vx')
    expect(end(10_000, {}, false)).not.toContain('\x1b]9;vx')
  })
})

describe('a worker row says what waits on it', () => {
  it('critical path, then the count; nothing for a task nothing waits on', () => {
    const lines = formatStatusRegion(
      {
        pinnedPersistent: [],
        slots: [
          { id: 'p#a', startedMs: 0 },
          { id: 'p#d', startedMs: 0 },
        ],
        overflow: 0,
        nowMs: 500,
        summaryLines: [],
        blocks: new Map([
          ['p#a', 2],
          ['p#d', 0],
        ]),
        critical: 'p#a',
      },
      { enabled: false },
    )
    expect(lines[1]).toEndWith('p#a  critical path · blocks 2')
    expect(lines[2]).toEndWith('p#d')
  })
})
