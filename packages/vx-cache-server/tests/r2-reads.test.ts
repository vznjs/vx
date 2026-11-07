// Each /v1/artifacts answer names where its reads came from: the data
// center's cache or R2 (`vx-reads: edge=<n>, bucket=<n>`), so a client
// can total a run's split at no cost (2026-11-07: a log line per answer
// doubled the Worker's log events, past the free 200k a day).

import { expect, it } from 'bun:test'
import { createCacheServer } from '../src/server.js'
import { type R2Bucket, r2Blobs } from '../src/worker.js'

const HASH = 'abcdef01'
const SCOPE = 'refs%2Fheads%2Fmain'

function server() {
  const bucket: R2Bucket = {
    put: async () => undefined,
    head: async (name) => (name.endsWith(HASH) ? { size: 5, uploaded: new Date() } : null),
    get: async (name) =>
      name.endsWith(HASH)
        ? { body: new Blob(['bytes']).stream(), size: 5, uploaded: new Date() }
        : null,
  }
  const held = new Map<string, { headers: Headers; bytes: ArrayBuffer }>()
  const cache = {
    match: async (key: Request) => {
      const r = held.get(key.url)
      return r === undefined ? undefined : new Response(r.bytes, { headers: r.headers })
    },
    put: async (key: Request, res: Response) =>
      void held.set(key.url, { headers: res.headers, bytes: await res.arrayBuffer() }),
    delete: async (key: Request) => held.delete(key.url),
  }
  const later: Promise<unknown>[] = []
  // A Worker makes the store per request, so its count is that request's.
  const answer = (req: Request) =>
    createCacheServer({
      blobs: r2Blobs(bucket, Promise.resolve(cache), { waitUntil: (p) => void later.push(p) }, 1),
      authorize: async () => ({ issuer: 'https://ci', repository: 'o/r', write: 'refs/heads/main' }),
    })(req)
  return { answer, settle: () => Promise.all(later.splice(0)) }
}

const get = (hash: string) =>
  new Request(`https://c/v1/artifacts/${hash}`, { headers: { 'vx-scope': SCOPE } })
const check = (hashes: string[]) =>
  new Request('https://c/v1/artifacts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hashes, scopes: [SCOPE] }),
  })

it('names R2 for a first read and the data center for a repeat', async () => {
  const s = server()
  const first = await s.answer(get(HASH))
  expect(first.headers.get('vx-reads')).toBe('edge=0, bucket=1')
  await first.arrayBuffer()
  await s.settle()
  const again = await s.answer(get(HASH))
  expect(again.headers.get('vx-reads')).toBe('edge=1, bucket=0')
  expect(await again.text()).toBe('bytes')
})

it("totals a check's lookups: a held mark answers, a miss asks R2", async () => {
  const s = server()
  await (await s.answer(check([HASH]))).json()
  await s.settle()
  const res = await s.answer(check([HASH, '12345678']))
  expect(res.headers.get('vx-reads')).toBe('edge=1, bucket=1')
})
