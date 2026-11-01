import { expect, it } from 'bun:test'
import {
  baseFails,
  HELD,
  SIGNIFICANCE,
  SITE_ARMS,
  tailAtLeast,
  turboFails,
  undecided,
} from '../pr-bench-base.js'
import config from '../vx.config.js'

// 10-25 to 10-29: the per-PR bench held vx only to Turbo, at 1.3× its
// recorded ratio, so a run that grew slower than main by a fifth passed.
// Then a 4% tolerance over the base let a regression land 3% at a time.
// Now no slack: vx slower than the base in more pairs than chance explains.
it('fails an arm slower than the base in more pairs than chance explains', () => {
  const pair = (vx: number, base: number) => ({ vx, base })
  const slow = Array.from({ length: 12 }, (_, i) => pair(103 + (i % 3), 100))
  const even = Array.from({ length: 12 }, (_, i) => pair(i % 2 === 0 ? 103 : 97, 100))
  expect(baseFails({ noop: slow, restore: even }, ['noop', 'restore'])).toEqual([
    `noop: vx slower than the base in 12 of 12 pairs (p ${tailAtLeast(12, 12).toPrecision(2)})`,
  ])
})

it('keeps timing an arm that leans slower than the base until it decides', () => {
  const pair = (vx: number, base: number) => ({ vx, base })
  expect(undecided([pair(101, 100), pair(102, 100), pair(99, 100)])).toBe(true)
  expect(undecided([pair(99, 100), pair(98, 100), pair(101, 100)])).toBe(false)
  expect(undecided(Array.from({ length: 12 }, () => pair(101, 100)))).toBe(false)
})

it('reads the binomial tail of a fair coin', () => {
  expect(tailAtLeast(0, 5)).toBe(1)
  expect(tailAtLeast(5, 5)).toBe(1 / 32)
  expect(tailAtLeast(4, 5)).toBe(6 / 32)
})

it('holds nothing to a base the job did not time', () => {
  expect(baseFails({ noop: [] }, ['noop'])).toEqual([])
})

it('passes the base commit to the bench and keys the check on it', () => {
  const task = config.tasks?.['check.perf']
  expect(task?.exec?.env?.passThrough).toContain('VX_BENCH_BASE')
  expect(task?.inputs?.env).toContain('VX_BENCH_BASE')
})

// vx is never slower than Turbo: a held arm vx lost was a printed LOSS that
// passed (cold 1.12, noop 1.14 recorded, 2026-10-12 to 11-01).
it('fails a held arm vx is slower than Turbo in', () => {
  const best = { cold: { vx: 1010, turbo: 1000 }, noop: { vx: 90, turbo: 100 } }
  expect(turboFails(best, ['cold', 'noop'])).toEqual([
    'cold: vx 1010 ms against Turbo 1000 ms: vx is slower than Turbo',
  ])
})

it('holds cold too, the overhead the site publishes', () => {
  expect(HELD).toEqual(['cold', 'restore', 'noop'])
})

// #4892 added 17-35 ms to every site run, 9,603 tasks, and passed: on the
// 100-package workspace it was noise. Restore and nothing-changed are timed
// where the site times them, with no task sleeping.
it('times restore and nothing-changed on the site workspace, with no task sleeping', () => {
  expect(SITE_ARMS).toEqual(['restore', 'noop'])
  expect(SIGNIFICANCE).toBeLessThan(0.01)
  expect(config.tasks?.['check.perf']?.exec?.env?.define?.BENCH_BUILD_MS).toBe('0')
})
