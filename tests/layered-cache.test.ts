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

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'vx-layered-'))
    projectDir = path.join(workspaceRoot, 'project')
    cacheDir = path.join(workspaceRoot, '.vx', 'cache')
    await mkdir(projectDir, { recursive: true })
    local = new Cache(cacheDir)

    serverRequests = []
    serverStore = new Map()
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
          return new Response(stored, { status: 200, headers: { 'x-artifact-duration': '42' } })
        }
        if (req.method === 'PUT') {
          serverStore.set(hash, body)
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

  function makeLayered(): LayeredCache {
    const remote = new RemoteCache({
      baseUrl: `http://localhost:${server.port}`,
      token: 'tok',
    })
    return new LayeredCache(local, remote, {
      onRemoteError: () => {
        /* suppress; tests assert via serverRequests when relevant */
      },
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
