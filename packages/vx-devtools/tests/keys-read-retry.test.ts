// A read of the issuer's keys is tried again past a timeout, a dropped
// connection, a 5xx or a 429: one timed-out read of GitHub's keys ended a
// DTE worker before it joined (run 45171381326).

import { afterEach, describe, expect, it } from 'bun:test'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { cachedFetchJson, oidcClaims, Refusal } from '../src/index.js'

const ISS = 'https://issuer.example.com'
const AUD = 'https://server.example.com'
const pair = await generateKeyPair('RS256')
const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' }
const token = () =>
  new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(ISS)
    .setAudience(AUD)
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(pair.privateKey)

/** An issuer whose first `fails` key reads fail as `how`; counts the key reads. */
function issuer(fails: number, how: () => Response | Error) {
  const state = { reads: 0 }
  const impl = (async (input: string) => {
    const url = input
    if (url.endsWith('/.well-known/openid-configuration'))
      return Response.json({ jwks_uri: `${ISS}/keys` })
    if (state.reads++ < fails) {
      const r = how()
      if (r instanceof Error) throw r
      return r
    }
    return Response.json({ keys: [jwk] })
  }) as unknown as typeof fetch
  return { state, impl }
}

const timeout = () => new DOMException('The operation timed out.', 'TimeoutError') as Error
const real = globalThis.fetch

describe("a read of the issuer's keys", () => {
  afterEach(() => {
    globalThis.fetch = real
  })

  it('is tried again past a timeout', async () => {
    const { state, impl } = issuer(1, timeout)
    globalThis.fetch = impl
    const { iss } = await oidcClaims({ allow: [{ issuer: ISS }] })(await token(), AUD)
    expect({ iss, reads: state.reads }).toEqual({ iss: ISS, reads: 2 })
  })

  it('is tried again past a 503 and a 429', async () => {
    let n = 0
    const { state, impl } = issuer(2, () => new Response('busy', { status: n++ ? 429 : 503 }))
    globalThis.fetch = impl
    await oidcClaims({ allow: [{ issuer: ISS }] })(await token(), AUD)
    expect(state.reads).toBe(3)
  })

  it('is not tried again past a 404, and gives up after three tries', async () => {
    const gone = issuer(9, () => new Response('no', { status: 404 }))
    globalThis.fetch = gone.impl
    const said = await oidcClaims({ allow: [{ issuer: ISS }] })(await token(), AUD).catch(
      (e: unknown) => e,
    )
    expect(said).toBeInstanceOf(Refusal)
    expect((said as Refusal).status).toBe(502)
    expect(gone.state.reads).toBe(1)

    const down = issuer(9, timeout)
    globalThis.fetch = down.impl
    const out = await oidcClaims({ allow: [{ issuer: ISS }] })(await token(), AUD).catch(
      (e: unknown) => e,
    )
    expect((out as Refusal).message).toContain('timed out')
    expect(down.state.reads).toBe(3)
  })

  it('through a shared cache is tried again too', async () => {
    const { state, impl } = issuer(1, timeout)
    const held = new Map<string, string>()
    const cache = {
      match: async (u: string) => {
        const body = held.get(u)
        return body === undefined ? undefined : new Response(body)
      },
      put: async (u: string, r: Response) => {
        held.set(u, await r.text())
      },
    }
    await oidcClaims({ allow: [{ issuer: ISS }], fetchJson: cachedFetchJson(cache, impl) })(
      await token(),
      AUD,
    )
    expect(state.reads).toBe(2)
  })
})
