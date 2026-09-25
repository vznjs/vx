// LayeredCache over the RemoteCacheLayer seam — a plain in-memory stub
// layer (core ships no wire client; the wire is a plugin concern, see
// docs/modules/layered-cache.md). The stub throws like a real client would;
// LayeredCache owns dedup, provenance, and never-fail degradation.

import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { Cache } from '../src/cache/cache.js'
import { LayeredCache, type RemoteCacheLayer } from '../src/cache/layered-cache.js'
import type { InvocationRecord } from '../src/cache/index.js'

/** A minimal invocation row: `recordRunBundle` is the only run-history write a layer takes. */
function invocation(runId: string): InvocationRecord {
  return {
    runId,
    command: 'vx run build',
    requestedTasks: JSON.stringify(['build']),
    cachePolicy: 'lR,lW',
    concurrency: 1,
    flow: 'broad',
    startedAt: Date.now() - 10,
    endedAt: Date.now(),
    totalDurationMs: 10,
    taskCount: 1,
    failedCount: 0,
    hitCount: 0,
    hitLocalCount: 0,
    hitRemoteCount: 0,
    exitOk: true,
    commitSha: null,
    branch: null,
    dirty: null,
    ci: false,
    ciProvider: null,
    host: null,
    os: null,
    arch: null,
    vxVersion: '0.0.0',
    tags: '{}',
  }
}

interface StubRemote {
  layer: RemoteCacheLayer
  store: Map<string, Uint8Array>
  /** What `get` wraps the stored bytes in — the contract takes either. */
  bodyKind: 'blob' | 'response'
  /** Every body `put` received, as handed over. */
  putBodies: Blob[]
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
    bodyKind: 'blob',
    putBodies: [],
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
        const copy = body.slice()
        return {
          body: state.bodyKind === 'blob' ? new Blob([copy]) : new Response(copy),
          durationMs: 42,
        }
      },
      async put(hash, body) {
        state.puts++
        state.putStarted = true
        state.putBodies.push(body)
        if (state.failAll) throw new Error('remote down')
        if (state.putGate !== undefined) await state.putGate
        state.store.set(hash, await body.bytes())
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

  // A plugin's shape is a boundary (item 252): the line names the call
  // and the shape, never "corrupt artifact" for a body that is a string.
  it('get() that resolves the wrong shape is named as the plugin bug and degraded to a miss', async () => {
    const errors: Error[] = []
    const shaped = {
      has: async () => true,
      get: async () => ({ body: 'abc', durationMs: 1 }),
      put: async () => {},
    } as unknown as RemoteCacheLayer
    const layered = new LayeredCache(local, shaped, { onRemoteError: (e) => errors.push(e) })
    expect(await layered.get('h-shape', { taskId: 'pkg#build', command: 'tsc' })).toBeNull()
    expect(errors.map((e) => e.message)).toEqual([
      'download h-shape failed: remote cache layer returned an invalid result: get() resolved body is string (expected { body: Blob | Response, durationMs } or null) — a plugin bug, degraded to a miss',
    ])
    expect(await local.get('h-shape')).toBeNull()
  })

  it('get() that resolves the pre-stream bytes shape is refused, naming the new one', async () => {
    // No bytes union (streaming-remote-2026-09): a layer still resolving
    // `{ body: Uint8Array }` is an unported plugin, refused at the boundary
    // though Bun.write would happily take the bytes.
    await saveSample(makeLayered(), 'h-old')
    await wipeLocal()
    const errors: Error[] = []
    const old = {
      has: async () => true,
      get: async () => ({ body: remote.store.get('h-old')!.slice(), durationMs: 1 }),
      put: async () => {},
    } as unknown as RemoteCacheLayer
    const layered = new LayeredCache(local, old, { onRemoteError: (e) => errors.push(e) })
    expect(await layered.get('h-old', { taskId: 'pkg#build', command: 'tsc' })).toBeNull()
    expect(errors.map((e) => e.message)).toEqual([
      'download h-old failed: remote cache layer returned an invalid result: get() resolved body is a Uint8Array (expected { body: Blob | Response, durationMs } or null) — a plugin bug, degraded to a miss',
    ])
    expect(await local.has('h-old')).toBeNull()
  })

  for (const kind of ['blob', 'response'] as const) {
    it(`get() ingests a remote body resolved as a ${kind}`, async () => {
      await saveSample(makeLayered(), `h-${kind}`)
      await wipeLocal()
      remote.bodyKind = kind
      const errors: Error[] = []
      const layered = makeLayered({ onRemoteError: (e) => errors.push(e) })
      const hit = await layered.get(`h-${kind}`, { taskId: 'pkg#build', command: 'echo produced' })
      expect(errors).toEqual([])
      expect(hit?.source).toBe('remote')
      expect(hit?.stdout).toBe('compiling…')
      expect(hit?.outputFiles).toEqual(['dist/out.txt'])
    })
  }

  // A socket that drops mid-body leaves Bun.write's partial file behind it;
  // the second shape (a body that ends early but cleanly) is validation's
  // to refuse. Either way nothing may outlive the miss in the cache dir.
  for (const cut of ['errors', 'ends early'] as const) {
    it(`get() degrades a Response body that ${cut} mid-artifact to a miss, leaving no temp`, async () => {
      await saveSample(makeLayered(), 'h-cut')
      const whole = remote.store.get('h-cut')!
      await wipeLocal()
      const errors: Error[] = []
      const cutting = {
        has: async () => true,
        get: async () => ({
          body: new Response(
            new ReadableStream<Uint8Array>({
              start(c) {
                c.enqueue(whole.slice(0, whole.byteLength >> 1))
                if (cut === 'errors') c.error(new Error('socket dropped'))
                else c.close()
              },
            }),
          ),
          durationMs: 1,
        }),
        put: async () => {},
      } satisfies RemoteCacheLayer
      const layered = new LayeredCache(local, cutting, { onRemoteError: (e) => errors.push(e) })
      expect(await layered.get('h-cut', { taskId: 'pkg#build', command: 'tsc' })).toBeNull()
      expect(errors).toHaveLength(1)
      expect(await local.has('h-cut')).toBeNull()
      expect((await readdir(cacheDir)).filter((f) => f.startsWith('h-cut'))).toEqual([])
    })
  }

  it('hasMany() that resolves an array is named and read as no batch info', async () => {
    const errors: Error[] = []
    const shaped = {
      has: async () => false,
      hasMany: async () => ['h-a'],
      get: async () => null,
      put: async () => {},
    } as unknown as RemoteCacheLayer
    const layered = new LayeredCache(local, shaped, { onRemoteError: (e) => errors.push(e) })
    expect(await layered.remoteHasMany(['h-a', 'h-b'])).toBeNull()
    expect(errors.map((e) => e.message)).toEqual([
      'probe of 2 artifacts failed: remote cache layer returned an invalid result: hasMany() resolved an array (expected a Set of the hashes present, or null) — a plugin bug, degraded to a miss',
    ])
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

  it('prefetch() with remote reads off pulls nothing: no remote GET, false', async () => {
    // The policy gate on `prefetch` (`if (!this.policy.remoteRead) return
    // false`) survived the whole core suite with `remoteHasMany`'s twin
    // held (item 641): a `--cache` that turns remote reads off must leave
    // the prefetch pass, not only the lazy get, off the wire.
    await saveSample(makeLayered(), 'h-off')
    await wipeLocal()
    const layered = new LayeredCache(local, remote.layer, {
      policy: { localRead: true, localWrite: true, remoteRead: false, remoteWrite: true },
      onRemoteError: () => {},
    })
    expect(await layered.prefetch('h-off', { taskId: 'pkg#build', command: 'x' })).toBe(false)
    expect(remote.gets).toBe(0)
  })

  it('get() with remote reads off is a plain local miss: no remote GET, null', async () => {
    await saveSample(makeLayered(), 'h-off')
    await wipeLocal()
    const layered = new LayeredCache(local, remote.layer, {
      policy: { localRead: true, localWrite: true, remoteRead: false, remoteWrite: true },
      onRemoteError: () => {},
    })
    expect(await layered.get('h-off', { taskId: 'pkg#build', command: 'x' })).toBeNull()
    expect(remote.gets).toBe(0)
  })

  it('save() with remote writes off uploads nothing: local entry, no remote PUT', async () => {
    // The write twin of the two read gates (item 641): `--cache` turning
    // remote writes off must leave the upload pool idle, and the local
    // save still lands. Deleting the gate survived the whole core suite
    // (item 642).
    const layered = new LayeredCache(local, remote.layer, {
      policy: { localRead: true, localWrite: true, remoteRead: true, remoteWrite: false },
      onRemoteError: () => {},
    })
    await saveSample(layered, 'h-nowrite')
    await layered.drainUploads()
    expect(remote.puts).toBe(0)
    expect(remote.store.has('h-nowrite')).toBe(false)
    expect(await local.has('h-nowrite')).toBe('local')
  })

  it('save() with local writes off: a pack that throws is reported and skipped, never thrown', async () => {
    // With local writes off the bytes are packed NOW (there is no on-disk
    // artifact to read later); a pack that fails is a remote-side loss,
    // not the task's — reported, no PUT, the task already succeeded.
    // Deleting the catch survived the whole core suite (item 642).
    const errors: Error[] = []
    const writeless = new Cache(path.join(workspaceRoot, '.vx', 'nowrite-pack'), {
      read: true,
      write: false,
    })
    const layered = new LayeredCache(writeless, remote.layer, {
      policy: { localRead: true, localWrite: false, remoteRead: true, remoteWrite: true },
      onRemoteError: (e) => errors.push(e),
    })
    const pack = spyOn(writeless, 'packArtifactBytes').mockRejectedValue(new Error('pack exploded'))
    try {
      await saveSample(layered, 'h-pack')
      await layered.drainUploads()
    } finally {
      pack.mockRestore()
      writeless.close()
    }
    expect(errors.map((e) => e.message)).toEqual(['upload h-pack failed: pack exploded'])
    expect(remote.puts).toBe(0)
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

  it('a get() issued while a pull is in flight waits for it, after markRemoteAbsent too', async () => {
    // The pull's own promise survives the clobber either way; what a late
    // `false` would break is the get() that joins the pull mid-flight.
    await saveSample(makeLayered(), 'h-join')
    await wipeLocal()
    const layered = makeLayered()
    remote.getLatencyMs = 40
    const pull = layered.prefetch('h-join', { taskId: 'pkg#build', command: 'echo produced' })
    layered.markRemoteAbsent(['h-join'])
    const hit = await layered.get('h-join', { taskId: 'pkg#build', command: 'echo produced' })
    expect(hit?.source).toBe('remote')
    expect(await pull).toBe(true)
  })

  it("the pulled entry carries the caller's task id, and the upload the entry's duration", async () => {
    const metas: Array<{ durationMs?: number }> = []
    const layer: RemoteCacheLayer = {
      ...remote.layer,
      put: async (hash, body, meta) => {
        metas.push({ ...meta })
        await remote.layer.put(hash, body, meta)
      },
    }
    const saver = new LayeredCache(local, layer, { onRemoteError: () => {} })
    await saveSample(saver, 'h-meta')
    expect(metas).toEqual([{ durationMs: 5 }])
    await wipeLocal()
    const hit = await makeLayered().get('h-meta', { taskId: 'app#build', command: 'x' })
    expect(hit?.taskId).toBe('app#build')
  })

  it('has() with remote reads off never probes the remote', async () => {
    await saveSample(makeLayered(), 'h-probe')
    await wipeLocal()
    const layered = new LayeredCache(local, remote.layer, {
      policy: { localRead: true, localWrite: true, remoteRead: false, remoteWrite: true },
      onRemoteError: () => {},
    })
    remote.heads = 0
    expect(await layered.has('h-probe')).toBeNull()
    expect(remote.heads).toBe(0)
  })

  it('remoteHasMany() reads a hasMany() that resolves undefined as no batch info', async () => {
    const layered = new LayeredCache(
      local,
      { ...remote.layer, hasMany: async () => undefined as unknown as Set<string> },
      { onRemoteError: () => {} },
    )
    expect(await layered.remoteHasMany(['h1'])).toBeNull()
  })

  it('runs four uploads at once, and the fifth waits', async () => {
    let release!: () => void
    remote.putGate = new Promise<void>((r) => (release = r))
    const layered = makeLayered()
    const outFile = path.join(projectDir, 'dist', 'out.txt')
    await mkdir(path.dirname(outFile), { recursive: true })
    for (let i = 0; i < 5; i++) {
      await writeFile(outFile, `produced-${i}`)
      await layered.save({
        hash: `h-pool-${i}`,
        projectDir,
        outputFiles: [outFile],
        entry: { taskId: 'pkg#build', command: 'x', durationMs: 1, stdout: '' },
      })
    }
    await Bun.sleep(0)
    expect(remote.puts).toBe(4)
    release()
    await layered.drainUploads()
    expect(remote.puts).toBe(5)
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

  it('prefetch() skips the remote GET when local ALREADY has the artifact (warm-local run)', async () => {
    // A configured remote + a warm local (a prior run already materialized
    // the artifact). prefetch() must mirror get()/has()'s local-first check:
    // there is nothing to warm, so it fires NO remote GET and — crucially —
    // does NOT flip provenance. Marking a purely-local warm hit as
    // `cache-hit-remote` would inflate the remote hit-rate signal (and, on a
    // 1000-task warm run, re-download every artifact the local cache holds).
    const layered = makeLayered()
    await saveSample(layered, 'h-warm') // both local + remote hold it
    expect(await local.get('h-warm')).not.toBeNull()
    remote.gets = 0 // reset after the save's upload

    const pulled = await layered.prefetch('h-warm', {
      taskId: 'pkg#build',
      command: 'echo produced',
    })
    expect(pulled).toBe(true) // available in local — but via NO remote GET
    expect(remote.gets).toBe(0) // NO redundant remote download

    // The subsequent lookup is a LOCAL hit, not a mislabeled remote one.
    const hit = await layered.get('h-warm', { taskId: 'pkg#build', command: 'echo produced' })
    expect(hit?.source).toBe('local')
    expect(remote.gets).toBe(0)
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
      entry: { taskId: 'pkg#build', command: 'c', durationMs: 1, stdout: '' },
    })
    // Wait for the background job to fire the request rather than assuming
    // it fits in a fixed pause: under a loaded gate 20 ms did not, and the
    // assertion read as "the upload never started" (2026-09-05).
    const deadline = Date.now() + 5_000
    while (!remote.putStarted && Date.now() < deadline) await Bun.sleep(5)
    expect(remote.putStarted).toBe(true)
    expect(remote.putFinished).toBe(false)
    // Local landed synchronously regardless of the in-flight upload.
    expect(await local.get('h-slow-put')).not.toBeNull()

    const drain = layered.drainUploads()
    releasePut()
    await drain
    expect(remote.putFinished).toBe(true)
  })

  it('a queued upload holds no artifact bytes — it reads them when the PUT runs', async () => {
    // UPLOAD_CONCURRENCY bounds sockets, not memory: a queued closure that
    // captured its own artifact keeps the WHOLE backlog resident, so peak
    // RSS scaled with total miss artifact bytes. Proving non-retention
    // WITHOUT an RSS assertion: stall the pool, save, then delete the local
    // artifacts. Bytes captured at save time would still upload; bytes read
    // at PUT time cannot. Deleting stands in for the documented racer, a
    // concurrent `vx cache prune`.
    let releasePut!: () => void
    remote.putGate = new Promise<void>((resolve) => {
      releasePut = resolve
    })
    const errors: Error[] = []
    const layered = makeLayered({ onRemoteError: (e) => errors.push(e) })

    // One more save than the pool can run at once, so some genuinely queue.
    const queuedHashes = ['h-q0', 'h-q1', 'h-q2', 'h-q3', 'h-q4', 'h-q5']
    for (const hash of queuedHashes) {
      const outFile = path.join(projectDir, 'dist', `${hash}.txt`)
      await mkdir(path.dirname(outFile), { recursive: true })
      await writeFile(outFile, `produced-${hash}`)
      // save() must not block on the gated pool — the upload is off the
      // task's critical path whether or not the bytes are read here.
      await layered.save({
        hash,
        projectDir,
        outputFiles: [outFile],
        entry: { taskId: 'pkg#build', command: 'c', durationMs: 1, stdout: '' },
      })
    }
    await Bun.sleep(20)
    // Every artifact landed locally; only the uploads are backed up.
    for (const hash of queuedHashes) expect(await local.get(hash)).not.toBeNull()

    // Remove the artifacts the still-queued uploads have not read yet.
    await rm(cacheDir, { recursive: true, force: true })

    const drain = layered.drainUploads()
    releasePut()
    await drain

    // Only the uploads already RUNNING when the artifacts vanished could
    // have read their bytes; every queued one found nothing to send.
    expect(remote.store.size).toBeLessThan(queuedHashes.length)
    expect(errors.length).toBeGreaterThan(0)
    // And the vanished artifact never failed anything — the never-fail
    // contract covers the deferred read too.
    expect(errors.every((e) => e instanceof Error)).toBe(true)
  })

  it('the upload job hands put() a file-backed Blob over the local artifact', async () => {
    // A path, not a buffer: the plugin streams it and never holds it whole.
    const layered = makeLayered()
    await saveSample(layered, 'h-file')
    expect(remote.putBodies.map((b) => (b as { name?: unknown }).name)).toEqual([
      local.outputsPath('h-file'),
    ])
  })

  it('save() still packs in memory when local writes are disabled', async () => {
    // Control for the deferred read: with `--cache=local:,remote:rw` there
    // is no on-disk artifact to read later, so those bytes MUST be captured
    // during save() while the task's outputs are still on disk. Must behave
    // identically before and after the deferral.
    const writeless = new Cache(path.join(workspaceRoot, '.vx', 'nowrite'), {
      read: false,
      write: false,
    })
    try {
      const layered = new LayeredCache(writeless, remote.layer, { onRemoteError: () => {} })
      const outFile = path.join(projectDir, 'dist', 'packed.txt')
      await mkdir(path.dirname(outFile), { recursive: true })
      await writeFile(outFile, 'packed-in-memory')
      await layered.save({
        hash: 'h-packed',
        projectDir,
        outputFiles: [outFile],
        entry: { taskId: 'pkg#build', command: 'c', durationMs: 1, stdout: '' },
      })
      // Deleting the outputs after save() must not affect the upload: the
      // bytes were already packed.
      await rm(outFile)
      await layered.drainUploads()
      expect(remote.store.get('h-packed')!.byteLength).toBeGreaterThan(0)
    } finally {
      writeless.close()
    }
  })

  it('get() keeps source local when the pull skipped the remote (no GET issued)', async () => {
    // `doPullFromRemote` also returns true for its local-first skip, which
    // issues NO remote GET. A run sharing this cache dir can ingest the
    // artifact between get()'s local read and that skip's `local.has` —
    // stamping 'remote' there reported a purely-local hit as
    // cache-hit-remote and inflated the remote hit-rate.
    await saveSample(local, 'h-src-race')

    // The first local read misses, later reads see the artifact — exactly
    // what a concurrent run ingesting into the shared cache dir produces.
    let firstRead = true
    const racy = new Proxy(local, {
      get(target, prop, receiver) {
        if (prop === 'get') {
          return async (hash: string, ctx?: unknown) => {
            if (firstRead) {
              firstRead = false
              return null
            }
            return await (target.get as (h: string, c?: unknown) => Promise<unknown>)(hash, ctx)
          }
        }
        return Reflect.get(target, prop, receiver) as unknown
      },
    })
    const layered = new LayeredCache(racy, remote.layer, { onRemoteError: () => {} })

    const hit = await layered.get('h-src-race', { taskId: 'pkg#build', command: 'echo produced' })
    expect(hit).not.toBeNull()
    expect(hit?.source).toBe('local')
    expect(remote.gets).toBe(0)
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

  it('stats() / recordRunBundle() / prune() delegate to local', async () => {
    const layered = makeLayered()
    layered.recordRunBundle({
      runs: [
        {
          hash: 'h-rec',
          project: 'pkg',
          task: 'build',
          status: 'success',
          exitCode: 0,
          durationMs: 1,
          startedAt: Date.now(),
          endedAt: Date.now(),
        },
      ],
      invocation: invocation('run-1'),
    })
    const stats = layered.stats()
    expect(stats.runCountLast24h).toBe(1)

    await expect(layered.prune({})).rejects.toThrow(/at least one of/)
  })

  // Item 749: a wire's own message names nothing — "The operation timed
  // out." with no upload, hash or server — and an unreachable server said
  // it once per request. The layer knows the call and the artifact, the
  // plugin knows the server; the line carries all three, once per class.
  describe('what a degraded remote says', () => {
    const ENDPOINT = 'https://cache.example.com/v8/artifacts'

    /** A layer whose every call throws what `fail` returns for it. */
    function failing(
      fail: (call: 'has' | 'hasMany' | 'get' | 'put', hash: string) => Error,
      endpoint?: string,
    ): RemoteCacheLayer {
      return {
        ...(endpoint === undefined ? {} : { endpoint }),
        has: async (h) => {
          throw fail('has', h)
        },
        hasMany: async (hs) => {
          throw fail('hasMany', hs.join(','))
        },
        get: async (h) => {
          throw fail('get', h)
        },
        put: async (h) => {
          throw fail('put', h)
        },
      }
    }

    /** Close the layer (the repeat count is said there) and reopen `local` for afterEach. */
    function closeAndReopen(layered: LayeredCache): void {
      layered.close()
      local = new Cache(cacheDir)
    }

    it('each call names its operation, its artifact and the endpoint', async () => {
      const errors: Error[] = []
      const causes = {
        has: new Error('HEAD said 500'),
        hasMany: new Error('POST said 502'),
        get: new Error('GET said 503'),
        put: new Error('PUT said 504'),
      }
      const layered = new LayeredCache(
        local,
        failing((call) => causes[call], ENDPOINT),
        { onRemoteError: (e) => errors.push(e) },
      )
      expect(await layered.has('h1')).toBeNull()
      expect(await layered.remoteHasMany(['h1', 'h2'])).toBeNull()
      expect(await layered.get('h1')).toBeNull()
      await saveSample(layered, 'h-up')
      closeAndReopen(layered)
      expect(errors.map((e) => e.message)).toEqual([
        'probe h1 at https://cache.example.com/v8/artifacts failed: HEAD said 500',
        'probe of 2 artifacts at https://cache.example.com/v8/artifacts failed: POST said 502',
        'download h1 from https://cache.example.com/v8/artifacts failed: GET said 503',
        'upload h-up to https://cache.example.com/v8/artifacts failed: PUT said 504',
      ])
      expect(errors.map((e) => e.cause)).toEqual([
        causes.has,
        causes.hasMany,
        causes.get,
        causes.put,
      ])
    })

    it('one failure class is said once, and close() counts the requests held back', async () => {
      const errors: Error[] = []
      const layered = new LayeredCache(
        local,
        failing(() => new Error('Unable to connect'), ENDPOINT),
        { onRemoteError: (e) => errors.push(e) },
      )
      await layered.remoteHasMany(['h1'])
      await layered.get('h1')
      await saveSample(layered, 'h1')
      expect(errors.map((e) => e.message)).toEqual([
        'probe of 1 artifact at https://cache.example.com/v8/artifacts failed: Unable to connect',
      ])
      closeAndReopen(layered)
      expect(errors.map((e) => e.message)).toEqual([
        'probe of 1 artifact at https://cache.example.com/v8/artifacts failed: Unable to connect',
        '2 more requests failed the same way: Unable to connect',
      ])
    })

    it('the artifact in a message and the timing in a coded one do not split a class', async () => {
      // gRPC writes the elapsed time into the message, so a deadline's code
      // is its class; a status line that names the hash is one class across
      // hashes. A different code is a different class (the control).
      const coded = (code: number, message: string): Error =>
        Object.assign(new Error(message), { code })
      const errors: Error[] = []
      const layered = new LayeredCache(
        local,
        failing((call, hash) => {
          if (call === 'has' && hash === 'h1') return coded(4, '4 DEADLINE_EXCEEDED: after 0.001s')
          if (call === 'has' && hash === 'h2') return coded(4, '4 DEADLINE_EXCEEDED: after 0.702s')
          if (call === 'has') return coded(14, '14 UNAVAILABLE: no connection')
          return new Error(`HTTP 500 for ${hash}`)
        }),
        { onRemoteError: (e) => errors.push(e) },
      )
      for (const h of ['h1', 'h2', 'h3']) await layered.has(h)
      for (const h of ['h4', 'h5']) await layered.get(h)
      closeAndReopen(layered)
      expect(errors.map((e) => e.message)).toEqual([
        'probe h1 failed: 4 DEADLINE_EXCEEDED: after 0.001s',
        'probe h3 failed: 14 UNAVAILABLE: no connection',
        'download h4 failed: HTTP 500 for h4',
        '1 more request failed the same way: 4 DEADLINE_EXCEEDED: after 0.001s',
        '1 more request failed the same way: HTTP 500 for h4',
      ])
    })

    it('a body of null is named, a thrown string is its own message, and an empty endpoint is none', async () => {
      const errors: Error[] = []
      const layered = new LayeredCache(
        local,
        {
          endpoint: '',
          has: async () => {
            throw 'boom'
          },
          get: async () => ({ body: null }) as never,
          put: async () => {},
        },
        { onRemoteError: (e) => errors.push(e) },
      )
      await layered.has('h1')
      await layered.get('h2')
      expect(errors.map((e) => e.message)).toEqual([
        'probe h1 failed: boom',
        'download h2 failed: remote cache layer returned an invalid result: get() resolved body is null (expected { body: Blob | Response, durationMs } or null) — a plugin bug, degraded to a miss',
      ])
    })

    it('with no reporter, the line goes to stderr', async () => {
      const writes: string[] = []
      const spy = spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        writes.push(String(chunk))
        return true
      })
      try {
        await new LayeredCache(
          local,
          failing(() => new Error('down'), ENDPOINT),
        ).has('h1')
      } finally {
        spy.mockRestore()
      }
      expect(writes).toEqual([`[vx] remote cache: probe h1 at ${ENDPOINT} failed: down\n`])
    })

    it('the endpoint is printed without its credentials, query or fragment', async () => {
      const said = async (endpoint: string): Promise<string[]> => {
        const errors: Error[] = []
        const layered = new LayeredCache(
          local,
          failing(() => new Error('down'), endpoint),
          { onRemoteError: (e) => errors.push(e) },
        )
        await layered.has('h1')
        return errors.map((e) => e.message)
      }
      expect(await said('https://user:secret@cache.example.com/v1/cache?token=t0k#frag')).toEqual([
        'probe h1 at https://cache.example.com/v1/cache failed: down',
      ])
      // Controls: a clean URL and a gRPC `host:port` print as given.
      expect(await said('https://cache.example.com/v1/cache')).toEqual([
        'probe h1 at https://cache.example.com/v1/cache failed: down',
      ])
      expect(await said('grpc.example.com:443')).toEqual([
        'probe h1 at grpc.example.com:443 failed: down',
      ])
      // A bare origin has nothing to strip, so it is not re-serialised
      // (which would add a trailing slash).
      expect(await said('https://cache.example.com')).toEqual([
        'probe h1 at https://cache.example.com failed: down',
      ])
    })
  })
})
