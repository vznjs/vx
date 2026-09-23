// The wire against a strict in-memory server that implements the published
// Turborepo remote cache spec (`/v8/artifacts`): Bearer auth, HEAD/GET/PUT
// per hash, the batch POST, `x-artifact-duration` and `x-artifact-tag`. The
// server is the spec's transcription, so a plugin that drifts from it fails
// here; the signature is transcribed independently of the implementation.

import { createHmac } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { run } from '@vzn/vx'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import {
  artifactTag,
  MIN_SIGNATURE_KEY_LENGTH,
  resolveTurboCacheConfig,
  TurboRemoteCache,
  turboCache,
} from '../src/index.js'

const TOKEN = 'secret-token'
const KEY = 'k'.repeat(40)
const PLUGIN_INDEX = path.resolve(import.meta.dir, '..', 'src', 'index.ts')

interface Stored {
  body: Uint8Array
  duration: string | null
  tag: string | null
}
interface Seen {
  method: string
  url: string
  headers: Record<string, string>
}

function turboServer(opts: { token?: string; verifyTag?: boolean } = {}) {
  const store = new Map<string, Stored>()
  const seen: Seen[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      seen.push({ method: req.method, url: req.url, headers: Object.fromEntries(req.headers) })
      if (req.headers.get('authorization') !== `Bearer ${opts.token ?? TOKEN}`) {
        return Response.json(
          { error: { code: 'forbidden', message: 'bad token' } },
          { status: 401 },
        )
      }
      if (url.pathname === '/v8/artifacts' && req.method === 'POST') {
        const { hashes } = (await req.json()) as { hashes: string[] }
        const out: Record<string, unknown> = {}
        for (const h of hashes) {
          const s = store.get(h)
          out[h] = s ? { size: s.body.byteLength, taggedAt: Date.now() } : null
        }
        return Response.json(out)
      }
      const m = /^\/v8\/artifacts\/([0-9a-f]+)$/.exec(url.pathname)
      if (!m) return new Response('not found', { status: 404 })
      const hash = m[1]!
      if (req.method === 'PUT') {
        const body = new Uint8Array(await req.arrayBuffer())
        if (String(body.byteLength) !== req.headers.get('content-length')) {
          return new Response('content-length mismatch', { status: 400 })
        }
        store.set(hash, {
          body,
          duration: req.headers.get('x-artifact-duration'),
          tag: req.headers.get('x-artifact-tag'),
        })
        return Response.json({ urls: [`${url.origin}/v8/artifacts/${hash}`] }, { status: 202 })
      }
      const s = store.get(hash)
      if (!s) return new Response('not found', { status: 404 })
      const headers: Record<string, string> = { 'Content-Length': String(s.body.byteLength) }
      if (s.duration !== null) headers['x-artifact-duration'] = s.duration
      if (s.tag !== null) headers['x-artifact-tag'] = s.tag
      if (req.method === 'HEAD') return new Response(null, { status: 200, headers })
      if (req.method === 'GET') return new Response(s.body, { status: 200, headers })
      return new Response('method', { status: 405 })
    },
  })
  return { store, seen, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

describe('resolveTurboCacheConfig', () => {
  it('reads options over Turbo’s environment, strips a trailing slash, declines without url+token', () => {
    expect(resolveTurboCacheConfig({}, {})).toBeUndefined()
    expect(resolveTurboCacheConfig({ apiUrl: 'https://c.example' }, {})).toBeUndefined()
    // A token alone is Vercel's hosted cache, as it is for `turbo`.
    expect(resolveTurboCacheConfig({ token: 't' }, {})?.apiUrl).toBe('https://vercel.com/api')
    expect(resolveTurboCacheConfig({}, { TURBO_TOKEN: 't', TURBO_TEAM: 'acme' })?.apiUrl).toBe(
      'https://vercel.com/api',
    )
    expect(
      resolveTurboCacheConfig(
        {},
        { TURBO_API: 'https://c.example/', TURBO_TOKEN: 't', TURBO_TEAM: 'acme' },
      ),
    ).toEqual({
      apiUrl: 'https://c.example',
      token: 't',
      teamSlug: 'acme',
      timeoutMs: 30_000,
      uploadTimeoutMs: 60_000,
    })
    expect(
      resolveTurboCacheConfig(
        { apiUrl: 'https://o', token: 'o' },
        { TURBO_API: 'x', TURBO_TOKEN: 'y' },
      )?.apiUrl,
    ).toBe('https://o')
  })
  it('a signature key must be Turbo’s minimum length and come with a team id', () => {
    expect(() =>
      resolveTurboCacheConfig(
        { apiUrl: 'u', token: 't', signatureKey: 'short', teamId: 'team_1' },
        {},
      ),
    ).toThrow(/at least 32 bytes/)
    expect(() =>
      resolveTurboCacheConfig({ apiUrl: 'u', token: 't', signatureKey: KEY }, {}),
    ).toThrow(/needs teamId/)
    expect(MIN_SIGNATURE_KEY_LENGTH).toBe(32)
  })
})

describe('artifactTag', () => {
  it('is base64(HMAC-SHA256) over length-prefixed prefix, hash, team id, body — transcribed from Turbo', async () => {
    const body = new TextEncoder().encode('artifact-bytes')
    const mac = createHmac('sha256', Buffer.from(KEY))
    for (const f of ['artifact-signature:v2', 'abc123', 'team_1']
      .map((s) => Buffer.from(s))
      .concat([Buffer.from(body)])) {
      const len = Buffer.alloc(8)
      len.writeBigUInt64LE(BigInt(f.byteLength))
      mac.update(len).update(f)
    }
    const tag = (team: string) => artifactTag(Buffer.from(KEY), 'abc123', team, new Blob([body]))
    expect(await tag('team_1')).toBe(mac.digest('base64'))
    // The team id is part of the message: a different team is a different tag.
    expect(await tag('team_2')).not.toBe(await tag('team_1'))
  })
})

describe('TurboRemoteCache against the spec server', () => {
  let srv: ReturnType<typeof turboServer>
  beforeAll(() => {
    srv = turboServer()
  })
  afterAll(() => srv.stop())
  const cache = (
    extra: Partial<Parameters<typeof resolveTurboCacheConfig>[0]> = {},
    tempDir?: string,
  ) =>
    new TurboRemoteCache(
      resolveTurboCacheConfig(
        { apiUrl: srv.url, token: TOKEN, teamId: 'team_1', teamSlug: 'acme', ...extra },
        {},
      )!,
      fetch,
      tempDir,
    )

  it('put → has / hasMany / get round trip with the spec’s headers and query', async () => {
    const c = cache()
    const body = new TextEncoder().encode('zstd-tar-bytes')
    await c.put('aa11', new Blob([body]), { durationMs: 1234 })
    const put = srv.seen.at(-1)!
    expect(put.method).toBe('PUT')
    expect(new URL(put.url).searchParams.get('teamId')).toBe('team_1')
    expect(new URL(put.url).searchParams.get('slug')).toBe('acme')
    expect(put.headers['x-artifact-duration']).toBe('1234')
    expect(put.headers['content-type']).toBe('application/octet-stream')
    expect(put.headers['x-artifact-client-interactive']).toMatch(/^[01]$/)
    expect(await c.has('aa11')).toBe(true)
    expect(srv.seen.at(-1)!.method).toBe('HEAD')
    expect(await c.has('bb22')).toBe(false)
    expect(await c.hasMany(['aa11', 'bb22'])).toEqual(new Set(['aa11']))
    const got = await c.get('aa11')
    expect(got?.durationMs).toBe(1234)
    expect(await got!.body.bytes()).toEqual(body)
    expect(await c.get('bb22')).toBeNull()
  })

  it('signs uploads and refuses a download whose tag does not verify', async () => {
    const c = cache({ signatureKey: KEY })
    const body = new TextEncoder().encode('signed-bytes')
    await c.put('cc33', new Blob([body]), { durationMs: 1 })
    expect(srv.store.get('cc33')!.tag).toBe(
      await artifactTag(Buffer.from(KEY), 'cc33', 'team_1', new Blob([body])),
    )
    expect(await (await c.get('cc33'))!.body.bytes()).toEqual(body)
    // Tampered on the server: the tag no longer covers the bytes.
    srv.store.get('cc33')!.body = new TextEncoder().encode('tampered')
    await expect(c.get('cc33')).rejects.toThrow(/signature did not verify/)
    // Unsigned on the server (written without a key): also a miss when we verify.
    await cache().put('dd44', new Blob([body]), { durationMs: 1 })
    await expect(c.get('dd44')).rejects.toThrow(/signature did not verify/)
    // Without a key configured nothing is verified (control).
    expect(await cache().get('dd44')).not.toBeNull()
  })

  // A signed download is verified from a temp before core sees a byte; the
  // temp is the layer's to remove on every path out: a refused tag, a body
  // read to its end, a body cancelled part-way.
  describe('the signed download’s temp', () => {
    let tempDir: string
    beforeAll(async () => {
      tempDir = await mkdtemp(path.join(tmpdir(), 'vx-turbo-temp-'))
    })
    afterAll(() => rm(tempDir, { recursive: true, force: true }))
    const body = new Uint8Array(256 * 1024).map((_, i) => i % 251)

    it('a bad tag is refused and leaves no temp', async () => {
      const c = cache({ signatureKey: KEY }, tempDir)
      await c.put('ab12', new Blob([body]), { durationMs: 1 })
      srv.store.get('ab12')!.body = body.slice().reverse()
      await expect(c.get('ab12')).rejects.toThrow(/signature did not verify/)
      expect(await readdir(tempDir)).toEqual([])
    })

    it('a verified body is served from the temp, which goes once it is read to the end', async () => {
      const c = cache({ signatureKey: KEY }, tempDir)
      await c.put('ab34', new Blob([body]), { durationMs: 1 })
      const got = await c.get('ab34')
      expect((await readdir(tempDir)).length).toBe(1)
      expect(await got!.body.bytes()).toEqual(body)
      expect(await readdir(tempDir)).toEqual([])
    })

    it('a verified body cancelled part-way leaves no temp', async () => {
      // Past one file-stream chunk (256 KiB), so the cancel lands mid-file.
      const large = new Uint8Array(4 << 20).map((_, i) => i % 251)
      const c = cache({ signatureKey: KEY }, tempDir)
      await c.put('ab56', new Blob([large]), { durationMs: 1 })
      const got = await c.get('ab56')
      expect((await readdir(tempDir)).length).toBe(1)
      const reader = got!.body.body!.getReader()
      expect((await reader.read()).done).toBe(false)
      await reader.cancel()
      expect(await readdir(tempDir)).toEqual([])
    })

    it('an untagged download is refused unread: its body is cancelled, no temp is written', async () => {
      let cancelled = false
      const untagged = (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull: (c) => c.enqueue(body),
            cancel: () => {
              cancelled = true
            },
          }),
        )) as unknown as typeof fetch
      const config = resolveTurboCacheConfig(
        { apiUrl: 'http://turbo.invalid', token: TOKEN, teamId: 'team_1', signatureKey: KEY },
        {},
      )!
      const c = new TurboRemoteCache(config, untagged, tempDir)
      await expect(c.get('ab78')).rejects.toThrow(/signature did not verify/)
      expect(cancelled).toBe(true)
      expect(await readdir(tempDir)).toEqual([])
    })
  })

  it('a refused token throws ONCE even when the calls are concurrent', async () => {
    // The claim in the class comment is "one line, not one per task", and a
    // run's calls overlap: the probe pass asks for every task at once. Six
    // projects under a bad token printed FIVE identical warnings before the
    // in-flight refusals learned to degrade in silence (2026-09-20).
    //
    // Which call loses the race is the scheduler's business, so the pin is
    // "exactly one rejection, and every other call returned its own miss
    // value" — never an index.
    const c = cache({ token: 'also-wrong' })
    const miss: Record<string, unknown> = {
      'has-a': false,
      'has-b': false,
      get: null,
      hasMany: new Set(),
      put: undefined,
    }
    const names = ['has-a', 'has-b', 'get', 'hasMany', 'put']
    const settled = await Promise.allSettled([
      c.has('aa11'),
      c.has('bb22'),
      c.get('aa11'),
      c.hasMany(['aa11', 'bb22']),
      c.put('ff66', new Blob(['x']), { durationMs: 1 }),
    ])
    const rejected = settled.flatMap((r, i) =>
      r.status === 'rejected' ? [{ name: names[i]!, message: String(r.reason.message) }] : [],
    )
    expect({ count: rejected.length }).toEqual({ count: 1 })
    expect(rejected[0]!.message).toMatch(/401.*token was refused/)
    for (const [i, r] of settled.entries()) {
      if (r.status !== 'fulfilled') continue
      const got: { name: string; value: unknown } = { name: names[i]!, value: r.value }
      const want: { name: string; value: unknown } = { name: names[i]!, value: miss[names[i]!] }
      expect(got).toEqual(want)
    }
  })

  it('a refused token throws once and turns the layer off', async () => {
    const c = cache({ token: 'wrong' })
    await expect(c.has('aa11')).rejects.toThrow(/401.*token was refused/)
    const n = srv.seen.length
    expect(await c.has('aa11')).toBe(false)
    expect(await c.get('aa11')).toBeNull()
    await c.put('ee55', new Blob(['x']), { durationMs: 1 })
    expect(await c.hasMany(['aa11'])).toEqual(new Set())
    expect(srv.seen.length).toBe(n) // no further requests
  })
})

describe('vx run with turboCache() declared before the local cache', () => {
  let srv: ReturnType<typeof turboServer>
  let root: string
  beforeAll(async () => {
    srv = turboServer()
    root = await mkdtemp(path.join(tmpdir(), 'vx-turbo-cache-'))
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
        [
          `turboCache({ apiUrl: ${JSON.stringify(srv.url)}, token: ${JSON.stringify(TOKEN)}, teamSlug: 'acme' })`,
        ],
        `import { turboCache } from ${JSON.stringify(PLUGIN_INDEX)}\n`,
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
    // Uploads are queued; drained before run() resolves.
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

  it('the plugin declines without a url and a token', () => {
    const plugin = turboCache({})
    const ctx = {
      localCache: {} as never,
      policy: { localRead: true, localWrite: true, remoteRead: true, remoteWrite: true },
      warn: () => {},
      workspaceRoot: root,
      cacheDir: root,
    }
    expect(plugin.cache?.(ctx as never)).toBeUndefined()
  })
})
