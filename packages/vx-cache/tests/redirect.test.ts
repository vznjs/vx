// A server answering a redirect: the protocol has none, and following one
// sent a proxy's secret headers to another origin.

import { afterAll, expect, it } from 'bun:test'
import { VxCacheLayer } from '../src/index.js'

const reached: Record<string, string | null>[] = []
const elsewhere = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch: (req) => {
    reached.push({ secret: req.headers.get('cf-access-client-secret') })
    return Response.json({ maxCheckHashes: 10, maxUploadBytes: 10 })
  },
})
const redirecting = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch: (req) =>
    Response.redirect(`http://localhost:${elsewhere.port}${new URL(req.url).pathname}`, 307),
})
afterAll(() => {
  void elsewhere.stop(true)
  void redirecting.stop(true)
})

it('follows no redirect, and names where it pointed', async () => {
  const c = new VxCacheLayer(
    {
      url: redirecting.url.href.replace(/\/$/, ''),
      issuer: 'https://token.actions.githubusercontent.com',
      repository: 'acme/app',
      timeoutMs: 5_000,
      uploadTimeoutMs: 5_000,
      headers: { 'CF-Access-Client-Secret': 'secret' },
    },
    fetch,
    { VX_CACHE_TOKEN: 'a.b.c' },
  )
  c.refs = ['refs/heads/main']
  await expect(c.has('aa')).rejects.toThrow(
    `HTTP 307, to http://localhost:${elsewhere.port}/v1/capabilities: vx-cache servers do not redirect; name the url it points to`,
  )
  await expect(c.put('aa', new Blob(['x']), { durationMs: 1 })).rejects.toThrow('HTTP 307, to')
  expect(reached).toEqual([])
})
