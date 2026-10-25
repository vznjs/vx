// vxHistory({ server }) against a real @vzn/vx-history-server, in process:
// a CI run sends its timings once at its end, and the next run orders by
// the numbers the server answers, re-ranking without waiting for them.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, it, setSystemTime } from 'bun:test'
import { hashPart, oidcAuth } from '@vzn/vx-devtools'
import { createHistoryServer, sqliteStore } from '@vzn/vx-history-server'
import { run } from '../../vx/tests/helpers/orchestrator.js'
import { type Issuer, issuer, trustOf } from './issuer.js'
import { HistoryServer, proxyHeaders, serverUrlOf } from '../src/history-server.js'

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
    authorize: oidcAuth({ trust: trustOf(), fetchJson: (u) => iss.fetchJson(u) }),
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
    const client = new HistoryServer(url, { VX_HISTORY_TOKEN: token })
    const before = seen.length
    await client.upload(new Map([['a1', { durationMs: 100, cores: 2, rssBytes: 1000 }]]))
    expect(seen.slice(before).map((r) => r.path)).toEqual([
      '/v1/capabilities',
      '/v1/timings/upload',
    ])
    const got = await client.query(
      [await hashPart('refs/heads/feature'), await hashPart('refs/heads/main')],
      ['a1', 'none'],
    )
    expect(got).toEqual(new Map([['a1', { durationMs: 100, cores: 2, rssBytes: 1000 }]]))
  })

  it("says a refusal with the server's own words", async () => {
    const read = await iss.sign('read', new URL(url).origin)
    const client = new HistoryServer(url, { VX_HISTORY_TOKEN: read })
    expect(client.upload(new Map([['b', { durationMs: 1 }]]))).rejects.toThrow('HTTP 403: ')
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
    const client = new HistoryServer('https://h.example', env, fake)
    try {
      await client.query(['0'.repeat(32)], ['a', 'b', 'c'])
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

  // M, 2026-10-25: a proxy in front of the server (an Access service token).
  it('sends serverHeaders on every request, never over the CI token', async () => {
    const seen: Headers[] = []
    const fake = (async (_u: string, init: RequestInit) => {
      seen.push(new Headers(init.headers))
      return new Response(JSON.stringify({ maxQueryHashes: 10, maxQueryScopes: 2, rows: [] }))
    }) as unknown as typeof fetch
    const headers = proxyHeaders({ 'CF-Access-Client-Id': 'id', 'X-Unset': undefined })
    expect(headers).toEqual({ 'CF-Access-Client-Id': 'id' })
    const client = new HistoryServer(
      'https://h.example',
      { VX_HISTORY_TOKEN: 'jwt' },
      fake,
      headers,
    )
    await client.query(['0'.repeat(32)], ['a']).catch(() => {})
    expect(seen.length).toBeGreaterThan(0)
    for (const h of seen)
      expect([h.get('cf-access-client-id'), h.get('authorization')]).toEqual(['id', 'Bearer jwt'])
    for (const bad of [{ Authorization: 'x' }, { 'a b': 'x' }, { a: 'x\ny' }])
      expect(() => proxyHeaders(bad)).toThrow('vxHistory(): ')
  })

  it('reads the URL over VX_HISTORY_URL', () => {
    expect(serverUrlOf(undefined, {})).toBeUndefined()
    expect(serverUrlOf(undefined, { VX_HISTORY_URL: 'https://h.example/' })).toBe(
      'https://h.example',
    )
    expect(() => serverUrlOf('h.example', {})).toThrow('vxHistory(): server must be http(s)')
  })
})

describe('vx run with vxHistory({ server })', () => {
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
        `export default { plugins: [vxHistory({ server: ${JSON.stringify(url)} })] }\n`,
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
    expect(JSON.parse(query!.body)).toEqual({
      // The ref's hash, never the ref (M, 2026-10-25).
      scopes: [await hashPart('refs/heads/main')],
      hashes: [sent[0]!.hash],
    })
  })
})
