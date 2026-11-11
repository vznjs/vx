import { expect, test } from 'bun:test'
import { scores, scoreTable, type Results } from '../src/report.ts'

const rows: Results['cases'] = [
  {
    id: 'inputs/x',
    category: 'inputs',
    kind: 'correctness',
    title: 'X',
    why: 'Because.',
    from: [],
    outcomes: { a: { status: 'fail', detail: 'no' }, b: { status: 'pass' } },
  },
  {
    id: 'report/y',
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
