// Integration: vx insights serve's tiny static server for cache.db.
// Boots the static server against a temp file and verifies it streams
// the bytes with the right MIME + CORS headers.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { startStaticServer } from '../src/cli/index.js'

describe('vx insights — static cache.db server', () => {
  it('serves cache.db with correct content-type + CORS', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vx-insights-static-'))
    const dbPath = path.join(dir, 'cache.db')
    const bytes = new Uint8Array(Array.from('SQLite format 3\0', (c) => c.charCodeAt(0)))
    await Bun.write(dbPath, bytes)

    const server = startStaticServer(dbPath)
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/cache.db`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('application/vnd.sqlite3')
      expect(res.headers.get('access-control-allow-origin')).toBe('*')
      const body = new Uint8Array(await res.arrayBuffer())
      expect(body.byteLength).toBe(bytes.byteLength)
      // First bytes of a SQLite header
      expect(new TextDecoder().decode(body).startsWith('SQLite format 3')).toBe(true)
    } finally {
      server.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns /health → 200', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vx-insights-static-h-'))
    const dbPath = path.join(dir, 'cache.db')
    await Bun.write(dbPath, new Uint8Array([0]))
    const server = startStaticServer(dbPath)
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/health`)
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('ok')
    } finally {
      server.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns 404 for unknown paths', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vx-insights-static-n-'))
    const dbPath = path.join(dir, 'cache.db')
    await Bun.write(dbPath, new Uint8Array([0]))
    const server = startStaticServer(dbPath)
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/nope`)
      expect(res.status).toBe(404)
    } finally {
      server.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
