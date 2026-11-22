import { expect, test } from 'bun:test'
import { mergeResults, scores, scoreTable, type Results } from '../src/report.ts'

const rows: Results['cases'] = [
  {
    id: 'inputs/x',
    ref: 'aaaaaa',
    category: 'inputs',
    kind: 'correctness',
    title: 'X',
    why: 'Because.',
    from: [],
    outcomes: { a: { status: 'fail', detail: 'no' }, b: { status: 'pass' } },
  },
  {
    id: 'report/y',
    ref: 'bbbbbb',
    category: 'report',
    kind: 'data',
    title: 'Y',
    why: 'Because.',
    from: [],
    outcomes: { a: { status: 'pass' }, b: { status: 'n/a' } },
  },
]

test('a score counts every case, and how many the tool can express', () => {
  const s = scores(['a', 'b'], rows)
  expect(s['a']).toEqual({
    all: { pass: 1, can: 2, of: 2 },
    correctness: { pass: 0, can: 1, of: 1 },
    data: { pass: 1, can: 1, of: 1 },
    inputs: { pass: 0, can: 1, of: 1 },
    report: { pass: 1, can: 1, of: 1 },
  })
  expect(s['b']!['report']).toEqual({ pass: 0, can: 0, of: 1 })
  expect(scoreTable({ tools: { a: '1', b: '2' }, scores: s })).toContain(
    '| all | 50% (1/2), supports 100% | 50% (1/2), supports 50% |',
  )
})

test('a score rounds down: only a clean sweep reads 100%', () => {
  const all = { pass: 996, can: 999, of: 1000 }
  expect(scoreTable({ tools: { a: '1' }, scores: { a: { all } } })).toContain(
    '| all | 99% (996/1000), supports 99% |',
  )
})

test('an exact share keeps its point', () => {
  const all = { pass: 29, can: 100, of: 100 }
  expect(scoreTable({ tools: { a: '1' }, scores: { a: { all } } })).toContain(
    '| all | 29% (29/100), supports 100% |',
  )
})

// A sharded CI run: each job one tool and every nth case; the merge is the run.
test('shards merge into one run, each case in the suite order with every tool', () => {
  const part = (tool: string, ids: string[]): Results => ({
    coverage: {} as Results['coverage'],
    tools: { [tool]: '1' },
    scores: {},
    cases: rows
      .filter((r) => ids.includes(r.id))
      .map((r) => ({ ...r, outcomes: { [tool]: r.outcomes[tool]! } })),
  })
  const merged = mergeResults(
    [part('b', ['report/y']), part('a', ['report/y', 'inputs/x']), part('b', ['inputs/x'])],
    ['inputs/x', 'report/y'],
  )
  expect(merged.cases.map((c) => c.id)).toEqual(['inputs/x', 'report/y'])
  expect(merged.cases.map((c) => c.outcomes)).toEqual(rows.map((r) => r.outcomes))
  expect(merged.scores).toEqual(scores(['b', 'a'], rows))
})
