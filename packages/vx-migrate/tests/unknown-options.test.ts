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
    'nx() has unknown option "rot" (allowed: graph, root) \u2014 did you mean root?',
  )
  expect(refusal(() => turboCache({ apiURL: 'x' } as never))).toBe(
    'turboCache() has unknown option "apiURL" (allowed: apiUrl, retries, signatureKey, teamId, teamSlug, timeoutMs, token, uploadTimeoutMs) \u2014 did you mean apiUrl?',
  )
  expect(refusal(() => nxCache({ severr: 'x' } as never))).toBe(
    'nxCache() has unknown option "severr" (allowed: accessToken, retries, server, timeoutMs) \u2014 did you mean server?',
  )
})

it('no options is taken', () => {
  expect(refusal(() => turbo({}))).not.toContain('unknown option')
  expect(refusal(() => nx({}))).not.toContain('unknown option')
  expect(refusal(() => turboCache({}))).not.toContain('unknown option')
  expect(refusal(() => nxCache({}))).not.toContain('unknown option')
})
