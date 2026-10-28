// src/worker.ts's R2 put, its stream checked by a stand-in for workerd's
// FixedLengthStream: a short body is the client's fault, R2's own failure
// the bucket's.

import { expect, it } from 'bun:test'
import { type R2Bucket, r2Blobs } from '../src/worker.js'

/** workerd's FixedLengthStream: errors at a length other than `length`. */
class FixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
  constructor(length: number) {
    let seen = 0
    super({
      transform(chunk, c) {
        seen += chunk.byteLength
        if (seen > length) throw new TypeError('too long')
        c.enqueue(chunk)
      },
      flush() {
        if (seen !== length) throw new TypeError('too short')
      },
    })
  }
}
Object.assign(globalThis, { FixedLengthStream })

const bucket = (fail?: Error): R2Bucket => ({
  put: async (_name, body) => {
    await new Response(body).arrayBuffer()
    if (fail !== undefined) throw fail
  },
  get: async () => null,
  head: async () => null,
})
const cache = Promise.resolve({ match: async () => undefined, put: async () => {} })
const body = (s: string) => new Blob([s]).stream()

it("refuses a body of another length 400, and answers R2's own failure as the bucket's", async () => {
  const short = r2Blobs(bucket(), cache, { waitUntil: () => {} }).put('n', body('ab'), 3)
  expect(await short.catch((e: { status?: number }) => e.status)).toBe(400)
  const down = r2Blobs(bucket(new Error('R2 is down')), cache, { waitUntil: () => {} })
  const err = await down.put('n', body('abc'), 3).catch((e: unknown) => e)
  expect([err instanceof Error && !('status' in err), (err as Error).message]).toEqual([
    true,
    'R2 is down',
  ])
})
