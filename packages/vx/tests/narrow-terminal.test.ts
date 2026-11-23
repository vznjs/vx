// A terminal narrower than the footer (a VS Code side panel is ~50-60
// columns) wrapped every bar and rule onto a second row: the bars were a
// fixed 50 cells and the rules 60-62 columns. On a terminal they now fit
// its width; off one (a CI log) they keep their fixed width.

import { describe, expect, it } from 'bun:test'
import type { TaskOutcome } from '../src/graph/outcome.js'
import type { TaskNode } from '../src/graph/task-graph.js'
import { formatTaskBlock, planList } from '../src/report/framed-output.js'
import { formatRunSummary } from '../src/report/summary.js'

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
  it.each([40, 50, 61])('every bar and rule fits %i columns', (columns) => {
    const rows = furniture(footer(columns))
    expect(rows.length).toBe(4)
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(columns)
  })

  it('a failed task frame’s section rule fits too', () => {
    const block = formatTaskBlock(
      node('b#build'),
      outcome('b#build', 'failed'),
      { output: [{ text: 'boom\n', err: true }] },
      { enabled: false, columns: 40 },
    )
    const rules = block.split('\n').filter((l) => l.startsWith('├─'))
    expect(rules.length).toBe(1)
    expect(rules[0]!.length).toBeLessThanOrEqual(40)
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
