// The live run's forecast (`report/forecast.ts`), the terminal
// escapes that carry it (`terminal-signals.ts`), and the logger's promise
// that a run ending inside a second never reads history for it.

import { describe, expect, it, spyOn } from 'bun:test'
import type { TaskNode, TaskOutcome } from '../src/graph/index.js'
import { createForecast } from '../src/report/forecast.js'
import { defaultLogger } from '../src/report/logger.js'
import { formatStatusRegion, type StatusStream } from '../src/report/status-line.js'
import { formatSummarySection } from '../src/report/summary.js'
import {
  notifyEscape,
  PROGRESS_CLEAR,
  progressEscape,
  terminalSignals,
} from '../src/report/terminal-signals.js'

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

  it('names the running task the longest chain waits on, and counts what waits', () => {
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
    // b and c wait on a; nothing waits on d.
    expect(both.waiting).toBe(2)
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
    expect(later.waiting).toBe(1)
    // Past its p50 the time is unknown, and so is the path; what waits is not.
    const over = f(new Set(['p#a', 'p#d']), new Map([['p#b', 0]]), 2600)
    expect(over.critical).toBeUndefined()
    expect(over.waiting).toBe(1)
  })

  it("names each running task's p50, the row's expected duration", () => {
    const f = createForecast(nodes, p50s, 8)
    const r = f(
      new Set(['p#a']),
      new Map([
        ['p#b', 0],
        ['p#x', 0],
      ]),
      100,
    )
    expect([...(r.expected ?? [])]).toEqual([['p#b', 2000]])
    // A running task past its p50 still says it: the row's value is fixed.
    expect([...(f(new Set(['p#a']), new Map([['p#b', 0]]), 9000).expected ?? [])]).toEqual([
      ['p#b', 2000],
    ])
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

// M, 2026-10-21: blocked tasks are a number on the tasks line, a dim
// segment of its bar; rows carry none of it.
describe('the tasks line counts what is blocked', () => {
  const stats = {
    failed: 0,
    successful: 30,
    skipped: 0,
    total: 62,
    upToDate: 0,
    restoredLocal: 0,
    restoredRemote: 0,
    miss: 0,
    left: 32,
    running: 4,
    scheduled: 12,
    blocked: 16,
    spread: null,
  }
  const legend = (s: object) =>
    formatSummarySection({ ...stats, ...s }, 1500, { enabled: false }).find((l) =>
      l.includes(' total'),
    )

  it('between scheduled and the total, and not when nothing is', () => {
    expect(legend({})?.trim()).toBe('30 success · 4 running · 12 scheduled · 16 blocked · 62 total')
    expect(legend({ blocked: 0 })).not.toContain('blocked')
  })

  it('takes its share of the bar from what is left', () => {
    const bar = (s: object) =>
      formatSummarySection({ ...stats, ...s }, 1500, { enabled: false }).find((l) =>
        l.startsWith('  tasks'),
      )!
    const empty = (l: string) => l.split('\u25b1').length - 1
    expect(empty(bar({}))).toBeLessThan(empty(bar({ blocked: 0 })))
  })

  it('the forecast counts each task an unfinished dependency holds back', () => {
    const f = createForecast(
      graph(node('p#a'), node('p#b', ['p#a']), node('p#c', ['p#b']), node('p#x')),
      new Map(),
      8,
    )
    expect(f(new Set(), new Map([['p#a', 0]]), 0).waiting).toBe(2)
  })
})

// M, 2026-10-21: in DTE the list is what runs; a task on the critical
// path says so on its finished row too; the lists have a dim header.
describe('rows under an executor that places tasks', () => {
  it('no idle or blocked rows, only running ones', () => {
    const lines = formatStatusRegion(
      {
        pinnedPersistent: [],
        slots: [{ id: 'p#a', startedMs: 0 }, null, null],
        blocked: [null, { id: 'p#c', by: 'p#a' }, null],
        nowMs: 500,
        summaryLines: [],
        where: () => 'small#2',
      },
      { enabled: false },
    )
    expect(lines).toEqual([
      '',
      '      time status  cache    task · worker',
      '     500ms running          p#a · small#2',
    ])
  })

  it('the critical path, then the agent last', () => {
    const lines = formatStatusRegion(
      {
        pinnedPersistent: [],
        slots: [
          { id: 'p#a', startedMs: 0 },
          { id: 'p#d', startedMs: 0 },
        ],
        nowMs: 500,
        summaryLines: [],
        critical: 'p#a',
        where: () => 'small#2',
      },
      { enabled: false },
    )
    expect(lines[2]).toBe('     500ms running          p#a  critical path · small#2')
  })

  it('a task the region showed on the critical path says so on its finished row', () => {
    const out = tty()
    const log = defaultLogger({ enabled: false }, { mode: 'broad' }, out, {
      env: {},
      forceFloorMs: 0,
    })
    log.runStart?.({ total: 3, concurrency: 3 })
    log.forecast(
      () => () => ({ waiting: 0, critical: 'p#a' }),
      async () => () => ({ waiting: 0, critical: 'p#a' }),
    )
    const [a, d, x] = [node('p#a'), node('p#d'), node('p#x')]
    for (const t of [a, d, x]) log.taskStart?.(t)
    const done = (t: TaskNode) =>
      ({ node: t, status: 'success', exitCode: 0, durationMs: 1 }) as TaskOutcome
    // x frees a row, so the graph's forecast runs while a and d still do.
    for (const t of [x, a, d]) log.taskComplete(t, done(t))
    log.runEnd?.()
    const rows = out.text().split(/[\n\r]/)
    expect(rows.find((l) => l.endsWith('p#a  critical path'))).toBeDefined()
    expect(rows.find((l) => /success .*p#d$/.test(l))).toBeDefined()
    // The list's header, once, over its first row.
    expect(rows.filter((l) => l === '      time status  cache    task')).not.toHaveLength(0)
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
    log.forecast(
      () => () => ({ waiting: 0 }),
      async () => {
        asked++
        return () => ({ etaMs: 4000, waiting: 0 })
      },
    )
    const a = node('p#a')
    log.taskStart?.(a)
    await Bun.sleep(lastsMs)
    const region = out.text()
    log.runEnd?.()
    log.runDone?.()
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

// M, 2026-10-21: `blocks N` said nothing worth a column; the critical path stays.
describe('a worker row says when it holds the critical path', () => {
  it('critical path on its row alone, and no count of what it blocks', () => {
    const lines = formatStatusRegion(
      {
        pinnedPersistent: [],
        slots: [
          { id: 'p#a', startedMs: 0 },
          { id: 'p#d', startedMs: 0 },
        ],
        nowMs: 500,
        summaryLines: [],
        critical: 'p#a',
      },
      { enabled: false },
    )
    expect(lines[2]).toEndWith('p#a  critical path')
    expect(lines[3]).toEndWith('p#d')
  })
})

// M, 2026-10-15: an idle worker row holds a task an unfinished dependency
// blocks, in the order the scheduler would start it; a row with none left
// to hold leaves the region.
describe('idle worker rows hold blocked tasks', () => {
  // a runs; b and c wait on it, d waits on c; x is ready, so not blocked.
  const nodes = graph(
    node('p#a'),
    node('p#b', ['p#a']),
    node('p#c', ['p#a']),
    node('p#d', ['p#c']),
    node('p#x'),
    node('p#g', ['p#a'], true),
  )

  it('lists blocked tasks most-blocking first, each with the running task that holds it', () => {
    const f = createForecast(nodes, new Map(), 8)
    expect(f(new Set(), new Map([['p#a', 0]]), 0).blocked).toEqual([
      { id: 'p#c', by: 'p#a' },
      { id: 'p#b', by: 'p#a' },
      { id: 'p#d', by: 'p#a' },
    ])
  })

  it('lists no more than the workers, and nothing once none is blocked', () => {
    const f = createForecast(nodes, new Map(), 2)
    expect(f(new Set(), new Map([['p#a', 0]]), 0).blocked?.map((b) => b.id)).toEqual(['p#c', 'p#b'])
    expect(f(new Set(['p#a', 'p#c']), new Map([['p#b', 0]]), 0).blocked).toEqual([])
  })

  it('an idle row reads blocked, the id, then what holds it, on the running grid', () => {
    const lines = formatStatusRegion(
      {
        pinnedPersistent: [],
        slots: [{ id: 'p#a', startedMs: 0 }, null, null],
        blocked: [null, { id: 'p#c', by: 'p#a' }, null],
        nowMs: 500,
        summaryLines: [],
      },
      { enabled: false },
    )
    expect(lines[3]).toBe('           blocked          p#c  by p#a')
    expect(lines[3]!.indexOf('blocked')).toBe(lines[2]!.indexOf('running'))
    // A row the list leaves empty reads idle; the live logger never draws one.
    expect(lines[4]).toContain('idle')
  })

  const live = async (list: { id: string; by: string }[]) => {
    const out = tty()
    const log = defaultLogger({ enabled: false }, { mode: 'broad' }, out, {
      env: {},
      forceFloorMs: 0,
    })
    log.runStart?.({ total: 6, concurrency: 3 })
    log.forecast(
      () => () => ({ waiting: list.length, blocked: list }),
      async () => () => ({ waiting: list.length, blocked: list }),
    )
    // Three rows shown; x and y finish, so two workers sit idle beside a.
    const [a, x, y] = [node('p#a'), node('p#x'), node('p#y')]
    for (const n of [a, x, y]) log.taskStart?.(n)
    for (const n of [x, y])
      log.taskComplete(n, { node: n, status: 'success', exitCode: 0, durationMs: 1 } as TaskOutcome)
    await Bun.sleep(1200)
    const frame = (): string[] => {
      const lines = out.text().split('\n')
      const i = lines.findLastIndex((l) => l.includes('running') && l.endsWith('p#a'))
      return lines.slice(i + 1, i + 3).map((l) => l.trimEnd())
    }
    return { log, frame }
  }

  it('a blocked task that starts runs in the row that held it', async () => {
    const { log, frame } = await live([
      { id: 'p#c', by: 'p#a' },
      { id: 'p#b', by: 'p#a' },
    ])
    expect(frame()).toEqual([
      '           blocked          p#c  by p#a',
      '           blocked          p#b  by p#a',
    ])
    log.taskStart?.(node('p#b'))
    const [second, third] = frame()
    expect(second).toContain('blocked          p#c')
    expect(third).toContain('running          p#b')
    log.runEnd?.()
  })

  it('a worker with nothing left to hold leaves the region', async () => {
    const { log, frame } = await live([{ id: 'p#c', by: 'p#a' }])
    const [second, third] = frame()
    expect(second).toBe('           blocked          p#c  by p#a')
    expect(third).not.toContain('idle')
    expect(third).not.toContain('blocked')
    log.runEnd?.()
  })
})

// What a free worker row shows is the graph's to say, not history's (M,
// 2026-10-17: "core should already know that"): from the first frame, an
// idle row holds a blocked task, and one with nothing to hold never draws.
// History only times the run.
describe('the live view knows blocked tasks from the graph, from the first frame', () => {
  const nodes = graph(
    node('p#a'),
    node('p#x'),
    node('p#y'),
    node('p#b', ['p#a']),
    node('p#c', ['p#a']),
  )
  const live = (only: string[]) => {
    const out = tty()
    const log = defaultLogger({ enabled: false }, { mode: 'broad' }, out, {
      env: {},
      forceFloorMs: 0,
    })
    log.runStart?.({ total: nodes.size, concurrency: 3 })
    let asked = 0
    const sub = new Map([...nodes].filter(([id]) => only.includes(id)))
    log.forecast(
      () => createForecast(sub, new Map(), 3),
      async () => {
        asked++
        return createForecast(sub, new Map(), 3)
      },
    )
    const [a, x, y] = [node('p#a'), node('p#x'), node('p#y')]
    for (const n of [a, x, y]) log.taskStart?.(n)
    for (const n of [x, y])
      log.taskComplete(n, { node: n, status: 'success', exitCode: 0, durationMs: 1 } as TaskOutcome)
    const lines = out.text().split('\n')
    const i = lines.findLastIndex((l) => /running {10}p#a\b/.test(l))
    const rows = lines.slice(i + 1, i + 3).map((l) => l.trimEnd())
    log.runEnd?.()
    return { rows, asked }
  }

  it('an idle row holds a blocked task before history is read', () => {
    const r = live(['p#a', 'p#x', 'p#y', 'p#b', 'p#c'])
    expect(r.asked).toBe(0)
    expect(r.rows).toEqual([
      '           blocked          p#b  by p#a',
      '           blocked          p#c  by p#a',
    ])
  })

  it('a free row with nothing to hold never draws idle', () => {
    const r = live(['p#a', 'p#x', 'p#y'])
    expect(r.rows.join('\n')).not.toContain('idle')
    expect(r.rows.join('\n')).not.toContain('blocked')
  })
})
