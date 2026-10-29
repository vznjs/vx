// A `content-type` header (from the option or OTEL_EXPORTER_OTLP_HEADERS)
// replaced the `application/json` the body is, so a collector parsed the
// JSON as whatever it named (protobuf, mostly) and refused every export.
// The body decides its own type: the header is dropped, saying so once.
import { expect, it } from 'bun:test'
import { resolveOtelConfig } from '../src/plugin.js'

it('a content-type header is not sent over the JSON body, and says so once', () => {
  const warns: string[] = []
  const c = resolveOtelConfig(
    { headers: { 'Content-Type': 'application/x-protobuf', 'x-team': 'core' } },
    {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
      OTEL_EXPORTER_OTLP_HEADERS: 'content-type=application/x-protobuf',
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'content-type=application/x-protobuf',
    },
    (m) => warns.push(m),
  )
  expect(c?.headers).toEqual({ 'x-team': 'core' })
  expect(c?.signalHeaders.traces).toEqual({ 'x-team': 'core' })
  expect(warns).toEqual([
    '[vx] vx-otel: header "content-type" names the body\'s type, and vx-otel sends OTLP/HTTP JSON (application/json) — not sent',
  ])
})
