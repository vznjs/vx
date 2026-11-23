// The real-repos page prints private/vx-bench/real-repos.json's native
// rows through `%bench.real.…%` tokens (src/bench/real.ts): each cell
// is the measured time alone (no percentage or multiple), and a row timed
// through turbo() / nx() is never quoted (STATUS, Positioning).
import { describe, expect, it } from 'bun:test'
import { realFigures, type RealRow } from '../src/bench/real.ts'

const row = (over: Partial<RealRow>): RealRow => ({
  repo: 'solidjs/solid',
  tool: 'Turbo',
  version: '2.10.10',
  commit: 'b25c557754f2ced0d86490e6dbfded9b1745b663',
  machine: 'linux x64, 4 cores',
  setup: 'native config, `private/vx-bench/real/solid/`',
  date: '2026-11-10',
  cold: ['36.0 s', '40.0 s'],
  restore: ['121 ms', '**73 ms**'],
  noop: ['90 ms', '**67 ms**'],
  ...over,
})

describe('real-repo figures', () => {
  it('fills each arm with its bare time, and the run’s provenance', () => {
    const f = realFigures([row({})])
    expect(f.get('real.solid.cold.vx')).toBe('36.0 s')
    expect(f.get('real.solid.cold.rival')).toBe('40.0 s')
    expect(f.get('real.solid.noop.rival')).toBe('67 ms')
    expect(f.get('real.solid.rival')).toBe('Turbo')
    expect(f.get('real.solid.tool')).toBe('Turbo 2.10.10')
    expect(f.get('real.solid.commit')).toBe('b25c557')
    expect(f.get('real.solid.machine')).toBe('linux x64, 4 cores')
    expect(f.get('real.solid.date')).toBe('2026-11-10')
  })

  it('quotes no row timed through turbo() or nx()', () => {
    const f = realFigures([row({ repo: 'withastro/astro', setup: '`turbo()`, nothing written' })])
    expect(f.size).toBe(0)
  })

  it('refuses a cell that is no duration', () => {
    expect(() => realFigures([row({ cold: ['fast', '40.0 s'] })])).toThrow('not a duration')
  })
})
