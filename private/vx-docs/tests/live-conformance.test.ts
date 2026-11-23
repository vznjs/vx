import { expect, it } from 'bun:test'
import { merge } from '../scripts/live-conformance.js'
import type { Case, Results } from '../src/conformance/data.js'

const row = (id: string, outcomes: Record<string, 'pass' | 'fail' | 'n/a'>): Case => ({
  id,
  ref: id,
  category: 'cache',
  kind: 'correctness',
  title: `title ${id}`,
  why: `why ${id}`,
  from: [],
  outcomes: Object.fromEntries(Object.entries(outcomes).map(([t, status]) => [t, { status }])),
})

const results = (tools: Record<string, string>, cases: Case[]): Results => ({
  coverage: { ported: 1, rest: {}, verdicts: {} },
  tools,
  scores: {},
  cases,
})

// The deploy shows the rivals as the newest weekly run scored them, at
// their latest releases (2026-11-21), and vx as the commit's own column.
it('takes the rivals and their versions from the weekly run, vx and new cases from the commit', () => {
  const committed = results({ vx: 'this commit', turbo: '2.11.10' }, [
    row('a', { vx: 'pass', turbo: 'pass' }),
    row('b', { vx: 'pass', turbo: 'fail' }),
    row('new', { vx: 'pass', turbo: 'n/a' }),
  ])
  const weekly = results({ vx: 'this commit', turbo: '2.11.13' }, [
    row('a', { vx: 'fail', turbo: 'fail' }),
    row('b', { vx: 'pass', turbo: 'pass' }),
    row('gone', { vx: 'pass', turbo: 'pass' }),
  ])
  const live = merge(committed, weekly)
  expect(live.tools).toEqual({ vx: 'this commit', turbo: '2.11.13' })
  expect(
    live.cases.map((c) => [c.id, c.outcomes['vx']!.status, c.outcomes['turbo']!.status]),
  ).toEqual([
    ['a', 'pass', 'fail'],
    ['b', 'pass', 'pass'],
    ['new', 'pass', 'n/a'],
  ])
  expect(live.cases[0]!.title).toBe('title a')
  expect(live.scores['turbo']!['all']).toEqual({ pass: 1, can: 2, of: 3 })
  expect(live.scores['vx']!['cache']).toEqual({ pass: 3, can: 3, of: 3 })
})

// A feature the adapter now lacks is N/A at once, without a rerun (2026-11-23).
it('keeps a rival’s committed N/A over the weekly run’s outcome', () => {
  const committed = results({ vx: 'this commit', turbo: '2.11.10' }, [
    row('a', { vx: 'pass', turbo: 'n/a' }),
  ])
  const weekly = results({ vx: 'this commit', turbo: '2.11.13' }, [
    row('a', { vx: 'pass', turbo: 'fail' }),
  ])
  expect(merge(committed, weekly).cases[0]!.outcomes['turbo']!.status).toBe('n/a')
})
