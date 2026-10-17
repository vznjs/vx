// The OS keychain as the last token source for turboCache() and nxCache()
// (owner, 2026-10-17): read only from the layer's `open`, asked for on a
// terminal when missing and saved there, deleted when the server refuses it.
// A stand-in store and terminal: the real keychain is never touched.
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'bun:test'
import { NxRemoteCache, resolveNxCacheConfig } from '../src/nx-cache/index.js'
import { KeychainTokens, type SecretStore } from '../src/remote-token.js'
import { terminalOf, type TokenTerminal } from '../src/terminal-prompt.js'
import { resolveTurboCacheConfig, TurboRemoteCache } from '../src/turbo-cache/index.js'

function store(initial: Record<string, string> = {}, broken = false) {
  const entries = new Map(Object.entries(initial))
  const calls: string[] = []
  const fail = () => {
    if (broken) throw new Error('libsecret not found')
  }
  const s: SecretStore = {
    async get({ service, name }) {
      calls.push(`get ${service} ${name}`)
      fail()
      return entries.get(name) ?? null
    },
    async set({ name, value }) {
      calls.push(`set ${name}`)
      fail()
      entries.set(name, value)
    },
    async delete({ name }) {
      calls.push(`delete ${name}`)
      fail()
      return entries.delete(name)
    },
  }
  return { s, calls, entries }
}

function terminal(answer: string, interactive = true) {
  const asked: string[] = []
  const t: TokenTerminal = {
    interactive: () => interactive,
    async ask(question) {
      asked.push(question)
      return answer
    },
  }
  return { t, asked }
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
const NAME = `${API}/v8/artifacts#cachely`
const turbo = (
  env: Record<string, string>,
  keychain: KeychainTokens,
  fetchImpl: typeof fetch,
  options: { token?: string } = {},
  local: { token?: string } = {},
) =>
  new TurboRemoteCache(
    resolveTurboCacheConfig({ apiUrl: API, teamSlug: 'cachely', ...options }, env, {}, local)!,
    fetchImpl,
    undefined,
    undefined,
    undefined,
    keychain,
  )
const message = (p: Promise<unknown>) =>
  p.then(
    () => '(resolved)',
    (e: unknown) => (e as Error).message,
  )

describe('token precedence: option, env, config file, then the keychain', () => {
  for (const [source, env, options, local] of [
    ['the option', { TURBO_TOKEN: 'env' }, { token: 'opt' }, { token: 'file' }],
    ['TURBO_TOKEN', { TURBO_TOKEN: 'env' }, {}, { token: 'file' }],
    ['.turbo/config.json', {}, {}, { token: 'file' }],
  ] as const) {
    it(`${source} wins and the keychain is never read`, async () => {
      const { s, calls } = store({ [NAME]: 'kc' })
      const srv = server()
      const c = turbo(
        env,
        new KeychainTokens(s, terminal('typed').t),
        srv.fetchImpl,
        options,
        local,
      )
      await c.open({ ci: false })
      await c.has('aa')
      expect(calls).toEqual([])
      expect(srv.auth[0]).toBe(`Bearer ${options.token ?? env.TURBO_TOKEN ?? local.token}`)
    })
  }

  it('none of them: the keychain entry, keyed by endpoint and team', async () => {
    const { s, calls } = store({ [NAME]: 'kc' })
    const srv = server()
    await turbo({}, new KeychainTokens(s, terminal('').t), srv.fetchImpl).open({ ci: true })
    expect(calls).toEqual([`get vx-migrate ${NAME}`])
  })

  it('an empty TURBO_TOKEN (a fork’s missing secret) is no token', async () => {
    const { s } = store({ [NAME]: 'kc' })
    const srv = server()
    const c = turbo({ TURBO_TOKEN: '' }, new KeychainTokens(s, terminal('').t), srv.fetchImpl)
    await c.open({ ci: true })
    await c.has('aa')
    expect(srv.auth).toEqual(['Bearer kc'])
  })
})

describe('laziness', () => {
  it('a layer never opened (a plan, a remote-off run) reads no keychain and asks no server', async () => {
    const { s, calls } = store({ [NAME]: 'kc' })
    const srv = server()
    const c = turbo({}, new KeychainTokens(s, terminal('typed').t), srv.fetchImpl)
    expect(await c.has('aa')).toBe(false)
    expect(await c.get('aa')).toBeNull()
    await c.put('aa', new Blob(['x']), { durationMs: 1 })
    expect(calls).toEqual([])
    expect(srv.auth).toEqual([])
  })

  it('concurrent opens and a second layer of the same declaration share one answer', async () => {
    const { s, calls } = store()
    const term = terminal('typed')
    const keychain = new KeychainTokens(s, term.t)
    const srv = server()
    await Promise.all([
      turbo({}, keychain, srv.fetchImpl).open({ ci: false }),
      turbo({}, keychain, srv.fetchImpl).open({ ci: false }),
    ])
    await turbo({}, keychain, srv.fetchImpl).open({ ci: false })
    expect(term.asked).toHaveLength(1)
    expect(calls).toEqual([`get vx-migrate ${NAME}`, `set ${NAME}`])
  })
})

describe('missing everywhere', () => {
  it('on a terminal: asked once on stderr, saved to the keychain, used', async () => {
    const { s, entries } = store()
    const term = terminal('  typed  ')
    const srv = server()
    const c = turbo({}, new KeychainTokens(s, term.t), srv.fetchImpl)
    await c.open({ ci: false })
    await c.has('aa')
    expect(term.asked).toEqual([
      'Token for remote.cachely.dev (cachely), saved to the OS keychain: ',
    ])
    expect(entries.get(NAME)).toBe('typed')
    expect(srv.auth).toEqual(['Bearer typed'])
  })

  const WARNING =
    'no token for remote.cachely.dev (cachely): set TURBO_TOKEN, run vx in a terminal to be asked for one (kept in the OS keychain), or pass --cache-policy=remote: to skip the remote; local cache only this run'

  it('on CI: nothing asked, one warning naming the remote and the fixes', async () => {
    const term = terminal('typed')
    const c = turbo({}, new KeychainTokens(store().s, term.t), server().fetchImpl)
    expect(await message(c.open({ ci: true }))).toBe(WARNING)
    expect(term.asked).toEqual([])
  })

  it('with no terminal: nothing asked, the same warning', async () => {
    const term = terminal('typed', false)
    const c = turbo({}, new KeychainTokens(store().s, term.t), server().fetchImpl)
    expect(await message(c.open({ ci: false }))).toBe(WARNING)
    expect(term.asked).toEqual([])
  })

  it('an empty answer: the same warning, nothing saved', async () => {
    const { s, calls } = store()
    const c = turbo({}, new KeychainTokens(s, terminal('   ').t), server().fetchImpl)
    expect(await message(c.open({ ci: false }))).toBe(WARNING)
    expect(calls.filter((x) => x.startsWith('set'))).toEqual([])
  })

  it('no keychain (libsecret missing): read as empty, asked on a terminal, the run goes on', async () => {
    const broken = store({}, true)
    const srv = server()
    const c = turbo({}, new KeychainTokens(broken.s, terminal('typed').t), srv.fetchImpl)
    await c.open({ ci: false })
    await c.has('aa')
    expect(srv.auth).toEqual(['Bearer typed'])
    const off = turbo({}, new KeychainTokens(broken.s, terminal('').t), srv.fetchImpl)
    expect(await message(off.open({ ci: true }))).toBe(WARNING)
  })
})

describe('a refused token', () => {
  it('from the keychain: deleted, so the next run asks again', async () => {
    const { s, entries } = store({ [NAME]: 'stale' })
    const term = terminal('fresh')
    const keychain = new KeychainTokens(s, term.t)
    const c = turbo({}, keychain, server(401).fetchImpl)
    await c.open({ ci: false })
    expect(await message(c.has('aa'))).toBe(
      'HTTP 401: the token was refused; removed it from the OS keychain, so the next run asks again; remote cache off for this run',
    )
    expect(entries.has(NAME)).toBe(false)
    await turbo({}, keychain, server().fetchImpl).open({ ci: false })
    expect(term.asked).toHaveLength(1)
  })

  it('from TURBO_TOKEN: kept', async () => {
    const { s, calls } = store({ [NAME]: 'kc' })
    const c = turbo({ TURBO_TOKEN: 'env' }, new KeychainTokens(s), server(403).fetchImpl)
    await c.open({ ci: false })
    expect(await message(c.has('aa'))).toBe(
      'HTTP 403: the token was refused; remote cache off for this run',
    )
    expect(calls).toEqual([])
  })
})

describe('nxCache()', () => {
  const SERVER = 'https://nx.example'
  const nx = (accessToken: string | undefined, keychain: KeychainTokens, f: typeof fetch) =>
    new NxRemoteCache(
      resolveNxCacheConfig(
        accessToken === undefined ? { server: SERVER } : { server: SERVER, accessToken },
        {},
      )!,
      f,
      undefined,
      keychain,
    )

  it('no token anywhere: the keychain entry, keyed by endpoint', async () => {
    const { s, calls } = store({ [`${SERVER}/v1/cache`]: 'kc' })
    const srv = server(404)
    const c = nx(undefined, new KeychainTokens(s), srv.fetchImpl)
    await c.open({ ci: true })
    await c.get('aa')
    expect(calls).toEqual([`get vx-migrate ${SERVER}/v1/cache`])
    expect(srv.auth).toEqual(['Bearer kc'])
  })

  it('an empty token is an open server: nothing read, nothing asked, no Authorization', async () => {
    const { s, calls } = store()
    const srv = server(404)
    const c = nx('', new KeychainTokens(s, terminal('typed').t), srv.fetchImpl)
    await c.open({ ci: false })
    await c.get('aa')
    expect(calls).toEqual([])
    expect(srv.auth).toEqual([undefined])
  })

  it('missing on CI names its own variable', async () => {
    const c = nx(undefined, new KeychainTokens(store().s, terminal('').t), server().fetchImpl)
    expect(await message(c.open({ ci: true }))).toContain(
      'set NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN',
    )
  })

  it('a 401 on a keychain token deletes it', async () => {
    const { s, entries } = store({ [`${SERVER}/v1/cache`]: 'stale' })
    const c = nx(undefined, new KeychainTokens(s), server(401).fetchImpl)
    await c.open({ ci: true })
    expect(await message(c.get('aa'))).toContain('removed it from the OS keychain')
    expect(entries.size).toBe(0)
  })
})

describe('the terminal', () => {
  it('is asked only when stdin and stderr are both TTYs', () => {
    const input = Object.assign(new EventEmitter(), {
      setRawMode: () => {},
      resume: () => {},
      pause: () => {},
    })
    const tty = (isTTY: boolean) => ({ isTTY, write: () => true })
    expect([
      terminalOf(Object.assign(input, { isTTY: true }), tty(true)).interactive(),
      terminalOf(Object.assign(input, { isTTY: false }), tty(true)).interactive(),
      terminalOf(Object.assign(input, { isTTY: true }), tty(false)).interactive(),
    ]).toEqual([true, false, false])
  })

  const raw = () => {
    const modes: boolean[] = []
    const input = Object.assign(new EventEmitter(), {
      isRaw: false,
      setRawMode: (m: boolean) => modes.push(m),
      resume: () => {},
      pause: () => {},
    })
    const out: string[] = []
    const ask = (q: string) =>
      terminalOf(input, { isTTY: true, write: (s: string) => out.push(s) }).ask(q)
    return { input, modes, out, ask }
  }

  it('echoes nothing, edits with backspace, and restores the mode', async () => {
    const t = raw()
    const line = t.ask('Token: ')
    t.input.emit('data', Buffer.from('sec'))
    t.input.emit('data', '\u007ft\r')
    expect(await line).toBe('set')
    expect(t.out).toEqual(['Token: ', '\n'])
    expect(t.modes).toEqual([true, false])
    expect(t.input.listenerCount('data')).toBe(0)
  })

  it('Ctrl-C gives up rather than hanging the run', async () => {
    const t = raw()
    const line = t.ask('Token: ')
    t.input.emit('data', 'ab\u0003')
    expect(await message(line)).toBe('no token given')
    expect(t.modes).toEqual([true, false])
  })
})
