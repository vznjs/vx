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
import { indexDb, networkConcurrency, type InvocationRecord } from '../src/cache/index.js'
import { isInline, removeStoredArtifact, storedArtifact } from './helpers/stored-artifact.js'
import { layeredOver } from './helpers/layered.js'
import { TAR_STORE } from './helpers/tar-store.js'

/** A minimal invocation row: `recordRunBundle` is the only run-history write a layer takes. */
function invocation(runId: string): InvocationRecord {
  return {
    runId,
    command: 'vx run build',
    requestedTasks: JSON.stringify(['build']),
    cachePolicy: 'local:rw,remote:',
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
    upToDateCount: 0,
    restoredLocalCount: 0,
    restoredRemoteCount: 0,
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
        return state.store.has(hash) ? {} : null
      },
      async hasMany(hashes) {
        state.hasManyCalls++
        if (state.failAll) throw new Error('remote down')
        return new Map(hashes.filter((h) => state.store.has(h)).map((h) => [h, {}]))
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
    local = new Cache(cacheDir, undefined, undefined, undefined, undefined, undefined, TAR_STORE)
    remote = stubRemote()
  })

  afterEach(async () => {
    local.close()
    await rm(workspaceRoot, { recursive: true, force: true })
  })

  function makeLayered(opts?: {
    onRemoteError?: (e: Error) => void
    uploadConcurrency?: number
  }): LayeredCache {
    return layeredOver(local, remote.layer, {
      ...(opts?.uploadConcurrency !== undefined
        ? { uploadConcurrency: opts.uploadConcurrency }
        : {}),
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
    local = new Cache(cacheDir, undefined, undefined, undefined, undefined, undefined, TAR_STORE)
  }

  /** `file`: incompressible bytes past INLINE_MAX beside it, so the artifact is a file. */
  async function saveSample(
    cache: Cache | LayeredCache,
    hash: string,
    file = false,
  ): Promise<void> {
    const outFile = path.join(projectDir, 'dist', 'out.txt')
    await mkdir(path.dirname(outFile), { recursive: true })
    await writeFile(
      outFile,
      file
        ? Buffer.concat([
            Buffer.from(`produced-${hash}`),
            crypto.getRandomValues(new Uint8Array(48 * 1024)),
          ])
        : `produced-${hash}`,
    )
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

  // A DTE worker HEADed each upload of a key the run had found in no cache
  // (turboCache()), and a write-only lane asked `has` too (2026-10-25).
  for (const read of [true, false])
    it(`save({ absent }) tells the remote the key is missing and asks no has (read ${read})`, async () => {
      const told: string[] = []
      const layered = layeredOver(
        local,
        {
          ...remote.layer,
          missing(hash) {
            told.push(hash)
          },
        },
        { policy: { localRead: true, localWrite: true, remoteRead: read, remoteWrite: true } },
      )
      const outFile = path.join(projectDir, 'dist', 'absent.txt')
      await mkdir(path.dirname(outFile), { recursive: true })
      await writeFile(outFile, 'x')
      const entry = { taskId: 'pkg#build', command: 'c', durationMs: 1, stdout: '' }
      await layered.save({
        hash: 'h-absent',
        projectDir,
        outputFiles: [outFile],
        entry,
        absent: true,
      })
      await layered.drainUploads()
      expect(remote.heads).toBe(0)
      await layered.save({ hash: 'h-asked', projectDir, outputFiles: [outFile], entry })
      await layered.drainUploads()
      expect(remote.heads).toBe(read ? 0 : 1)
      expect(told).toEqual(['h-absent'])
      expect(remote.puts).toBe(2)
    })

  it('save() does not fail when the remote rejects', async () => {
    remote.failAll = true
    const layered = makeLayered()
    // Should resolve normally — remote error is logged, not thrown.
    await expect(saveSample(layered, 'h-rem-err')).resolves.toBeUndefined()
    expect(await local.get('h-rem-err')).not.toBeNull()
  })

  // A distributed run's worker told the orchestrator its task was saved
  // though no remote took the upload, and the run failed restoring it
  // (2026-10-25): the worker now asks.
  it('uploaded() says whether a remote took what save() sent', async () => {
    const layered = makeLayered()
    expect(await layered.uploaded('h-up')).toBeUndefined()
    await saveSample(layered, 'h-up')
    expect(await layered.uploaded('h-up')).toBe(true)
    remote.failAll = true
    await saveSample(layered, 'h-refused')
    expect(await layered.uploaded('h-refused')).toBe(false)
  })

  // A CI job whose token the server refused said "remote 1↑" though its
  // remote was off and sent nothing (found 2026-10-25 on a fresh repo).
  it('counts no upload a remote put declined with false', async () => {
    const layered = makeLayered()
    const put = remote.layer.put.bind(remote.layer)
    remote.layer.put = async () => false
    await saveSample(layered, 'h-declined')
    await layered.drainUploads()
    expect(local.uploads).toMatchObject({ count: 0, bytes: 0, failed: 0 })
    expect(await layered.uploaded('h-declined')).toBe(false)
    remote.layer.put = put
    await saveSample(layered, 'h-sent')
    await layered.drainUploads()
    expect(local.uploads.count).toBe(1)
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
    // And the re-run's save replaces the bad bytes there: held as fetched,
    // the key was never sent again and every machine rebuilt it (2026-10-24).
    expect(remote.puts).toBe(1)
  })

  // A plugin's shape is a boundary (item 252): the line names the call
  // and the shape, never "corrupt artifact" for a body that is a string.
  it('get() that resolves the wrong shape is named as the plugin bug and degraded to a miss', async () => {
    const errors: Error[] = []
    const shaped = {
      has: async () => ({}),
      get: async () => ({ body: 'abc', durationMs: 1 }),
      put: async () => {},
    } as unknown as RemoteCacheLayer
    const layered = layeredOver(local, shaped, { onRemoteError: (e) => errors.push(e) })
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
      has: async () => ({}),
      get: async () => ({ body: remote.store.get('h-old')!.slice(), durationMs: 1 }),
      put: async () => {},
    } as unknown as RemoteCacheLayer
    const layered = layeredOver(local, old, { onRemoteError: (e) => errors.push(e) })
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
  // to refuse. The third is a plugin checking bytes as they pass (a digest,
  // a signature) that refuses after the last one. Nothing may outlive the
  // miss in the cache dir.
  for (const cut of ['errors', 'ends early', 'fails its check at the end'] as const) {
    it(`get() degrades a Response body that ${cut} mid-artifact to a miss, leaving no temp`, async () => {
      await saveSample(makeLayered(), 'h-cut')
      const whole = remote.store.get('h-cut')!
      await wipeLocal()
      const errors: Error[] = []
      const cutting = {
        has: async () => ({}),
        get: async () => ({
          body: new Response(
            new ReadableStream<Uint8Array>({
              start(c) {
                if (cut === 'fails its check at the end') {
                  c.enqueue(whole)
                  c.error(new Error('signature does not match'))
                  return
                }
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
      const layered = layeredOver(local, cutting, { onRemoteError: (e) => errors.push(e) })
      expect(await layered.get('h-cut', { taskId: 'pkg#build', command: 'tsc' })).toBeNull()
      expect(errors).toHaveLength(1)
      expect(await local.has('h-cut')).toBeNull()
      expect((await readdir(cacheDir)).filter((f) => f.startsWith('h-cut'))).toEqual([])
    })
  }

  it('hasMany() that resolves an array is named and read as no batch info', async () => {
    const errors: Error[] = []
    const shaped = {
      has: async () => null,
      hasMany: async () => ['h-a'],
      get: async () => null,
      put: async () => {},
    } as unknown as RemoteCacheLayer
    const layered = layeredOver(local, shaped, { onRemoteError: (e) => errors.push(e) })
    expect(await layered.remoteHasMany(['h-a', 'h-b'])).toBeNull()
    expect(errors.map((e) => e.message)).toEqual([
      'probe of 2 artifacts failed: remote cache layer returned an invalid result: hasMany() resolved an array (expected a Map of the hashes present, or null) — a plugin bug, degraded to a miss',
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
    expect([...(present?.keys() ?? [])].sort()).toEqual(['h-a', 'h-c'])
    expect(remote.hasManyCalls).toBe(1)
  })

  it('remoteHasMany() returns null when the remote layer cannot batch', async () => {
    delete (remote.layer as { hasMany?: unknown }).hasMany
    const layered = makeLayered()
    expect(await layered.remoteHasMany(['h-a'])).toBeNull()
  })

  // Main f71b377 (2026-10-23): no batch answer, and the run planned as if
  // nothing were held. Asked key by key, the answer is complete; one
  // failed probe leaves it unknown, never a miss.
  it('remoteHasEach() asks a remote with no batch answer each key; a failure is no answer', async () => {
    delete (remote.layer as { hasMany?: unknown }).hasMany
    remote.store.set('h-a', new Uint8Array([1]))
    const layered = makeLayered()
    expect([...((await layered.remoteHasEach(['h-a', 'h-b'], 4)) ?? new Map()).keys()]).toEqual([
      'h-a',
    ])
    remote.failAll = true
    expect(await makeLayered().remoteHasEach(['h-a', 'h-b'], 4)).toBeNull()
  })

  it('remoteHasMany() returns null and reports the error when hasMany throws', async () => {
    remote.failAll = true
    const errors: Error[] = []
    const layered = makeLayered({ onRemoteError: (e) => errors.push(e) })
    expect(await layered.remoteHasMany(['h-a'])).toBeNull()
    expect(errors).toHaveLength(1)
  })

  it('remoteHasMany() returns null when remote reads are disabled by policy', async () => {
    const layered = layeredOver(local, remote.layer, {
      policy: { localRead: true, localWrite: true, remoteRead: false, remoteWrite: true },
      onRemoteError: () => {},
    })
    expect(await layered.remoteHasMany(['h-a'])).toBeNull()
    expect(remote.hasManyCalls).toBe(0)
  })

  it('prefetch() with remote reads off pulls nothing: no remote GET, false', async () => {
    // The policy gate on `prefetch` (`if (!this.policy.remoteRead) return
    // false`) survived the whole core suite with `remoteHasMany`'s twin
    // held (item 641): a `--cache-policy` that turns remote reads off must leave
    // the prefetch pass, not only the lazy get, off the wire.
    await saveSample(makeLayered(), 'h-off')
    await wipeLocal()
    const layered = layeredOver(local, remote.layer, {
      policy: { localRead: true, localWrite: true, remoteRead: false, remoteWrite: true },
      onRemoteError: () => {},
    })
    expect(await layered.prefetch('h-off', { taskId: 'pkg#build', command: 'x' })).toBe(false)
    expect(remote.gets).toBe(0)
  })

  it('get() with remote reads off is a plain local miss: no remote GET, null', async () => {
    await saveSample(makeLayered(), 'h-off')
    await wipeLocal()
    const layered = layeredOver(local, remote.layer, {
      policy: { localRead: true, localWrite: true, remoteRead: false, remoteWrite: true },
      onRemoteError: () => {},
    })
    expect(await layered.get('h-off', { taskId: 'pkg#build', command: 'x' })).toBeNull()
    expect(remote.gets).toBe(0)
  })

  it('save() with remote writes off uploads nothing: local entry, no remote PUT', async () => {
    // The write twin of the two read gates (item 641): `--cache-policy` turning
    // remote writes off must leave the upload pool idle, and the local
    // save still lands. Deleting the gate survived the whole core suite
    // (item 642).
    const layered = layeredOver(local, remote.layer, {
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
    const writeless = new Cache(
      path.join(workspaceRoot, '.vx', 'nowrite-pack'),
      {
        read: true,
        write: false,
      },
      undefined,
      undefined,
      undefined,
      undefined,
      TAR_STORE,
    )
    const layered = layeredOver(writeless, remote.layer, {
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

  it('getSaved() reads past a probe’s absence and the read policy', async () => {
    // An agent saves it after the run's probe found it absent.
    await saveSample(makeLayered(), 'h-agent')
    const bytes = remote.store.get('h-agent')!
    remote.store.delete('h-agent')
    await wipeLocal()
    const layered = makeLayered()
    expect((await layered.remoteHasMany(['h-agent']))?.size).toBe(0)
    remote.store.set('h-agent', bytes)
    expect(await layered.get('h-agent')).toBeNull()
    expect(await layered.getSaved('h-agent')).not.toBeNull()
    // `--force` reads no remote: an agent's entry still comes back.
    await wipeLocal()
    const forced = layeredOver(local, remote.layer, {
      policy: { localRead: false, localWrite: true, remoteRead: false, remoteWrite: true },
    })
    expect(await forced.get('h-agent')).toBeNull()
    expect(await forced.getSaved('h-agent')).not.toBeNull()
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

  it('a get() between a pull writing its row and the pull settling is a remote hit', async () => {
    // The row lands a tick before the pull settles: a get() then read it
    // as a local hit, so a remote hit said `cache-hit` (vx-cache's own
    // run test met it on a fast loopback).
    await saveSample(makeLayered(), 'h-tick')
    await wipeLocal()
    const layered = makeLayered()
    const written = Promise.withResolvers<void>()
    const ingest = local.ingest.bind(local)
    local.ingest = async (...a: Parameters<typeof ingest>) => {
      const r = await ingest(...a)
      written.resolve()
      await Bun.sleep(30)
      return r
    }
    try {
      const pull = layered.prefetch('h-tick', { taskId: 'pkg#build', command: 'echo produced' })
      await written.promise
      const hit = await layered.get('h-tick', { taskId: 'pkg#build', command: 'echo produced' })
      expect(hit?.source).toBe('remote')
      expect(await pull).toBe(true)
    } finally {
      local.ingest = ingest
    }
  })

  it('a get() while the batch probe is out GETs at once, not after the probe', async () => {
    // Waiting cost a remote hit two round-trips, the probe then the GET:
    // ~300 ms an up-to-date task on CI.
    await saveSample(makeLayered(), 'h-eager')
    await wipeLocal()
    const answer = Promise.withResolvers<Map<string, object>>()
    const layered = layeredOver(local, { ...remote.layer, hasMany: () => answer.promise })
    const probe = layered.remoteHasMany(['h-eager'])
    const hit = await layered.get('h-eager', { taskId: 'pkg#build', command: 'echo produced' })
    expect(hit?.source).toBe('remote')
    answer.resolve(new Map([['h-eager', {}]]))
    expect((await probe)?.size).toBe(1)
    expect(remote.gets).toBe(1)
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
    const saver = layeredOver(local, layer, { onRemoteError: () => {} })
    await saveSample(saver, 'h-meta')
    expect(metas).toEqual([{ durationMs: 5 }])
    await wipeLocal()
    const hit = await makeLayered().get('h-meta', { taskId: 'app#build', command: 'x' })
    expect(hit?.taskId).toBe('app#build')
  })

  it('has() with remote reads off never probes the remote', async () => {
    await saveSample(makeLayered(), 'h-probe')
    await wipeLocal()
    const layered = layeredOver(local, remote.layer, {
      policy: { localRead: true, localWrite: true, remoteRead: false, remoteWrite: true },
      onRemoteError: () => {},
    })
    remote.heads = 0
    expect(await layered.has('h-probe')).toBeNull()
    expect(remote.heads).toBe(0)
  })

  it('remoteHasMany() reads a hasMany() that resolves undefined as no batch info', async () => {
    const layered = layeredOver(
      local,
      { ...remote.layer, hasMany: async () => undefined as unknown as Map<string, never> },
      { onRemoteError: () => {} },
    )
    expect(await layered.remoteHasMany(['h1'])).toBeNull()
  })

  it.each([
    [3, 3],
    [undefined, networkConcurrency()],
  ])(
    'runs cache.concurrency.upload %p uploads at once (%p), and the next waits',
    async (cap, at) => {
      let release!: () => void
      remote.putGate = new Promise<void>((r) => (release = r))
      const layered = makeLayered(cap === undefined ? {} : { uploadConcurrency: cap })
      const outFile = path.join(projectDir, 'dist', 'out.txt')
      await mkdir(path.dirname(outFile), { recursive: true })
      for (let i = 0; i <= at; i++) {
        await writeFile(outFile, `produced-${i}`)
        await layered.save({
          hash: `h-pool-${i}`,
          projectDir,
          outputFiles: [outFile],
          entry: { taskId: 'pkg#build', command: 'x', durationMs: 1, stdout: '' },
        })
      }
      await Bun.sleep(0)
      expect(remote.puts).toBe(at)
      release()
      await layered.drainUploads()
      expect(remote.puts).toBe(at + 1)
    },
  )

  it('drainUploads() waits for an upload still running once the queue is empty', async () => {
    const gates = new Map<string, () => void>()
    const done: string[] = []
    const layered = layeredOver(local, {
      ...remote.layer,
      async put(hash) {
        await new Promise<void>((r) => gates.set(hash, r))
        done.push(hash)
      },
    })
    const outFile = path.join(projectDir, 'dist', 'out.txt')
    await mkdir(path.dirname(outFile), { recursive: true })
    for (const hash of ['h-a', 'h-b']) {
      await writeFile(outFile, hash)
      await layered.save({
        hash,
        projectDir,
        outputFiles: [outFile],
        entry: { taskId: 'pkg#build', command: 'x', durationMs: 1, stdout: '' },
      })
    }
    while (gates.size < 2) await Bun.sleep(1)
    let drained = false
    const drain = layered.drainUploads().then(() => (drained = true))
    gates.get('h-a')!()
    while (done.length < 1) await Bun.sleep(1)
    await Bun.sleep(5)
    expect(drained).toBe(false)
    gates.get('h-b')!()
    await drain
    expect(done).toEqual(['h-a', 'h-b'])
  })

  it('an onRemoteError that throws still degrades the call to a miss', async () => {
    remote.failAll = true
    const layered = makeLayered({
      onRemoteError: () => {
        throw new Error('sink broke')
      },
    })
    expect(await layered.get('h-sink')).toBeNull()
    expect(await layered.has('h-sink')).toBeNull()
  })

  it('an artifact gone between its ingest and the read is a miss, not a hit', async () => {
    await saveSample(makeLayered(), 'h-gone')
    await wipeLocal()
    const layered = makeLayered()
    const read = local.getIngested.bind(local)
    // A concurrent prune on a shared cache dir removes the artifact.
    spyOn(local, 'getIngested').mockImplementation(async (hash) => {
      removeStoredArtifact(local, hash)
      return read(hash)
    })
    expect(await layered.get('h-gone')).toBeNull()
  })

  it('key() is identical to local.key()', async () => {
    const layered = makeLayered()
    const input = {
      taskId: 'pkg#build',
      taskConfigHash: 'cfg',
      envValues: [] as Array<[string, string]>,
      inputFiles: [],
      workspaceRoot,
      upstreamHashes: [],
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
    // cache.concurrency.upload bounds sockets, not memory: a queued closure that
    // captured its own artifact keeps the WHOLE backlog resident, so peak
    // RSS scaled with total miss artifact bytes. Proving non-retention
    // WITHOUT an RSS assertion: stall the pool, save, then delete the local
    // artifacts. Bytes captured at save time would still upload; bytes read
    // at PUT time cannot. Deleting stands in for the documented racer, a
    // concurrent `vx cache clean`.
    let releasePut!: () => void
    remote.putGate = new Promise<void>((resolve) => {
      releasePut = resolve
    })
    const errors: Error[] = []
    const layered = makeLayered({ onRemoteError: (e) => errors.push(e), uploadConcurrency: 4 })

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

    // Remove the artifacts the still-queued uploads have not read yet. Only
    // the artifacts.
    for (const hash of queuedHashes) removeStoredArtifact(local, hash)

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
    // The path is a private name for the artifact, gone once the PUT ends.
    const layered = makeLayered()
    await saveSample(layered, 'h-file', true)
    const names = remote.putBodies.map((b) => (b as { name?: unknown }).name)
    expect(names).toHaveLength(1)
    expect(String(names[0]).startsWith(`${local.outputsPath('h-file')}.tmp-`)).toBe(true)
    expect(await readdir(cacheDir)).not.toContain(path.basename(String(names[0])))
  })

  it("an inline artifact's upload body is its bytes, read when the job runs", async () => {
    const layered = makeLayered()
    await saveSample(layered, 'h-inline')
    expect(isInline(local, 'h-inline')).toBe(true)
    expect(remote.putBodies).toHaveLength(1)
    expect(Buffer.from(await remote.putBodies[0]!.bytes())).toEqual(
      Buffer.from(storedArtifact(local, 'h-inline')!),
    )
  })

  // Test 9 of docs/design/cache-save-cpu-2026-10.md for the inline artifact;
  // the file's pin is a private link.
  for (const where of ['inline', 'file'] as const) {
    it(`a re-save of the key during an upload leaves every read of its ${where} body the same`, async () => {
      // A plugin reads its body twice (a digest pass, then the bytes); a
      // body opened by the live path read the re-save's bytes the second time.
      let midPut!: () => void
      const reading = new Promise<void>((resolve) => {
        midPut = resolve
      })
      let resume!: () => void
      const gate = new Promise<void>((resolve) => {
        resume = resolve
      })
      const reads: string[] = []
      const errors: Error[] = []
      const layered = layeredOver(
        local,
        {
          ...remote.layer,
          async put(_hash, body) {
            reads.push(Buffer.from(await body.bytes()).toString('hex'))
            midPut()
            await gate
            reads.push(Buffer.from(await body.bytes()).toString('hex'))
          },
        },
        { onRemoteError: (e) => errors.push(e) },
      )
      const outFile = path.join(projectDir, 'dist', 'out.txt')
      await mkdir(path.dirname(outFile), { recursive: true })
      const pad =
        where === 'file' ? crypto.getRandomValues(new Uint8Array(48 * 1024)) : new Uint8Array(0)
      const save = async (cache: Cache | LayeredCache, text: string) => {
        await writeFile(outFile, Buffer.concat([Buffer.from(text), pad]))
        await cache.save({
          hash: 'h-resave',
          projectDir,
          outputFiles: [outFile],
          entry: { taskId: 'pkg#build', command: 'c', durationMs: 1, stdout: '' },
        })
      }
      await save(layered, 'first')
      await reading
      expect(isInline(local, 'h-resave')).toBe(where === 'inline')
      const firstBytes = Buffer.from(storedArtifact(local, 'h-resave')!)
      // An entry is immutable, so only a writer that checked before the
      // first save landed (another process) re-saves the key: its row is
      // dropped here to stand for that race.
      indexDb(local).run('DELETE FROM entries WHERE hash = ?', ['h-resave'])
      indexDb(local).run('DELETE FROM artifacts WHERE hash = ?', ['h-resave'])
      await save(local, 'second, longer than the first')
      expect(Buffer.from(storedArtifact(local, 'h-resave')!)).not.toEqual(firstBytes)
      resume()
      await layered.drainUploads()
      expect(errors).toEqual([])
      expect(reads).toEqual([firstBytes.toString('hex'), firstBytes.toString('hex')])
    })
  }

  it('save() still packs in memory when local writes are disabled', async () => {
    // Control for the deferred read: with `--cache-policy=local:,remote:rw` there
    // is no on-disk artifact to read later, so those bytes MUST be captured
    // during save() while the task's outputs are still on disk. Must behave
    // identically before and after the deferral.
    const writeless = new Cache(
      path.join(workspaceRoot, '.vx', 'nowrite'),
      {
        read: false,
        write: false,
      },
      undefined,
      undefined,
      undefined,
      undefined,
      TAR_STORE,
    )
    try {
      const layered = layeredOver(writeless, remote.layer, { onRemoteError: () => {} })
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
    const layered = layeredOver(racy, remote.layer, { onRemoteError: () => {} })

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
      local = new Cache(cacheDir, undefined, undefined, undefined, undefined, undefined, TAR_STORE)
    }

    it('each call names its operation, its artifact and the endpoint', async () => {
      const errors: Error[] = []
      const causes = {
        has: new Error('HEAD said 500'),
        hasMany: new Error('POST said 502'),
        get: new Error('GET said 503'),
        put: new Error('PUT said 504'),
      }
      const layered = layeredOver(
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

    // The footer's `remote N✗ M⇡` counts tasks, and `vx last` names each
    // one's failure (2026-10-15): so a read's failure is the key's too.
    it("each failure lands on its task's key, read and write alike; a batch probe's on none", async () => {
      const layered = layeredOver(
        local,
        failing((call) => new Error(`${call} said 500`)),
        { onRemoteError: () => {} },
      )
      await layered.remoteHasMany(['h1', 'h2'])
      expect(await layered.get('h1')).toBeNull()
      await saveSample(layered, 'h-up')
      await layered.drainUploads()
      expect(local.traffic.inFlight).toBe(0)
      expect([...local.traffic.keys]).toEqual([
        ['h1', { uploading: 0, landed: false, failures: ['download: get said 500'] }],
        ['h-up', { uploading: 0, landed: false, failures: ['upload: put said 500'] }],
      ])
      closeAndReopen(layered)
    })

    it('an upload is in flight on its key until it lands', async () => {
      let land!: () => void
      const landed = new Promise<void>((resolve) => (land = resolve))
      const layered = layeredOver(local, {
        has: async () => null,
        get: async () => null,
        put: () => landed,
      })
      // saveSample drains, so it settles only once the PUT lands.
      const saving = saveSample(layered, 'h-up')
      while (local.traffic.inFlight === 0) await Bun.sleep(1)
      expect(local.traffic.inFlight).toBe(1)
      expect(local.traffic.keys.get('h-up')).toEqual({ uploading: 1, landed: false, failures: [] })
      land()
      await saving
      expect(local.traffic.inFlight).toBe(0)
      expect(local.traffic.keys.get('h-up')).toEqual({ uploading: 0, landed: true, failures: [] })
      closeAndReopen(layered)
    })

    it('one failure class is said once, and close() counts the requests held back', async () => {
      const errors: Error[] = []
      const layered = layeredOver(
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
      const layered = layeredOver(
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
      const layered = layeredOver(
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
        await layeredOver(
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
        const layered = layeredOver(
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
      // A query alone is stripped too: a token rides there without userinfo.
      expect(await said('https://cache.example.com/v1/cache?token=t0k')).toEqual([
        'probe h1 at https://cache.example.com/v1/cache failed: down',
      ])
      // Controls: a clean URL and a gRPC `host:port` print as given, and a
      // name no URL parser reads prints as given, never throws.
      expect(await said('cache.internal')).toEqual(['probe h1 at cache.internal failed: down'])
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
