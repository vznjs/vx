// The remote-cache seam, end to end: core ships NO wire client
// (native-cache-wire-2026-07), so every remote layer here is an injected
// `RunOptions.remoteCache` — an in-memory RemoteCacheLayer or a stub-HTTP
// one where observing the wire matters. Coverage carried over from the
// retired env-hatch (VX_REMOTE_CACHE_*) suites: the remote-hit e2e, the
// plan path's HEAD prediction, never-fail on a fully-broken remote,
// prefetch overlap + at-most-once, the codegen→consumer stability gate,
// --no-cache issuing no reads, and the local:,remote:rw in-memory pack.

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, spyOn } from 'bun:test'
import { LayeredCache, type RemoteCacheLayer } from '../src/cache/index.js'
import type { Logger } from '../src/orchestrator/index.js'
import { planRun, run } from '../src/orchestrator/index.js'

interface Fixture {
  root: string
  log: string[]
  err: string[]
}

const TIMEOUT = 30_000

const silentLogger = (fixture: Fixture): Logger => {
  const buffers = new Map<string, string>()
  return {
    status(line) {
      fixture.log.push(line)
    },
    taskStdout(node, chunk) {
      buffers.set(node.id, (buffers.get(node.id) ?? '') + chunk)
    },
    taskStderr(node, chunk) {
      fixture.err.push(chunk.trimEnd())
      buffers.set(node.id, (buffers.get(node.id) ?? '') + chunk)
    },
    taskComplete(node, outcome) {
      const body = buffers.get(node.id) ?? ''
      buffers.delete(node.id)
      fixture.log.push(`task ${node.id} ${outcome.status}`)
      if (body.trim().length > 0) fixture.log.push(body.trimEnd())
    },
  }
}

async function makeWorkspace(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-remote-e2e-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-root', private: true }, null, 2),
  )
  await mkdir(path.join(root, 'packages'), { recursive: true })
  initGitRepo(root)
  return { root, log: [], err: [] }
}

function initGitRepo(cwd: string): void {
  const git = (...args: string[]): void => {
    const p = Bun.spawnSync({
      cmd: ['git', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgSign=false', ...args],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (p.exitCode !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(p.stderr)}`)
    }
  }
  git('init', '-q')
  git('config', 'user.email', 'test@vx.local')
  git('config', 'user.name', 'vx test')
}

async function addProject(
  root: string,
  name: string,
  args: { files?: Record<string, string>; config: string },
): Promise<string> {
  const dir = path.join(root, 'packages', name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '0.0.0' }, null, 2),
  )
  await writeFile(path.join(dir, 'vx.config.mjs'), args.config)
  for (const [rel, content] of Object.entries(args.files ?? {})) {
    const full = path.join(dir, rel)
    await mkdir(path.dirname(full), { recursive: true })
    await writeFile(full, content)
  }
  return dir
}

/**
 * A stub HTTP artifact server + the RemoteCacheLayer speaking to it — for
 * the cases where observing the WIRE matters (per-hash GET/HEAD counts,
 * concurrency overlap, a 500ing remote). The layer is deliberately thin:
 * LayeredCache owns dedup/degradation, so the stub just translates.
 */
interface ArtifactServer {
  server: ReturnType<typeof Bun.serve>
  layer: RemoteCacheLayer
  store: Map<string, Uint8Array>
  /** Per-hash GET counts — pins at-most-once probing across prefetch + get. */
  getCounts: Map<string, number>
  /** Per-hash HEAD counts — the plan path's existence probes. */
  headCounts: Map<string, number>
  /** Max GETs observed concurrently in flight. */
  getsInFlight: () => number
}

function startArtifactServer(opts?: { getLatencyMs?: number; failAll?: boolean }): ArtifactServer {
  const store = new Map<string, Uint8Array>()
  const getCounts = new Map<string, number>()
  const headCounts = new Map<string, number>()
  let inFlight = 0
  let maxInFlight = 0
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      // Simulate a fully-broken remote: every request 500s. The run
      // must still succeed — remote cache is optional, errors degrade
      // to a miss.
      if (opts?.failAll) return new Response('boom', { status: 500 })
      const url = new URL(req.url)
      const m = url.pathname.match(/^\/artifacts\/([0-9a-f]+)$/)
      if (!m) return new Response('not found', { status: 404 })
      const hash = m[1]!
      if (req.method === 'PUT') {
        store.set(hash, new Uint8Array(await req.arrayBuffer()))
        return new Response(null, { status: 200 })
      }
      if (req.method === 'HEAD') {
        headCounts.set(hash, (headCounts.get(hash) ?? 0) + 1)
        return new Response(null, { status: store.has(hash) ? 200 : 404 })
      }
      if (req.method === 'GET') {
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
    },
  })
  const baseUrl = `http://localhost:${server.port}`
  const layer: RemoteCacheLayer = {
    async has(hash) {
      const res = await fetch(`${baseUrl}/artifacts/${hash}`, { method: 'HEAD' })
      if (res.status === 404) return false
      if (!res.ok) throw new Error(`HEAD ${hash} → ${res.status}`)
      return true
    },
    async get(hash) {
      const res = await fetch(`${baseUrl}/artifacts/${hash}`)
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`GET ${hash} → ${res.status}`)
      const durationRaw = res.headers.get('x-duration')
      return {
        body: await res.arrayBuffer(),
        durationMs: durationRaw !== null ? Number(durationRaw) : undefined,
      }
    },
    async put(hash, body) {
      const res = await fetch(`${baseUrl}/artifacts/${hash}`, { method: 'PUT', body })
      if (!res.ok) throw new Error(`PUT ${hash} → ${res.status}`)
    },
  }
  return { server, layer, store, getCounts, headCounts, getsInFlight: () => maxInFlight }
}

const BUILD_CONFIG = `
  export default {
    tasks: {
      build: {
        exec: { command: 'echo built > out.txt' },
        cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
      },
    },
  }
`

describe('orchestrator e2e: injected remote cache (stub HTTP layer)', () => {
  it(
    'a run served entirely from the remote layer reports ok: true',
    async () => {
      const fixture = await makeWorkspace()
      const remote = startArtifactServer()
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
        await rm(path.join(fixture.root, '.vx'), { recursive: true, force: true })

        const second = await run({
          cwd: fixture.root,
          tasks: ['build'],
          log: silentLogger(fixture),
          remoteCache: remote.layer,
        })
        expect(second.outcomes[0]!.status).toBe('cache-hit-remote')
        expect(second.ok).toBe(true)
      } finally {
        await remote.server.stop(true)
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'planRun (--dry) predicts hit-remote via HEAD — no artifact download, no local ingest',
    async () => {
      const fixture = await makeWorkspace()
      const remote = startArtifactServer()
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
        await rm(path.join(fixture.root, '.vx'), { recursive: true, force: true })
        remote.getCounts.clear()
        remote.headCounts.clear()

        const plan = await planRun({
          cwd: fixture.root,
          tasks: ['build'],
          remoteCache: remote.layer,
        })
        expect(plan.tasks).toHaveLength(1)
        expect(plan.tasks[0]!.cacheStatus).toBe('hit-remote')

        // The probe was an existence HEAD — no GET fired, and nothing was
        // ingested into the (freshly recreated) local cache.
        expect([...remote.getCounts.values()]).toEqual([])
        expect([...remote.headCounts.values()]).toEqual([1])
        const cacheDir = path.join(fixture.root, '.vx', 'cache')
        const glob = new Bun.Glob('*.tar.zst')
        const artifacts = [...glob.scanSync({ cwd: cacheDir })]
        expect(artifacts).toEqual([])
      } finally {
        await remote.server.stop(true)
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'a remote that 500s on every request never fails the run (optional cache degrades to miss)',
    async () => {
      // Point at a fully-broken remote: GET, PUT, and the prefetch
      // probe all 500. Nothing may escalate to a run failure.
      const fixture = await makeWorkspace()
      const broken = startArtifactServer({ failAll: true })
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
        await broken.server.stop(true)
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'a remote-served run issues AT MOST ONE GET per task key (prefetch + execute share it)',
    async () => {
      const fixture = await makeWorkspace()
      // Two independent (no-dep) tasks so both prefetch + execute, and
      // both are stable keys (no upstream outputs feed their inputs).
      for (const name of ['a', 'b']) {
        await addProject(fixture.root, name, {
          files: { 'src/in.txt': `v-${name}` },
          config: BUILD_CONFIG,
        })
      }
      const seed = startArtifactServer()
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
        await rm(path.join(fixture.root, '.vx'), { recursive: true, force: true })

        const remote = startArtifactServer({ getLatencyMs: 40 })
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
          await remote.server.stop(true)
        }
      } finally {
        await seed.server.stop(true)
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'codegen→consumer (inputs glob over a sibling output) stays correct without prefetch',
    async () => {
      // The consumer task reads `**/*` (which includes the codegen
      // output `generated.txt`), so its key is preliminary until codegen
      // runs — it must NOT be prefetched, but the lazy read-through must
      // still produce a correct remote hit on the warm run.
      const fixture = await makeWorkspace()
      const remote = startArtifactServer()
      try {
        await addProject(fixture.root, 'pkg', {
          files: { 'src/seed.txt': 'seed' },
          config: `
            export default {
              tasks: {
                codegen: {
                  exec: { command: 'echo gen > generated.txt' },
                  cache: { inputs: { files: ['src/**'] }, outputs: { files: ['generated.txt'] } },
                },
                build: {
                  dependsOn: ['codegen'],
                  exec: { command: 'cat generated.txt > out.txt' },
                  cache: { inputs: { files: ['**/*'] }, outputs: { files: ['out.txt'] } },
                },
              },
            }
          `,
        })

        const first = await run({
          cwd: fixture.root,
          tasks: ['build'],
          log: silentLogger(fixture),
          remoteCache: remote.layer,
        })
        expect(first.ok).toBe(true)
        await rm(path.join(fixture.root, '.vx'), { recursive: true, force: true })

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
        await remote.server.stop(true)
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    '--no-cache issues no remote GET (no prefetch, no read-through)',
    async () => {
      const fixture = await makeWorkspace()
      const remote = startArtifactServer()
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
        await remote.server.stop(true)
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'local:,remote:rw uploads to remote even with local writes disabled (packs bytes in memory)',
    async () => {
      const fixture = await makeWorkspace()
      const remote = startArtifactServer()
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
        await rm(path.join(fixture.root, '.vx'), { recursive: true, force: true })
        const second = await run({
          cwd: fixture.root,
          tasks: ['build'],
          log: silentLogger(fixture),
          remoteCache: remote.layer,
        })
        expect(second.outcomes[0]!.status).toBe('cache-hit-remote')
      } finally {
        await remote.server.stop(true)
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})

describe('orchestrator: local-only runs never prefetch', () => {
  it('a run with no remote cache configured invokes no prefetch', async () => {
    const fixture = await makeWorkspace()
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
          return store.has(hash)
        },
        async get(hash) {
          state.gets++
          const body = store.get(hash)
          if (!body) return null
          return { body: body.slice().buffer as ArrayBuffer, durationMs: 7 }
        },
        async put(hash, body) {
          state.puts++
          store.set(hash, body instanceof Uint8Array ? body.slice() : new Uint8Array(body))
        },
      },
    }
    return state
  }

  it(
    'an in-memory layer (no HTTP anywhere) serves the full remote-hit path',
    async () => {
      const fixture = await makeWorkspace()
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

        await rm(path.join(fixture.root, '.vx'), { recursive: true, force: true })
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

  it(
    'explicit injection WINS over a workspace-declared cache plugin (never consulted)',
    async () => {
      const fixture = await makeWorkspace()
      const mem = memoryLayer()
      try {
        // A cache plugin that would ABORT the run if consulted: the
        // injection-wins precedence is only proven if this never fires.
        await writeFile(
          path.join(fixture.root, 'vx.workspace.mjs'),
          `
            export default {
              plugins: [
                {
                  name: 'test/poison-cache',
                  cache: () => {
                    throw new Error('plugin cache must not be consulted when remoteCache is injected')
                  },
                },
              ],
            }
          `,
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
