// GitHub's OIDC endpoint, faked: what the layer does with each answer.

import { expect, it } from 'bun:test'
import { VxCacheLayer } from '../src/index.js'

const TOKEN_URL = 'https://token.example/ask'

/** A fetch answering GitHub's endpoint `status`, counting the bodies left unread. */
function endpoint(status: number) {
  const open = new Set<number>()
  let n = 0
  const fetchImpl: typeof fetch = Object.assign(
    () => {
      const id = n++
      open.add(id)
      // Pulled only as it is read: unread, it stays open.
      const body = new ReadableStream(
        {
          pull(c) {
            c.enqueue(new TextEncoder().encode('{"message":"no"}'))
            c.close()
            open.delete(id)
          },
          cancel: () => void open.delete(id),
        },
        { highWaterMark: 0 },
      )
      return Promise.resolve(new Response(body, { status }))
    },
    { preconnect: fetch.preconnect },
  )
  const layer = new VxCacheLayer(
    {
      url: 'https://cache.example',
      issuer: 'https://token.actions.githubusercontent.com',
      repository: 'acme/app',
      timeoutMs: 5_000,
      uploadTimeoutMs: 5_000,
      headers: {},
    },
    fetchImpl,
    { ACTIONS_ID_TOKEN_REQUEST_URL: TOKEN_URL, ACTIONS_ID_TOKEN_REQUEST_TOKEN: 't' },
    async () => {},
  )
  layer.refs = ['refs/heads/main']
  return { layer, open, asked: () => n }
}

// A refusal, or a 5xx past the last try, threw with its body unread,
// holding its connection.
it("releases the body of GitHub's refusal, and of its last 5xx", async () => {
  for (const [status, asks] of [
    [403, 1],
    [503, 3],
  ] as const) {
    const { layer, open, asked } = endpoint(status)
    await expect(layer.has('aa')).rejects.toThrow(`GitHub's OIDC endpoint: HTTP ${status}`)
    expect([asked(), open.size]).toEqual([asks, 0])
  }
})
