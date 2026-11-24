// A misspelt option was read as unset: Bun strips a config's types, so
// the factory saw the typo and the plugin quietly declined or kept its
// default. `turbo()`, `nx()`, `turboCache()`, `nxCache()` now refuse a key they do not read (stream F).
import { expect, it } from 'bun:test'
import { turbo, nx, turboCache, nxCache } from '../src/index.js'

const refusal = (make: () => unknown): string => {
  try {
    make()
    return 'taken'
  } catch (err) {
    return (err as Error).message
  }
}

it('a misspelt option is refused, naming the nearest one', () => {
  expect(refusal(() => turbo({ rot: '.' } as never))).toBe(
    'turbo() has unknown option "rot" (allowed: root) \u2014 did you mean root?',
  )
  expect(refusal(() => nx({ rot: '.' } as never))).toBe(
    'nx() has unknown option "rot" (allowed: executors, graph, root) \u2014 did you mean root?',
  )
  expect(refusal(() => turboCache({ ulr: 'x' } as never))).toBe(
    'turboCache() has unknown option "ulr" (allowed: oidc, preflight, retries, scope, signatureKey, teamId, teamSlug, timeoutMs, token, uploadTimeoutMs, url) \u2014 did you mean url?',
  )
  expect(refusal(() => nxCache({ ulr: 'x' } as never))).toBe(
    'nxCache() has unknown option "ulr" (allowed: retries, timeoutMs, token, url) \u2014 did you mean url?',
  )
})

// One name per concept across the cache plugins, vxCache()'s: the server is
// `url`, its bearer `token`.
it('names the server url and its bearer token, as vxCache() does', () => {
  expect(refusal(() => turboCache({ apiUrl: 'x' } as never))).toContain(
    'turboCache() has unknown option "apiUrl"',
  )
  expect(refusal(() => nxCache({ server: 'x' } as never))).toContain(
    'nxCache() has unknown option "server"',
  )
  expect(refusal(() => nxCache({ accessToken: 'x' } as never))).toContain(
    'nxCache() has unknown option "accessToken"',
  )
})

it('no options is taken', () => {
  expect(refusal(() => turbo({}))).not.toContain('unknown option')
  expect(refusal(() => nx({}))).not.toContain('unknown option')
  expect(refusal(() => turboCache({}))).not.toContain('unknown option')
  expect(refusal(() => nxCache({}))).not.toContain('unknown option')
})

// `oidc` is read only in a CI job's cache hook: a wrong shape passed
// `vx lock` and every laptop run, then warned in CI and ran local only.
it('refuses an oidc of the wrong shape at the call', () => {
  expect(refusal(() => turboCache({ oidc: 'x' } as never))).toBe(
    'turboCache() option "oidc" must be true or { tokenUrl, revokeUrl, audience, params }, got "x"',
  )
  expect(refusal(() => turboCache({ oidc: false } as never))).toBe(
    'turboCache() option "oidc" must be true or { tokenUrl, revokeUrl, audience, params }, got false',
  )
  expect(refusal(() => turboCache({ oidc: { tokenURL: 'https://t.test' } } as never))).toBe(
    'turboCache() option "oidc" has unknown option "tokenURL" (allowed: audience, params, revokeUrl, tokenUrl) — did you mean tokenUrl?',
  )
  expect(refusal(() => turboCache({ oidc: { audience: 5 } } as never))).toBe(
    'turboCache() option "oidc.audience" must be a string, got 5',
  )
  expect(refusal(() => turboCache({ oidc: true }))).toBe('taken')
  expect(
    refusal(() => turboCache({ oidc: { tokenUrl: 'https://t.test', revokeUrl: false } })),
  ).toBe('taken')
})
