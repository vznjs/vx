// A terminal narrower than the footer (a VS Code side panel is ~50-60
// columns) wrapped every bar and rule onto a second row: the bars were a
// fixed 50 cells and the rules 60-62 columns. On a terminal they now fit
// its width; off one (a CI log) they keep their fixed width.

import { describe, expect, it } from 'bun:test'
import type { TaskOutcome } from '../src/graph/outcome.js'
import type { TaskNode } from '../src/graph/task-graph.js'
import {
  formatFrameClose,
  formatListHeader,
  formatRecordedRow,
  formatTaskBlock,
  formatTaskExecutedLine,
  planList,
  taskList,
} from '../src/report/framed-output.js'
import { formatRunSummary } from '../src/report/summary.js'
import { helpText, paintHelp, verbHelpText, wrapHelp } from '../src/cli/help.js'
import { formatRunList, formatStats } from '../src/cli/last.js'
import { whatChangedSection } from '../src/cli/why.js'
import { paint, ui } from '../src/ui/index.js'

const node = (id: string): TaskNode => {
  const [projectName, taskName] = id.split('#')
  return { id, projectName, taskName, config: { exec: { command: 'x' } } } as unknown as TaskNode
}
const outcome = (id: string, status: TaskOutcome['status']): TaskOutcome =>
  ({
    node: node(id),
    status,
    exitCode: status === 'failed' ? 1 : 0,
    durationMs: 5,
  }) as TaskOutcome
const CONTEXT = {
  version: '1.2.3',
  packageCount: 3,
  concurrency: 4,
  remoteCacheEnabled: false,
  workspaceProjectCount: 7,
}
const footer = (columns?: number): string[] =>
  formatRunSummary(
    [outcome('a#build', 'success'), outcome('b#build', 'failed'), outcome('c#build', 'success')],
    1234,
    columns === undefined ? { enabled: false } : { enabled: false, columns },
    CONTEXT,
  )
/** Bars and the title line: the rows padded to a width, with no words to wrap. */
const furniture = (lines: string[]): string[] => lines.filter((l) => /[▰▱]|^ {2}Summary/.test(l))

describe('on a terminal narrower than the footer', () => {
  it.each([20, 40, 50, 61])('every bar and rule fits %i columns', (columns) => {
    const rows = furniture(footer(columns))
    expect(rows.length).toBe(4)
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(columns)
  })

  it.each([20, 40])('a failed task frame’s section rule fits %i columns too', (columns) => {
    const block = formatTaskBlock(
      node('b#build'),
      outcome('b#build', 'failed'),
      { output: [{ text: 'boom\n', err: true }] },
      { enabled: false, columns },
    )
    const rules = block.split('\n').filter((l) => l.startsWith('├─'))
    expect(rules.length).toBe(1)
    expect(rules[0]!.length).toBeLessThanOrEqual(columns)
  })

  it('CONTROL: off a terminal and on a wide one the bars keep their 62 columns', () => {
    // The title line spans the terminal (120 off one), so its note sits flush right past a task's name.
    for (const [lines, width] of [
      [footer(), 120],
      [footer(200), 200],
    ] as const) {
      const rows = furniture(lines)
      expect(rows[0]).toBe('  Summary' + ' '.repeat(width - 17) + 'vx 1.2.3')
      for (const row of rows.slice(1)) expect(row.length).toBe(62)
    }
  })

  // One frame width: a task frame's section rule ran two columns short of
  // the footer's rule and bars under it (60 against 62).
  it.each([undefined, 40, 61, 200])(
    'a frame’s section rule is as wide as the footer’s (%p)',
    (columns) => {
      const colors = columns === undefined ? { enabled: false } : { enabled: false, columns }
      const block = formatTaskBlock(
        node('b#build'),
        outcome('b#build', 'failed'),
        { output: [{ text: 'boom\n', err: true }] },
        colors,
      )
      const rule = block.split('\n').find((l) => l.startsWith('├─'))!
      expect(rule.length).toBe(furniture(footer(columns))[1]!.length)
    },
  )

  // The footer's words broke where the terminal did: `6 tot|al`, a run id in
  // two. A value now breaks between its `·` parts, each line under the first.
  const wordy = (columns?: number): string[] =>
    formatRunSummary(
      [outcome('a#build', 'success'), outcome('b#build', 'failed'), outcome('c#build', 'skipped')],
      1234,
      columns === undefined ? { enabled: false } : { enabled: false, columns },
      { ...CONTEXT, runId: '01a20842-c687-7468-9a61-298f70fa4b7f' },
    )

  it('a footer value breaks between its parts at 40 columns', () => {
    const lines = wordy(40)
    const at = (start: string): number => lines.findIndex((l) => l.startsWith(start))
    const tasks = at('            1 failed')
    expect(lines.slice(tasks, tasks + 2)).toEqual([
      '            1 failed · 1 success',
      '            1 skipped · 3 total',
    ])
    expect(lines.slice(at('  info'), at('  info') + 2)).toEqual([
      '  info      4 workers · local cache',
      '            run 01a20842-c687-7468-9a61-298f70fa4b7f',
    ])
  })

  it('CONTROL: off a terminal a footer value stays on one line', () => {
    const lines = wordy()
    expect(lines).toContain('            1 failed · 1 success · 1 skipped · 3 total')
    expect(lines).toContain(
      '  info      4 workers · local cache · run 01a20842-c687-7468-9a61-298f70fa4b7f',
    )
  })
})

// `vx run --affected --dry` puts why a task was kept beside its row: up to
// 134 columns, so a 60-column terminal wrapped it into the next row.
describe('a dry plan row with a reason, on a narrow terminal', () => {
  const note = 'affected: packages/lib/src/index.ts changed (an input), via lib#build'
  const plan = (columns?: number): string[] =>
    planList([
      {
        node: node('app#build'),
        status: 'run',
        tone: 'info',
        cache: 'miss',
        cacheTone: 'muted',
        blocks: 0,
        worker: 'local',
        note,
      } as unknown as Parameters<typeof planList>[0][number],
    ]).lines(columns === undefined ? { enabled: false } : { enabled: false, columns })

  it('goes on its own line: under the task name where it fits, else at the gutter', () => {
    const wide = plan(165)
    expect(wide.length).toBe(2)
    expect(wide[0]!.trimEnd().endsWith('app#build')).toBe(true)
    expect(wide[1]!.indexOf(note)).toBe(wide[0]!.indexOf('app#build'))
    expect(wide[1]!.length).toBeLessThanOrEqual(165)
    const narrow = plan(60)
    expect(narrow.length).toBe(2)
    expect(narrow[1]).toBe(`${' '.repeat(12)}${note}`)
  })

  it('CONTROL: off a terminal, and on a wide one, it stays beside the row', () => {
    for (const lines of [plan(), plan(200)]) {
      expect(lines.length).toBe(1)
      expect(lines[0]!.endsWith(`app#build  ${note}`)).toBe(true)
    }
  })
})

// `vx why`'s "What changed" row printed two whole 40-char git ids: a
// 60-column terminal broke it mid-hash. There they are cut to 12, as git
// cuts one; off a terminal they stay whole.
describe("vx why's What changed table, on a narrow terminal", () => {
  const a = 'a'.repeat(40)
  const b = 'b'.repeat(40)
  const table = (columns?: number): string[] =>
    whatChangedSection({
      runId: 'r',
      taskId: 'app#build',
      found: true,
      previousRunId: 'p',
      entries: [{ change: 'changed', kind: 'file', name: 'src/index.ts', before: a, after: b }],
      unchangedCount: 3,
      note: '',
    } as Parameters<typeof whatChangedSection>[0]).lines(
      columns === undefined ? { enabled: false } : { enabled: false, columns },
    )

  it('cuts each hash to 12 and fits 60 columns', () => {
    const lines = table(60)
    const row = lines.find((l) => l.includes('src/index.ts'))!
    expect(row).toContain(`${a.slice(0, 12)} → ${b.slice(0, 12)}`)
    expect(row).not.toContain(a)
    for (const l of lines) expect(Bun.stringWidth(l)).toBeLessThanOrEqual(60)
  })

  it('CONTROL: off a terminal, and on a wide one, both stay whole', () => {
    for (const lines of [table(), table(200)])
      expect(lines.find((l) => l.includes('src/index.ts'))).toContain(`${a} → ${b}`)
  })
})

// `vx last` drew a failed task's `exit 3` (or why it was skipped) beside its
// row: a 60-column terminal wrapped it into the next row. It goes on its own
// line there, as a `--dry` reason does.
describe("vx last's task row with a note, on a narrow terminal", () => {
  const recorded = {
    project: 'packages/app',
    task: 'build',
    status: 'failed',
    durationMs: 12,
    cacheHit: false,
    restored: null,
    cached: false,
    cpuMs: null,
    peakRssBytes: null,
    placement: null,
    outputBytes: null,
    blocks: null,
  }
  const rows = (columns?: number): string[] =>
    taskList([(c) => formatRecordedRow(recorded, c, 'exit 3')]).lines(
      columns === undefined ? { enabled: false } : { enabled: false, columns },
    )

  it('goes under the task name and every line fits 60 columns', () => {
    const lines = rows(60).flatMap((l) => l.split('\n'))
    expect(lines.length).toBe(2)
    expect(lines[0]!.trimEnd().endsWith('packages/app#build')).toBe(true)
    expect(lines[1]!.indexOf('exit 3')).toBe(lines[0]!.indexOf('packages/app#build'))
    for (const l of lines) expect(Bun.stringWidth(l)).toBeLessThanOrEqual(60)
  })

  it('CONTROL: off a terminal, and on a wide one, it stays beside the row', () => {
    for (const lines of [rows(), rows(200)]) {
      expect(lines.length).toBe(1)
      expect(lines[0]!.endsWith('packages/app#build  exit 3')).toBe(true)
    }
  })
})

// A refused config's source frame printed its lines whole: a 60-column
// terminal wrapped a long config line, and the caret under it landed on
// the wrong character or a row of its own. On a terminal each line now
// shows the window around the caret, `…` where it was cut.
describe("a refusal's source frame, on a narrow terminal", () => {
  const line = `export default { tasks: { build: { exec: { command: 'tsc -p .' }, inputs: { files: ['src/**'] }, outputs: ['dist/**'] } } }`
  const col = line.indexOf("outputs: ['") + 1
  const frame = `> 1 | ${line}\n    | ${' '.repeat(col - 1)}^`
  const draw = (columns?: number): string[] =>
    ui.code(frame).lines(columns === undefined ? { enabled: false } : { enabled: false, columns })

  it.each([40, 60, 80])('fits %i columns with the caret under its character', (columns) => {
    const [src, caret] = draw(columns)
    for (const l of [src!, caret!]) expect(Bun.stringWidth(l)).toBeLessThanOrEqual(columns)
    expect(src!.slice(caret!.indexOf('^')).startsWith('outputs')).toBe(true)
    expect(src).toContain('…')
  })

  it('keeps the caret under its character past wide ones', () => {
    const wide = `const 名前 = '${'名'.repeat(30)}'; export default { tasks: { 構築: { outputs: [] } } }`
    const at = wide.indexOf('outputs')
    const lead = Bun.stringWidth(wide.slice(0, at))
    for (const columns of [40, 41, 60]) {
      const [src, caret] = ui
        .code(`> 1 | ${wide}\n    | ${' '.repeat(lead)}^`)
        .lines({ enabled: false, columns })
      expect(Bun.stringWidth(src!)).toBeLessThanOrEqual(columns)
      const before = Bun.stringWidth(caret!.slice(0, caret!.indexOf('^')))
      let w = 0
      let under = ''
      for (const ch of src!) {
        if (w === before) under = ch
        w += Bun.stringWidth(ch)
      }
      expect(under).toBe('o')
    }
  })

  it('CONTROL: off a terminal, and on a wide one, the line stays whole', () => {
    for (const lines of [draw(), draw(200)])
      expect(lines).toEqual([`  > 1 | ${line}`, `      | ${' '.repeat(col - 1)}^`])
  })
})

// On a colour terminal the frame was the one block of a refusal with no
// colour at all: vx's gutter now reads dim and the caret red, as the
// headline's mark; the source between stays the user's own text.
describe("a refusal's source frame, in colour", () => {
  const on = { enabled: true }
  const frame = '> 1 | export default { tasks: 1 }\n    |                 ^'

  it('dims the gutter and paints the caret', () => {
    const [src, caret] = ui.code(frame).lines(on)
    expect(src).toBe(`  ${paint('muted', '> 1 |', on)} export default { tasks: 1 }`)
    expect(caret).toBe(
      `  ${paint('muted', '    |', on)} ${' '.repeat(16)}${paint('error', '^', on)}`,
    )
  })

  it('CONTROL: off colour the frame is as written', () => {
    expect(ui.code(frame).lines({ enabled: false })).toEqual(frame.split('\n').map((l) => `  ${l}`))
  })
})

// A failed frame's edges, `┌─ <id> > failed (exit 1)` and `└─ <id> ── (12.35s)
// failed (exit 1)`, wrapped at 60 columns once the id ran past ~40. On a
// terminal the edges cut the project's name in the middle; the body keeps
// the whole id.
describe("a frame's edges with a long task id, on a narrow terminal", () => {
  const id = '@acme/very-long-package-name-here#typecheck.strict'
  const block = (columns?: number): string[] =>
    formatTaskBlock(
      node(id),
      { ...outcome(id, 'failed'), durationMs: 12345 },
      { output: [{ text: 'boom\n', err: true }] },
      columns === undefined ? { enabled: false } : { enabled: false, columns },
    ).split('\n')
  const edges = (lines: string[]): string[] => lines.filter((l) => /^[┌└]─/.test(l))

  it.each([50, 60])('both edges fit %i columns and the body names the whole id', (columns) => {
    const lines = block(columns)
    expect(edges(lines).length).toBe(2)
    for (const e of edges(lines)) {
      expect(Bun.stringWidth(e)).toBeLessThanOrEqual(columns)
      expect(e).toContain('…')
      // At 50 the task's name gives way too.
      if (columns === 60) expect(e).toContain('#typecheck.strict')
    }
    expect(lines.filter((l) => l === id).length).toBe(1)
  })

  it("a focused frame's closing edge fits 60 columns too", () => {
    const close = formatFrameClose(
      node(id),
      { ...outcome(id, 'failed'), durationMs: 12345 },
      { enabled: false, columns: 60 },
    )
    expect(Bun.stringWidth(close)).toBeLessThanOrEqual(60)
    expect(close).toContain('…-here#typecheck.strict')
    expect(formatFrameClose(node(id), outcome(id, 'failed'))).toContain(id)
  })

  it('CONTROL: off a terminal, and on a wide one, the edges carry the whole id', () => {
    for (const lines of [block(), block(200)]) {
      for (const e of edges(lines)) expect(e).toContain(id)
      expect(lines).not.toContain(id)
    }
  })
})

// At 50 columns the grid had dropped every optional column and a row was
// still 57 wide: status, cache and time leave a name 11 columns. On a
// terminal the name now gives way in its middle, colours kept.
describe('a task row at 50 columns', () => {
  const id = 'packages/app#build'
  const row = (colors: { enabled: boolean; columns?: number }): string =>
    formatTaskExecutedLine(node(id), outcome(id, 'failed'), colors)

  it.each([40, 50])('fits %i columns, the name cut in its middle', (columns) => {
    for (const enabled of [false, true]) {
      const r = row({ enabled, columns })
      expect(Bun.stringWidth(r)).toBeLessThanOrEqual(columns)
      // At 40 the name has one column: only the mark.
      expect(Bun.stripANSI(r)).toMatch(columns === 50 ? /pa.*….*ld$/ : /…$/)
    }
    expect(Bun.stripANSI(row({ enabled: true, columns: 50 }))).toBe(
      row({ enabled: false, columns: 50 }),
    )
    expect(formatListHeader({ enabled: false, columns }).length + 2).toBeLessThanOrEqual(columns)
  })

  it('CONTROL: at 60 and off a terminal the name stays whole', () => {
    for (const colors of [{ enabled: false }, { enabled: false, columns: 60 }])
      expect(row(colors).endsWith(` ${id}`)).toBe(true)
  })
})

// `vx last --list` drew a 93-109 column grid: a 60-column terminal wrapped
// every run. There `when` drops, then the counts, and a command that does
// not fit beside its row goes under it, as a --dry reason does.
describe('vx last --list on a narrow terminal', () => {
  const run = (o: { failedCount?: number; hitCount?: number; command?: string } = {}) => ({
    inv: {
      exitOk: (o.failedCount ?? 0) === 0,
      startedAt: Date.UTC(2026, 10, 23, 22, 4, 41, 788),
      taskCount: 3,
      failedCount: o.failedCount ?? 0,
      totalDurationMs: 52,
      command: o.command ?? 'vx run build warn --all',
      hitCount: o.hitCount ?? 0,
      upToDateCount: o.hitCount ?? 0,
      restoredLocalCount: 0,
      restoredRemoteCount: 0,
    },
    id: '01a20a70-9bb8',
  })
  const list = (columns?: number, runs = [run({ failedCount: 1 }), run()]): string[] =>
    formatRunList(runs).lines(
      columns === undefined ? { enabled: false } : { enabled: false, columns },
    )

  it.each([50, 60, 80])('every line fits %i columns and keeps status, run and time', (columns) => {
    const lines = list(columns, [
      run({ failedCount: 1, command: 'vx run build lint test typecheck --all' }),
      run(),
    ])
    for (const l of lines) expect(Bun.stringWidth(l)).toBeLessThanOrEqual(columns)
    expect(lines[0]).not.toContain('when')
    const failed = lines.findIndex((l) => l.includes('FAILED'))
    expect(lines[failed]).toContain('01a20a70-9bb8')
    expect(lines[failed]).toContain('52ms')
    expect(lines.some((l) => l.trim() === 'vx run build lint test typecheck --all')).toBe(true)
  })

  it('at 70 the counts stay, and a command that fits stays beside', () => {
    const lines = list(70, [run({ failedCount: 1, command: 'vx' })])
    expect(lines[1]).toContain('3 tasks · 0 hits · 1 failed')
    expect(lines[1]!.endsWith('52ms  vx')).toBe(true)
  })

  it('CONTROL: off a terminal, and on a wide one, every column on one line', () => {
    for (const lines of [list(), list(200)]) {
      expect(lines[0]).toContain('when')
      expect(lines.length).toBe(3)
      expect(lines[1]).toContain('2026-11-23T22:04:41.788Z')
      expect(lines[1]!.endsWith('vx run build warn --all')).toBe(true)
    }
  })
})

// `vx last --stats` drew a 78-column grid of nine columns: a 60-column
// terminal wrapped each task. There cpu, peak rss, p99, hit, failure mode
// and runs go in that order; the task, p50 and pass rate stay.
describe('vx last --stats on a narrow terminal', () => {
  const row = (taskId: string) => ({
    taskId,
    runs: 2,
    p50DurationMs: 23,
    p99DurationMs: 23,
    successRate: 1,
    hitRate: 0,
    failureMode: 'stable' as const,
    maxPeakRssBytes: 1.9 * 1024 * 1024,
    maxCpuParallelism: 0.11,
  })
  const table = (columns?: number): string[] =>
    formatStats([row('packages/app#build'), row('packages/lib#warn')]).lines(
      columns === undefined ? { enabled: false } : { enabled: false, columns },
    )

  it.each([40, 50, 60])('fits %i columns, keeping task, p50 and pass', (columns) => {
    const lines = table(columns)
    for (const l of lines) expect(Bun.stringWidth(l)).toBeLessThanOrEqual(columns)
    expect(lines[0]).toMatch(/task .*p50 +pass/)
    expect(lines[0]).not.toContain('cpu')
    expect(lines[0]).not.toContain('p99')
  })

  it('CONTROL: off a terminal, and on a wide one, every column', () => {
    for (const lines of [table(), table(200)])
      expect(lines[0]).toMatch(/task +runs +p50 +p99 +pass +hit +failure mode +peak rss +cpu/)
  })
})

// `vx help` and `vx <verb> --help` are written at about 80 columns: a
// 60-column terminal broke their lines mid-word, and a few ran to 88. On a
// terminal each line now wraps at a space to the width, at most 80, its
// continuation under the description; piped it stays as written.
describe('help on a narrow terminal', () => {
  const words = (s: string): string[] => Bun.stripANSI(s).split(/\s+/).filter(Boolean)

  it.each([50, 60, 200])('fits min(%i, 80) columns and keeps every word', (columns) => {
    for (const text of [helpText(), verbHelpText('run')]) {
      for (const enabled of [false, true]) {
        const out = paintHelp(wrapHelp(text, columns), { enabled }, paint)
        // A URL wider than the terminal stays whole, alone on its line:
        // split, it would no longer open.
        for (const l of out.split('\n'))
          if (words(l).length > 1 || !/^\(?https?:/.test(words(l)[0] ?? ''))
            expect(Bun.stringWidth(l)).toBeLessThanOrEqual(Math.min(columns, 80))
        expect(words(out)).toEqual(words(text))
      }
    }
  })

  // At 60 columns the Usage list ran together into one paragraph: each
  // `vx <verb> …` line took the next as its continuation.
  it.each([60, 80])(
    'at %i columns each usage line stays its own, wrapped under its verb',
    (columns) => {
      const usage = (t: string): string[] => {
        const block = t.split('\n\n').find((b) => b.startsWith('Usage:'))!
        return block.split('\n').slice(1)
      }
      const verbs = usage(helpText()).map((l) => /^ {2}vx (\S+)/.exec(l)![1]!)
      for (const text of [helpText(), ...verbs.map((v) => verbHelpText(v))]) {
        const out = usage(wrapHelp(text, columns))
        for (const l of out) {
          expect(Bun.stringWidth(l)).toBeLessThanOrEqual(columns)
          expect(l).toMatch(/^ {2}vx \S|^ {5}\S/)
        }
        const heads = out.filter((l) => l.startsWith('  vx '))
        expect(heads.length).toBe(usage(text).length)
        heads.forEach((h, n) => expect(usage(text)[n]!.startsWith(h)).toBe(true))
        expect(words(out.join(' '))).toEqual(words(usage(text).join(' ')))
      }
    },
  )

  it('a wrapped description continues under its description column', () => {
    const out = wrapHelp(verbHelpText('run'), 60).split('\n')
    const at = out.findIndex((l) => l.startsWith('      --all '))
    const col = out[at]!.indexOf('Run task')
    expect(out[at + 1]!.length - out[at + 1]!.trimStart().length).toBe(col)
  })

  it('CONTROL: off a terminal the text is as written', () => {
    expect(wrapHelp(helpText(), undefined)).toBe(helpText())
  })
})
