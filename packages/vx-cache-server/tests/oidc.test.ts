// CI OIDC tokens: the token alone decides where a write lands (PROTOCOL.md
// § Tokens), against keys served without a network.

import { Database } from 'bun:sqlite'
import { beforeAll, describe, expect, it } from 'bun:test'
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from 'jose'
import { parseTokens, sha256, tokenAuth } from '../src/auth.js'
import { anyAuth, oidcAuth, parseTrust } from '../src/oidc.js'
import { createCacheServer } from '../src/server.js'

const GITHUB = 'https://token.actions.githubusercontent.com'
const AUD = 'https://cache.example.com'
const READ = 'read-token'
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
    db: {
      all: async <T>(sql: string, p: readonly unknown[]) =>
        db.query(sql).all(...(p as never[])) as T[],
      run: async (sql, p) => db.query(sql).run(...(p as never[])).changes,
      batch: async (s) => s.forEach((x) => db.run(x)),
    },
    authorize: anyAuth(
      tokenAuth(parseTokens(`read:${await sha256(READ)}`)),
      oidcAuth({
        trust,
        audience: AUD,
        fetchJson: async (url) =>
          url.endsWith('/.well-known/openid-configuration')
            ? { jwks_uri: `${GITHUB}/keys` }
            : { keys: [jwk] },
      }),
    ),
  })
})

const put = (token: string, key: string) =>
  handle(
    new Request(`${AUD}/v1/artifacts/${key}`, {
      method: 'PUT',
      body: 'x',
      headers: { authorization: `Bearer ${token}`, 'content-length': '1' },
    }),
  )
const head = (key: string, refs?: string) =>
  handle(
    new Request(`${AUD}/v1/artifacts/${key}`, {
      method: 'HEAD',
      headers: {
        authorization: `Bearer ${READ}`,
        ...(refs === undefined ? {} : { 'x-artifact-read-scopes': refs }),
      },
    }),
  ).then((r) => r.status)
const detail = async (res: Response) =>
  [res.status, ((await res.json()) as { message: string }).message] as const

const MAIN = { event_name: 'push', ref: 'refs/heads/main', ref_protected: 'true' }

describe('CI OIDC tokens', () => {
  it('a token matching a rule writes trusted, which every read sees', async () => {
    expect((await put(await sign(MAIN), 'a1')).status).toBe(202)
    expect(await head('a1')).toBe(200)
  })

  it("a pull request's token writes its head branch, read only by naming it", async () => {
    const pr = await sign({
      event_name: 'pull_request',
      ref: 'refs/pull/7/merge',
      head_ref: 'feature',
      ref_protected: 'false',
    })
    expect((await put(pr, 'b2')).status).toBe(202)
    expect(await head('b2')).toBe(404)
    expect(await head('b2', '"refs/heads/feature", "refs/heads/main"')).toBe(200)
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
    expect(await head('c3', '"refs/heads/main"')).toBe(404)
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

describe('parseTrust', () => {
  it('takes rules naming the repository and the refs they trust, and nothing less', () => {
    expect(parseTrust('')).toEqual([])
    expect(() => parseTrust('{}')).toThrow('not a JSON list of rules')
    expect(() => parseTrust('[{"iss":"http://x","project_id":"1","ref_path":"r"}]')).toThrow(
      'rule 0: iss is not an https:// issuer',
    )
    expect(() => parseTrust(`[{"iss":"${GITHUB}","ref":"refs/heads/main"}]`)).toThrow(
      'rule 0: names no repository_id (one repository, no *)',
    )
    expect(() => parseTrust(`[{"iss":"${GITHUB}","repository_id":"4*","ref":"r"}]`)).toThrow(
      'rule 0: names no repository_id (one repository, no *)',
    )
    expect(() => parseTrust('[{"iss":"https://gitlab.com","project_id":"1"}]')).toThrow(
      'rule 0: names no ref_path (the refs it trusts)',
    )
    expect(() =>
      parseTrust(`[{"iss":"${GITHUB}","repository_id":"4","ref":"r","event_name":[]}]`),
    ).toThrow('rule 0: event_name is not a string or a list of them')
  })
})
