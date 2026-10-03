// The client's and the executor's deadlines refuse a value they cannot wait
// on: a zero, negative or non-number one ended every call, or stopped every
// action, the moment it began (stream F).
import { expect, it } from 'bun:test'
import { ReapiClient, reapiExecutor } from '../src/index.js'

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
    '@vzn/vx-reapi: callTimeoutMs must be a positive number of ms (got 0)',
  )
  expect(said(client({ metaTimeoutMs: -1 }))).toBe(
    '@vzn/vx-reapi: metaTimeoutMs must be a positive number of ms (got -1)',
  )
  expect(said(client({ callTimeoutMs: 1000, metaTimeoutMs: 500 }))).toBe('taken')
})

it('an execute deadline that is not a positive number is refused', () => {
  const c = new ReapiClient({ endpoint: 'grpc://127.0.0.1:1' })
  try {
    expect(said(() => reapiExecutor(c, { executeTimeoutMs: 0 }))).toBe(
      '@vzn/vx-reapi: executeTimeoutMs must be a positive number of ms (got 0)',
    )
    expect(said(() => reapiExecutor(c, { executeTimeoutMs: 60_000 }))).toBe('taken')
  } finally {
    c.close()
  }
})
