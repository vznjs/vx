// turboCache() and nxCache() read a missing token from core's plugin
// keychain (`ctx.secret`) last, after the option, the variable and the
// config files, from the layer's `open` alone (2026-10-17). A
// stand-in `ctx`: the real keychain is never touched.
import { describe, expect, it } from 'bun:test'
import type { RemoteOpenContext, SecretUnavailableReason } from '@vzn/vx'
import { NxRemoteCache, resolveNxCacheConfig } from '../src/nx-cache/index.js'
import { resolveTurboCacheConfig, TurboRemoteCache } from '../src/turbo-cache/index.js'

function keychain(
  initial: Record<string, string> = {},
  missing: SecretUnavailableReason = 'no-terminal',
) {
  const entries = new Map(Object.entries(initial))
  const calls: string[] = []
  const ctx: RemoteOpenContext = {
    ci: false,
    warn: (m) => calls.push(`warn ${m}`),
    async secret({ key, prompt }) {
      calls.push(`secret ${key} | ${prompt}`)
      const v = entries.get(key)
      if (v !== undefined) return v
      throw Object.assign(new Error(`secret '${key}' unavailable`), {
        name: 'SecretUnavailable',
        reason: missing,
      })
    },
    async forgetSecret({ key }) {
      calls.push(`forget ${key}`)
      entries.delete(key)
    },
  }
  return { ctx, calls, entries }
}

function server(status = 200) {
  const auth: (string | undefined)[] = []
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    auth.push((init.headers as Record<string, string>)['Authorization'])
    return new Response(null, { status })
  }) as unknown as typeof fetch
  return { fetchImpl, auth }
}

const API = 'https://remote.cachely.dev'
const KEY = `${API}/v8/artifacts#cachely`
const PROMPT = 'Token for remote.cachely.dev (cachely), saved to the OS keychain: '
const turbo = (
  env: Record<string, string>,
  fetchImpl: typeof fetch,
  options: { token?: string } = {},
  local: { token?: string } = {},
) =>
  new TurboRemoteCache(
    resolveTurboCacheConfig({ url: API, teamSlug: 'cachely', ...options }, env, {}, local)!,
    fetchImpl,
  )
const message = (p: Promise<unknown>) =>
  p.then(
    () => '(resolved)',
    (e: unknown) => (e as Error).message,
  )

describe('turboCache(): option, env, config file, then the keychain', () => {
  for (const [source, env, options, local] of [
    ['the option', { TURBO_TOKEN: 'env' }, { token: 'opt' }, { token: 'file' }],
    ['TURBO_TOKEN', { TURBO_TOKEN: 'env' }, {}, { token: 'file' }],
    ['.turbo/config.json', {}, {}, { token: 'file' }],
  ] as const) {
    it(`${source} wins and the keychain is never read`, async () => {
      const k = keychain({ [KEY]: 'kc' })
      const srv = server()
      const c = turbo(env, srv.fetchImpl, options, local)
      await c.open(k.ctx)
      await c.has('aa')
      expect(k.calls).toEqual([])
      expect(srv.auth[0]).toBe(`Bearer ${options.token ?? env.TURBO_TOKEN ?? local.token}`)
    })
  }

  it('none of them: the keychain entry, keyed by endpoint and team, with a prompt', async () => {
    const k = keychain({ [KEY]: 'kc' })
    const srv = server()
    const c = turbo({}, srv.fetchImpl)
    await c.open(k.ctx)
    await c.has('aa')
    expect(k.calls).toEqual([`secret ${KEY} | ${PROMPT}`])
    expect(srv.auth).toEqual(['Bearer kc'])
  })

  it('an empty TURBO_TOKEN (a fork’s missing secret) is no token', async () => {
    const k = keychain({ [KEY]: 'kc' })
    const srv = server()
    const c = turbo({ TURBO_TOKEN: '' }, srv.fetchImpl)
    await c.open(k.ctx)
    await c.has('aa')
    expect(srv.auth).toEqual(['Bearer kc'])
  })

  it('a layer never opened (a plan, a remote-off run) asks the server nothing', async () => {
    const srv = server()
    const c = turbo({}, srv.fetchImpl)
    expect(await c.has('aa')).toBeNull()
    expect(await c.get('aa')).toBeNull()
    await c.put('aa', new Blob(['x']), { durationMs: 1 })
    expect(srv.auth).toEqual([])
  })

  for (const reason of ['no-terminal', 'declined', 'not-found', 'store-unavailable'] as const) {
    it(`no token (${reason}): one warning naming the remote and the fixes`, async () => {
      expect(await message(turbo({}, server().fetchImpl).open(keychain({}, reason).ctx))).toBe(
        'no token for remote.cachely.dev (cachely): set TURBO_TOKEN, run vx in a terminal to be asked for one (kept in the OS keychain), or pass --cache-policy=remote: to skip the remote; local cache only this run',
      )
    })
  }

  it('a keychain token the server refuses is deleted, so the next run asks again', async () => {
    const k = keychain({ [KEY]: 'stale' })
    const c = turbo({}, server(401).fetchImpl)
    await c.open(k.ctx)
    expect(await message(c.has('aa'))).toBe(
      'HTTP 401: the token was refused; removed it from the OS keychain, so the next run asks again; remote cache off for this run',
    )
    expect(k.entries.has(KEY)).toBe(false)
  })

  it('a TURBO_TOKEN the server refuses is kept', async () => {
    const k = keychain({ [KEY]: 'kc' })
    const c = turbo({ TURBO_TOKEN: 'env' }, server(403).fetchImpl)
    await c.open(k.ctx)
    expect(await message(c.has('aa'))).toBe(
      'HTTP 403: the token was refused; remote cache off for this run',
    )
    expect(k.calls).toEqual([])
  })

  it('a keychain token no header can carry is deleted, not sent, not printed', async () => {
    const k = keychain({ [KEY]: 'SECRET\nX' })
    const srv = server()
    const c = turbo({}, srv.fetchImpl)
    expect(await message(c.open(k.ctx))).toBe(
      "the OS keychain's token for remote.cachely.dev (cachely) holds a line break or NUL, which no HTTP header can carry (it is not printed); removed it, so the next run asks again",
    )
    expect(k.entries.has(KEY)).toBe(false)
    expect(await c.has('aa')).toBeNull()
    expect(srv.auth).toEqual([])
  })
})

describe('nxCache()', () => {
  const SERVER = 'https://nx.example'
  const NX_KEY = `${SERVER}/v1/cache`
  const nx = (token: string | undefined, f: typeof fetch) =>
    new NxRemoteCache(
      resolveNxCacheConfig(token === undefined ? { url: SERVER } : { url: SERVER, token }, {})!,
      f,
    )

  it('no token anywhere: the keychain entry, keyed by endpoint', async () => {
    const k = keychain({ [NX_KEY]: 'kc' })
    const srv = server(404)
    const c = nx(undefined, srv.fetchImpl)
    await c.open(k.ctx)
    await c.get('aa')
    expect(k.calls).toEqual([`secret ${NX_KEY} | Token for nx.example, saved to the OS keychain: `])
    expect(srv.auth).toEqual(['Bearer kc'])
  })

  it('an empty token is an open url: nothing read, no Authorization', async () => {
    const k = keychain()
    const srv = server(404)
    const c = nx('', srv.fetchImpl)
    await c.open(k.ctx)
    await c.get('aa')
    expect(k.calls).toEqual([])
    expect(srv.auth).toEqual([undefined])
  })

  it('missing names its own variable', async () => {
    expect(await message(nx(undefined, server().fetchImpl).open(keychain().ctx))).toContain(
      'set NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN',
    )
  })

  it('a 401 on a keychain token deletes it', async () => {
    const k = keychain({ [NX_KEY]: 'stale' })
    const c = nx(undefined, server(401).fetchImpl)
    await c.open(k.ctx)
    expect(await message(c.get('aa'))).toContain('removed it from the OS keychain')
    expect(k.entries.size).toBe(0)
  })
})
