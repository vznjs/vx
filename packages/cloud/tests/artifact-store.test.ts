// The ArtifactStore — the vx-native `/v1/cache/:hash` wire policy
// (docs/design/native-cache-wire-2026-07.md), driven directly against the
// store (backend-agnostic; the platform's S3 path + the full HTTP round-trip
// live in blob-store-s3.test.ts + server.test.ts). Covered here: the raw
// request policy (caps, zstd-magic, hostile hashes, has/storedDurationMs),
// the trust-scope + tenancy + list matrix, and the cloud() plugin's
// environment rung (lazy /v1/meta capability probe against a mock serve).

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Cache, FULL_CACHE_POLICY, LayeredCache, type CacheContext } from '@vzn/vx'
import { ArtifactStore, MAX_ARTIFACT_BYTES, type Principal } from '../src/artifact-store.js'
import { ENVIRONMENTS_VERSION, writeEnvironmentsFile } from '../src/environments.js'
import { cloud } from '../src/plugin.js'

// PUT refuses a body that is not a zstd frame (an immutable store must never
// let junk lock a key), so every stored test body is real zstd. Deterministic
// per tag, so round-trip assertions compare against zbody(tag) bytes. The
// copy pins the ArrayBuffer generic — toEqual() against a fresh
// `new Uint8Array(await res.arrayBuffer())` needs both sides typed alike.
const zbody = (tag: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(Bun.zstdCompressSync(Buffer.from(tag)))

describe('ArtifactStore — native-wire request policy (LocalDirBackend)', () => {
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'vx-artifacts-'))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('rejects an oversized declared PUT with 413 and a hostile hash with 400', async () => {
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

    // A hostile hash never becomes an entry — the store's own gate rejects a
    // traversal token for any embedder calling handle() directly.
    const evilDirect = await store.handle(
      new Request('http://x/v1/cache/whatever', { method: 'PUT', body: 'x' }),
      '../escape',
    )
    expect(evilDirect.status).toBe(400)
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
      const names = await readdir(path.join(scratch, 'artifacts', 'default', 'trusted')).catch(
        () => [] as string[],
      )
      expect(names).toEqual([])
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })

  it('has()/storedDurationMs are a local stat; false for unknown/hostile hashes', async () => {
    const store = new ArtifactStore(path.join(dir, 'artifacts'))
    const hash = 'beefbeefbeefbeef'
    expect(await store.has(hash)).toBe(false)
    const put = await store.handle(
      new Request(`http://x/v1/cache/${hash}`, {
        method: 'PUT',
        headers: { 'x-vx-duration-ms': '7' },
        body: zbody('probe-me'),
      }),
      hash,
    )
    expect(put.status).toBe(200)
    expect(await store.has(hash)).toBe(true)
    expect(await store.storedDurationMs(hash)).toBe(7)
    expect(await store.storedDurationMs('0000000000000000')).toBeUndefined()
    expect(await store.has('../escape')).toBe(false)
  })
})

// (The full HTTP round-trip — PUT/HEAD/GET, the 307 offload, the bearer gate,
// tier scopes, provenance, and a real NativeCacheClient run — is driven
// against the platform server in server.test.ts + blob-store-s3.test.ts.)

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

// (GET /v1/artifacts with the Postgres task_runs provenance join is driven
// against the platform server in server.test.ts; ArtifactStore.list scoping is
// unit-tested directly above.)
