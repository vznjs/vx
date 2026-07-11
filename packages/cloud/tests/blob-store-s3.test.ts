// The ArtifactStore on the S3 blob backend (docs/design/s3-blob-backend-2026-07.md):
// the controller stores NO artifact bytes at rest — PUT proxies through the
// store's gates (cap, zstd magic, immutability, trust scopes) then uploads to
// the bucket; GET answers 307 to a pre-signed bucket URL. Driven against the
// fake S3 server (tests/helpers/fake-s3.ts), plus resolveS3Config boot units
// and a real end-to-end run through a serve configured with VX_CLOUD_S3_*.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { run, type Logger } from '@vzn/vx'
import { ArtifactStore, type Principal } from '../src/artifact-store.js'
import { S3Backend } from '../src/blob/s3.js'
import { NativeCacheClient } from '../src/native-cache.js'
import { resolveS3Config, startServe } from '../src/cli/serve.js'
import { startFakeS3, type FakeS3 } from './helpers/fake-s3.js'

const TIMEOUT = 30_000

const zbody = (tag: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(Bun.zstdCompressSync(Buffer.from(tag)))
const digestOf = (bytes: Uint8Array): string =>
  `xxh3:${Bun.hash.xxHash3(bytes).toString(16).padStart(16, '0')}`

const trusted: Principal = { tier: 'trusted', bucket: 'default' }
const untrusted: Principal = { tier: 'untrusted', bucket: 'default' }

describe('ArtifactStore on the S3 backend', () => {
  let fake: FakeS3
  let store: ArtifactStore

  const backend = (extra?: { prefix?: string }): S3Backend =>
    new S3Backend({
      endpoint: fake.origin,
      bucket: fake.bucket,
      region: 'us-east-1',
      accessKeyId: 'test-key',
      secretAccessKey: 'test-secret',
      ...extra,
    })

  beforeEach(() => {
    fake = startFakeS3()
    store = new ArtifactStore(backend())
  })
  afterEach(() => {
    fake.stop()
  })

  const put = (
    s: ArtifactStore,
    hash: string,
    tag: string,
    p: Principal,
    headers?: Record<string, string>,
  ) =>
    s.handle(
      new Request(`http://x/v1/cache/${hash}`, {
        method: 'PUT',
        body: zbody(tag),
        ...(headers !== undefined ? { headers } : {}),
      }),
      hash,
      p,
    )
  const get = (s: ArtifactStore, hash: string, p: Principal, scope?: string) =>
    s.handle(
      new Request(
        `http://x/v1/cache/${hash}`,
        scope !== undefined ? { headers: { 'x-vx-cache-scope': scope } } : {},
      ),
      hash,
      p,
    )
  const head = (s: ArtifactStore, hash: string, p: Principal) =>
    s.handle(new Request(`http://x/v1/cache/${hash}`, { method: 'HEAD' }), hash, p)

  it('PUT uploads to the bucket under the write scope, with the vx metadata', async () => {
    const hash = 'a1b2c3d4e5f60718'
    const body = zbody('s3-artifact')
    const res = await put(store, hash, 's3-artifact', trusted, {
      'x-vx-digest': digestOf(body),
      'x-vx-duration-ms': '42',
    })
    expect(res.status).toBe(200)
    const obj = fake.objects.get(`default/trusted/${hash}.tar.zst`)
    expect(obj).toBeDefined()
    expect(new Uint8Array(obj!.body)).toEqual(body)
    expect(obj!.meta['x-amz-meta-vx-digest']).toBe(digestOf(body))
    expect(obj!.meta['x-amz-meta-vx-duration-ms']).toBe('42')
  })

  it('GET answers 307 to a pre-signed bucket URL — the bytes come from the bucket', async () => {
    const hash = 'b2c3d4e5f6071829'
    const body = zbody('offloaded-bytes')
    await put(store, hash, 'offloaded-bytes', trusted, { 'x-vx-digest': digestOf(body) })

    const res = await get(store, hash, trusted)
    expect(res.status).toBe(307)
    const loc = res.headers.get('location')!
    expect(loc.startsWith(`${fake.origin}/vx-test/default/trusted/${hash}.tar.zst?`)).toBe(true)
    expect(loc).toContain('X-Amz-Signature=')
    expect(loc).toContain('X-Amz-Expires=300')

    // Follow the hop like the client does: the bucket serves the bytes with
    // the vx metadata as S3 user metadata (the client's fallback headers).
    const blob = await fetch(loc)
    expect(blob.status).toBe(200)
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(body)
    expect(blob.headers.get('x-amz-meta-vx-digest')).toBe(digestOf(body))
    expect(fake.violations).toEqual([])
  })

  it('HEAD probes the bucket: 200 after PUT, 404 before', async () => {
    const hash = 'c3d4e5f607182930'
    expect((await head(store, hash, trusted)).status).toBe(404)
    await put(store, hash, 'probe-me', trusted)
    expect((await head(store, hash, trusted)).status).toBe(200)
  })

  it('immutability holds via a bucket HEAD — a re-PUT is 409 and the bytes survive', async () => {
    const hash = 'd4e5f60718293041'
    expect((await put(store, hash, 'first', trusted)).status).toBe(200)
    expect((await put(store, hash, 'overwrite', trusted)).status).toBe(409)
    expect(new Uint8Array(fake.objects.get(`default/trusted/${hash}.tar.zst`)!.body)).toEqual(
      zbody('first'),
    )
  })

  it('a junk PUT is 400 and stores NOTHING in the bucket', async () => {
    const hash = 'e5f6071829304152'
    const res = await store.handle(
      new Request(`http://x/v1/cache/${hash}`, {
        method: 'PUT',
        body: '<html>proxy error page</html>',
      }),
      hash,
      trusted,
    )
    expect(res.status).toBe(400)
    expect(fake.objects.size).toBe(0)
    // The key is not locked: the real bytes still land afterwards.
    expect((await put(store, hash, 'real', trusted)).status).toBe(200)
  })

  it('caps a chunked PUT on ACTUAL streamed bytes — 413, nothing uploaded', async () => {
    const capped = new ArtifactStore(backend(), 1024)
    const chunk = new Uint8Array(300).fill(65)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 5; i++) controller.enqueue(chunk) // 1500 bytes > 1024 cap
        controller.close()
      },
    })
    const res = await capped.handle(
      new Request('http://x/v1/cache/beefbeefbeef0001', { method: 'PUT', body: stream }),
      'beefbeefbeef0001',
      trusted,
    )
    expect(res.status).toBe(413)
    expect(fake.objects.size).toBe(0)
  })

  it('trust scopes hold on the bucket: untrusted never feeds trusted, PRs stay isolated', async () => {
    const hash = 'f6071829304152a3'
    // A fork PR writes under its own untrusted sub-scope.
    const prPut = await store.handle(
      new Request(`http://x/v1/cache/${hash}`, {
        method: 'PUT',
        body: zbody('evil'),
        headers: { 'x-vx-cache-scope': 'pr-1' },
      }),
      hash,
      untrusted,
    )
    expect(prPut.status).toBe(200)
    expect(fake.objects.has(`default/untrusted/pr-1/${hash}.tar.zst`)).toBe(true)
    // A trusted build for the SAME key never sees it.
    expect((await get(store, hash, trusted)).status).toBe(404)
    // Another PR never sees it either.
    expect((await get(store, hash, untrusted, 'pr-2')).status).toBe(404)
    // The owning PR resolves its own copy (307 bound to ITS scope key).
    const own = await get(store, hash, untrusted, 'pr-1')
    expect(own.status).toBe(307)
    expect(own.headers.get('location')).toContain(`/default/untrusted/pr-1/${hash}.tar.zst`)
  })

  it('an untrusted read falls through to the trusted baseline (warm PR)', async () => {
    const hash = '0718293041526374'
    await put(store, hash, 'baseline', trusted)
    const res = await get(store, hash, untrusted, 'pr-9')
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toContain(`/default/trusted/${hash}.tar.zst`)
  })

  it('list() walks exactly the read scopes, following continuation pages', async () => {
    fake.stop()
    fake = startFakeS3({ listPageSize: 2 }) // 3 trusted objects → 2 pages
    store = new ArtifactStore(backend())
    await put(store, 'aaaaaaaaaaaaaaa1', 'one', trusted)
    await put(store, 'aaaaaaaaaaaaaaa2', 'two', trusted)
    await put(store, 'aaaaaaaaaaaaaaa3', 'three', trusted)
    const prPut = await store.handle(
      new Request('http://x/v1/cache/bbbbbbbbbbbbbbb1', {
        method: 'PUT',
        body: zbody('pr-only'),
        headers: { 'x-vx-cache-scope': 'pr-1' },
      }),
      'bbbbbbbbbbbbbbb1',
      untrusted,
    )
    expect(prPut.status).toBe(200)

    // Trusted lists ONLY trusted — across both continuation pages.
    const trustedRows = await store.list(trusted)
    expect(trustedRows.map((r) => r.hash).sort()).toEqual([
      'aaaaaaaaaaaaaaa1',
      'aaaaaaaaaaaaaaa2',
      'aaaaaaaaaaaaaaa3',
    ])
    expect(trustedRows.every((r) => r.tier === 'trusted')).toBe(true)
    expect(trustedRows[0]!.sizeBytes).toBeGreaterThan(0)

    // The PR lists its own sub-scope ∪ trusted; another PR only trusted.
    const pr1 = await store.list(untrusted, 'pr-1')
    expect(pr1.map((r) => r.hash).sort()).toEqual([
      'aaaaaaaaaaaaaaa1',
      'aaaaaaaaaaaaaaa2',
      'aaaaaaaaaaaaaaa3',
      'bbbbbbbbbbbbbbb1',
    ])
    const pr2 = await store.list(untrusted, 'pr-2')
    expect(pr2.map((r) => r.hash).includes('bbbbbbbbbbbbbbb1')).toBe(false)
  })

  it('a configured key prefix namespaces every object', async () => {
    store = new ArtifactStore(backend({ prefix: 'vx-cache/' }))
    const hash = '1829304152637485'
    await put(store, hash, 'prefixed', trusted)
    expect(fake.objects.has(`vx-cache/default/trusted/${hash}.tar.zst`)).toBe(true)
    const res = await get(store, hash, trusted)
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toContain(`/vx-test/vx-cache/default/trusted/`)
    expect((await store.list(trusted)).map((r) => r.hash)).toEqual([hash])
  })

  it('storedDurationMs reads the object user metadata', async () => {
    const hash = '2930415263748596'
    await put(store, hash, 'timed', trusted, { 'x-vx-duration-ms': '1234' })
    expect(await store.storedDurationMs(hash, trusted)).toBe(1234)
    expect(await store.storedDurationMs('0000000000000000', trusted)).toBeUndefined()
  })

  it('a down bucket is a LOUD 502 on GET/HEAD/PUT — never a silent 404', async () => {
    const dead = new ArtifactStore(
      new S3Backend({
        endpoint: 'http://127.0.0.1:1',
        bucket: 'x',
        region: 'auto',
        accessKeyId: 'k',
        secretAccessKey: 's',
        timeoutMs: 2000,
      }),
    )
    const hash = 'abcdefabcdef0123'
    expect((await get(dead, hash, trusted)).status).toBe(502)
    expect((await head(dead, hash, trusted)).status).toBe(502)
    // PUT fails on the immutability probe BEFORE reading the body.
    expect((await put(dead, hash, 'x', trusted)).status).toBe(502)
    // The internal best-effort probes degrade instead of crashing a caller.
    expect(await dead.has(hash)).toBe(false)
    expect(await dead.storedDurationMs(hash)).toBeUndefined()
    expect(await dead.list(trusted)).toEqual([])
  })
})

describe('resolveS3Config', () => {
  const FULL = {
    VX_CLOUD_S3_ENDPOINT: 'https://s3.example.com',
    VX_CLOUD_S3_BUCKET: 'artifacts',
    VX_CLOUD_S3_ACCESS_KEY_ID: 'key',
    VX_CLOUD_S3_SECRET_ACCESS_KEY: 'secret',
  }

  it('is disabled without an endpoint (empty counts as unset)', () => {
    expect(resolveS3Config({})).toBeNull()
    expect(resolveS3Config({ VX_CLOUD_S3_ENDPOINT: '' })).toBeNull()
    expect(resolveS3Config({ VX_CLOUD_S3_BUCKET: 'artifacts' })).toBeNull()
  })

  it('partial config is a hard error naming every missing var — never a local fallback', () => {
    expect(() => resolveS3Config({ VX_CLOUD_S3_ENDPOINT: 'https://s3.example.com' })).toThrow(
      /VX_CLOUD_S3_BUCKET, VX_CLOUD_S3_ACCESS_KEY_ID, VX_CLOUD_S3_SECRET_ACCESS_KEY are missing/,
    )
    expect(() => resolveS3Config({ ...FULL, VX_CLOUD_S3_SECRET_ACCESS_KEY: '' })).toThrow(
      /VX_CLOUD_S3_SECRET_ACCESS_KEY is missing/,
    )
  })

  it('applies the defaults and parses the overrides', () => {
    expect(resolveS3Config(FULL)).toEqual({
      endpoint: 'https://s3.example.com',
      bucket: 'artifacts',
      region: 'auto',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      prefix: '',
      presignTtlSeconds: 300,
    })
    expect(
      resolveS3Config({
        ...FULL,
        VX_CLOUD_S3_REGION: 'us-east-1',
        VX_CLOUD_S3_PREFIX: 'vx-cache/',
        VX_CLOUD_S3_PRESIGN_TTL: '600',
      }),
    ).toMatchObject({ region: 'us-east-1', prefix: 'vx-cache/', presignTtlSeconds: 600 })
  })

  it('rejects a malformed TTL', () => {
    expect(() => resolveS3Config({ ...FULL, VX_CLOUD_S3_PRESIGN_TTL: 'soon' })).toThrow(
      /VX_CLOUD_S3_PRESIGN_TTL/,
    )
    expect(() => resolveS3Config({ ...FULL, VX_CLOUD_S3_PRESIGN_TTL: '0' })).toThrow(
      /VX_CLOUD_S3_PRESIGN_TTL/,
    )
  })
})

// ---------------------------------------------------------------------------
// End-to-end: a real run against a serve whose artifact bytes live in S3
// ---------------------------------------------------------------------------

const silentLogger: Logger = {
  status() {},
  taskStdout() {},
  taskStderr() {},
  taskComplete() {},
}

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'vx-s3-e2e-'))
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

describe('e2e: vx run against an S3-offloaded serve', () => {
  const S3_KEYS = [
    'VX_CLOUD_S3_ENDPOINT',
    'VX_CLOUD_S3_BUCKET',
    'VX_CLOUD_S3_REGION',
    'VX_CLOUD_S3_ACCESS_KEY_ID',
    'VX_CLOUD_S3_SECRET_ACCESS_KEY',
    'VX_CLOUD_S3_PREFIX',
    'VX_CLOUD_S3_PRESIGN_TTL',
  ]
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const k of S3_KEYS) {
      savedEnv[k] = process.env[k]
      delete process.env[k]
    }
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it('startServe hard-errors on partial S3 config instead of falling back to local', async () => {
    process.env['VX_CLOUD_S3_ENDPOINT'] = 'https://s3.example.com'
    const dir = await mkdtemp(path.join(tmpdir(), 'vx-s3-partial-'))
    try {
      await expect(startServe({ root: dir, ingestDir: dir })).rejects.toThrow(/VX_CLOUD_S3_BUCKET/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it(
    'miss uploads to the bucket (controller byte-free) → 307 remote hit → tamper degrades to a miss',
    async () => {
      const fake = startFakeS3({ bucket: 'vx-e2e' })
      const ingestDir = await mkdtemp(path.join(tmpdir(), 'vx-s3-serve-'))
      process.env['VX_CLOUD_S3_ENDPOINT'] = fake.origin
      process.env['VX_CLOUD_S3_BUCKET'] = 'vx-e2e'
      process.env['VX_CLOUD_S3_ACCESS_KEY_ID'] = 'test-key'
      process.env['VX_CLOUD_S3_SECRET_ACCESS_KEY'] = 'test-secret'
      const server = await startServe({ root: ingestDir, ingestDir, token: 'store-tok' })
      const root = await makeWorkspace()
      const remoteCache = new NativeCacheClient({ baseUrl: server.origin, token: 'store-tok' })
      const outFile = path.join(root, 'packages', 'app', 'out.txt')
      try {
        const first = await run({ cwd: root, tasks: ['build'], log: silentLogger, remoteCache })
        expect(first.ok).toBe(true)
        expect(first.outcomes[0]!.status).toBe('success')

        // THE DIRECTIVE: the controller holds no artifact bytes at rest —
        // the upload streamed through the serve into the bucket, and the
        // spool was unlinked.
        const controllerFiles = (
          await readdir(path.join(ingestDir, 'artifacts'), { recursive: true }).catch(
            () => [] as string[],
          )
        ).map(String)
        expect(controllerFiles.filter((f) => f.includes('.tar.zst'))).toEqual([])
        const bucketKeys = [...fake.objects.keys()]
        expect(bucketKeys).toHaveLength(1)
        expect(bucketKeys[0]!.startsWith('default/trusted/')).toBe(true)
        expect(bucketKeys[0]!.endsWith('.tar.zst')).toBe(true)
        // The wire metadata rides as S3 user metadata.
        const stored = fake.objects.get(bucketKeys[0]!)!
        expect(stored.meta['x-amz-meta-vx-digest']).toMatch(/^xxh3:[0-9a-f]{16}$/)
        expect(stored.meta['x-amz-meta-vx-duration-ms']).toMatch(/^\d+$/)

        // Local wipe → the remote hit rides the 307 to the bucket, verifies
        // the digest from the x-amz-meta fallback, and restores the output.
        await rm(path.join(root, '.vx'), { recursive: true, force: true })
        const second = await run({ cwd: root, tasks: ['build'], log: silentLogger, remoteCache })
        expect(second.ok).toBe(true)
        expect(second.outcomes[0]!.status).toBe('cache-hit-remote')
        expect(await Bun.file(outFile).text()).toContain('built')
        // The presigned bucket GET arrived credential-free (bearer + scope
        // header dropped on the cross-origin hop).
        expect(fake.violations).toEqual([])

        // Tamper the bucket object: the digest mismatch degrades the hit to
        // a miss and the task re-executes instead of restoring corrupt bytes.
        fake.objects.set(bucketKeys[0]!, {
          ...stored,
          body: new Uint8Array(Bun.zstdCompressSync(Buffer.from('tampered'))),
        })
        await rm(path.join(root, '.vx'), { recursive: true, force: true })
        await rm(outFile, { force: true })
        const third = await run({ cwd: root, tasks: ['build'], log: silentLogger, remoteCache })
        expect(third.ok).toBe(true)
        expect(third.outcomes[0]!.status).toBe('success')
        expect(await Bun.file(outFile).text()).toContain('built')
      } finally {
        await server.stop()
        fake.stop()
        await rm(root, { recursive: true, force: true })
        await rm(ingestDir, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})
