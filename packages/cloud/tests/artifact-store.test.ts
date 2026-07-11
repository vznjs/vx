// The serve-hosted artifact store: the vx-native `/v1/cache/:hash` wire
// (docs/design/native-cache-wire-2026-07.md), backed by a flat dir under the
// ingest root. Covered at three levels: the raw wire (PUT/HEAD/GET + the
// duration/digest sidecars + auth + limits incl. the streaming actual-bytes
// cap), a real end-to-end run with an injected NativeCacheClient pointed at
// the serve (miss → upload, local wipe → remote-hit restore), and the
// cloud() plugin's environment rung (lazy /v1/meta capability probe).

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  Cache,
  FULL_CACHE_POLICY,
  LayeredCache,
  run,
  type CacheContext,
  type Logger,
} from '@vzn/vx'
import { startServe } from '../src/cli/serve.js'
import { ArtifactStore, type Principal } from '../src/artifact-store.js'
import { NativeCacheClient } from '../src/native-cache.js'
import { ENVIRONMENTS_VERSION, writeEnvironmentsFile } from '../src/environments.js'
import { cloud } from '../src/plugin.js'

const TIMEOUT = 30_000

// PUT refuses a body that is not a zstd frame (an immutable store must never
// let junk lock a key), so every stored test body is real zstd. Deterministic
// per tag, so round-trip assertions compare against zbody(tag) bytes. The
// copy pins the ArrayBuffer generic — toEqual() against a fresh
// `new Uint8Array(await res.arrayBuffer())` needs both sides typed alike.
const zbody = (tag: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(Bun.zstdCompressSync(Buffer.from(tag)))

describe('vx serve /v1/cache — the native wire', () => {
  let dir: string
  let server: Awaited<ReturnType<typeof startServe>>
  const auth = { authorization: 'Bearer store-tok' }

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'vx-artifacts-'))
    server = await startServe({ root: dir, ingestDir: dir, token: 'store-tok' })
  })

  afterAll(async () => {
    await server.stop()
    await rm(dir, { recursive: true, force: true })
  })

  it('advertises the artifact store + wire version on /v1/meta', async () => {
    const meta = (await (await fetch(`${server.origin}/v1/meta`)).json()) as {
      artifacts: boolean
      cacheWire: number
    }
    expect(meta.artifacts).toBe(true)
    expect(meta.cacheWire).toBe(1)
  })

  it('PUT → HEAD → GET round-trips bytes + the duration/digest headers', async () => {
    const hash = 'a1b2c3d4e5f60718'
    const body = zbody('artifact-bytes-v1')
    const digest = `xxh3:${Bun.hash.xxHash3(body).toString(16).padStart(16, '0')}`

    // Miss before the upload.
    expect(
      (await fetch(`${server.origin}/v1/cache/${hash}`, { method: 'HEAD', headers: auth })).status,
    ).toBe(404)

    const put = await fetch(`${server.origin}/v1/cache/${hash}`, {
      method: 'PUT',
      headers: { ...auth, 'x-vx-digest': digest, 'x-vx-duration-ms': '42' },
      body,
    })
    expect(put.status).toBe(200)
    expect(((await put.json()) as { ok: boolean }).ok).toBe(true)

    // HEAD sees it now.
    const head = await fetch(`${server.origin}/v1/cache/${hash}`, {
      method: 'HEAD',
      headers: auth,
    })
    expect(head.status).toBe(200)

    // GET streams the exact bytes with content-length + the stored digest —
    // clients verify the digest against the received body.
    const get = await fetch(`${server.origin}/v1/cache/${hash}`, { headers: auth })
    expect(get.status).toBe(200)
    expect(get.headers.get('x-vx-digest')).toBe(digest)
    // The original task duration rides back too, so a remote hit records
    // honest analytics instead of durationMs 0.
    expect(get.headers.get('x-vx-duration-ms')).toBe('42')
    expect(Number(get.headers.get('content-length'))).toBe(body.byteLength)
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(body)

    // The backing files land in the token's scope (a single --token maps to
    // default/trusted): `<hash>.tar.zst` + sidecars.
    const files = await readdir(path.join(dir, 'artifacts', 'default', 'trusted'))
    expect(files.sort()).toEqual([`${hash}.digest`, `${hash}.duration`, `${hash}.tar.zst`])
  })

  it('omits the digest/duration headers on GET when the PUT carried none', async () => {
    const hash = 'feedfacefeedface'
    await fetch(`${server.origin}/v1/cache/${hash}`, {
      method: 'PUT',
      headers: auth,
      body: zbody('bare'),
    })
    const get = await fetch(`${server.origin}/v1/cache/${hash}`, { headers: auth })
    expect(get.status).toBe(200)
    expect(get.headers.get('x-vx-digest')).toBeNull()
    expect(get.headers.get('x-vx-duration-ms')).toBeNull()
  })

  it('ignores a malformed x-vx-digest instead of storing it', async () => {
    const hash = '0123456789abcdef'
    await fetch(`${server.origin}/v1/cache/${hash}`, {
      method: 'PUT',
      headers: { ...auth, 'x-vx-digest': 'sha256:deadbeef' },
      body: zbody('x'),
    })
    const get = await fetch(`${server.origin}/v1/cache/${hash}`, { headers: auth })
    expect(get.headers.get('x-vx-digest')).toBeNull()
  })

  it('is behind the bearer gate', async () => {
    const res = await fetch(`${server.origin}/v1/cache/a1b2c3d4e5f60718`)
    expect(res.status).toBe(401)
    const put = await fetch(`${server.origin}/v1/cache/cafebabecafebabe`, {
      method: 'PUT',
      headers: { authorization: 'Bearer wrong' },
      body: 'x',
    })
    expect(put.status).toBe(401)
  })

  it('rejects an oversized declared PUT with 413 and a hostile hash with 400', async () => {
    // fetch() recomputes Content-Length from the real body, so the declared-
    // length 413 branch is exercised against the handler directly (a
    // hand-built Request keeps the header).
    const { ArtifactStore, MAX_ARTIFACT_BYTES } = await import('../src/artifact-store.js')
    const store = new ArtifactStore(path.join(dir, 'artifacts'))
    const big = await store.handle(
      new Request('http://x/v1/cache/deadbeefdeadbeef', {
        method: 'PUT',
        headers: { 'content-length': String(MAX_ARTIFACT_BYTES + 1) },
        body: 'small-but-lying',
      }),
      'deadbeefdeadbeef',
    )
    expect(big.status).toBe(413)

    // A hostile hash never reaches the store through the serve (the hex-only
    // route can't match a traversal token); the store's own gate rejects it
    // for any embedder calling handle() directly.
    const evilDirect = await store.handle(
      new Request('http://x/v1/cache/whatever', { method: 'PUT', body: 'x' }),
      '../escape',
    )
    expect(evilDirect.status).toBe(400)
    await fetch(`${server.origin}/v1/cache/${encodeURIComponent('../escape')}`, {
      method: 'PUT',
      headers: auth,
      body: 'x',
    })
    const stored = await readdir(path.join(dir, 'artifacts')).catch(() => [] as string[])
    expect(stored.every((n) => !n.includes('escape'))).toBe(true)
  })

  it('caps a chunked PUT on ACTUAL streamed bytes — 413, nothing stored', async () => {
    // No content-length at all (a chunked body): the declared-length
    // pre-check can't fire, so only the mid-stream cumulative cap stands
    // between a hostile client and the disk.
    const scratch = await mkdtemp(path.join(tmpdir(), 'vx-stream-cap-'))
    try {
      const store = new ArtifactStore(path.join(scratch, 'artifacts'), 1024)
      const chunk = new Uint8Array(300).fill(65)
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < 5; i++) controller.enqueue(chunk) // 1500 bytes > 1024 cap
          controller.close()
        },
      })
      const res = await store.handle(
        new Request('http://x/v1/cache/beefbeefbeef0001', { method: 'PUT', body: stream }),
        'beefbeefbeef0001',
      )
      expect(res.status).toBe(413)
      // Nothing stored: no artifact, no leftover temp file.
      const scopeDir = path.join(scratch, 'artifacts', 'default', 'trusted')
      const names = await readdir(scopeDir).catch(() => [] as string[])
      expect(names).toEqual([])
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })

  it('PUT rejects an empty body — the key is NOT locked for the real upload', async () => {
    // Immutability makes a stored body permanent, so an accidental empty
    // upload (buggy client, stripped body) must never become an entry: 400,
    // nothing stored, and the legitimate artifact still lands afterwards.
    const hash = 'e0e0e0e0e0e0e0e0'
    const empty = await fetch(`${server.origin}/v1/cache/${hash}`, {
      method: 'PUT',
      headers: auth,
    })
    expect(empty.status).toBe(400)
    expect(
      (await fetch(`${server.origin}/v1/cache/${hash}`, { method: 'HEAD', headers: auth })).status,
    ).toBe(404)
    // The key stays writable — the real bytes are not locked out.
    const real = await fetch(`${server.origin}/v1/cache/${hash}`, {
      method: 'PUT',
      headers: auth,
      body: zbody('the-real-artifact'),
    })
    expect(real.status).toBe(200)
    const got = await fetch(`${server.origin}/v1/cache/${hash}`, { headers: auth })
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(zbody('the-real-artifact'))
  })

  it('PUT rejects a non-zstd body (junk cannot become an immutable entry)', async () => {
    const hash = 'f1f1f1f1f1f1f1f1'
    const junk = await fetch(`${server.origin}/v1/cache/${hash}`, {
      method: 'PUT',
      headers: auth,
      body: '<html>proxy error page</html>',
    })
    expect(junk.status).toBe(400)
    expect(
      (await fetch(`${server.origin}/v1/cache/${hash}`, { method: 'HEAD', headers: auth })).status,
    ).toBe(404)
    // No temp/partial file survives the rejection.
    const files = await readdir(path.join(dir, 'artifacts', 'default', 'trusted'))
    expect(files.every((n) => !n.startsWith(hash))).toBe(true)
  })

  it('has() is a local stat: present after PUT, false for unknown/hostile hashes', async () => {
    const { ArtifactStore } = await import('../src/artifact-store.js')
    const store = new ArtifactStore(path.join(dir, 'artifacts'))
    const hash = 'beefbeefbeefbeef'
    expect(await store.has(hash)).toBe(false)
    await fetch(`${server.origin}/v1/cache/${hash}`, {
      method: 'PUT',
      headers: { ...auth, 'x-vx-duration-ms': '7' },
      body: zbody('probe-me'),
    })
    expect(await store.has(hash)).toBe(true)
    expect(await store.storedDurationMs(hash)).toBe(7)
    expect(await store.storedDurationMs('0000000000000000')).toBeUndefined()
    expect(await store.has('../escape')).toBe(false)
  })

  it('404s a GET for an unknown hash and 405s other methods', async () => {
    const get = await fetch(`${server.origin}/v1/cache/0000000000000000`, { headers: auth })
    expect(get.status).toBe(404)
    const del = await fetch(`${server.origin}/v1/cache/0000000000000000`, {
      method: 'DELETE',
      headers: auth,
    })
    expect(del.status).toBe(405)
  })

  it('never shadows the named /v1/cache/* analytics routes', async () => {
    // `stats` is not a hex hash, so the artifact route must not swallow it —
    // it reaches the analytics handler (JSON body, not an artifact 404).
    const res = await fetch(`${server.origin}/v1/cache/stats`, { headers: auth })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toHaveProperty('entryCount')
  })
})

// ---------------------------------------------------------------------------
// End-to-end: a real run with an injected NativeCacheClient at the serve
// ---------------------------------------------------------------------------

const silentLogger: Logger = {
  status() {},
  taskStdout() {},
  taskStderr() {},
  taskComplete() {},
}

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'vx-serve-remote-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-root', private: true }),
  )
  const dir = path.join(root, 'packages', 'app')
  await mkdir(path.join(dir, 'src'), { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'app', version: '0.0.0' }))
  await writeFile(path.join(dir, 'src', 'in.txt'), 'v1')
  await writeFile(
    path.join(dir, 'vx.config.mjs'),
    `
      export default {
        tasks: {
          build: {
            exec: { command: 'echo built > out.txt' },
            cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
          },
        },
      }
    `,
  )
  const git = (...args: string[]) => Bun.spawnSync({ cmd: ['git', ...args], cwd: root })
  git('init', '-q')
  git('config', 'user.email', 't@vx.local')
  git('config', 'user.name', 'vx test')
  git('add', '-A')
  git('commit', '-qm', 'init')
  return root
}

describe('e2e: vx run against the serve-hosted artifact store', () => {
  it(
    'miss → upload to the serve; local wipe → the remote hit restores (digest-verified)',
    async () => {
      const ingestDir = await mkdtemp(path.join(tmpdir(), 'vx-serve-store-'))
      const server = await startServe({ root: ingestDir, ingestDir, token: 'store-tok' })
      const root = await makeWorkspace()
      const remoteCache = new NativeCacheClient({ baseUrl: server.origin, token: 'store-tok' })
      try {
        const first = await run({ cwd: root, tasks: ['build'], log: silentLogger, remoteCache })
        expect(first.ok).toBe(true)
        expect(first.outcomes[0]!.status).toBe('success')

        // The write-through upload landed in the token's scope
        // (default/trusted) — artifact + the digest/duration sidecars.
        const files = (
          await readdir(path.join(ingestDir, 'artifacts', 'default', 'trusted'))
        ).sort()
        expect(files.length).toBe(3)
        expect(files[0]!.endsWith('.digest')).toBe(true)
        expect(files[1]!.endsWith('.duration')).toBe(true)
        expect(files[2]!.endsWith('.tar.zst')).toBe(true)

        // Wipe the local cache: the serve is now the only source of truth.
        await rm(path.join(root, '.vx'), { recursive: true, force: true })

        const second = await run({ cwd: root, tasks: ['build'], log: silentLogger, remoteCache })
        expect(second.ok).toBe(true)
        // A remote hit proves the GET round-trip INCLUDING the returned
        // x-vx-digest (the client verifies it before restoring).
        expect(second.outcomes[0]!.status).toBe('cache-hit-remote')
        expect(await Bun.file(path.join(root, 'packages', 'app', 'out.txt')).text()).toContain(
          'built',
        )
      } finally {
        await server.stop()
        await rm(root, { recursive: true, force: true })
        await rm(ingestDir, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})

// ---------------------------------------------------------------------------
// cloud() plugin — the environment rung of the cache capability
// ---------------------------------------------------------------------------

function cacheCtx(localCache: Cache, root: string): CacheContext {
  return {
    workspaceRoot: root,
    cacheDir: path.join(root, '.vx', 'cache'),
    warn: () => {},
    localCache,
    policy: FULL_CACHE_POLICY,
  }
}

/** A mock serve answering /v1/meta + recording /v1/cache requests. */
function mockServe(cacheWire: boolean): {
  server: ReturnType<typeof Bun.serve>
  origin: string
  metaHits: () => number
  cacheRequests: { hash: string; auth: string | null }[]
} {
  const cacheRequests: { hash: string; auth: string | null }[] = []
  let meta = 0
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/v1/meta') {
        meta++
        return Response.json({
          v: 1,
          name: 'mock',
          auth: 'token',
          artifacts: cacheWire,
          ...(cacheWire ? { cacheWire: 1 } : {}),
        })
      }
      const m = url.pathname.match(/^\/v1\/cache\/([^/]+)$/)
      if (m) {
        cacheRequests.push({ hash: m[1]!, auth: req.headers.get('authorization') })
        return new Response(null, { status: 404 })
      }
      return new Response('nope', { status: 404 })
    },
  })
  return {
    server,
    origin: `http://localhost:${server.port}`,
    metaHits: () => meta,
    cacheRequests,
  }
}

describe('cloud() cache capability — environment rung', () => {
  const savedEnv: Record<string, string | undefined> = {}
  const KEYS = ['VX_CLOUD_URL', 'VX_CLOUD_TOKEN', 'VX_CLOUD_CONFIG', 'VX_CLOUD_ENV']
  let root: string
  let localCache: Cache

  beforeEach(async () => {
    for (const k of KEYS) {
      savedEnv[k] = process.env[k]
      delete process.env[k]
    }
    root = await mkdtemp(path.join(tmpdir(), 'vx-env-rung-'))
    // Fresh per-test environments file (the reader memoizes per path).
    process.env['VX_CLOUD_CONFIG'] = path.join(root, 'environments.json')
    localCache = new Cache(path.join(root, '.vx', 'cache'))
  })

  afterEach(async () => {
    localCache.close()
    await rm(root, { recursive: true, force: true })
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  function connectTo(url: string): void {
    writeEnvironmentsFile({
      version: ENVIRONMENTS_VERSION,
      active: 'team',
      environments: { team: { url, token: 'env-tok' } },
    })
  }

  it('builds a LayeredCache against the active environment when its serve advertises the cache wire', async () => {
    const mock = mockServe(true)
    try {
      connectTo(mock.origin)
      const layer = (await cloud().cache!(cacheCtx(localCache, root))) as LayeredCache
      expect(layer).toBeInstanceOf(LayeredCache)

      // A local miss reads through to the environment's serve, carrying the
      // environment's bearer token.
      const entry = await layer.get('deadbeefdeadbeef', { taskId: 'demo#build', command: 'x' })
      expect(entry).toBeNull()
      expect(mock.cacheRequests.length).toBe(1)
      expect(mock.cacheRequests[0]!.hash).toBe('deadbeefdeadbeef')
      expect(mock.cacheRequests[0]!.auth).toBe('Bearer env-tok')
      expect(mock.metaHits()).toBe(1)
    } finally {
      void mock.server.stop(true)
    }
  })

  it('declines when the environment serve does not advertise the cache wire', async () => {
    const mock = mockServe(false)
    try {
      connectTo(mock.origin)
      const layer = await cloud().cache!(cacheCtx(localCache, root))
      expect(layer).toBeUndefined()
      expect(mock.metaHits()).toBe(1)
    } finally {
      void mock.server.stop(true)
    }
  })

  it('never probes /v1/meta when an explicit URL already configures the cache', async () => {
    const mock = mockServe(true)
    const explicit = mockServe(true)
    try {
      connectTo(mock.origin)
      process.env['VX_CLOUD_URL'] = explicit.origin
      process.env['VX_CLOUD_TOKEN'] = 'explicit-tok'
      const layer = (await cloud().cache!(cacheCtx(localCache, root))) as LayeredCache
      expect(layer).toBeInstanceOf(LayeredCache)

      await layer.get('deadbeefdeadbeef')
      // The explicit config won: its store saw the read; the connected
      // environment was never probed at all.
      expect(explicit.cacheRequests.length).toBe(1)
      expect(explicit.cacheRequests[0]!.auth).toBe('Bearer explicit-tok')
      expect(mock.metaHits()).toBe(0)
      expect(mock.cacheRequests.length).toBe(0)
    } finally {
      void mock.server.stop(true)
      void explicit.server.stop(true)
    }
  })

  it('declines with zero network when nothing is configured (the plain-run pin)', async () => {
    // No env vars, no environments file → undefined without any probe.
    const layer = await cloud().cache!(cacheCtx(localCache, root))
    expect(layer).toBeUndefined()
  })

  it('an unreachable environment serve declines instead of failing', async () => {
    connectTo('http://localhost:1')
    const layer = await cloud().cache!(cacheCtx(localCache, root))
    expect(layer).toBeUndefined()
  })
})

describe('ArtifactStore — trust scopes (poisoning guard)', () => {
  let dir: string
  const trusted = { orgId: 'default', tier: 'trusted', bucket: 'default' } as const
  const untrusted = { orgId: 'default', tier: 'untrusted', bucket: 'default' } as const

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'vx-scope-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const hdrs = (scope?: string) =>
    scope !== undefined ? { headers: { 'x-vx-cache-scope': scope } } : {}
  const put = (store: ArtifactStore, hash: string, tag: string, p: Principal, scope?: string) =>
    store.handle(
      new Request(`http://x/v1/cache/${hash}`, { method: 'PUT', body: zbody(tag), ...hdrs(scope) }),
      hash,
      p,
    )
  const get = (store: ArtifactStore, hash: string, p: Principal, scope?: string) =>
    store.handle(new Request(`http://x/v1/cache/${hash}`, hdrs(scope)), hash, p)

  it('an untrusted write NEVER feeds a trusted read (quarantine)', async () => {
    const store = new ArtifactStore(path.join(dir, 'artifacts'))
    const hash = 'a1b2c3d4e5f60718'
    // A fork PR poisons the key.
    expect((await put(store, hash, 'evil', untrusted)).status).toBe(200)
    // A trusted (main) build for the SAME key must NOT see it — 404.
    expect((await get(store, hash, trusted)).status).toBe(404)
    // It lives only under untrusted/<sub> (default sub-scope: `shared`).
    const under = await readdir(path.join(dir, 'artifacts', 'default', 'untrusted', 'shared'))
    expect(under).toContain(`${hash}.tar.zst`)
  })

  it('one PR NEVER reads or poisons another PR (per-PR isolated untrusted scope)', async () => {
    const store = new ArtifactStore(path.join(dir, 'artifacts'))
    const hash = 'aabbccddeeff0011'
    // PR-A writes under its own sub-scope.
    expect((await put(store, hash, 'from-pr-A', untrusted, 'pr-1')).status).toBe(200)
    // PR-B (a DIFFERENT sub-scope) must NOT see PR-A's artifact — 404, no leak.
    expect((await get(store, hash, untrusted, 'pr-2')).status).toBe(404)
    // PR-B can write the SAME key in its OWN scope (not blocked by PR-A, no
    // cross-poison): immutability is per-scope.
    expect((await put(store, hash, 'from-pr-B', untrusted, 'pr-2')).status).toBe(200)
    // Each PR reads back its OWN bytes.
    const a = await (await get(store, hash, untrusted, 'pr-1')).arrayBuffer()
    expect(new Uint8Array(a)).toEqual(zbody('from-pr-A'))
    const b = await (await get(store, hash, untrusted, 'pr-2')).arrayBuffer()
    expect(new Uint8Array(b)).toEqual(zbody('from-pr-B'))
    // A trusted build still sees NEITHER.
    expect((await get(store, hash, trusted)).status).toBe(404)
  })

  it('an untrusted read falls through to the trusted baseline (warm PR)', async () => {
    const store = new ArtifactStore(path.join(dir, 'artifacts'))
    const hash = 'cafebabecafebabe'
    expect((await put(store, hash, 'legit', trusted)).status).toBe(200)
    // The PR warms off main's cache.
    const got = await get(store, hash, untrusted)
    expect(got.status).toBe(200)
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(zbody('legit'))
  })

  it('an untrusted write cannot overwrite a trusted artifact', async () => {
    const store = new ArtifactStore(path.join(dir, 'artifacts'))
    const hash = 'feedfacefeedface'
    expect((await put(store, hash, 'legit', trusted)).status).toBe(200)
    // The untrusted PUT lands in untrusted/, leaving trusted/ untouched.
    expect((await put(store, hash, 'evil', untrusted)).status).toBe(200)
    const trustedGet = await get(store, hash, trusted)
    expect(new Uint8Array(await trustedGet.arrayBuffer())).toEqual(zbody('legit'))
  })

  it('artifacts are immutable — a re-PUT of an existing hash is refused (409)', async () => {
    const store = new ArtifactStore(path.join(dir, 'artifacts'))
    const hash = '0011223344556677'
    expect((await put(store, hash, 'first', trusted)).status).toBe(200)
    expect((await put(store, hash, 'overwrite', trusted)).status).toBe(409)
    const got = await get(store, hash, trusted)
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(zbody('first'))
  })

  it('a `..` / `.` sub-scope collapses to `shared` (no bucket-root scatter)', async () => {
    const store = new ArtifactStore(path.join(dir, 'artifacts'))
    const hash = 'ddccbbaa00112233'
    // An untrusted PUT claiming sub-scope `..` must not land at the bucket
    // root; it collapses to the `shared` sub-scope like any invalid value.
    expect((await put(store, hash, 'x', untrusted, '..')).status).toBe(200)
    const shared = await readdir(path.join(dir, 'artifacts', 'default', 'untrusted', 'shared'))
    expect(shared).toContain(`${hash}.tar.zst`)
    // Nothing was written up at the bucket root.
    const bucketRoot = await readdir(path.join(dir, 'artifacts', 'default'))
    expect(bucketRoot.every((n) => !n.endsWith('.tar.zst'))).toBe(true)
  })

  it('migrates a legacy flat store into default/trusted/', async () => {
    const artDir = path.join(dir, 'artifacts')
    await mkdir(artDir, { recursive: true })
    await writeFile(path.join(artDir, 'deadbeefdeadbeef.tar.zst'), 'legacy')
    await writeFile(path.join(artDir, 'deadbeefdeadbeef.duration'), '12')
    const store = new ArtifactStore(artDir)
    await store.migrateLegacyFlatStore()
    const got = await get(store, 'deadbeefdeadbeef', trusted)
    expect(got.status).toBe(200)
    expect(await got.text()).toBe('legacy')
    const moved = await readdir(path.join(artDir, 'default', 'trusted'))
    expect(moved.sort()).toEqual(['deadbeefdeadbeef.duration', 'deadbeefdeadbeef.tar.zst'])
  })
})

describe('ArtifactStore — org/workspace tenancy prefix (platform §8.1)', () => {
  let dir: string
  // Tenant-derived principals (no `bucket` override): the scope base is
  // `org/<orgId>/ws/<workspaceId ?? _org>`.
  const orgAws1: Principal = { orgId: 'org-a', workspaceId: 'ws-1', tier: 'trusted' }
  const orgAws1Pr: Principal = { orgId: 'org-a', workspaceId: 'ws-1', tier: 'untrusted' }
  const orgAws2: Principal = { orgId: 'org-a', workspaceId: 'ws-2', tier: 'trusted' }
  const orgBws1: Principal = { orgId: 'org-b', workspaceId: 'ws-1', tier: 'trusted' }
  const orgAwide: Principal = { orgId: 'org-a', tier: 'trusted' }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'vx-tenant-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const put = (store: ArtifactStore, hash: string, tag: string, p: Principal) =>
    store.handle(
      new Request(`http://x/v1/cache/${hash}`, { method: 'PUT', body: zbody(tag) }),
      hash,
      p,
    )
  const get = (store: ArtifactStore, hash: string, p: Principal) =>
    store.handle(new Request(`http://x/v1/cache/${hash}`), hash, p)

  it('a write lands under org/<orgId>/ws/<wsId>/<tier>', async () => {
    const store = new ArtifactStore(path.join(dir, 'artifacts'))
    const hash = 'a1a2a3a4a5a6a7a8'
    expect((await put(store, hash, 'bytes', orgAws1)).status).toBe(200)
    const under = await readdir(
      path.join(dir, 'artifacts', 'org', 'org-a', 'ws', 'ws-1', 'trusted'),
    )
    expect(under).toContain(`${hash}.tar.zst`)
    // The writer reads it back; a same-tier peer in the same tenant does too.
    expect((await get(store, hash, orgAws1)).status).toBe(200)
  })

  it("a second org NEVER reads org A's cache key", async () => {
    const store = new ArtifactStore(path.join(dir, 'artifacts'))
    const hash = 'b1b2b3b4b5b6b7b8'
    expect((await put(store, hash, 'org-a-bytes', orgAws1)).status).toBe(200)
    // Same key, same workspace slug, DIFFERENT org → 404 (cross-tenant clamp).
    expect((await get(store, hash, orgBws1)).status).toBe(404)
  })

  it('two workspaces in one org are isolated', async () => {
    const store = new ArtifactStore(path.join(dir, 'artifacts'))
    const hash = 'c1c2c3c4c5c6c7c8'
    expect((await put(store, hash, 'ws1-bytes', orgAws1)).status).toBe(200)
    // A different workspace in the SAME org can't read it.
    expect((await get(store, hash, orgAws2)).status).toBe(404)
    // ...and can write the same key in its own scope.
    expect((await put(store, hash, 'ws2-bytes', orgAws2)).status).toBe(200)
    const w1 = await (await get(store, hash, orgAws1)).arrayBuffer()
    expect(new Uint8Array(w1)).toEqual(zbody('ws1-bytes'))
    const w2 = await (await get(store, hash, orgAws2)).arrayBuffer()
    expect(new Uint8Array(w2)).toEqual(zbody('ws2-bytes'))
  })

  it('trust tiers hold within a tenant: untrusted never feeds trusted', async () => {
    const store = new ArtifactStore(path.join(dir, 'artifacts'))
    const hash = 'd1d2d3d4d5d6d7d8'
    // A fork PR under org-a/ws-1 poisons the key.
    expect((await put(store, hash, 'evil', orgAws1Pr)).status).toBe(200)
    const under = await readdir(
      path.join(dir, 'artifacts', 'org', 'org-a', 'ws', 'ws-1', 'untrusted', 'shared'),
    )
    expect(under).toContain(`${hash}.tar.zst`)
    // The trusted build for the same tenant/key must NOT see it.
    expect((await get(store, hash, orgAws1)).status).toBe(404)
    // A DIFFERENT key present only in the tenant's trusted scope warms the PR
    // (it has no own untrusted copy to shadow the baseline).
    const warmHash = 'd9dadbdcdddedf00'
    expect((await put(store, warmHash, 'legit', orgAws1)).status).toBe(200)
    const warm = await get(store, warmHash, orgAws1Pr)
    expect(warm.status).toBe(200)
    expect(new Uint8Array(await warm.arrayBuffer())).toEqual(zbody('legit'))
  })

  it('an org-wide token (no workspace) uses the shared _org segment', async () => {
    const store = new ArtifactStore(path.join(dir, 'artifacts'))
    const hash = 'e1e2e3e4e5e6e7e8'
    expect((await put(store, hash, 'shared', orgAwide)).status).toBe(200)
    const under = await readdir(
      path.join(dir, 'artifacts', 'org', 'org-a', 'ws', '_org', 'trusted'),
    )
    expect(under).toContain(`${hash}.tar.zst`)
    // A workspace-scoped token in the same org does NOT see the _org cache.
    expect((await get(store, hash, orgAws1)).status).toBe(404)
  })
})

describe('ArtifactStore.list — trust-scoped listing (/v1/artifacts source)', () => {
  let dir: string
  const trusted = { orgId: 'default', tier: 'trusted', bucket: 'default' } as const
  const untrusted = { orgId: 'default', tier: 'untrusted', bucket: 'default' } as const

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'vx-artlist-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const put = (
    store: ArtifactStore,
    hash: string,
    tag: string,
    p: Principal,
    scope?: string,
    duration?: string,
  ) =>
    store.handle(
      new Request(`http://x/v1/cache/${hash}`, {
        method: 'PUT',
        body: zbody(tag),
        headers: {
          ...(scope !== undefined ? { 'x-vx-cache-scope': scope } : {}),
          ...(duration !== undefined ? { 'x-vx-duration-ms': duration } : {}),
        },
      }),
      hash,
      p,
    )

  it('an empty store lists []', async () => {
    const store = new ArtifactStore(path.join(dir, 'artifacts'))
    expect(await store.list(trusted)).toEqual([])
  })

  it('a trusted principal NEVER lists untrusted entries', async () => {
    const store = new ArtifactStore(path.join(dir, 'artifacts'))
    await put(store, 'aaaaaaaaaaaaaaaa', 'evil', untrusted)
    await put(store, 'bbbbbbbbbbbbbbbb', 'legit', trusted)
    const rows = await store.list(trusted)
    expect(rows.map((r) => r.hash)).toEqual(['bbbbbbbbbbbbbbbb'])
    expect(rows[0]!.tier).toBe('trusted')
    expect(rows[0]!.sizeBytes).toBe(zbody('legit').byteLength)
  })

  it('an untrusted principal lists its own sub-scope ∪ trusted — never another PR', async () => {
    const store = new ArtifactStore(path.join(dir, 'artifacts'))
    await put(store, 'aaaaaaaaaaaaaaaa', 'from-pr-1', untrusted, 'pr-1')
    await put(store, 'bbbbbbbbbbbbbbbb', 'baseline', trusted)
    const pr1 = await store.list(untrusted, 'pr-1')
    expect(pr1.map((r) => `${r.hash}:${r.tier}`).sort()).toEqual([
      'aaaaaaaaaaaaaaaa:untrusted',
      'bbbbbbbbbbbbbbbb:trusted',
    ])
    // A DIFFERENT PR sees only the trusted baseline.
    const pr2 = await store.list(untrusted, 'pr-2')
    expect(pr2.map((r) => r.hash)).toEqual(['bbbbbbbbbbbbbbbb'])
  })

  it('the duration sidecar rides as durationMs', async () => {
    const store = new ArtifactStore(path.join(dir, 'artifacts'))
    await put(store, 'cccccccccccccccc', 'x', trusted, undefined, '1234')
    const rows = await store.list(trusted)
    expect(rows[0]!.durationMs).toBe(1234)
  })

  it('a hash in both readable scopes lists ONCE, own scope first (GET-resolution parity)', async () => {
    const store = new ArtifactStore(path.join(dir, 'artifacts'))
    await put(store, 'dddddddddddddddd', 'own-copy', untrusted, 'pr-1')
    await put(store, 'dddddddddddddddd', 'baseline', trusted)
    const rows = await store.list(untrusted, 'pr-1')
    expect(rows).toHaveLength(1)
    // GET would resolve the sub-scope copy first; the list says the same.
    expect(rows[0]!.tier).toBe('untrusted')
    expect(rows[0]!.sizeBytes).toBe(zbody('own-copy').byteLength)
  })

  it('respects limit, newest first', async () => {
    const store = new ArtifactStore(path.join(dir, 'artifacts'))
    await put(store, 'eeeeeeeeeeeeeee1', 'one', trusted)
    await Bun.sleep(5)
    await put(store, 'eeeeeeeeeeeeeee2', 'two', trusted)
    const rows = await store.list(trusted, null, 1)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.hash).toBe('eeeeeeeeeeeeeee2')
  })
})

describe('GET /v1/artifacts — the store list + provenance join', () => {
  let dir: string
  let server: Awaited<ReturnType<typeof startServe>>
  const auth = { authorization: 'Bearer list-tok' }

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'vx-artlist-serve-'))
    server = await startServe({ root: dir, ingestDir: dir, token: 'list-tok' })
  })
  afterAll(async () => {
    await server.stop()
    await rm(dir, { recursive: true, force: true })
  })

  it('requires the bearer', async () => {
    expect((await fetch(`${server.origin}/v1/artifacts`)).status).toBe(401)
  })

  it('lists stored artifacts with best-effort task/run provenance', async () => {
    const hash = 'f00dfacef00dface'
    // Store an artifact via the native wire.
    const putRes = await fetch(`${server.origin}/v1/cache/${hash}`, {
      method: 'PUT',
      headers: { ...auth, 'x-vx-duration-ms': '77' },
      body: zbody('bytes'),
    })
    expect(putRes.status).toBe(200)
    // Ingest a run summary whose task produced that hash.
    const runId = 'run-artifact-join'
    const at = Date.now()
    const ingestRes = await fetch(`${server.origin}/v1/ingest`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        v: 2,
        run: {
          runId,
          vxVersion: '0.0.0',
          workspaceId: 'ws-art',
          workspaceName: 'art-ws',
          command: 'vx run build',
          requestedTasks: ['build'],
          cachePolicy: 'lR,lW,rR,rW',
          concurrency: 1,
          flow: 'focused',
          commitSha: 'c0ffee',
          branch: 'main',
          dirty: false,
          ci: false,
          ciProvider: null,
          host: 'box',
          os: 'linux',
          arch: 'x64',
          tags: {},
        },
        startedAt: at,
        endedAt: at + 100,
        totalDurationMs: 100,
        taskCount: 1,
        failedCount: 0,
        hitCount: 0,
        hitLocalCount: 0,
        hitRemoteCount: 0,
        exitOk: true,
        tasks: [
          {
            taskId: 'demo#build',
            project: 'demo',
            task: 'build',
            status: 'success',
            cacheSource: 'miss',
            exitCode: 0,
            durationMs: 77,
            hash,
          },
        ],
      }),
    })
    expect(ingestRes.ok).toBe(true)

    const res = await fetch(`${server.origin}/v1/artifacts`, { headers: auth })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      artifacts: Array<{
        hash: string
        sizeBytes: number
        durationMs?: number
        tier: string
        task?: { project: string; task: string; runId?: string }
      }>
    }
    const row = body.artifacts.find((a) => a.hash === hash)
    expect(row).toBeDefined()
    expect(row!.sizeBytes).toBe(zbody('bytes').byteLength)
    expect(row!.durationMs).toBe(77)
    expect(row!.tier).toBe('trusted')
    expect(row!.task).toEqual({ project: 'demo', task: 'build', runId })
  })

  it('an artifact no ingested run produced has no task field', async () => {
    const hash = 'beefbeefbeefbeef'
    await fetch(`${server.origin}/v1/cache/${hash}`, {
      method: 'PUT',
      headers: auth,
      body: zbody('orphan'),
    })
    const res = await fetch(`${server.origin}/v1/artifacts`, { headers: auth })
    const body = (await res.json()) as { artifacts: Array<{ hash: string; task?: unknown }> }
    const row = body.artifacts.find((a) => a.hash === hash)
    expect(row).toBeDefined()
    expect(row!.task).toBeUndefined()
  })
})
