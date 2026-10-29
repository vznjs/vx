// `otel({ timeoutMs })` is held to OTEL_EXPORTER_OTLP_TIMEOUT's rule. A zero,
// negative or non-number value armed the abort at once, and every export
// failed as it started (stream F). It is refused at the call: refused only
// once an endpoint was set, a laptop passed what failed in CI, and a NaN
// was named as null.
import { expect, it } from 'bun:test'
import { otel } from '../src/index.js'
import { resolveOtelConfig } from '../src/plugin.js'

const said = (o: Record<string, unknown>): string => {
  try {
    otel(o as never)
    return 'taken'
  } catch (err) {
    return (err as Error).message
  }
}

it('a timeout that is not a positive number is refused', () => {
  expect(said({ timeoutMs: 0 })).toBe(
    'otel() option "timeoutMs" must be a positive number of ms, got 0',
  )
  expect(said({ timeoutMs: -5 })).toBe(
    'otel() option "timeoutMs" must be a positive number of ms, got -5',
  )
  expect(said({ timeoutMs: Number.NaN })).toBe(
    'otel() option "timeoutMs" must be a positive number of ms, got NaN',
  )
  expect(said({ timeoutMs: Number.POSITIVE_INFINITY })).toBe(
    'otel() option "timeoutMs" must be a positive number of ms, got Infinity',
  )
})

it('a compression it does not send is refused', () => {
  expect(said({ compression: 'zstd' })).toBe(
    'otel() option "compression" must be "gzip" or "none", got "zstd"',
  )
  expect(said({ compression: 'gzip' })).toBe('taken')
})

it('a positive timeout, or none, is taken', () => {
  const env = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318' }
  expect(said({ timeoutMs: 1000 })).toBe('taken')
  expect(resolveOtelConfig({ timeoutMs: 1000 }, env)?.timeoutMs).toBe(1000)
  expect(resolveOtelConfig({}, env)?.timeoutMs).toBe(15000)
})
