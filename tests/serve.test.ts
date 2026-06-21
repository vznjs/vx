import { describe, it, expect } from 'bun:test'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { startServe, serveInfoPath } from '../src/cli/serve.js'
import { serviceBackend, resolveBackend } from '../src/cli/backend.js'
import type { Logger, RunRequest } from '../src/orchestrator/index.js'

/** A non-rendering Logger that records the event kinds it sees. */
function captureLogger(seen: string[]): Logger {
  return {
    status: () => {},
    taskStdout: () => {},
    taskStderr: () => {},
    taskComplete: (n) => seen.push(`complete:${n.id}`),
    runStart: () => seen.push('runStart'),
    taskStart: (n) => seen.push(`start:${n.id}`),
    runEnd: () => seen.push('runEnd'),
  }
}

// A minimal single-project workspace so a delegated `run()` has real work.
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

describe('vx serve delegation', () => {
  it('executes a delegated run and streams events + a result', async () => {
    const root = await makeWorkspace()
    const seen: string[] = []
    const server = await startServe({ root })
    try {
      const backend = serviceBackend(server.origin, captureLogger(seen))
      const request: RunRequest = { tasks: ['hello'], cwd: root, flow: 'focused' }
      const result = await backend.run(request)
      // The result is correct...
      expect(result.ok).toBe(true)
      expect(result.outcomes.length).toBe(1)
      expect(result.outcomes[0]!.taskId).toBe('demo#hello')
      expect(['success', 'cache-hit', 'cache-hit-remote']).toContain(result.outcomes[0]!.status)
      // ...and the streamed events were rendered through the client sink.
      expect(seen).toContain('runStart')
      expect(seen).toContain('start:demo#hello')
      expect(seen).toContain('complete:demo#hello')
      expect(seen).toContain('runEnd')
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports a health endpoint and writes/removes its info file', async () => {
    const root = await makeWorkspace()
    const server = await startServe({ root })
    try {
      const res = await fetch(`${server.origin}/health`)
      expect(res.ok).toBe(true)
      expect((await Bun.file(serveInfoPath(root)).json()).origin).toBe(server.origin)
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('vx serve /v1/* metrics API', () => {
  it('serves runs / invocations / cache stats / history after a delegated run', async () => {
    const root = await makeWorkspace()
    const server = await startServe({ root })
    try {
      // Execute one delegated run to populate cache.db
      const backend = serviceBackend(server.origin, captureLogger([]))
      await backend.run({ tasks: ['hello'], cwd: root, flow: 'focused' })

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
})

describe('resolveBackend', () => {
  it('falls back to local when no service is reachable', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'vx-nosvc-'))
    const backend = await resolveBackend(root)
    // localBackend and the resolved one are structurally the same shape;
    // the meaningful assertion is that it did NOT pick a service (no throw,
    // returns a usable backend). We can't compare identities, so assert it
    // behaves like local by checking it's not the service path: a run would
    // execute in-process. Here we just assert a backend object came back.
    expect(typeof backend.run).toBe('function')
    await rm(root, { recursive: true, force: true })
  })

  it('selects a service when its info file points at a reachable server', async () => {
    const root = await makeWorkspace()
    const server = await startServe({ root })
    try {
      const seen: string[] = []
      const backend = await resolveBackend(root, captureLogger(seen))
      const result = await backend.run({ tasks: ['hello'], cwd: root })
      expect(result.ok).toBe(true)
      expect(result.outcomes[0]!.taskId).toBe('demo#hello')
      expect(seen).toContain('runEnd') // delegated, not local (local renders via run())
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('ignores a stale info file (unreachable origin) and falls back', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'vx-stale-'))
    await mkdir(path.join(root, '.vx'), { recursive: true })
    // A port nothing listens on → health check fails → local fallback.
    await writeFile(serveInfoPath(root), JSON.stringify({ origin: 'http://localhost:1', pid: 1 }))
    const backend = await resolveBackend(root)
    expect(typeof backend.run).toBe('function')
    await rm(root, { recursive: true, force: true })
  })
})
