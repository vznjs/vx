// A terminal narrower than the footer (a VS Code side panel is ~50-60
// columns) wrapped every bar and rule onto a second row: the bars were a
// fixed 50 cells and the rules 60-62 columns. On a terminal they now fit
// its width; off one (a CI log) they keep their fixed width.

import { describe, expect, it } from 'bun:test'
import type { TaskOutcome } from '../src/graph/scheduler.js'
import type { TaskNode } from '../src/graph/task-graph.js'
import { formatTaskBlock } from '../src/report/framed-output.js'
import { formatRunSummary } from '../src/report/summary.js'

const node = (id: string): TaskNode => {
  const [projectName, taskName] = id.split('#')
  return { id, projectName, taskName, config: { exec: { command: 'x' } } } as unknown as TaskNode
}
const outcome = (id: string, status: TaskOutcome['status']): TaskOutcome => ({
  node: node(id),
  status,
  exitCode: status === 'failed' ? 1 : 0,
  durationMs: 5,
})
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
/** Bars and rules: the rows with no words to wrap. */
const furniture = (lines: string[]): string[] => lines.filter((l) => /[▰▱]|──/.test(l))

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

  it('CONTROL: off a terminal and on a wide one the footer keeps its 62 columns', () => {
    for (const lines of [footer(), footer(200)]) {
      const rows = furniture(lines)
      expect(rows[0]).toBe('─ vx 1.2.3 ' + '─'.repeat(51))
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
      expect(rule.length).toBe(furniture(footer(columns))[0]!.length)
    },
  )
})
