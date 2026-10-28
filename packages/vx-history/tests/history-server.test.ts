// vxHistory({ url }) against a real @vzn/vx-history-server, in process:
// a CI run sends its timings once at its end, and the next run orders by
// the numbers the server answers, re-ranking without waiting for them.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, it, setSystemTime } from 'bun:test'
import { oidcTokenAuth } from '@vzn/vx-devtools'
import { createHistoryServer, sqliteStore } from '@vzn/vx-history-server'
import { run } from '../../vx/tests/helpers/orchestrator.js'
import { allowOf, type Issuer, issuer, NAMED } from './issuer.js'
import { HistoryServer, proxyHeaders, serverUrlOf, timingOf } from '../src/history-server.js'
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

  // 2026-10-25: a proxy in front of the server (an Access service token).
  it('sends headers on every request, never over the CI token', async () => {
    const seen: Headers[] = []
    const fake = (async (_u: string, init: RequestInit) => {
      seen.push(new Headers(init.headers))
      return new Response(JSON.stringify({ maxUploadTimings: 10, maxQueryHashes: 10, rows: [] }))
    }) as unknown as typeof fetch
    const headers = proxyHeaders({ 'CF-Access-Client-Id': 'id', 'X-Unset': undefined })
    expect(headers).toEqual({ 'CF-Access-Client-Id': 'id' })
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
    for (const bad of [{ Authorization: 'x' }, { 'a b': 'x' }, { a: 'x\ny' }])
      expect(() => proxyHeaders(bad)).toThrow('vxHistory(): ')
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

  it('refuses a workspace that names a server but no issuer or repository', () => {
    expect(() => vxHistory({ url: 'https://h.example', repository: 'acme/app' })).toThrow(
      "vxHistory(): issuer must be the CI issuer's URL",
    )
    expect(() => vxHistory({ url: 'https://h.example', issuer: NAMED.issuer })).toThrow(
      'vxHistory(): repository must be org/name, got undefined',
    )
  })

  it('reads the URL over VX_HISTORY_URL', () => {
    expect(serverUrlOf(undefined, {})).toBeUndefined()
    expect(serverUrlOf(undefined, { VX_HISTORY_URL: 'https://h.example/' })).toBe(
      'https://h.example',
    )
    expect(() => serverUrlOf('h.example', {})).toThrow('vxHistory(): url must be http(s)')
    expect(() => serverUrlOf('https://h.example/v1/', {})).toThrow(
      "vxHistory(): url is the server's base, without /v1: https://h.example",
    )
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
