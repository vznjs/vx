import { expect, it } from 'bun:test'
import {
  baseFails,
  HELD,
  SIGNIFICANCE,
  SITE_ARMS,
  tailAtLeast,
  rivalFails,
  CPU_HELD,
  RIVALS,
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

// vx is the best of all runners in every case (2026-11-01): slower than
// any rival fails, and so does more CPU than any but Vite Task, whose one
// process per run does less than a shell per task.
it('fails a case vx is slower than any rival in, or uses more CPU than Turbo or Nx in', () => {
  const t = (ms: number, cpuMs: number) => ({ ms, cpuMs })
  const vs = (vx: ReturnType<typeof t>, rival: ReturnType<typeof t>) => ({ vx, rival })
  const best = {
    cold: {
      turbo: vs(t(1000, 900), t(1100, 1000)),
      nx: vs(t(1000, 900), t(9000, 800)),
      'vite-task': vs(t(1000, 900), t(990, 100)),
    },
    noop: {
      turbo: vs(t(500, 600), t(600, 700)),
      nx: vs(t(80, 90), t(9000, 9000)),
      'vite-task': vs(t(80, 90), t(9000, 50)),
    },
  }
  expect(rivalFails(best, ['cold', 'noop'])).toEqual([
    'cold: vx 900 ms CPU against Nx 800 ms: vx uses more CPU than Nx',
    'cold: vx 1000 ms against Vite Task 990 ms: vx is slower than Vite Task',
  ])
  expect(RIVALS).toEqual(['turbo', 'nx', 'vite-task'])
  expect(CPU_HELD).toEqual(['turbo', 'nx'])
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
