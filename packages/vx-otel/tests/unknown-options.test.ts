// A misspelt option was read as unset: Bun strips a config's types, so
// the factory saw the typo and the plugin quietly declined or kept its
// default. `otel()` now refuse a key it does not read (stream F).
import { expect, it } from 'bun:test'
import { otel } from '../src/index.js'

const refusal = (make: () => unknown): string => {
  try {
    make()
    return 'taken'
  } catch (err) {
    return (err as Error).message
  }
}

it('a misspelt option is refused, naming the nearest one', () => {
  expect(refusal(() => otel({ endpiont: 'x' } as never))).toBe(
    'otel() has unknown option "endpiont" (allowed: compression, endpoint, headers, logs, logsEndpoint, metrics, metricsEndpoint, post, serviceName, timeoutMs, tracesEndpoint) \u2014 did you mean endpoint?',
  )
})

it('no options is taken', () => {
  expect(refusal(() => otel({}))).not.toContain('unknown option')
})
