// Tokens from the internet: the check refuses what jose must, and costs
// the issuer no fetch per forged token.

import { beforeAll, describe, expect, it } from 'bun:test'
import { base64url, exportJWK, exportSPKI, generateKeyPair, type JWTPayload, SignJWT } from 'jose'
import { oidcTokenAuth, parseAllow, Refusal } from '../src/index.js'

const GITHUB = 'https://token.actions.githubusercontent.com'
const AUD = 'https://cache.example.com'
const CLAIMS = {
  repository: 'acme/app',
  job_workflow_ref: 'acme/app/.github/workflows/ci.yml@refs/heads/main',
  event_name: 'push',
  ref: 'refs/heads/main',
}

let good: string
let publicPem: string
let fetches = 0
let jwk: Record<string, unknown>
let sign: (header: { alg: string; kid?: string }, claims?: JWTPayload) => Promise<string>
const enc = (o: unknown) => base64url.encode(JSON.stringify(o))

const auth = oidcTokenAuth({
  allow: parseAllow(`${GITHUB}:acme/app:ci.yml`),
  audience: AUD,
  fetchJson: async (url) => {
    fetches++
    return url.endsWith('/.well-known/openid-configuration')
      ? { jwks_uri: `${GITHUB}/keys` }
      : { keys: [jwk] }
  },
})
beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' }
  publicPem = await exportSPKI(publicKey)
  sign = (header, claims = {}) =>
    new SignJWT({ ...CLAIMS, ...claims })
      .setProtectedHeader(header)
      .setIssuer(GITHUB)
      .setAudience(AUD)
      .setExpirationTime('5m')
      .sign(privateKey)
  good = await sign({ alg: 'RS256', kid: 'k1' })
})

const refusal = async (token: string) => {
  try {
    await auth(new Request(`${AUD}/v1/x`, { headers: { authorization: `Bearer ${token}` } }))
  } catch (err) {
    if (err instanceof Refusal) return [err.status, err.message] as const
    throw err
  }
  return 'admitted'
}

describe('hostile tokens', () => {
  it('admits a good token, the baseline the forgeries differ from', async () => {
    expect(await refusal(good)).toBe('admitted')
  })

  it('refuses alg none and HS256 keyed with the public key', async () => {
    const [, payload] = good.split('.')
    expect(await refusal(`${enc({ alg: 'none' })}.${payload}.`)).toEqual([401, 'alg is not RS256'])
    const hs = await new SignJWT({ ...CLAIMS })
      .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
      .setIssuer(GITHUB)
      .setAudience(AUD)
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(publicPem))
    expect(await refusal(hs)).toEqual([401, 'alg is not RS256'])
  })

  it('refuses an unknown crit extension and a payload swapped under a signature', async () => {
    const [header, payload, sig] = good.split('.')
    const crit = `${enc({ alg: 'RS256', kid: 'k1', crit: ['x'], x: 1 })}.${payload}.${sig}`
    expect((await refusal(crit))[0]).toBe(401)
    const other = enc({ ...JSON.parse(atob(payload!)), repository: 'acme/other' })
    expect(await refusal(`${header}.${other}.${sig}`)).toEqual([401, 'bad signature'])
  })

  it('fetches no keys for forged kids once the set is fresh', async () => {
    await refusal(good)
    const before = fetches
    for (let i = 0; i < 20; i++)
      expect(await refusal(await sign({ alg: 'RS256', kid: `forged-${i}` }))).toEqual([
        401,
        'unknown signing key',
      ])
    expect(fetches).toBe(before)
  })

  it('never echoes the token it refuses', async () => {
    for (const token of [
      await sign({ alg: 'RS256', kid: 'k1' }, { repository: 'acme/other' }),
      await sign({ alg: 'RS256', kid: 'k1' }, { job_workflow_ref: 'acme/app/x@refs/heads/a' }),
      `${good.split('.')[0]}.not-json.${good.split('.')[2]}`,
    ]) {
      const [, message] = (await refusal(token)) as readonly [number, string]
      for (const part of token.split('.')) if (part !== '') expect(message).not.toContain(part)
    }
  })
})
