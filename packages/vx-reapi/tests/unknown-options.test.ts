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
    'reapi() has unknown option "endpont" (allowed: callTimeoutMs, capacity, chunkBytes, correlatedInvocationsId, endpoint, execute, executeTimeoutMs, headers, instanceName, metaTimeoutMs, onWarn, platform, tls, tlsCaPem, tlsCertificate, tlsClientCertPem, tlsClientCertificate, tlsClientKey, tlsClientKeyPem, toolName, toolVersion) \u2014 did you mean endpoint?',
  )
})

it('no options is taken', () => {
  expect(refusal(() => reapi({}))).not.toContain('unknown option')
})
