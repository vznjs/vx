// The Worker's R2 read, with the data center's cache beside it. On Workers
// a tee'd stream is read at the pace of its slower branch, so the client's
// download moved at the cache write's pace: main's DTE run read one artifact
// for 19 minutes, then failed with "no bytes for 30000 ms" (2026-10-28).

import { expect, it } from 'bun:test'
import { r2Blobs, type R2Bucket } from '../src/worker.js'

it("serves a read from R2 alone, the data center's copy from a read of its own", async () => {
  const bytes = new TextEncoder().encode('artifact bytes')
  const bodies: ReadableStream<Uint8Array>[] = []
  const bucket: R2Bucket = {
    put: async () => undefined,
    head: async () => ({ size: bytes.byteLength }),
    get: async () => {
      const body = new Blob([bytes]).stream()
      bodies.push(body)
      return { body, size: bytes.byteLength }
    },
  }
  const copies: Response[] = []
  const cache = {
    match: async () => undefined,
    put: async (_key: Request, res: Response) => void copies.push(res),
  }
  const later: Promise<unknown>[] = []
  const blobs = r2Blobs(bucket, Promise.resolve(cache), { waitUntil: (p) => void later.push(p) })
  const got = await blobs.get('a/b/c/d')
  expect(got?.size).toBe(bytes.byteLength)
  // The client's body is R2's own stream, shared with no other reader.
  expect(got?.body).toBe(bodies[0]!)
  expect(await new Response(got!.body).text()).toBe('artifact bytes')
  await Promise.all(later)
  expect(bodies).toHaveLength(2)
  expect(await copies[0]!.text()).toBe('artifact bytes')
})
