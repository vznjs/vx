// The serve-hosted artifact store: the Turbo /v8/artifacts wire core's
// RemoteCache already speaks, backed by a flat dir under the ingest root.
// Covered at three levels: the raw wire (PUT/HEAD/GET + tag sidecar + auth +
// limits), a real end-to-end run with VX_REMOTE_CACHE_URL pointed at the
// serve (miss → upload, local wipe → remote-hit restore), and the cloud()
// plugin's environment rung (lazy /v1/meta capability probe).

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
import { serveInfoPath } from '../src/serve-info.js'
import { ENVIRONMENTS_VERSION, writeEnvironmentsFile } from '../src/environments.js'
import { cloud } from '../src/plugin.js'

const TIMEOUT = 30_000

// Isolate the per-user serve advertisement at a temp path so test serves
// never clobber (or get discovered through) the real machine-level file.
const prevServeInfo = process.env['VX_CLOUD_SERVE_INFO']
beforeAll(() => {
  process.env['VX_CLOUD_SERVE_INFO'] = path.join(
    tmpdir(),
    `vx-serveinfo-artifacts-${process.pid}.json`,
  )
})
afterAll(async () => {
  await rm(serveInfoPath(), { force: true })
  if (prevServeInfo === undefined) delete process.env['VX_CLOUD_SERVE_INFO']
  else process.env['VX_CLOUD_SERVE_INFO'] = prevServeInfo
})

describe('vx serve /v8/artifacts — the Turbo wire', () => {
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

  it('advertises the artifact store on /v1/meta', async () => {
    const meta = (await (await fetch(`${server.origin}/v1/meta`)).json()) as {
      artifacts: boolean
    }
    expect(meta.artifacts).toBe(true)
  })

  it('PUT → HEAD → GET round-trips bytes + the x-artifact-tag sidecar', async () => {
    const hash = 'a1b2c3d4e5f60718'
    const body = new TextEncoder().encode('artifact-bytes-v1')

    // Miss before the upload.
    expect(
      (await fetch(`${server.origin}/v8/artifacts/${hash}`, { method: 'HEAD', headers: auth }))
        .status,
    ).toBe(404)

    // PUT with a client-side signing tag (?teamId/slug accepted by ignoring).
    const put = await fetch(`${server.origin}/v8/artifacts/${hash}?teamId=team_x&slug=acme`, {
      method: 'PUT',
      headers: { ...auth, 'x-artifact-tag': 'dGVzdC10YWc=', 'x-artifact-duration': '42' },
      body,
    })
    expect(put.status).toBe(200)

    // HEAD sees it now.
    const head = await fetch(`${server.origin}/v8/artifacts/${hash}`, {
      method: 'HEAD',
      headers: auth,
    })
    expect(head.status).toBe(200)

    // GET streams the exact bytes with content-length + the stored tag —
    // signing clients verify the tag against the body on GET.
    const get = await fetch(`${server.origin}/v8/artifacts/${hash}`, { headers: auth })
    expect(get.status).toBe(200)
    expect(get.headers.get('x-artifact-tag')).toBe('dGVzdC10YWc=')
    // The original task duration rides back too, so a remote hit records
    // honest analytics instead of durationMs 0.
    expect(get.headers.get('x-artifact-duration')).toBe('42')
    expect(Number(get.headers.get('content-length'))).toBe(body.byteLength)
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(body)

    // The backing files land in the token's scope (a single --token maps to
    // default/trusted): `<hash>.tar.zst` + sidecars.
    const files = await readdir(path.join(dir, 'artifacts', 'default', 'trusted'))
    expect(files.sort()).toEqual([`${hash}.duration`, `${hash}.tag`, `${hash}.tar.zst`])
  })

  it('omits x-artifact-tag on GET when the PUT carried none', async () => {
    const hash = 'feedfacefeedface'
    await fetch(`${server.origin}/v8/artifacts/${hash}`, {
      method: 'PUT',
      headers: auth,
      body: 'untagged',
    })
    const get = await fetch(`${server.origin}/v8/artifacts/${hash}`, { headers: auth })
    expect(get.status).toBe(200)
    expect(get.headers.get('x-artifact-tag')).toBeNull()
  })

  it('is behind the bearer gate', async () => {
    const res = await fetch(`${server.origin}/v8/artifacts/a1b2c3d4e5f60718`)
    expect(res.status).toBe(401)
    const put = await fetch(`${server.origin}/v8/artifacts/cafebabecafebabe`, {
      method: 'PUT',
      headers: { authorization: 'Bearer wrong' },
      body: 'x',
    })
    expect(put.status).toBe(401)
  })

  it('rejects an oversized PUT with 413 and a hostile hash with 400', async () => {
    // fetch() recomputes Content-Length from the real body, so the declared-
    // length 413 branch is exercised against the handler directly (a
    // hand-built Request keeps the header).
    const { ArtifactStore, MAX_ARTIFACT_BYTES } = await import('../src/artifact-store.js')
    const store = new ArtifactStore(path.join(dir, 'artifacts'))
    const big = await store.handle(
      new Request('http://x/v8/artifacts/deadbeefdeadbeef', {
        method: 'PUT',
        headers: { 'content-length': String(MAX_ARTIFACT_BYTES + 1) },
        body: 'small-but-lying',
      }),
      'deadbeefdeadbeef',
    )
    expect(big.status).toBe(413)

    const evil = await fetch(`${server.origin}/v8/artifacts/${encodeURIComponent('../escape')}`, {
      method: 'PUT',
      headers: auth,
      body: 'x',
    })
    expect(evil.status).toBe(400)
  })

  it('has() is a local stat: present after PUT, false for unknown/hostile hashes', async () => {
    const { ArtifactStore } = await import('../src/artifact-store.js')
    const store = new ArtifactStore(path.join(dir, 'artifacts'))
    const hash = 'beefbeefbeefbeef'
    expect(await store.has(hash)).toBe(false)
    await fetch(`${server.origin}/v8/artifacts/${hash}`, {
      method: 'PUT',
      headers: { ...auth, 'x-artifact-duration': '7' },
      body: 'probe-me',
    })
    expect(await store.has(hash)).toBe(true)
    expect(await store.storedDurationMs(hash)).toBe(7)
    expect(await store.storedDurationMs('0000000000000000')).toBeUndefined()
    expect(await store.has('../escape')).toBe(false)
  })

  it('404s a GET for an unknown hash and 405s other methods', async () => {
    const get = await fetch(`${server.origin}/v8/artifacts/0000000000000000`, { headers: auth })
    expect(get.status).toBe(404)
    const del = await fetch(`${server.origin}/v8/artifacts/0000000000000000`, {
      method: 'DELETE',
      headers: auth,
    })
    expect(del.status).toBe(405)
  })
})

// ---------------------------------------------------------------------------
// End-to-end: a real run with VX_REMOTE_CACHE_* pointed at the serve
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
  const savedEnv: Record<string, string | undefined> = {}
  const KEYS = ['VX_REMOTE_CACHE_URL', 'VX_REMOTE_CACHE_TOKEN', 'VX_REMOTE_CACHE_SIGNATURE_KEY']

  beforeEach(() => {
    for (const k of KEYS) savedEnv[k] = process.env[k]
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it(
    'miss → upload to the serve; local wipe → the remote hit restores (signed)',
    async () => {
      const ingestDir = await mkdtemp(path.join(tmpdir(), 'vx-serve-store-'))
      const server = await startServe({ root: ingestDir, ingestDir, token: 'store-tok' })
      const root = await makeWorkspace()
      process.env['VX_REMOTE_CACHE_URL'] = server.origin
      process.env['VX_REMOTE_CACHE_TOKEN'] = 'store-tok'
      process.env['VX_REMOTE_CACHE_SIGNATURE_KEY'] = 'e2e-signing-key-0123456789abcdef'
      try {
        const first = await run({ cwd: root, tasks: ['build'], log: silentLogger })
        expect(first.ok).toBe(true)
        expect(first.outcomes[0]!.status).toBe('success')

        // The write-through upload landed in the token's scope
        // (default/trusted) — artifact + the signing-tag + duration sidecars.
        const files = (
          await readdir(path.join(ingestDir, 'artifacts', 'default', 'trusted'))
        ).sort()
        expect(files.length).toBe(3)
        expect(files[0]!.endsWith('.duration')).toBe(true)
        expect(files[1]!.endsWith('.tag')).toBe(true)
        expect(files[2]!.endsWith('.tar.zst')).toBe(true)

        // Wipe the local cache: the serve is now the only source of truth.
        await rm(path.join(root, '.vx'), { recursive: true, force: true })

        const second = await run({ cwd: root, tasks: ['build'], log: silentLogger })
        expect(second.ok).toBe(true)
        // A remote hit proves the GET round-trip INCLUDING the returned
        // x-artifact-tag (the signing client verifies it before restoring).
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

/** A mock serve answering /v1/meta + recording /v8 requests. */
function mockServe(artifacts: boolean): {
  server: ReturnType<typeof Bun.serve>
  origin: string
  metaHits: () => number
  v8Requests: { hash: string; auth: string | null }[]
} {
  const v8Requests: { hash: string; auth: string | null }[] = []
  let meta = 0
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/v1/meta') {
        meta++
        return Response.json({ v: 1, name: 'mock', auth: 'token', artifacts })
      }
      const m = url.pathname.match(/^\/v8\/artifacts\/([^/]+)$/)
      if (m) {
        v8Requests.push({ hash: m[1]!, auth: req.headers.get('authorization') })
        return new Response(null, { status: 404 })
      }
      return new Response('nope', { status: 404 })
    },
  })
  return { server, origin: `http://localhost:${server.port}`, metaHits: () => meta, v8Requests }
}

describe('cloud() cache capability — environment rung', () => {
  const savedEnv: Record<string, string | undefined> = {}
  const KEYS = ['VX_REMOTE_CACHE_URL', 'VX_REMOTE_CACHE_TOKEN', 'VX_CLOUD_CONFIG', 'VX_CLOUD_ENV']
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

  it('builds a LayeredCache against the active environment when its serve advertises artifacts', async () => {
    const mock = mockServe(true)
    try {
      connectTo(mock.origin)
      const layer = (await cloud().cache!(cacheCtx(localCache, root))) as LayeredCache
      expect(layer).toBeInstanceOf(LayeredCache)

      // A local miss reads through to the environment's serve, carrying the
      // environment's bearer token.
      const entry = await layer.get('deadbeefdeadbeef', { taskId: 'demo#build', command: 'x' })
      expect(entry).toBeNull()
      expect(mock.v8Requests.length).toBe(1)
      expect(mock.v8Requests[0]!.hash).toBe('deadbeefdeadbeef')
      expect(mock.v8Requests[0]!.auth).toBe('Bearer env-tok')
      expect(mock.metaHits()).toBe(1)
    } finally {
      void mock.server.stop(true)
    }
  })

  it('declines when the environment serve does not advertise artifacts', async () => {
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

  it('never probes /v1/meta when env vars already configure the cache', async () => {
    const mock = mockServe(true)
    const explicit = mockServe(true)
    try {
      connectTo(mock.origin)
      process.env['VX_REMOTE_CACHE_URL'] = explicit.origin
      process.env['VX_REMOTE_CACHE_TOKEN'] = 'explicit-tok'
      const layer = (await cloud().cache!(cacheCtx(localCache, root))) as LayeredCache
      expect(layer).toBeInstanceOf(LayeredCache)

      await layer.get('deadbeefdeadbeef')
      // The explicit config won: its store saw the read; the connected
      // environment was never probed at all.
      expect(explicit.v8Requests.length).toBe(1)
      expect(explicit.v8Requests[0]!.auth).toBe('Bearer explicit-tok')
      expect(mock.metaHits()).toBe(0)
      expect(mock.v8Requests.length).toBe(0)
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
  const trusted = { tier: 'trusted', bucket: 'default' } as const
  const untrusted = { tier: 'untrusted', bucket: 'default' } as const

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'vx-scope-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const put = (store: ArtifactStore, hash: string, body: string, p: Principal) =>
    store.handle(new Request(`http://x/v8/artifacts/${hash}`, { method: 'PUT', body }), hash, p)
  const get = (store: ArtifactStore, hash: string, p: Principal) =>
    store.handle(new Request(`http://x/v8/artifacts/${hash}`), hash, p)

  it('an untrusted write NEVER feeds a trusted read (quarantine)', async () => {
    const store = new ArtifactStore(path.join(dir, 'artifacts'))
    const hash = 'a1b2c3d4e5f60718'
    // A fork PR poisons the key.
    expect((await put(store, hash, 'evil', untrusted)).status).toBe(200)
    // A trusted (main) build for the SAME key must NOT see it — 404.
    expect((await get(store, hash, trusted)).status).toBe(404)
    // It lives only under untrusted/.
    const under = await readdir(path.join(dir, 'artifacts', 'default', 'untrusted'))
    expect(under).toContain(`${hash}.tar.zst`)
  })

  it('an untrusted read falls through to the trusted baseline (warm PR)', async () => {
    const store = new ArtifactStore(path.join(dir, 'artifacts'))
    const hash = 'cafebabecafebabe'
    expect((await put(store, hash, 'legit', trusted)).status).toBe(200)
    // The PR warms off main's cache.
    const got = await get(store, hash, untrusted)
    expect(got.status).toBe(200)
    expect(await got.text()).toBe('legit')
  })

  it('an untrusted write cannot overwrite a trusted artifact', async () => {
    const store = new ArtifactStore(path.join(dir, 'artifacts'))
    const hash = 'feedfacefeedface'
    expect((await put(store, hash, 'legit', trusted)).status).toBe(200)
    // The untrusted PUT lands in untrusted/, leaving trusted/ untouched.
    expect((await put(store, hash, 'evil', untrusted)).status).toBe(200)
    const trustedGet = await get(store, hash, trusted)
    expect(await trustedGet.text()).toBe('legit')
  })

  it('artifacts are immutable — a re-PUT of an existing hash is refused (409)', async () => {
    const store = new ArtifactStore(path.join(dir, 'artifacts'))
    const hash = '0011223344556677'
    expect((await put(store, hash, 'first', trusted)).status).toBe(200)
    expect((await put(store, hash, 'overwrite', trusted)).status).toBe(409)
    const got = await get(store, hash, trusted)
    expect(await got.text()).toBe('first')
  })

  it('migrates a legacy flat store into default/trusted/', async () => {
    const artDir = path.join(dir, 'artifacts')
    await mkdir(artDir, { recursive: true })
    await writeFile(path.join(artDir, 'deadbeefdeadbeef.tar.zst'), 'legacy')
    await writeFile(path.join(artDir, 'deadbeefdeadbeef.tag'), 'sig')
    const store = new ArtifactStore(artDir)
    await store.migrateLegacyFlatStore()
    const got = await get(store, 'deadbeefdeadbeef', trusted)
    expect(got.status).toBe(200)
    expect(await got.text()).toBe('legacy')
    const moved = await readdir(path.join(artDir, 'default', 'trusted'))
    expect(moved.sort()).toEqual(['deadbeefdeadbeef.tag', 'deadbeefdeadbeef.tar.zst'])
  })
})
