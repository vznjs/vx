// The site never shows a vx figure worse than the one it shows now: the
// Bench job publishes a measured run only when no vx overhead in it is
// above the live site's, and otherwise keeps the live numbers.
import { describe, expect, it } from 'bun:test'
import { worse } from '../src/bench/hold.ts'
import type { BenchData } from '../src/bench/format.ts'
import committed from '../src/data/bench.json'

const live = committed as unknown as BenchData
const withVx = (patch: Partial<BenchData['runners']['vx']['row']>): BenchData => ({
  ...live,
  runners: {
    ...live.runners,
    vx: { ...live.runners.vx, row: { ...live.runners.vx.row, ...patch } },
  },
})

describe('holding the site to its vx numbers', () => {
  it('finds nothing worse in the same run', () => {
    expect(worse(live, live)).toEqual([])
  })

  it('names each vx overhead the measured run is above the live one on', () => {
    const r = live.runners.vx.row
    expect(worse(withVx({ fresh: r.fresh + 1, warmRestore: r.warmRestore + 1 }), live)).toEqual([
      'restore',
      'cold',
    ])
    expect(
      worse(withVx({ warmNoRestore: r.warmNoRestore + 1, freshCpu: r.freshCpu + 1 }), live),
    ).toEqual(['warm', 'cpu'])
  })

  it('takes a better vx run, whatever the rivals read', () => {
    const r = live.runners.vx.row
    const better = withVx({ fresh: r.fresh - 1 })
    const turbo = { ...live.runners.turbo, row: { ...live.runners.turbo.row, fresh: 1 } }
    expect(worse({ ...better, runners: { ...better.runners, turbo } }, live)).toEqual([])
  })

  it('compares overhead, so a lower ideal does not hide a slower vx', () => {
    const vx = live.runners.vx
    const measured: BenchData = {
      ...live,
      runners: {
        ...live.runners,
        vx: {
          ...vx,
          baseline: { ...vx.baseline, fresh: vx.baseline.fresh - 1000 },
          row: { ...vx.row, fresh: vx.row.fresh - 500 },
        },
      },
    }
    expect(worse(measured, live)).toEqual(['cold'])
  })
})
