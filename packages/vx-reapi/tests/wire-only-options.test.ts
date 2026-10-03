// `reapi()` takes PEM files and warns through vx; the wire-form fields of
// `ReapiOptions` are `ReapiRemoteCache`'s. Accepted by the plugin, `onWarn`
// was dropped without a word (its own warn replaced it) and
// `tlsClientCertPem` skipped the cert-and-key pair check.

import { expect, it } from 'bun:test'
import { reapi } from '../src/index.js'

const refusal = (options: object): string => {
  try {
    reapi(options as never)
    return 'accepted'
  } catch (err) {
    return (err as Error).message
  }
}

it.each([
  ['onWarn', () => {}],
  ['tlsCaPem', '-----BEGIN CERTIFICATE-----'],
  ['tlsClientCertPem', '-----BEGIN CERTIFICATE-----'],
  ['tlsClientKeyPem', '-----BEGIN PRIVATE KEY-----'],
])('reapi({ %s }) is refused as unknown', (key, value) => {
  expect(refusal({ endpoint: 'cache.example.com:443', [key]: value })).toStartWith(
    `reapi() has unknown option "${key}" (allowed: `,
  )
})

it('the file form it takes instead is accepted', () => {
  expect(refusal({ endpoint: 'cache.example.com:443', toolName: 'ci' })).toBe('accepted')
})
