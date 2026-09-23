// The wire against a strict in-memory server implementing Nx's self-hosted
// remote cache OpenAPI spec: GET/PUT /v1/cache/{hash}, Bearer auth, 404 for
// a missing record, 409 for a write over an existing one (the spec's
// cache-poisoning guard), 401 for a bad token, 403 for a read-only one.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { run } from '@vzn/vx'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { nxCache, NxRemoteCache, resolveNxCacheConfig } from '../src/index.js'

const TOKEN = 'rw-token'
const READONLY = 'ro-token'
const PLUGIN_INDEX = path.resolve(import.meta.dir, '..', 'src', 'index.ts')

function nxServer() {
  const store = new Map<string, Uint8Array>()
  const seen: { method: string; url: string; headers: Record<string, string> }[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      seen.push({ method: req.method, url: req.url, headers: Object.fromEntries(req.headers) })
      const auth = req.headers.get('authorization')
      if (auth !== `Bearer ${TOKEN}` && auth !== `Bearer ${READONLY}`) {
        return new Response('unauthorized', { status: 401 })
      }
      const m = /^\/v1\/cache\/([0-9a-f]+)$/.exec(url.pathname)
      if (!m) return new Response('not found', { status: 404 })
      const hash = m[1]!
      if (req.method === 'PUT') {
        if (auth === `Bearer ${READONLY}`) return new Response('forbidden', { status: 403 })
        if (store.has(hash)) return new Response('conflict', { status: 409 })
        const body = new Uint8Array(await req.arrayBuffer())
        if (String(body.byteLength) !== req.headers.get('content-length')) {
          return new Response('content-length mismatch', { status: 400 })
        }
        store.set(hash, body)
        return new Response(null, { status: 202 })
      }
      if (req.method === 'GET') {
        const s = store.get(hash)
        return s
          ? new Response(s, {
              status: 200,
              headers: { 'Content-Type': 'application/octet-stream' },
            })
          : new Response('not found', { status: 404 })
      }
      return new Response('method', { status: 405 })
    },
  })
  return { store, seen, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

describe('resolveNxCacheConfig', () => {
  it('reads options over Nx’s environment, strips a trailing slash, declines without a server', () => {
    expect(resolveNxCacheConfig({}, {})).toBeUndefined()
    expect(
      resolveNxCacheConfig(
        {},
        {
          NX_SELF_HOSTED_REMOTE_CACHE_SERVER: 'https://c.example/',
          NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN: 't',
        },
      ),
    ).toEqual({ server: 'https://c.example', accessToken: 't', timeoutMs: 30_000 })
    expect(resolveNxCacheConfig({ server: 'https://o' }, {})).toEqual({
      server: 'https://o',
      timeoutMs: 30_000,
    })
  })

  it('refuses a server carrying user:pass@, from options or the env (gaps §8 L232)', () => {
    const refusal = (f: () => unknown): string => {
      try {
        f()
        return 'accepted'
      } catch (err) {
        return (err as Error).message
      }
    }
    const MSG =
      'vx/nx-cache: server carries credentials (user:pass@); pass them as the accessToken instead'
    expect([
      refusal(() => resolveNxCacheConfig({ server: 'https://u:p@c.example' }, {})),
      refusal(() =>
        resolveNxCacheConfig({}, { NX_SELF_HOSTED_REMOTE_CACHE_SERVER: 'https://u@c.example/' }),
      ),
    ]).toEqual([MSG, MSG])
    // CONTROL: the same host without userinfo resolves.
    expect(resolveNxCacheConfig({ server: 'https://c.example' }, {})?.server).toBe(
      'https://c.example',
    )
  })
})

describe('NxRemoteCache against the spec server', () => {
  let srv: ReturnType<typeof nxServer>
  beforeAll(() => {
    srv = nxServer()
  })
  afterAll(() => srv.stop())
  const cache = (accessToken = TOKEN) =>
    new NxRemoteCache(resolveNxCacheConfig({ server: srv.url, accessToken }, {})!)

  it('put → get round trip; a miss is 404 → null; a second put of the same hash is the spec’s 409 and fine', async () => {
    const c = cache()
    const body = new TextEncoder().encode('zstd-tar-bytes')
    await c.put('aa11', new Blob([body]), { durationMs: 5 })
    const put = srv.seen.at(-1)!
    expect(put.method).toBe('PUT')
    expect(put.headers['authorization']).toBe(`Bearer ${TOKEN}`)
    expect(put.headers['content-type']).toBe('application/octet-stream')
    expect(put.headers['content-length']).toBe(String(body.byteLength))
    const got = await c.get('aa11')
    expect(await got!.body.bytes()).toEqual(body)
    expect(got!.durationMs).toBeUndefined()
    expect(await c.get('bb22')).toBeNull()
    await c.put('aa11', new Blob(['other']), { durationMs: 5 })
    expect(await (await c.get('aa11'))!.body.bytes()).toEqual(body) // immutable record kept
  })

  it('has is a GET whose body the following get reuses — one transfer, not two', async () => {
    const c = cache()
    const n = srv.seen.length
    expect(await c.has('aa11')).toBe(true)
    expect(srv.seen.length).toBe(n + 1)
    expect(await (await c.get('aa11'))!.body.text()).toBe('zstd-tar-bytes')
    expect(srv.seen.length).toBe(n + 1)
    expect(await c.has('bb22')).toBe(false)
  })

  it('a probe no get follows is cancelled by the next, so its response holds no connection', async () => {
    const cancelled: string[] = []
    const streamed = (async (url: string) => {
      const hash = url.slice(url.lastIndexOf('/') + 1)
      return new Response(
        new ReadableStream<Uint8Array>({
          pull: (c) => c.enqueue(new TextEncoder().encode(hash)),
          cancel: () => {
            cancelled.push(hash)
          },
        }),
      )
    }) as unknown as typeof fetch
    const c = new NxRemoteCache({ server: 'http://nx.invalid', timeoutMs: 1_000 }, streamed)
    expect(await c.has('aa11')).toBe(true)
    expect(await c.has('bb22')).toBe(true)
    expect(cancelled).toEqual(['aa11'])
    // The kept response is the one the following get hands over, unread.
    const got = await c.get('bb22')
    const reader = got!.body.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('bb22')
    await reader.cancel()
    expect(cancelled).toEqual(['aa11', 'bb22'])
  })

  it('a bad token throws ONCE even when the calls are concurrent', async () => {
    // Same claim as the Turbo wire's, and the same race behind it: a run's
    // probe pass asks for every task at once, so several refusals are in
    // flight before the first sets the layer off. Six projects under a bad
    // token printed FIVE identical warnings before this (2026-09-20).
    // Which call loses the race is the scheduler's business, so the pin is
    // the count and each other call's own miss value, never an index.
    const c = cache('also-wrong')
    const names = ['get-a', 'get-b', 'has', 'put']
    const miss: Record<string, unknown> = {
      'get-a': null,
      'get-b': null,
      has: false,
      put: undefined,
    }
    const settled = await Promise.allSettled([
      c.get('aa11'),
      c.get('bb22'),
      c.has('cc33'),
      c.put('dd44', new Blob(['x']), { durationMs: 1 }),
    ])
    const rejected = settled.flatMap((r, i) =>
      r.status === 'rejected' ? [{ name: names[i]!, message: String(r.reason.message) }] : [],
    )
    expect({ count: rejected.length }).toEqual({ count: 1 })
    expect(rejected[0]!.message).toMatch(/401.*invalid token/)
    for (const [i, r] of settled.entries()) {
      if (r.status !== 'fulfilled') continue
      const got: { name: string; value: unknown } = { name: names[i]!, value: r.value }
      const want: { name: string; value: unknown } = { name: names[i]!, value: miss[names[i]!] }
      expect(got).toEqual(want)
    }
  })

  it('a bad token throws once and turns the layer off; a read-only token fails the write the same way', async () => {
    const bad = cache('nope')
    await expect(bad.get('aa11')).rejects.toThrow(/401.*invalid token/)
    const n = srv.seen.length
    expect(await bad.get('aa11')).toBeNull()
    expect(await bad.has('aa11')).toBe(false)
    await bad.put('cc33', new Blob(['x']), { durationMs: 1 })
    expect(srv.seen.length).toBe(n)
    const ro = cache(READONLY)
    expect(await ro.has('aa11')).toBe(true) // reads are allowed
    await expect(ro.put('dd44', new Blob(['x']), { durationMs: 1 })).rejects.toThrow(
      /403.*read-only/,
    )
  })
})

describe('vx run with nxCache() declared before the local cache', () => {
  let srv: ReturnType<typeof nxServer>
  let root: string
  beforeAll(async () => {
    srv = nxServer()
    root = await mkdtemp(path.join(tmpdir(), 'vx-nx-cache-'))
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture' }))
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'pkg'\n")
    await mkdir(path.join(root, 'pkg', 'src'), { recursive: true })
    await writeFile(path.join(root, 'pkg', 'package.json'), JSON.stringify({ name: 'pkg' }))
    await writeFile(path.join(root, 'pkg', 'src', 'app.js'), 'console.log("app")\n')
    await writeFile(
      path.join(root, 'pkg', 'vx.config.mjs'),
      "export default { tasks: { build: { exec: { command: 'mkdir -p dist && cp src/app.js dist/app.js' }, cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } } } } }\n",
    )
    await writeFile(
      path.join(root, 'vx.workspace.mjs'),
      localWorkspaceSource(
        [`nxCache({ server: ${JSON.stringify(srv.url)}, accessToken: ${JSON.stringify(TOKEN)} })`],
        `import { nxCache } from ${JSON.stringify(PLUGIN_INDEX)}\n`,
      ),
    )
    Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  })
  afterAll(async () => {
    await srv.stop()
    await rm(root, { recursive: true, force: true })
  })

  it('a miss uploads; with the local cache wiped the next run restores from the server', async () => {
    const first = await run({
      cwd: root,
      tasks: ['build'],
      handleSignals: false,
    })
    expect(first.ok).toBe(true)
    expect(first.outcomes.map((o) => o.status)).toEqual(['success'])
    expect(srv.store.size).toBe(1)
    await rm(path.join(root, '.vx'), { recursive: true, force: true })
    await rm(path.join(root, 'pkg', 'dist'), { recursive: true, force: true })
    const second = await run({
      cwd: root,
      tasks: ['build'],
      handleSignals: false,
    })
    expect(second.ok).toBe(true)
    expect(second.outcomes.map((o) => o.status)).toEqual(['cache-hit-remote'])
    expect(await Bun.file(path.join(root, 'pkg', 'dist', 'app.js')).text()).toBe(
      'console.log("app")\n',
    )
  })

  it('the plugin declines without a server', () => {
    const ctx = {
      localCache: {} as never,
      policy: { localRead: true, localWrite: true, remoteRead: true, remoteWrite: true },
      warn: () => {},
      workspaceRoot: root,
      cacheDir: root,
    }
    expect(nxCache({}).cache?.(ctx as never)).toBeUndefined()
  })
})
