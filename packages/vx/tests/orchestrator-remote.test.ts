// The remote-cache seam, end to end: core ships NO wire client
// (docs/modules/layered-cache.md), so every remote layer here is an injected
// `RunOptions.remoteCache` — an in-memory RemoteCacheLayer or a stub-HTTP
// one where observing the wire matters. Coverage carried over from the
// retired env-hatch (VX_REMOTE_CACHE_*) suites: the remote-hit e2e, the
// plan path's HEAD prediction, never-fail on a fully-broken remote,
// prefetch overlap + at-most-once, the codegen→consumer stability gate,
// --no-cache issuing no reads, and the local:,remote:rw in-memory pack.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { describe, expect, it, spyOn } from 'bun:test'
import { localWorkspaceSource, writeLocalWorkspace } from './helpers/local-workspace.js'
import {
  addProject,
  FORCE,
  makeWorkspace as makeFixture,
  silentLogger,
  TIMEOUT,
} from './helpers/orchestrator-fixture.js'
import { indexDb, Cache, LayeredCache, type RemoteCacheLayer } from '../src/cache/index.js'
import { ownRssHighWater } from '../src/exec/runner.js'
import { type RunSummaryRecord, type TelemetryRecord } from '../src/orchestrator/index.js'
import { LocalHistoryProvider } from '../src/history/index.js'
import { planRun, run } from './helpers/orchestrator.js'
import { pluginSource, writeEdges } from './helpers/plugin.js'
import { storedKeys } from './helpers/stored-artifact.js'
import { layeredOver } from './helpers/layered.js'

/**
 * A stub HTTP artifact ENDPOINT + the RemoteCacheLayer speaking to it —
 * for the cases where observing the WIRE matters (per-hash GET/HEAD
 * counts, concurrency overlap, a 500ing remote). The layer is
 * deliberately thin: LayeredCache owns dedup/degradation, so the stub
 * just translates.
 *
 * The endpoint is a `Request → Response` handler the layer calls
 * directly, NOT a listening socket. It is the same wire — methods,
 * statuses, headers, JSON bodies — with nothing to bind: a test that
 * opens a localhost port needs a sandbox grant that says a task in this
 * repo may serve the network, and nothing here actually needs one.
 */
interface ArtifactEndpoint {
  layer: RemoteCacheLayer
  store: Map<string, Uint8Array>
  /** Per-hash GET counts — pins at-most-once probing across prefetch + get. */
  getCounts: Map<string, number>
  /** Per-hash HEAD counts — the plan path's existence probes. */
  headCounts: Map<string, number>
  /** Per-hash PUT counts. */
  putCounts: Map<string, number>
  /** Every existence probe (batch and HEAD), set by a test: held for `delayMs`, or a 500. */
  probes: { delayMs: number; fail: boolean }
  /** Max GETs observed concurrently in flight. */
  getsInFlight: () => number
  /** Number of `POST /artifacts/batch` existence probes served. */
  batchCalls: () => number
}

function startArtifactEndpoint(opts?: {
  getLatencyMs?: number
  failAll?: boolean
  failBatch?: boolean
  /**
   * Hold every HEAD and GET until a batch probe arrives. The prefetch is
   * detached from execution: on a slow runner both tasks fetched lazily,
   * ran and saved locally before it asked the local index, which then held
   * every key, so no batch was sent (macOS CI, #3684).
   */
  holdUntilBatch?: boolean
}): ArtifactEndpoint {
  const store = new Map<string, Uint8Array>()
  const getCounts = new Map<string, number>()
  const headCounts = new Map<string, number>()
  const putCounts = new Map<string, number>()
  let inFlight = 0
  let maxInFlight = 0
  let batchCalls = 0
  const batched = Promise.withResolvers<void>()
  // Bounded: a run that never batches fails on `batchCalls`, not the timeout.
  const holdForBatch = async (): Promise<void> => {
    if (opts?.holdUntilBatch) await Promise.race([batched.promise, Bun.sleep(5_000)])
  }
  const probes = { delayMs: 0, fail: false }
  const probe = async (): Promise<Response | undefined> => {
    if (probes.delayMs > 0) await Bun.sleep(probes.delayMs)
    return probes.fail ? new Response('boom', { status: 500 }) : undefined
  }
  const handle = async (req: Request): Promise<Response> => {
    // Simulate a fully-broken remote: every request 500s. The run
    // must still succeed — remote cache is optional, errors degrade
    // to a miss.
    if (opts?.failAll) return new Response('boom', { status: 500 })
    const url = new URL(req.url)
    // Batch existence probe — one round-trip for many hashes.
    if (url.pathname === '/artifacts/batch' && req.method === 'POST') {
      batchCalls++
      batched.resolve()
      if (opts?.failBatch) return new Response('boom', { status: 500 })
      const held = await probe()
      if (held !== undefined) return held
      const { hashes } = (await req.json()) as { hashes: string[] }
      return Response.json({ present: hashes.filter((h) => store.has(h)) })
    }
    const m = url.pathname.match(/^\/artifacts\/([0-9a-f]+)$/)
    if (!m) return new Response('not found', { status: 404 })
    const hash = m[1]!
    if (req.method === 'PUT') {
      putCounts.set(hash, (putCounts.get(hash) ?? 0) + 1)
      store.set(hash, new Uint8Array(await req.arrayBuffer()))
      return new Response(null, { status: 200 })
    }
    if (req.method === 'HEAD') {
      await holdForBatch()
      const held = await probe()
      if (held !== undefined) return held
      headCounts.set(hash, (headCounts.get(hash) ?? 0) + 1)
      return new Response(null, { status: store.has(hash) ? 200 : 404 })
    }
    if (req.method === 'GET') {
      await holdForBatch()
      getCounts.set(hash, (getCounts.get(hash) ?? 0) + 1)
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      try {
        if (opts?.getLatencyMs) await Bun.sleep(opts.getLatencyMs)
        const body = store.get(hash)
        if (!body) return new Response('not found', { status: 404 })
        return new Response(body, { status: 200, headers: { 'x-duration': '12' } })
      } finally {
        inFlight--
      }
    }
    return new Response('method not allowed', { status: 405 })
  }
  const baseUrl = 'http://artifacts.invalid'
  const call = (url: string, init?: RequestInit): Promise<Response> =>
    handle(new Request(url, init))
  const layer: RemoteCacheLayer = {
    async has(hash) {
      const res = await call(`${baseUrl}/artifacts/${hash}`, { method: 'HEAD' })
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`HEAD ${hash} → ${res.status}`)
      return {}
    },
    async hasMany(hashes) {
      const res = await call(`${baseUrl}/artifacts/batch`, {
        method: 'POST',
        body: JSON.stringify({ hashes }),
      })
      if (!res.ok) throw new Error(`batch → ${res.status}`)
      const { present } = (await res.json()) as { present: string[] }
      return new Map(present.map((h) => [h, {}]))
    },
    async get(hash) {
      const res = await call(`${baseUrl}/artifacts/${hash}`)
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`GET ${hash} → ${res.status}`)
      const durationRaw = res.headers.get('x-duration')
      return {
        body: res,
        durationMs: durationRaw !== null ? Number(durationRaw) : undefined,
      }
    },
    async put(hash, body) {
      const res = await call(`${baseUrl}/artifacts/${hash}`, { method: 'PUT', body })
      if (!res.ok) throw new Error(`PUT ${hash} → ${res.status}`)
    },
  }
  return {
    layer,
    store,
    getCounts,
    headCounts,
    putCounts,
    probes,
    getsInFlight: () => maxInFlight,
    batchCalls: () => batchCalls,
  }
}

const BUILD_CONFIG = `
  export default {
    tasks: {
      build: {
        exec: { command: 'echo built > out.txt' },
        inputs: { files: ['src/**'] }, cache: { outputs: { files: ['out.txt'] } },
      },
    },
  }
`

// The usage round trip needs a peak on record, and the runner reports one
// only above its own footprint (a lighter child reads the parent's mark
// back on Linux), so this build holds 150 MB.
// A child lighter than this process records no peak RSS on Linux (item
// 170: `ru_maxrss` folds the parent's high-water mark), and the mark depends
// on which suites a shard ran first — a fixed 150 MB read as undefined once
// the deal put this file beside the 87k-edge graph (2026-09-16). Size the
// child from the mark, as `runner.test.ts` does.
const MB = 1024 * 1024
const heavyMb = (): number => Math.ceil(ownRssHighWater() / MB) + 200
const heavyBuildConfig = (mb: number): string => `
  export default {
    tasks: {
      build: {
        exec: { command: 'bun -e "const b = Buffer.alloc(${mb} * 1024 * 1024, 1); require(\\'fs\\').writeFileSync(\\'out.txt\\', \\'built\\'); console.log(b.length)"' },
        inputs: { files: ['src/**'] }, cache: { outputs: { files: ['out.txt'] } },
      },
    },
  }
`

describe('orchestrator e2e: injected remote cache (stub HTTP layer)', () => {
  it(
    'a run served entirely from the remote layer reports ok: true',
    async () => {
      const fixture = await makeFixture('vx-remote-e2e-')
      const remote = startArtifactEndpoint()
      try {
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: BUILD_CONFIG,
        })

        const first = await run({
          cwd: fixture.root,
          tasks: ['build'],
          log: silentLogger(fixture),
          remoteCache: remote.layer,
        })
        expect(first.ok).toBe(true)
        expect(first.outcomes[0]!.status).toBe('success')
        // Write-through upload landed on the remote.
        expect(remote.store.size).toBe(1)

        // Wipe the local cache so the only source of truth is the remote.
        await rm(path.join(fixture.root, '.vx', 'cache'), { recursive: true, force: true })

        const second = await run({
          cwd: fixture.root,
          tasks: ['build'],
          log: silentLogger(fixture),
          remoteCache: remote.layer,
        })
        expect(second.outcomes[0]!.status).toBe('cache-hit-remote')
        expect(second.ok).toBe(true)
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  // A probe's hit is a hint, not the artifact: the server may have dropped
  // it since, or a hit recorded by an earlier run may be stale. The GET's
  // 404 is the truth, and the task runs (2026-10-23).
  it(
    'a key hasMany reports held whose GET is 404 runs as a miss',
    async () => {
      const fixture = await makeFixture('vx-remote-stale-probe-')
      const remote = startArtifactEndpoint()
      try {
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: BUILD_CONFIG,
        })
        const opts = { cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) }
        expect((await run({ ...opts, remoteCache: remote.layer })).ok).toBe(true)
        await rm(path.join(fixture.root, '.vx', 'cache'), { recursive: true, force: true })
        await rm(path.join(fixture.root, 'packages', 'app', 'out.txt'))
        const [hash] = [...remote.store.keys()]
        remote.store.clear()
        remote.getCounts.clear()
        const asked: string[] = []
        const stale: RemoteCacheLayer = {
          ...remote.layer,
          async has() {
            return {}
          },
          async hasMany(hashes) {
            asked.push(...hashes)
            return new Map(hashes.map((h) => [h, {}]))
          },
        }
        const second = await run({ ...opts, remoteCache: stale })
        expect([
          second.ok,
          second.outcomes[0]!.status,
          asked.includes(hash!),
          remote.getCounts.get(hash!),
          await Bun.file(path.join(fixture.root, 'packages', 'app', 'out.txt')).text(),
          fixture.err.filter((l) => /remote|cache/i.test(l)),
        ]).toEqual([true, 'success', true, 1, 'built\n', []])
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  // `vx run --dry` and `vx run` are separate processes: what the
  // plan's probe found must reach the run through the index, never memory.
  // Only hits are kept, and the run's GETs wait on no probe (2026-10-23).
  it(
    'plan then run: the run trusts the hits the plan kept and GETs them before its probe answers',
    async () => {
      const fixture = await makeFixture('vx-remote-kept-hits-')
      const remote = startArtifactEndpoint()
      const cacheDir = path.join(fixture.root, '.vx', 'cache')
      try {
        for (const name of ['a', 'b', 'c'])
          await addProject(fixture.root, name, {
            files: { 'src/in.txt': name },
            config: BUILD_CONFIG,
          })
        const opts = { cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) }
        expect((await run({ ...opts, remoteCache: remote.layer })).ok).toBe(true)
        await rm(cacheDir, { recursive: true, force: true })
        await Bun.write(path.join(fixture.root, 'packages', 'c', 'src', 'in.txt'), 'v2')
        remote.getCounts.clear()
        const batches = remote.batchCalls()

        const planned = await planRun({ ...opts, remoteCache: remote.layer })
        expect(planned.tasks.map((t) => `${t.node.id} ${t.cacheStatus}`).sort()).toEqual([
          'a#build hit-remote',
          'b#build hit-remote',
          'c#build miss',
        ])
        const kept = (): string[] => {
          const local = new Cache(cacheDir)
          try {
            return (
              indexDb(local).query('SELECT hash FROM remote_hits').all() as Array<{
                hash: string
              }>
            )
              .map((r) => r.hash)
              .sort()
          } finally {
            local.close()
          }
        }
        // Hits only: c's miss is no row.
        expect(kept()).toEqual(
          planned.tasks
            .filter((t) => t.cacheStatus === 'hit-remote')
            .map((t) => t.hash)
            .sort(),
        )

        let answeredAt = Infinity
        const gets: number[] = []
        remote.probes.delayMs = 400
        const timed: RemoteCacheLayer = {
          ...remote.layer,
          async hasMany(hashes) {
            const found = await remote.layer.hasMany!(hashes)
            answeredAt = performance.now()
            return found
          },
          get(hash) {
            gets.push(performance.now())
            return remote.layer.get(hash)
          },
        }
        const second = await run({ ...opts, remoteCache: timed })
        expect(second.outcomes.map((o) => `${o.node.id} ${o.status}`).sort()).toEqual([
          'a#build cache-hit-remote',
          'b#build cache-hit-remote',
          'c#build success',
        ])
        // One probe for the plan, one background refresh for the run, and
        // no HEAD; each key fetched once, before the refresh answered: c's
        // lookup waits on no probe, so its miss is one GET.
        expect(remote.batchCalls() - batches).toBe(2)
        expect(remote.headCounts.size).toBe(0)
        expect([...remote.getCounts.values()]).toEqual([1, 1, 1])
        expect(gets.filter((t) => t < answeredAt)).toHaveLength(3)
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'a kept hit the server dropped runs as a miss and leaves the index',
    async () => {
      const fixture = await makeFixture('vx-remote-kept-gone-')
      const remote = startArtifactEndpoint()
      const cacheDir = path.join(fixture.root, '.vx', 'cache')
      try {
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: BUILD_CONFIG,
        })
        const opts = { cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) }
        expect((await run({ ...opts, remoteCache: remote.layer })).ok).toBe(true)
        await rm(cacheDir, { recursive: true, force: true })
        await rm(path.join(fixture.root, 'packages', 'app', 'out.txt'))
        await planRun({ ...opts, remoteCache: remote.layer })
        remote.store.clear()
        // A probe that still says held: only the GET's 404 is the truth.
        const stale: RemoteCacheLayer = {
          ...remote.layer,
          async hasMany(hashes) {
            return new Map(hashes.map((h) => [h, {}]))
          },
        }
        const second = await run({ ...opts, remoteCache: stale })
        const local = new Cache(cacheDir)
        let rows: unknown[]
        try {
          rows = indexDb(local).query('SELECT hash FROM remote_hits').all()
        } finally {
          local.close()
        }
        expect([
          second.ok,
          second.outcomes[0]!.status,
          await Bun.file(path.join(fixture.root, 'packages', 'app', 'out.txt')).text(),
          rows,
        ]).toEqual([true, 'success', 'built\n', []])
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  // A local save stores the masked command (L-11), but a remote hit's
  // ingest wrote the one the lookup carried, raw: the token a config
  // inlined sat in cache.db, where `vx why` reads it (L-27).
  it(
    'a remote hit stores the command with its secret masked',
    async () => {
      const fixture = await makeFixture('vx-remote-mask-')
      const remote = startArtifactEndpoint()
      try {
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: `
            export default {
              tasks: {
                build: {
                  exec: {
                    command: 'echo tok-l27-secret > /dev/null; echo built > out.txt',
                    env: { define: { L27_TOKEN: 'tok-l27-secret' }, secret: ['L27_TOKEN'] },
                  },
                  inputs: { files: ['src/**'] }, cache: { outputs: { files: ['out.txt'] } },
                },
              },
            }
          `,
        })
        const opts = {
          cwd: fixture.root,
          tasks: ['build'],
          log: silentLogger(fixture),
          remoteCache: remote.layer,
        }
        expect((await run(opts)).outcomes[0]!.status).toBe('success')
        await rm(path.join(fixture.root, '.vx', 'cache'), { recursive: true, force: true })
        expect((await run(opts)).outcomes[0]!.status).toBe('cache-hit-remote')
        const db = new Database(path.join(fixture.root, '.vx', 'cache', 'cache.db'), {
          readonly: true,
        })
        const stored = db
          .query<{ command: string }, []>('SELECT command FROM entries')
          .all()
          .map((r) => r.command)
        db.close()
        expect(stored).toEqual(['echo *** > /dev/null; echo built > out.txt'])
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  for (const batches of [true, false]) {
    it(
      `planRun (--dry) predicts hit-remote ${batches ? 'from one hasMany' : 'per key with has when the batch fails'}: no download, no ingest`,
      async () => {
        const fixture = await makeFixture('vx-remote-e2e-')
        const remote = startArtifactEndpoint({ failBatch: !batches })
        try {
          await addProject(fixture.root, 'app', {
            files: { 'src/in.txt': 'v1' },
            config: BUILD_CONFIG,
          })

          // Populate the remote, then wipe local so remote is the only source.
          const first = await run({
            cwd: fixture.root,
            tasks: ['build'],
            log: silentLogger(fixture),
            remoteCache: remote.layer,
          })
          expect(first.ok).toBe(true)
          expect(remote.store.size).toBe(1)
          await rm(path.join(fixture.root, '.vx', 'cache'), { recursive: true, force: true })
          remote.getCounts.clear()
          remote.headCounts.clear()
          const batchesBefore = remote.batchCalls()

          const plan = await planRun({
            cwd: fixture.root,
            tasks: ['build'],
            remoteCache: remote.layer,
          })
          expect(plan.tasks).toHaveLength(1)
          expect(plan.tasks[0]!.cacheStatus).toBe('hit-remote')

          // An existence probe only: no GET fired, nothing was ingested
          // into the (freshly recreated) local cache.
          expect([...remote.getCounts.values()]).toEqual([])
          expect({
            batch: remote.batchCalls() - batchesBefore,
            heads: [...remote.headCounts.values()],
          }).toEqual({ batch: 1, heads: batches ? [] : [1] })
          const cacheDir = path.join(fixture.root, '.vx', 'cache')
          expect(storedKeys(cacheDir)).toEqual([])
        } finally {
          await rm(fixture.root, { recursive: true, force: true })
        }
      },
      TIMEOUT,
    )
  }

  it(
    'a remote that 500s on every request never fails the run (optional cache degrades to miss)',
    async () => {
      // Point at a fully-broken remote: GET, PUT, and the prefetch
      // probe all 500. Nothing may escalate to a run failure.
      const fixture = await makeFixture('vx-remote-e2e-')
      const broken = startArtifactEndpoint({ failAll: true })
      try {
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: BUILD_CONFIG,
        })
        // Cold run: prefetch GET 500s → miss → executes → write-through
        // PUT 500s → swallowed. Run succeeds.
        const first = await run({
          cwd: fixture.root,
          tasks: ['build'],
          log: silentLogger(fixture),
          remoteCache: broken.layer,
        })
        expect(first.ok).toBe(true)
        expect(first.outcomes[0]!.status).toBe('success')
        // Warm run: local hit (remote never contributed). Still ok.
        const second = await run({
          cwd: fixture.root,
          tasks: ['build'],
          log: silentLogger(fixture),
          remoteCache: broken.layer,
        })
        expect(second.ok).toBe(true)
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'a remote-served run issues AT MOST ONE GET per task key (prefetch + execute share it)',
    async () => {
      const fixture = await makeFixture('vx-remote-e2e-')
      // Two independent (no-dep) tasks so both prefetch + execute, and
      // both are stable keys (no upstream outputs feed their inputs).
      for (const name of ['a', 'b']) {
        await addProject(fixture.root, name, {
          files: { 'src/in.txt': `v-${name}` },
          config: BUILD_CONFIG,
        })
      }
      const seed = startArtifactEndpoint()
      try {
        // Warm the remote (and wipe local) so the second run is fully
        // remote-served — both prefetch AND execute-task want each key.
        await run({
          cwd: fixture.root,
          tasks: ['build'],
          log: silentLogger(fixture),
          remoteCache: seed.layer,
        })
        expect(seed.store.size).toBe(2)
        await rm(path.join(fixture.root, '.vx', 'cache'), { recursive: true, force: true })

        const remote = startArtifactEndpoint({ getLatencyMs: 40 })
        // Carry over the warmed artifacts to the latency server.
        for (const [h, b] of seed.store) remote.store.set(h, b)
        try {
          const second = await run({
            cwd: fixture.root,
            tasks: ['build'],
            log: silentLogger(fixture),
            remoteCache: remote.layer,
          })
          expect(second.ok).toBe(true)
          // Both tasks served from remote.
          expect(second.outcomes.filter((o) => o.status === 'cache-hit-remote')).toHaveLength(2)
          // The crux: exactly one GET per key despite prefetch AND
          // execute-task both wanting it. If the inflight de-dup were
          // removed this would be 2 per hash.
          for (const [, n] of remote.getCounts) expect(n).toBe(1)
          // Overlap: both prefetches were in flight at the same time —
          // their latency overlapped instead of serializing.
          expect(remote.getsInFlight()).toBeGreaterThanOrEqual(2)
        } finally {
        }
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'a batch-capable remote is probed ONCE and fetches only the hits',
    async () => {
      const fixture = await makeFixture('vx-remote-e2e-')
      // Two independent stable-key tasks; seed only ONE remotely so the
      // other is a genuine remote miss on the warm run.
      for (const name of ['a', 'b']) {
        await addProject(fixture.root, name, {
          files: { 'src/in.txt': `v-${name}` },
          config: BUILD_CONFIG,
        })
      }
      const seed = startArtifactEndpoint()
      try {
        await run({
          cwd: fixture.root,
          tasks: ['build'],
          log: silentLogger(fixture),
          remoteCache: seed.layer,
        })
        expect(seed.store.size).toBe(2)
        const [presentHash, absentHash] = [...seed.store.keys()] as [string, string]
        await rm(path.join(fixture.root, '.vx', 'cache'), { recursive: true, force: true })

        const remote = startArtifactEndpoint({ holdUntilBatch: true })
        // Carry over ONLY one artifact — the other stays a remote miss.
        remote.store.set(presentHash, seed.store.get(presentHash)!)
        try {
          const second = await run({
            cwd: fixture.root,
            tasks: ['build'],
            log: silentLogger(fixture),
            remoteCache: remote.layer,
          })
          expect(second.ok).toBe(true)
          // ONE batch probe covered BOTH stable keys — not two HEADs.
          expect(remote.batchCalls()).toBe(1)
          // Exactly one task was served from remote, the other executed.
          expect(second.outcomes.filter((o) => o.status === 'cache-hit-remote')).toHaveLength(1)
          // The hit was fetched exactly once. The miss is never fetched more
          // than once (batch + lazy get share the in-flight map); when the
          // batch verdict lands before the task's probe it fires ZERO GETs —
          // that skip is pinned deterministically in the LayeredCache unit
          // suite (markRemoteAbsent → get → no remote GET).
          expect(remote.getCounts.get(presentHash)).toBe(1)
          expect(remote.getCounts.get(absentHash) ?? 0).toBeLessThanOrEqual(1)
        } finally {
        }
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  // `--force` re-executes and restores nothing, yet a key the remote holds
  // is the same bytes by the immutable contract: re-uploading it was a PUT
  // per task for nothing (2026-10-15).
  describe('--force', () => {
    const seeded = async (opts?: { failBatch?: boolean }) => {
      const fixture = await makeFixture('vx-remote-force-')
      for (const name of ['a', 'b']) {
        await addProject(fixture.root, name, {
          files: { 'src/in.txt': `v-${name}` },
          config: BUILD_CONFIG,
        })
      }
      const remote = startArtifactEndpoint(opts)
      await run({
        cwd: fixture.root,
        tasks: ['build'],
        log: silentLogger(fixture),
        remoteCache: remote.layer,
      })
      expect(remote.store.size).toBe(2)
      remote.putCounts.clear()
      remote.getCounts.clear()
      return { fixture, remote }
    }

    it(
      'a key the remote holds is not uploaded again, from one batch probe',
      async () => {
        const { fixture, remote } = await seeded()
        try {
          const batches = remote.batchCalls()
          const forced = await run({
            cwd: fixture.root,
            tasks: ['build'],
            log: silentLogger(fixture),
            remoteCache: remote.layer,
            cacheFlags: { force: true },
          })
          expect(forced.ok).toBe(true)
          expect(forced.outcomes.map((o) => o.status).sort()).toEqual(['success', 'success'])
          expect(remote.putCounts.size).toBe(0)
          expect(remote.batchCalls() - batches).toBe(1)
          expect(remote.getCounts.size).toBe(0)
        } finally {
          await rm(fixture.root, { recursive: true, force: true })
        }
      },
      TIMEOUT,
    )

    it(
      'a key the remote lacks is uploaded',
      async () => {
        const { fixture, remote } = await seeded()
        try {
          const [gone] = [...remote.store.keys()] as [string]
          remote.store.delete(gone)
          await run({
            cwd: fixture.root,
            tasks: ['build'],
            log: silentLogger(fixture),
            remoteCache: remote.layer,
            cacheFlags: { force: true },
          })
          expect([...remote.putCounts.entries()]).toEqual([[gone, 1]])
        } finally {
          await rm(fixture.root, { recursive: true, force: true })
        }
      },
      TIMEOUT,
    )

    it(
      'a failed batch asks each key before its upload',
      async () => {
        const { fixture, remote } = await seeded({ failBatch: true })
        try {
          const warn = spyOn(process.stderr, 'write').mockImplementation(() => true)
          try {
            await run({
              cwd: fixture.root,
              tasks: ['build'],
              log: silentLogger(fixture),
              remoteCache: remote.layer,
              cacheFlags: { force: true },
            })
          } finally {
            warn.mockRestore()
          }
          // The batch failed; each upload asks for its own key instead.
          expect(remote.putCounts.size).toBe(0)
          expect(remote.headCounts.size).toBe(2)
        } finally {
          await rm(fixture.root, { recursive: true, force: true })
        }
      },
      TIMEOUT,
    )

    it(
      'a probe that fails uploads, as before',
      async () => {
        const { fixture, remote } = await seeded()
        remote.probes.fail = true
        try {
          const warn = spyOn(process.stderr, 'write').mockImplementation(() => true)
          try {
            await run({
              cwd: fixture.root,
              tasks: ['build'],
              log: silentLogger(fixture),
              remoteCache: remote.layer,
              cacheFlags: { force: true },
            })
          } finally {
            warn.mockRestore()
          }
          expect([...remote.putCounts.values()]).toEqual([1, 1])
        } finally {
          await rm(fixture.root, { recursive: true, force: true })
        }
      },
      TIMEOUT,
    )

    it(
      'a slow probe holds no task: only the upload decision waits for it (2026-10-15)',
      async () => {
        const { fixture, remote } = await seeded()
        remote.probes.delayMs = 2_000
        try {
          const done: number[] = []
          const started = performance.now()
          await run({
            cwd: fixture.root,
            tasks: ['build'],
            log: {
              ...silentLogger(fixture),
              taskComplete: () => void done.push(performance.now() - started),
            },
            remoteCache: remote.layer,
            cacheFlags: { force: true },
          })
          const ended = performance.now() - started
          expect({
            tasks: done.length,
            heldByProbe: done.some((ms) => ms >= 2_000),
            uploadsWaited: ended >= 2_000,
            puts: remote.putCounts.size,
          }).toEqual({ tasks: 2, heldByProbe: false, uploadsWaited: true, puts: 0 })
        } finally {
          await rm(fixture.root, { recursive: true, force: true })
        }
      },
      TIMEOUT,
    )

    it(
      'the local entry under the same key is kept, not rewritten',
      async () => {
        const { fixture, remote } = await seeded()
        try {
          const db = () => new Database(path.join(fixture.root, '.vx', 'cache', 'cache.db'))
          const before = db()
          const stored = before.query('SELECT hash, accessed_at FROM entries ORDER BY hash').all()
          before.close()
          await Bun.sleep(20)
          await run({
            cwd: fixture.root,
            tasks: ['build'],
            log: silentLogger(fixture),
            remoteCache: remote.layer,
            cacheFlags: { force: true },
          })
          const after = db()
          expect(after.query('SELECT hash, accessed_at FROM entries ORDER BY hash').all()).toEqual(
            stored,
          )
          after.close()
        } finally {
          await rm(fixture.root, { recursive: true, force: true })
        }
      },
      TIMEOUT,
    )
  })

  it(
    'codegen→consumer (inputs glob over a sibling output) stays correct without prefetch',
    async () => {
      // The consumer task reads `**/*` (which includes the codegen
      // output `generated.txt`), so its key is preliminary until codegen
      // runs — it must NOT be prefetched, but the lazy read-through must
      // still produce a correct remote hit on the warm run.
      const fixture = await makeFixture('vx-remote-e2e-')
      const remote = startArtifactEndpoint()
      try {
        await addProject(fixture.root, 'pkg', {
          files: { 'src/seed.txt': 'seed' },
          config: `
            export default {
              tasks: {
                codegen: {
                  exec: { command: 'echo gen > generated.txt' },
                  inputs: { files: ['src/**'] }, cache: { outputs: { files: ['generated.txt'] } },
                },
                build: {
                  dependsOn: ['codegen'],
                  exec: { command: 'cat generated.txt > out.txt' },
                  inputs: { files: ['**/*'], tasks: [] }, cache: { outputs: { files: ['out.txt'] } },
                },
              },
            }
          `,
        })

        await writeLocalWorkspace(fixture.root)
        const first = await run({
          cwd: fixture.root,
          tasks: ['build'],
          log: silentLogger(fixture),
          remoteCache: remote.layer,
        })
        expect(first.ok).toBe(true)
        await rm(path.join(fixture.root, '.vx', 'cache'), { recursive: true, force: true })

        const second = await run({
          cwd: fixture.root,
          tasks: ['build'],
          log: silentLogger(fixture),
          remoteCache: remote.layer,
        })
        expect(second.ok).toBe(true)
        // Both tasks are remote hits on the warm run — the consumer's
        // key resolves correctly via lazy read-through even though it was
        // skipped by prefetch.
        const statuses = second.outcomes.map((o) => `${o.node.taskName}:${o.status}`).sort()
        expect(statuses).toEqual(['build:cache-hit-remote', 'codegen:cache-hit-remote'])
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    '--no-cache issues no remote GET (no prefetch, no read-through)',
    async () => {
      const fixture = await makeFixture('vx-remote-e2e-')
      const remote = startArtifactEndpoint()
      try {
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: BUILD_CONFIG,
        })

        const res = await run({
          cwd: fixture.root,
          tasks: ['build'],
          cache: { localRead: false, localWrite: false, remoteRead: false, remoteWrite: false },
          log: silentLogger(fixture),
          remoteCache: remote.layer,
        })
        expect(res.ok).toBe(true)
        expect(res.outcomes[0]!.status).toBe('success')
        expect([...remote.getCounts.values()]).toHaveLength(0)
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'remote reads off: the prefetch pass never starts — no probe, no pull, no key derived for it',
    async () => {
      // The layer refuses both calls under this policy (layered-cache.test.ts,
      // item 641), so the wire is quiet either way; the orchestrator's own
      // gate is what spares the pass — deriving every stable key to feed a
      // layer that answers null. Deleting it survived the whole core suite
      // (item 643); the calls that gate removes are the observable.
      const fixture = await makeFixture('vx-remote-e2e-')
      const remote = startArtifactEndpoint()
      const hasMany = spyOn(LayeredCache.prototype, 'remoteHasMany')
      const prefetch = spyOn(LayeredCache.prototype, 'prefetch')
      try {
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: BUILD_CONFIG,
        })
        const res = await run({
          cwd: fixture.root,
          tasks: ['build'],
          cache: { localRead: true, localWrite: true, remoteRead: false, remoteWrite: true },
          log: silentLogger(fixture),
          remoteCache: remote.layer,
        })
        expect(res.ok).toBe(true)
        expect(hasMany).toHaveBeenCalledTimes(0)
        expect(prefetch).toHaveBeenCalledTimes(0)
        expect([...remote.getCounts.values()]).toHaveLength(0)
      } finally {
        hasMany.mockRestore()
        prefetch.mockRestore()
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'the batch probe decides the pulls: the misses are pre-marked, only the hits enter the pool',
    async () => {
      // Two things ride the batch answer and nothing held either (item
      // 643): the misses are pre-marked absent, so a task's lazy get on a
      // local miss issues no remote GET; and only the hits enter the pull
      // pool, so the pass itself GETs nothing that would 404. Both are
      // pinned on the layer's calls, which do not race: the pass races
      // execution, and a GET count for the miss is a claim about which
      // lands first (the gate saw the warm run's own 404 counted against
      // the cold run's one fetch). The hit's count holds — one pull per
      // hash is the in-flight map's rule — and the miss's is bounded the
      // way the row above bounds it. The pre-mark's list is `b` because
      // the batch is answered in-process on the next turn, before any
      // child can exit and save: a 150 ms delay in the stub's handler
      // is what it takes to make the verdict see b's own upload.
      const fixture = await makeFixture('vx-remote-e2e-')
      const remote = startArtifactEndpoint()
      const absent = spyOn(LayeredCache.prototype, 'markRemoteAbsent')
      const prefetch = spyOn(LayeredCache.prototype, 'prefetch')
      try {
        await addProject(fixture.root, 'a', {
          files: { 'src/in.txt': 'a' },
          config: BUILD_CONFIG,
        })
        await writeEdges(fixture.root, { b: ['a'] })
        await addProject(fixture.root, 'b', {
          files: { 'src/in.txt': 'b' },
          config: `
            export default {
              tasks: {
                build: {
                  dependsOn: ['^build'],
                  exec: { command: 'echo built > out.txt' },
                  inputs: { files: ['src/**'] }, cache: { outputs: { files: ['out.txt'] } },
                },
              },
            }
          `,
        })
        // Warm the remote with a's artifact only.
        const warm = await run({
          cwd: fixture.root,
          tasks: ['build'],
          projects: ['a'],
          log: silentLogger(fixture),
          remoteCache: remote.layer,
        })
        expect(warm.ok).toBe(true)
        expect(remote.store.size).toBe(1)
        await rm(path.join(fixture.root, '.vx', 'cache'), { recursive: true, force: true })
        remote.getCounts.clear()
        remote.headCounts.clear()
        const batches = remote.batchCalls()
        absent.mockClear()
        prefetch.mockClear()

        const res = await run({
          cwd: fixture.root,
          tasks: ['build'],
          log: silentLogger(fixture),
          remoteCache: remote.layer,
        })
        expect(res.ok).toBe(true)
        const byId = new Map(res.outcomes.map((o) => [o.node.id, o]))
        expect(byId.get('a#build')!.status).toBe('cache-hit-remote')
        expect(byId.get('b#build')!.status).toBe('success')
        const aHash = byId.get('a#build')!.hash!
        const bHash = byId.get('b#build')!.hash!
        expect(absent.mock.calls.map((c) => [...c[0]])).toEqual([[bHash]])
        // a's lazy pull may land before the pass asks the local store,
        // which then drops a too. The miss enters once at most: as the
        // first pool's worth, pulled before the probe answers.
        expect(prefetch.mock.calls.filter((c) => c[0] === bHash).length).toBeLessThanOrEqual(1)
        expect(remote.getCounts.get(aHash)).toBe(1)
        expect(remote.getCounts.get(bHash) ?? 0).toBeLessThanOrEqual(1)
        // One existence probe a run: no task's lookup asks the remote again
        // whether it holds a key (2026-10-23).
        expect(remote.batchCalls() - batches).toBe(1)
        expect(remote.headCounts.size).toBe(0)
      } finally {
        absent.mockRestore()
        prefetch.mockRestore()
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'one prefetch that rejects does not end the pump: the hashes behind it are still warmed',
    async () => {
      // `LayeredCache.prefetch` swallows the remote's own throws, but its
      // local-first probe runs before that catch, so a local-store refusal
      // can still reject one pull. The pump's per-hash catch is what keeps
      // that from ending the pass for every hash queued behind it (the
      // outer catch only spares the handle). One worker, two present
      // hashes, the first pull rejecting: both must reach the layer.
      const fixture = await makeFixture('vx-remote-e2e-')
      const remote = startArtifactEndpoint()
      const real = LayeredCache.prototype.prefetch
      let calls = 0
      const prefetch = spyOn(LayeredCache.prototype, 'prefetch').mockImplementation(function (
        this: LayeredCache,
        ...a: Parameters<typeof real>
      ) {
        calls++
        if (calls === 1) return Promise.reject(new Error('local store refused the probe'))
        return real.apply(this, a)
      })
      try {
        await addProject(fixture.root, 'a', { files: { 'src/in.txt': 'a' }, config: BUILD_CONFIG })
        await addProject(fixture.root, 'c', { files: { 'src/in.txt': 'c' }, config: BUILD_CONFIG })
        prefetch.mockClear()
        calls = 0
        const warm = await run({
          cwd: fixture.root,
          tasks: ['build'],
          log: silentLogger(fixture),
          remoteCache: remote.layer,
        })
        expect(warm.ok).toBe(true)
        expect(remote.store.size).toBe(2)
        await rm(path.join(fixture.root, '.vx', 'cache'), { recursive: true, force: true })

        calls = 0
        // The local store holds nothing for the pass: a task's lazy pull
        // landing first would drop its hash before the pump.
        const held = spyOn(LayeredCache.prototype, 'localHasMany').mockResolvedValue(new Set())
        const res = await run({
          cwd: fixture.root,
          tasks: ['build'],
          concurrency: 1,
          log: silentLogger(fixture),
          remoteCache: remote.layer,
        })
        expect(res.ok).toBe(true)
        held.mockRestore()
        expect(calls).toBe(2)
        expect(res.outcomes.map((o) => o.status).sort()).toEqual([
          'cache-hit-remote',
          'cache-hit-remote',
        ])
      } finally {
        prefetch.mockRestore()
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    '--dry reads the same clamped policy the run will use',
    async () => {
      const fixture = await makeFixture('vx-remote-e2e-')
      const remote = startArtifactEndpoint()
      try {
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: BUILD_CONFIG,
        })
        // Remote axes only — and NO remote layer to serve them. run()
        // clamps those axes off, so caching is entirely disabled; the plan
        // must say so instead of predicting a miss that "would be stored".
        const remoteOnly = {
          localRead: false,
          localWrite: false,
          remoteRead: true,
          remoteWrite: true,
        }
        const planned = await planRun({
          cwd: fixture.root,
          tasks: ['build'],
          cache: remoteOnly,
          log: silentLogger(fixture),
        })
        expect(planned.tasks.map((t) => t.cacheStatus)).toEqual(['no-cache'])

        // Control: the SAME policy WITH a remote layer keeps its remote
        // axes, so the plan probes and reports a genuine miss. The clamp
        // must not swallow a policy the run will really honour.
        const withRemote = await planRun({
          cwd: fixture.root,
          tasks: ['build'],
          cache: remoteOnly,
          log: silentLogger(fixture),
          remoteCache: remote.layer,
        })
        expect(withRemote.tasks.map((t) => t.cacheStatus)).toEqual(['miss'])
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'a run record that cannot be written is a status line; the cache handle still closes',
    async () => {
      const fixture = await makeFixture('vx-remote-e2e-')
      const remote = startArtifactEndpoint()
      // `recordRunBundle` is the last write between the final task and the
      // normal close. A throw there (SQLITE_BUSY past the busy_timeout, a
      // full disk) once skipped close() entirely — leaking the SQLite handle
      // and, with it, the run's deferred accessed_at flush, so an LRU
      // `vx cache clean` could evict entries this run just hit — and then
      // failed the finished run with a stack. History is observability: the
      // verdict stands, the line says what was lost, and close() still runs.
      const closeSpy = spyOn(Cache.prototype, 'close')
      const recordSpy = spyOn(Cache.prototype, 'recordRunBundle').mockImplementation(() => {
        throw new Error('SQLITE_BUSY: database is locked')
      })
      try {
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: BUILD_CONFIG,
        })
        const r = await run({
          cwd: fixture.root,
          tasks: ['build'],
          log: silentLogger(fixture),
          remoteCache: remote.layer,
        })
        expect(r.ok).toBe(true)
        expect(fixture.log).toContain(
          '[vx] run history not recorded: SQLITE_BUSY: database is locked — the verdict above stands',
        )
        expect(closeSpy).toHaveBeenCalled()
      } finally {
        recordSpy.mockRestore()
        closeSpy.mockRestore()
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'local:,remote:rw uploads to remote even with local writes disabled (packs bytes in memory)',
    async () => {
      const fixture = await makeFixture('vx-remote-e2e-')
      const remote = startArtifactEndpoint()
      try {
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: BUILD_CONFIG,
        })

        // local: (no read, no write), remote:rw — there is NO local
        // artifact to read off disk, so the upload path must pack the
        // bytes in memory.
        const res = await run({
          cwd: fixture.root,
          tasks: ['build'],
          cache: { localRead: false, localWrite: false, remoteRead: true, remoteWrite: true },
          log: silentLogger(fixture),
          remoteCache: remote.layer,
        })
        expect(res.ok).toBe(true)
        expect(res.outcomes[0]!.status).toBe('success')
        // The artifact landed on the remote despite no local write.
        expect(remote.store.size).toBe(1)
        // No local cache.db entry was written (local writes were off);
        // the next run with remote reads on serves the artifact from the
        // remote layer.
        await rm(path.join(fixture.root, '.vx', 'cache'), { recursive: true, force: true })
        const second = await run({
          cwd: fixture.root,
          tasks: ['build'],
          log: silentLogger(fixture),
          remoteCache: remote.layer,
        })
        expect(second.outcomes[0]!.status).toBe('cache-hit-remote')
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'local:,remote:rw HITS from the remote on the next run — it does not re-execute forever',
    async () => {
      // The remote read-through ingests the artifact into local, then read
      // it back through the LOCAL READ GATE — which `local:` turns off. So
      // every run downloaded the artifact, threw the hit away, re-executed
      // and re-uploaded: unbounded work + unbounded egress for the exact
      // policy string docs/cli.md documents. The gate means "don't serve
      // hits from the PRE-EXISTING local cache", not "discard what you just
      // downloaded".
      const fixture = await makeFixture('vx-remote-e2e-')
      const remote = startArtifactEndpoint()
      const policy = { localRead: false, localWrite: false, remoteRead: true, remoteWrite: true }
      try {
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: BUILD_CONFIG,
        })

        const first = await run({
          cwd: fixture.root,
          tasks: ['build'],
          cache: policy,
          log: silentLogger(fixture),
          remoteCache: remote.layer,
        })
        expect(first.outcomes[0]!.status).toBe('success')
        expect(remote.store.size).toBe(1)

        const putsAfterFirst = [...remote.store.keys()]
        const second = await run({
          cwd: fixture.root,
          tasks: ['build'],
          cache: policy,
          log: silentLogger(fixture),
          remoteCache: remote.layer,
        })
        // The whole point: a HIT, sourced from the remote.
        expect(second.outcomes[0]!.status).toBe('cache-hit-remote')
        expect(second.ok).toBe(true)
        // …and therefore no second upload of bytes the remote already holds.
        expect([...remote.store.keys()]).toEqual(putsAfterFirst)
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  // turborepo#3127 asked `--force` to overwrite the remote's artifact. vx
  // does not: an entry is immutable (2026-10-15), so a forced run
  // re-executes and refreshes the disk, and the key keeps its first bytes.
  it(
    '--force re-executes but leaves the artifact the remote holds, and the next cold run is served it',
    async () => {
      const fixture = await makeFixture('vx-remote-e2e-')
      const remote = startArtifactEndpoint()
      const puts: string[] = []
      const layer: RemoteCacheLayer = {
        ...remote.layer,
        put: (hash, body, meta) => {
          puts.push(hash)
          return remote.layer.put(hash, body, meta)
        },
      }
      try {
        const dir = await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: `
            export default {
              tasks: {
                build: {
                  exec: { command: "node -e 'process.stdout.write(String(Math.random()))' > out.txt" },
                  inputs: { files: ['src/**'] }, cache: { outputs: { files: ['out.txt'] } },
                },
              },
            }
          `,
        })
        const out = path.join(dir, 'out.txt')
        const once = async (cache?: typeof FORCE) => {
          const r = await run({
            cwd: fixture.root,
            tasks: ['build'],
            ...(cache === undefined ? {} : { cache }),
            log: silentLogger(fixture),
            remoteCache: layer,
          })
          return r.outcomes[0]!.status
        }
        expect(await once()).toBe('success')
        const plain = await Bun.file(out).text()
        expect(await once(FORCE)).toBe('success')
        const forced = await Bun.file(out).text()
        expect(forced).not.toBe(plain)
        expect(puts).toHaveLength(1)

        await rm(path.join(fixture.root, '.vx', 'cache'), { recursive: true, force: true })
        await rm(out)
        expect(await once()).toBe('cache-hit-remote')
        expect(await Bun.file(out).text()).toBe(plain)
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  // turborepo#12346: a requested task with no cache left its cached
  // dependency's artifact local-only.
  it(
    'a cached dependency of an uncached requested task is uploaded and later served remotely',
    async () => {
      const fixture = await makeFixture('vx-remote-e2e-')
      const remote = startArtifactEndpoint()
      try {
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: `
            export default {
              tasks: {
                build: {
                  exec: { command: 'echo built > out.txt' },
                  inputs: { files: ['src/**'] }, cache: { outputs: { files: ['out.txt'] } },
                },
                deploy: { exec: { command: 'cat out.txt' }, dependsOn: ['build'] },
              },
            }
          `,
        })
        const statuses = async () =>
          Object.fromEntries(
            (
              await run({
                cwd: fixture.root,
                tasks: ['deploy'],
                log: silentLogger(fixture),
                remoteCache: remote.layer,
              })
            ).outcomes.map((o) => [o.node.id, o.status]),
          )
        expect(await statuses()).toEqual({ 'app#build': 'success', 'app#deploy': 'success' })
        // build's entry, and deploy's log the run keeps (run-store.ts).
        expect(remote.store.size).toBe(2)

        await rm(path.join(fixture.root, '.vx', 'cache'), { recursive: true, force: true })
        await rm(path.join(fixture.root, 'packages', 'app', 'out.txt'))
        expect(await statuses()).toEqual({
          'app#build': 'cache-hit-remote',
          'app#deploy': 'success',
        })
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  // turborepo#8418: `--cache-policy=remote:rw` still served the entry from the
  // local cache.
  it(
    'local:,remote:rw re-executes over a LOCAL-only entry and uploads the result',
    async () => {
      const fixture = await makeFixture('vx-remote-e2e-')
      const remote = startArtifactEndpoint()
      const runs = path.join(fixture.root, 'runs.txt')
      try {
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: `
            export default {
              tasks: {
                build: {
                  exec: { command: 'echo built > out.txt && echo run >> ../../runs.txt' },
                  inputs: { files: ['src/**'] }, cache: { outputs: { files: ['out.txt'] } },
                },
              },
            }
          `,
        })
        const local = await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
        expect(local.outcomes[0]!.status).toBe('success')
        const [predicted] = (
          await planRun({
            cwd: fixture.root,
            tasks: ['build'],
            log: silentLogger(fixture),
            remoteCache: remote.layer,
          })
        ).tasks
        expect(predicted?.cacheStatus).toBe('hit-local')

        const remoteOnly = await run({
          cwd: fixture.root,
          tasks: ['build'],
          cache: { localRead: false, localWrite: false, remoteRead: true, remoteWrite: true },
          log: silentLogger(fixture),
          remoteCache: remote.layer,
        })
        expect(remoteOnly.outcomes[0]!.status).toBe('success')
        expect(await Bun.file(runs).text()).toBe('run\nrun\n')
        expect(remote.store.size).toBe(1)
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})

describe("orchestrator e2e: a remote hit carries the producing execution's usage", () => {
  it(
    'a fresh runner learns what the task used from the artifact it restored',
    async () => {
      // Step 2 of the reservations learned from history: the machine that
      // never ran the task has no `runs` row with usage, and that is where
      // a memory budget bites (a fresh CI runner). The producing
      // execution's CPU time and peak RSS ride the artifact's sidecar, the
      // ingest indexes them on the entry, the hit surfaces them as
      // `stored*` (never as this run's own usage), and the history reader
      // takes them from the hit row's entry.
      const fixture = await makeFixture('vx-remote-usage-')
      const remote = startArtifactEndpoint()
      try {
        const mb = heavyMb()
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: heavyBuildConfig(mb),
        })
        const first = await run({
          cwd: fixture.root,
          tasks: ['build'],
          log: silentLogger(fixture),
          remoteCache: remote.layer,
        })
        const produced = first.outcomes[0]!
        expect(produced.status).toBe('success')
        // The runner reports rusage on linux and darwin; the differential
        // below needs a real number, not an absent one.
        expect(produced.peakRssBytes).toBeGreaterThanOrEqual(mb * MB)
        expect(produced.storedPeakRssBytes).toBeUndefined()

        // The fresh runner: no local cache, no history.
        await rm(path.join(fixture.root, '.vx', 'cache'), { recursive: true, force: true })
        const second = await run({
          cwd: fixture.root,
          tasks: ['build'],
          log: silentLogger(fixture),
          remoteCache: remote.layer,
        })
        const hit = second.outcomes[0]!
        expect(hit.status).toBe('cache-hit-remote')
        expect(hit.storedPeakRssBytes).toBe(produced.peakRssBytes!)
        expect(hit.storedCpuMs).toBe(produced.cpuMs!)
        // A hit spent no CPU of its own on the task.
        expect(hit.peakRssBytes).toBeUndefined()
        expect(hit.cpuMs).toBeUndefined()

        // What `@vzn/vx-history` reads on this runner's NEXT run.
        const local = new Cache(path.join(fixture.root, '.vx', 'cache'))
        try {
          const table = await new LocalHistoryProvider(indexDb(local)).loadFor(['app#build'])
          expect(table.get('app#build')?.maxPeakRssBytes).toBe(produced.peakRssBytes!)
          expect(table.get('app#build')?.hitRate).toBe(1)
        } finally {
          local.close()
        }
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})

describe('orchestrator: a prefetch still in flight when the run stops', () => {
  it(
    'is given up before the cache closes, and the next run pulls it whole',
    async () => {
      // `startRemotePrefetch` promises that the caller awaits its handle
      // before closing the cache (item 634). A stopped run waits on no
      // read: a Ctrl-C during a slow download waited for its last byte
      // (2026-10-17). Each prefetch ends at the stop, so the cache
      // closes under no ingest, nothing half-read lands, and the next run
      // GETs both again and hits.
      const fixture = await makeFixture('vx-remote-e2e-')
      const warm = startArtifactEndpoint()
      try {
        for (const name of ['a', 'b']) {
          await addProject(fixture.root, name, {
            files: { 'src/in.txt': name },
            config: BUILD_CONFIG,
          })
        }
        const first = await run({
          cwd: fixture.root,
          tasks: ['build'],
          log: silentLogger(fixture),
          remoteCache: warm.layer,
        })
        expect(first.ok).toBe(true)
        expect(warm.store.size).toBe(2)
        await rm(path.join(fixture.root, '.vx', 'cache'), { recursive: true, force: true })

        const slow = startArtifactEndpoint({ getLatencyMs: 150 })
        for (const [h, body] of warm.store) slow.store.set(h, body)
        const controller = new AbortController()
        controller.abort()
        const aborted = await run({
          cwd: fixture.root,
          tasks: ['build'],
          log: silentLogger(fixture),
          remoteCache: slow.layer,
          signal: controller.signal,
        })
        expect(aborted.outcomes.map((o) => o.status)).toEqual(['aborted', 'aborted'])
        const pulled = [...slow.getCounts.values()].reduce((x, y) => x + y, 0)
        expect(pulled).toBeLessThanOrEqual(2)

        const third = await run({
          cwd: fixture.root,
          tasks: ['build'],
          log: silentLogger(fixture),
          remoteCache: slow.layer,
        })
        expect(third.ok).toBe(true)
        expect(third.outcomes.map((o) => o.status)).toEqual([
          'cache-hit-remote',
          'cache-hit-remote',
        ])
        expect([...slow.getCounts.values()].reduce((x, y) => x + y, 0)).toBe(pulled + 2)
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})

describe('orchestrator: local-only runs never prefetch', () => {
  it('a run with no remote cache configured invokes no prefetch', async () => {
    const fixture = await makeFixture('vx-remote-e2e-')
    try {
      await addProject(fixture.root, 'app', {
        files: { 'src/in.txt': 'v1' },
        config: BUILD_CONFIG,
      })

      // Spy on the only entry point that fires prefetches. With no
      // remote layer it must never be called — local-only runs are
      // byte-identical to before this feature.
      const prefetchSpy = spyOn(LayeredCache.prototype, 'prefetch')
      const res = await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
      expect(res.ok).toBe(true)
      expect(prefetchSpy).toHaveBeenCalledTimes(0)
      prefetchSpy.mockRestore()
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })
})

// ─── RunOptions.remoteCache injection — THE plugin seam, wire-free ─────────
// A remote layer is any object with has/get/put (RemoteCacheLayer); core
// carries no wire client. An in-memory layer (zero HTTP) must drive the
// full remote-hit path, and explicit injection must WIN over a
// workspace-declared cache plugin (no double-wrapping).

describe('orchestrator: injected RemoteCacheLayer (RunOptions.remoteCache)', () => {
  interface MemLayer {
    layer: RemoteCacheLayer
    store: Map<string, Uint8Array>
    gets: number
    puts: number
    heads: number
  }
  function memoryLayer(): MemLayer {
    const store = new Map<string, Uint8Array>()
    const state: MemLayer = {
      store,
      gets: 0,
      puts: 0,
      heads: 0,
      layer: {
        async has(hash) {
          state.heads++
          return store.has(hash) ? {} : null
        },
        async get(hash) {
          state.gets++
          const body = store.get(hash)
          if (!body) return null
          return { body: new Blob([body.slice()]), durationMs: 7 }
        },
        async put(hash, body) {
          state.puts++
          store.set(hash, await body.bytes())
        },
      },
    }
    return state
  }

  it(
    'an in-memory layer (no HTTP anywhere) serves the full remote-hit path',
    async () => {
      const fixture = await makeFixture('vx-remote-e2e-')
      const mem = memoryLayer()
      try {
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: BUILD_CONFIG,
        })

        const first = await run({
          cwd: fixture.root,
          tasks: ['build'],
          log: silentLogger(fixture),
          remoteCache: mem.layer,
        })
        expect(first.ok).toBe(true)
        expect(mem.puts).toBe(1) // write-through landed in the injected layer

        await rm(path.join(fixture.root, '.vx', 'cache'), { recursive: true, force: true })
        const second = await run({
          cwd: fixture.root,
          tasks: ['build'],
          log: silentLogger(fixture),
          remoteCache: mem.layer,
        })
        expect(second.outcomes[0]!.status).toBe('cache-hit-remote')
        expect(second.ok).toBe(true)
        expect(mem.gets).toBeGreaterThanOrEqual(1)
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  // A remote with no `hasMany` is asked `has` per key before its upload;
  // a held key is not sent, so it is counted nowhere (Docs, 2026-10-16:
  // the footer read `remote 1↑` with no PUT made).
  it(
    'a --force run counts no upload for a key a has-only remote holds',
    async () => {
      const fixture = await makeFixture('vx-remote-e2e-')
      try {
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: BUILD_CONFIG,
        })
        const store = new Map<string, Uint8Array>()
        let puts = 0
        const remoteCache = {
          has: async (h: string) => (store.has(h) ? {} : null),
          get: async (h: string) => {
            const b = store.get(h)
            return b === undefined ? null : { body: new Blob([b]), durationMs: 1 }
          },
          put: async (h: string, body: Blob) => {
            puts++
            store.set(h, new Uint8Array(await body.arrayBuffer()))
          },
        }
        await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture), remoteCache })
        expect(puts).toBe(1)
        fixture.log.length = 0
        const forced = await run({
          cwd: fixture.root,
          tasks: ['build'],
          log: silentLogger(fixture),
          remoteCache,
          cacheFlags: { force: true },
        })
        expect(forced.outcomes[0]!.status).toBe('success')
        const legend = fixture.log[fixture.log.findIndex((l) => l.startsWith('  cache')) + 1]
        expect({ puts, legend: legend?.trim() }).toEqual({ puts: 1, legend: 'local 1↑' })
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  // 2026-10-15: a remote read's failure counts with a write's, as one
  // `N✗` in the footer, and `vx last` names each, though the upload's
  // failure lands after the run's rows went in.
  it(
    'a failed read and a failed upload are one ✗ in the footer, and the run row names both',
    async () => {
      const fixture = await makeFixture('vx-remote-e2e-')
      try {
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: BUILD_CONFIG,
        })
        const result = await run({
          cwd: fixture.root,
          tasks: ['build'],
          log: silentLogger(fixture),
          remoteCache: {
            has: async () => null,
            get: async () => {
              throw new Error('GET down')
            },
            put: async () => {
              throw new Error('PUT down')
            },
          },
        })
        expect(result.outcomes[0]!.status).toBe('success')
        const legend = fixture.log[fixture.log.findIndex((l) => l.startsWith('  cache')) + 1]
        expect(legend?.trim()).toBe('remote 1✗')
        const db = new Database(path.join(fixture.root, '.vx', 'cache', 'cache.db'), {
          readonly: true,
        })
        const rows = db.query<{ e: string | null }, []>('SELECT remote_error AS e FROM runs').all()
        db.close()
        expect(rows).toEqual([{ e: 'download: GET down; upload: PUT down' }])
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    "a sink hears each artifact's size, a save's and a fetch's time, and the run's uploads",
    async () => {
      const fixture = await makeFixture('vx-remote-e2e-')
      const mem = memoryLayer()
      try {
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: BUILD_CONFIG,
        })
        const runOnce = async () => {
          let end: TelemetryRecord | undefined
          let summary: RunSummaryRecord | undefined
          await run({
            cwd: fixture.root,
            tasks: ['build'],
            log: silentLogger(fixture),
            remoteCache: mem.layer,
            telemetrySinks: [
              {
                onRecord: (r) => void (r.kind === 'task.end' && (end = r)),
                onRunSummary: (s) => void (summary = s),
              },
            ],
          })
          const t = end?.kind === 'task.end' ? end : undefined
          return {
            source: t?.cacheSource,
            bytes: t?.artifactBytes,
            saved: t?.saveMs !== undefined,
            fetched: t?.fetchMs !== undefined,
            uploads: summary?.uploads,
          }
        }
        const miss = await runOnce()
        const size = mem.store.values().next().value!.byteLength
        expect(size).toBeGreaterThan(0)
        expect(miss).toEqual({
          source: 'miss',
          bytes: size,
          saved: true,
          fetched: false,
          uploads: { count: 1, bytes: size, ms: miss.uploads!.ms, failed: 0 },
        })
        await rm(path.join(fixture.root, '.vx', 'cache'), { recursive: true, force: true })
        expect(await runOnce()).toEqual({
          source: 'remote',
          bytes: size,
          saved: false,
          fetched: true,
          uploads: undefined,
        })
        expect(await runOnce()).toEqual({
          source: 'local',
          bytes: size,
          saved: false,
          fetched: false,
          uploads: undefined,
        })
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'explicit injection WINS over a workspace-declared cache plugin (never consulted)',
    async () => {
      const fixture = await makeFixture('vx-remote-e2e-')
      const mem = memoryLayer()
      try {
        // A cache plugin that would ABORT the run if consulted: the
        // injection-wins precedence is only proven if this never fires.
        await Bun.write(
          path.join(fixture.root, '.vx/workspace.mjs'),
          localWorkspaceSource([
            pluginSource(
              'test/poison-cache',
              `{ cache: () => {
                throw new Error('plugin cache must not be consulted when remoteCache is injected')
              },
            }`,
            ),
          ]),
        )
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: BUILD_CONFIG,
        })
        const res = await run({
          cwd: fixture.root,
          tasks: ['build'],
          log: silentLogger(fixture),
          remoteCache: mem.layer,
        })
        expect(res.ok).toBe(true)
        expect(mem.puts).toBe(1) // the injected layer got the upload
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})

// ─── "Is there a remote behind this layer?" — the LAYER answers ────────────
// The orchestrator clamps the remote policy axes, skips the up-front local
// classify, drives the prefetch pass and drains background uploads off ONE
// question. It used to guess the answer two different wrong ways: identity
// against the local cache (`cache !== localCache`) said YES to any
// pass-through decorator with no remote at all, and `instanceof LayeredCache`
// said NO to every third-party layer. `CacheLayer.hasRemote` is the layer's
// own answer, and these pin both directions.

describe('cache layer: hasRemote is the remote-layer signal', () => {
  it('a bare local Cache reports no remote; a LayeredCache reports one', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-hasremote-'))
    try {
      const local = new Cache(dir)
      const remote: RemoteCacheLayer = {
        async has() {
          return null
        },
        async get() {
          return null
        },
        async put() {},
      }
      expect(local.hasRemote).toBe(false)
      expect(layeredOver(local, remote).hasRemote).toBe(true)
      local.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it(
    'a remote-only write policy with no remote stays clamped inert',
    async () => {
      // An unclamped `remote:w` made execute-task believe a save would
      // happen, so it wiped the declared outputs before every exec for a
      // save that goes NOWHERE: `--no-cache`'s "leave the tree alone".
      const fixture = await makeFixture('vx-remote-e2e-')
      try {
        const dir = await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1', 'stray.txt': 'UNTOUCHED' },
          config: `
            export default {
              tasks: {
                build: {
                  exec: { command: 'echo built > out.txt' },
                  inputs: { files: ['src/**'] }, cache: { outputs: { files: ['*.txt'] } },
                },
              },
            }
          `,
        })
        const res = await run({
          cwd: fixture.root,
          tasks: ['build'],
          cache: { localRead: true, localWrite: false, remoteRead: true, remoteWrite: true },
          log: silentLogger(fixture),
        })
        expect(res.ok).toBe(true)
        expect(await Bun.file(path.join(dir, 'stray.txt')).text()).toBe('UNTOUCHED')
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    "a plugin's remote gets the prefetch pass, and its uploads drain before teardown",
    async () => {
      // Without the prefetch a remote's lookups land on the up-front
      // classify, awaited BEFORE any task is scheduled; without the drain,
      // uploads are in flight when close() fires.
      const fixture = await makeFixture('vx-remote-e2e-')
      const g = globalThis as Record<string, unknown>
      try {
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: BUILD_CONFIG,
        })
        await Bun.write(
          path.join(fixture.root, '.vx/workspace.mjs'),
          localWorkspaceSource([
            `                ${pluginSource(
              'test/remote',
              `{ cache() {
                  return {
                    async has() { return false },
                    async hasMany() {
                      globalThis.__vxPrefetched = true
                      return new Set()
                    },
                    async get() { return null },
                    async put() {
                      await Bun.sleep(50)
                      globalThis.__vxDrained = true
                      globalThis.__vxTornDownFirst = globalThis.__vxTornDown === true
                    },
                  }
                },
                teardown() {
                  globalThis.__vxTornDown = true
                },
              }`,
            )}`,
          ]),
        )
        g['__vxPrefetched'] = false
        g['__vxDrained'] = false
        const res = await run({
          cwd: fixture.root,
          tasks: ['build'],
          cache: { localRead: true, localWrite: true, remoteRead: true, remoteWrite: true },
          log: silentLogger(fixture),
        })
        expect(res.ok).toBe(true)
        expect(g['__vxPrefetched']).toBe(true)
        expect(g['__vxDrained']).toBe(true)
        // ORDER, not just occurrence: a plugin releasing its client in
        // teardown() must not run first. When it did, every remote write was
        // lost to `Channel has been shut down` — a warning, a green run, and
        // nothing in the remote store (observed against a live REAPI server).
        expect(g['__vxTornDownFirst']).toBe(false)
      } finally {
        delete g['__vxPrefetched']
        delete g['__vxDrained']
        delete g['__vxTornDown']
        delete g['__vxTornDownFirst']
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'a run that THROWS after its hits still flushes the accessed_at bumps',
    async () => {
      // `close()` is where the deferred `accessed_at` batch is written — a
      // hit only adds its hash to `touched`. run() therefore closes the
      // cache in a `finally`, "on EVERY exit path, not just the happy one",
      // because a throw between opening the cache and the normal close
      // leaks the handle AND loses the run's touch record, after which an
      // LRU `vx cache clean` can evict entries the run just hit.
      //
      // Nothing pinned that: deleting the `finally`'s close survives the
      // whole repo (item 447). The row above — "a run record that cannot be
      // written is a status line; the cache handle still closes" — names
      // this exact hazard, but `recordRunBundle`'s throw is CAUGHT, so that
      // run finishes and closes on the NORMAL path; the `finally` is never
      // the close under test. The claim is "every exit path"; the coverage
      // was one of them.
      //
      // The lever: the local store's run-end `recordOutputDirs` throws. A
      // restoring hit snapshots its `dist/**` tree after the drain, so the
      // run takes its hits and then dies before its own close.
      const fixture = await makeFixture('vx-remote-e2e-')
      const g = globalThis as Record<string, unknown>
      const record = Cache.prototype.recordOutputDirs
      const dirs = spyOn(Cache.prototype, 'recordOutputDirs').mockImplementation(function (
        this: Cache,
        ...args
      ) {
        // Only the run-end snapshot (it passes `holds`): the hit path's own
        // snapshot failure is caught where it is taken.
        if (g['__vxDirsThrow'] === true && args[3] !== undefined) {
          throw new Error('snapshot exploded')
        }
        return record.apply(this, args)
      })
      try {
        const dir = await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: `
            export default {
              tasks: {
                build: {
                  exec: { command: 'mkdir -p dist && echo built > dist/out.txt' },
                  inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
                },
              },
            }
          `,
        })
        g['__vxDirsThrow'] = false
        const first = await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
        expect(first.ok).toBe(true)

        const dbPath = path.join(fixture.root, '.vx', 'cache', 'cache.db')
        const accessedAt = (): number => {
          const db = new Database(dbPath, { readonly: true })
          try {
            const row = db.query('SELECT MAX(accessed_at) AS a FROM entries').get() as {
              a: number
            }
            return row.a
          } finally {
            db.close()
          }
        }
        // A hit renews only a row over an hour old, so age it first.
        const rw = new Database(dbPath)
        rw.run('UPDATE entries SET accessed_at = 0')
        rw.close()
        const before = accessedAt()

        // A restoring hit: the output tree is gone, so the hit writes it back.
        await rm(path.join(dir, 'dist'), { recursive: true, force: true })
        g['__vxDirsThrow'] = true
        await expect(
          run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) }),
        ).rejects.toThrow('snapshot exploded')
        expect(accessedAt()).toBeGreaterThan(before)
      } finally {
        dirs.mockRestore()
        delete g['__vxDirsThrow']
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})
