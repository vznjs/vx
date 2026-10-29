// oidcTokenAuth against keys served without a network.

import { afterEach, beforeAll, describe, expect, it, setSystemTime } from 'bun:test'
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from 'jose'
import { cachedFetchJson, oidcTokenAuth, parseAllow, Refusal } from '../src/index.js'

const GITLAB = 'https://gitlab.example.com'
const AUD = 'https://cache.example.com'

let sign: (iss: string, claims?: JWTPayload, kid?: string) => Promise<string>
let signWith: (key: CryptoKey, kid: string) => Promise<string>
let fetchJson: (url: string) => Promise<unknown>

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' }
  fetchJson = async (url) =>
    url.endsWith('/.well-known/openid-configuration')
      ? { jwks_uri: `${GITLAB}/keys` }
      : { keys: [jwk] }
  signWith = (key, kid) =>
    new SignJWT({
      project_path: 'group/app',
      ci_config_ref_uri: 'gitlab.example.com/group/app//.gitlab-ci.yml@refs/heads/main',
      ref_path: 'refs/heads/main',
    })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuer(GITLAB)
      .setAudience(AUD)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(key)
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
  // A key set the issuer broke (two keys answering one kid, or no set at
  // all) is the issuer's fault: it read 401 "not a JWT", a token refused,
  // and the client dropped a remote it should have asked again.
  it("answers an issuer's broken key set 502, never 401", async () => {
    const { publicKey } = await generateKeyPair('RS256')
    const other = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' }
    const good = (await fetchJson(`${GITLAB}/keys`)) as { keys: unknown[] }
    const statusFor = async (keys: unknown): Promise<[number, string]> => {
      const auth = oidcTokenAuth({
        allow: parseAllow(`${GITLAB}:group/app:.gitlab-ci.yml`),
        fetchJson: async (url) =>
          url.endsWith('/.well-known/openid-configuration') ? { jwks_uri: `${GITLAB}/keys` } : keys,
      })
      try {
        await auth(req(await sign(GITLAB)), { issuer: GITLAB, repository: 'group/app' })
        return [200, '']
      } catch (err) {
        if (!(err instanceof Refusal)) throw err
        return [err.status, err.message.slice(0, 30)]
      }
    }
    expect((await statusFor({ keys: [...good.keys, other] }))[0]).toBe(502)
    expect((await statusFor({ keys: 'none' }))[0]).toBe(502)
    // Control: the issuer's own set takes the token.
    expect(await statusFor(good)).toEqual([200, ''])
  })
  // jose refetches an issuer's keys every 10 minutes and threw when the
  // refetch failed: one slow answer from GitHub's key endpoint (10 s, on a
  // Worker) failed an upload 502 and lost a DTE worker's entry (2026-10-29).
  describe("an issuer's keys out of reach on a refetch", () => {
    afterEach(() => setSystemTime())
    const flaky = () => {
      let up = true
      return {
        down: () => (up = false),
        fetchJson: async (url: string) => {
          if (!up) throw new Error('request timed out')
          return fetchJson(url)
        },
      }
    }
    const statusOf = async (p: Promise<unknown>): Promise<number> =>
      p.then(
        () => 200,
        (err: unknown) => {
          if (!(err instanceof Refusal)) throw err
          return err.status
        },
      )

    it('verifies with the keys last read', async () => {
      const issuer = flaky()
      const auth = oidcTokenAuth({
        allow: parseAllow(`${GITLAB}:group/app:.gitlab-ci.yml`),
        fetchJson: issuer.fetchJson,
      })
      const scope = { issuer: GITLAB, repository: 'group/app' }
      expect(await statusOf(auth(req(await sign(GITLAB)), scope))).toBe(200)
      issuer.down()
      setSystemTime(Date.now() + 11 * 60_000)
      expect(await statusOf(auth(req(await sign(GITLAB)), scope))).toBe(200)
    })

    // The keys last read lack a new kid: the issuer, not the token, so 502,
    // never the 401 that turns a client's remote off.
    it('answers a kid the keys last read lack 502', async () => {
      const issuer = flaky()
      const auth = oidcTokenAuth({
        allow: parseAllow(`${GITLAB}:group/app:.gitlab-ci.yml`),
        fetchJson: issuer.fetchJson,
      })
      const scope = { issuer: GITLAB, repository: 'group/app' }
      expect(await statusOf(auth(req(await sign(GITLAB)), scope))).toBe(200)
      issuer.down()
      setSystemTime(Date.now() + 11 * 60_000)
      const { privateKey } = await generateKeyPair('RS256')
      expect(await statusOf(auth(req(await signWith(privateKey, 'k2')), scope))).toBe(502)
    })
  })

  // A Worker's fresh isolate read the issuer on its first token, and the
  // issuer's slow answer failed it 502: the first read may come from a
  // cache an isolate shares, a reload (jose's, every 10 minutes or for a
  // kid it lacks) never does, or a rotated key stayed unknown.
  it('asks the first read of each URL not fresh, each reload fresh', async () => {
    const asked: [string, boolean][] = []
    const auth = oidcTokenAuth({
      allow: parseAllow(`${GITLAB}:group/app:.gitlab-ci.yml`),
      fetchJson: async (url, fresh) => {
        asked.push([url, fresh])
        return fetchJson(url)
      },
    })
    const scope = { issuer: GITLAB, repository: 'group/app' }
    await auth(req(await sign(GITLAB)), scope)
    setSystemTime(Date.now() + 11 * 60_000)
    await auth(req(await sign(GITLAB)), scope)
    setSystemTime()
    expect(asked).toEqual([
      [`${GITLAB}/.well-known/openid-configuration`, false],
      [`${GITLAB}/keys`, false],
      [`${GITLAB}/keys`, true],
    ])
  })
})

describe('cachedFetchJson', () => {
  const memCache = () => {
    const held = new Map<string, string>()
    return {
      held,
      match: async (url: string) => {
        const body = held.get(url)
        return body === undefined ? undefined : new Response(body)
      },
      put: async (url: string, res: Response) => {
        held.set(url, await res.text())
      },
    }
  }
  const network = (answers: Record<string, unknown>) => {
    const seen: string[] = []
    const fetchImpl = (async (url: string) => {
      seen.push(url)
      return Response.json(answers[url])
    }) as unknown as typeof fetch
    return { seen, fetchImpl }
  }

  it('answers a read not fresh from the cache, and keeps what the network says', async () => {
    const cache = memCache()
    const net = network({ 'https://i/keys': { keys: [1] } })
    const read = cachedFetchJson(cache, net.fetchImpl)
    expect(await read('https://i/keys', false)).toEqual({ keys: [1] })
    expect(await read('https://i/keys', false)).toEqual({ keys: [1] })
    expect(net.seen).toEqual(['https://i/keys'])
    expect(JSON.parse(cache.held.get('https://i/keys')!)).toEqual({ keys: [1] })
  })

  it('asks the network for a fresh read, held or not', async () => {
    const cache = memCache()
    cache.held.set('https://i/keys', JSON.stringify({ keys: [1] }))
    const net = network({ 'https://i/keys': { keys: [2] } })
    expect(await cachedFetchJson(cache, net.fetchImpl)('https://i/keys', true)).toEqual({
      keys: [2],
    })
    expect(net.seen).toEqual(['https://i/keys'])
    expect(JSON.parse(cache.held.get('https://i/keys')!)).toEqual({ keys: [2] })
  })
})
