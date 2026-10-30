import { expect, it } from 'bun:test'
import { BASE_TOLERANCE, baseFails } from '../pr-bench-base.js'
import config from '../vx.config.js'

// 10-25 to 10-29: the per-PR bench held vx only to Turbo, at 1.3× its
// recorded ratio, so a run that grew slower than main by a fifth passed.
// A held arm is now also held to the base commit's vx, timed in the same job.
it('fails a held arm whose time grew past the tolerance over the base', () => {
  const best = { noop: { vx: 120, base: 100 }, restore: { vx: 105, base: 100 } }
  expect(baseFails(best, ['noop', 'restore'])).toEqual([
    `noop: vx 120 ms against the base's 100 ms, past ${BASE_TOLERANCE}× it`,
  ])
})

it('holds nothing to a base the job did not time', () => {
  expect(baseFails({ noop: { vx: 500 } }, ['noop'])).toEqual([])
})

it('passes the base commit to the bench and keys the check on it', () => {
  const task = config.tasks?.['check.perf']
  expect(task?.exec?.env?.passThrough).toContain('VX_BENCH_BASE')
  expect(task?.inputs?.env).toContain('VX_BENCH_BASE')
})
