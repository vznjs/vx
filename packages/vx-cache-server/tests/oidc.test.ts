// CI OIDC tokens: the token alone decides where a write lands (PROTOCOL.md
// § Tokens), against keys served without a network.

import { Database } from 'bun:sqlite'
import { beforeAll, describe, expect, it } from 'bun:test'
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from 'jose'
import { oidcAuth, parseTrust } from '@vzn/vx-devtools'
import { createCacheServer } from '../src/server.js'
import { sqliteStore } from '../src/store.js'
import { upload } from './upload.js'

const GITHUB = 'https://token.actions.githubusercontent.com'
const AUD = 'https://cache.example.com'
const trust = parseTrust(
  JSON.stringify([
    {
      iss: GITHUB,
      repository_id: '42',
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
    new SignJWT({ repository_id: '42', ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(GITHUB)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
  const db = new Database(':memory:', { strict: true })
  const blobs = new Map<string, Uint8Array>()
  handle = createCacheServer({
    blobs: {
      async put(name, body) {
        blobs.set(name, new Uint8Array(await new Response(body).arrayBuffer()))
      },
      get: async (name) => (blobs.has(name) ? new Blob([blobs.get(name)!]) : null),
      delete: async (name) => void blobs.delete(name),
    },
    store: sqliteStore({
      all: async <T>(sql: string, p: readonly unknown[]) =>
        db.query(sql).all(...(p as never[])) as T[],
      run: async (sql, p) => db.query(sql).run(...(p as never[])).changes,
      batch: async (s) => s.forEach((x) => db.run(x)),
    }),
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
  handle(new Request(`${AUD}/v1/artifacts/upload`, upload([[key, 'x']], token)))
const status = (key: string, refs?: string) =>
  handle(
    new Request(`${AUD}/v1/artifacts/download/${key}`, {
      headers: {
        authorization: `Bearer ${read}`,
        ...(refs === undefined ? {} : { 'x-artifact-read-scopes': refs }),
      },
    }),
  ).then(async (r) => (await r.arrayBuffer(), r.status))
const detail = async (res: Response) =>
  [res.status, ((await res.json()) as { message: string }).message] as const

const MAIN = { event_name: 'push', ref: 'refs/heads/main', ref_protected: 'true' }

describe('CI OIDC tokens', () => {
  it('a token matching a rule writes trusted, which every read sees', async () => {
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
    expect(await status('b2', '"refs/heads/feature", "refs/heads/main"')).toBe(200)
  })

  it("an untrusted job on a trusted ref writes nothing: main's reads would find it first", async () => {
    const res = await put(await sign({ ...MAIN, event_name: 'workflow_dispatch' }), 'c3')
    expect(await detail(res)).toEqual([403, 'this token reads only'])
    const pr = await sign({
      event_name: 'pull_request',
      head_ref: 'main',
      ref: 'refs/pull/8/merge',
    })
    expect((await put(pr, 'c3')).status).toBe(403)
    expect(await status('c3', '"refs/heads/main"')).toBe(404)
  })

  it('refuses another repository, another audience and a forged signature', async () => {
    expect(await detail(await put(await sign({ ...MAIN, repository_id: '9' }), 'd4'))).toEqual([
      403,
      "repository_id 9 is not in this server's TRUST",
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
      blobs: { put: async () => {}, get: async () => null, delete: async () => {} },
      store: sqliteStore({ all: async () => [], run: async () => 0, batch: async () => {} }),
      authorize: oidcAuth({ trust: [] }),
    })
    const res = await none(new Request(`${AUD}/v1/artifacts/download/abc`))
    expect(await detail(res)).toEqual([401, 'the server trusts no CI: set TRUST'])
  })
})
