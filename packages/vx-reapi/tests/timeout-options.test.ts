// The client's and the executor's deadlines refuse a value they cannot wait
// on: a zero, negative or non-number one, or one past the longest timer,
// ended every call, or stopped every action, the moment it began (stream F).
import { expect, it } from 'bun:test'
import { reapiExecutor } from '../src/executor.js'
import { ReapiClient } from '../src/wire.js'

const said = (make: () => unknown): string => {
  try {
    make()
    return 'taken'
  } catch (err) {
    return (err as Error).message
  }
}
const client = (o: Record<string, unknown>) => () =>
  new ReapiClient({ endpoint: 'grpc://127.0.0.1:1', ...o } as never)

it('a call or metadata deadline that is not a positive number is refused', () => {
  expect(said(client({ callTimeoutMs: 0 }))).toBe(
    'reapi(): callTimeoutMs must be a positive number of ms up to 2147483647 (got 0)',
  )
  expect(said(client({ metaTimeoutMs: -1 }))).toBe(
    'reapi(): metaTimeoutMs must be a positive number of ms up to 2147483647 (got -1)',
  )
  // JSON.stringify said NaN and Infinity as "null".
  expect(said(client({ callTimeoutMs: Number.NaN }))).toBe(
    'reapi(): callTimeoutMs must be a positive number of ms up to 2147483647 (got NaN)',
  )
  expect(said(client({ metaTimeoutMs: Number.POSITIVE_INFINITY }))).toBe(
    'reapi(): metaTimeoutMs must be a positive number of ms up to 2147483647 (got Infinity)',
  )
  expect(said(client({ callTimeoutMs: '5000' }))).toBe(
    'reapi(): callTimeoutMs must be a positive number of ms up to 2147483647 (got "5000")',
  )
  expect(said(client({ callTimeoutMs: 1000, metaTimeoutMs: 500 }))).toBe('taken')
})

it('an execute deadline that is not a positive number is refused', () => {
  const c = new ReapiClient({ endpoint: 'grpc://127.0.0.1:1' })
  try {
    expect(said(() => reapiExecutor(c, { executeTimeoutMs: 0 }))).toBe(
      'reapi(): executeTimeoutMs must be a positive number of ms up to 2147483647 (got 0)',
    )
    expect(said(() => reapiExecutor(c, { queueTimeoutMs: Number.NaN }))).toBe(
      'reapi(): queueTimeoutMs must be a positive number of ms up to 2147483647 (got NaN)',
    )
    expect(said(() => reapiExecutor(c, { executeTimeoutMs: 60_000 }))).toBe('taken')
  } finally {
    c.close()
  }
})

// Bun fires a timer past 2^31 - 1 ms after 1 ms: queueTimeoutMs: 2 ** 31
// cancelled every action at once, executeTimeoutMs: 2 ** 31 timed every task
// out. Such a bound is refused, as core refuses such an exec.timeout and
// vxCache() such a timeoutMs; the longest a timer holds is taken
// (queue-timeout.test.ts waits one out).
it('an execute or queue deadline past what a timer can wait is refused', () => {
  const c = new ReapiClient({ endpoint: 'grpc://127.0.0.1:1' })
  try {
    expect(said(() => reapiExecutor(c, { executeTimeoutMs: 2 ** 31 }))).toBe(
      'reapi(): executeTimeoutMs must be a positive number of ms up to 2147483647 (got 2147483648)',
    )
    expect(said(() => reapiExecutor(c, { queueTimeoutMs: 1e10 }))).toBe(
      'reapi(): queueTimeoutMs must be a positive number of ms up to 2147483647 (got 10000000000)',
    )
    expect(said(() => reapiExecutor(c, { queueTimeoutMs: 2 ** 31 - 1 }))).toBe('taken')
  } finally {
    c.close()
  }
})

it('a call or metadata deadline past what a timer can wait is refused', () => {
  expect(said(client({ callTimeoutMs: 2 ** 31 }))).toBe(
    'reapi(): callTimeoutMs must be a positive number of ms up to 2147483647 (got 2147483648)',
  )
  expect(said(client({ metaTimeoutMs: 3e9 }))).toBe(
    'reapi(): metaTimeoutMs must be a positive number of ms up to 2147483647 (got 3000000000)',
  )
  expect(said(client({ callTimeoutMs: 2 ** 31 - 1 }))).toBe('taken')
})
