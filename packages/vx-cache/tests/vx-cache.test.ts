// vxCache() against a real @vzn/vx-cache-server, in process: the layer's
// wire, and a vx run that uploads and later restores through it.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createCacheServer, parseTokens, tokenAuth } from '@vzn/vx-cache-server'
import { run } from '../../vx/tests/helpers/orchestrator.js'
import { resolveVxCacheConfig, VxCacheLayer } from '../src/index.js'

const READ = 'read-token'
const WRITE = 'write-token'
const sha = (t: string) => new Bun.CryptoHasher('sha256').update(t).digest('hex')

/** The server over a Map bucket and an in-memory SQLite: what the wire sees is the server's own. */
function server(maxArtifactBytes = 1 << 20) {
  const blobs = new Map<string, Uint8Array>()
  const db = new Database(':memory:', { strict: true })
  const seen: Request[] = []
  const handle = createCacheServer({
    blobs: {
      async put(name, body, size) {
        const bytes = new Uint8Array(await new Response(body).arrayBuffer())
        if (bytes.byteLength !== size) throw new Error('short body')
        blobs.set(name, bytes)
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
    authorize: tokenAuth(parseTokens(`read:${sha(READ)} write:${sha(WRITE)}`)),
    maxArtifactBytes,
  })
  const srv = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req) => {
      seen.push(req.clone() as never)
      return handle(req as never)
    },
  })
  return { url: srv.url.href.replace(/\/$/, ''), blobs, seen, stop: () => srv.stop(true) }
}

const layer = (url: string, token: string) =>
  new VxCacheLayer({ url, token, timeoutMs: 5_000, uploadTimeoutMs: 5_000 })

describe('VxCacheLayer', () => {
  let srv: ReturnType<typeof server>
  beforeAll(() => {
    srv = server(64)
  })
  afterAll(() => srv.stop())

  it('stores, probes and reads an artifact with its duration, naming the read refs', async () => {
    const c = layer(srv.url, WRITE)
    c.reads = { 'vx-read-scopes': '"refs/heads/f", "refs/heads/main"' }
    expect(await c.has('aa11')).toBeNull()
    await c.put('aa11', new Blob(['hello']), { durationMs: 1234.4 })
    expect(await c.has('aa11')).toEqual({ size: 5, durationMs: 1234 })
    expect(await c.hasMany(['aa11', 'bb22'])).toEqual(
      new Map([['aa11', { size: 5, durationMs: 1234 }]]),
    )
    const got = await c.get('aa11')
    expect([await got!.body.text(), got!.durationMs]).toEqual(['hello', 1234])
    expect(await c.get('bb22')).toBeNull()
    const reads = srv.seen.filter((r) => r.method !== 'PUT')
    expect(
      reads.every((r) => r.headers.get('vx-read-scopes') === '"refs/heads/f", "refs/heads/main"'),
    ).toBe(true)
  })

  it('asks more than 1000 keys in queries of at most 1000', async () => {
    const before = srv.seen.length
    const keys = Array.from({ length: 2500 }, (_, i) => `k${i}`)
    expect((await layer(srv.url, READ).hasMany(keys))!.size).toBe(0)
    const sizes = await Promise.all(
      srv.seen.slice(before).map(async (r) => ((await r.json()) as { keys: string[] }).keys.length),
    )
    expect(sizes.sort((a, b) => b - a)).toEqual([1000, 1000, 500])
  })

  it('says a read token refused an upload once, and reads on', async () => {
    const c = layer(srv.url, READ)
    expect(c.put('cc33', new Blob(['x']), { durationMs: 1 })).rejects.toThrow(
      'HTTP 403: this token reads only: the upload was refused (a read token); uploads off for this run, reads go on',
    )
    await c.put('dd44', new Blob(['x']), { durationMs: 1 })
    expect(await c.has('aa11')).not.toBeNull()
  })

  it('says a refused token once, then asks nothing', async () => {
    const c = layer(srv.url, 'nope')
    expect(c.get('aa11')).rejects.toThrow(
      'HTTP 401: unknown token: the token was refused; remote cache off for this run',
    )
    const n = srv.seen.length
    expect(await c.has('aa11')).toBeNull()
    expect(await c.hasMany(['aa11'])).toEqual(new Map())
    expect(srv.seen.length).toBe(n)
  })

  it("names the server's own words when it refuses an upload", async () => {
    expect(
      layer(srv.url, WRITE).put('ee55', new Blob([new Uint8Array(65)]), { durationMs: 1 }),
    ).rejects.toThrow('HTTP 413: an artifact is at most 64 bytes')
  })
})

describe('resolveVxCacheConfig', () => {
  it('reads options over VX_CACHE_URL and VX_CACHE_TOKEN, and declines without both', () => {
    expect(resolveVxCacheConfig({}, {})).toBeUndefined()
    expect(resolveVxCacheConfig({ url: 'https://c.example' }, {})).toBeUndefined()
    expect(
      resolveVxCacheConfig({}, { VX_CACHE_URL: 'https://c.example/', VX_CACHE_TOKEN: 't' }),
    ).toEqual({
      url: 'https://c.example',
      token: 't',
      timeoutMs: 30_000,
      uploadTimeoutMs: 60_000,
    })
    expect(() => resolveVxCacheConfig({ url: 'c.example', token: 't' }, {})).toThrow(
      'vxCache(): url must be http(s), got c.example',
    )
  })
})

describe('vx run with vxCache()', () => {
  let srv: ReturnType<typeof server>
  let root: string
  beforeAll(async () => {
    srv = server()
    root = await mkdtemp(path.join(tmpdir(), 'vx-cache-'))
    await mkdir(path.join(root, 'pkg', 'src'), { recursive: true })
    await writeFile(path.join(root, 'pkg', 'src', 'app.js'), 'console.log("app")\n')
    await writeFile(
      path.join(root, 'pkg', 'vx.config.mjs'),
      "export default { tasks: { build: { exec: { command: 'mkdir -p dist && cp src/app.js dist/app.js' }, inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } } } } }\n",
    )
    await Bun.write(
      path.join(root, '.vx/workspace.mjs'),
      `import { vxCache } from ${JSON.stringify(path.resolve(import.meta.dir, '..', 'src', 'index.ts'))}\n` +
        `export default { plugins: [vxCache({ url: ${JSON.stringify(srv.url)}, token: ${JSON.stringify(WRITE)} })] }\n`,
    )
    Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  })
  afterAll(async () => {
    await srv.stop()
    await rm(root, { recursive: true, force: true })
  })

  it('a miss uploads; with the local cache wiped the next run restores from the server', async () => {
    const first = await run({ cwd: root, tasks: ['build'], handleSignals: false })
    expect(first.outcomes.map((o) => o.status)).toEqual(['success'])
    expect(srv.blobs.size).toBe(1)
    await rm(path.join(root, '.vx', 'cache'), { recursive: true, force: true })
    await rm(path.join(root, 'pkg', 'dist'), { recursive: true, force: true })
    const second = await run({ cwd: root, tasks: ['build'], handleSignals: false })
    expect(second.outcomes.map((o) => o.status)).toEqual(['cache-hit-remote'])
    expect(await Bun.file(path.join(root, 'pkg', 'dist', 'app.js')).text()).toBe(
      'console.log("app")\n',
    )
  })
})
