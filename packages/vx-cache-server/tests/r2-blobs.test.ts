// The Worker's R2 read, with the data center's cache beside it. On Workers
// a tee'd stream is read at the pace of its slower branch, so the client's
// download moved at the cache write's pace: main's DTE run read one artifact
// for 19 minutes, then failed with "no bytes for 30000 ms" (2026-10-28).

import { beforeEach, expect, it } from 'bun:test'
import { r2Blobs, type R2Bucket } from '../src/worker.js'

// workerd's FixedLengthStream, its length unchecked: tests/r2-put.test.ts checks it.
beforeEach(() => {
  Object.assign(globalThis, {
    FixedLengthStream: class extends TransformStream<Uint8Array, Uint8Array> {
      constructor(_length: number) {
        super()
      }
    },
  })
})

it("serves a read from R2 alone, the data center's copy from a read of its own", async () => {
  const bytes = new TextEncoder().encode('artifact bytes')
  const bodies: ReadableStream<Uint8Array>[] = []
  const bucket: R2Bucket = {
    put: async () => undefined,
    head: async () => ({ size: bytes.byteLength, uploaded: new Date() }),
    get: async () => {
      const body = new Blob([bytes]).stream()
      bodies.push(body)
      return { body, size: bytes.byteLength, uploaded: new Date() }
    },
  }
  const copies: Response[] = []
  const cache = {
    match: async () => undefined,
    put: async (_key: Request, res: Response) => void copies.push(res),
    delete: async () => false,
  }
  const later: Promise<unknown>[] = []
  const blobs = r2Blobs(bucket, Promise.resolve(cache), { waitUntil: (p) => void later.push(p) })
  // A small artifact read at once is not a slow download: 14 bytes in 0 ms
  // is under any rate, and every such read logged a line (2026-11-18).
  const said: string[] = []
  const warn = console.warn
  console.warn = (m: string) => void said.push(m)
  const got = await blobs.get('a/b/c/d')
  expect(got?.size).toBe(bytes.byteLength)
  // One reader of the object at a time: read beside the client's, both reads
  // of one 42 MB object ran at 150 to 300 KB/s for minutes (main, 2026-11-18).
  await Bun.sleep(20)
  expect(bodies).toHaveLength(1)
  expect(await new Response(got!.body).text()).toBe('artifact bytes')
  await Promise.all(later).finally(() => void (console.warn = warn))
  expect(bodies).toHaveLength(2)
  expect(await copies[0]!.text()).toBe('artifact bytes')
  expect(said).toEqual([])
})

it('makes no copy of a download the client left, and says how long it ran', async () => {
  const bucket: R2Bucket = {
    put: async () => undefined,
    head: async () => ({ size: 3, uploaded: new Date() }),
    get: async () => ({
      body: new ReadableStream<Uint8Array>({ pull: () => {} }),
      size: 3,
      uploaded: new Date(),
    }),
  }
  let reads = 0
  const counted: R2Bucket = { ...bucket, get: (n) => (reads++, bucket.get(n)) }
  const cache = { match: async () => undefined, put: async () => {}, delete: async () => false }
  const later: Promise<unknown>[] = []
  const blobs = r2Blobs(counted, Promise.resolve(cache), { waitUntil: (p) => void later.push(p) })
  const said: string[] = []
  const warn = console.warn
  console.warn = (m: string) => void said.push(m)
  try {
    const got = await blobs.get('a/b/c/d')
    await got!.body.cancel(new Error('client left'))
    await Promise.all(later)
  } finally {
    console.warn = warn
  }
  expect(reads).toBe(1)
  expect(said).toHaveLength(1)
  expect(said[0]).toMatch(/^vx-cache-server: a\/b\/c\/d \(3 bytes\) ended after \d+ ms: /)
})

// The S3 read guards a length it is not told (Number(null) is 0, and a
// client held to vx-size 0 read every hit as a miss); the data center's
// copy did not. One naming no length is skipped for R2's (2026-11-24).
it("reads R2 when the data center's copy names no length", async () => {
  const bytes = new TextEncoder().encode('artifact bytes')
  const bucket: R2Bucket = {
    put: async () => undefined,
    head: async () => ({ size: bytes.byteLength, uploaded: new Date() }),
    get: async () => ({
      body: new Blob([bytes]).stream(),
      size: bytes.byteLength,
      uploaded: new Date(),
    }),
  }
  const unsized = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })
  const cache = {
    match: async () => new Response(unsized),
    put: async () => undefined,
    delete: async () => false,
  }
  const later: Promise<unknown>[] = []
  const blobs = r2Blobs(bucket, Promise.resolve(cache), { waitUntil: (p) => void later.push(p) })
  const got = await blobs.get('a/b/c/d')
  expect(got?.size).toBe(bytes.byteLength)
  expect(await new Response(got!.body).text()).toBe('artifact bytes')
  await Promise.all(later)
})
