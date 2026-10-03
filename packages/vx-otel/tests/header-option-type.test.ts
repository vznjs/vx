// A header option whose value is not a string (`{ 'x-tenant': 42 }`) threw
// `value.trim is not a function` out of the plugin. It is dropped with the
// warning a value fetch cannot send gets, and the other headers still go.
import { expect, it } from 'bun:test'
import { resolveOtelConfig } from '../src/plugin.js'

it('a non-string header value is not sent, and says so once', () => {
  const warns: string[] = []
  const c = resolveOtelConfig(
    { headers: { 'x-tenant': 42, 'x-team': 'core' } as never },
    { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318' },
    (m) => warns.push(m),
  )
  expect(c?.headers).toEqual({ 'x-team': 'core' })
  expect(warns).toEqual([
    '[vx-otel] header "x-tenant" holds a non-string value, which no HTTP header can carry — not sent (its value is not printed)',
  ])
})
