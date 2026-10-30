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
    // b at 2,400: 0 left, then c.
    expect(f(new Set(['p#a', 'p#d']), new Map([['p#b', 0]]), 2400).etaMs).toBe(500)
  })

  // 2026-10-27: it used to give up 25% past a p50, so the estimate came and went.
  it('keeps forecasting once a running task is well past its p50', () => {
    const f = createForecast(nodes, p50s, 8)
    expect(f(new Set(['p#a', 'p#d']), new Map([['p#b', 0]]), 9000).etaMs).toBe(500)
    expect(f(new Set(['p#a', 'p#b', 'p#d']), new Map([['p#c', 0]]), 9000).etaMs).toBe(0)
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
    // Past its p50 it still heads the path, and what waits still waits.
    const over = f(new Set(['p#a', 'p#d']), new Map([['p#b', 0]]), 2600)
    expect(over.critical).toBe('p#b')
    expect(over.waiting).toBe(1)
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
    // A multiplexer keeps the outer terminal's variables: inside one started
    // from Windows Terminal or Ghostty, the progress went to it all the same.
    for (const env of [
      { TERM_PROGRAM: 'tmux', TMUX: '/tmp/tmux-1/default,1,0', WT_SESSION: 'x' },
      { TERM_PROGRAM: 'ghostty', TMUX: '/tmp/tmux-1/default,1,0' },
      { TERM_PROGRAM: 'ghostty', STY: '1.pts-0.host' },
      { TERM_PROGRAM: 'screen', ConEmuPID: '1' },
    ])
      expect(terminalSignals(env)).toEqual({ progress: false, notify: false })
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

  it('counts up past the forecast', () => {
    const over = (overMs: number): string | undefined =>
      formatSummarySection({ ...stats, overMs }, 1500, { enabled: false }).find((l) =>
        l.startsWith('  time'),
      )
    expect(over(0)).toBe('  time      1.50s · +1s over')
    expect(over(4200)).toBe('  time      1.50s · +5s over')
    expect(over(65_000)).toBe('  time      1.50s · +1m 05s over')
  })
})

// 2026-10-21: blocked tasks are a number on the tasks line, a dim
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
    expect(legend({})?.trim()).toBe(
      '30 success · 4 running · 12 scheduled · 16 blocked · 32 left · 62 total',
    )
    expect(legend({ blocked: 0 })).not.toContain('blocked')
  })

  // 2026-10-27: done and total were there, what remains was not.
  it('says how many tasks are left, running included, until none is', () => {
    expect(legend({ blocked: 0, scheduled: 0, running: 0, left: 5 })?.trim()).toBe(
      '30 success · 5 left · 62 total',
    )
    expect(legend({ blocked: 0, scheduled: 0, running: 0, left: 0 })).not.toContain('left')
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

// In DTE the list is what runs; a task on the critical path says so on
// its finished row too; the lists have a header.
describe('rows under an executor that places tasks', () => {
  it('no blank or nested rows, only running ones', () => {
    const lines = formatStatusRegion(
      {
        pinnedPersistent: [],
        slots: [{ id: 'p#a', startedMs: 0 }, null, null],
        size: 3,
        next: [{ id: 'p#c', by: 'p#a' }],
        nowMs: 500,
        summaryLines: [],
        where: () => 'small#2',
      },
      { enabled: false },
    )
    expect(lines).toEqual([
      '',
      ' Running',
      '      time   usual status  cache      cpu    mem outputs  blocks worker       task',
      '     500ms         running miss                                0 small#2      p#a',
    ])
  })

  it('the critical path note follows the id; the agent is the worker column', () => {
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
    expect(lines[3]).toBe(
      '     500ms         running miss                                0 small#2      p#a  critical path',
    )
  })

  it('a task the region showed on the critical path says so on its finished row', () => {
    const out = tty()
    const log = defaultLogger({ enabled: false }, { mode: 'broad' }, out, {
      env: {},
      forceFloorMs: 0,
    })
    log.runStart?.({ total: 3, concurrency: 3 })
    log.forecast(
      () => () => ({ blockedBy: new Map(), waiting: 0, critical: 'p#a' }),
      async () => () => ({ blockedBy: new Map(), waiting: 0, critical: 'p#a' }),
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
    // The list's title and header, once, over its first row.
    expect(rows.filter((l) => Bun.stripANSI(l) === ' Finished')).toHaveLength(1)
    expect(
      rows.filter(
        (l) =>
          Bun.stripANSI(l) ===
          '      time  ±usual status  cache      cpu    mem outputs  blocks worker       task',
      ),
    ).not.toHaveLength(0)
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
  const run = async (lastsMs: number, env: Record<string, string>, etaMs = 4000) => {
    const out = tty()
    const log = defaultLogger({ enabled: false }, { mode: 'broad' }, out, { env })
    let asked = 0
    log.runStart?.({ total: 1, concurrency: 1 })
    log.forecast(
      () => () => ({ blockedBy: new Map(), waiting: 0 }),
      async () => {
        asked++
        return () => ({ etaMs, blockedBy: new Map(), waiting: 0 })
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
    expect(r.region).not.toMatch(/s left/)
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

  it('a run past its forecast counts up instead of going blank', async () => {
    const r = await run(1300, {}, 0)
    expect(r.region).toContain('+1s over')
    expect(r.region).not.toMatch(/s left/)
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

describe('a worker row says when it holds the critical path', () => {
  it('critical path on its row, after the count of what it holds back', () => {
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
    expect(lines[3]).toEndWith(' 0 local        p#a  critical path')
    expect(lines[4]).toEndWith(' 0 local        p#d')
  })

  // 2026-10-27 counted only direct dependents; 2026-10-29: `blocks` is
  // every node downstream, each once: the count the scheduler ranks by.
  it('the forecast counts every task downstream of each running task', () => {
    // a runs, b and c wait on it, d on c; e runs, f waits on it; x is ready.
    const f = createForecast(
      graph(
        node('p#a'),
        node('p#b', ['p#a']),
        node('p#c', ['p#a']),
        node('p#d', ['p#c']),
        node('p#e'),
        node('p#f', ['p#e']),
        node('p#x'),
      ),
      new Map(),
      4,
    )
    const r = f(
      new Set(),
      new Map([
        ['p#a', 0],
        ['p#e', 0],
      ]),
      0,
    )
    expect([...r.blockedBy].sort(([x], [y]) => x.localeCompare(y))).toEqual([
      ['p#a', 3],
      ['p#e', 1],
    ])
    expect(r.waiting).toBe(4)
  })

  it('a task waiting on two running tasks counts under both, a group counted', () => {
    // g is a group over a and e; h waits on g and on e.
    const f = createForecast(
      graph(
        node('p#a'),
        node('p#e'),
        node('p#g', ['p#a', 'p#e'], true),
        node('p#h', ['p#g', 'p#e']),
      ),
      new Map(),
      4,
    )
    const r = f(
      new Set(),
      new Map([
        ['p#a', 0],
        ['p#e', 0],
      ]),
      0,
    )
    // The scheduler's count: g and h downstream of each.
    expect([...r.blockedBy].sort(([x], [y]) => x.localeCompare(y))).toEqual([
      ['p#a', 2],
      ['p#e', 2],
    ])
  })
})

// A free worker row holds a task the scheduler has picked next, nested
// under the running task it waits on; nothing further ahead.
describe('free worker rows hold the planned tasks', () => {
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

  const live = (list: { id: string; by: string }[]) => {
    const out = tty()
    const log = defaultLogger({ enabled: false }, { mode: 'broad' }, out, {
      env: {},
      forceFloorMs: 0,
    })
    log.runStart?.({ total: 6, concurrency: 3 })
    const answer = () => ({
      blockedBy: new Map([['p#a', list.length]]),
      waiting: list.length,
      blocked: list,
    })
    log.forecast(
      () => answer,
      async () => answer,
    )
    // Three workers; x and y finish, so two rows are free beside a.
    const [a, x, y] = [node('p#a'), node('p#x'), node('p#y')]
    for (const n of [a, x, y]) log.taskStart?.(n)
    for (const n of [x, y])
      log.taskComplete(n, { node: n, status: 'success', exitCode: 0, durationMs: 1 } as TaskOutcome)
    const frame = (): string[] => {
      const lines = out.text().split('\n')
      const i = lines.findLastIndex((l) => l.includes('worker       task'))
      return lines.slice(i + 1, i + 4).map((l) => l.trimEnd())
    }
    return { log, frame }
  }

  it('the free rows hold the planned tasks, nested under what they wait on', () => {
    const { log, frame } = live([
      { id: 'p#c', by: 'p#a' },
      { id: 'p#b', by: 'p#a' },
      { id: 'p#d', by: 'p#a' },
    ])
    expect(frame()).toEqual([
      expect.stringMatching(/running (?:miss|no-cache) +3 local +p#a$/),
      '                   blocked                                                    └ p#c',
      '                   blocked                                                    └ p#b',
    ])
    log.runEnd?.()
  })

  // No blank row for a free worker: ten of them were ten empty lines
  // between the list and its footer (2026-10-29).
  it('a free row with nothing planned adds no blank row', () => {
    const { log, frame } = live([{ id: 'p#c', by: 'p#a' }])
    expect(frame()).toEqual([
      expect.stringMatching(/running (?:miss|no-cache) +1 local +p#a$/),
      '                   blocked                                                    └ p#c',
      '',
    ])
    log.runEnd?.()
  })
})

// What a free worker row shows is the graph's to say, not history's: from
// the first frame a free row holds a planned task. History only times the run.
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
    const i = lines.findLastIndex((l) => /running (?:miss|no-cache) +\d+ local +p#a\b/.test(l))
    const rows = lines.slice(i + 1, i + 3).map((l) => l.trimEnd())
    log.runEnd?.()
    return { rows, asked }
  }

  it('a free row holds a planned task before history is read', () => {
    const r = live(['p#a', 'p#x', 'p#y', 'p#b', 'p#c'])
    expect(r.asked).toBe(0)
    expect(r.rows).toEqual([
      '                   blocked                                                    └ p#b',
      '                   blocked                                                    └ p#c',
    ])
  })

  it('a free row with nothing planned shows nothing: the footer follows', () => {
    const r = live(['p#a', 'p#x', 'p#y'])
    expect(r.rows).toEqual(['', '─ vx ─────────────────────────────────────────────────────────'])
  })
})

describe('a burst of task events builds the live region once per draw', () => {
  it('the region is built when the writer draws it, not per event', async () => {
    const out = tty()
    // Frozen before the writer reads its clock: every event lands inside
    // the forced-redraw floor, so only the first draws at once.
    const clock = spyOn(Date, 'now').mockReturnValue(Date.now())
    let built = 0
    let lastFinished = -1
    try {
      const log = defaultLogger({ enabled: false }, { mode: 'broad' }, out, { env: {} })
      log.runStart?.({ total: 50, concurrency: 4 })
      log.forecast(
        () => (finished) => {
          built++
          lastFinished = finished.size
          return { blockedBy: new Map(), waiting: 0 }
        },
        async () => () => ({ blockedBy: new Map(), waiting: 0 }),
      )
      for (let i = 0; i < 50; i++) {
        const t = node(`p#t${i}`)
        log.taskStart?.(t)
        log.taskComplete(t, {
          node: t,
          status: 'cache-hit',
          exitCode: 0,
          durationMs: 0,
          restored: false,
        } as TaskOutcome)
      }
      // A hundred events past the first draw: none of them built a region.
      expect(built).toBe(0)
    } finally {
      clock.mockRestore()
    }
    // The trailing draw at the floor's end builds the last state, once.
    await Bun.sleep(80)
    expect([built, lastFinished]).toEqual([1, 50])
    expect(out.text()).toContain('50 up-to-date')
  })
})
