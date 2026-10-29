// An OTEL_EXPORTER_OTLP_TIMEOUT that is not a positive number of ms
// (`5s`, `0`) ran on the default with no word, while a bad compression
// variable warns. The spec asks an SDK to warn on an invalid value and use
// the default: each variable read and not taken says so, once.
import { expect, it } from 'bun:test'
import { resolveOtelConfig } from '../src/plugin.js'

const base = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318' }
const warnings = (opts: { timeoutMs?: number }, env: Record<string, string>): string[] => {
  const warns: string[] = []
  resolveOtelConfig(opts, { ...base, ...env }, (m) => warns.push(m))
  return warns
}

it('a timeout variable that is not a positive number says so, and the default runs', () => {
  expect(warnings({}, { OTEL_EXPORTER_OTLP_TIMEOUT: '5s' })).toEqual([
    '[vx] vx-otel: OTEL_EXPORTER_OTLP_TIMEOUT "5s" is not a positive number of ms — not used',
  ])
  expect(warnings({}, { OTEL_EXPORTER_OTLP_LOGS_TIMEOUT: '0' })).toEqual([
    '[vx] vx-otel: OTEL_EXPORTER_OTLP_LOGS_TIMEOUT "0" is not a positive number of ms — not used',
  ])
})

it('a good, unset or overridden timeout variable says nothing', () => {
  expect(warnings({}, { OTEL_EXPORTER_OTLP_TIMEOUT: '2500' })).toEqual([])
  expect(warnings({}, {})).toEqual([])
  expect(warnings({}, { OTEL_EXPORTER_OTLP_TIMEOUT: ' ' })).toEqual([])
  expect(warnings({ timeoutMs: 100 }, { OTEL_EXPORTER_OTLP_TIMEOUT: '5s' })).toEqual([])
})
