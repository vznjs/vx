// Integration tests for the JSON-RPC 2.0 envelope mounts on vx serve. The
// SSE/NDJSON-from-a-delegated-run and WS submit.run→result cases were REMOVED
// with run delegation (platform §12 P3): the transitional serve no longer
// executes `{t:'run'}`, so there is no server-side run to stream. The
// `/version` capability handshake survives (transitional, until P4 absorbs
// serve.ts into server.ts).

import { describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { WIRE_PROTOCOL_VERSION } from '@vzn/vx'
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
