// The issuer's keys oidcClaims keeps: read again once 10 minutes old, and
// for a kid they lack only 30 s after the last read; a key the issuer
// withdrew stops verifying at that read, and the last keys read answer
// while the issuer is down.

import { afterEach, describe, expect, it, setSystemTime } from 'bun:test'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { oidcClaims, Refusal } from '../src/index.js'

const ISS = 'https://gitlab.example.com'
const AUD = 'https://server.example.com'
const T0 = new Date('2030-01-01T00:00:00Z').getTime()

const pairs = await Promise.all([generateKeyPair('RS256'), generateKeyPair('RS256')])
const jwks = await Promise.all(
  pairs.map(async (p, i) => ({
    ...(await exportJWK(p.publicKey)),
    kid: `k${i + 1}`,
    alg: 'RS256',
  })),
)
const sign = (i: number) =>
  new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: `k${i + 1}` })
    .setIssuer(ISS)
    .setAudience(AUD)
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(pairs[i]!.privateKey)

/** An issuer serving `served`, counting its key reads; `down` fails every read. */
function issuer() {
  const state = { served: [jwks[0]] as unknown[], down: false, reads: 0 }
  const check = oidcClaims({
    allow: [{ issuer: ISS }],
    fetchJson: async (url) => {
      if (url.endsWith('/.well-known/openid-configuration')) return { jwks_uri: `${ISS}/keys` }
      state.reads++
      if (state.down) throw new Error('down')
      return { keys: state.served }
    },
  })
  const verdict = async (i: number) =>
    check(await sign(i), AUD).then(
      () => 'ok',
      (err: unknown) => {
        if (!(err instanceof Refusal)) throw err
        return `${err.status} ${err.message}`
      },
    )
  return { state, verdict }
}

const at = (ms: number) => setSystemTime(new Date(T0 + ms))

describe('the keys oidcClaims keeps', () => {
  afterEach(() => setSystemTime())

  it('are read again once 10 minutes old, not before', async () => {
    const { state, verdict } = issuer()
    at(0)
    expect(await verdict(0)).toBe('ok')
    at(600_000 - 1)
    expect(await verdict(0)).toBe('ok')
    expect(state.reads).toBe(1)
    at(600_000)
    expect(await verdict(0)).toBe('ok')
    expect(state.reads).toBe(2)
  })

  it('are read again for a kid they lack only 30 s after the last fresh read', async () => {
    const { state, verdict } = issuer()
    at(0)
    expect(await verdict(0)).toBe('ok')
    // The first read may be a cache's; the one at 10 minutes is the issuer's.
    at(600_000)
    expect(await verdict(0)).toBe('ok')
    state.served = [jwks[0], jwks[1]]
    at(630_000 - 1)
    expect(await verdict(1)).toBe('401 unknown signing key')
    expect(state.reads).toBe(2)
    at(630_000)
    expect(await verdict(1)).toBe('ok')
    expect(state.reads).toBe(3)
  })

  it('stop verifying a key the issuer withdrew once read again', async () => {
    const { state, verdict } = issuer()
    at(0)
    expect(await verdict(0)).toBe('ok')
    state.served = [jwks[1]]
    at(600_000)
    expect(await verdict(0)).toBe('401 unknown signing key')
    expect(await verdict(1)).toBe('ok')
  })

  it('answer while the issuer is down, and a kid they lack is then 502', async () => {
    const { state, verdict } = issuer()
    at(0)
    expect(await verdict(0)).toBe('ok')
    state.down = true
    at(600_000)
    expect(await verdict(0)).toBe('ok')
    expect(state.reads).toBe(2)
    at(630_000)
    expect(await verdict(1)).toBe(
      `502 could not read ${ISS}'s keys: a key the keys last read lack, and a refetch failed`,
    )
  })

  // A Worker's fresh isolate reads the keys through the shared cache, up to
  // 10 minutes old: a key the issuer rotated in since was refused 401 for
  // the isolate's first 30 s, and a client gives up on a 401.
  it('a kid the keys a cache answered lack is read fresh at once', async () => {
    let fresh = 0
    const check = oidcClaims({
      allow: [{ issuer: ISS }],
      fetchJson: async (url, isFresh) => {
        if (url.endsWith('/.well-known/openid-configuration')) return { jwks_uri: `${ISS}/keys` }
        if (isFresh) fresh++
        return { keys: isFresh ? [jwks[0], jwks[1]] : [jwks[0]] }
      },
    })
    at(0)
    await check(await sign(1), AUD)
    expect(fresh).toBe(1)
  })
})
