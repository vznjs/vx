import { expect, it } from 'bun:test'
import raw from '../src/data/bench.json'
import type { BenchData } from '../src/bench/format.ts'
import { worse } from '../src/bench/gate.ts'

const live = raw as unknown as BenchData
const variant = (vx: Partial<BenchData['runners']['vx']['row']>, turbo = {}): BenchData => ({
  ...live,
  runners: {
    ...live.runners,
    vx: { ...live.runners.vx, row: { ...live.runners.vx.row, ...vx } },
    turbo: { ...live.runners.turbo, row: { ...live.runners.turbo.row, ...turbo } },
  },
})

it('publishes a run that shows vx no worse against Turbo', () => {
  expect(worse(live, live)).toEqual([])
  expect(worse(live, variant({ warmNoRestore: live.runners.vx.row.warmNoRestore - 1 }))).toEqual([])
})

it('keeps the live numbers when any figure shows vx worse against Turbo', () => {
  const vx = live.runners.vx.row
  expect(worse(live, variant({ warmRestore: vx.warmRestore + 1 }))).toEqual(['restore'])
  expect(worse(live, variant({ fresh: vx.fresh + 1, freshCpu: vx.freshCpu + 1 }))).toEqual([
    'cold',
    'cpu',
  ])
})

it('judges vx against Turbo, not alone: a slower machine slows both', () => {
  const vx = live.runners.vx.row
  const t = live.runners.turbo.row
  expect(
    worse(
      live,
      variant({ warmNoRestore: vx.warmNoRestore * 1.5 }, { warmNoRestore: t.warmNoRestore * 1.5 }),
    ),
  ).toEqual([])
})
