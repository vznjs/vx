import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { LayeredCache } from '../src/cache/index.js'
import type { Logger } from '../src/orchestrator/index.js'
import { run } from '../src/orchestrator/index.js'

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

interface ArtifactServer {
  server: ReturnType<typeof Bun.serve>
  baseUrl: string
  store: Map<string, Uint8Array>
  tags: Map<string, string>
  /** Per-hash GET counts — pins at-most-once probing across prefetch + get. */
  getCounts: Map<string, number>
  /** Hashes a GET was issued for, in arrival order. */
  getsInFlight: () => number
}

/** Minimal in-memory Turbo /v8/artifacts server. `getLatencyMs` lets a
 *  test hold GETs open so prefetch overlap is observable. */
function startArtifactServer(opts?: { getLatencyMs?: number; failAll?: boolean }): ArtifactServer {
  const store = new Map<string, Uint8Array>()
  const tags = new Map<string, string>()
  const getCounts = new Map<string, number>()
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
      const m = url.pathname.match(/^\/v8\/artifacts\/([0-9a-f]+)$/)
      if (!m) return new Response('not found', { status: 404 })
      const hash = m[1]!
      if (req.method === 'PUT') {
        store.set(hash, new Uint8Array(await req.arrayBuffer()))
        const tag = req.headers.get('x-artifact-tag')
        if (tag) tags.set(hash, tag)
        return new Response(JSON.stringify({ urls: [] }), { status: 200 })
      }
      if (req.method === 'GET') {
        getCounts.set(hash, (getCounts.get(hash) ?? 0) + 1)
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        try {
          if (opts?.getLatencyMs) await Bun.sleep(opts.getLatencyMs)
          const body = store.get(hash)
          if (!body) return new Response('not found', { status: 404 })
          const headers: Record<string, string> = { 'x-artifact-duration': '12' }
          const tag = tags.get(hash)
          if (tag) headers['x-artifact-tag'] = tag
          return new Response(body, { status: 200, headers })
        } finally {
          inFlight--
        }
      }
      return new Response('method not allowed', { status: 405 })
    },
  })
  return {
    server,
    baseUrl: `http://localhost:${server.port}`,
    store,
    tags,
    getCounts,
    getsInFlight: () => maxInFlight,
  }
}

describe('orchestrator e2e: remote cache', () => {
  let fixture: Fixture
  let remote: ReturnType<typeof startArtifactServer>
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(async () => {
    fixture = await makeWorkspace()
    remote = startArtifactServer()
    for (const k of [
      'VX_REMOTE_CACHE_URL',
      'VX_REMOTE_CACHE_TOKEN',
      'VX_REMOTE_CACHE_SIGNATURE_KEY',
    ]) {
      savedEnv[k] = process.env[k]
    }
    process.env.VX_REMOTE_CACHE_URL = remote.baseUrl
    process.env.VX_REMOTE_CACHE_TOKEN = 'test-token'
    delete process.env.VX_REMOTE_CACHE_SIGNATURE_KEY
  })

  afterEach(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await remote.server.stop(true)
    await rm(fixture.root, { recursive: true, force: true })
  })

  it(
    'a run served entirely from the remote layer reports ok: true',
    async () => {
      await addProject(fixture.root, 'app', {
        files: { 'src/in.txt': 'v1' },
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: 'echo built > out.txt' },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })

      const first = await run({
        cwd: fixture.root,
        tasks: ['build'],
        log: silentLogger(fixture),
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
      })
      expect(second.outcomes[0]!.status).toBe('cache-hit-remote')
      expect(second.ok).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'a remote that 500s on every request never fails the run (optional cache degrades to miss)',
    async () => {
      // Point at a fully-broken remote: GET, PUT, and the prefetch
      // probe all 500. Nothing may escalate to a run failure.
      const broken = startArtifactServer({ failAll: true })
      process.env.VX_REMOTE_CACHE_URL = broken.baseUrl
      try {
        await addProject(fixture.root, 'app', {
          files: { 'src/in.txt': 'v1' },
          config: `
            export default {
              tasks: {
                build: {
                  exec: { command: 'echo built > out.txt' },
                  cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
                },
              },
            }
          `,
        })
        // Cold run: prefetch GET 500s → miss → executes → write-through
        // PUT 500s → swallowed. Run succeeds.
        const first = await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
        expect(first.ok).toBe(true)
        expect(first.outcomes[0]!.status).toBe('success')
        // Warm run: local hit (remote never contributed). Still ok.
        const second = await run({
          cwd: fixture.root,
          tasks: ['build'],
          log: silentLogger(fixture),
        })
        expect(second.ok).toBe(true)
      } finally {
        await broken.server.stop(true)
      }
    },
    TIMEOUT,
  )

  it(
    'VX_REMOTE_CACHE_SIGNATURE_KEY signs uploads and verifies downloads end-to-end',
    async () => {
      process.env.VX_REMOTE_CACHE_SIGNATURE_KEY = 'e2e-signing-key-0123456789abcdef'
      await addProject(fixture.root, 'app', {
        files: { 'src/in.txt': 'v1' },
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: 'echo built > out.txt' },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })

      const first = await run({
        cwd: fixture.root,
        tasks: ['build'],
        log: silentLogger(fixture),
      })
      expect(first.ok).toBe(true)
      // The upload carried an x-artifact-tag.
      expect(remote.tags.size).toBe(1)

      await rm(path.join(fixture.root, '.vx'), { recursive: true, force: true })

      // Round trip: the tagged artifact passes verification on the way back.
      const second = await run({
        cwd: fixture.root,
        tasks: ['build'],
        log: silentLogger(fixture),
      })
      expect(second.outcomes[0]!.status).toBe('cache-hit-remote')

      // Tamper the stored artifact: verification fails, the run degrades
      // to re-execution instead of restoring poisoned bytes.
      const [hash, body] = [...remote.store.entries()][0]!
      const flipped = new Uint8Array(body)
      flipped[0] = flipped[0]! ^ 0xff
      remote.store.set(hash, flipped)
      await rm(path.join(fixture.root, '.vx'), { recursive: true, force: true })

      const third = await run({
        cwd: fixture.root,
        tasks: ['build'],
        log: silentLogger(fixture),
      })
      expect(third.ok).toBe(true)
      expect(third.outcomes[0]!.status).toBe('success')
      expect(fixture.log.join('\n')).toMatch(/signature mismatch/)
    },
    TIMEOUT,
  )

  it(
    'a remote-served run issues AT MOST ONE GET per task key (prefetch + execute share it)',
    async () => {
      await remote.server.stop(true)
      remote = startArtifactServer({ getLatencyMs: 40 })
      process.env.VX_REMOTE_CACHE_URL = remote.baseUrl

      // Two independent (no-dep) tasks so both prefetch + execute, and
      // both are stable keys (no upstream outputs feed their inputs).
      for (const name of ['a', 'b']) {
        await addProject(fixture.root, name, {
          files: { 'src/in.txt': `v-${name}` },
          config: `
            export default {
              tasks: {
                build: {
                  exec: { command: 'echo built > out.txt' },
                  cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
                },
              },
            }
          `,
        })
      }

      // Warm the remote (and wipe local) so the second run is fully
      // remote-served — both prefetch AND execute-task want each key.
      await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
      expect(remote.store.size).toBe(2)
      await rm(path.join(fixture.root, '.vx'), { recursive: true, force: true })

      const fresh = startArtifactServer({ getLatencyMs: 40 })
      // Carry over the warmed artifacts to the latency server.
      for (const [h, b] of remote.store) fresh.store.set(h, b)
      await remote.server.stop(true)
      remote = fresh
      process.env.VX_REMOTE_CACHE_URL = remote.baseUrl

      const second = await run({
        cwd: fixture.root,
        tasks: ['build'],
        log: silentLogger(fixture),
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

      const first = await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
      expect(first.ok).toBe(true)
      await rm(path.join(fixture.root, '.vx'), { recursive: true, force: true })

      const second = await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
      expect(second.ok).toBe(true)
      // Both tasks are remote hits on the warm run — the consumer's
      // key resolves correctly via lazy read-through even though it was
      // skipped by prefetch.
      const statuses = second.outcomes.map((o) => `${o.node.taskName}:${o.status}`).sort()
      expect(statuses).toEqual(['build:cache-hit-remote', 'codegen:cache-hit-remote'])
    },
    TIMEOUT,
  )

  it(
    '--no-cache issues no remote GET (no prefetch, no read-through)',
    async () => {
      await remote.server.stop(true)
      remote = startArtifactServer()
      process.env.VX_REMOTE_CACHE_URL = remote.baseUrl
      await addProject(fixture.root, 'app', {
        files: { 'src/in.txt': 'v1' },
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: 'echo built > out.txt' },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })

      const res = await run({
        cwd: fixture.root,
        tasks: ['build'],
        cache: { localRead: false, localWrite: false, remoteRead: false, remoteWrite: false },
        log: silentLogger(fixture),
      })
      expect(res.ok).toBe(true)
      expect(res.outcomes[0]!.status).toBe('success')
      expect([...remote.getCounts.values()]).toHaveLength(0)
    },
    TIMEOUT,
  )

  it(
    'local:,remote:rw uploads to remote even with local writes disabled (packs bytes in memory)',
    async () => {
      await remote.server.stop(true)
      remote = startArtifactServer()
      process.env.VX_REMOTE_CACHE_URL = remote.baseUrl
      await addProject(fixture.root, 'app', {
        files: { 'src/in.txt': 'v1' },
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: 'echo built > out.txt' },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })

      // local: (no read, no write), remote:rw — there is NO local
      // artifact to read off disk, so the upload path must pack the
      // bytes in memory.
      const res = await run({
        cwd: fixture.root,
        tasks: ['build'],
        cache: { localRead: false, localWrite: false, remoteRead: true, remoteWrite: true },
        log: silentLogger(fixture),
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
      })
      expect(second.outcomes[0]!.status).toBe('cache-hit-remote')
    },
    TIMEOUT,
  )
})

describe('orchestrator: local-only runs never prefetch', () => {
  it('a run with no remote cache configured invokes no prefetch', async () => {
    const fixture = await makeWorkspace()
    const savedUrl = process.env.VX_REMOTE_CACHE_URL
    const savedTok = process.env.VX_REMOTE_CACHE_TOKEN
    delete process.env.VX_REMOTE_CACHE_URL
    delete process.env.VX_REMOTE_CACHE_TOKEN
    try {
      await addProject(fixture.root, 'app', {
        files: { 'src/in.txt': 'v1' },
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: 'echo built > out.txt' },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
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
      if (savedUrl === undefined) delete process.env.VX_REMOTE_CACHE_URL
      else process.env.VX_REMOTE_CACHE_URL = savedUrl
      if (savedTok === undefined) delete process.env.VX_REMOTE_CACHE_TOKEN
      else process.env.VX_REMOTE_CACHE_TOKEN = savedTok
      await rm(fixture.root, { recursive: true, force: true })
    }
  })
})
