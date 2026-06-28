import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  Cache,
  FULL_CACHE_POLICY,
  LayeredCache,
  type BackendContext,
  type CacheContext,
  type RunRequest,
  type RunSummaryRecord,
  type TelemetryContext,
  type TelemetrySink,
} from '@vzn/vx'
import { cloud } from '../src/plugin.js'
import { startServe } from '../src/cli/serve.js'
import { serveInfoPath } from '../src/serve-info.js'

// Isolate the per-user serve advertisement at a temp path so these tests never
// touch a real local serve's file on the machine.
const prevServeInfo = process.env['VX_CLOUD_SERVE_INFO']
beforeAll(() => {
  process.env['VX_CLOUD_SERVE_INFO'] = path.join(
    tmpdir(),
    `vx-serveinfo-plugin-${process.pid}.json`,
  )
})
afterAll(async () => {
  await rm(serveInfoPath(), { force: true })
  if (prevServeInfo === undefined) delete process.env['VX_CLOUD_SERVE_INFO']
  else process.env['VX_CLOUD_SERVE_INFO'] = prevServeInfo
})

// A minimal single-project workspace so a delegated `run()` has real work.
async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'vx-cloud-plugin-'))
  spawnSync('git', ['init', '-q'], { cwd: root })
  spawnSync('git', ['config', 'user.email', 'a@b.c'], { cwd: root })
  spawnSync('git', ['config', 'user.name', 't'], { cwd: root })
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'demo', version: '1.0.0' }),
  )
  await writeFile(
    path.join(root, 'vx.config.mjs'),
    [
      'export default {',
      '  tasks: {',
      '    hello: { exec: { command: "echo hi-from-task" } },',
      '  },',
      '}',
      '',
    ].join('\n'),
  )
  spawnSync('git', ['add', '-A'], { cwd: root })
  spawnSync('git', ['commit', '-qm', 'init'], { cwd: root })
  return root
}

function backendCtx(cwd: string): BackendContext {
  const request: RunRequest = { tasks: ['hello'], cwd, flow: 'focused' }
  return { workspaceRoot: cwd, cacheDir: path.join(cwd, '.vx', 'cache'), warn: () => {}, request }
}

function cacheCtx(localCache: Cache, root: string): CacheContext {
  return {
    workspaceRoot: root,
    cacheDir: path.join(root, '.vx', 'cache'),
    warn: () => {},
    localCache,
    policy: FULL_CACHE_POLICY,
  }
}

function telemetryCtx(root: string): TelemetryContext {
  return { workspaceRoot: root, cacheDir: path.join(root, '.vx', 'cache'), warn: () => {} }
}

describe('cloud() plugin shape', () => {
  it('returns a VxPlugin contributing backend / cache / telemetry', () => {
    const plugin = cloud()
    expect(plugin.name).toBe('vzn/cloud')
    expect(typeof plugin.backend).toBe('function')
    expect(typeof plugin.cache).toBe('function')
    expect(typeof plugin.telemetry).toBe('function')
  })

  it('setup rejects a malformed serviceUrl', () => {
    expect(() => cloud({ serviceUrl: 'not a url' }).setup?.(telemetryCtx('/x'))).toThrow(
      /not a valid URL/,
    )
  })

  it('setup rejects a malformed cacheUrl / ingestUrl', () => {
    expect(() => cloud({ cacheUrl: ':::bad' }).setup?.(telemetryCtx('/x'))).toThrow(
      /not a valid URL/,
    )
    expect(() => cloud({ ingestUrl: 'http://' }).setup?.(telemetryCtx('/x'))).toThrow(
      /not a valid URL/,
    )
  })
})

describe('cloud() backend capability', () => {
  it('delegates to a reachable serve via the serviceUrl option', async () => {
    const root = await makeWorkspace()
    const server = await startServe({ root })
    try {
      const backend = (await cloud({ serviceUrl: server.origin }).backend!(backendCtx(root)))!
      expect(typeof backend.run).toBe('function')
      const result = await backend.run({ tasks: ['hello'], cwd: root, flow: 'focused' })
      expect(result.ok).toBe(true)
      expect(result.outcomes[0]!.taskId).toBe('demo#hello')
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('declines (undefined) when no service is configured — no probe, core stays local', async () => {
    const prev = process.env['VX_SERVICE_URL']
    delete process.env['VX_SERVICE_URL']
    try {
      const backend = await cloud().backend!(backendCtx('/x'))
      expect(backend).toBeUndefined()
    } finally {
      if (prev !== undefined) process.env['VX_SERVICE_URL'] = prev
    }
  })

  it('falls back to a local backend when nothing is reachable', async () => {
    const root = await makeWorkspace()
    try {
      const backend = (await cloud({ serviceUrl: 'http://localhost:1' }).backend!(
        backendCtx(root),
      ))!
      // Unreachable serve → local in-process backend; a real run still works.
      const result = await backend.run({ tasks: ['hello'], cwd: root, flow: 'focused' })
      expect(result.ok).toBe(true)
      expect(result.outcomes[0]!.taskId).toBe('demo#hello')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('cloud() cache capability', () => {
  it('returns a LayeredCache that routes reads through the cloud remote', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'vx-cloud-cache-'))
    const localCache = new Cache(path.join(root, '.vx', 'cache'))
    const seen: { hash: string; auth: string | null }[] = []
    const remote = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        const m = url.pathname.match(/\/v8\/artifacts\/([^/]+)$/)
        if (m) seen.push({ hash: m[1]!, auth: req.headers.get('authorization') })
        return new Response(null, { status: 404 })
      },
    })
    try {
      const layer = (await cloud({
        cacheUrl: `http://localhost:${remote.port}`,
        cacheToken: 'tok-123',
      }).cache!(cacheCtx(localCache, root))) as LayeredCache
      expect(layer).toBeInstanceOf(LayeredCache)

      // A local miss reads through to the cloud remote — proving the route.
      const entry = await layer.get('deadbeefdeadbeef', { taskId: 'demo#hello', command: 'echo' })
      expect(entry).toBeNull()
      expect(seen.length).toBe(1)
      expect(seen[0]!.hash).toBe('deadbeefdeadbeef')
      expect(seen[0]!.auth).toBe('Bearer tok-123')
    } finally {
      localCache.close()
      void remote.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('declines (undefined) when no cloud cache is configured', async () => {
    const prevUrl = process.env['VX_REMOTE_CACHE_URL']
    const prevTok = process.env['VX_REMOTE_CACHE_TOKEN']
    delete process.env['VX_REMOTE_CACHE_URL']
    delete process.env['VX_REMOTE_CACHE_TOKEN']
    const root = await mkdtemp(path.join(tmpdir(), 'vx-cloud-nocache-'))
    const localCache = new Cache(path.join(root, '.vx', 'cache'))
    try {
      const layer = await cloud().cache!(cacheCtx(localCache, root))
      expect(layer).toBeUndefined()
    } finally {
      localCache.close()
      await rm(root, { recursive: true, force: true })
      if (prevUrl !== undefined) process.env['VX_REMOTE_CACHE_URL'] = prevUrl
      if (prevTok !== undefined) process.env['VX_REMOTE_CACHE_TOKEN'] = prevTok
    }
  })
})

function fakeSummary(): RunSummaryRecord {
  return {
    v: 1,
    run: {
      runId: 'run-xyz',
      vxVersion: '0.0.0',
      command: 'vx run hello',
      requestedTasks: ['hello'],
      cachePolicy: 'lR,lW,rR,rW',
      concurrency: 1,
      flow: 'focused',
      commitSha: null,
      branch: null,
      dirty: null,
      ci: false,
      ciProvider: null,
      host: null,
      os: 'linux',
      arch: 'x64',
      tags: {},
    },
    startedAt: 0,
    endedAt: 10,
    totalDurationMs: 10,
    taskCount: 1,
    failedCount: 0,
    hitCount: 0,
    hitLocalCount: 0,
    hitRemoteCount: 0,
    exitOk: true,
    tasks: [
      {
        taskId: 'demo#hello',
        project: 'demo',
        task: 'hello',
        status: 'success',
        cacheSource: 'miss',
        exitCode: 0,
        durationMs: 5,
      },
    ],
  }
}

describe('cloud() telemetry capability', () => {
  it('POSTs the RunSummaryRecord to the ingest endpoint with the token at flush', async () => {
    const received: { body: string; auth: string | null; contentType: string | null }[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        received.push({
          body: await req.text(),
          auth: req.headers.get('authorization'),
          contentType: req.headers.get('content-type'),
        })
        return new Response('ok')
      },
    })
    try {
      const sink = (await cloud({
        ingestUrl: `http://localhost:${server.port}/v1/ingest`,
        ingestToken: 'ing-tok',
      }).telemetry!(telemetryCtx('/x'))) as TelemetrySink
      expect(sink).toBeDefined()

      sink.onRunSummary!(fakeSummary())
      await sink.flush!()

      expect(received.length).toBe(1)
      expect(received[0]!.auth).toBe('Bearer ing-tok')
      expect(received[0]!.contentType).toContain('json')
      const parsed = JSON.parse(received[0]!.body) as RunSummaryRecord
      expect(parsed.run.runId).toBe('run-xyz')
      expect(parsed.tasks[0]!.task).toBe('hello')
    } finally {
      void server.stop(true)
    }
  })

  it('flush never throws even if the ingest endpoint is down', async () => {
    const sink = (await cloud({
      ingestUrl: 'http://localhost:1/v1/ingest',
      ingestToken: 'x',
    }).telemetry!(telemetryCtx('/x'))) as TelemetrySink
    sink.onRunSummary!(fakeSummary())
    await expect(sink.flush!()).resolves.toBeUndefined()
  })

  it('declines (undefined) when no ingest URL is configured', async () => {
    const prevIngest = process.env['VX_CLOUD_INGEST_URL']
    const prevInsights = process.env['VX_CLOUD_INSIGHTS_URL']
    delete process.env['VX_CLOUD_INGEST_URL']
    delete process.env['VX_CLOUD_INSIGHTS_URL']
    try {
      const sink = await cloud().telemetry!(telemetryCtx('/x'))
      expect(sink).toBeUndefined()
    } finally {
      if (prevIngest !== undefined) process.env['VX_CLOUD_INGEST_URL'] = prevIngest
      if (prevInsights !== undefined) process.env['VX_CLOUD_INSIGHTS_URL'] = prevInsights
    }
  })

  it('AUTO-DETECTS a local vx-cloud serve via its advertisement and pushes there', async () => {
    const prevIngest = process.env['VX_CLOUD_INGEST_URL']
    const prevInsights = process.env['VX_CLOUD_INSIGHTS_URL']
    delete process.env['VX_CLOUD_INGEST_URL']
    delete process.env['VX_CLOUD_INSIGHTS_URL']
    const root = await mkdtemp(path.join(tmpdir(), 'vx-autodetect-'))
    const received: string[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        received.push(new URL(req.url).pathname)
        await req.text()
        return new Response('ok')
      },
    })
    try {
      // Simulate a serve running in ANOTHER process advertising itself at the
      // per-user (machine-level) path — discovered regardless of workspace. Use
      // process.ppid: a DIFFERENT (so not "self") yet ALIVE pid, so the
      // liveness check passes (the same-pid case is self; a dead pid is stale).
      await mkdir(path.dirname(serveInfoPath()), { recursive: true })
      await writeFile(
        serveInfoPath(),
        JSON.stringify({ origin: `http://localhost:${server.port}`, pid: process.ppid }),
      )
      const sink = (await cloud().telemetry!(telemetryCtx(root))) as TelemetrySink
      expect(sink).toBeDefined()
      sink.onRunSummary!(fakeSummary())
      await sink.flush!()
      expect(received).toContain('/v1/ingest')
    } finally {
      void server.stop(true)
      await rm(serveInfoPath(), { force: true })
      await rm(root, { recursive: true, force: true })
      if (prevIngest !== undefined) process.env['VX_CLOUD_INGEST_URL'] = prevIngest
      if (prevInsights !== undefined) process.env['VX_CLOUD_INSIGHTS_URL'] = prevInsights
    }
  })

  it('declines a STALE advertisement (serve died — pid not alive)', async () => {
    const prevIngest = process.env['VX_CLOUD_INGEST_URL']
    delete process.env['VX_CLOUD_INGEST_URL']
    const root = await mkdtemp(path.join(tmpdir(), 'vx-stale-'))
    try {
      await mkdir(path.dirname(serveInfoPath()), { recursive: true })
      // pid 2147483646 ≈ no such process → liveness check fails → decline.
      await writeFile(
        serveInfoPath(),
        JSON.stringify({ origin: 'http://localhost:59999', pid: 2_147_483_646 }),
      )
      const sink = await cloud().telemetry!(telemetryCtx(root))
      expect(sink).toBeUndefined()
    } finally {
      await rm(serveInfoPath(), { force: true })
      await rm(root, { recursive: true, force: true })
      if (prevIngest !== undefined) process.env['VX_CLOUD_INGEST_URL'] = prevIngest
    }
  })
})

describe('cloud() end-to-end through defineWorkspace', () => {
  it('is accepted by the loader and routes a CLI run through the plugin backend', async () => {
    const root = await makeWorkspace()
    const server = await startServe({ root })
    try {
      await writeFile(
        path.join(root, 'vx.workspace.mjs'),
        [
          `import { cloud } from '${path.join(import.meta.dir, '..', 'src', 'plugin.ts')}'`,
          'export default {',
          `  plugins: [cloud({ serviceUrl: ${JSON.stringify(server.origin)} })],`,
          '}',
          '',
        ].join('\n'),
      )
      // The in-process serve advertises itself (machine-level path). Remove it
      // before spawning so the subprocess's telemetry auto-detect declines —
      // this test exercises the EXPLICIT-serviceUrl backend path, not the push.
      // (Why it must go: `spawnSync` blocks THIS process's event loop while the
      // CLI runs, so the in-process serve can't answer an auto-detected POST
      // back to it, and `flush()` would wait the full timeout — a test-only
      // artifact. The dedicated auto-detect test covers the push with a
      // separate, responsive process. See cloud()'s detectLocalIngestUrl.)
      await rm(serveInfoPath(), { force: true })
      // Drive the real CLI: it loads the workspace config, sees the plugin,
      // and routes the run through cloud()'s backend (the reachable serve).
      const binPath = path.join(import.meta.dir, '..', '..', '..', 'src', 'bin.ts')
      const proc = Bun.spawnSync(['bun', binPath, 'run', 'hello'], { cwd: root })
      const out = proc.stdout.toString() + proc.stderr.toString()
      expect(proc.exitCode).toBe(0)
      expect(out).toContain('hi-from-task')
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })
})
