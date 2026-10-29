// Turbo's signing rules for a carried-over setup (`crates/turborepo-cache/src/http.rs`,
// `HTTPCache::new`): a key under 32 bytes only warns unless turbo.json sets
// `futureFlags.longerSignatureKey`; a missing team id signs as the empty
// string; signing on with no key leaves Turbo no usable remote. A throw from
// `cache()` fails the whole vx run, so each of these refused a repo Turbo runs.
import { describe, expect, it } from 'bun:test'
import { resolveTurboCacheConfig } from '../src/turbo-cache/index.js'

const SHORT = 's'.repeat(20)
const KEY = 'k'.repeat(32)
const BASE = { apiUrl: 'https://cache.example', token: 't' }

function resolve(
  env: Record<string, string>,
  file: Parameters<typeof resolveTurboCacheConfig>[2],
  options: Parameters<typeof resolveTurboCacheConfig>[0] = BASE,
) {
  const warnings: string[] = []
  const config = resolveTurboCacheConfig(options, env, file, {}, (m) => warnings.push(m))
  return { config, warnings }
}

describe('turboCache() signs as Turbo does with a carried-over key', () => {
  it('a short env key signs and warns, as Turbo does without the future flag', () => {
    const { config, warnings } = resolve(
      { TURBO_REMOTE_CACHE_SIGNATURE_KEY: SHORT, TURBO_TEAMID: 'team_1' },
      { signature: true },
    )
    expect(config?.signatureKey).toBe(SHORT)
    expect(warnings).toEqual([
      'TURBO_REMOTE_CACHE_SIGNATURE_KEY is 20 bytes; 32 or more is safe (Turbo enforces it under futureFlags.longerSignatureKey)',
    ])
  })

  it('futureFlags.longerSignatureKey refuses a short env key, as Turbo does', () => {
    expect(() =>
      resolve(
        { TURBO_REMOTE_CACHE_SIGNATURE_KEY: SHORT, TURBO_TEAMID: 'team_1' },
        { signature: true, longerSignatureKey: true },
      ),
    ).toThrow(/at least 32 bytes/)
  })

  it('signs with no team id, folding the empty string, as Turbo does', () => {
    const { config, warnings } = resolve(
      { TURBO_REMOTE_CACHE_SIGNATURE_KEY: KEY, TURBO_TEAM: 'acme' },
      { signature: true },
    )
    expect([config?.signatureKey, config?.teamId, config?.teamSlug, warnings]).toEqual([
      KEY,
      undefined,
      'acme',
      [],
    ])
    expect(
      resolve({}, {}, { ...BASE, teamSlug: 'acme', signatureKey: KEY }).config?.signatureKey,
    ).toBe(KEY)
  })

  it('signing on with no key turns the remote off with a warning, never an unverified read', () => {
    const { config, warnings } = resolve({ TURBO_TEAMID: 'team_1' }, { signature: true })
    expect(config).toBeUndefined()
    expect(warnings).toEqual([
      'turbo.json sets remoteCache.signature but TURBO_REMOTE_CACHE_SIGNATURE_KEY is unset: remote cache off for this run, as for turbo',
    ])
    // CONTROL: signing off reads the remote unsigned.
    expect(resolve({ TURBO_TEAMID: 'team_1' }, {}).config?.signatureKey).toBeUndefined()
    expect(resolve({ TURBO_TEAMID: 'team_1' }, {}).config).toBeDefined()
  })
})
