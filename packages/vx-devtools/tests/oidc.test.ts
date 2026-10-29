// oidcTokenAuth against keys served without a network.

import { beforeAll, describe, expect, it } from 'bun:test'
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from 'jose'
import { oidcTokenAuth, parseAllow } from '../src/index.js'

const GITLAB = 'https://gitlab.example.com'
const AUD = 'https://cache.example.com'

let sign: (iss: string, claims?: JWTPayload) => Promise<string>
let fetchJson: (url: string) => Promise<unknown>

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' }
  fetchJson = async (url) =>
    url.endsWith('/.well-known/openid-configuration')
      ? { jwks_uri: `${GITLAB}/keys` }
      : { keys: [jwk] }
  sign = (iss, claims = {}) =>
    new SignJWT({
      project_path: 'group/app',
      ci_config_ref_uri: 'gitlab.example.com/group/app//.gitlab-ci.yml@refs/heads/main',
      ref_path: 'refs/heads/main',
      ...claims,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(iss)
      .setAudience(AUD)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
})

const req = (token: string) =>
  new Request(`${AUD}/v1/x`, { headers: { authorization: `Bearer ${token}` } })

describe('oidcTokenAuth', () => {
  // A trailing slash is no other issuer: a key and a tokenless read already
  // named it without one, yet a token was refused as of an issuer ALLOW lacks.
  it('takes an issuer with or without a trailing slash, in ALLOW or in the token', async () => {
    const access = { issuer: GITLAB, repository: 'group/app', write: 'refs/heads/main' }
    for (const [allowed, iss] of [
      [`${GITLAB}/`, GITLAB],
      [GITLAB, `${GITLAB}/`],
      [GITLAB, GITLAB],
    ]) {
      const auth = oidcTokenAuth({
        allow: parseAllow(`${allowed}:group/app:.gitlab-ci.yml`),
        fetchJson,
      })
      expect(
        await auth(req(await sign(iss!)), { issuer: allowed!, repository: 'Group/App' }),
      ).toEqual(access)
    }
  })
})
