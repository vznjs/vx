// Integration tests for the JSON-RPC 2.0 envelope mounts added to vx
// serve: GET /version, GET /events (SSE), GET /stream (NDJSON), and
// the WS endpoint accepting BOTH legacy t-discriminated and new
// envelope frames.

import { describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  decodeEnvelope,
  isEnvelope,
  isNotification,
  makeRequest,
  WIRE_PROTOCOL_VERSION,
} from '@vzn/vx'
import { startServe } from '../src/cli/serve.js'

async function setupWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'vx-serve-transport-'))
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'root', workspaces: ['pkg'] }),
  )
  await mkdir(path.join(root, 'pkg'), { recursive: true })
  await writeFile(path.join(root, 'pkg/package.json'), JSON.stringify({ name: 'pkg' }))
  await writeFile(
    path.join(root, 'pkg/vx.config.mjs'),
    `export default { tasks: { hi: { exec: { command: 'echo ok' } } } }`,
  )
  // git init for input enumeration
  await Bun.spawn(['git', 'init', '-q'], { cwd: root }).exited
  await Bun.spawn(['git', 'add', '-A'], { cwd: root }).exited
  await Bun.spawn(
    ['git', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'],
    { cwd: root },
  ).exited
  return root
}

describe('vx serve — /version', () => {
  let root: string
  it('returns protocol version + capability list', async () => {
    root = await setupWorkspace()
    const server = await startServe({ root })
    try {
      const res = await fetch(`${server.origin}/version`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        protocol: string
        vx: string
        channels: string[]
        rpc: string[]
      }
      expect(body.protocol).toBe(WIRE_PROTOCOL_VERSION)
      expect(body.channels).toContain('vx:events')
      expect(body.channels).toContain('vx:rpc')
      expect(body.rpc.length).toBeGreaterThan(0)
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('vx serve — /events (SSE) + /stream (NDJSON)', () => {
  it('SSE broadcasts JSON-RPC envelopes from a delegated run', async () => {
    const root = await setupWorkspace()
    const server = await startServe({ root })
    try {
      const ctl = new AbortController()
      const events: string[] = []
      const ssePromise = (async () => {
        const res = await fetch(`${server.origin}/events`, { signal: ctl.signal })
        const reader = res.body!.getReader()
        const decoder = new TextDecoder()
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          const chunk = decoder.decode(value)
          for (const line of chunk.split('\n')) {
            const m = line.match(/^data: (.+)$/)
            if (m) events.push(m[1]!)
          }
        }
      })()
      // Trigger a delegated run over WS using the legacy frame.
      const ws = new WebSocket(server.origin.replace('http', 'ws'))
      await new Promise<void>((resolve) => (ws.onopen = () => resolve()))
      ws.send(
        JSON.stringify({
          t: 'run',
          request: { cwd: root, tasks: ['hi'], projects: ['pkg'] },
        }),
      )
      // Wait for the result frame.
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(reject, 10_000)
        ws.onmessage = (ev) => {
          const msg = JSON.parse(String(ev.data)) as { t: string }
          if (msg.t === 'result' || msg.t === 'error') {
            clearTimeout(t)
            resolve()
          }
        }
      })
      ws.close()
      // Pump SSE a moment, then abort.
      await Bun.sleep(50)
      ctl.abort()
      try {
        await ssePromise
      } catch {
        // expected: aborted
      }
      // We should have received at least one envelope. Notifications
      // (events.append) make up most of the stream; final result/error
      // arrive as responses — both are valid envelopes.
      expect(events.length).toBeGreaterThan(0)
      let sawNotification = false
      for (const raw of events) {
        const env = decodeEnvelope(raw)
        expect(isEnvelope(env)).toBe(true)
        if (isNotification(env)) sawNotification = true
      }
      expect(sawNotification).toBe(true)
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('vx serve — WS accepts both legacy and JSON-RPC envelope frames', () => {
  it('accepts a submit.run JSON-RPC envelope request', async () => {
    const root = await setupWorkspace()
    const server = await startServe({ root })
    try {
      const ws = new WebSocket(server.origin.replace('http', 'ws'))
      await new Promise<void>((resolve) => (ws.onopen = () => resolve()))
      // Send the new envelope form.
      ws.send(
        JSON.stringify(
          makeRequest(1, 'submit.run', { cwd: root, tasks: ['hi'], projects: ['pkg'] }),
        ),
      )
      const done = new Promise<{ t: string }>((resolve, reject) => {
        const t = setTimeout(reject, 10_000)
        ws.onmessage = (ev) => {
          const msg = JSON.parse(String(ev.data)) as { t: string }
          if (msg.t === 'result' || msg.t === 'error') {
            clearTimeout(t)
            resolve(msg)
          }
        }
      })
      const result = await done
      expect(result.t).toBe('result')
      ws.close()
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })
})
