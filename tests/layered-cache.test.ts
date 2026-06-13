import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Cache } from '../src/cache/cache.js'
import { LayeredCache } from '../src/cache/layered-cache.js'
import { RemoteCache } from '../src/cache/remote-cache.js'

describe('LayeredCache', () => {
  let workspaceRoot: string
  let projectDir: string
  let cacheDir: string
  let local: Cache
  let server: ReturnType<typeof Bun.serve>
  let serverRequests: Array<{ method: string; path: string; body: ArrayBuffer }>
  let serverStore: Map<string, ArrayBuffer>
  let serverTags: Map<string, string>

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'vx-layered-'))
    projectDir = path.join(workspaceRoot, 'project')
    cacheDir = path.join(workspaceRoot, '.vx', 'cache')
    await mkdir(projectDir, { recursive: true })
    local = new Cache(cacheDir)

    serverRequests = []
    serverStore = new Map()
    serverTags = new Map()
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        const body = await req.arrayBuffer()
        const match = url.pathname.match(/^\/v8\/artifacts\/(.+)$/)
        serverRequests.push({ method: req.method, path: url.pathname, body })
        if (!match) return new Response(null, { status: 404 })
        const hash = decodeURIComponent(match[1]!)
        if (req.method === 'HEAD') {
          return serverStore.has(hash)
            ? new Response(null, { status: 200 })
            : new Response(null, { status: 404 })
        }
        if (req.method === 'GET') {
          const stored = serverStore.get(hash)
          if (!stored) return new Response(null, { status: 404 })
          const headers: Record<string, string> = { 'x-artifact-duration': '42' }
          const tag = serverTags.get(hash)
          if (tag) headers['x-artifact-tag'] = tag
          return new Response(stored, { status: 200, headers })
        }
        if (req.method === 'PUT') {
          serverStore.set(hash, body)
          const tag = req.headers.get('x-artifact-tag')
          if (tag) serverTags.set(hash, tag)
          return new Response(null, { status: 201 })
        }
        return new Response(null, { status: 405 })
      },
    })
  })

  afterEach(async () => {
    local.close()
    await server.stop(true)
    await rm(workspaceRoot, { recursive: true, force: true })
  })

  function makeLayered(opts?: {
    signatureKey?: string
    onRemoteError?: (e: Error) => void
  }): LayeredCache {
    const remote = new RemoteCache({
      baseUrl: `http://localhost:${server.port}`,
      token: 'tok',
      ...(opts?.signatureKey !== undefined ? { signatureKey: opts.signatureKey } : {}),
    })
    return new LayeredCache(local, remote, {
      onRemoteError:
        opts?.onRemoteError ??
        (() => {
          /* suppress; tests assert via serverRequests when relevant */
        }),
    })
  }

  async function saveSample(cache: Cache | LayeredCache, hash: string): Promise<void> {
    const outFile = path.join(projectDir, 'dist', 'out.txt')
    await mkdir(path.dirname(outFile), { recursive: true })
    await writeFile(outFile, `produced-${hash}`)
    await cache.save({
      hash,
      projectDir,
      outputFiles: [outFile],
      entry: {
        taskId: 'pkg#build',
        command: 'echo produced',
        exitCode: 0,
        durationMs: 5,
        stdout: 'compiling…',
      },
    })
  }

  it('save() writes local AND uploads to remote', async () => {
    const layered = makeLayered()
    await saveSample(layered, 'h-save')

    // Local entry present.
    const got = await local.get('h-save')
    expect(got).not.toBeNull()

    // Remote received a PUT for the same hash.
    const puts = serverRequests.filter((r) => r.method === 'PUT' && r.path.endsWith('h-save'))
    expect(puts).toHaveLength(1)
    expect(puts[0]!.body.byteLength).toBeGreaterThan(0)
  })

  it('save() does not fail when the remote rejects', async () => {
    await server.stop(true)
    server = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 500 }) })
    const layered = makeLayered()
    // Should resolve normally — remote error is logged, not thrown.
    await expect(saveSample(layered, 'h-rem-err')).resolves.toBeUndefined()
    expect(await local.get('h-rem-err')).not.toBeNull()
  })

  it('get() returns local entry without touching remote when local has it', async () => {
    await saveSample(local, 'h-local')
    serverRequests.length = 0

    const layered = makeLayered()
    const hit = await layered.get('h-local')
    expect(hit).not.toBeNull()
    expect(hit?.source).toBe('local')
    expect(serverRequests).toHaveLength(0)
  })

  it('get() falls back to remote and materializes into local', async () => {
    // Seed the remote: do a save through a separate LayeredCache so the
    // server has a real packed entry for the hash, then wipe local.
    const seeder = makeLayered()
    await saveSample(seeder, 'h-remote-only')
    expect(serverStore.has('h-remote-only')).toBe(true)

    // Now make a fresh local cache and a fresh LayeredCache on top.
    local.close()
    await rm(cacheDir, { recursive: true, force: true })
    local = new Cache(cacheDir)
    const layered = new LayeredCache(
      local,
      new RemoteCache({
        baseUrl: `http://localhost:${server.port}`,
        token: 'tok',
      }),
    )

    // Local is empty.
    expect(await local.get('h-remote-only')).toBeNull()

    // get() pulls from remote, materializes locally. Caller passes
    // taskId/command via ctx so the materialized SQL row carries
    // queryable metadata (the artifact bytes don't).
    const hit = await layered.get('h-remote-only', {
      taskId: 'pkg#build',
      command: 'echo produced',
    })
    expect(hit).not.toBeNull()
    expect(hit?.source).toBe('remote')
    expect(hit?.command).toBe('echo produced')
    expect(hit?.exitCode).toBe(0)
    expect(hit?.stdout).toBe('compiling…')
    expect(hit?.outputFiles).toEqual(['dist/out.txt'])

    // Local is now populated for next time, and a follow-up lookup
    // reports source='local' (the remote pull only fires once).
    const next = await local.get('h-remote-only')
    expect(next).not.toBeNull()
    expect(next?.source).toBe('local')
  })

  it('get() degrades a corrupt remote artifact to a miss instead of throwing', async () => {
    // The server "has" the hash, but the body is not a zstd artifact —
    // a truncated/garbage upload from another writer. The layered cache
    // must report it via onRemoteError and return null so the run falls
    // back to executing the task.
    serverStore.set('h-corrupt', new TextEncoder().encode('definitely not zstd').buffer)
    const errors: Error[] = []
    const layered = new LayeredCache(
      local,
      new RemoteCache({ baseUrl: `http://localhost:${server.port}`, token: 'tok' }),
      { onRemoteError: (e) => errors.push(e) },
    )

    const hit = await layered.get('h-corrupt', { taskId: 'pkg#build', command: 'tsc' })
    expect(hit).toBeNull()
    expect(errors).toHaveLength(1)

    // Nothing half-ingested locally, and a later save of the same hash
    // (the task re-executed) still works.
    expect(await local.get('h-corrupt')).toBeNull()
    await saveSample(layered, 'h-corrupt')
    expect(await local.get('h-corrupt')).not.toBeNull()
  })

  it('get() returns null when both local and remote miss', async () => {
    const layered = makeLayered()
    expect(await layered.get('h-nowhere')).toBeNull()
  })

  it('get() suppresses remote errors and returns null', async () => {
    await server.stop(true)
    server = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 500 }) })
    const layered = makeLayered()
    expect(await layered.get('h-fail')).toBeNull()
  })

  it('key() is identical to local.key()', async () => {
    const layered = makeLayered()
    const input = {
      taskId: 'pkg#build',
      taskConfigHash: 'cfg',
      projectPackageJsonHash: 'pkg',
      envValues: [] as Array<[string, string]>,
      inputFiles: [],
      workspaceRoot,
      upstreamHashes: [],
      workspaceFingerprint: 'ws',
    }
    expect(await layered.key(input)).toBe(await local.key(input))
  })

  it('signing round-trip: save() uploads a tagged artifact a verifying reader accepts', async () => {
    const key = 'vx-layered-signing-key-0123456789abcdef'
    const seeder = makeLayered({ signatureKey: key })
    await saveSample(seeder, 'h-signed')
    expect(serverTags.get('h-signed')).toBeDefined()

    // Fresh local cache → the only source is the (tagged) remote entry.
    local.close()
    await rm(cacheDir, { recursive: true, force: true })
    local = new Cache(cacheDir)

    const reader = makeLayered({ signatureKey: key })
    const hit = await reader.get('h-signed', { taskId: 'pkg#build', command: 'echo produced' })
    expect(hit).not.toBeNull()
    expect(hit?.source).toBe('remote')
  })

  it('signing: tampered remote bytes degrade to a miss and fire onRemoteError', async () => {
    const key = 'vx-layered-signing-key-0123456789abcdef'
    const seeder = makeLayered({ signatureKey: key })
    await saveSample(seeder, 'h-tampered')

    // Flip one byte of the stored artifact (the view aliases the map's
    // ArrayBuffer); the tag still covers the original bytes, so
    // verification must fail on the next read.
    const stored = new Uint8Array(serverStore.get('h-tampered')!)
    stored[stored.length - 1] = stored[stored.length - 1]! ^ 0xff

    local.close()
    await rm(cacheDir, { recursive: true, force: true })
    local = new Cache(cacheDir)

    const errors: Error[] = []
    const reader = makeLayered({ signatureKey: key, onRemoteError: (e) => errors.push(e) })
    const hit = await reader.get('h-tampered', { taskId: 'pkg#build', command: 'echo produced' })
    expect(hit).toBeNull()
    expect(errors).toHaveLength(1)
    expect(errors[0]!.message).toMatch(/signature mismatch/)
    // Nothing half-ingested locally — the run re-executes the task.
    expect(await local.get('h-tampered')).toBeNull()
  })

  it('prefetch() pulls a remote-only artifact into local, and a later get() is a remote-source hit', async () => {
    const seeder = makeLayered()
    await saveSample(seeder, 'h-pf')

    local.close()
    await rm(cacheDir, { recursive: true, force: true })
    local = new Cache(cacheDir)
    const layered = makeLayered()

    const pulled = await layered.prefetch('h-pf', { taskId: 'pkg#build', command: 'echo produced' })
    expect(pulled).toBe(true)
    // The artifact is now materialized locally.
    expect(await local.get('h-pf')).not.toBeNull()

    // get() after a prefetch still reports source='remote' (this lookup
    // was served by the remote layer) and fires NO new remote GET.
    serverRequests.length = 0
    const hit = await layered.get('h-pf', { taskId: 'pkg#build', command: 'echo produced' })
    expect(hit?.source).toBe('remote')
    expect(serverRequests.filter((r) => r.method === 'GET')).toHaveLength(0)
  })

  it('prefetch() returns false on a remote miss (degrades, never throws)', async () => {
    const layered = makeLayered()
    expect(await layered.prefetch('h-absent', { taskId: 'pkg#x', command: 'c' })).toBe(false)
  })

  it('prefetch() + get() issue AT MOST ONE remote GET per hash', async () => {
    const seeder = makeLayered()
    await saveSample(seeder, 'h-once')

    local.close()
    await rm(cacheDir, { recursive: true, force: true })
    local = new Cache(cacheDir)

    // Inject latency so prefetch is still in flight when get() arrives —
    // this is the race the inflight map must collapse to one GET. The
    // guard FAILS at 2 if the de-dup is removed.
    await server.stop(true)
    let getCount = 0
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        const hash = decodeURIComponent(url.pathname.split('/').pop()!)
        if (req.method === 'GET') {
          getCount++
          await Bun.sleep(60)
          const stored = serverStore.get(hash)
          if (!stored) return new Response(null, { status: 404 })
          return new Response(stored, { status: 200, headers: { 'x-artifact-duration': '7' } })
        }
        return new Response(null, { status: 405 })
      },
    })
    const remote = new RemoteCache({ baseUrl: `http://localhost:${server.port}`, token: 'tok' })
    const layered = new LayeredCache(local, remote, { onRemoteError: () => {} })

    // Kick off prefetch (in flight), then immediately get() the same hash.
    const pf = layered.prefetch('h-once', { taskId: 'pkg#build', command: 'echo produced' })
    const hit = await layered.get('h-once', { taskId: 'pkg#build', command: 'echo produced' })
    await pf
    expect(hit?.source).toBe('remote')
    expect(getCount).toBe(1)
  })

  it('prefetch-miss does not trigger a SECOND remote GET on the following get()', async () => {
    local.close()
    await rm(cacheDir, { recursive: true, force: true })
    local = new Cache(cacheDir)

    let getCount = 0
    await server.stop(true)
    server = Bun.serve({
      port: 0,
      fetch(req) {
        if (req.method === 'GET') getCount++
        return new Response(null, { status: 404 })
      },
    })
    const remote = new RemoteCache({ baseUrl: `http://localhost:${server.port}`, token: 'tok' })
    const layered = new LayeredCache(local, remote, { onRemoteError: () => {} })

    expect(await layered.prefetch('h-pm', { taskId: 'pkg#x', command: 'c' })).toBe(false)
    const hit = await layered.get('h-pm', { taskId: 'pkg#x', command: 'c' })
    expect(hit).toBeNull()
    // The prefetch already probed remote and found nothing; get() must
    // reuse that result, not probe again.
    expect(getCount).toBe(1)
  })

  it('prefetch() is idempotent — two concurrent prefetches share one remote GET', async () => {
    const seeder = makeLayered()
    await saveSample(seeder, 'h-dup')

    local.close()
    await rm(cacheDir, { recursive: true, force: true })
    local = new Cache(cacheDir)

    await server.stop(true)
    let getCount = 0
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        const hash = decodeURIComponent(url.pathname.split('/').pop()!)
        if (req.method === 'GET') {
          getCount++
          await Bun.sleep(40)
          const stored = serverStore.get(hash)
          if (!stored) return new Response(null, { status: 404 })
          return new Response(stored, { status: 200, headers: { 'x-artifact-duration': '7' } })
        }
        return new Response(null, { status: 405 })
      },
    })
    const remote = new RemoteCache({ baseUrl: `http://localhost:${server.port}`, token: 'tok' })
    const layered = new LayeredCache(local, remote, { onRemoteError: () => {} })

    const [a, b] = await Promise.all([
      layered.prefetch('h-dup', { taskId: 'pkg#build', command: 'echo produced' }),
      layered.prefetch('h-dup', { taskId: 'pkg#build', command: 'echo produced' }),
    ])
    expect(a).toBe(true)
    expect(b).toBe(true)
    expect(getCount).toBe(1)
  })

  it('stats() / recordRun() / prune() delegate to local', async () => {
    const layered = makeLayered()
    layered.recordRun({
      hash: 'h-rec',
      project: 'pkg',
      task: 'build',
      status: 'success',
      exitCode: 0,
      durationMs: 1,
      startedAt: Date.now(),
      endedAt: Date.now(),
    })
    const stats = layered.stats()
    expect(stats.runCountLast24h).toBe(1)

    await expect(layered.prune({})).rejects.toThrow(/at least one of/)
  })
})
