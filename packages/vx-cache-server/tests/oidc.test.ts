// CI OIDC tokens: the token alone decides where a write lands (PROTOCOL.md
// § Tokens), against keys served without a network.

import { beforeAll, describe, expect, it } from 'bun:test'
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from 'jose'
import { oidcAuth, parseTrust } from '@vzn/vx-devtools'
import { createCacheServer } from '../src/server.js'
import { scopeOf } from './conformance.js'
import { memBlobs } from './mem-blobs.js'

const GITHUB = 'https://token.actions.githubusercontent.com'
const AUD = 'https://cache.example.com'
const trust = parseTrust(
  JSON.stringify([
    {
      iss: GITHUB,
      // A name, matched whatever its case (M, 2026-10-25: org/name, not id).
      repository: 'Acme/App',
      event_name: ['push', 'merge_group'],
      ref: ['refs/heads/main', 'refs/heads/gh-readonly-queue/main/*'],
      ref_protected: 'true',
    },
  ]),
)

let sign: (claims: JWTPayload, aud?: string) => Promise<string>
let handle: (req: Request) => Promise<Response>
let read: string

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' }
  sign = (claims, aud = AUD) =>
    new SignJWT({ repository: 'acme/app', ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(GITHUB)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
  handle = createCacheServer({
    blobs: memBlobs(),
    authorize: oidcAuth({
      trust,
      audience: AUD,
      fetchJson: async (url) =>
        url.endsWith('/.well-known/openid-configuration')
          ? { jwks_uri: `${GITHUB}/keys` }
          : { keys: [jwk] },
    }),
  })
  read = await sign({ event_name: 'workflow_dispatch', ref: 'refs/heads/main' })
})

const put = (token: string, key: string) =>
  handle(
    new Request(`${AUD}/v1/artifacts/${key}`, {
      method: 'PUT',
      body: 'x',
      headers: { authorization: `Bearer ${token}`, 'content-length': '1' },
    }),
  )
const status = (key: string, ref = 'refs/heads/main') =>
  handle(
    new Request(`${AUD}/v1/artifacts/${key}`, {
      headers: { authorization: `Bearer ${read}`, 'x-artifact-scope': scopeOf(ref) },
    }),
  ).then(async (r) => (await r.arrayBuffer(), r.status))
const detail = async (res: Response) =>
  [res.status, ((await res.json()) as { message: string }).message] as const

const MAIN = { event_name: 'push', ref: 'refs/heads/main', ref_protected: 'true' }

describe('CI OIDC tokens', () => {
  it('a token matching a rule writes the protected ref it runs on', async () => {
    expect((await put(await sign(MAIN), 'a1')).status).toBe(204)
    expect(await status('a1')).toBe(200)
  })

  it("a pull request's token writes its head branch, read only by naming it", async () => {
    const pr = await sign({
      event_name: 'pull_request',
      ref: 'refs/pull/7/merge',
      head_ref: 'feature',
      ref_protected: 'false',
    })
    expect((await put(pr, 'b2')).status).toBe(204)
    expect(await status('b2')).toBe(404)
    expect(await status('b2', 'refs/heads/feature')).toBe(200)
  })

  it("a merge queue's token writes its base branch, and only by matching a rule", async () => {
    const SHA = 'a'.repeat(40)
    const queue = {
      event_name: 'merge_group',
      ref: `refs/heads/gh-readonly-queue/main/pr-12-${SHA}`,
      ref_protected: 'true',
    }
    expect((await put(await sign(queue), 'e5')).status).toBe(204)
    expect(await status('e5')).toBe(200)
    // Another event on the same ref matches no rule: main is protected.
    expect(
      (await put(await sign({ ...queue, event_name: 'workflow_dispatch' }), 'e6')).status,
    ).toBe(403)
    // Only the exact pattern is stripped.
    const near = { ...queue, ref: 'refs/heads/gh-readonly-queue/main/pr-12-xyz' }
    expect((await put(await sign(near), 'e7')).status).toBe(204)
    expect(await status('e7')).toBe(404)
    expect(await status('e7', near.ref)).toBe(200)
  })

  it('a job matching no rule on a protected ref writes nothing', async () => {
    const res = await put(await sign({ ...MAIN, event_name: 'workflow_dispatch' }), 'c3')
    expect(await detail(res)).toEqual([403, 'this token reads only'])
    const pr = await sign({
      event_name: 'pull_request',
      head_ref: 'main',
      ref: 'refs/pull/8/merge',
    })
    expect((await put(pr, 'c3')).status).toBe(403)
    expect(await status('c3')).toBe(404)
  })

  it('refuses another repository, another audience and a forged signature', async () => {
    expect(await detail(await put(await sign({ ...MAIN, repository: '9' }), 'd4'))).toEqual([
      403,
      "repository 9 is not in this server's TRUST",
    ])
    expect(await detail(await put(await sign(MAIN, 'https://elsewhere'), 'd4'))).toEqual([
      401,
      'wrong audience',
    ])
    const [h, p] = (await sign(MAIN)).split('.')
    const forged = `${h}.${p}.${'A'.repeat(342)}`
    expect(await detail(await put(forged, 'd4'))).toEqual([401, 'bad signature'])
  })
})

describe('a server that trusts no CI', () => {
  it('refuses every request while it trusts no CI', async () => {
    const none = createCacheServer({
      blobs: memBlobs(),
      authorize: oidcAuth({ trust: [] }),
    })
    const res = await none(new Request(`${AUD}/v1/artifacts/abc`))
    expect(await detail(res)).toEqual([401, 'the server trusts no CI: set TRUST'])
  })
})
