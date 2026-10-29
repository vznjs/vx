// turboCache() and nxCache() refuse a timeout they cannot wait on. A
// negative or non-number one made AbortSignal.timeout throw on every
// request (turbo), and a zero one aborted each as it started (nx; Turbo
// reads 0 as no deadline, so turboCache takes it) (stream F). Refused at
// the call, with no remote named, and a NaN named as NaN, not null.
import { expect, it } from 'bun:test'
import { nxCache } from '../src/nx-cache/index.js'
import { turboCache } from '../src/turbo-cache/index.js'
import { deadline } from '../src/remote-deadline.js'

const said = (make: () => unknown): string => {
  try {
    make()
    return 'taken'
  } catch (err) {
    return (err as Error).message
  }
}

it('turboCache refuses a negative or non-number timeout, and takes 0', () => {
  expect(said(() => turboCache({ timeoutMs: -1 }))).toBe(
    'turboCache() option "timeoutMs" must be ms ≥ 0 (0: none), got -1',
  )
  expect(said(() => turboCache({ uploadTimeoutMs: Number.NaN }))).toBe(
    'turboCache() option "uploadTimeoutMs" must be ms ≥ 0 (0: none), got NaN',
  )
  expect(said(() => turboCache({ uploadTimeoutMs: '60' } as never))).toBe(
    'turboCache() option "uploadTimeoutMs" must be a number, got "60"',
  )
  expect(said(() => turboCache({ timeoutMs: Number.NaN }))).toBe(
    'turboCache() option "timeoutMs" must be ms ≥ 0 (0: none), got NaN',
  )
  expect(said(() => turboCache({ timeoutMs: 0 }))).toBe('taken')
  expect(said(() => turboCache({ timeoutMs: 5000 }))).toBe('taken')
})

it('nxCache refuses a timeout that is not a positive number', () => {
  expect(said(() => nxCache({ timeoutMs: 0 }))).toBe(
    'nxCache() option "timeoutMs" must be a positive number of ms, got 0',
  )
  expect(said(() => nxCache({ timeoutMs: Number.NaN }))).toBe(
    'nxCache() option "timeoutMs" must be a positive number of ms, got NaN',
  )
  expect(said(() => nxCache({ timeoutMs: 5000 }))).toBe('taken')
})

// A timer past 2^31-1 ms fires after 1 ms: TURBO_REMOTE_CACHE_TIMEOUT=2592000
// (30 days) or nxCache({ timeoutMs: 3e9 }) aborted every request at once.
it('a deadline past the longest timer still waits', async () => {
  const long = deadline(3e9)
  const short = deadline(5)
  await Bun.sleep(40)
  expect([long.aborted, short.aborted]).toEqual([false, true])
})
