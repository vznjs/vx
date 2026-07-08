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
  type RunRequest,
  type RunSummaryRecord,
  type TelemetryContext,
  type TelemetrySink,
} from '@vzn/vx'
import { cloud } from '../src/plugin.js'
import { startServe } from '../src/cli/serve.js'
import { ENVIRONMENTS_VERSION, writeEnvironmentsFile } from '../src/environments.js'

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

  it('setup rejects a malformed connection url', () => {
    expect(() => cloud({ url: 'not a url' }).setup?.(telemetryCtx('/x'))).toThrow(/not a valid URL/)
    expect(() => cloud({ url: ':::bad' }).setup?.(telemetryCtx('/x'))).toThrow(/not a valid URL/)
  })
})

// Clear every connection env var so a test's outcome depends only on what it
// sets — the plugin resolves ONE connection from a superset of aliases.
const CONN_KEYS = [
  'VX_CLOUD_URL',
  'VX_CLOUD_TOKEN',
  'VX_CLOUD_PR_TOKEN',
  'VX_SERVICE_URL',
  'VX_REMOTE_CACHE_URL',
  'VX_REMOTE_CACHE_TOKEN',
  'VX_REMOTE_CACHE_PR_TOKEN',
  'VX_CLOUD_INGEST_URL',
  'VX_CLOUD_INGEST_TOKEN',
  'VX_CLOUD_INSIGHTS_URL',
  'VX_CLOUD_CONFIG',
  'VX_CLOUD_ENV',
]
async function withCleanConnEnv<T>(
  overrides: Record<string, string>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const saved: Record<string, string | undefined> = {}
  for (const k of CONN_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v
  try {
    return await fn()
  } finally {
    for (const k of Object.keys(overrides)) delete process.env[k]
    for (const k of CONN_KEYS) if (saved[k] !== undefined) process.env[k] = saved[k]
  }
}

// Point the active environment at a serve, optionally opting into delegation.
function connectEnv(configDir: string, url: string, delegate: boolean): void {
  process.env['VX_CLOUD_CONFIG'] = path.join(configDir, 'environments.json')
  writeEnvironmentsFile({
    version: ENVIRONMENTS_VERSION,
    active: 'team',
    environments: { team: { url, ...(delegate ? { delegate: true } : {}) } },
  })
}

describe('cloud() backend capability', () => {
  it('delegates to a reachable serve ONLY when the environment opted in with delegate', async () => {
    const root = await makeWorkspace()
    const server = await startServe({ root })
    const savedCfg = process.env['VX_CLOUD_CONFIG']
    const savedUrl = process.env['VX_CLOUD_URL']
    delete process.env['VX_CLOUD_URL']
    try {
      connectEnv(root, server.origin, true)
      const backend = (await cloud().backend!(backendCtx(root)))!
      expect(typeof backend.run).toBe('function')
      const result = await backend.run({ tasks: ['hello'], cwd: root, flow: 'focused' })
      expect(result.ok).toBe(true)
      expect(result.outcomes[0]!.taskId).toBe('demo#hello')
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
      if (savedCfg === undefined) delete process.env['VX_CLOUD_CONFIG']
      else process.env['VX_CLOUD_CONFIG'] = savedCfg
      if (savedUrl !== undefined) process.env['VX_CLOUD_URL'] = savedUrl
    }
  })

  it('declines (undefined) with no connection — a bare cloud() never delegates', async () => {
    await withCleanConnEnv({ VX_CLOUD_CONFIG: '/nonexistent/environments.json' }, async () => {
      const backend = await cloud().backend!(backendCtx('/x'))
      expect(backend).toBeUndefined()
    })
  })

  it('a plain connection (url, no delegate) does NOT move execution', async () => {
    // VX_CLOUD_URL wires cache/ingest/distribution but must never silently
    // delegate a run to the server — so the backend rung declines.
    await withCleanConnEnv({ VX_CLOUD_URL: 'http://localhost:59998' }, async () => {
      const backend = await cloud().backend!(backendCtx('/x'))
      expect(backend).toBeUndefined()
    })
  })

  it('falls back to a local backend when a delegate environment is unreachable', async () => {
    const root = await makeWorkspace()
    const savedCfg = process.env['VX_CLOUD_CONFIG']
    try {
      connectEnv(root, 'http://localhost:1', true)
      const backend = (await cloud().backend!(backendCtx(root)))!
      const result = await backend.run({ tasks: ['hello'], cwd: root, flow: 'focused' })
      expect(result.ok).toBe(true)
      expect(result.outcomes[0]!.taskId).toBe('demo#hello')
    } finally {
      await rm(root, { recursive: true, force: true })
      if (savedCfg === undefined) delete process.env['VX_CLOUD_CONFIG']
      else process.env['VX_CLOUD_CONFIG'] = savedCfg
    }
  })

  it('an ambient `distribute` environment returns a backend that FAILS SAFE to a local run', async () => {
    // The local-pool keystone: connecting with `--distribute` engages the
    // ambient rung, but an unreachable pool must run locally, never throw or
    // block — so a dev who leaves it on is never worse off than a plain run.
    const root = await makeWorkspace()
    const savedCfg = process.env['VX_CLOUD_CONFIG']
    const savedUrl = process.env['VX_CLOUD_URL']
    delete process.env['VX_CLOUD_URL']
    try {
      process.env['VX_CLOUD_CONFIG'] = path.join(root, 'environments.json')
      writeEnvironmentsFile({
        version: ENVIRONMENTS_VERSION,
        active: 'pool',
        environments: { pool: { url: 'http://localhost:1', distribute: true } },
      })
      const backend = await cloud().backend!(backendCtx(root))
      expect(backend).toBeDefined() // the ambient rung engaged (not a decline)
      const result = await backend!.run({ tasks: ['hello'], cwd: root, flow: 'focused' })
      expect(result.ok).toBe(true)
      expect(result.outcomes[0]!.taskId).toBe('demo#hello')
    } finally {
      await rm(root, { recursive: true, force: true })
      if (savedCfg === undefined) delete process.env['VX_CLOUD_CONFIG']
      else process.env['VX_CLOUD_CONFIG'] = savedCfg
      if (savedUrl !== undefined) process.env['VX_CLOUD_URL'] = savedUrl
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
        url: `http://localhost:${remote.port}`,
        token: 'tok-123',
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

  it('declines (undefined) when no connection is configured', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'vx-cloud-nocache-'))
    const localCache = new Cache(path.join(root, '.vx', 'cache'))
    try {
      // No connection env, no environments file → decline without a probe.
      await withCleanConnEnv(
        { VX_CLOUD_CONFIG: path.join(root, 'no-environments.json') },
        async () => {
          const layer = await cloud().cache!(cacheCtx(localCache, root))
          expect(layer).toBeUndefined()
        },
      )
    } finally {
      localCache.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('declines when a connection has a URL but no token (an open local serve)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'vx-cloud-notoken-'))
    const localCache = new Cache(path.join(root, '.vx', 'cache'))
    try {
      await withCleanConnEnv({ VX_CLOUD_URL: 'http://localhost:59997' }, async () => {
        const layer = await cloud().cache!(cacheCtx(localCache, root))
        expect(layer).toBeUndefined()
      })
    } finally {
      localCache.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})

function fakeSummary(): RunSummaryRecord {
  return {
    v: 1,
    run: {
      runId: 'run-xyz',
      vxVersion: '0.0.0',
      workspaceId: 'ws-test',
      workspaceName: 'fixture-ws',
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
        url: `http://localhost:${server.port}`,
        token: 'ing-tok',
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
      url: 'http://localhost:1',
      token: 'x',
    }).telemetry!(telemetryCtx('/x'))) as TelemetrySink
    sink.onRunSummary!(fakeSummary())
    await expect(sink.flush!()).resolves.toBeUndefined()
  })

  it('captures task logs and POSTs a bundle to /v1/ingest/logs after the summary', async () => {
    const paths: string[] = []
    const bodies: string[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        paths.push(new URL(req.url).pathname)
        bodies.push(await req.text())
        return new Response('ok')
      },
    })
    try {
      const sink = (await cloud({
        url: `http://localhost:${server.port}`,
        token: 't',
        logs: true,
      }).telemetry!(telemetryCtx('/x'))) as TelemetrySink
      // Opt-in: the source only projects task.log when the sink wants it.
      expect(sink.wants).toContain('task.log')
      expect(sink.wants).toContain('task.end')

      sink.onRecord!({
        v: 2,
        kind: 'task.log',
        runId: 'run-xyz',
        taskId: 'p#build',
        stream: 'stderr',
        chunk: 'boom\n',
        ts: 1,
      })
      sink.onRecord!({
        v: 2,
        kind: 'task.end',
        runId: 'run-xyz',
        ts: 2,
        taskId: 'p#build',
        project: 'p',
        task: 'build',
        status: 'failed',
        cacheSource: 'miss',
        exitCode: 1,
        durationMs: 1,
      })
      sink.onRunSummary!(fakeSummary())
      await sink.flush!()

      // Summary first, then the log bundle.
      expect(paths).toEqual(['/v1/ingest', '/v1/ingest/logs'])
      const logBody = JSON.parse(bodies[1]!) as {
        workspaceId: string
        tasks: { taskId: string; content: string }[]
      }
      expect(logBody.workspaceId).toBe('ws-test')
      expect(logBody.tasks[0]!.taskId).toBe('p#build')
      expect(logBody.tasks[0]!.content).toBe('boom\n')
    } finally {
      void server.stop(true)
    }
  })

  it('writes a GitHub job summary in CI even with NO cloud connected', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'vx-gha-plugin-'))
    const file = path.join(dir, 'summary.md')
    await withCleanConnEnv({ VX_CLOUD_CONFIG: '/nonexistent/environments.json' }, async () => {
      const prev = process.env['GITHUB_STEP_SUMMARY']
      process.env['GITHUB_STEP_SUMMARY'] = file
      try {
        // No URL/token anywhere → no connection, but GITHUB_STEP_SUMMARY is set.
        const sink = (await cloud().telemetry!(telemetryCtx('/x'))) as TelemetrySink
        expect(sink).toBeDefined()
        expect(sink.wants).toEqual([]) // no connection → no log capture
        sink.onRunSummary!(fakeSummary())
        await sink.flush!()
        const written = await Bun.file(file).text()
        expect(written).toContain('vx run')
        expect(written).toContain('| Task | Status | Duration | Cache |')
      } finally {
        if (prev === undefined) delete process.env['GITHUB_STEP_SUMMARY']
        else process.env['GITHUB_STEP_SUMMARY'] = prev
        await rm(dir, { recursive: true, force: true })
      }
    })
  })

  it('still declines with no connection AND no GitHub summary (plain local run untouched)', async () => {
    await withCleanConnEnv({ VX_CLOUD_CONFIG: '/nonexistent/environments.json' }, async () => {
      const prev = process.env['GITHUB_STEP_SUMMARY']
      delete process.env['GITHUB_STEP_SUMMARY']
      try {
        expect(await cloud().telemetry!(telemetryCtx('/x'))).toBeUndefined()
      } finally {
        if (prev !== undefined) process.env['GITHUB_STEP_SUMMARY'] = prev
      }
    })
  })

  it('the zero-projection guarantee: VX_CLOUD_LOGS=0 leaves wants empty (no task.log subscription)', async () => {
    const prev = process.env['VX_CLOUD_LOGS']
    process.env['VX_CLOUD_LOGS'] = '0'
    try {
      const sink = (await cloud({
        url: 'http://localhost:1',
        token: 't',
      }).telemetry!(telemetryCtx('/x'))) as TelemetrySink
      expect(sink.wants).toEqual([])
    } finally {
      if (prev === undefined) delete process.env['VX_CLOUD_LOGS']
      else process.env['VX_CLOUD_LOGS'] = prev
    }
  })

  it('an all-hit run ships NO log bundle (only the summary)', async () => {
    const paths: string[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        paths.push(new URL(req.url).pathname)
        await req.text()
        return new Response('ok')
      },
    })
    try {
      const sink = (await cloud({
        url: `http://localhost:${server.port}`,
        token: 't',
        logs: true,
      }).telemetry!(telemetryCtx('/x'))) as TelemetrySink
      // A cache hit: the buffer drops it (bytes resolve by hash to the run
      // that produced them).
      sink.onRecord!({
        v: 2,
        kind: 'task.log',
        runId: 'run-xyz',
        taskId: 'p#b',
        stream: 'stdout',
        chunk: 'replay\n',
        ts: 1,
      })
      sink.onRecord!({
        v: 2,
        kind: 'task.end',
        runId: 'run-xyz',
        ts: 2,
        taskId: 'p#b',
        project: 'p',
        task: 'b',
        status: 'cache-hit',
        cacheSource: 'local',
        exitCode: 0,
        durationMs: 1,
        hash: 'h',
      })
      sink.onRunSummary!(fakeSummary())
      await sink.flush!()
      expect(paths).toEqual(['/v1/ingest']) // no /v1/ingest/logs
    } finally {
      void server.stop(true)
    }
  })

  it('declines (undefined) when no connection is configured', async () => {
    await withCleanConnEnv({ VX_CLOUD_CONFIG: '/nonexistent/environments.json' }, async () => {
      const sink = await cloud().telemetry!(telemetryCtx('/x'))
      expect(sink).toBeUndefined()
    })
  })

  it('does NOT auto-detect a RUNNING local serve — unconnected means decline', async () => {
    // The one wiring story: `vx-cloud connect` (or explicit env vars). A serve
    // merely running on the machine must never capture runs by existence.
    const root = await mkdtemp(path.join(tmpdir(), 'vx-noautodetect-'))
    const server = await startServe({ root, ingestDir: root })
    try {
      await withCleanConnEnv({ VX_CLOUD_CONFIG: '/nonexistent/environments.json' }, async () => {
        const sink = await cloud().telemetry!(telemetryCtx(root))
        expect(sink).toBeUndefined()
        const backend = await cloud().backend!(backendCtx(root))
        expect(backend).toBeUndefined()
      })
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('cloud() end-to-end through defineWorkspace', () => {
  it('is accepted by the loader and a CLI run completes with the plugin declared', async () => {
    const root = await makeWorkspace()
    try {
      // Bare cloud() — no connection configured, so every capability declines
      // (zero-overhead). The point is that DECLARING the plugin loads cleanly
      // and a plain `vx run` executes locally, unaffected.
      await writeFile(
        path.join(root, 'vx.workspace.mjs'),
        [
          `import { cloud } from '${path.join(import.meta.dir, '..', 'src', 'plugin.ts')}'`,
          'export default {',
          '  plugins: [cloud()],',
          '}',
          '',
        ].join('\n'),
      )
      const binPath = path.join(import.meta.dir, '..', '..', '..', 'src', 'bin.ts')
      // Pin the environments file at a nonexistent path so a real per-user
      // connection on this machine can't leak into the subprocess.
      const proc = Bun.spawnSync(['bun', binPath, 'run', 'hello'], {
        cwd: root,
        env: { ...process.env, VX_CLOUD_CONFIG: '/nonexistent/environments.json' },
      })
      const out = proc.stdout.toString() + proc.stderr.toString()
      expect(proc.exitCode).toBe(0)
      expect(out).toContain('hi-from-task')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
