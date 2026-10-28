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
let jwk: Record<string, unknown>
let key: CryptoKey

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  key = privateKey
  jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' }
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

  // The claim was cut at its first `@`, so a workflow file with one in its
  // name (`ci@x.yml`) was refused whatever ALLOW said.
  it('admits a job of a workflow file whose name holds an @', async () => {
    const at = createCacheServer({
      blobs: memBlobs(),
      authorize: oidcAuth({
        allow: parseAllow(`${GITHUB}:acme/app:ci@x.yml`),
        audience: AUD,
        fetchJson: async (url) =>
          url.endsWith('/.well-known/openid-configuration')
            ? { jwks_uri: `${GITHUB}/keys` }
            : { keys: [jwk] },
      }),
    })
    const token = await sign({
      ...MAIN,
      job_workflow_ref: 'acme/app/.github/workflows/ci@x.yml@refs/heads/main',
    })
    const res = await at(
      new Request(`${AUD}/v1/artifacts/e2`, {
        method: 'PUT',
        body: 'x',
        headers: { ...NAMED, authorization: `Bearer ${token}`, 'content-length': '1' },
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

  // A token with no exp was refused as "not a JWT", which named nothing to fix.
  it('refuses a token with no exp, naming the claim', async () => {
    const noExp = await new SignJWT({
      ...MAIN,
      repository: 'acme/app',
      job_workflow_ref: 'acme/app/.github/workflows/ci.yml@refs/heads/main',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(GITHUB)
      .setAudience(AUD)
      .sign(key)
    expect(await detail(await put(noExp, 'a9'))).toEqual([401, 'no exp claim'])
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
    expect(await detail(await put(await sign(MAIN, 'https://elsewhere'), 'd4'))).toEqual([
      401,
      'wrong audience',
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

describe('a server that admits no CI', () => {
  it('refuses every request while ALLOW is empty', async () => {
    const none = createCacheServer({
      blobs: memBlobs(),
      authorize: oidcAuth({ allow: [] }),
    })
    const res = await none(new Request(`${AUD}/v1/artifacts/abc`))
    expect(await detail(res)).toEqual([401, 'the server admits no CI: set ALLOW'])
  })
})

// A 401 tells vx-cache its token is refused, and it turned the remote cache
// off for the run when only the issuer's keys could not be fetched.
it("answers 502 while the issuer's keys cannot be read, never 401", async () => {
  // `garbled`: the keys answered as JSON that is no key set (a proxy's error page).
  for (const down of ['/.well-known/openid-configuration', '/keys', 'garbled']) {
    const other = createCacheServer({
      blobs: memBlobs(),
      authorize: oidcAuth({
        allow,
        audience: AUD,
        fetchJson: async (url) => {
          if (url.endsWith(down)) throw new Error(`${url}: 503`)
          return url.endsWith('/keys') && down === 'garbled'
            ? { message: 'upstream unavailable' }
            : { jwks_uri: `${GITHUB}/keys` }
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

// A fork's merge request pipeline runs in the parent project with the
// fork's branch as its `ref_path`: a fork's branch `main` wrote main.
describe('GitLab merge request pipelines', () => {
  const GITLAB = 'https://gitlab.com'
  const AT = { 'vx-issuer': scopeOf(GITLAB), 'vx-repository': scopeOf('acme/app') }
  let lab: (claims: JWTPayload) => Promise<string>
  let h: (req: Request) => Promise<Response>
  beforeAll(async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256')
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' }
    lab = (claims) =>
      new SignJWT({
        project_path: 'acme/app',
        ci_config_ref_uri: 'gitlab.com/acme/app//.gitlab-ci.yml@refs/heads/main',
        ...claims,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(GITLAB)
        .setAudience(AUD)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey)
    h = createCacheServer({
      blobs: memBlobs(),
      authorize: oidcAuth({
        allow: parseAllow(`${GITLAB}:acme/app:.gitlab-ci.yml`),
        audience: AUD,
        fetchJson: async (url) =>
          url.endsWith('/.well-known/openid-configuration')
            ? { jwks_uri: `${GITLAB}/keys` }
            : { keys: [jwk] },
      }),
    })
  })
  const write = (token: string, key: string) =>
    h(
      new Request(`${AUD}/v1/artifacts/${key}`, {
        method: 'PUT',
        body: 'x',
        headers: { ...AT, authorization: `Bearer ${token}`, 'content-length': '1' },
      }),
    )
  const held = (token: string, key: string, ref: string) =>
    h(
      new Request(`${AUD}/v1/artifacts/${key}`, {
        headers: { ...AT, authorization: `Bearer ${token}`, 'vx-scope': scopeOf(ref) },
      }),
    ).then(async (r) => (await r.arrayBuffer(), r.status))
  const MR = { pipeline_source: 'merge_request_event', job_project_path: 'acme/app' }

  it("a fork's merge request writes nothing, nor one naming no source project", async () => {
    const fork = await lab({ ...MR, source_project_path: 'eve/app', ref_path: 'refs/heads/main' })
    expect(await detail(await write(fork, 'b1'))).toEqual([403, 'this request reads only'])
    const unnamed = await lab({ ...MR, ref_path: 'refs/heads/main' })
    expect(await detail(await write(unnamed, 'b2'))).toEqual([403, 'this request reads only'])
    const main = await lab({ pipeline_source: 'push', ref_path: 'refs/heads/main' })
    expect(await held(main, 'b1', 'refs/heads/main')).toBe(404)
    expect(await held(main, 'b2', 'refs/heads/main')).toBe(404)
  })

  it("the project's own merge request writes its source branch", async () => {
    const own = await lab({
      ...MR,
      source_project_path: 'Acme/App',
      ref_path: 'refs/heads/feature',
    })
    expect((await write(own, 'b3')).status).toBe(204)
    expect(await held(own, 'b3', 'refs/heads/feature')).toBe(200)
  })
})

describe('GitLab CI tokens', () => {
  const GITLAB = 'https://gitlab.example.com'
  const named = { 'vx-issuer': scopeOf(GITLAB), 'vx-repository': scopeOf('acme/app') }
  const server = async (allowVar: string) => {
    const { privateKey, publicKey } = await generateKeyPair('RS256')
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' }
    const h = createCacheServer({
      blobs: memBlobs(),
      authorize: oidcAuth({
        allow: parseAllow(allowVar),
        audience: AUD,
        fetchJson: async (url) =>
          url.endsWith('/.well-known/openid-configuration')
            ? { jwks_uri: `${GITLAB}/oauth/discovery/keys` }
            : { keys: [jwk] },
      }),
    })
    return async (config = '.gitlab-ci.yml') => {
      const token = await new SignJWT({
        project_path: 'acme/app',
        ci_config_ref_uri: `gitlab.example.com/acme/app//${config}@refs/heads/main`,
        ref_path: 'refs/heads/main',
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(GITLAB)
        .setAudience(AUD)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey)
      return h(
        new Request(`${AUD}/v1/artifacts/ab`, {
          method: 'PUT',
          body: 'x',
          headers: { ...named, authorization: `Bearer ${token}`, 'content-length': '1' },
        }),
      )
    }
  }

  // An issuer written with a trailing slash admitted public reads, but
  // refused every token: its `iss` names none.
  it('admits a token of an issuer ALLOW names with a trailing slash', async () => {
    const put = await server(`${GITLAB}/:acme/app:.gitlab-ci.yml`)
    expect((await put()).status).toBe(204)
  })

  // A project's CI file may live in another project, `.gitlab-ci.yml@acme/ci`:
  // the claim was cut at its first `@`, so no ALLOW entry could name it.
  it('matches a CI file kept in another project, ref and all', async () => {
    const put = await server(`${GITLAB}:acme/app:.gitlab-ci.yml@acme/ci`)
    expect((await put('.gitlab-ci.yml@acme/ci')).status).toBe(204)
    expect(await detail(await put())).toEqual([
      403,
      "ci_config_ref_uri gitlab.example.com/acme/app//.gitlab-ci.yml is not in this server's ALLOW",
    ])
    const own = await server(`${GITLAB}:acme/app:.gitlab-ci.yml`)
    expect(await detail(await own('.gitlab-ci.yml@acme/ci'))).toEqual([
      403,
      "ci_config_ref_uri gitlab.example.com/acme/app//.gitlab-ci.yml@acme/ci is not in this server's ALLOW",
    ])
  })
})
