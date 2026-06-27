import { describe, it, expect } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  Cache,
  FULL_CACHE_POLICY,
  LayeredCache,
  type BackendContext,
  type CacheContext,
  type EventSinkContext,
  type RunRequest,
  type WireEvent,
} from '@vzn/vx'
import { cloud } from '../src/plugin.js'
import { startServe } from '../src/cli/serve.js'

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

function eventSinkCtx(root: string): EventSinkContext {
  return { workspaceRoot: root, cacheDir: path.join(root, '.vx', 'cache'), warn: () => {} }
}

describe('cloud() plugin shape', () => {
  it('returns a VxPlugin contributing all three capabilities', () => {
    const plugin = cloud()
    expect(plugin.name).toBe('vzn/cloud')
    expect(typeof plugin.backend).toBe('function')
    expect(typeof plugin.cache).toBe('function')
    expect(typeof plugin.eventSink).toBe('function')
  })

  it('setup rejects a malformed serviceUrl', () => {
    expect(() => cloud({ serviceUrl: 'not a url' }).setup?.(eventSinkCtx('/x'))).toThrow(
      /not a valid URL/,
    )
  })

  it('setup rejects a malformed cacheUrl / insightsUrl', () => {
    expect(() => cloud({ cacheUrl: ':::bad' }).setup?.(eventSinkCtx('/x'))).toThrow(
      /not a valid URL/,
    )
    expect(() => cloud({ insightsUrl: 'http://' }).setup?.(eventSinkCtx('/x'))).toThrow(
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

describe('cloud() eventSink capability', () => {
  it('buffers WireEvents and uploads them on run:end with the token', async () => {
    const received: { body: string; auth: string | null; contentType: string | null }[] = []
    let resolveUpload: () => void
    const uploaded = new Promise<void>((r) => {
      resolveUpload = r
    })
    const insights = Bun.serve({
      port: 0,
      async fetch(req) {
        received.push({
          body: await req.text(),
          auth: req.headers.get('authorization'),
          contentType: req.headers.get('content-type'),
        })
        resolveUpload()
        return new Response('ok')
      },
    })
    try {
      const sink = (await cloud({
        insightsUrl: `http://localhost:${insights.port}/ingest`,
        insightsToken: 'ins-tok',
      }).eventSink!(eventSinkCtx('/x')))!
      expect(sink).toBeDefined()

      const events: WireEvent[] = [
        { kind: 'run:start', info: { tasks: ['hello'], concurrency: 1 } as never },
        { kind: 'run:status', line: 'a status line' },
        { kind: 'run:end' },
      ]
      for (const e of events) sink.onEvent(e)

      await uploaded
      expect(received.length).toBe(1)
      expect(received[0]!.auth).toBe('Bearer ins-tok')
      expect(received[0]!.contentType).toContain('ndjson')
      const lines = received[0]!.body.split('\n')
      expect(lines.length).toBe(3)
      expect(JSON.parse(lines[2]!)).toEqual({ kind: 'run:end' })
    } finally {
      void insights.stop(true)
    }
  })

  it('onEvent never throws even if the insights endpoint is down', async () => {
    const sink = (await cloud({
      insightsUrl: 'http://localhost:1/ingest',
      insightsToken: 'x',
    }).eventSink!(eventSinkCtx('/x')))!
    expect(() => {
      sink.onEvent({ kind: 'run:status', line: 'x' })
      sink.onEvent({ kind: 'run:end' })
    }).not.toThrow()
    // Give the fire-and-forget fetch a tick to reject and be swallowed.
    await Bun.sleep(20)
  })

  it('declines (undefined) when no insights URL is configured', async () => {
    const prev = process.env['VX_CLOUD_INSIGHTS_URL']
    delete process.env['VX_CLOUD_INSIGHTS_URL']
    try {
      const sink = await cloud().eventSink!(eventSinkCtx('/x'))
      expect(sink).toBeUndefined()
    } finally {
      if (prev !== undefined) process.env['VX_CLOUD_INSIGHTS_URL'] = prev
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
