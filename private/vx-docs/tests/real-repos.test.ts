// The real-repos page prints private/vx-bench/real-repos.json's native
// rows through `%bench.real.…%` tokens (src/bench/real.ts): each rival
// cell carries the verdict the compare pages print, and a row timed
// through turbo() / nx() is never quoted (STATUS, Positioning).
import { describe, expect, it } from 'bun:test'
import { realFigures, verdict, type RealRow } from '../src/bench/real.ts'

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
  it('says how much faster or slower vx is: a percentage below 2×, N× from it', () => {
    expect(verdict('36.0 s', '40.0 s')).toBe('vx 11% faster')
    expect(verdict('121 ms', '**73 ms**')).toBe('vx 66% slower')
    expect(verdict('113 ms', '423 ms')).toBe('vx 3.7× faster')
    expect(verdict('278 ms', '**106 ms**')).toBe('vx 2.6× slower')
  })

  it('calls two figures within 2% of each other a tie, either way', () => {
    expect(verdict('75 ms', '75 ms')).toBe('tie')
    expect(verdict('97 ms', '98 ms')).toBe('tie')
    expect(verdict('100 ms', '102 ms')).toBe('tie')
    expect(verdict('102 ms', '100 ms')).toBe('tie')
    expect(verdict('100 ms', '103 ms')).toBe('vx 3% faster')
    const f = realFigures([row({ restore: ['75 ms', '75 ms'] })])
    expect(f.get('real.solid.restore.rival')).toBe('75 ms (tie)')
  })

  it('fills each arm, the rival cell with its verdict, and the run’s provenance', () => {
    const f = realFigures([row({})])
    expect(f.get('real.solid.cold.vx')).toBe('36.0 s')
    expect(f.get('real.solid.cold.rival')).toBe('40.0 s (vx 11% faster)')
    expect(f.get('real.solid.noop.rival')).toBe('67 ms (vx 34% slower)')
    expect(f.get('real.solid.rival')).toBe('Turborepo')
    expect(f.get('real.solid.tool')).toBe('Turborepo 2.10.10')
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
