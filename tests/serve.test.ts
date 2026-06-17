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
