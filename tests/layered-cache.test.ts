// LayeredCache over the RemoteCacheLayer seam — a plain in-memory stub
// layer (core ships no wire client; the wire is a plugin concern, see
// native-cache-wire-2026-07). The stub throws like a real client would;
// LayeredCache owns dedup, provenance, and never-fail degradation.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Cache } from '../src/cache/cache.js'
import { LayeredCache, type RemoteCacheLayer } from '../src/cache/layered-cache.js'

interface StubRemote {
  layer: RemoteCacheLayer
  store: Map<string, Uint8Array>
  gets: number
  puts: number
  heads: number
  hasManyCalls: number
  /** Per-call latency for get() — lets a test hold pulls open. */
  getLatencyMs: number
  /** When true every call throws (a fully-broken remote). */
  failAll: boolean
  /** Gate for put(): when set, every put awaits it before completing. */
  putGate?: Promise<void>
  putStarted: boolean
  putFinished: boolean
}

function stubRemote(): StubRemote {
  const state: StubRemote = {
    store: new Map<string, Uint8Array>(),
    gets: 0,
    puts: 0,
    heads: 0,
    hasManyCalls: 0,
    getLatencyMs: 0,
    failAll: false,
    putStarted: false,
    putFinished: false,
    layer: {
      async has(hash) {
        state.heads++
        if (state.failAll) throw new Error('remote down')
        return state.store.has(hash)
      },
      async hasMany(hashes) {
        state.hasManyCalls++
        if (state.failAll) throw new Error('remote down')
        return new Set(hashes.filter((h) => state.store.has(h)))
      },
      async get(hash) {
        state.gets++
        if (state.failAll) throw new Error('remote down')
        if (state.getLatencyMs > 0) await Bun.sleep(state.getLatencyMs)
        const body = state.store.get(hash)
        if (!body) return null
        return { body: body.slice().buffer as ArrayBuffer, durationMs: 42 }
      },
      async put(hash, body) {
        state.puts++
        state.putStarted = true
        if (state.failAll) throw new Error('remote down')
        if (state.putGate !== undefined) await state.putGate
        state.store.set(hash, body instanceof Uint8Array ? body.slice() : new Uint8Array(body))
        state.putFinished = true
      },
    },
  }
  return state
}

describe('LayeredCache', () => {
  let workspaceRoot: string
  let projectDir: string
  let cacheDir: string
  let local: Cache
  let remote: StubRemote

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'vx-layered-'))
    projectDir = path.join(workspaceRoot, 'project')
    cacheDir = path.join(workspaceRoot, '.vx', 'cache')
    await mkdir(projectDir, { recursive: true })
    local = new Cache(cacheDir)
    remote = stubRemote()
  })

  afterEach(async () => {
    local.close()
    await rm(workspaceRoot, { recursive: true, force: true })
  })

  function makeLayered(opts?: { onRemoteError?: (e: Error) => void }): LayeredCache {
    return new LayeredCache(local, remote.layer, {
      onRemoteError:
        opts?.onRemoteError ??
        (() => {
          /* suppress; tests assert via counters when relevant */
        }),
    })
  }

  /** Wipe + reopen the local cache so the stub remote is the only source. */
  async function wipeLocal(): Promise<void> {
    local.close()
    await rm(cacheDir, { recursive: true, force: true })
    local = new Cache(cacheDir)
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
    // save() queues the remote PUT in the background (run() drains at
    // end-of-run); tests asserting on the remote side drain here.
    if (cache instanceof LayeredCache) await cache.drainUploads()
  }

  it('save() writes local AND uploads to remote', async () => {
    const layered = makeLayered()
    await saveSample(layered, 'h-save')

    // Local entry present.
    const got = await local.get('h-save')
    expect(got).not.toBeNull()

    // Remote received the artifact bytes for the same hash.
    expect(remote.puts).toBe(1)
    expect(remote.store.get('h-save')!.byteLength).toBeGreaterThan(0)
  })

  it('save() does not fail when the remote rejects', async () => {
    remote.failAll = true
    const layered = makeLayered()
    // Should resolve normally — remote error is logged, not thrown.
    await expect(saveSample(layered, 'h-rem-err')).resolves.toBeUndefined()
    expect(await local.get('h-rem-err')).not.toBeNull()
  })

  it('get() returns local entry without touching remote when local has it', async () => {
    await saveSample(local, 'h-local')

    const layered = makeLayered()
    const hit = await layered.get('h-local')
    expect(hit).not.toBeNull()
    expect(hit?.source).toBe('local')
    expect(remote.gets).toBe(0)
  })

  it('get() falls back to remote and materializes into local', async () => {
    // Seed the remote: a save through a LayeredCache uploads a real packed
    // artifact for the hash, then wipe local.
    await saveSample(makeLayered(), 'h-remote-only')
    expect(remote.store.has('h-remote-only')).toBe(true)
    await wipeLocal()
    const layered = makeLayered()

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
    // The remote-reported duration rode the ingest.
    expect(hit?.durationMs).toBe(42)

    // Local is now populated for next time, and a follow-up lookup
    // reports source='local' (the remote pull only fires once).
    const next = await local.get('h-remote-only')
    expect(next).not.toBeNull()
    expect(next?.source).toBe('local')
  })

  it('get() degrades a corrupt remote artifact to a miss instead of throwing', async () => {
    // The remote "has" the hash, but the body is not a zstd artifact —
    // a truncated/garbage upload from another writer. The layered cache
    // must report it via onRemoteError and return null so the run falls
    // back to executing the task.
    remote.store.set('h-corrupt', new TextEncoder().encode('definitely not zstd'))
    const errors: Error[] = []
    const layered = makeLayered({ onRemoteError: (e) => errors.push(e) })

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
    remote.failAll = true
    const layered = makeLayered()
    expect(await layered.get('h-fail')).toBeNull()
  })

  it('remoteHasMany() returns the remotely-present subset in one call', async () => {
    remote.store.set('h-a', new Uint8Array([1]))
    remote.store.set('h-c', new Uint8Array([1]))
    const layered = makeLayered()
    const present = await layered.remoteHasMany(['h-a', 'h-b', 'h-c'])
    expect(present).not.toBeNull()
    expect([...(present ?? [])].sort()).toEqual(['h-a', 'h-c'])
    expect(remote.hasManyCalls).toBe(1)
  })

  it('remoteHasMany() returns null when the remote layer cannot batch', async () => {
    delete (remote.layer as { hasMany?: unknown }).hasMany
    const layered = makeLayered()
    expect(await layered.remoteHasMany(['h-a'])).toBeNull()
  })

  it('remoteHasMany() returns null and reports the error when hasMany throws', async () => {
    remote.failAll = true
    const errors: Error[] = []
    const layered = makeLayered({ onRemoteError: (e) => errors.push(e) })
    expect(await layered.remoteHasMany(['h-a'])).toBeNull()
    expect(errors).toHaveLength(1)
  })

  it('remoteHasMany() returns null when remote reads are disabled by policy', async () => {
    const layered = new LayeredCache(local, remote.layer, {
      policy: { localRead: true, localWrite: true, remoteRead: false, remoteWrite: true },
      onRemoteError: () => {},
    })
    expect(await layered.remoteHasMany(['h-a'])).toBeNull()
    expect(remote.hasManyCalls).toBe(0)
  })

  it('markRemoteAbsent() makes a later get() a miss with NO remote GET', async () => {
    const layered = makeLayered()
    layered.markRemoteAbsent(['h-gone'])
    expect(await layered.get('h-gone', { taskId: 'pkg#build', command: 'x' })).toBeNull()
    // The batch probe already said "absent" — the lazy get must not re-probe.
    expect(remote.gets).toBe(0)
  })

  it('markRemoteAbsent() does not clobber an in-flight pull', async () => {
    // Seed a REAL artifact remotely, then hold the pull open mid-flight.
    await saveSample(makeLayered(), 'h-race')
    await wipeLocal()
    const layered = makeLayered()
    remote.getLatencyMs = 40
    const pull = layered.prefetch('h-race', { taskId: 'pkg#build', command: 'echo produced' })
    // A late batch verdict must NOT overwrite the pending pull with `false`.
    layered.markRemoteAbsent(['h-race'])
    expect(await pull).toBe(true)
    expect(await local.get('h-race')).not.toBeNull()
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

  it('prefetch() pulls a remote-only artifact into local, and a later get() is a remote-source hit', async () => {
    await saveSample(makeLayered(), 'h-pf')
    await wipeLocal()
    const layered = makeLayered()

    const pulled = await layered.prefetch('h-pf', { taskId: 'pkg#build', command: 'echo produced' })
    expect(pulled).toBe(true)
    // The artifact is now materialized locally.
    expect(await local.get('h-pf')).not.toBeNull()

    // get() after a prefetch still reports source='remote' (this lookup
    // was served by the remote layer) and fires NO new remote GET.
    const getsBefore = remote.gets
    const hit = await layered.get('h-pf', { taskId: 'pkg#build', command: 'echo produced' })
    expect(hit?.source).toBe('remote')
    expect(remote.gets).toBe(getsBefore)
  })

  it('prefetch() returns false on a remote miss (degrades, never throws)', async () => {
    const layered = makeLayered()
    expect(await layered.prefetch('h-absent', { taskId: 'pkg#x', command: 'c' })).toBe(false)
  })

  it('prefetch() + get() issue AT MOST ONE remote GET per hash', async () => {
    await saveSample(makeLayered(), 'h-once')
    await wipeLocal()

    // Inject latency so prefetch is still in flight when get() arrives —
    // this is the race the inflight map must collapse to one GET. The
    // guard FAILS at 2 if the de-dup is removed.
    remote.getLatencyMs = 60
    remote.gets = 0
    const layered = makeLayered()

    // Kick off prefetch (in flight), then immediately get() the same hash.
    const pf = layered.prefetch('h-once', { taskId: 'pkg#build', command: 'echo produced' })
    const hit = await layered.get('h-once', { taskId: 'pkg#build', command: 'echo produced' })
    await pf
    expect(hit?.source).toBe('remote')
    expect(remote.gets).toBe(1)
  })

  it('prefetch-miss does not trigger a SECOND remote GET on the following get()', async () => {
    const layered = makeLayered()
    expect(await layered.prefetch('h-pm', { taskId: 'pkg#x', command: 'c' })).toBe(false)
    const hit = await layered.get('h-pm', { taskId: 'pkg#x', command: 'c' })
    expect(hit).toBeNull()
    // The prefetch already probed remote and found nothing; get() must
    // reuse that result, not probe again.
    expect(remote.gets).toBe(1)
  })

  it('prefetch() is idempotent — two concurrent prefetches share one remote GET', async () => {
    await saveSample(makeLayered(), 'h-dup')
    await wipeLocal()

    remote.getLatencyMs = 40
    remote.gets = 0
    const layered = makeLayered()

    const [a, b] = await Promise.all([
      layered.prefetch('h-dup', { taskId: 'pkg#build', command: 'echo produced' }),
      layered.prefetch('h-dup', { taskId: 'pkg#build', command: 'echo produced' }),
    ])
    expect(a).toBe(true)
    expect(b).toBe(true)
    expect(remote.gets).toBe(1)
  })

  it('save() resolves before a slow remote PUT completes; drainUploads() completes it', async () => {
    // Gate the PUT: the stub holds every PUT open until we release it.
    let releasePut!: () => void
    remote.putGate = new Promise<void>((resolve) => {
      releasePut = resolve
    })
    const layered = makeLayered()

    const outFile = path.join(projectDir, 'dist', 'out.txt')
    await mkdir(path.dirname(outFile), { recursive: true })
    await writeFile(outFile, 'slow-put')
    // save() must return while the PUT is still gated open — the upload
    // is off the task's critical path.
    await layered.save({
      hash: 'h-slow-put',
      projectDir,
      outputFiles: [outFile],
      entry: { taskId: 'pkg#build', command: 'c', exitCode: 0, durationMs: 1, stdout: '' },
    })
    // Give the background job a beat to fire the request.
    await Bun.sleep(20)
    expect(remote.putStarted).toBe(true)
    expect(remote.putFinished).toBe(false)
    // Local landed synchronously regardless of the in-flight upload.
    expect(await local.get('h-slow-put')).not.toBeNull()

    const drain = layered.drainUploads()
    releasePut()
    await drain
    expect(remote.putFinished).toBe(true)
  })

  it('has() reports local / remote / null without moving bytes', async () => {
    const layered = makeLayered()
    await saveSample(local, 'h-has-local')
    expect(await layered.has('h-has-local')).toBe('local')

    // Remote-only: seed via a layered save, then wipe local.
    await saveSample(layered, 'h-has-remote')
    await wipeLocal()
    const fresh = makeLayered()
    remote.gets = 0
    remote.heads = 0
    expect(await fresh.has('h-has-remote')).toBe('remote')
    // The probe was an existence HEAD — no GET, and nothing was ingested
    // locally.
    expect(remote.heads).toBe(1)
    expect(remote.gets).toBe(0)
    expect(await local.get('h-has-remote')).toBeNull()

    expect(await fresh.has('h-has-nowhere')).toBe(null)
  })

  it('has() degrades a remote failure to null (never throws)', async () => {
    remote.failAll = true
    const layered = makeLayered()
    expect(await layered.has('h-has-err')).toBe(null)
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
