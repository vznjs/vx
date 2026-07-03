// The unix-socket transport (`serve --socket`): a second listener sharing the
// TCP fetch handler, whose requests bypass the token gate because the 0600
// socket's OS file permissions ARE the auth. The advertisement carries the
// socket path and the cloud() plugin's local auto-detect rung dials it.

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { stat, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { RunSummaryRecord, TelemetryContext, TelemetrySink } from '@vzn/vx'
import { parseServeArgs, startServe } from '../src/cli/serve.js'
import { defaultServeSocketPath, readServeInfo, serveInfoPath } from '../src/serve-info.js'
import { cloud } from '../src/plugin.js'

// Isolate the per-user serve advertisement at a temp path so test serves
// never clobber (or get discovered through) the real machine-level file.
const prevServeInfo = process.env['VX_CLOUD_SERVE_INFO']
beforeAll(() => {
  process.env['VX_CLOUD_SERVE_INFO'] = path.join(
    tmpdir(),
    `vx-serveinfo-socket-${process.pid}.json`,
  )
})
afterAll(async () => {
  await rm(serveInfoPath(), { force: true })
  if (prevServeInfo === undefined) delete process.env['VX_CLOUD_SERVE_INFO']
  else process.env['VX_CLOUD_SERVE_INFO'] = prevServeInfo
})

function fakeSummary(runId: string): RunSummaryRecord {
  return {
    v: 2,
    run: {
      runId,
      vxVersion: '0.0.0',
      workspaceId: 'ws-sock',
      workspaceName: 'socket-fixture',
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
    startedAt: Date.now() - 1000,
    endedAt: Date.now(),
    totalDurationMs: 1000,
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

describe('vx serve --socket', () => {
  it('serves the same API over the socket, BYPASSING the token gate', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'vx-sock-'))
    const socketPath = path.join(dir, 'serve.sock')
    const server = await startServe({ root: dir, ingestDir: dir, token: 'sekret', socketPath })
    try {
      // TCP without the token → 401.
      const tcp = await fetch(`${server.origin}/v1/runs`)
      expect(tcp.status).toBe(401)

      // The SAME GET over the unix socket → 200 (file permissions are auth).
      const sock = await fetch('http://localhost/v1/runs', { unix: socketPath })
      expect(sock.status).toBe(200)
      const body = (await sock.json()) as { runs: unknown[] }
      expect(Array.isArray(body.runs)).toBe(true)

      // The socket is owner-only.
      const mode = (await stat(socketPath)).mode & 0o777
      expect(mode).toBe(0o600)

      // The advertisement carries the socket path.
      expect(readServeInfo()?.socket).toBe(socketPath)
      expect(server.socketPath).toBe(socketPath)
    } finally {
      await server.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('removes the socket on shutdown and unlinks a stale one on boot', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'vx-sock-stale-'))
    const socketPath = path.join(dir, 'serve.sock')
    // A stale file at the socket path (a crashed previous serve) must not
    // block the bind.
    await writeFile(socketPath, 'stale')
    const server = await startServe({ root: dir, ingestDir: dir, socketPath })
    try {
      const res = await fetch('http://localhost/health', { unix: socketPath })
      expect(await res.text()).toBe('ok')
    } finally {
      await server.stop()
    }
    // Gone after shutdown, alongside the advertisement.
    expect(await Bun.file(socketPath).exists()).toBe(false)
    await rm(dir, { recursive: true, force: true })
  })

  it('the cloud() plugin auto-detect pushes over the advertised socket', async () => {
    const saved: Record<string, string | undefined> = {}
    for (const k of ['VX_CLOUD_INGEST_URL', 'VX_CLOUD_INSIGHTS_URL', 'VX_CLOUD_CONFIG']) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
    // No environments file → the env rung declines and auto-detect runs.
    process.env['VX_CLOUD_CONFIG'] = path.join(tmpdir(), `vx-sock-noenvs-${process.pid}.json`)
    const dir = await mkdtemp(path.join(tmpdir(), 'vx-sock-push-'))
    const socketPath = path.join(dir, 'serve.sock')
    // Token-gated serve + a token-less sink: a TCP push would 401 and the run
    // would never land, so a stored run PROVES the push went over the socket.
    const server = await startServe({ root: dir, ingestDir: dir, token: 'sekret', socketPath })
    try {
      // The serve advertises its own pid; rewrite with a different-but-alive
      // pid so the plugin's self-push guard doesn't decline (the serve runs
      // inside this test process).
      const info = readServeInfo()!
      await writeFile(serveInfoPath(), JSON.stringify({ ...info, pid: process.ppid }))

      const ctx: TelemetryContext = {
        workspaceRoot: dir,
        cacheDir: path.join(dir, '.vx', 'cache'),
        warn: () => {},
      }
      const sink = (await cloud().telemetry!(ctx)) as TelemetrySink
      expect(sink).toBeDefined()
      sink.onRunSummary!(fakeSummary('run-over-socket'))
      await sink.flush!()

      const res = await fetch('http://localhost/v1/runs', { unix: socketPath })
      const body = (await res.json()) as { runs: { runId: string | null }[] }
      expect(body.runs.some((r) => r.runId === 'run-over-socket')).toBe(true)
    } finally {
      await server.stop()
      await rm(dir, { recursive: true, force: true })
      await rm(process.env['VX_CLOUD_CONFIG']!, { force: true })
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })
})

describe('parseServeArgs --socket', () => {
  it('parses the bare flag, an inline path, and a following path', () => {
    expect(parseServeArgs([]).socket).toBeUndefined()
    expect(parseServeArgs(['--socket']).socket).toBe(true)
    expect(parseServeArgs(['--socket', '/tmp/x.sock']).socket).toBe('/tmp/x.sock')
    expect(parseServeArgs(['--socket=/tmp/y.sock']).socket).toBe('/tmp/y.sock')
    // Bare --socket followed by another flag keeps both.
    const both = parseServeArgs(['--socket', '--ui'])
    expect(both.socket).toBe(true)
    expect(both.ui).toBe(true)
    expect(parseServeArgs(['--socket=']).error).toMatch(/invalid --socket/)
  })
})

describe('defaultServeSocketPath', () => {
  it('lives beside the serve advertisement in the per-user runtime dir', () => {
    expect(defaultServeSocketPath().endsWith('serve.sock')).toBe(true)
    expect(path.basename(path.dirname(defaultServeSocketPath()))).toContain('vx-cloud')
  })
})
