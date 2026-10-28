// CI OIDC tokens: the token alone decides where a write lands (PROTOCOL.md
// § Tokens), against keys served without a network.

import { beforeAll, describe, expect, it } from 'bun:test'
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from 'jose'
import { oidcAuth, parseAllow } from '@vzn/vx-devtools'
import { createCacheServer } from '../src/server.js'
import { scopeOf } from './conformance.js'
import { NAMED } from './issuer.js'
import { memBlobs } from './mem-blobs.js'

const GITHUB = 'https://token.actions.githubusercontent.com'
const AUD = 'https://cache.example.com'
// A name, matched whatever its case (2026-10-25: org/name, not id).
const allow = parseAllow(`${GITHUB}:Acme/App:ci.yml`)

let sign: (claims: JWTPayload, aud?: string) => Promise<string>
let handle: (req: Request) => Promise<Response>
let read: string
let jwks: { keys: unknown[] }

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' }
  jwks = { keys: [jwk] }
  sign = (claims, aud = AUD) =>
    new SignJWT({
      repository: 'acme/app',
      job_workflow_ref: 'acme/app/.github/workflows/ci.yml@refs/heads/main',
      ...claims,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(GITHUB)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
  handle = createCacheServer({
    blobs: memBlobs(),
    authorize: oidcAuth({
      allow,
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
      headers: { ...NAMED, authorization: `Bearer ${token}`, 'content-length': '1' },
    }),
  )
const status = (key: string, ref = 'refs/heads/main') =>
  handle(
    new Request(`${AUD}/v1/artifacts/${key}`, {
      headers: { ...NAMED, authorization: `Bearer ${read}`, 'vx-scope': scopeOf(ref) },
    }),
  ).then(async (r) => (await r.arrayBuffer(), r.status))
const detail = async (res: Response) =>
  [res.status, ((await res.json()) as { message: string }).message] as const

const MAIN = { event_name: 'push', ref: 'refs/heads/main' }

describe('CI OIDC tokens', () => {
  it('a job of a workflow ALLOW names writes the ref it runs on', async () => {
    expect((await put(await sign(MAIN), 'a1')).status).toBe(204)
    expect(await status('a1')).toBe(200)
  })

  it("a pull request's token writes its head branch, read only by naming it", async () => {
    const pr = await sign({
      event_name: 'pull_request',
      ref: 'refs/pull/7/merge',
      head_ref: 'feature',
    })
    expect((await put(pr, 'b2')).status).toBe(204)
    expect(await status('b2')).toBe(404)
    expect(await status('b2', 'refs/heads/feature')).toBe(200)
  })

  it("a merge queue's token writes its base branch", async () => {
    const SHA = 'a'.repeat(40)
    const queue = {
      event_name: 'merge_group',
      ref: `refs/heads/gh-readonly-queue/main/pr-12-${SHA}`,
    }
    expect((await put(await sign(queue), 'e5')).status).toBe(204)
    expect(await status('e5')).toBe(200)
    // Only the exact pattern is stripped.
    const near = { ...queue, ref: 'refs/heads/gh-readonly-queue/main/pr-12-xyz' }
    expect((await put(await sign(near), 'e7')).status).toBe(204)
    expect(await status('e7')).toBe(404)
    expect(await status('e7', near.ref)).toBe(200)
  })

  // The queue's rename keyed on the ref alone: a push to a branch named
  // like a queue ref, or a pull request whose head branch was, wrote main.
  it('only a merge_group run writes its base branch', async () => {
    const queued = `gh-readonly-queue/main/pr-12-${'a'.repeat(40)}`
    const push = { event_name: 'push', ref: `refs/heads/${queued}` }
    expect((await put(await sign(push), 'a11')).status).toBe(204)
    expect(await status('a11')).toBe(404)
    expect(await status('a11', push.ref)).toBe(200)
    const pr = { event_name: 'pull_request', ref: 'refs/pull/7/merge', head_ref: queued }
    expect((await put(await sign(pr), 'a12')).status).toBe(204)
    expect(await status('a12')).toBe(404)
  })

  // A fork names its own head branch: a fork's branch `main` wrote main
  // wherever fork pull requests get a token.
  it("a pull request whose head branch is its base branch's name writes nothing", async () => {
    const pr = await sign({
      event_name: 'pull_request',
      ref: 'refs/pull/7/merge',
      head_ref: 'main',
      base_ref: 'main',
    })
    expect(await detail(await put(pr, 'a13'))).toEqual([403, 'this request reads only'])
    expect(await status('a13')).toBe(404)
  })

  // A pull_request_target run carries a fork's head_ref, named by the
  // fork: it wrote that branch's scope, so a fork poisoned a branch of the
  // same name (found 2026-10-26). Its ref is the base: a fork's code never
  // writes it either.
  it('a pull_request_target token writes nothing', async () => {
    const target = await sign({
      event_name: 'pull_request_target',
      ref: 'refs/heads/main',
      head_ref: 'feature',
    })
    expect(await detail(await put(target, 'f8'))).toEqual([403, 'this request reads only'])
    expect(await status('f8')).toBe(404)
    expect(await status('f8', 'refs/heads/feature')).toBe(404)
  })

  // An issue_comment run (a "/test" comment on a pull request) or a
  // workflow_run a pull request started carries main's ref while it may
  // check out the pull request's code: it wrote main's scope, so a fork's
  // code reached main's entries (#4570 dropped the event filter that
  // kept it out).
  it('an issue_comment or workflow_run token writes nothing', async () => {
    for (const event_name of ['issue_comment', 'workflow_run']) {
      const token = await sign({ event_name, ref: 'refs/heads/main' })
      expect(await detail(await put(token, 'f9'))).toEqual([403, 'this request reads only'])
      expect(await status('f9')).toBe(404)
    }
  })

  it('refuses a job of a workflow ALLOW does not name', async () => {
    const other = await sign({
      ...MAIN,
      job_workflow_ref: 'acme/app/.github/workflows/release.yml@refs/heads/main',
    })
    expect(await detail(await put(other, 'c3'))).toEqual([
      403,
      "job_workflow_ref acme/app/.github/workflows/release.yml is not in this server's ALLOW",
    ])
    expect(await status('c3')).toBe(404)
  })

  // An issuer's URL written with a trailing slash in ALLOW matched no
  // token's iss (which has none): every job was refused "an issuer this
  // server's ALLOW does not name".
  it('admits a job whatever trailing slash ALLOW gives its issuer', async () => {
    const slashed = createCacheServer({
      blobs: memBlobs(),
      authorize: oidcAuth({
        allow: parseAllow(`${GITHUB}/:acme/app:ci.yml`),
        audience: AUD,
        fetchJson: async (url) =>
          url.endsWith('/.well-known/openid-configuration') ? { jwks_uri: `${GITHUB}/keys` } : jwks,
      }),
    })
    const res = await slashed(
      new Request(`${AUD}/v1/artifacts/e1`, {
        method: 'PUT',
        body: 'x',
        headers: { ...NAMED, authorization: `Bearer ${await sign(MAIN)}`, 'content-length': '1' },
      }),
    )
    expect(res.status).toBe(204)
  })

  // A missing claim read as the text "undefined": the refusal named a
  // repository or workflow `undefined` instead of the claim to set.
  it('refuses a token missing its repository or workflow claim, naming the claim', async () => {
    const noRepo = await sign({ ...MAIN, repository: undefined })
    expect(await detail(await put(noRepo, 'a9'))).toEqual([403, 'no repository claim'])
    const noWorkflow = await sign({ ...MAIN, job_workflow_ref: undefined })
    expect(await detail(await put(noWorkflow, 'a9'))).toEqual([403, 'no job_workflow_ref claim'])
  })

  it('refuses another repository, another audience and a forged signature', async () => {
    expect(await detail(await put(await sign({ ...MAIN, repository: 'acme/9' }), 'd4'))).toEqual([
      403,
      "repository acme/9 is not in this server's ALLOW",
    ])
    // A token of a repository ALLOW names, sent naming another.
    const named = { ...NAMED, 'vx-repository': scopeOf('acme/other') }
    const res = await handle(
      new Request(`${AUD}/v1/artifacts/d4`, {
        headers: {
          ...named,
          authorization: `Bearer ${await sign(MAIN)}`,
          'vx-scope': scopeOf('refs/heads/main'),
        },
      }),
    )
    expect(await detail(res)).toEqual([
      403,
      'the token is of repository acme/app at https://token.actions.githubusercontent.com, not the repository named',
    ])
    // Behind a proxy that ends TLS the server is reached at http://: the
    // refusal names both, so the fix (AUDIENCE) is in the message.
    expect(await detail(await put(await sign(MAIN, 'https://elsewhere'), 'd4'))).toEqual([
      401,
      `wrong audience: the token names https://elsewhere, this server takes ${AUD} (AUDIENCE)`,
    ])
    const [h, p] = (await sign(MAIN)).split('.')
    const forged = `${h}.${p}.${'A'.repeat(342)}`
    expect(await detail(await put(forged, 'd4'))).toEqual([401, 'bad signature'])
  })
})

describe('READ_ACCESS=public', () => {
  const open = (readAccess?: string) =>
    createCacheServer({
      blobs: memBlobs(),
      authorize: oidcAuth({ allow, readAccess, fetchJson: async () => ({}) }),
    })
  const tokenless = (
    h: (req: Request) => Promise<Response>,
    named: Record<string, string>,
    init: RequestInit = {},
  ) =>
    h(
      new Request(`${AUD}/v1/artifacts/f1`, {
        ...init,
        headers: {
          ...named,
          'vx-scope': scopeOf('refs/heads/main'),
          ...(init.headers as Record<string, string>),
        },
      }),
    )

  // A chunked body names no length: it was read whole, however large,
  // before it was measured, by anyone a public server lets in (2026-10-26).
  it('refuses a check body past its limit as it arrives, unread', async () => {
    let pulled = 0
    const large = new ReadableStream<Uint8Array>({
      pull(c) {
        // 4 MB in all, so a read of the whole body ends, and fails below.
        if (++pulled > 64) return c.close()
        c.enqueue(new Uint8Array(64 * 1024).fill(32))
      },
    })
    const res = await open('public')(
      new Request(`${AUD}/v1/artifacts`, {
        method: 'POST',
        body: large,
        headers: { ...NAMED, 'content-type': 'application/json' },
      }),
    )
    expect(await detail(res)).toEqual([413, 'the body is at most 70100 bytes'])
    expect(pulled).toBeLessThan(10)
  })

  it('reads a repository ALLOW names with no token, and writes nothing', async () => {
    const h = open('public')
    expect((await tokenless(h, NAMED)).status).toBe(404)
    const write = await tokenless(h, NAMED, {
      method: 'PUT',
      body: 'x',
      headers: { 'content-length': '1' },
    })
    expect(await detail(write)).toEqual([403, 'this request reads only'])
    const other = await tokenless(h, { ...NAMED, 'vx-repository': scopeOf('acme/other') })
    expect(await detail(other)).toEqual([403, "the repository named is not in this server's ALLOW"])
  })

  it('takes no tokenless read unless set, and no value but public', async () => {
    expect(await detail(await tokenless(open(), NAMED))).toEqual([401, 'no bearer token'])
    expect(() => open('yes')).toThrow('READ_ACCESS: public, or unset, not yes')
  })
})

describe('a server whose ALLOW is empty', () => {
  it('refuses every request while ALLOW is empty', async () => {
    const none = createCacheServer({
      blobs: memBlobs(),
      authorize: oidcAuth({ allow: [] }),
    })
    const res = await none(new Request(`${AUD}/v1/artifacts/abc`))
    expect(await detail(res)).toEqual([
      401,
      'ALLOW is empty: set it to the CI workflows this server serves',
    ])
  })
})

// A 401 tells vx-cache its token is refused, and it turned the remote cache
// off for the run when only the issuer's keys could not be fetched.
it("answers 502 while the issuer's keys cannot be read, never 401", async () => {
  for (const down of ['/.well-known/openid-configuration', '/keys']) {
    const other = createCacheServer({
      blobs: memBlobs(),
      authorize: oidcAuth({
        allow,
        audience: AUD,
        fetchJson: async (url) => {
          if (url.endsWith(down)) throw new Error(`${url}: 503`)
          return { jwks_uri: `${GITHUB}/keys` }
        },
      }),
    })
    const res = await other(
      new Request(`${AUD}/v1/artifacts/abc`, {
        headers: {
          ...NAMED,
          authorization: `Bearer ${read}`,
          'vx-scope': scopeOf('refs/heads/main'),
        },
      }),
    )
    expect(await detail(res)).toEqual([502, `could not read ${GITHUB}'s keys`])
  }
})
