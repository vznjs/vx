// `headers: { authorization: process.env.OTLP_TOKEN }` is how vxCache(),
// vxHistory() and dte() take a secret: an unset one is left out, unsaid.
// otel() typed its headers `Record<string, string>`, so that line did not
// type-check, and in an untyped config the unset value warned as a value
// no HTTP header can carry.
import { expect, it } from 'bun:test'
import { resolveOtelConfig, type OtelPluginOptions } from '../src/plugin.js'

it('a header whose value is unset is left out, unsaid', () => {
  const warns: string[] = []
  const headers: OtelPluginOptions['headers'] = { authorization: undefined, 'x-team': 'core' }
  const c = resolveOtelConfig(
    { headers },
    { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318', OTEL_EXPORTER_OTLP_HEADERS: 'a=b' },
    (m) => warns.push(m),
  )
  expect(c?.headers).toEqual({ a: 'b', 'x-team': 'core' })
  expect(c?.signalHeaders?.traces).toEqual({ 'x-team': 'core' })
  expect(warns).toEqual([])
})

it('an unset option header does not drop the env header of that name', () => {
  const c = resolveOtelConfig(
    { headers: { authorization: undefined } },
    {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
      OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer%20t',
    },
  )
  expect(c?.headers).toEqual({ authorization: 'Bearer t' })
})
