// `otel({ timeoutMs })` is held to OTEL_EXPORTER_OTLP_TIMEOUT's rule. A zero,
// negative or non-number value armed the abort at once, and every export
// failed as it started (stream F).
import { expect, it } from 'bun:test'
import { resolveOtelConfig } from '../src/plugin.js'

const env = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318' }
const said = (timeoutMs: unknown): string => {
  try {
    const c = resolveOtelConfig({ timeoutMs } as never, env)
    return `timeout ${c?.timeoutMs}`
  } catch (err) {
    return (err as Error).message
  }
}

it('a timeout that is not a positive number is refused', () => {
  expect(said(0)).toBe('[vx-otel] timeoutMs must be a positive number of ms, got 0')
  expect(said(-5)).toBe('[vx-otel] timeoutMs must be a positive number of ms, got -5')
  expect(said(Number.NaN)).toBe('[vx-otel] timeoutMs must be a positive number of ms, got null')
  expect(said('5000')).toBe('[vx-otel] timeoutMs must be a positive number of ms, got "5000"')
})

it('a positive timeout, or none, is taken', () => {
  expect(said(1000)).toBe('timeout 1000')
  expect(said(undefined)).toBe('timeout 15000')
})
