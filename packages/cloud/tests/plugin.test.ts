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
import { capFingerprintPayload, cloud } from '../src/plugin.js'
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
// sets — the plugin resolves ONE connection from a superset of aliases. The
// GITHUB_* vars are cleared too so the suite is HERMETIC inside GitHub Actions
// itself: `GITHUB_STEP_SUMMARY` (always set in Actions) activates the plugin's
// GHA-summary telemetry path, and GITHUB_TOKEN/ACTIONS drive the check-run rung
// — leaving them set makes a "declines when unconfigured" assertion fail on a
// runner though it passes locally. A test that WANTS the GHA-summary path sets
// GITHUB_STEP_SUMMARY itself inside the clean-env block.
const CONN_KEYS = [
  'VX_CLOUD_URL',
  'VX_CLOUD_TOKEN',
  'VX_CLOUD_PR_TOKEN',
  'VX_SERVICE_URL',
  'VX_CLOUD_INGEST_URL',
  'VX_CLOUD_INGEST_TOKEN',
  'VX_CLOUD_INSIGHTS_URL',
  'VX_CLOUD_CONFIG',
  'VX_CLOUD_ENV',
  'GITHUB_STEP_SUMMARY',
  'GITHUB_TOKEN',
  'GITHUB_ACTIONS',
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

// Run delegation was removed (platform §12 P3): the backend capability now
// only ever returns a DISTRIBUTION backend; a plain connection never moves
// execution. These pin that a bare / plain / distribute connection behaves.
describe('cloud() backend capability', () => {
  it('declines (undefined) with no connection — a bare cloud() never delegates', async () => {
    await withCleanConnEnv({ VX_CLOUD_CONFIG: '/nonexistent/environments.json' }, async () => {
      const backend = await cloud().backend!(backendCtx('/x'))
      expect(backend).toBeUndefined()
    })
  })

  it('a plain connection (url only) does NOT move execution', async () => {
    // VX_CLOUD_URL wires cache/ingest/distribution but never delegates a run —
    // delegation is gone, so the backend rung declines without VX_CLOUD_DISTRIBUTE.
    await withCleanConnEnv({ VX_CLOUD_URL: 'http://localhost:59998' }, async () => {
      const backend = await cloud().backend!(backendCtx('/x'))
      expect(backend).toBeUndefined()
    })
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
        const m = url.pathname.match(/\/v1\/cache\/([^/]+)$/)
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

/** A stub GitHub API capturing check-run POSTs (path + head_sha). */
function stubGithubApi(): {
  server: ReturnType<typeof Bun.serve>
  requests: { path: string; headSha: string }[]
} {
  const requests: { path: string; headSha: string }[] = []
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = (await req.json()) as { head_sha: string }
      requests.push({ path: new URL(req.url).pathname, headSha: body.head_sha })
      return new Response('{"id":1}', { status: 201 })
    },
  })
  return { server, requests }
}

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
      defaultBranch: null,
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

  it('caps the per-run fingerprint payload at 4 MiB (later tasks tree-only); small runs untouched', async () => {
    // Pure-cap semantics: an under-budget summary is the SAME object…
    const small = fakeSummary()
    small.tasks = [
      {
        ...small.tasks[0]!,
        hash: 'h1',
        outputFp: { tree: 't1', fileCount: 1, files: [['out.txt', 'aa']] },
      },
    ]
    expect(capFingerprintPayload(small)).toBe(small)

    // …while a run whose serialized maps blow the budget ships the later
    // tasks tree-only (truncated: true), earlier tasks intact.
    // ~3 MiB serialized per task: the first fits the 4 MiB budget, the second
    // (cumulative ~6 MiB) does not.
    const bigFiles: Array<[string, string]> = []
    for (let i = 0; i < 500; i++) {
      bigFiles.push([`dist/${'p'.repeat(6000)}/f${i}.js`, `${i}`.padStart(16, '0')])
    }
    const big = fakeSummary()
    big.tasks = [
      {
        ...big.tasks[0]!,
        taskId: 'a#build',
        hash: 'h1',
        outputFp: { tree: 't1', fileCount: 500, files: bigFiles },
      },
      {
        ...big.tasks[0]!,
        taskId: 'b#build',
        hash: 'h2',
        outputFp: { tree: 't2', fileCount: 500, files: bigFiles },
      },
    ]
    const capped = capFingerprintPayload(big)
    expect(capped).not.toBe(big)
    expect(capped.tasks[0]!.outputFp!.files).toBeDefined()
    expect(capped.tasks[1]!.outputFp).toEqual({ tree: 't2', fileCount: 500, truncated: true })

    // And the sink POSTs a small run's body byte-for-byte.
    const bodies: string[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        bodies.push(await req.text())
        return new Response('ok')
      },
    })
    try {
      const sink = (await cloud({
        url: `http://localhost:${server.port}`,
        token: 't',
      }).telemetry!(telemetryCtx('/x'))) as TelemetrySink
      sink.onRunSummary!(small)
      await sink.flush!()
      expect(bodies[0]).toBe(JSON.stringify(small))
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

  it('reports each EXECUTED task incrementally on task.end (result + log), hits excepted', async () => {
    const reqs: { path: string; body: string }[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        reqs.push({ path: new URL(req.url).pathname, body: await req.text() })
        return new Response('ok')
      },
    })
    try {
      const sink = (await cloud({
        url: `http://localhost:${server.port}`,
        token: 't',
        logs: true,
      }).telemetry!(telemetryCtx('/x'))) as TelemetrySink
      // With a connection, run.start + task.end are projected for incremental.
      expect(sink.wants).toContain('run.start')
      expect(sink.wants).toContain('task.end')

      // run.start carries the canonical start + the workspace to route to.
      sink.onRecord!({
        v: 2,
        kind: 'run.start',
        run: fakeSummary().run,
        total: 2,
        ts: 0,
        startedAt: 7000,
      })
      // An executed task with output → fires an incremental push.
      sink.onRecord!({
        v: 2,
        kind: 'task.log',
        runId: 'run-xyz',
        taskId: 'p#build',
        stream: 'stdout',
        chunk: 'ok\n',
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
        status: 'success',
        cacheSource: 'miss',
        exitCode: 0,
        durationMs: 5,
      })
      // A CACHE HIT does NOT fire — it lands in the end-of-run batch.
      sink.onRecord!({
        v: 2,
        kind: 'task.end',
        runId: 'run-xyz',
        ts: 3,
        taskId: 'p#cached',
        project: 'p',
        task: 'cached',
        status: 'cache-hit',
        cacheSource: 'local',
        exitCode: 0,
        durationMs: 0,
      })
      // The incremental POST is fire-and-forget — wait for it to land.
      for (let i = 0; i < 50 && !reqs.some((r) => r.path === '/v1/ingest/task'); i++) {
        await Bun.sleep(10)
      }
      const taskPosts = reqs.filter((r) => r.path === '/v1/ingest/task')
      expect(taskPosts).toHaveLength(1) // only the executed task, not the hit
      const rec = JSON.parse(taskPosts[0]!.body) as {
        runId: string
        workspaceId: string
        runStartedAt: number
        task: { taskId: string }
        log?: { content: string }
      }
      expect(rec.runId).toBe('run-xyz')
      expect(rec.workspaceId).toBe('ws-test')
      expect(rec.runStartedAt).toBe(7000)
      expect(rec.task.taskId).toBe('p#build')
      expect(rec.log?.content).toBe('ok\n')

      // At flush, the summary posts; the log bundle is EMPTY (the tail already
      // went out incrementally), so no /v1/ingest/logs.
      sink.onRunSummary!(fakeSummary())
      await sink.flush!()
      expect(reqs.some((r) => r.path === '/v1/ingest')).toBe(true)
      expect(reqs.some((r) => r.path === '/v1/ingest/logs')).toBe(false)
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

  it('annotates failed rows in the GHA summary with platform triage verdicts', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'vx-gha-triage-'))
    const file = path.join(dir, 'summary.md')
    const paths: { path: string; auth: string | null }[] = []
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const p = new URL(req.url).pathname
        paths.push({ path: p, auth: req.headers.get('authorization') })
        if (p === '/v1/triage/run-xyz') {
          return Response.json({
            rows: [
              {
                taskId: 'demo#hello',
                verdict: 'flaky',
                sameKeySuccesses: 2,
                keyChanged: false,
              },
            ],
          })
        }
        return new Response('ok')
      },
    })
    const failing: RunSummaryRecord = {
      ...fakeSummary(),
      failedCount: 1,
      exitOk: false,
      tasks: [
        {
          taskId: 'demo#hello',
          project: 'demo',
          task: 'hello',
          status: 'failed',
          cacheSource: 'miss',
          exitCode: 1,
          durationMs: 5,
        },
      ],
    }
    const prev = process.env['GITHUB_STEP_SUMMARY']
    process.env['GITHUB_STEP_SUMMARY'] = file
    try {
      const sink = (await cloud({
        url: `http://localhost:${server.port}`,
        token: 'tri-tok',
      }).telemetry!(telemetryCtx('/x'))) as TelemetrySink
      sink.onRunSummary!(failing)
      await sink.flush!()
      const written = await Bun.file(file).text()
      expect(written).toContain('🎲 flaky — not this change (same key passed 2×)')
      const triageReq = paths.find((r) => r.path === '/v1/triage/run-xyz')
      expect(triageReq).toBeDefined()
      expect(triageReq!.auth).toBe('Bearer tri-tok')
    } finally {
      if (prev === undefined) delete process.env['GITHUB_STEP_SUMMARY']
      else process.env['GITHUB_STEP_SUMMARY'] = prev
      void server.stop(true)
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('a failed triage fetch leaves the summary plain (never-fail)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'vx-gha-triage-err-'))
    const file = path.join(dir, 'summary.md')
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname.startsWith('/v1/triage/')) {
          return new Response('boom', { status: 500 })
        }
        return new Response('ok')
      },
    })
    const failing: RunSummaryRecord = {
      ...fakeSummary(),
      failedCount: 1,
      exitOk: false,
      tasks: [
        {
          taskId: 'demo#hello',
          project: 'demo',
          task: 'hello',
          status: 'failed',
          cacheSource: 'miss',
          exitCode: 1,
          durationMs: 5,
        },
      ],
    }
    const prev = process.env['GITHUB_STEP_SUMMARY']
    process.env['GITHUB_STEP_SUMMARY'] = file
    try {
      const sink = (await cloud({
        url: `http://localhost:${server.port}`,
        token: 't',
      }).telemetry!(telemetryCtx('/x'))) as TelemetrySink
      sink.onRunSummary!(failing)
      await sink.flush!()
      const written = await Bun.file(file).text()
      expect(written).toContain('❌ failed (exit 1)')
      expect(written).not.toContain('🎲')
    } finally {
      if (prev === undefined) delete process.env['GITHUB_STEP_SUMMARY']
      else process.env['GITHUB_STEP_SUMMARY'] = prev
      void server.stop(true)
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('still declines with no connection AND no GitHub surfaces (plain local run untouched)', async () => {
    await withCleanConnEnv({ VX_CLOUD_CONFIG: '/nonexistent/environments.json' }, async () => {
      const prevSummary = process.env['GITHUB_STEP_SUMMARY']
      const prevToken = process.env['GITHUB_TOKEN']
      delete process.env['GITHUB_STEP_SUMMARY']
      // No token → no check candidate, even when the suite itself runs in
      // Actions (GITHUB_ACTIONS=true there).
      delete process.env['GITHUB_TOKEN']
      try {
        expect(await cloud().telemetry!(telemetryCtx('/x'))).toBeUndefined()
      } finally {
        if (prevSummary !== undefined) process.env['GITHUB_STEP_SUMMARY'] = prevSummary
        if (prevToken !== undefined) process.env['GITHUB_TOKEN'] = prevToken
      }
    })
  })

  it('activates for the GitHub CHECK alone (token passed to the step, no serve)', async () => {
    const stub = stubGithubApi()
    await withCleanConnEnv({ VX_CLOUD_CONFIG: '/nonexistent/environments.json' }, async () => {
      const saved: Record<string, string | undefined> = {}
      const pin = (k: string, v: string | undefined): void => {
        saved[k] = process.env[k]
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      pin('GITHUB_STEP_SUMMARY', undefined)
      pin('GITHUB_ACTIONS', 'true')
      pin('GITHUB_TOKEN', 'tok')
      pin('GITHUB_REPOSITORY', 'acme/mono')
      pin('GITHUB_SHA', 'sha-1')
      pin('GITHUB_EVENT_PATH', undefined)
      pin('GITHUB_API_URL', `http://localhost:${stub.server.port}`)
      try {
        const sink = (await cloud().telemetry!(telemetryCtx('/x'))) as TelemetrySink
        expect(sink).toBeDefined()
        sink.onRunSummary!(fakeSummary())
        await sink.flush!()
        expect(stub.requests).toHaveLength(1)
        expect(stub.requests[0]!.path).toBe('/repos/acme/mono/check-runs')
        expect(stub.requests[0]!.headSha).toBe('sha-1')
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k]
          else process.env[k] = v
        }
        await stub.server.stop()
      }
    })
  })

  it('the zero-projection guarantee: VX_CLOUD_LOGS=0 does NOT subscribe to task.log (the chunk path stays free)', async () => {
    const prev = process.env['VX_CLOUD_LOGS']
    process.env['VX_CLOUD_LOGS'] = '0'
    try {
      const sink = (await cloud({
        url: 'http://localhost:1',
        token: 't',
      }).telemetry!(telemetryCtx('/x'))) as TelemetrySink
      // Logs off → the high-volume task.log stream is never projected (a plain
      // run pays nothing per chunk). Per-task RESULT reporting (run.start +
      // task.end) is a separate feature and stays on when connected.
      expect(sink.wants).not.toContain('task.log')
      expect(sink.wants).toContain('task.end')
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

  it('does NOT auto-detect a RUNNING local server — unconnected means decline', async () => {
    // The one wiring story: `vx-cloud connect` (or explicit env vars). A server
    // merely running on the machine must never capture runs by existence — the
    // plugin does no local discovery, so the running stub below is irrelevant.
    const root = await mkdtemp(path.join(tmpdir(), 'vx-noautodetect-'))
    const server = Bun.serve({ port: 0, fetch: () => new Response('ok') })
    try {
      await withCleanConnEnv({ VX_CLOUD_CONFIG: '/nonexistent/environments.json' }, async () => {
        const sink = await cloud().telemetry!(telemetryCtx(root))
        expect(sink).toBeUndefined()
        const backend = await cloud().backend!(backendCtx(root))
        expect(backend).toBeUndefined()
      })
    } finally {
      void server.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  })
})

// A refused ingest must SAY so. `fetch` resolves for a 401/403/500 — only a
// network error rejects — so a `post` that never checks `res.ok` discards the
// run's telemetry in total silence: the dashboard stays empty and the user
// gets no signal at all. `vx-cloud connect` was hardened against exactly this
// (it refuses a tokenless connect), but the env rung — which IS the CI path —
// never passes through `connect`.
describe('a refused ingest is reported, not swallowed', () => {
  async function pushAgainst(
    status: number,
    env: Record<string, string | undefined>,
  ): Promise<{ warnings: string[]; requests: number }> {
    let requests = 0
    const srv = Bun.serve({
      port: 0,
      fetch() {
        requests++
        return new Response('{}', { status })
      },
    })
    const saved: Record<string, string | undefined> = {}
    for (const [k, v] of Object.entries({ VX_CLOUD_URL: `http://localhost:${srv.port}`, ...env })) {
      saved[k] = process.env[k]
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    const warnings: string[] = []
    try {
      const sink = (await cloud().telemetry!({
        ...telemetryCtx(process.cwd()),
        warn: (m: string) => warnings.push(m),
      })) as TelemetrySink
      expect(sink).toBeDefined()
      sink.onRunSummary?.(fakeSummary())
      await sink.flush?.()
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      void srv.stop(true)
    }
    return { warnings, requests }
  }

  it('names the missing token on a tokenless 401 — the CI path', async () => {
    const { warnings, requests } = await pushAgainst(401, { VX_CLOUD_TOKEN: undefined })
    expect(requests).toBe(1)
    expect(warnings).toHaveLength(1)
    // The status, the concrete fix, and — the load-bearing half — that the run
    // did NOT land. Without the last part a reader can mistake it for noise.
    expect(warnings[0]).toContain('401')
    expect(warnings[0]).toContain('VX_CLOUD_TOKEN')
    expect(warnings[0]).toContain('NOT recorded')
  })

  it('distinguishes a REJECTED token from a missing one', async () => {
    const { warnings } = await pushAgainst(403, { VX_CLOUD_TOKEN: 'vxc_stale' })
    expect(warnings).toHaveLength(1)
    // A token WAS sent, so telling the user to set one would send them the
    // wrong way; the actionable cause is expiry/revocation/wrong workspace.
    expect(warnings[0]).toContain('403')
    expect(warnings[0]).not.toContain('set VX_CLOUD_TOKEN')
    expect(warnings[0]).toContain('rejected this token')
  })

  it('reports a server error without inventing a cause for it', async () => {
    const { warnings } = await pushAgainst(500, { VX_CLOUD_TOKEN: 'vxc_ok' })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('500')
    expect(warnings[0]).not.toContain('token')
  })

  it('stays silent when the ingest is accepted', async () => {
    const { warnings, requests } = await pushAgainst(200, { VX_CLOUD_TOKEN: 'vxc_ok' })
    expect(requests).toBe(1)
    expect(warnings).toEqual([])
  })

  it('warns ONCE however many times the same failure repeats', async () => {
    // The per-task path fires per executed task; a 500-task run against a
    // refusing platform must not print 500 identical lines. Driven through the
    // real sink by flushing twice over a fresh instance is not possible (flush
    // is once-only), so this drives `send` through repeated task pushes.
    let requests = 0
    const srv = Bun.serve({
      port: 0,
      fetch() {
        requests++
        return new Response('{}', { status: 401 })
      },
    })
    const savedUrl = process.env['VX_CLOUD_URL']
    const savedTok = process.env['VX_CLOUD_TOKEN']
    process.env['VX_CLOUD_URL'] = `http://localhost:${srv.port}`
    delete process.env['VX_CLOUD_TOKEN']
    const warnings: string[] = []
    try {
      const sink = (await cloud({ logs: false }).telemetry!({
        ...telemetryCtx(process.cwd()),
        warn: (m: string) => warnings.push(m),
      })) as TelemetrySink
      sink.onRecord?.({
        v: 2,
        kind: 'run.start',
        run: fakeSummary().run,
        total: 3,
        ts: 1,
        startedAt: 1,
      } as never)
      for (let i = 0; i < 3; i++) {
        sink.onRecord?.({
          v: 2,
          kind: 'task.end',
          runId: 'r1',
          ts: 2,
          taskId: `p#t${i}`,
          project: 'p',
          task: `t${i}`,
          status: 'success',
          cacheSource: 'miss',
          exitCode: 0,
          durationMs: 1,
        } as never)
      }
      // Let the fire-and-forget task pushes settle.
      await Bun.sleep(250)
    } finally {
      if (savedUrl === undefined) delete process.env['VX_CLOUD_URL']
      else process.env['VX_CLOUD_URL'] = savedUrl
      if (savedTok !== undefined) process.env['VX_CLOUD_TOKEN'] = savedTok
      void srv.stop(true)
    }
    // Three refusals reached the server, ONE line reached the user.
    expect(requests).toBe(3)
    expect(warnings).toHaveLength(1)
  })
})

// A fork-PR job holds ONLY `VX_CLOUD_PR_TOKEN` — repo secrets are not exposed
// to forks, which is the entire reason the PR token exists. Three of the four
// rungs already fell back to it (`conn.token ?? conn.prToken`: both backend
// paths and the cache); telemetry read `conn.token` alone, so the run summary
// went out with NO Authorization header and was guaranteed a 401.
describe('the fork-PR token reaches the ingest', () => {
  async function pushWith(env: Record<string, string>): Promise<{
    auth: (string | null)[]
    warnings: string[]
  }> {
    const auth: (string | null)[] = []
    const srv = Bun.serve({
      port: 0,
      fetch(req) {
        auth.push(req.headers.get('authorization'))
        return new Response('{}')
      },
    })
    const keys = [
      'VX_CLOUD_URL',
      'VX_CLOUD_TOKEN',
      'VX_CLOUD_INGEST_TOKEN',
      'VX_CLOUD_PR_TOKEN',
      'VX_CLOUD_AGENT',
      'GITHUB_STEP_SUMMARY',
    ]
    const saved: Record<string, string | undefined> = {}
    for (const k of keys) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
    process.env['VX_CLOUD_URL'] = `http://localhost:${srv.port}`
    for (const [k, v] of Object.entries(env)) process.env[k] = v
    const warnings: string[] = []
    try {
      const sink = (await cloud().telemetry!({
        ...telemetryCtx(process.cwd()),
        warn: (m: string) => warnings.push(m),
      })) as TelemetrySink
      sink.onRunSummary?.(fakeSummary())
      await sink.flush?.()
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      void srv.stop(true)
    }
    return { auth, warnings }
  }

  it('presents the PR token when it is the only one — the fork-PR job', async () => {
    const { auth, warnings } = await pushWith({ VX_CLOUD_PR_TOKEN: 'vxc_pr_fork' })
    expect(auth).toEqual(['Bearer vxc_pr_fork'])
    // The server accepted it, so nothing to report. Before the fix this sent
    // no header at all and the run silently vanished.
    expect(warnings).toEqual([])
  })

  it('prefers the TRUSTED token when a job holds both', async () => {
    // Same precedence as every other rung — a trusted job that also happens to
    // export a PR token must not downgrade itself to the untrusted scope.
    const { auth } = await pushWith({
      VX_CLOUD_TOKEN: 'vxc_trusted',
      VX_CLOUD_PR_TOKEN: 'vxc_pr',
    })
    expect(auth).toEqual(['Bearer vxc_trusted'])
  })

  it('still sends nothing when there is genuinely no token', async () => {
    // The control: the fallback must not invent a credential. This is the case
    // whose 401 warning names VX_CLOUD_TOKEN — correct here, and NOT correct
    // for the fork-PR job above, which is why that one had to be fixed by
    // sending the token rather than by rewording the message.
    const { auth } = await pushWith({})
    expect(auth).toEqual([null])
  })
})

// `Number()` is the wrong tool at an argument boundary: it accepts hex
// (`0x10` → 16), exponents (`1e3` → 1000), a leading `+`, and surrounding
// whitespace, so a typo becomes a DIFFERENT number rather than an error. Every
// numeric knob cloud reads from the environment used it while also rejecting
// `abc` and `-1` — half-strict, which teaches a reader it validates when it
// only half does. Core's `parseDecimalInt` exists for exactly this and is now
// on the façade.
describe('VX_CLOUD_DISTRIBUTE is parsed strictly, not coerced', () => {
  async function resolve(raw: string): Promise<string> {
    const saved = process.env['VX_CLOUD_DISTRIBUTE']
    const savedUrl = process.env['VX_CLOUD_URL']
    process.env['VX_CLOUD_DISTRIBUTE'] = raw
    delete process.env['VX_CLOUD_URL']
    try {
      await cloud().backend!(backendCtx(process.cwd()))
      return 'accepted'
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      // A value that PARSES reaches the next rung and fails on the missing
      // serve; a value that does not parse is refused by name.
      return m.includes('invalid VX_CLOUD_DISTRIBUTE') ? 'refused' : 'accepted'
    } finally {
      if (saved === undefined) delete process.env['VX_CLOUD_DISTRIBUTE']
      else process.env['VX_CLOUD_DISTRIBUTE'] = saved
      if (savedUrl !== undefined) process.env['VX_CLOUD_URL'] = savedUrl
    }
  }

  it.each([
    ['hex', '0x10'],
    ['an exponent', '1e3'],
    ['surrounding whitespace', ' 2 '],
    ['a leading plus', '+2'],
    ['a fraction', '1.5'],
    ['non-numeric junk', 'abc'],
    ['zero', '0'],
    ['a negative', '-1'],
    ['past MAX_SAFE_INTEGER', '9007199254740993'],
  ])('refuses %s', async (_label, raw) => {
    expect({ raw, verdict: await resolve(raw) }).toEqual({ raw, verdict: 'refused' })
  })

  it.each([
    ['a plain count', '2'],
    ['a larger plain count', '48'],
  ])('still accepts %s', async (_label, raw) => {
    // The control: strictness must not refuse the values that always worked.
    expect({ raw, verdict: await resolve(raw) }).toEqual({ raw, verdict: 'accepted' })
  })

  it('treats an empty value as unset, not as an error', async () => {
    // `VX_CLOUD_DISTRIBUTE=""` is how a CI matrix expresses "not this job";
    // it must decline the rung rather than fail the run.
    expect(await resolve('')).toBe('accepted')
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
