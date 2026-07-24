// readTextBounded — the shared streaming body cap used by the artifact PUT,
// the cache batch probe, ingest/logs/catalog, and MCP.

import { describe, it, expect } from 'bun:test'
import { readTextBounded } from '../src/http-body.js'

describe('readTextBounded', () => {
  it('returns the body under the cap', async () => {
    const req = new Request('http://x', { method: 'POST', body: 'hello' })
    expect(await readTextBounded(req, 1024)).toBe('hello')
  })

  it('returns null (→ 413) for a body over the cap', async () => {
    const req = new Request('http://x', { method: 'POST', body: 'x'.repeat(2048) })
    expect(await readTextBounded(req, 1024)).toBeNull()
  })

  it('aborts a CHUNKED (no content-length) body mid-stream at the cap', async () => {
    // A ReadableStream body carries no content-length, so the cap can only be
    // enforced by streaming + aborting — the exact bypass the fix closes.
    let pulled = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        if (pulled > 1000) {
          controller.close()
          return
        }
        controller.enqueue(new Uint8Array(1024)) // 1 KiB per pull
      },
    })
    const req = new Request('http://x', { method: 'POST', body, duplex: 'half' } as RequestInit)
    expect(await readTextBounded(req, 4096)).toBeNull()
    // It stopped pulling shortly after crossing the 4 KiB cap — it did NOT
    // drain all ~1 MiB the producer would have emitted.
    expect(pulled).toBeLessThan(20)
  })

  it('enforces the cap on BYTE length, not code-unit length', async () => {
    // A 2-byte UTF-8 char: 3 chars = 6 bytes > a 5-byte cap.
    const req = new Request('http://x', { method: 'POST', body: 'é'.repeat(3) })
    expect(await readTextBounded(req, 5)).toBeNull()
    const ok = new Request('http://x', { method: 'POST', body: 'é'.repeat(3) })
    expect(await readTextBounded(ok, 6)).toBe('é'.repeat(3))
  })
})
