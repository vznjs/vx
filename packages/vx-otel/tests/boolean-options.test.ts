// `otel({ metrics: process.env.X })` passes the string 'false', which is
// truthy: the signal was exported though it was turned off (stream F).
import { expect, it } from 'bun:test'
import { otel } from '../src/index.js'

const said = (opts: Record<string, unknown>): string => {
  try {
    otel(opts as never)
    return 'taken'
  } catch (err) {
    return (err as Error).message
  }
}

it('metrics or logs that is not a boolean is refused', () => {
  expect(said({ metrics: 'false' })).toBe('otel() option "metrics" must be a boolean, got "false"')
  expect(said({ logs: 0 })).toBe('otel() option "logs" must be a boolean, got 0')
})

it('booleans are taken', () => {
  expect(said({ metrics: false, logs: true })).toBe('taken')
})
