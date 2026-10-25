// vxCache() against a real @vzn/vx-cache-server, in process: the layer's
// wire, and a vx run that uploads and later restores through it. Every
// request carries a CI token the server's issuer signed.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { oidcAuth } from '@vzn/vx-devtools'
import { createCacheServer, sqliteStore } from '@vzn/vx-cache-server'
import type { JWTPayload } from 'jose'
import { run } from '../../vx/tests/helpers/orchestrator.js'
import {
  BRANCH_JOB,
  type Issuer,
  issuer,
  READ_JOB,
  TRUST,
  TRUSTED_JOB,
} from '../../vx-cache-server/tests/issuer.js'
import { hasCiToken, resolveVxCacheConfig, vxCache, VxCacheLayer } from '../src/index.js'

let iss: Issuer
beforeAll(async () => {
  iss = await issuer()
})

/** The server over a Map bucket and an in-memory SQLite: what the wire sees is the server's own. */
function server(maxUploadBytes = 1 << 20) {
  const blobs = new Map<string, Uint8Array>()
  const db = new Database(':memory:', { strict: true })
  const seen: { path: string; body: string }[] = []
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
    store: sqliteStore({
      all: async <T>(sql: string, p: readonly unknown[]) =>
        db.query(sql).all(...(p as never[])) as T[],
      run: async (sql, p) => db.query(sql).run(...(p as never[])).changes,
      batch: async (s) => s.forEach((x) => db.run(x)),
    }),
    authorize: oidcAuth({ trust: TRUST, fetchJson: (u) => iss.fetchJson(u) }),
    maxUploadBytes,
  })
  const srv = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      // The line alone: an upload's bytes follow it.
      const text = await req.clone().text()
      seen.push({ path: new URL(req.url).pathname, body: text.split('\n')[0]! })
      return handle(req as never)
    },
  })
  const url = srv.url.href.replace(/\/$/, '')
  return {
    url,
    blobs,
    seen,
    token: (claims: JWTPayload) => iss.sign(claims, new URL(url).origin),
    stop: () => srv.stop(true),
  }
}

/** A layer whose job's token is `token`, as GitLab's `VX_CACHE_TOKEN` carries it. */
const layer = (url: string, token: string) =>
  new VxCacheLayer({ url, timeoutMs: 5_000, uploadTimeoutMs: 5_000 }, fetch, {
    VX_CACHE_TOKEN: token,
  })

const artifacts = (body: string) =>
  (JSON.parse(body) as { artifacts?: { hash: string }[] }).artifacts?.map((a) => a.hash)
/** Requests land in any order: sorted by what they say. */
const byJson = (a: unknown, b: unknown) => JSON.stringify(a).localeCompare(JSON.stringify(b))
const hashes = (body: string) => (JSON.parse(body) as { hashes: string[] }).hashes

describe('VxCacheLayer', () => {
  let srv: ReturnType<typeof server>
  let write = ''
  let read = ''
  beforeAll(async () => {
    srv = server(64)
    ;[write, read] = await Promise.all([srv.token(TRUSTED_JOB), srv.token(READ_JOB)])
  })
  afterAll(() => srv.stop())

  it('uploads, checks and downloads one artifact, naming the read refs', async () => {
    const c = layer(srv.url, write)
    c.reads = { 'x-artifact-read-scopes': '"refs/heads/f", "refs/heads/main"' }
    expect(await c.has('aa11')).toBeNull()
    await c.put('aa11', new Blob(['hello']), { durationMs: 1 })
    expect(await c.has('aa11')).toEqual({ size: 5 })
    expect(await c.hasMany(['aa11', 'bb22'])).toEqual(new Map([['aa11', { size: 5 }]]))
    const got = await c.get('aa11')
    expect(await got!.body.text()).toBe('hello')
    expect(await c.get('bb22')).toBeNull()
  })

  it('asks more than 1000 keys in checks of at most 1000', async () => {
    const before = srv.seen.length
    const keys = Array.from({ length: 2500 }, (_, i) => i.toString(16))
    expect((await layer(srv.url, read).hasMany(keys)).size).toBe(0)
    const sizes = srv.seen.slice(before).map((r) => hashes(r.body).length)
    expect(sizes.sort((a, b) => b - a)).toEqual([1000, 1000, 500])
  })

  it('sends more than two waiting uploads as one batch of the missing, checked first', async () => {
    await layer(srv.url, write).put('e0', new Blob(['held']), { durationMs: 1 })
    const c = layer(srv.url, write)
    // The server's limits, named on every check, which a run asks first.
    await c.hasMany(['0'])
    const before = srv.seen.length
    // Four go at once, each alone; the three left wait, and go together.
    const keys = ['e1', 'e2', 'e3', 'e4', 'e5', 'e0', 'e6']
    await Promise.all(keys.map((k) => c.put(k, new Blob([k]), { durationMs: 1 })))
    const seen = srv.seen.slice(before).map((r) => [r.path, artifacts(r.body) ?? hashes(r.body)])
    // Requests land in any order; the batch's check comes before its upload.
    expect(seen.filter(([, list]) => list!.length === 1)).toEqual(
      ['e1', 'e2', 'e3', 'e4'].map((k) => ['/v1/artifacts/upload', [k]]),
    )
    expect(seen.filter(([, list]) => list!.length > 1)).toEqual([
      ['/v1/artifacts/check', ['e5', 'e0', 'e6']],
      ['/v1/artifacts/upload', ['e5', 'e6']],
    ])
    for (const k of keys.slice(0, 5)) expect(await (await c.get(k))!.body.text()).toBe(k)
  })

  it('sends one or two waiting uploads alone, unchecked', async () => {
    const c = layer(srv.url, write)
    await c.hasMany(['0'])
    const before = srv.seen.length
    const keys = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6']
    await Promise.all(keys.map((k) => c.put(k, new Blob([k]), { durationMs: 1 })))
    const seen = srv.seen.slice(before).map((r) => [r.path, artifacts(r.body)])
    expect(seen.sort(byJson)).toEqual(keys.map((k) => ['/v1/artifacts/upload', [k]]))
  })

  it('batches nothing until a check names the limits, and says once when one names none', async () => {
    const said: string[] = []
    // A server whose answers lose the limit headers.
    const stripped: typeof fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const res = await fetch(input, init)
        const headers = new Headers(res.headers)
        headers.delete('x-vx-max-batch-artifacts')
        return new Response(res.body, { status: res.status, headers })
      },
      { preconnect: fetch.preconnect },
    )
    const c = new VxCacheLayer(
      { url: srv.url, timeoutMs: 5_000, uploadTimeoutMs: 5_000 },
      stripped,
      {
        VX_CACHE_TOKEN: write,
      },
    )
    c.warn = (m) => said.push(m)
    const before = srv.seen.length
    const keys = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']
    await Promise.all(keys.map((k) => c.put(k, new Blob([k]), { durationMs: 1 })))
    await c.hasMany(['c1'])
    await c.hasMany(['c2'])
    await Promise.all(
      ['c8', 'c9', 'ca', 'cb', 'cc'].map((k) => c.put(k, new Blob([k]), { durationMs: 1 })),
    )
    expect(
      srv.seen.slice(before).every((r) => (artifacts(r.body) ?? hashes(r.body)).length === 1),
    ).toBe(true)
    expect(said).toEqual([
      '[vx] vx-cache: the check (HTTP 200) named no batch limits (x-vx-max-batch-artifacts, x-vx-max-upload-bytes); uploads go one at a time',
    ])
  })

  it('sends timings with the next upload, the rest on their own, and reads them back', async () => {
    const c = layer(srv.url, write)
    c.addTiming({ hash: 'build', durationMs: 100, cores: 2, rssBytes: 1000 })
    const before = srv.seen.length
    await c.put('a0', new Blob(['x']), { durationMs: 1 })
    const sent = srv.seen.slice(before).find((r) => artifacts(r.body)?.[0] === 'a0')!
    expect(JSON.parse(sent.body).timings).toEqual([
      { hash: 'build', durationMs: 100, cores: 2, rssBytes: 1000 },
    ])
    // Held: the server answers before the bytes, and keeps the timings.
    c.addTiming({ hash: 'build', durationMs: 200 })
    await c.put('a0', new Blob(['x']), { durationMs: 1 })
    c.addTiming({ hash: 'test', durationMs: 50 })
    await c.flushTimings()
    expect(srv.seen.at(-1)!.path).toBe('/v1/timings/upload')
    expect(await layer(srv.url, read).timings(['build', 'test', 'none'])).toEqual(
      new Map([
        [
          'build',
          [
            { hash: 'build', durationMs: 200 },
            { hash: 'build', durationMs: 100, cores: 2, rssBytes: 1000 },
          ],
        ],
        ['test', [{ hash: 'test', durationMs: 50 }]],
      ]),
    )
  })

  it('says a job that reads only was refused a write once, and reads on', async () => {
    const c = layer(srv.url, read)
    expect(c.put('cc33', new Blob(['x']), { durationMs: 1 })).rejects.toThrow(
      'HTTP 403: this token reads only: the write was refused (this job reads only); writes off for this run, reads go on',
    )
    await c.put('dd44', new Blob(['x']), { durationMs: 1 })
    expect(await c.has('aa11')).not.toBeNull()
  })

  it('says a refused token once, then asks nothing', async () => {
    const c = layer(srv.url, 'nope')
    expect(c.get('aa11')).rejects.toThrow(': the token was refused; remote cache off for this run')
    const n = srv.seen.length
    expect(await c.has('aa11')).toBeNull()
    expect(await c.hasMany(['aa11'])).toEqual(new Map())
    expect(srv.seen.length).toBe(n)
  })

  it("sends no artifact over the server's limit, says so, and keeps its timing", async () => {
    const c = layer(srv.url, write)
    const said: string[] = []
    c.warn = (m) => said.push(m)
    await c.hasMany(['0'])
    c.addTiming({ hash: 'big', durationMs: 7 })
    const before = srv.seen.length
    await c.put('b16', new Blob([new Uint8Array(65)]), { durationMs: 1 })
    expect(srv.seen.length).toBe(before)
    expect(said).toEqual([
      "[vx] vx-cache: b16 is 65 bytes, over the server's upload limit of 64: not uploaded",
    ])
    await c.flushTimings()
    expect(JSON.parse(srv.seen.at(-1)!.body).timings).toEqual([{ hash: 'big', durationMs: 7 }])
  })

  it("names the server's own words when it refuses an upload", async () => {
    expect(
      layer(srv.url, write).put('ee55', new Blob([new Uint8Array(65)]), { durationMs: 1 }),
    ).rejects.toThrow('HTTP 413: an upload is at most 64 bytes')
  })
})

describe('GitHub OIDC', () => {
  it("asks the job's token for the server's origin, and its branch's writes land there", async () => {
    const srv = server()
    const asked: string[] = []
    const github = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (req) => {
        const audience = new URL(req.url).searchParams.get('audience')!
        asked.push(`${req.headers.get('authorization')} ${audience}`)
        return Response.json({ value: await iss.sign(BRANCH_JOB, audience) })
      },
    })
    try {
      const env = {
        ACTIONS_ID_TOKEN_REQUEST_URL: github.url.href,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'gh',
      }
      const c = new VxCacheLayer(resolveVxCacheConfig({ url: srv.url }, env)!, fetch, env)
      await c.put('f1', new Blob(['x']), { durationMs: 1 })
      await c.put('f2', new Blob(['y']), { durationMs: 1 })
      expect(asked).toEqual([`bearer gh ${new URL(srv.url).origin}`])
      const reader = layer(srv.url, await srv.token(READ_JOB))
      expect(await reader.has('f1')).toBeNull()
      reader.reads = { 'x-artifact-read-scopes': '"refs/heads/feature"' }
      expect(await reader.has('f1')).toEqual({ size: 1 })
    } finally {
      await srv.stop()
      await github.stop(true)
    }
  })
})

describe('lend', () => {
  it("lends the run's token to another job, whose writes land where the run reads", async () => {
    const srv = server()
    let lifetime = '10m'
    const asked: string[] = []
    // The run's job is a push to main; the other job's a dispatch on main.
    const claims: Record<string, JWTPayload> = { run: TRUSTED_JOB, other: READ_JOB }
    const github = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (req) => {
        const job = req.headers.get('authorization')!.slice('bearer '.length)
        asked.push(job)
        const aud = new URL(req.url).searchParams.get('audience')!
        return Response.json({ value: await iss.sign(claims[job]!, aud, lifetime) })
      },
    })
    const envOf = (job: string) => ({
      ACTIONS_ID_TOKEN_REQUEST_URL: github.url.href,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: job,
    })
    const on = (job: string) =>
      new VxCacheLayer(resolveVxCacheConfig({ url: srv.url }, envOf(job))!, fetch, envOf(job))
    try {
      const run = on('run')
      const lent = await run.lend()
      expect(lent?.token.split('.')).toHaveLength(3)
      expect(lent!.expiresAt! - Date.now()).toBeGreaterThan(4 * 60_000)

      // Its own token reads only: main's ref from a job no rule trusts.
      await expect(on('other').put('a1', new Blob(['x']), { durationMs: 1 })).rejects.toThrow(
        'writes off for this run',
      )
      const other = on('other')
      other.lent = () => lent!.token
      await other.put('a2', new Blob(['y']), { durationMs: 1 })
      expect(await layer(srv.url, await srv.token(READ_JOB)).has('a2')).toEqual({ size: 1 })
      expect(await other.lend()).toBeUndefined()

      // A token ending within five minutes is asked again before it is lent.
      lifetime = '4m'
      const short = on('run')
      await short.lend()
      await short.lend()
      expect(asked.filter((j) => j === 'run')).toHaveLength(3)
    } finally {
      await srv.stop()
      await github.stop(true)
    }
  })
})

describe('config', () => {
  it('reads the URL over VX_CACHE_URL, and a CI token from GitHub, GitLab or a lending run', () => {
    expect(resolveVxCacheConfig({}, {})).toBeUndefined()
    expect(resolveVxCacheConfig({}, { VX_CACHE_URL: 'https://c.example/' })).toEqual({
      url: 'https://c.example',
      timeoutMs: 30_000,
      uploadTimeoutMs: 60_000,
    })
    expect(() => resolveVxCacheConfig({ url: 'c.example' }, {})).toThrow(
      'vxCache(): url must be http(s), got c.example',
    )
    expect(hasCiToken({}, false)).toBe(false)
    expect(hasCiToken({}, true)).toBe(true)
    expect(hasCiToken({ VX_CACHE_TOKEN: 'jwt' }, false)).toBe(true)
    const gh = { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://gh', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'b' }
    expect(hasCiToken(gh, false)).toBe(true)
  })

  it('declines off CI with one note, and never asks the server', async () => {
    const saved = { ...Bun.env }
    for (const k of [
      'VX_CACHE_TOKEN',
      'ACTIONS_ID_TOKEN_REQUEST_URL',
      'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
      'GITHUB_ACTIONS',
    ]) {
      delete Bun.env[k]
    }
    try {
      const said: string[] = []
      const hooks = vxCache({ url: 'https://c.example' }) as unknown as {
        cache(ctx: object): unknown
      }
      expect(hooks.cache({ refs: [], warn: (m: string) => said.push(m) })).toBeUndefined()
      expect(said).toEqual([
        '[vx] vx-cache: serves CI jobs only (no CI token here); remote cache off for this run',
      ])
    } finally {
      Object.assign(Bun.env, saved)
    }
  })
})

describe('vx run with vxCache()', () => {
  let srv: ReturnType<typeof server>
  let root: string
  const saved = { ...Bun.env }
  beforeAll(async () => {
    srv = server()
    // This job's CI token, whatever CI runs these tests.
    delete Bun.env.ACTIONS_ID_TOKEN_REQUEST_URL
    delete Bun.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
    Bun.env.VX_CACHE_TOKEN = await srv.token(TRUSTED_JOB)
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
        `export default { plugins: [vxCache({ url: ${JSON.stringify(srv.url)} })] }\n`,
    )
    Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  })
  afterAll(async () => {
    for (const k of Object.keys(Bun.env)) if (!(k in saved)) delete Bun.env[k]
    Object.assign(Bun.env, saved)
    await srv.stop()
    await rm(root, { recursive: true, force: true })
  })

  it('a miss uploads and is timed; with the local cache wiped the next run restores', async () => {
    const first = await run({ cwd: root, tasks: ['build'], handleSignals: false })
    expect(first.outcomes.map((o) => o.status)).toEqual(['success'])
    expect(srv.blobs.size).toBe(1)
    // The task completes after its upload: its timing goes at the run's end.
    const sent = srv.seen
      .filter((r) => r.path.endsWith('/upload'))
      .flatMap((r) => (JSON.parse(r.body) as { timings?: unknown[] }).timings ?? [])
    expect(sent).toEqual([
      expect.objectContaining({ hash: expect.any(String), durationMs: expect.any(Number) }),
    ])
    await rm(path.join(root, '.vx', 'cache'), { recursive: true, force: true })
    await rm(path.join(root, 'pkg', 'dist'), { recursive: true, force: true })
    const before = srv.seen.length
    const second = await run({ cwd: root, tasks: ['build'], handleSignals: false })
    expect(second.outcomes.map((o) => o.status)).toEqual(['cache-hit-remote'])
    expect(await Bun.file(path.join(root, 'pkg', 'dist', 'app.js')).text()).toBe(
      'console.log("app")\n',
    )
    // The order asked for the task's timings; a hit writes none.
    const paths = srv.seen.slice(before).map((r) => r.path)
    expect(paths).toContain('/v1/timings/query')
    expect(paths).not.toContain('/v1/timings/upload')
  })
})
