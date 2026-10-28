// turboCache({ oidc }): a GitHub Actions job's OIDC token exchanged for a
// short-lived cache token at open, revoked at teardown (2026-10-17;
// Vercel's flow as vercel/setup-turborepo-remote-cache-action runs it).
// Driven through a stub `fetch` standing in for GitHub, the exchange and
// the cache: nothing binds a port.
import { describe, expect, it } from 'bun:test'
import type { RemoteOpenContext } from '@vzn/vx'
import {
  resolveTurboCacheConfig,
  TurboRemoteCache,
  type TurboCacheOptions,
} from '../src/turbo-cache/index.js'

const GITHUB = 'https://pipelines.actions.example/idtoken?api-version=2.0'
const GH_ENV = {
  GITHUB_ACTIONS: 'true',
  ACTIONS_ID_TOKEN_REQUEST_URL: GITHUB,
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'gh-bearer',
}

interface Seen {
  url: string
  method: string
  auth: string | undefined
  form: Record<string, string> | undefined
}

function world(answer: (url: URL, attempt: number) => Response | undefined = () => undefined) {
  const seen: Seen[] = []
  const tries = new Map<string, number>()
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const u = new URL(url)
    const headers = (init.headers ?? {}) as Record<string, string>
    seen.push({
      url,
      method: init.method ?? 'GET',
      auth: headers['Authorization'],
      form:
        typeof init.body === 'string' && headers['Content-Type']?.includes('form')
          ? Object.fromEntries(new URLSearchParams(init.body))
          : undefined,
    })
    const n = (tries.get(u.pathname) ?? 0) + 1
    tries.set(u.pathname, n)
    const custom = answer(u, n)
    if (custom !== undefined) return custom
    if (u.pathname === '/idtoken') return Response.json({ value: 'gh-jwt' })
    if (u.pathname.endsWith('/oauth/token')) return Response.json({ access_token: 'short-lived' })
    if (u.pathname.endsWith('/revoke')) return new Response(null, { status: 200 })
    return new Response(null, { status: 404 })
  }) as unknown as typeof fetch
  return { fetchImpl, seen }
}

function ctx() {
  const warned: string[] = []
  const asked: string[] = []
  const c: RemoteOpenContext = {
    ci: true,
    warn: (m) => warned.push(m),
    async secret({ key }) {
      asked.push(key)
      throw Object.assign(new Error('none'), { name: 'SecretUnavailable', reason: 'no-terminal' })
    },
    async forgetSecret() {},
  }
  return { c, warned, asked }
}

const cache = (
  options: TurboCacheOptions,
  env: Record<string, string>,
  fetchImpl: typeof fetch,
  local: { token?: string } = {},
) =>
  new TurboRemoteCache(
    resolveTurboCacheConfig({ teamSlug: 'acme', ...options }, env, {}, local)!,
    fetchImpl,
    undefined,
    async () => {},
  )
const message = (p: Promise<unknown>) =>
  p.then(
    () => '(resolved)',
    (e: unknown) => (e as Error).message,
  )

describe('the exchange, Vercel’s defaults', () => {
  it('GitHub’s ID token, then RFC 8693 with Vercel’s client and team; every request carries the short-lived token', async () => {
    const w = world()
    const c = cache(
      { oidc: { audience: 'vercel', params: { policy_id: 'pol_1' } } },
      GH_ENV,
      w.fetchImpl,
    )
    await c.open(ctx().c)
    await c.has('aa')
    expect(w.seen[0]).toEqual({
      url: `${GITHUB}&audience=vercel`,
      method: 'GET',
      auth: 'bearer gh-bearer',
      form: undefined,
    })
    expect(w.seen[1]!.url).toBe('https://api.vercel.com/login/oauth/token')
    expect(w.seen[1]!.form).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: 'gh-jwt',
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      client_id: 'cl_kyUx2zVvA4MGptBohkmtYHJly2XltXzD',
      team_id_or_slug: 'acme',
      policy_id: 'pol_1',
    })
    expect(w.seen[2]!.url.startsWith('https://vercel.com/api/v8/artifacts/aa')).toBe(true)
    expect(w.seen[2]!.auth).toBe('Bearer short-lived')
  })

  it('teardown’s revoke is RFC 7009 with the client and the token, once', async () => {
    const w = world()
    const c = cache({ oidc: true }, GH_ENV, w.fetchImpl)
    await c.open(ctx().c)
    await c.revoke()
    await c.revoke()
    const revokes = w.seen.filter((s) => s.url.endsWith('/revoke'))
    expect(revokes).toHaveLength(1)
    expect(revokes[0]!.url).toBe('https://api.vercel.com/login/oauth/token/revoke')
    expect(revokes[0]!.form).toEqual({
      client_id: 'cl_kyUx2zVvA4MGptBohkmtYHJly2XltXzD',
      token: 'short-lived',
      token_type_hint: 'access_token',
    })
  })

  it('a 503 and a dropped connection are tried again, three tries in all', async () => {
    const w = world((u, n) => {
      if (u.pathname === '/idtoken' && n === 1) return new Response(null, { status: 503 })
      if (u.pathname.endsWith('/oauth/token') && n < 3) throw new Error('socket hang up')
      return undefined
    })
    const c = cache({ oidc: true }, GH_ENV, w.fetchImpl)
    await c.open(ctx().c)
    expect(w.seen.map((s) => new URL(s.url).pathname)).toEqual([
      '/idtoken',
      '/idtoken',
      '/login/oauth/token',
      '/login/oauth/token',
      '/login/oauth/token',
    ])
  })
})

describe('precedence: option, TURBO_TOKEN, OIDC, config file, keychain', () => {
  it('a token option or TURBO_TOKEN wins: nothing exchanged', async () => {
    for (const [options, env] of [
      [{ oidc: true, token: 'opt' }, GH_ENV],
      [{ oidc: true }, { ...GH_ENV, TURBO_TOKEN: 'env' }],
    ] as const) {
      const w = world()
      const c = cache(options, env, w.fetchImpl)
      await c.open(ctx().c)
      await c.has('aa')
      expect(w.seen.map((s) => new URL(s.url).host)).toEqual(['vercel.com'])
    }
  })

  it('OIDC wins over .turbo/config.json', async () => {
    const w = world()
    const c = cache({ oidc: true }, GH_ENV, w.fetchImpl, { token: 'file' })
    await c.open(ctx().c)
    await c.has('aa')
    expect(w.seen.at(-1)!.auth).toBe('Bearer short-lived')
  })

  it('on GitHub with no ID-token permission: one warning, then the config file’s token', async () => {
    const w = world()
    const k = ctx()
    const c = cache({ oidc: true }, { GITHUB_ACTIONS: 'true' }, w.fetchImpl, { token: 'file' })
    await c.open(k.c)
    await c.has('aa')
    expect(k.warned).toEqual([
      'oidc: GitHub gave this job no OIDC token: it needs `permissions: id-token: write` (a fork or Dependabot pull request never gets one)',
    ])
    expect(w.seen.map((s) => s.auth)).toEqual(['Bearer file'])
  })

  it('off GitHub: no warning, the keychain', async () => {
    const k = ctx()
    const c = cache({ oidc: true }, {}, world().fetchImpl)
    await message(c.open(k.c))
    expect(k.warned).toEqual([])
    expect(k.asked).toEqual(['https://vercel.com/api/v8/artifacts#acme'])
  })
})

describe('a failed exchange leaves the run local, and says why without a token', () => {
  for (const [name, answer, why] of [
    [
      'GitHub refuses',
      (u: URL) => (u.pathname === '/idtoken' ? new Response('gh-jwt', { status: 403 }) : undefined),
      "GitHub's OIDC endpoint (pipelines.actions.example) answered HTTP 403",
    ],
    [
      'the exchange refuses',
      (u: URL) =>
        u.pathname.endsWith('/oauth/token')
          ? Response.json({ error: 'invalid_grant' }, { status: 400 })
          : undefined,
      'the token exchange (api.vercel.com) answered HTTP 400: invalid_grant',
    ],
    [
      // RFC 6749's error fields say why, and never carry a token.
      'the exchange refuses, saying why',
      (u: URL) =>
        u.pathname.endsWith('/oauth/token')
          ? Response.json(
              { error: 'invalid_grant', error_description: 'audience not allowed' },
              { status: 400 },
            )
          : undefined,
      'the token exchange (api.vercel.com) answered HTTP 400: invalid_grant: audience not allowed',
    ],
    [
      'GitHub refuses, saying why',
      (u: URL) =>
        u.pathname === '/idtoken'
          ? Response.json(
              { message: 'Unable to get ACTIONS_ID_TOKEN_REQUEST_URL' },
              { status: 403 },
            )
          : undefined,
      "GitHub's OIDC endpoint (pipelines.actions.example) answered HTTP 403: Unable to get ACTIONS_ID_TOKEN_REQUEST_URL",
    ],
    [
      'the exchange sends no token',
      (u: URL) => (u.pathname.endsWith('/oauth/token') ? Response.json({}) : undefined),
      'the token exchange (api.vercel.com) sent no access_token',
    ],
  ] as const) {
    it(name, async () => {
      const w = world(answer)
      const c = cache({ oidc: true }, GH_ENV, w.fetchImpl)
      const msg = await message(c.open(ctx().c))
      expect(msg).toBe(`oidc: ${why}; local cache only this run`)
      expect(msg).not.toContain('gh-bearer')
      expect(msg).not.toContain('gh-jwt')
      expect(await c.has('aa')).toBeNull()
      await c.revoke()
      expect(w.seen.some((s) => s.url.endsWith('/revoke'))).toBe(false)
    })
  }

  it('a revoke the server refuses throws for teardown’s warning, quoting no token', async () => {
    const w = world((u) =>
      u.pathname.endsWith('/revoke')
        ? Response.json({ error: 'server_error' }, { status: 500 })
        : undefined,
    )
    const c = cache({ oidc: true }, GH_ENV, w.fetchImpl)
    await c.open(ctx().c)
    expect(await message(c.revoke())).toBe(
      'revoking at api.vercel.com answered HTTP 500: server_error',
    )
  })
})

describe('another server', () => {
  it('needs its tokenUrl, and revokes only where revokeUrl names it', async () => {
    expect(() =>
      resolveTurboCacheConfig({ apiUrl: 'https://cache.example', oidc: true }, GH_ENV),
    ).toThrow("vx/turbo-cache: oidc needs tokenUrl for a cache that is not Vercel's")
    const w = world()
    const c = cache(
      {
        apiUrl: 'https://cache.example',
        oidc: { tokenUrl: 'https://auth.example/oauth/token', params: { resource: 'cache' } },
      },
      GH_ENV,
      w.fetchImpl,
    )
    await c.open(ctx().c)
    expect(w.seen[1]!.form).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: 'gh-jwt',
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      resource: 'cache',
    })
    await c.revoke()
    expect(w.seen.some((s) => s.url.endsWith('/revoke'))).toBe(false)
  })

  it('Vercel with revokeUrl: false revokes nothing; Vercel with no team is refused', async () => {
    const w = world()
    const c = cache({ oidc: { revokeUrl: false } }, GH_ENV, w.fetchImpl)
    await c.open(ctx().c)
    await c.revoke()
    expect(w.seen.some((s) => s.url.endsWith('/revoke'))).toBe(false)
    expect(() => resolveTurboCacheConfig({ token: 't', oidc: true }, GH_ENV)).toThrow(
      'vx/turbo-cache: oidc on Vercel needs teamId or teamSlug (TURBO_TEAM)',
    )
  })

  it('a layer never opened (a plan, a remote-off run) exchanges nothing', async () => {
    const w = world()
    const c = cache({ oidc: true }, GH_ENV, w.fetchImpl)
    expect(await c.has('aa')).toBeNull()
    await c.revoke()
    expect(w.seen).toEqual([])
  })
})

// A run whose tasks run on agents lends them its exchanged token
// (`RemoteCacheLayer.lend`); an agent with no access of its own reads it per
// request (`CacheContext.lent`), so one lent again replaces the last.
describe('lending: a run’s exchanged token to the machines that run its tasks', () => {
  it('lends the exchanged token, and exchanges a new one when it ends within five minutes', async () => {
    let ttl = 3600
    const w = world((u) =>
      u.pathname.endsWith('/oauth/token')
        ? Response.json({ access_token: `t${w.seen.length}`, expires_in: ttl })
        : undefined,
    )
    const c = cache({ oidc: true }, GH_ENV, w.fetchImpl)
    await c.open(ctx().c)
    const first = await c.lend()
    expect(first).toEqual({ token: 't2', expiresAt: expect.any(Number) })
    expect(await c.lend()).toEqual(first)
    ttl = 60
    const c2 = cache({ oidc: true }, GH_ENV, w.fetchImpl)
    await c2.open(ctx().c)
    const again = await c2.lend()
    expect(again!.token).not.toBe(first!.token)
    expect(await c2.lend()).not.toEqual(again)
    await c2.revoke()
    expect(w.seen.filter((s) => s.url.endsWith('/revoke'))).toHaveLength(3)
  })

  it('never lends a token it was given', async () => {
    const c = cache({ oidc: true }, { ...GH_ENV, TURBO_TOKEN: 'mine' }, world().fetchImpl)
    await c.open(ctx().c)
    expect(await c.lend()).toBeUndefined()
  })

  it('an agent with no access of its own sends the lent token, the latest each request', async () => {
    const w = world()
    const c = cache({}, {}, w.fetchImpl)
    let lent = 'lent-1'
    c.lent = () => lent
    const o = ctx()
    await c.open(o.c)
    await c.has('aa')
    lent = 'lent-2'
    await c.has('bb')
    expect(w.seen.map((s) => s.auth)).toEqual(['Bearer lent-1', 'Bearer lent-2'])
    expect(o.asked).toEqual([])
  })

  it('an agent with its own token uses it; one with only OIDC sends the lent one', async () => {
    // The server files a write by its token: an agent's own OIDC (its own
    // workflow and ref) filed every task where the run could not read it.
    const w = world()
    const own = cache({}, { TURBO_TOKEN: 'mine' }, w.fetchImpl)
    own.lent = () => 'lent'
    await own.open(ctx().c)
    await own.has('aa')
    const oidc = cache({ oidc: true }, GH_ENV, w.fetchImpl)
    oidc.lent = () => 'lent'
    await oidc.open(ctx().c)
    await oidc.has('bb')
    expect(w.seen.map((s) => s.url.includes('/oauth/token'))).not.toContain(true)
    expect(w.seen.filter((s) => s.url.includes('/v8/artifacts/')).map((s) => s.auth)).toEqual([
      'Bearer mine',
      'Bearer lent',
    ])
    expect(await oidc.lend()).toBeUndefined()
  })
})
