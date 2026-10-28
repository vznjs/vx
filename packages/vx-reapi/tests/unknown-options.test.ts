// A misspelt option was read as unset: Bun strips a config's types, so
// the factory saw the typo and the plugin quietly declined or kept its
// default. `reapi()` now refuse a key it does not read (stream F).
import { expect, it } from 'bun:test'
import { reapi } from '../src/index.js'

const refusal = (make: () => unknown): string => {
  try {
    make()
    return 'taken'
  } catch (err) {
    return (err as Error).message
  }
}

it('a misspelt option is refused, naming the nearest one', () => {
  expect(refusal(() => reapi({ endpont: 'x' } as never))).toBe(
    'reapi() has unknown option "endpont" (allowed: callTimeoutMs, capacity, chunkBytes, correlatedInvocationsId, endpoint, execute, executeTimeoutMs, headers, instanceName, metaTimeoutMs, platform, queueTimeoutMs, tls, tlsCertificate, tlsClientCertificate, tlsClientKey, toolName, toolVersion) \u2014 did you mean endpoint?',
  )
})

it('no options is taken', () => {
  expect(refusal(() => reapi({}))).not.toContain('unknown option')
})

// A bad number was refused only once an endpoint was set, so a laptop
// passed what failed the first CI run, and a NaN was named as null
// (JSON.stringify(NaN)).
it('a number option it cannot use is refused at the call, naming the value', () => {
  expect(refusal(() => reapi({ callTimeoutMs: Number.NaN }))).toBe(
    'reapi() option "callTimeoutMs" must be a positive number of ms, got NaN',
  )
  expect(refusal(() => reapi({ metaTimeoutMs: 0 }))).toBe(
    'reapi() option "metaTimeoutMs" must be a positive number of ms, got 0',
  )
  expect(refusal(() => reapi({ executeTimeoutMs: -1 }))).toBe(
    'reapi() option "executeTimeoutMs" must be a positive number of ms, got -1',
  )
  expect(refusal(() => reapi({ queueTimeoutMs: Number.POSITIVE_INFINITY }))).toBe(
    'reapi() option "queueTimeoutMs" must be a positive number of ms, got Infinity',
  )
  expect(refusal(() => reapi({ chunkBytes: 1.5 }))).toBe(
    'reapi() option "chunkBytes" must be a whole number above 0, got 1.5',
  )
  expect(refusal(() => reapi({ capacity: 0 }))).toBe(
    'reapi() option "capacity" must be a whole number above 0, got 0',
  )
  expect(refusal(() => reapi({ callTimeoutMs: 1000, chunkBytes: 4096, capacity: 8 }))).toBe('taken')
})
