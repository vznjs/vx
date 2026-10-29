// vxHistory({ url }) against a real @vzn/vx-history-server, in process:
// a CI run sends its timings once at its end, and the next run orders by
// the numbers the server answers, re-ranking without waiting for them.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, it, setSystemTime, spyOn } from 'bun:test'
import { Cache, taskDefinitions, type TaskNode } from '@vzn/vx'
import { oidcTokenAuth } from '@vzn/vx-devtools'
import { createHistoryServer, sqliteStore } from '@vzn/vx-history-server'
import { run } from '../../vx/tests/helpers/orchestrator.js'
import { allowOf, type Issuer, issuer, NAMED } from './issuer.js'
import { HistoryServer, timingOf } from '../src/history-server.js'
import { vxHistory } from '../src/index.js'

let iss: Issuer
let srv: Bun.Server<undefined>
let seen: { path: string; body: string }[]
let url = ''

beforeAll(async () => {
  iss = await issuer()
  const db = new Database(':memory:', { strict: true })
  const handle = createHistoryServer({
    store: sqliteStore({
      all: async <T>(sql: string, p: readonly unknown[]) =>
        db.query(sql).all(...(p as never[])) as T[],
      run: async (sql, p) => db.query(sql).run(...(p as never[])).changes,
    }),
    authorize: oidcTokenAuth({ allow: allowOf(), fetchJson: (u) => iss.fetchJson(u) }),
  })
  seen = []
  srv = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      seen.push({ path: new URL(req.url).pathname, body: await req.clone().text() })
      return handle(req)
    },
  })
  url = srv.url.href.replace(/\/$/, '')
})

afterAll(() => srv.stop(true))

describe('HistoryServer', () => {
  it('sends timings in uploads of the limit the server names, and reads them back', async () => {
    const token = await iss.sign('main', new URL(url).origin)
    const client = new HistoryServer(url, NAMED, { VX_HISTORY_TOKEN: token })
    const before = seen.length
    await client.upload(new Map([['a1', { durationMs: 100, cores: 2, rssBytes: 1000 }]]))
    expect(seen.slice(before).map((r) => r.path)).toEqual([
      '/v1/capabilities',
      '/v1/timings/upload',
    ])
    const got = await client.query(['refs/heads/feature', 'refs/heads/main'], ['a1', 'none'])
    expect(got).toEqual(new Map([['a1', { durationMs: 100, cores: 2, rssBytes: 1000 }]]))
  })

  // A run of groups alone has no hash to ask for: it still asked the
  // server's limits, and warned when the server was down.
  it('asks nothing for no hashes, as it sends nothing for no timings', async () => {
    const asked: string[] = []
    const none = (async (u: string) => {
      asked.push(u)
      throw new Error('connection refused')
    }) as unknown as typeof fetch
    const client = new HistoryServer(url, NAMED, {}, none)
    expect(await client.query(['refs/heads/main'], [])).toEqual(new Map())
    await client.upload(new Map())
    expect(asked).toEqual([])
  })

  it('takes no duration that a chain of them could sum past a number', async () => {
    const answer = (async (u: string) =>
      String(u).endsWith('/v1/capabilities')
        ? Response.json({ maxUploadTimings: 10, maxQueryHashes: 10 })
        : Response.json({
            timings: { big: { durationMs: 1e308 }, ok: { durationMs: 5 } },
          })) as unknown as typeof fetch
    const client = new HistoryServer(url, NAMED, {}, answer)
    expect(await client.query(['refs/heads/main'], ['big', 'ok'])).toEqual(
      new Map([['ok', { durationMs: 5 }]]),
    )
  })

  // A blip on the run's first call, the query, kept the run's upload
  // from ever asking again: the run's timings were lost.
  it('asks for the limits again after a failed ask', async () => {
    const token = await iss.sign('main', new URL(url).origin)
    let blips = 1
    const flaky = (async (u: string, init: RequestInit) => {
      if (new URL(u).pathname === '/v1/capabilities' && blips-- > 0)
        throw new Error('connection reset')
      return fetch(u, init)
    }) as unknown as typeof fetch
    const client = new HistoryServer(url, NAMED, { VX_HISTORY_TOKEN: token }, flaky)
    await expect(client.query(['refs/heads/main'], ['c1'])).rejects.toThrow('connection reset')
    await client.upload(new Map([['c1', { durationMs: 3 }]]))
    expect(await client.query(['refs/heads/main'], ['c1'])).toEqual(
      new Map([['c1', { durationMs: 3 }]]),
    )
  })

  // A server's words reach the terminal: an ESC in them retitled it and
  // overwrote the line vx printed before them.
  it("writes the controls in a server's words as escapes", async () => {
    const said = JSON.stringify({ message: '\x1b]0;PWNED\x07\x1b[2K\rall good' })
    const client = new HistoryServer(
      'https://history.test',
      NAMED,
      { VX_HISTORY_TOKEN: 't' },
      (() => Promise.resolve(new Response(said, { status: 500 }))) as unknown as typeof fetch,
    )
    await expect(client.query(['refs/heads/main'], ['a1'])).rejects.toThrow(
      'HTTP 500: \\x1b]0;PWNED\\x07\\x1b[2K all good',
    )
  })

  it("says a refusal with the server's own words", async () => {
    const read = await iss.sign('read', new URL(url).origin)
    const client = new HistoryServer(url, NAMED, { VX_HISTORY_TOKEN: read })
    expect(client.upload(new Map([['b', { durationMs: 1 }]]))).rejects.toThrow('HTTP 403: ')
  })

  it('says which repository it named when the token is of another', async () => {
    const token = await iss.sign('main', new URL(url).origin)
    const client = new HistoryServer(
      url,
      { ...NAMED, repository: 'acme/other' },
      { VX_HISTORY_TOKEN: token },
    )
    await expect(client.query(['refs/heads/main'], ['p1'])).rejects.toThrow(
      `HTTP 403: the token is of ${NAMED.repository} at ${NAMED.issuer}, not acme/other at ${NAMED.issuer}`,
    )
  })

  // A URL of a website answers any path 200 with its page: JSON.parse's
  // "Unrecognized token '<'" named no fault.
  it('says a 200 that is no JSON is not a history server', async () => {
    const site = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }),
    })
    try {
      const client = new HistoryServer(site.url.origin, NAMED, {})
      await expect(client.query(['refs/heads/main'], ['p1'])).rejects.toThrow(
        new Error(
          '/v1/capabilities answered 200 with text/html, not JSON: is the url a vx-history server?',
        ),
      )
    } finally {
      await site.stop(true)
    }
  })

  it('says why a read with no token was refused, and what lets it in', async () => {
    const client = new HistoryServer(url, NAMED, {})
    await expect(client.query(['refs/heads/main'], ['p1'])).rejects.toThrow(
      'HTTP 401: no bearer token: a read with no CI token was refused (off CI, a server reads only with READ_ACCESS=public)',
    )
  })

  // A CI job with no token was told it was off CI: its fix is its token.
  it("names a CI job's missing token as the fix, not READ_ACCESS", async () => {
    const said = (env: Record<string, string>) =>
      new HistoryServer(url, NAMED, env)
        .query(['refs/heads/main'], ['p1'])
        .catch((e: Error) => e.message)
    expect(await said({ GITLAB_CI: 'true' })).toBe(
      'HTTP 401: no bearer token: a read with no CI token was refused (name an id_tokens entry VX_HISTORY_TOKEN)',
    )
    expect(await said({ GITHUB_ACTIONS: 'true' })).toBe(
      'HTTP 401: no bearer token: a read with no CI token was refused (give the job `permissions: id-token: write`)',
    )
  })

  it("asks GitHub for a new token before the job's ends, once for parallel calls", async () => {
    let asks = 0
    const t0 = Date.now()
    const exp = Math.floor(t0 / 1000) + 300
    const fake = (async (input: string | URL) => {
      const u = new URL(String(input))
      if (u.hostname === 'oidc.example') {
        asks++
        const body = Buffer.from(JSON.stringify({ exp })).toString('base64url')
        return Response.json({ value: `h.${body}.s` })
      }
      if (u.pathname === '/v1/capabilities') {
        return Response.json({ maxUploadTimings: 1, maxQueryHashes: 1 })
      }
      if (u.pathname === '/v1/timings/query') return Response.json({ timings: {} })
      return new Response(null, { status: 204 })
    }) as typeof fetch
    const env = {
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 't',
    }
    const client = new HistoryServer('https://h.example', NAMED, env, fake)
    try {
      await client.query(['refs/heads/main'], ['a', 'b', 'c'])
      expect(asks).toBe(1)
      setSystemTime(t0 + 200_000)
      await client.upload(new Map([['a', { durationMs: 1 }]]))
      expect(asks).toBe(1)
      // A run longer than the token: its upload asks again, never sends a dead token.
      setSystemTime(t0 + 250_000)
      await client.upload(new Map([['a', { durationMs: 1 }]]))
      expect(asks).toBe(2)
    } finally {
      setSystemTime()
    }
  })

  // One 503 from GitHub's OIDC endpoint lost the run's timings: the upload
  // asks for the token at the run's end, once (vx-cache asks again, #4571).
  it("asks GitHub's OIDC endpoint again after a 5xx or 429, never after a 4xx", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const jwt = `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`
    const env = {
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 't',
    }
    const clientOf = (answers: (number | 'reset')[]) => {
      const asked: string[] = []
      const fake = (async (input: string | URL) => {
        const u = new URL(String(input))
        if (u.hostname === 'oidc.example') {
          const a = answers.shift() ?? 200
          asked.push(String(a))
          if (a === 'reset') throw new Error('connection reset')
          return a === 200 ? Response.json({ value: jwt }) : new Response('no', { status: a })
        }
        if (u.pathname === '/v1/capabilities')
          return Response.json({ maxUploadTimings: 10, maxQueryHashes: 10 })
        return new Response(null, { status: 204 })
      }) as typeof fetch
      const waits: number[] = []
      const client = new HistoryServer('https://h.example', NAMED, env, fake, {}, async (ms) => {
        waits.push(ms)
      })
      return { client, asked, waits }
    }
    const blips = clientOf([503, 'reset', 200])
    await blips.client.upload(new Map([['a', { durationMs: 1 }]]))
    expect([blips.asked, blips.waits]).toEqual([
      ['503', 'reset', '200'],
      [1000, 2000],
    ])
    const busy = clientOf([429, 502, 500])
    await expect(busy.client.upload(new Map([['a', { durationMs: 1 }]]))).rejects.toThrow(
      "GitHub's OIDC endpoint: HTTP 500: no",
    )
    expect(busy.asked).toEqual(['429', '502', '500'])
    const refused = clientOf([403])
    await expect(refused.client.upload(new Map([['a', { durationMs: 1 }]]))).rejects.toThrow(
      "GitHub's OIDC endpoint: HTTP 403: no",
    )
    expect(refused.asked).toEqual(['403'])
  })

  // One 503 from the server's edge at the run's end lost every timing the
  // run measured. A 500 is the server's own failure, maybe after the fold:
  // sent again, a run would count twice.
  it('sends a request again after a 429, 502, 503 or 504, never after a 500 or no answer', async () => {
    const clientOf = (answers: (number | 'reset')[]) => {
      const sent: string[] = []
      const fake = (async (input: string | URL) => {
        const u = new URL(String(input))
        if (u.pathname === '/v1/capabilities')
          return Response.json({ maxUploadTimings: 10, maxQueryHashes: 10 })
        const a = answers.shift() ?? 200
        sent.push(`${u.pathname} ${a}`)
        if (a === 'reset') throw new Error('connection reset')
        if (a !== 200) return new Response('busy', { status: a })
        return u.pathname === '/v1/timings/query'
          ? Response.json({ timings: { a: { durationMs: 5 } } })
          : new Response(null, { status: 204 })
      }) as typeof fetch
      const waits: number[] = []
      const client = new HistoryServer(
        'https://h.example',
        NAMED,
        { VX_HISTORY_TOKEN: 'jwt' },
        fake,
        {},
        async (ms) => {
          waits.push(ms)
        },
      )
      return { client, sent, waits }
    }
    const up = clientOf([503, 504, 200])
    await up.client.upload(new Map([['a', { durationMs: 1 }]]))
    expect([up.sent, up.waits]).toEqual([
      ['/v1/timings/upload 503', '/v1/timings/upload 504', '/v1/timings/upload 200'],
      [1000, 2000],
    ])
    const gone = clientOf(['reset'])
    await expect(gone.client.upload(new Map([['a', { durationMs: 1 }]]))).rejects.toThrow(
      'connection reset',
    )
    expect(gone.sent).toEqual(['/v1/timings/upload reset'])
    const read = clientOf([429, 502, 200])
    expect(await read.client.query(['refs/heads/main'], ['a'])).toEqual(
      new Map([['a', { durationMs: 5 }]]),
    )
    const down = clientOf([504, 504, 504])
    await expect(down.client.upload(new Map([['a', { durationMs: 1 }]]))).rejects.toThrow(
      'HTTP 504: busy',
    )
    const failed = clientOf([500])
    await expect(failed.client.upload(new Map([['a', { durationMs: 1 }]]))).rejects.toThrow(
      'HTTP 500: busy',
    )
    expect(failed.sent).toEqual(['/v1/timings/upload 500'])
  })

  // 2026-10-25: a proxy in front of the server (an Access service token).
  it('sends headers on every request, never over the CI token', async () => {
    const seen: Headers[] = []
    const fake = (async (_u: string, init: RequestInit) => {
      seen.push(new Headers(init.headers))
      return new Response(JSON.stringify({ maxUploadTimings: 10, maxQueryHashes: 10, rows: [] }))
    }) as unknown as typeof fetch
    const headers = { 'CF-Access-Client-Id': 'id' }
    const client = new HistoryServer(
      'https://h.example',
      NAMED,
      { VX_HISTORY_TOKEN: 'jwt' },
      fake,
      headers,
    )
    await client.query(['refs/heads/main'], ['a']).catch(() => {})
    expect(seen.length).toBeGreaterThan(0)
    for (const h of seen)
      expect([
        h.get('cf-access-client-id'),
        h.get('authorization'),
        h.get('vx-issuer'),
        h.get('vx-repository'),
      ]).toEqual(['id', 'Bearer jwt', null, null])
  })

  it('reads with no token from a public server, sending none', async () => {
    const db = new Database(':memory:', { strict: true })
    const store = sqliteStore({
      all: async <T>(sql: string, p: readonly unknown[]) =>
        db.query(sql).all(...(p as never[])) as T[],
      run: async (sql, p) => db.query(sql).run(...(p as never[])).changes,
    })
    await store.init()
    await store.fold(NAMED, 'refs/heads/main', 1, [{ hash: 'p1', durationMs: 7 }])
    const handle = createHistoryServer({
      store,
      authorize: oidcTokenAuth({
        allow: allowOf(),
        readAccess: 'public',
        fetchJson: (u) => iss.fetchJson(u),
      }),
    })
    const auths: (string | null)[] = []
    const fake = (async (u: string, init: RequestInit) => {
      const req = new Request(u, init)
      auths.push(req.headers.get('authorization'))
      return handle(req)
    }) as unknown as typeof fetch
    const client = new HistoryServer('https://h.example', NAMED, {}, fake)
    expect(client.writes).toBe(false)
    expect(await client.query(['refs/heads/main'], ['p1'])).toEqual(
      new Map([['p1', { durationMs: 7 }]]),
    )
    expect(auths).toEqual([null, null])
  })

  it('sends how long a task on a crowded machine would have taken alone, as local history keeps it', () => {
    const ran = { status: 'success', durationMs: 75_000, cpuMs: 20_000 } as const
    // One core's work at a third of a core: two thirds of 20 s was waiting.
    expect(timingOf({ ...ran, cpuShare: 1 / 3 } as never)?.durationMs).toBe(35_000)
    expect(timingOf(ran as never)?.durationMs).toBe(75_000)
  })

  // A worker's share rounds to 0 at 0.0005 of a core: cores came out
  // Infinity (NaN with no CPU time), JSON sent null, and the server
  // refused the whole upload — every task's timing lost.
  it('sends no cores it cannot count, so one task never costs the upload', () => {
    const ran = { status: 'success', durationMs: 1000, peakRssBytes: 1024 } as const
    for (const cpuMs of [0, 500])
      expect(timingOf({ ...ran, cpuMs, cpuShare: 0 } as never)).toEqual({
        durationMs: 1000,
        rssBytes: 1024,
      })
    expect(timingOf({ ...ran, cpuMs: 500, cpuShare: 0.5 } as never)?.cores).toBe(1)
  })

  it('refuses a workspace that names a server but no issuer or repository', () => {
    expect(() => vxHistory({ url: 'https://h.example', repository: 'acme/app' })).toThrow(
      "vxHistory(): issuer must be the CI issuer's URL",
    )
    expect(() => vxHistory({ url: 'https://h.example', issuer: NAMED.issuer })).toThrow(
      'vxHistory(): repository must be org/name, got undefined',
    )
  })

  // The ordering was computed twice, on the local history and again when
  // the server's numbers landed, and each pass named the bad assumption.
  it('names an assumption it drops once a run, with the server re-ranking', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'vx-history-assume-'))
    const cache = new Cache(dir)
    const fake = spyOn(globalThis, 'fetch').mockImplementation((async (u: string) => {
      if (String(u).endsWith('/v1/capabilities'))
        return Response.json({ maxUploadTimings: 10, maxQueryHashes: 10 })
      const hash = [...taskDefinitions([node]).values()][0]!
      return Response.json({ timings: { [hash]: { durationMs: 50 } } })
    }) as never)
    const node = {
      id: 'a#build',
      projectName: 'a',
      projectDir: dir,
      taskName: 'build',
      config: { exec: { command: 'true' } },
      deps: [],
      requested: true,
    } as unknown as TaskNode
    try {
      const warned: string[] = []
      const refined: Promise<unknown>[] = []
      const plugin = vxHistory({
        url: 'https://h.example',
        ...NAMED,
        assume: { 'a#build': Number(undefined) },
      })
      await plugin.schedule!(new Map([['a#build', node]]), {
        warn: (m: string) => warned.push(m),
        workspaceRoot: dir,
        localCache: cache,
        branch: 'main',
        refs: [],
        refine: (p: Promise<unknown>) => refined.push(p),
      } as never)
      expect(refined).toHaveLength(1)
      expect(await refined[0]).toBeInstanceOf(Map)
      expect(warned).toEqual([
        '[vx] vx-history: assume ignores "a#build" — each must be a number of ms from 0 to 2^53',
      ])
    } finally {
      fake.mockRestore()
      cache.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reads the URL over VX_HISTORY_URL, refusing one no request can carry', async () => {
    const saved = Bun.env.VX_HISTORY_URL
    const warned: string[] = []
    const setup = (o: Parameters<typeof vxHistory>[0]) =>
      vxHistory(o).setup!({ ci: false, warn: (m: string) => warned.push(m) } as never)
    try {
      Bun.env.VX_HISTORY_URL = 'h.example'
      await expect(setup({ ...NAMED }) as Promise<unknown>).rejects.toThrow(
        'vxHistory(): url must be http(s), got h.example',
      )
      await setup({ ...NAMED, url: 'https://h.example/' })
      Bun.env.VX_HISTORY_URL = 'https://h.example/'
      await setup({})
      expect(warned).toEqual([
        '[vx] vx-history: VX_HISTORY_URL names a server, but vxHistory() names no issuer and repository: the server is not asked',
      ])
    } finally {
      if (saved === undefined) delete Bun.env.VX_HISTORY_URL
      else Bun.env.VX_HISTORY_URL = saved
    }
  })

  // It was checked only in a run's `setup`: `vx show`, `vx info` and a
  // `--dry` plan took the config, and every run then failed on it.
  it('refuses a url no request can carry when the config is evaluated', () => {
    const refusal = (o: Parameters<typeof vxHistory>[0]): string => {
      try {
        vxHistory({ ...NAMED, ...o })
        return 'taken'
      } catch (err) {
        return (err as Error).message
      }
    }
    expect(refusal({ url: 'h.example' })).toBe('vxHistory(): url must be http(s), got h.example')
    expect(refusal({ url: 'https://h.example/v1' })).toBe(
      "vxHistory(): url is the server's base, without /v1: https://h.example",
    )
    expect(refusal({ url: 'https://h.example/' })).toBe('taken')
  })
})

describe('vx run with vxHistory({ url })', () => {
  let root: string
  const saved = { ...Bun.env }
  beforeAll(async () => {
    delete Bun.env.ACTIONS_ID_TOKEN_REQUEST_URL
    delete Bun.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
    Bun.env.CI = 'true'
    Bun.env.VX_HISTORY_TOKEN = await iss.sign('main', new URL(url).origin)
    root = await mkdtemp(path.join(tmpdir(), 'vx-history-server-'))
    await mkdir(path.join(root, 'pkg'), { recursive: true })
    await writeFile(
      path.join(root, 'pkg', 'vx.config.mjs'),
      "export default { tasks: { build: { exec: { command: 'true' }, inputs: { files: [] } } } }\n",
    )
    await Bun.write(
      path.join(root, '.vx/workspace.mjs'),
      `import { vxHistory } from ${JSON.stringify(path.resolve(import.meta.dir, '..', 'src', 'index.ts'))}\n` +
        `export default { plugins: [vxHistory({ url: ${JSON.stringify(url)}, ...${JSON.stringify(NAMED)} })] }\n`,
    )
    Bun.spawnSync({ cmd: ['git', 'init', '-q', '-b', 'main'], cwd: root })
    // A branch with a commit: an unborn one names no ref to read.
    Bun.spawnSync({
      cmd: [
        'git',
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'x',
      ],
      cwd: root,
    })
  })
  afterAll(async () => {
    for (const k of Object.keys(Bun.env)) if (!(k in saved)) delete Bun.env[k]
    Object.assign(Bun.env, saved)
    await rm(root, { recursive: true, force: true })
  })

  it('sends the run’s timings once at its end, and the next run asks for them', async () => {
    const before = seen.length
    const first = await run({ cwd: root, tasks: ['build'], handleSignals: false })
    expect(first.outcomes.map((o) => o.status)).toEqual(['success'])
    const uploads = seen.slice(before).filter((r) => r.path === '/v1/timings/upload')
    expect(uploads).toHaveLength(1)
    const sent = (JSON.parse(uploads[0]!.body) as { timings: { hash: string }[] }).timings
    expect(sent).toEqual([
      expect.objectContaining({ hash: expect.any(String), durationMs: expect.any(Number) }),
    ])
    const mid = seen.length
    await run({ cwd: root, tasks: ['build'], handleSignals: false })
    const query = seen.slice(mid).find((r) => r.path === '/v1/timings/query')
    // One query a run: the repository, its refs and every hash, plainly.
    expect(JSON.parse(query!.body)).toEqual({
      ...NAMED,
      refs: ['refs/heads/main'],
      hashes: [sent[0]!.hash],
    })
  })

  it('names the server it could not reach, reading and sending', async () => {
    const gone = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() })
    const dead = `http://127.0.0.1:${gone.port}`
    await gone.stop(true)
    const other = await mkdtemp(path.join(tmpdir(), 'vx-history-dead-'))
    try {
      await mkdir(path.join(other, 'pkg'), { recursive: true })
      await writeFile(
        path.join(other, 'pkg', 'vx.config.mjs'),
        "export default { tasks: { build: { exec: { command: 'true' }, inputs: { files: [] } } } }\n",
      )
      await Bun.write(
        path.join(other, '.vx/workspace.mjs'),
        `import { vxHistory } from ${JSON.stringify(path.resolve(import.meta.dir, '..', 'src', 'index.ts'))}\n` +
          `export default { plugins: [vxHistory({ url: ${JSON.stringify(dead)}, ...${JSON.stringify(NAMED)} })] }\n`,
      )
      Bun.spawnSync({ cmd: ['git', 'init', '-q', '-b', 'main'], cwd: other })
      // A branch with a commit: an unborn one names no ref to read.
      Bun.spawnSync({
        cmd: [
          'git',
          '-c',
          'user.name=t',
          '-c',
          'user.email=t@t',
          'commit',
          '-q',
          '--allow-empty',
          '-m',
          'x',
        ],
        cwd: other,
      })
      const bin = path.resolve(import.meta.dir, '..', '..', 'vx', 'src', 'bin.ts')
      Bun.spawnSync({ cmd: [process.execPath, bin, 'lock'], cwd: other })
      const cli = Bun.spawnSync({
        cmd: [process.execPath, bin, 'run', 'build', '--all'],
        cwd: other,
        env: { ...Bun.env, NO_COLOR: '1' },
      })
      const said = `${cli.stdout.toString()}${cli.stderr.toString()}`
        .split('\n')
        .filter((l) => l.startsWith('[vx] vx-history:'))
        .map((l) => l.split(': ')[1])
      expect([cli.exitCode, said]).toEqual([
        0,
        [
          `the timings of the history server at ${dead} were not applied`,
          `the timings were not sent to the history server at ${dead}`,
        ],
      ])
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  }, 30_000)

  // The upload waited for teardown, which core bounds (3 s): a run that
  // outlived its OIDC token spent the bound on a new token and the PUT,
  // and its timings were dropped behind core's generic warning.
  it('starts the upload once the run ends, before any teardown', async () => {
    const other = await mkdtemp(path.join(tmpdir(), 'vx-history-early-'))
    const plugin = await mkdtemp(path.join(tmpdir(), 'vx-history-before-'))
    let arrived: boolean | undefined
    const sentBefore = seen.length
    const uploaded = () => seen.slice(sentBefore).some((r) => r.path === '/v1/timings/upload')
    try {
      await mkdir(path.join(other, 'pkg'), { recursive: true })
      await writeFile(
        path.join(other, 'pkg', 'vx.config.mjs'),
        "export default { tasks: { build: { exec: { command: 'true' }, inputs: { files: [] } } } }\n",
      )
      // Declared first, so its teardown runs before vx-history's.
      ;(globalThis as { __vxHistoryBefore?: unknown }).__vxHistoryBefore = async () => {
        for (let i = 0; i < 100 && !uploaded(); i++) await Bun.sleep(10)
        arrived = uploaded()
      }
      await Bun.write(path.join(plugin, 'package.json'), '{ "name": "before" }\n')
      await Bun.write(
        path.join(plugin, 'index.mjs'),
        `import { definePlugin } from ${JSON.stringify(path.resolve(import.meta.dir, '..', '..', 'vx', 'src', 'index.ts'))}\n` +
          'export default definePlugin(import.meta, { teardown: () => globalThis.__vxHistoryBefore() })\n',
      )
      await Bun.write(
        path.join(other, '.vx/workspace.mjs'),
        `import before from ${JSON.stringify(path.join(plugin, 'index.mjs'))}\n` +
          `import { vxHistory } from ${JSON.stringify(path.resolve(import.meta.dir, '..', 'src', 'index.ts'))}\n` +
          `export default { plugins: [before, vxHistory({ url: ${JSON.stringify(url)}, ...${JSON.stringify(NAMED)} })] }\n`,
      )
      Bun.spawnSync({ cmd: ['git', 'init', '-q', '-b', 'main'], cwd: other })
      const r = await run({ cwd: other, tasks: ['build'], handleSignals: false })
      expect([r.outcomes.map((o) => o.status), arrived]).toEqual([['success'], true])
    } finally {
      delete (globalThis as { __vxHistoryBefore?: unknown }).__vxHistoryBefore
      await rm(other, { recursive: true, force: true })
      await rm(plugin, { recursive: true, force: true })
    }
  }, 30_000)

  it('says how many timings it dropped when the server does not answer in time', async () => {
    const slow = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req) => {
        const at = new URL(req.url).pathname
        if (at === '/v1/capabilities')
          return Response.json({ maxUploadTimings: 100, maxQueryHashes: 100 })
        if (at === '/v1/timings/query') return Response.json({ timings: {} })
        return new Promise<Response>(() => {})
      },
    })
    const hung = `http://127.0.0.1:${slow.port}`
    const other = await mkdtemp(path.join(tmpdir(), 'vx-history-hung-'))
    try {
      await mkdir(path.join(other, 'pkg'), { recursive: true })
      await writeFile(
        path.join(other, 'pkg', 'vx.config.mjs'),
        "export default { tasks: { build: { exec: { command: 'true' }, inputs: { files: [] } } } }\n",
      )
      await Bun.write(
        path.join(other, '.vx/workspace.mjs'),
        `import { vxHistory } from ${JSON.stringify(path.resolve(import.meta.dir, '..', 'src', 'index.ts'))}\n` +
          `export default { plugins: [vxHistory({ url: ${JSON.stringify(hung)}, ...${JSON.stringify(NAMED)} })] }\n`,
      )
      Bun.spawnSync({ cmd: ['git', 'init', '-q', '-b', 'main'], cwd: other })
      const bin = path.resolve(import.meta.dir, '..', '..', 'vx', 'src', 'bin.ts')
      Bun.spawnSync({ cmd: [process.execPath, bin, 'lock'], cwd: other })
      const cli = Bun.spawn({
        cmd: [process.execPath, bin, 'run', 'build', '--all'],
        cwd: other,
        env: { ...Bun.env, NO_COLOR: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [out, err, code] = await Promise.all([
        new Response(cli.stdout).text(),
        new Response(cli.stderr).text(),
        cli.exited,
      ])
      const said = `${out}${err}`.split('\n').filter((l) => /teardown|vx-history/.test(l))
      expect([code, said]).toEqual([
        0,
        [
          `[vx] vx-history: the timings of 1 task were not sent to the history server at ${hung}: no answer in the 2000 ms a teardown waits`,
        ],
      ])
    } finally {
      await slow.stop(true)
      await rm(other, { recursive: true, force: true })
    }
  }, 30_000)

  // Core bounds a teardown (3 s): an upload first held the timings file's
  // write behind it, and a server slower than the bound cost the file.
  it('writes the timings file while the history server is slow to take the upload', async () => {
    const slow = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req) => {
        const at = new URL(req.url).pathname
        if (at === '/v1/capabilities')
          return Response.json({ maxUploadTimings: 100, maxQueryHashes: 100 })
        if (at === '/v1/timings/query') return Response.json({ timings: {} })
        return new Promise<Response>(() => {})
      },
    })
    const other = await mkdtemp(path.join(tmpdir(), 'vx-history-slow-'))
    Bun.env.VX_TEST_TEARDOWN_TIMEOUT = '300ms'
    try {
      await mkdir(path.join(other, 'pkg'), { recursive: true })
      await writeFile(
        path.join(other, 'pkg', 'vx.config.mjs'),
        "export default { tasks: { build: { exec: { command: 'true' }, inputs: { files: [] } } } }\n",
      )
      await Bun.write(
        path.join(other, '.vx/workspace.mjs'),
        `import { vxHistory } from ${JSON.stringify(path.resolve(import.meta.dir, '..', 'src', 'index.ts'))}\n` +
          `export default { plugins: [vxHistory({ url: ${JSON.stringify(`http://127.0.0.1:${slow.port}`)}, file: 'timings.json', ...${JSON.stringify(NAMED)} })] }\n`,
      )
      Bun.spawnSync({ cmd: ['git', 'init', '-q', '-b', 'main'], cwd: other })
      const r = await run({ cwd: other, tasks: ['build'], handleSignals: false })
      expect(r.outcomes.map((o) => o.status)).toEqual(['success'])
      const written = (await Bun.file(path.join(other, 'timings.json'))
        .json()
        .catch(() => undefined)) as { tasks?: Record<string, number> } | undefined
      expect(Object.keys(written?.tasks ?? {})).toEqual(['pkg#build'])
    } finally {
      delete Bun.env.VX_TEST_TEARDOWN_TIMEOUT
      await slow.stop(true)
      await rm(other, { recursive: true, force: true })
    }
  })

  // A run that names no ref (a detached HEAD, no default branch) asks
  // nothing: `main` was guessed, reading a branch the repository may lack.
  it('asks nothing when the run reads no ref', async () => {
    const other = await mkdtemp(path.join(tmpdir(), 'vx-history-norefs-'))
    try {
      await mkdir(path.join(other, 'pkg'), { recursive: true })
      await writeFile(
        path.join(other, 'pkg', 'vx.config.mjs'),
        "export default { tasks: { build: { exec: { command: 'true' }, inputs: { files: [] } } } }\n",
      )
      await Bun.write(
        path.join(other, '.vx/workspace.mjs'),
        `import { vxHistory } from ${JSON.stringify(path.resolve(import.meta.dir, '..', 'src', 'index.ts'))}\n` +
          `export default { plugins: [vxHistory({ url: ${JSON.stringify(url)}, ...${JSON.stringify(NAMED)} })] }\n`,
      )
      const git = (...args: string[]) =>
        Bun.spawnSync({
          cmd: ['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
          cwd: other,
        })
      git('init', '-q', '-b', 'feat')
      git('commit', '-q', '--allow-empty', '-m', 'x')
      git('checkout', '-q', '--detach')
      const before = seen.length
      await run({ cwd: other, tasks: ['build'], handleSignals: false })
      expect(seen.slice(before).filter((r) => r.path === '/v1/timings/query')).toEqual([])
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  })

  // A workspace naming no issuer and repository never asks the server
  // VX_HISTORY_URL names, so how that URL is spelled cannot fail its run.
  it('runs when VX_HISTORY_URL is malformed and the workspace names no server', async () => {
    const other = await mkdtemp(path.join(tmpdir(), 'vx-history-env-'))
    Bun.env.VX_HISTORY_URL = 'https://h.example/v1'
    try {
      await mkdir(path.join(other, 'pkg'), { recursive: true })
      await writeFile(
        path.join(other, 'pkg', 'vx.config.mjs'),
        "export default { tasks: { build: { exec: { command: 'true' }, inputs: { files: [] } } } }\n",
      )
      await Bun.write(
        path.join(other, '.vx/workspace.mjs'),
        `import { vxHistory } from ${JSON.stringify(path.resolve(import.meta.dir, '..', 'src', 'index.ts'))}\n` +
          `export default { plugins: [vxHistory()] }\n`,
      )
      Bun.spawnSync({ cmd: ['git', 'init', '-q', '-b', 'main'], cwd: other })
      const r = await run({ cwd: other, tasks: ['build'], handleSignals: false })
      expect(r.outcomes.map((o) => o.status)).toEqual(['success'])
    } finally {
      delete Bun.env.VX_HISTORY_URL
      await rm(other, { recursive: true, force: true })
    }
  })

  // `main` was assumed: a repository whose trunk is another branch read
  // no trunk's numbers on any branch.
  it('asks in the refs the run reads: its branch, then baseBranch', async () => {
    const other = await mkdtemp(path.join(tmpdir(), 'vx-history-refs-'))
    try {
      await mkdir(path.join(other, 'pkg'), { recursive: true })
      await writeFile(
        path.join(other, 'pkg', 'vx.config.mjs'),
        "export default { tasks: { build: { exec: { command: 'true' }, inputs: { files: [] } } } }\n",
      )
      await Bun.write(
        path.join(other, '.vx/workspace.mjs'),
        `import { vxHistory } from ${JSON.stringify(path.resolve(import.meta.dir, '..', 'src', 'index.ts'))}\n` +
          `export default { baseBranch: 'trunk', plugins: [vxHistory({ url: ${JSON.stringify(url)}, ...${JSON.stringify(NAMED)} })] }\n`,
      )
      Bun.spawnSync({ cmd: ['git', 'init', '-q', '-b', 'feat'], cwd: other })
      Bun.spawnSync({
        cmd: [
          'git',
          '-c',
          'user.name=t',
          '-c',
          'user.email=t@t',
          'commit',
          '-q',
          '--allow-empty',
          '-m',
          'x',
        ],
        cwd: other,
      })
      const before = seen.length
      await run({ cwd: other, tasks: ['build'], handleSignals: false })
      const query = seen.slice(before).find((r) => r.path === '/v1/timings/query')
      expect((JSON.parse(query!.body) as { refs: string[] }).refs).toEqual([
        'refs/heads/feat',
        'refs/heads/trunk',
      ])
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  })
})
