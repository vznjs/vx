// The unix-socket transport (`serve --socket`): a second listener sharing the
// TCP fetch handler, whose requests bypass the token gate because the 0600
// socket's OS file permissions ARE the auth.

import { describe, it, expect } from 'bun:test'
import { stat, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { defaultServeSocketPath, parseServeArgs, startServe } from '../src/cli/serve.js'

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
    // Gone after shutdown.
    expect(await Bun.file(socketPath).exists()).toBe(false)
    await rm(dir, { recursive: true, force: true })
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
  it('lives in the per-user runtime dir', () => {
    expect(defaultServeSocketPath().endsWith('serve.sock')).toBe(true)
    expect(path.basename(path.dirname(defaultServeSocketPath()))).toContain('vx-cloud')
  })
})
