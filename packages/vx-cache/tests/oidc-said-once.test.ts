// GitHub refusing the job's token: said once, as a refused token is.

import { expect, it } from 'bun:test'
import { VxCacheLayer } from '../src/index.js'

// Requests waiting on one ask each threw its failure: a check and two
// uploads said the same refusal three times.
it('says a token GitHub would not give once, to the requests waiting on it', async () => {
  let asked = 0
  const refusing: typeof fetch = Object.assign(
    () => {
      asked++
      return Promise.resolve(new Response('no', { status: 403 }))
    },
    { preconnect: fetch.preconnect },
  )
  const c = new VxCacheLayer(
    {
      url: 'https://cache.example',
      issuer: 'https://token.actions.githubusercontent.com',
      repository: 'acme/app',
      timeoutMs: 5_000,
      uploadTimeoutMs: 5_000,
      headers: {},
    },
    refusing,
    {
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.example/ask',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 't',
    },
    async () => {},
  )
  c.refs = ['refs/heads/main']
  const settled = await Promise.allSettled([
    c.has('a1'),
    c.put('a2', new Blob(['x']), { durationMs: 1 }),
    c.put('a3', new Blob(['y']), { durationMs: 1 }),
  ])
  expect(settled.filter((s) => s.status === 'rejected').map((s) => String(s.reason))).toEqual([
    "Error: GitHub's OIDC endpoint: HTTP 403: no; remote cache off for this run",
  ])
  expect(asked).toBe(1)
  expect(await c.has('a4')).toBeNull()
})
