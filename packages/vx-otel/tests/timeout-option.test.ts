// `otel({ timeoutMs })` is held to OTEL_EXPORTER_OTLP_TIMEOUT's rule. A zero,
// negative or non-number value, or one past the longest timer, armed the
// abort at once, and every export failed as it started (stream F). It is
// refused at the call: refused only once an endpoint was set, a laptop
// passed what failed in CI, and a NaN was named as null.
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
    'otel() option "timeoutMs" must be a positive number of ms up to 2147483647, got 0',
  )
  expect(said({ timeoutMs: -5 })).toBe(
    'otel() option "timeoutMs" must be a positive number of ms up to 2147483647, got -5',
  )
  expect(said({ timeoutMs: Number.NaN })).toBe(
    'otel() option "timeoutMs" must be a positive number of ms up to 2147483647, got NaN',
  )
  expect(said({ timeoutMs: Number.POSITIVE_INFINITY })).toBe(
    'otel() option "timeoutMs" must be a positive number of ms up to 2147483647, got Infinity',
  )
})

// A timer past 2^31-1 ms fires after 1 ms. The option is refused there,
// as vxCache() and core's exec.timeout refuse one; the env value is the
// OTel spec's to define, so the request timer holds it (collector.test.ts).
it('a timeout past the longest timer is refused', () => {
  expect(said({ timeoutMs: 2 ** 31 })).toBe(
    'otel() option "timeoutMs" must be a positive number of ms up to 2147483647, got 2147483648',
  )
  expect(said({ timeoutMs: 1e10 })).toBe(
    'otel() option "timeoutMs" must be a positive number of ms up to 2147483647, got 10000000000',
  )
  expect(said({ timeoutMs: 2 ** 31 - 1 })).toBe('taken')
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
