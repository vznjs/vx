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
import { type RemoteCacheLayer } from '@vzn/vx'
import type { WorkspaceConfig } from '@vzn/vx/config'
import { run } from '../../vx/tests/helpers/orchestrator.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import {
  artifactTag,
  MIN_SIGNATURE_KEY_LENGTH,
  resolveTurboCacheConfig,
  TurboRemoteCache,
} from '../src/turbo-cache/index.js'
import { turbo, turboCache } from '../src/index.js'
import { readScopes } from '../src/turbo-cache/scope.js'

const TOKEN = 'secret-token'
const KEY = 'k'.repeat(40)
const PLUGIN_INDEX = path.resolve(import.meta.dir, '..', 'src', 'index.ts')
const TURBO_CACHE = path.resolve(import.meta.dir, '..', 'src', 'turbo-cache', 'index.ts')

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
      // An API gateway's rule (nx#33092's class): a GET that does not ask for
      // the binary type gets the body base64-encoded.
      if (req.method === 'GET')
        return req.headers.get('accept') === 'application/octet-stream'
          ? new Response(s.body, { status: 200, headers })
          : new Response(Buffer.from(s.body).toString('base64'), { status: 200 })
      return new Response('method', { status: 405 })
    },
  })
  return { store, seen, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

describe('resolveTurboCacheConfig', () => {
  it('reads an empty TURBO_API, TURBO_TEAM, TURBO_TEAMID or VERCEL_ARTIFACTS_OWNER as unset, as Turbo does', () => {
    // CI hands `''` for a missing secret or variable (vercel/turborepo#6929).
    expect(
      resolveTurboCacheConfig({}, { TURBO_TOKEN: 't', TURBO_TEAM: 'acme', TURBO_API: '' })?.url,
    ).toBe('https://vercel.com/api')
    const local = { apiUrl: 'https://c.example', teamId: 'team_x', teamSlug: 'linked' }
    expect(
      resolveTurboCacheConfig(
        {},
        { TURBO_TOKEN: 't', TURBO_TEAM: '', TURBO_TEAMID: '', VERCEL_ARTIFACTS_OWNER: '' },
        {},
        local,
      ),
    ).toMatchObject({ url: 'https://c.example', teamId: 'team_x', teamSlug: 'linked' })
  })

  it('reads options over Turbo’s environment, strips a trailing slash, declines without url, team or token', () => {
    expect(resolveTurboCacheConfig({}, {})).toBeUndefined()
    // A URL with no token is kept: the layer's `open` asks the OS keychain.
    expect(resolveTurboCacheConfig({ url: 'https://c.example' }, {})?.token).toBeUndefined()
    expect(resolveTurboCacheConfig({}, { TURBO_TOKEN: '', TURBO_TEAM: 'acme' })).toMatchObject({
      url: 'https://vercel.com/api',
      teamSlug: 'acme',
    })
    // A token alone is Vercel's hosted cache, as it is for `turbo`.
    expect(resolveTurboCacheConfig({ token: 't' }, {})?.url).toBe('https://vercel.com/api')
    expect(resolveTurboCacheConfig({}, { TURBO_TOKEN: 't', TURBO_TEAM: 'acme' })?.url).toBe(
      'https://vercel.com/api',
    )
    expect(
      resolveTurboCacheConfig(
        {},
        { TURBO_API: 'https://c.example/', TURBO_TOKEN: 't', TURBO_TEAM: 'acme' },
      ),
    ).toEqual({
      url: 'https://c.example',
      token: 't',
      teamSlug: 'acme',
      timeoutMs: 30_000,
      retries: 1,
      preflight: false,
      uploadTimeoutMs: 60_000,
    })
    expect(
      resolveTurboCacheConfig(
        { url: 'https://o', token: 'o' },
        { TURBO_API: 'x', TURBO_TOKEN: 'y' },
      )?.url,
    ).toBe('https://o')
  })
  // Turbo's own order: turbo.json under the environment under the flags.
  it('turbo.json’s remoteCache is read below the environment; `enabled: false` declines', () => {
    const file = { apiUrl: 'https://file.example/', teamId: 'team_file', teamSlug: 'file' }
    const pick = (c: ReturnType<typeof resolveTurboCacheConfig>) =>
      c && [c.url, c.teamId, c.teamSlug]
    expect([
      pick(resolveTurboCacheConfig({}, { TURBO_TOKEN: 't' }, file)),
      pick(
        resolveTurboCacheConfig(
          {},
          {
            TURBO_TOKEN: 't',
            TURBO_API: 'https://env.example',
            TURBO_TEAMID: 'team_env',
            TURBO_TEAM: 'env',
          },
          file,
        ),
      ),
      pick(resolveTurboCacheConfig({ url: 'https://opt.example', token: 't' }, {}, file)),
      pick(resolveTurboCacheConfig({}, {}, file)),
      pick(resolveTurboCacheConfig({}, { TURBO_TOKEN: 't' }, { ...file, enabled: false })),
      pick(resolveTurboCacheConfig({ token: 't' }, {}, { ...file, enabled: false })),
      pick(resolveTurboCacheConfig({}, { TURBO_TOKEN: 't' }, { apiUrl: 7, teamId: null })),
    ]).toEqual([
      ['https://file.example', 'team_file', 'file'],
      ['https://env.example', 'team_env', 'env'],
      ['https://opt.example', 'team_file', 'file'],
      ['https://file.example', 'team_file', 'file'],
      undefined,
      ['https://file.example', 'team_file', 'file'],
      ['https://vercel.com/api', undefined, undefined],
    ])
  })

  // Turbo reads its deadlines, in whole seconds, from flags, then
  // TURBO_REMOTE_CACHE_[UPLOAD_]TIMEOUT, then turbo.json; they were not read,
  // so a repo that waits 120 s for its cache got vx's 30. 0 is no deadline.
  it('the timeouts come from the options, then Turbo’s env, then turbo.json, in seconds', () => {
    const at = (
      o: Parameters<typeof resolveTurboCacheConfig>[0],
      env: Record<string, string>,
      file: Parameters<typeof resolveTurboCacheConfig>[2],
    ) => {
      const c = resolveTurboCacheConfig({ token: 't', ...o }, env, file)!
      return [c.timeoutMs, c.uploadTimeoutMs]
    }
    const file = { timeout: 120, uploadTimeout: 300 }
    const env = { TURBO_REMOTE_CACHE_TIMEOUT: '5', TURBO_REMOTE_CACHE_UPLOAD_TIMEOUT: '0' }
    expect([
      at({}, {}, {}),
      at({}, {}, file),
      at({}, env, file),
      at({ timeoutMs: 7, uploadTimeoutMs: 8 }, env, file),
    ]).toEqual([
      [30_000, 60_000],
      [120_000, 300_000],
      [5_000, 0],
      [7, 8],
    ])
    expect(() => at({}, { TURBO_REMOTE_CACHE_TIMEOUT: '1.5' }, {})).toThrow(
      'turboCache(): TURBO_REMOTE_CACHE_TIMEOUT must be whole seconds ≥ 0, got "1.5"',
    )
    expect(() => at({}, {}, { uploadTimeout: -1 })).toThrow(
      'turboCache(): remoteCache.uploadTimeout must be whole seconds ≥ 0, got -1',
    )
  })

  it('a timeout of 0 sends no deadline', async () => {
    const signals: Array<AbortSignal | null | undefined> = []
    const seen = (async (_u: string, init?: RequestInit) => {
      signals.push(init?.signal)
      return new Response(null, { status: 404 })
    }) as unknown as typeof fetch
    for (const timeoutMs of [0, 1000]) {
      const c = resolveTurboCacheConfig({ url: 'https://c', token: 't', timeoutMs }, {})!
      await new TurboRemoteCache(c, seen).has('ab')
    }
    expect(signals.map((s) => s instanceof AbortSignal)).toEqual([false, true])
  })

  // Turbo's sources, highest first: TURBO_* env, then a Vercel build's
  // VERCEL_ARTIFACTS_TOKEN / _OWNER, then the repo's .turbo/config.json,
  // then turbo.json. vx read neither middle source, so it declined on Vercel
  // and after `turbo link`.
  it('reads VERCEL_ARTIFACTS_* and .turbo/config.json in Turbo’s order', () => {
    const pick = (
      env: Record<string, string>,
      local: Parameters<typeof resolveTurboCacheConfig>[3] = {},
    ) => {
      const c = resolveTurboCacheConfig({}, env, { teamId: 'team_json' }, local)
      return c && [c.url, c.token, c.teamId ?? null]
    }
    const vercel = { VERCEL_ARTIFACTS_TOKEN: 'vt', VERCEL_ARTIFACTS_OWNER: 'team_v' }
    const local = { apiUrl: 'https://link.example', teamId: 'team_link', token: 'lt' }
    expect([
      pick(vercel),
      pick({ ...vercel, TURBO_TOKEN: 'tt', TURBO_TEAMID: 'team_t' }),
      pick({ ...vercel, TURBO_TOKEN: 'tt' }),
      pick({ VERCEL_ARTIFACTS_TOKEN: 'vt' }),
      pick({}, local),
      pick({ TURBO_TOKEN: 'tt' }, local),
    ]).toEqual([
      ['https://vercel.com/api', 'vt', 'team_v'],
      ['https://vercel.com/api', 'tt', 'team_t'],
      ['https://vercel.com/api', 'tt', 'team_v'],
      ['https://vercel.com/api', undefined, 'team_json'],
      ['https://link.example', 'lt', 'team_link'],
      ['https://link.example', 'tt', 'team_link'],
    ])
  })

  // A workflow's `${{ vars.TURBO_API }}` is `''` when the variable is unset,
  // and Turbo reads `''` as unset. `??` took it as set: the empty URL turned
  // the cache off over turbo.json's apiUrl, and an empty TURBO_TOKEN hid a
  // Vercel build's VERCEL_ARTIFACTS_TOKEN.
  it('an empty TURBO_* variable is unset, as Turbo reads it', () => {
    const empty = { TURBO_API: '', TURBO_TOKEN: '', TURBO_TEAMID: '', TURBO_TEAM: '' }
    const c = resolveTurboCacheConfig({}, empty, {
      apiUrl: 'https://c.example',
      teamId: 'team_json',
    })
    const v = resolveTurboCacheConfig(
      {},
      {
        ...empty,
        VERCEL_ARTIFACTS_TOKEN: 'vt',
        VERCEL_ARTIFACTS_OWNER: 'team_v',
      },
    )
    const slug = resolveTurboCacheConfig({}, { TURBO_TEAM: '' }, { teamSlug: 'acme' })
    expect([c && [c.url, c.teamId], v && [v.url, v.token, v.teamId], slug?.teamSlug]).toEqual([
      ['https://c.example', 'team_json'],
      ['https://vercel.com/api', 'vt', 'team_v'],
      'acme',
    ])
  })

  // Turbo signs only under `remoteCache.signature: true`: a short env key
  // with the flag off refused the cache here and signed nothing there.
  it('the env signature key applies only where turbo.json turns signing on', () => {
    const env = { TURBO_TOKEN: 't', TURBO_REMOTE_CACHE_SIGNATURE_KEY: 'k'.repeat(32) }
    const key = (
      file: Parameters<typeof resolveTurboCacheConfig>[2],
      e: Record<string, string> = env,
    ) => resolveTurboCacheConfig({ teamId: 'team_1' }, e, file)?.signatureKey
    expect([
      key({}),
      key({ signature: false }),
      key({ signature: true }),
      key({}, { ...env, TURBO_REMOTE_CACHE_SIGNATURE_KEY: 'short' }),
      resolveTurboCacheConfig({ teamId: 'team_1', signatureKey: 'o'.repeat(32) }, env, {})
        ?.signatureKey,
    ]).toEqual([undefined, undefined, 'k'.repeat(32), undefined, 'o'.repeat(32)])
    // Turbo maps no TURBO_SIGNATURE (`turborepo-config/src/env.rs`): read here,
    // `0` skipped the verify turbo.json asks for and `yes` failed the run.
    expect([
      key({}, { ...env, TURBO_SIGNATURE: '1' }),
      key({ signature: true }, { ...env, TURBO_SIGNATURE: 'false' }),
      key({}, { ...env, TURBO_SIGNATURE: 'yes' }),
    ]).toEqual([undefined, 'k'.repeat(32), undefined])
  })

  it('a signatureKey option must be at least 32 bytes', () => {
    expect(() =>
      resolveTurboCacheConfig(
        { url: 'https://u', token: 't', signatureKey: 'short', teamId: 'team_1' },
        {},
      ),
    ).toThrow(/at least 32 bytes/)
    expect(MIN_SIGNATURE_KEY_LENGTH).toBe(32)
  })

  // Each names where the URL came from: TURBO_API was refused as a `url`
  // option the workspace never set.
  it('refuses a url with no http(s) scheme, naming options, TURBO_API or turbo.json', () => {
    expect(() => resolveTurboCacheConfig({ url: 'cache.example.com', token: 't' }, {})).toThrow(
      'turboCache() option "url" must be an http(s) URL, got "cache.example.com"',
    )
    expect(() =>
      resolveTurboCacheConfig({ token: 't' }, { TURBO_API: 'cache.example.com/' }),
    ).toThrow('TURBO_API must be an http(s) URL, got "cache.example.com"')
    expect(() =>
      resolveTurboCacheConfig({ token: 't' }, {}, { apiUrl: 'cache.example.com' }),
    ).toThrow('turbo.json remoteCache.apiUrl must be an http(s) URL, got "cache.example.com"')
  })

  it('refuses an url carrying user:pass@, from options or TURBO_API (gaps §8 L232)', () => {
    const refusal = (f: () => unknown): string => {
      try {
        f()
        return 'accepted'
      } catch (err) {
        return (err as Error).message
      }
    }
    const MSG =
      'turboCache() option "url" carries credentials (user:pass@); pass them as the token instead'
    const ENV = 'TURBO_API carries credentials (user:pass@); pass them as the token instead'
    expect([
      refusal(() => resolveTurboCacheConfig({ url: 'https://u:p@c.example', token: 't' }, {})),
      refusal(() => resolveTurboCacheConfig({ url: 'https://u@c.example', token: 't' }, {})),
      refusal(() =>
        resolveTurboCacheConfig({ token: 't' }, { TURBO_API: 'https://:p@c.example/' }),
      ),
    ]).toEqual([MSG, MSG, ENV])
    // CONTROL: the same host without userinfo resolves.
    expect(resolveTurboCacheConfig({ url: 'https://c.example', token: 't' }, {})?.url).toBe(
      'https://c.example',
    )
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
        { url: srv.url, token: TOKEN, teamId: 'team_1', teamSlug: 'acme', ...extra },
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
    expect(await c.has('aa11')).not.toBeNull()
    expect(srv.seen.at(-1)!.method).toBe('HEAD')
    expect(await c.has('bb22')).toBeNull()
    expect([...(await c.hasMany(['aa11', 'bb22']))!.keys()]).toEqual(['aa11'])
    const got = await c.get('aa11')
    expect(srv.seen.at(-1)!.headers['accept']).toBe('application/octet-stream')
    expect(got?.durationMs).toBe(1234)
    expect(await got!.body.bytes()).toEqual(body)
    expect(await c.get('bb22')).toBeNull()
  })

  // 2026-10-20: a read names the refs it may be answered from; a write
  // names none, since the server files it by the caller's token.
  it('every read names its refs in x-artifact-read-scopes; a PUT names none', async () => {
    const c = cache()
    c.reads = readScopes(['refs/heads/feat', 'refs/heads/main'])
    const from = srv.seen.length
    await c.put('a0c1', new Blob(['x']), { durationMs: 1 })
    await c.get('a0c1')
    await c.hasMany(['a0c1', 'a0c3'])
    expect(
      srv.seen
        .slice(from)
        .map(
          (r) =>
            `${r.method} ${new URL(r.url).pathname} ${r.headers['x-artifact-read-scopes'] ?? '-'}`,
        ),
    ).toEqual([
      'HEAD /v8/artifacts/a0c1 refs/heads/feat, refs/heads/main',
      'PUT /v8/artifacts/a0c1 -',
      'GET /v8/artifacts/a0c1 refs/heads/feat, refs/heads/main',
      'POST /v8/artifacts refs/heads/feat, refs/heads/main',
    ])
  })

  // Turbo's API client sends a team id only in Vercel's `team_` form; a
  // personal account's owner id (VERCEL_ARTIFACTS_OWNER) went out as one.
  it('sends teamId only in Vercel’s team_ form; the slug either way', async () => {
    const query = async (teamId: string) => {
      await cache({ teamId }).has('ab12')
      const u = new URL(srv.seen.at(-1)!.url)
      return [u.searchParams.get('teamId'), u.searchParams.get('slug')]
    }
    expect([await query('team_1'), await query('user_abc')]).toEqual([
      ['team_1', 'acme'],
      [null, 'acme'],
    ])
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

    it('a process exit with a verified body unread leaves no temp', async () => {
      // Core's signal exit is `process.exit`, which awaits no stream (item
      // 848): the exit itself must take the temp.
      const dir = await mkdtemp(path.join(tmpdir(), 'vx-turbo-exit-'))
      try {
        const script = `
          import { artifactTag, resolveTurboCacheConfig, TurboRemoteCache } from ${JSON.stringify(TURBO_CACHE)}
          import { readdirSync } from 'node:fs'
          const body = new Uint8Array(1024).fill(7)
          const tag = await artifactTag(Buffer.from(${JSON.stringify(KEY)}), 'ab90', 'team_1', new Blob([body]))
          const fetchImpl = async () => new Response(body, { headers: { 'x-artifact-tag': tag } })
          const config = resolveTurboCacheConfig(
            { url: 'http://turbo.invalid', token: 't', teamId: 'team_1', signatureKey: ${JSON.stringify(KEY)} },
            {},
          )
          const got = await new TurboRemoteCache(config, fetchImpl, ${JSON.stringify(dir)}).get('ab90')
          console.log(got === null ? 'miss' : readdirSync(${JSON.stringify(dir)}).length)
          process.exit(130)
        `
        const p = Bun.spawnSync([process.execPath, '-e', script], {
          stdout: 'pipe',
          stderr: 'pipe',
        })
        expect(p.stderr.toString()).toBe('')
        expect(p.exitCode).toBe(130)
        // The positive first: the temp existed when the process left.
        expect(p.stdout.toString().trim()).toBe('1')
        expect(await readdir(dir)).toEqual([])
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
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
        { url: 'http://turbo.invalid', token: TOKEN, teamId: 'team_1', signatureKey: KEY },
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
      'has-a': null,
      'has-b': null,
      get: null,
      // No answer: an empty map rewrote every key it asked as a miss.
      hasMany: null,
      put: false,
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
    expect(await c.has('aa11')).toBeNull()
    expect(await c.get('aa11')).toBeNull()
    // Not sent, so core counts no upload.
    expect(await c.put('ee55', new Blob(['x']), { durationMs: 1 })).toBe(false)
    // No answer, not "none held": core rewrites the keys a has-many
    // answers (`remote_hits`), and an empty map forgot every hit.
    expect(await c.hasMany(['aa11'])).toBeNull()
    expect(srv.seen.length).toBe(n) // no further requests
  })
})

describe('vx run with turboCache() layered over the local cache', () => {
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
      "export default { tasks: { build: { exec: { command: 'mkdir -p dist && cp src/app.js dist/app.js' }, inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } } } } }\n",
    )
    await Bun.write(
      path.join(root, '.vx/workspace.mjs'),
      localWorkspaceSource(
        [
          `turboCache({ url: ${JSON.stringify(srv.url)}, token: ${JSON.stringify(TOKEN)}, teamSlug: 'acme' })`,
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
    await rm(path.join(root, '.vx', 'cache'), { recursive: true, force: true })
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

  // L-19 through the wire: a server that hands back an artifact whose tar
  // is intact but whose body changed (one byte of dist/app.js) is a miss
  // that builds, never a hit that replays the changed bytes.
  it('an artifact the server altered is a miss that rebuilds, not a hit', async () => {
    const [hash, stored] = [...srv.store][0]!
    const tar = Bun.zstdDecompressSync(stored.body)
    const at = Buffer.from(tar).indexOf(Buffer.from('console.log("app")'))
    expect(at).toBeGreaterThan(0)
    const altered = new Uint8Array(tar)
    altered[at + 10] = 'f'.charCodeAt(0)
    srv.store.set(hash, { ...stored, body: Bun.zstdCompressSync(altered) })
    try {
      await rm(path.join(root, '.vx', 'cache'), { recursive: true, force: true })
      await rm(path.join(root, 'pkg', 'dist'), { recursive: true, force: true })
      const r = await run({ cwd: root, tasks: ['build'], handleSignals: false })
      expect({
        ok: r.ok,
        status: r.outcomes.map((o) => o.status),
        out: await Bun.file(path.join(root, 'pkg', 'dist', 'app.js')).text(),
      }).toEqual({ ok: true, status: ['success'], out: 'console.log("app")\n' })
    } finally {
      srv.store.set(hash, stored)
    }
  })

  it('the plugin reads the workspace’s turbo.json remoteCache', async () => {
    const ws = await mkdtemp(path.join(tmpdir(), 'vx-turbo-json-rc-'))
    const before = process.env['TURBO_TOKEN']
    try {
      process.env['TURBO_TOKEN'] = 't'
      const ctx = {
        warn: () => {},
        workspaceRoot: ws,
        cacheDir: ws,
        refs: [],
      }
      const on = async (turbo: unknown) => {
        await writeFile(path.join(ws, 'turbo.json'), JSON.stringify(turbo))
        return turboCache({}).cache?.(ctx as never) !== undefined
      }
      expect([
        await on({ remoteCache: { apiUrl: 'https://file.example' } }),
        await on({ remoteCache: { apiUrl: 'https://file.example', enabled: false } }),
      ]).toEqual([true, false])
    } finally {
      if (before === undefined) delete process.env['TURBO_TOKEN']
      else process.env['TURBO_TOKEN'] = before
      await rm(ws, { recursive: true, force: true })
    }
  })

  // A plugin moves bytes; core's cache.policy alone decides reads and
  // writes (2026-10-16), so Turbo's own switches change nothing.
  it('TURBO_CACHE and TURBO_REMOTE_CACHE_READ_ONLY leave the remote as it is', () => {
    const saved = { ...process.env }
    try {
      process.env['TURBO_TOKEN'] = 't'
      process.env['TURBO_API'] = 'https://c.example'
      const remote = (env: Record<string, string>) => {
        Object.assign(process.env, env)
        const ctx = {
          warn: () => {},
          workspaceRoot: root,
          cacheDir: root,
          scope: undefined,
          refs: [],
        }
        const r = turboCache({}).cache?.(ctx) as RemoteCacheLayer | undefined
        return r === undefined ? 'declined' : Object.keys(r).includes('access')
      }
      expect([
        remote({ TURBO_REMOTE_CACHE_READ_ONLY: 'true' }),
        remote({ TURBO_CACHE: 'local:rw' }),
      ]).toEqual([false, false])
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
      Object.assign(process.env, saved)
    }
  })

  // TURBO_FORCE (`true` or `1`, as Turbo reads it) is `turbo run --force`:
  // a CI that set it got hits replayed under turbo() (vercel/turborepo#921).
  // The remote is read by no forced run and written only where the
  // workspace's own policy names it: a laptop's write could reach CI.
  it('TURBO_FORCE turns every cache read off, through cache.policy', async () => {
    const saved = process.env['TURBO_FORCE']
    const policy = async (value: string | undefined, ws: WorkspaceConfig = {}) => {
      if (value === undefined) delete process.env['TURBO_FORCE']
      else process.env['TURBO_FORCE'] = value
      await turbo().config!(ws, { workspaceRoot: root, warn: () => {}, setBranch: () => {} })
      return ws.cache?.policy ?? null
    }
    try {
      expect([
        await policy(undefined),
        await policy('true'),
        await policy('1'),
        await policy('false'),
        await policy('yes'),
        await policy('true', { cache: { policy: 'local:rw,remote:rw' } }),
        await policy('true', { cache: { policy: 'remote:r' } }),
        await policy('true', { cache: { policy: 'local:r' } }),
      ]).toEqual([
        null,
        'local:w,remote:',
        'local:w,remote:',
        null,
        null,
        'local:w,remote:w',
        'local:w,remote:',
        'local:,remote:',
      ])
    } finally {
      if (saved === undefined) delete process.env['TURBO_FORCE']
      else process.env['TURBO_FORCE'] = saved
    }
  })

  it('a turbo() run under TURBO_FORCE runs its tasks and leaves the remote alone', async () => {
    const ws = await mkdtemp(path.join(tmpdir(), 'vx-turbo-force-'))
    const saved = process.env['TURBO_FORCE']
    try {
      await writeFile(
        path.join(ws, 'package.json'),
        JSON.stringify({ name: 'fixture', workspaces: ['pkg'] }),
      )
      await writeFile(
        path.join(ws, 'turbo.json'),
        JSON.stringify({ tasks: { build: { inputs: ['src/**'], outputs: ['dist/**'] } } }),
      )
      await mkdir(path.join(ws, 'pkg', 'src'), { recursive: true })
      await writeFile(
        path.join(ws, 'pkg', 'package.json'),
        JSON.stringify({ name: 'pkg', scripts: { build: 'mkdir -p dist && cp src/app.js dist/' } }),
      )
      await writeFile(path.join(ws, 'pkg', 'src', 'app.js'), 'console.log("app")\n')
      await Bun.write(
        path.join(ws, '.vx/workspace.mjs'),
        localWorkspaceSource(
          [
            'turbo()',
            `turboCache({ url: ${JSON.stringify(srv.url)}, token: ${JSON.stringify(TOKEN)}, teamSlug: 'acme' })`,
          ],
          `import { turbo, turboCache } from ${JSON.stringify(PLUGIN_INDEX)}\n`,
        ),
      )
      Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: ws })
      delete process.env['TURBO_FORCE']
      const status = async () =>
        (await run({ cwd: ws, tasks: ['build'], handleSignals: false })).outcomes.map(
          (o) => o.status,
        )
      const first = await status()
      const asked = srv.seen.length
      process.env['TURBO_FORCE'] = 'true'
      const forced = await status()
      const remoteAsked = srv.seen.length - asked
      delete process.env['TURBO_FORCE']
      expect({ first, forced, remoteAsked, after: await status() }).toEqual({
        first: ['success'],
        forced: ['success'],
        remoteAsked: 0,
        after: ['cache-hit'],
      })
    } finally {
      if (saved === undefined) delete process.env['TURBO_FORCE']
      else process.env['TURBO_FORCE'] = saved
      await rm(ws, { recursive: true, force: true })
    }
  })

  it('the plugin reads the repo’s .turbo/config.json, under Turbo’s aliases', async () => {
    const ws = await mkdtemp(path.join(tmpdir(), 'vx-turbo-link-'))
    const saved = process.env['TURBO_TOKEN']
    try {
      delete process.env['TURBO_TOKEN']
      const ctx = {
        warn: () => {},
        workspaceRoot: ws,
        cacheDir: ws,
        refs: [],
      }
      const on = () => turboCache({}).cache?.(ctx as never) !== undefined
      const before = on()
      await mkdir(path.join(ws, '.turbo'), { recursive: true })
      await writeFile(
        path.join(ws, '.turbo', 'config.json'),
        JSON.stringify({ apiurl: 'https://link.example', token: 'lt' }),
      )
      expect([before, on()]).toEqual([false, true])
    } finally {
      if (saved !== undefined) process.env['TURBO_TOKEN'] = saved
      await rm(ws, { recursive: true, force: true })
    }
  })

  it('the plugin declines without a url and a token', () => {
    const plugin = turboCache({})
    const ctx = {
      warn: () => {},
      workspaceRoot: root,
      cacheDir: root,
    }
    expect(plugin.cache?.(ctx as never)).toBeUndefined()
  })
})
