import { describe, it, expect } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import type { RunSummaryRecord } from '@vzn/vx'
import { startServe } from '../src/cli/serve.js'

// vx-cloud reads ONLY its own ingest store; runs reach it via POST /v1/ingest
// (the cloud() plugin's push), never from a workspace cache.db. These helpers
// build + push a canonical RunSummaryRecord so the /v1/* read tests have data.
function mkSummary(
  runId: string,
  over: {
    branch?: string | null
    project?: string
    task?: string
    hitLocal?: number
    at?: number
  } = {},
): RunSummaryRecord {
  const project = over.project ?? 'demo'
  const task = over.task ?? 'hello'
  const hitLocal = over.hitLocal ?? 0
  // Recent by default so 24h-windowed queries (cache stats, hit split) see it.
  const at = over.at ?? Date.now()
  return {
    v: 2,
    run: {
      runId,
      vxVersion: '0.0.0',
      workspaceId: 'ws-test',
      workspaceName: 'fixture-ws',
      command: `vx run ${task}`,
      requestedTasks: [task],
      cachePolicy: 'lR,lW,rR,rW',
      concurrency: 1,
      flow: 'focused',
      commitSha: 'c0ffee',
      branch: over.branch === undefined ? 'main' : over.branch,
      dirty: false,
      ci: false,
      ciProvider: null,
      host: 'box',
      os: 'linux',
      arch: 'x64',
      tags: {},
    },
    startedAt: at,
    endedAt: at + 200,
    totalDurationMs: 200,
    taskCount: 1,
    failedCount: 0,
    hitCount: hitLocal,
    hitLocalCount: hitLocal,
    hitRemoteCount: 0,
    exitOk: true,
    tasks: [
      {
        taskId: `${project}#${task}`,
        project,
        task,
        status: hitLocal > 0 ? 'cache-hit' : 'success',
        cacheSource: hitLocal > 0 ? 'local' : 'miss',
        exitCode: 0,
        durationMs: 120,
        hash: `h-${runId}`,
      },
    ],
  }
}

async function push(origin: string, summary: RunSummaryRecord): Promise<void> {
  const res = await fetch(`${origin}/v1/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(summary),
  })
  if (!res.ok) throw new Error(`ingest failed: ${res.status}`)
}

// A minimal single-project workspace fixture for the serve surfaces.
async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'vx-serve-'))
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

// Run delegation was removed (platform §12 P3) — the transitional serve no
// longer executes `{t:'run'}`; only the ingest/read/artifact surfaces remain.
describe('vx serve — basic surfaces', () => {
  it('reports a health endpoint', async () => {
    const root = await makeWorkspace()
    const server = await startServe({ root })
    try {
      const res = await fetch(`${server.origin}/health`)
      expect(res.ok).toBe(true)
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  // The SPA-serving CONTRACT: with a uiHtmlPath set, `/` and every non-API
  // app route serve that single file so the client-side hash router can take
  // over, while /v1/* + /health stay JSON. This is serve's ROUTING behavior —
  // exercised against a fixture file, NOT the real dashboard dist (which is a
  // build artifact the build pipeline compiles into the binary, not something
  // a unit test should build). A tiny stand-in HTML keeps the test hermetic
  // and fast regardless of whether the SPA has been built.
  it('serves the SPA shell at / and falls back for app routes', async () => {
    const root = await makeWorkspace()
    const uiHtmlPath = path.join(root, 'ui-shell.html')
    await writeFile(uiHtmlPath, '<!doctype html>\n<title>vx dashboard</title>\n')
    const server = await startServe({ root, uiHtmlPath })
    try {
      const index = await fetch(`${server.origin}/`)
      expect(index.ok).toBe(true)
      expect(index.headers.get('content-type')).toContain('text/html')
      const html = await index.text()
      expect(html).toContain('<!doctype html>')
      expect(html).toContain('vx dashboard')

      // A deep app path (not /v1/*, not a real asset) serves the SPA shell.
      const deep = await fetch(`${server.origin}/run`)
      expect(deep.ok).toBe(true)
      expect(await deep.text()).toContain('<!doctype html>')

      // The API is still JSON, not swallowed by the SPA fallback.
      const health = await fetch(`${server.origin}/health`)
      expect(await health.text()).toBe('ok')
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('vx serve — network/auth hardening', () => {
  it('refuses a non-loopback bind without a token', async () => {
    const root = await makeWorkspace()
    await expect(startServe({ root, host: '0.0.0.0' })).rejects.toThrow(/refusing to bind/i)
    await rm(root, { recursive: true, force: true })
  })

  it('allows a non-loopback bind when a token is set', async () => {
    const root = await makeWorkspace()
    const server = await startServe({ root, host: '0.0.0.0', token: 'sekret', port: 0 })
    try {
      expect(server.origin).toContain('http://')
      const res = await fetch(`${server.origin}/health`)
      expect(res.ok).toBe(true)
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a cross-origin WS upgrade (CSWSH) but allows same-origin / no-origin', async () => {
    const root = await makeWorkspace()
    const server = await startServe({ root })
    try {
      const wsUrl = server.origin.replace('http://', 'ws://')
      // Cross-origin browser handshake → 403.
      const evil = await fetch(server.origin, {
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          Origin: 'http://evil.example',
          'Sec-WebSocket-Key': 'x',
          'Sec-WebSocket-Version': '13',
        },
      })
      expect(evil.status).toBe(403)
      // Same-origin browser handshake is NOT rejected on the origin gate (it
      // proceeds to the upgrade). A real WS client connects fine.
      const ok = await new Promise<boolean>((resolve) => {
        const sock = new WebSocket(wsUrl)
        sock.addEventListener('open', () => {
          sock.close()
          resolve(true)
        })
        sock.addEventListener('error', () => resolve(false))
      })
      expect(ok).toBe(true)
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('allows a configured cross-origin via allowedOrigins', async () => {
    const root = await makeWorkspace()
    const server = await startServe({ root, allowedOrigins: ['http://dash.example'] })
    try {
      const res = await fetch(server.origin, {
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          Origin: 'http://dash.example',
          'Sec-WebSocket-Key': 'x',
          'Sec-WebSocket-Version': '13',
        },
      })
      // Not a 403 origin refusal (the upgrade is attempted; without a real WS
      // client Bun answers 426/501, never 403).
      expect(res.status).not.toBe(403)
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('vx serve /v1/* metrics API', () => {
  it('serves runs / invocations / cache stats / history after a pushed run', async () => {
    const root = await makeWorkspace()
    const server = await startServe({ root })
    try {
      // A pushed run summary is the ONLY way data reaches vx-cloud.
      await push(server.origin, mkSummary('run-1'))

      // /v1/runs
      const runs = (await (await fetch(`${server.origin}/v1/runs`)).json()) as {
        runs: { project: string; task: string }[]
      }
      expect(runs.runs.length).toBeGreaterThanOrEqual(1)
      expect(runs.runs[0]!.project).toBe('demo')
      expect(runs.runs[0]!.task).toBe('hello')

      // /v1/invocations
      const inv = (await (await fetch(`${server.origin}/v1/invocations`)).json()) as {
        invocations: { runId: string; taskCount: number }[]
      }
      expect(inv.invocations.length).toBeGreaterThanOrEqual(1)
      expect(inv.invocations[0]!.taskCount).toBeGreaterThanOrEqual(1)

      // /v1/cache/stats
      const stats = (await (await fetch(`${server.origin}/v1/cache/stats`)).json()) as {
        entryCount: number
        runCountLast24h: number
      }
      expect(stats.runCountLast24h).toBeGreaterThanOrEqual(1)

      // /v1/history
      const hist = (await (await fetch(`${server.origin}/v1/history`)).json()) as {
        history: { id: string; runs: number }[]
      }
      expect(hist.history.length).toBeGreaterThanOrEqual(1)
      expect(hist.history.find((h) => h.id === 'demo#hello')).toBeTruthy()

      // /v1/runs/:runId
      const runId = inv.invocations[0]!.runId
      const detail = (await (await fetch(`${server.origin}/v1/runs/${runId}`)).json()) as {
        runId: string
        tasks: { task: string }[]
      }
      expect(detail.runId).toBe(runId)
      expect(detail.tasks.length).toBeGreaterThanOrEqual(1)

      // /v1/explain/:taskId
      const explain = (await (
        await fetch(`${server.origin}/v1/explain/${encodeURIComponent('demo#hello')}`)
      ).json()) as { taskId: string; project: string; task: string }
      expect(explain.taskId).toBe('demo#hello')
      expect(explain.project).toBe('demo')
      expect(explain.task).toBe('hello')
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('compares a run against the previous invocation via /v1/compare/:runId', async () => {
    const root = await makeWorkspace()
    const server = await startServe({ root })
    try {
      // Two invocations so the latest has a previous one to diff against.
      await push(server.origin, mkSummary('run-older', { at: Date.now() - 5000 }))
      await push(server.origin, mkSummary('run-newer', { at: Date.now() - 1000 }))

      const inv = (await (await fetch(`${server.origin}/v1/invocations`)).json()) as {
        invocations: { runId: string }[]
      }
      expect(inv.invocations.length).toBeGreaterThanOrEqual(2)
      const latest = inv.invocations[0]!.runId

      const cmp = (await (
        await fetch(`${server.origin}/v1/compare/${encodeURIComponent(latest)}`)
      ).json()) as {
        runId: string
        previousRunId: string | null
        found: boolean
        tasks: { taskId: string }[]
        summary: { aTotalMs: number; bTotalMs: number; totalDeltaMs: number }
      }
      expect(cmp.runId).toBe(latest)
      expect(cmp.found).toBe(true)
      expect(cmp.previousRunId).not.toBeNull()
      expect(cmp.tasks.find((t) => t.taskId === 'demo#hello')).toBeTruthy()
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns a no-previous-run shape (not an error) for an unknown run id', async () => {
    const root = await makeWorkspace()
    const server = await startServe({ root })
    try {
      const res = await fetch(`${server.origin}/v1/compare/does-not-exist`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { found: boolean; tasks: unknown[] }
      expect(body.found).toBe(false)
      expect(body.tasks).toEqual([])
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns 404 for an unknown run id', async () => {
    const root = await makeWorkspace()
    const server = await startServe({ root })
    try {
      const res = await fetch(`${server.origin}/v1/runs/does-not-exist`)
      expect(res.status).toBe(404)
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns a cache-key diff shape via /v1/diff/:runId/:taskId', async () => {
    const root = await makeWorkspace()
    const server = await startServe({ root })
    try {
      await push(server.origin, mkSummary('run-1'))

      const inv = (await (await fetch(`${server.origin}/v1/invocations`)).json()) as {
        invocations: { runId: string }[]
      }
      const runId = inv.invocations[0]!.runId

      const res = await fetch(
        `${server.origin}/v1/diff/${encodeURIComponent(runId)}/${encodeURIComponent('demo#hello')}`,
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        runId: string
        taskId: string
        found: boolean
        entries: unknown[]
      }
      expect(body.runId).toBe(runId)
      expect(body.taskId).toBe('demo#hello')
      expect(body.found).toBe(true)
      expect(Array.isArray(body.entries)).toBe(true)
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns a found:false diff (200) for an unknown run + task pair', async () => {
    const root = await makeWorkspace()
    const server = await startServe({ root })
    try {
      const res = await fetch(
        `${server.origin}/v1/diff/does-not-exist/${encodeURIComponent('demo#hello')}`,
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { found: boolean; entries: unknown[] }
      expect(body.found).toBe(false)
      expect(body.entries).toEqual([])
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns one invocation via /v1/invocations/:runId (200) and 404 for a bogus id', async () => {
    const root = await makeWorkspace()
    const server = await startServe({ root })
    try {
      await push(server.origin, mkSummary('run-1'))

      const list = (await (await fetch(`${server.origin}/v1/invocations`)).json()) as {
        invocations: { runId: string }[]
      }
      const runId = list.invocations[0]!.runId

      const ok = await fetch(`${server.origin}/v1/invocations/${encodeURIComponent(runId)}`)
      expect(ok.status).toBe(200)
      const detail = (await ok.json()) as { runId: string; taskCount: number }
      expect(detail.runId).toBe(runId)
      expect(detail.taskCount).toBeGreaterThanOrEqual(1)

      const bogus = await fetch(`${server.origin}/v1/invocations/does-not-exist`)
      expect(bogus.status).toBe(404)
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('filters invocations by branch via /v1/invocations?branch=', async () => {
    const root = await makeWorkspace()
    const server = await startServe({ root })
    try {
      await push(server.origin, mkSummary('run-1'))

      // The recorded invocation's branch (the fixture is a fresh git repo).
      const all = (await (await fetch(`${server.origin}/v1/invocations`)).json()) as {
        invocations: { runId: string; branch: string | null }[]
      }
      expect(all.invocations.length).toBeGreaterThanOrEqual(1)
      const branch = all.invocations[0]!.branch

      if (branch !== null) {
        const matched = (await (
          await fetch(`${server.origin}/v1/invocations?branch=${encodeURIComponent(branch)}`)
        ).json()) as { invocations: { branch: string | null }[] }
        expect(matched.invocations.length).toBeGreaterThanOrEqual(1)
        for (const i of matched.invocations) expect(i.branch).toBe(branch)
      }

      // A branch nobody is on filters everything out.
      const none = (await (
        await fetch(`${server.origin}/v1/invocations?branch=no-such-branch-xyz`)
      ).json()) as { invocations: unknown[] }
      expect(none.invocations).toEqual([])
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns the local-vs-remote hit split via /v1/cache/hit-split', async () => {
    const root = await makeWorkspace()
    const server = await startServe({ root })
    try {
      // A miss then a local hit of the same task.
      await push(server.origin, mkSummary('build-miss', { task: 'build', at: Date.now() - 2000 }))
      await push(
        server.origin,
        mkSummary('build-hit', { task: 'build', hitLocal: 1, at: Date.now() - 1000 }),
      )

      const res = await fetch(`${server.origin}/v1/cache/hit-split`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        total: number
        hits: number
        hitLocal: number
        hitRemote: number
      }
      expect(body.total).toBeGreaterThanOrEqual(2)
      expect(body.hitLocal).toBeGreaterThanOrEqual(1)
      // No remote cache is configured in this fixture.
      expect(body.hitRemote).toBe(0)
      expect(body.hits).toBe(body.hitLocal + body.hitRemote)
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('answers CORS preflight + emits permissive headers on JSON responses', async () => {
    const root = await makeWorkspace()
    const server = await startServe({ root })
    try {
      const pre = await fetch(`${server.origin}/v1/runs`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://example.com' },
      })
      expect(pre.status).toBe(204)
      expect(pre.headers.get('access-control-allow-origin')).toBe('*')

      const res = await fetch(`${server.origin}/v1/runs`)
      expect(res.headers.get('access-control-allow-origin')).toBe('*')
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('advertises workspace + RPC capabilities on /version', async () => {
    const root = await makeWorkspace()
    const server = await startServe({ root })
    try {
      const v = (await (await fetch(`${server.origin}/version`)).json()) as {
        vx: string
        workspace: string
        rpc: string[]
      }
      expect(typeof v.vx).toBe('string')
      expect(v.workspace).toBe(root)
      expect(v.rpc).toContain('getCacheStats')
      expect(v.rpc).toContain('cacheKeyDiff')
      expect(v.rpc).toContain('getInvocation')
      expect(v.rpc).toContain('getHitRateSplit')
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('vx serve --ui (embedded single-file dashboard)', () => {
  it('serves the embedded HTML for every non-API route', async () => {
    const root = await makeWorkspace()
    const uiHtmlPath = path.join(await mkdtemp(path.join(tmpdir(), 'vx-ui-')), 'index.html')
    await writeFile(uiHtmlPath, '<!doctype html><title>vx dashboard</title>')

    const server = await startServe({ root, uiHtmlPath })
    try {
      // Root → the embedded HTML, no-store so a binary upgrade isn't cached
      const home = await fetch(`${server.origin}/`)
      expect(home.status).toBe(200)
      expect(home.headers.get('content-type')).toContain('text/html')
      expect(home.headers.get('cache-control')).toBe('no-store')
      expect(await home.text()).toContain('vx dashboard')

      // SPA hash-router fallback: every unknown route serves the same HTML
      const fallback = await fetch(`${server.origin}/tasks/pkg%23build`)
      expect(fallback.status).toBe(200)
      expect(fallback.headers.get('content-type')).toContain('text/html')
      expect(await fallback.text()).toContain('vx dashboard')

      // /v1/* still wins over the UI catch-all
      const api = await fetch(`${server.origin}/v1/cache/stats`)
      expect(api.status).toBe(200)
      expect(api.headers.get('content-type')).toContain('json')
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
      await rm(path.dirname(uiHtmlPath), { recursive: true, force: true })
    }
  })

  it('does not serve any UI when uiHtmlPath is unset', async () => {
    const root = await makeWorkspace()
    const server = await startServe({ root })
    try {
      const res = await fetch(`${server.origin}/`)
      expect(await res.text()).toBe('vx serve')
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('parseServeArgs', () => {
  it('parses --ui / --open / --port', async () => {
    const { parseServeArgs } = await import('../src/cli/serve.js')
    expect(parseServeArgs([]).ui).toBeUndefined()
    expect(parseServeArgs(['--ui']).ui).toBe(true)
    expect(parseServeArgs(['--open']).open).toBe(true)
    expect(parseServeArgs(['--ui', '--open', '--port', '4321']).port).toBe(4321)
    expect(parseServeArgs(['--nope']).error).toMatch(/unknown flag/)
    expect(parseServeArgs(['--port', 'oops']).error).toMatch(/invalid --port/)
  })

  it('parses --ingest-dir', async () => {
    const { parseServeArgs } = await import('../src/cli/serve.js')
    expect(parseServeArgs(['--ingest-dir', '/data']).ingestDir).toBe('/data')
    expect(parseServeArgs(['--ingest-dir=/d']).ingestDir).toBe('/d')
  })

  it('parses --host and repeatable --allow-origin', async () => {
    const { parseServeArgs } = await import('../src/cli/serve.js')
    expect(parseServeArgs(['--host', '0.0.0.0']).host).toBe('0.0.0.0')
    expect(parseServeArgs(['--host=::']).host).toBe('::')
    expect(parseServeArgs(['--host', '']).error).toMatch(/invalid --host/)
    expect(
      parseServeArgs(['--allow-origin', 'http://a', '--allow-origin=http://b']).allowOrigins,
    ).toEqual(['http://a', 'http://b'])
  })
})

describe('resolveServePort', () => {
  it('uses the stable default when neither --port nor env is set', async () => {
    const { resolveServePort, DEFAULT_SERVE_PORT } = await import('../src/cli/serve.js')
    expect(resolveServePort(undefined, {})).toEqual({ port: DEFAULT_SERVE_PORT })
  })

  it('an explicit --port wins over the env var', async () => {
    const { resolveServePort } = await import('../src/cli/serve.js')
    expect(resolveServePort(5000, { VX_CLOUD_PORT: '6000' })).toEqual({ port: 5000 })
  })

  it('VX_CLOUD_PORT overrides the default', async () => {
    const { resolveServePort } = await import('../src/cli/serve.js')
    expect(resolveServePort(undefined, { VX_CLOUD_PORT: '7777' })).toEqual({ port: 7777 })
  })

  it('an empty env var falls back to the default', async () => {
    const { resolveServePort, DEFAULT_SERVE_PORT } = await import('../src/cli/serve.js')
    expect(resolveServePort(undefined, { VX_CLOUD_PORT: '' })).toEqual({ port: DEFAULT_SERVE_PORT })
  })

  it('rejects a malformed env var', async () => {
    const { resolveServePort } = await import('../src/cli/serve.js')
    expect(resolveServePort(undefined, { VX_CLOUD_PORT: 'nope' })).toEqual({
      error: 'invalid VX_CLOUD_PORT: nope',
    })
    expect('error' in resolveServePort(undefined, { VX_CLOUD_PORT: '99999' })).toBe(true)
  })
})

// Cross-machine hermeticity (verify-cross-machine §4): two platforms' pushed
// summaries carrying the SAME cache key but different fingerprint trees are
// diffed at read time by GET /v1/hermeticity.
function mkFpSummary(
  runId: string,
  os: string,
  arch: string,
  files: Array<[string, string]> | undefined,
  tree: string,
): RunSummaryRecord {
  const base = mkSummary(runId)
  return {
    ...base,
    run: { ...base.run, os, arch, host: `host-${os}` },
    tasks: [
      {
        ...base.tasks[0]!,
        hash: 'shared-fp-key',
        outputFp: {
          tree,
          fileCount: files?.length ?? 1,
          ...(files !== undefined ? { files } : { truncated: true }),
        },
      },
    ],
  }
}

describe('vx serve /v1/hermeticity', () => {
  it('diffs two platforms for one key, naming the diverging rels', async () => {
    const root = await makeWorkspace()
    const server = await startServe({ root })
    try {
      await push(
        server.origin,
        mkFpSummary(
          'fp-run-1',
          'linux',
          'x64',
          [
            ['dist/app.js', 'aa'],
            ['dist/meta.json', '11'],
          ],
          't-linux',
        ),
      )
      await push(
        server.origin,
        mkFpSummary(
          'fp-run-2',
          'darwin',
          'arm64',
          [
            ['dist/app.js', 'bb'],
            ['dist/meta.json', '11'],
          ],
          't-darwin',
        ),
      )
      const res = (await (await fetch(`${server.origin}/v1/hermeticity`)).json()) as {
        divergent: Array<{
          hash: string
          taskId: string
          crossPlatform: boolean
          changed: string[]
          changedComplete: boolean
          reports: Array<{ os: string; arch: string; tree: string; runId: string }>
        }>
        keysTracked: number
        reportCount: number
      }
      expect(res.keysTracked).toBe(1)
      expect(res.reportCount).toBe(2)
      expect(res.divergent.length).toBe(1)
      const d = res.divergent[0]!
      expect(d.hash).toBe('shared-fp-key')
      expect(d.taskId).toBe('demo#hello')
      expect(d.crossPlatform).toBe(true)
      expect(d.changed).toEqual(['dist/app.js'])
      expect(d.changedComplete).toBe(true)
      expect(d.reports.map((r) => `${r.os}-${r.arch}`).sort()).toEqual([
        'darwin-arm64',
        'linux-x64',
      ])
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('single-platform / fp-free data → empty divergence; unknown ?ws= → 404', async () => {
    const root = await makeWorkspace()
    const server = await startServe({ root })
    try {
      // An fp-free (older-core) summary ingests fine…
      await push(server.origin, mkSummary('plain-run'))
      // …and one single-platform fp report is not divergence.
      await push(server.origin, mkFpSummary('fp-run-1', 'linux', 'x64', [['out.txt', 'aa']], 't1'))
      const res = (await (await fetch(`${server.origin}/v1/hermeticity`)).json()) as {
        divergent: unknown[]
        keysTracked: number
        reportCount: number
      }
      expect(res.divergent).toEqual([])
      expect(res.keysTracked).toBe(1)
      expect(res.reportCount).toBe(1)

      const unknown = await fetch(`${server.origin}/v1/hermeticity?ws=nope`)
      expect(unknown.status).toBe(404)
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('is bearer-gated like every /v1 read', async () => {
    const root = await makeWorkspace()
    const server = await startServe({ root, token: 'sekret' })
    try {
      const noToken = await fetch(`${server.origin}/v1/hermeticity`)
      expect(noToken.status).toBe(401)
      const ok = await fetch(`${server.origin}/v1/hermeticity`, {
        headers: { authorization: 'Bearer sekret' },
      })
      expect(ok.status).toBe(200)
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects an oversized POST /v1/ingest with 413 (declared content-length)', async () => {
    const root = await makeWorkspace()
    const server = await startServe({ root })
    try {
      // 33 MiB body — over the 32 MiB ingest cap; fetch sets content-length,
      // and the route rejects before parsing.
      const big = `{"pad":"${'x'.repeat(33 * 1024 * 1024)}"}`
      const res = await fetch(`${server.origin}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: big,
      })
      expect(res.status).toBe(413)
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects an oversized chunked POST /v1/ingest (no content-length to spoof)', async () => {
    const root = await makeWorkspace()
    const server = await startServe({ root })
    try {
      // A ReadableStream body sends `Transfer-Encoding: chunked` with NO
      // content-length, so the header pre-check reads 0 and passes — the
      // actual-byte re-check after reading must still 413 it.
      const chunk = 'x'.repeat(1024 * 1024) // 1 MiB
      const big = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`{"pad":"`))
          for (let i = 0; i < 40; i++) controller.enqueue(new TextEncoder().encode(chunk))
          controller.enqueue(new TextEncoder().encode(`"}`))
          controller.close()
        },
      })
      const res = await fetch(`${server.origin}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: big,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' })
      expect(res.status).toBe(413)
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })
})
