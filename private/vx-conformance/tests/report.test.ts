import { expect, test } from 'bun:test'
import { scores, scoreTable, type Results } from '../src/report.ts'

const rows: Results['cases'] = [
  {
    id: 'inputs/x',
    category: 'inputs',
    kind: 'correctness',
    title: 'X',
    from: [],
    outcomes: { a: { status: 'fail', detail: 'no' }, b: { status: 'pass' } },
  },
  {
    id: 'report/y',
    category: 'report',
    kind: 'data',
    title: 'Y',
    from: [],
    outcomes: { a: { status: 'pass' }, b: { status: 'n/a' } },
  },
]

test('a score counts only the cases a tool can express', () => {
  const s = scores(['a', 'b'], rows)
  expect(s['a']).toEqual({
    all: { pass: 1, of: 2 },
    correctness: { pass: 0, of: 1 },
    data: { pass: 1, of: 1 },
    inputs: { pass: 0, of: 1 },
    report: { pass: 1, of: 1 },
  })
  expect(s['b']!['report']).toEqual({ pass: 0, of: 0 })
  expect(scoreTable({ tools: { a: '1', b: '2' }, scores: s })).toContain(
    '| all | 50% (1/2) | 100% (1/1) |',
  )
})
