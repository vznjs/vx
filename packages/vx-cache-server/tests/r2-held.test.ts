// Whether R2 holds an artifact, kept in the data center's cache: a repeat
// check, HEAD or upload skip there answers without an R2 head. Only
// "held" is kept, and never past the day R2's lifecycle rule may drop the
// object, so a marker never says "held" of an artifact R2 expired.

import { expect, it } from 'bun:test'
import { type R2Bucket, r2Blobs } from '../src/worker.js'

const DAY = 86_400

// workerd's FixedLengthStream, its length unchecked: tests/r2-put.test.ts checks it.
Object.assign(globalThis, {
  FixedLengthStream: class extends TransformStream {
    constructor(_length: number) {
      super()
    }
  },
})

function fixture(uploadedAgo: number | null) {
  const heads: string[] = []
  const bucket: R2Bucket = {
    put: async (_name, body) => void (await new Response(body).arrayBuffer()),
    get: async () => null,
    head: async (name) => {
      heads.push(name)
      return uploadedAgo === null
        ? null
        : { size: 5, uploaded: new Date(Date.now() - uploadedAgo * 1000) }
    },
  }
  const held = new Map<string, Response>()
  const cache: Awaited<Parameters<typeof r2Blobs>[1]> = {
    match: async (key: Request) => {
      const res = held.get(key.url)
      return res === undefined ? undefined : new Response(null, { headers: res.headers })
    },
    put: async (key: Request, res: Response) => void held.set(key.url, res),
    delete: async (key: Request) => held.delete(key.url),
  }
  const later: Promise<unknown>[] = []
  const blobs = (expiryDays?: number) =>
    r2Blobs(bucket, Promise.resolve(cache), { waitUntil: (p) => void later.push(p) }, expiryDays)
  const settle = () => Promise.all(later.splice(0))
  const maxAge = () =>
    [...held.values()].map((r) => Number(/max-age=(\d+)/.exec(r.headers.get('cache-control')!)![1]))
  return { heads, blobs, settle, maxAge }
}

it('answers a repeat lookup of a held artifact without R2, until R2 may expire it', async () => {
  const f = fixture(3600)
  const blobs = f.blobs(1)
  expect(await blobs.size('a/b/c/d')).toBe(5)
  await f.settle()
  expect(await blobs.size('a/b/c/d')).toBe(5)
  expect(f.heads).toEqual(['a/b/c/d'])
  // Written an hour ago under a 1-day rule: kept 23 hours, not a day.
  const [age] = f.maxAge()
  expect(age).toBeGreaterThan(DAY - 3600 - 5)
  expect(age).toBeLessThanOrEqual(DAY - 3600)
})

it('asks R2 again on every miss: a kept "missing" would hide a later upload', async () => {
  const f = fixture(null)
  const blobs = f.blobs(1)
  expect(await blobs.size('a/b/c/d')).toBeNull()
  await f.settle()
  expect(await blobs.size('a/b/c/d')).toBeNull()
  expect(f.heads).toHaveLength(2)
  expect(f.maxAge()).toEqual([])
})

it('keeps nothing of an object past its expiry that R2 has not dropped yet', async () => {
  const f = fixture(2 * DAY)
  const blobs = f.blobs(1)
  expect(await blobs.size('a/b/c/d')).toBe(5)
  await f.settle()
  expect(await blobs.size('a/b/c/d')).toBe(5)
  expect(f.heads).toHaveLength(2)
  expect(f.maxAge()).toEqual([])
})

it('marks an upload held for the whole expiry, so its first check skips R2', async () => {
  const f = fixture(null)
  const blobs = f.blobs(1)
  await blobs.put('a/b/c/d', new Blob(['bytes']).stream(), 5)
  await f.settle()
  expect(await blobs.size('a/b/c/d')).toBe(5)
  expect(f.heads).toEqual([])
  const [age] = f.maxAge()
  expect(age).toBeGreaterThan(DAY - 5)
  expect(age).toBeLessThanOrEqual(DAY)
})

it('asks R2 every time while no expiry is set', async () => {
  const f = fixture(3600)
  const blobs = f.blobs()
  await blobs.put('a/b/c/d', new Blob(['bytes']).stream(), 5)
  expect(await blobs.size('a/b/c/d')).toBe(5)
  await f.settle()
  expect(await blobs.size('a/b/c/d')).toBe(5)
  expect(f.heads).toHaveLength(2)
  expect(f.maxAge()).toEqual([])
})
