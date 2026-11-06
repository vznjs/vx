// R2 answers some reads with "please try again": 10001 (internal error)
// and 10058 (too many simultaneous reads of one object). The Worker asks
// again before it fails the request 502, and the copy it makes in the
// background never throws past waitUntil (2026-11-06: the Issues tab).

import { expect, it } from 'bun:test'
import { type R2Bucket, r2Blobs } from '../src/worker.js'
import workerConfig from '../wrangler.jsonc' with { type: 'text' }

const r2Error = (code: number) =>
  new Error(
    code === 10058
      ? `head: Reduce your rate of simultaneous reads on the same object. (${code})`
      : `get: We encountered an internal error. Please try again. (${code})`,
  )

function fixture(fails: (Error | null)[]) {
  const calls: string[] = []
  const answer = () => {
    const err = fails.shift()
    if (err) throw err
  }
  const bucket: R2Bucket = {
    put: async () => undefined,
    head: async () => {
      calls.push('head')
      answer()
      return { size: 5, uploaded: new Date() }
    },
    get: async () => {
      calls.push('get')
      answer()
      return { body: new Blob(['bytes']).stream(), size: 5, uploaded: new Date() }
    },
  }
  const cache = {
    match: async () => undefined,
    put: async () => undefined,
    delete: async () => false,
  }
  const later: Promise<unknown>[] = []
  const blobs = r2Blobs(bucket, Promise.resolve(cache), { waitUntil: (p) => void later.push(p) })
  return { calls, blobs, later }
}

it('asks R2 again on 10001 and 10058', async () => {
  const f = fixture([r2Error(10058), r2Error(10001)])
  expect(await f.blobs.size('a/b/c/d')).toBe(5)
  expect(f.calls).toEqual(['head', 'head', 'head'])
  const g = fixture([r2Error(10001)])
  expect((await g.blobs.get('a/b/c/d'))?.size).toBe(5)
  expect(g.calls[0]).toBe('get')
  expect(g.calls[1]).toBe('get')
})

it('fails after three tries, and on any other error at once', async () => {
  const f = fixture([r2Error(10001), r2Error(10001), r2Error(10001)])
  await expect(f.blobs.size('a/b/c/d')).rejects.toThrow('(10001)')
  expect(f.calls).toEqual(['head', 'head', 'head'])
  const g = fixture([new Error('head: Object name not valid (10020)')])
  await expect(g.blobs.size('a/b/c/d')).rejects.toThrow('(10020)')
  expect(g.calls).toEqual(['head'])
})

it("a failed background copy settles: the client's download already has its bytes", async () => {
  // The client's read succeeds; the copy's own read fails past its retries.
  const f = fixture([null, r2Error(10001), r2Error(10001), r2Error(10001)])
  const got = await f.blobs.get('a/b/c/d')
  expect(await new Response(got!.body).text()).toBe('bytes')
  expect(await Promise.allSettled(f.later)).toEqual([{ status: 'fulfilled', value: undefined }])
  expect(f.calls).toEqual(['get', 'get', 'get', 'get'])
})

it('clears any cron on deploy: the Worker exports no scheduled()', () => {
  expect(Bun.JSONC.parse(workerConfig as unknown as string)).toMatchObject({
    triggers: { crons: [] },
  })
})
