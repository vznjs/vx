// A cache server that redirects to another origin must not receive the
// token there: both plugins hand the redirect to the runtime's fetch, which
// drops `Authorization` across origins. 127.0.0.1 and localhost on one port
// are two origins; the same-origin control proves the row sees a token.

import { afterAll, beforeAll, expect, it } from 'bun:test'
import {
  NxRemoteCache,
  resolveNxCacheConfig,
  resolveTurboCacheConfig,
  TurboRemoteCache,
} from '../src/index.js'

const TOKEN = 'secret-token'
const seen: { method: string; auth: string | null }[] = []
let redirectHost = ''
let srv: ReturnType<typeof Bun.serve>

beforeAll(() => {
  srv = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url)
      if (u.pathname.startsWith('/moved/')) {
        seen.push({ method: req.method, auth: req.headers.get('authorization') })
        return req.method === 'GET' ? new Response('', { status: 404 }) : new Response('{}')
      }
      return Response.redirect(
        `http://${redirectHost}:${srv.port}/moved${u.pathname}${u.search}`,
        307,
      )
    },
  })
})
afterAll(() => srv.stop())

const clients = {
  'nxCache()': () =>
    new NxRemoteCache(
      resolveNxCacheConfig({ server: `http://127.0.0.1:${srv.port}`, accessToken: TOKEN }, {})!,
    ),
  'turboCache()': () =>
    new TurboRemoteCache(
      resolveTurboCacheConfig(
        { apiUrl: `http://127.0.0.1:${srv.port}`, token: TOKEN, teamId: 'team_1' },
        {},
      )!,
    ),
}

for (const [name, client] of Object.entries(clients)) {
  for (const [host, auth] of [
    ['localhost', null],
    ['127.0.0.1', `Bearer ${TOKEN}`],
  ] as const) {
    it(`${name}: a redirect to ${host} ${auth ? 'keeps' : 'drops'} the token`, async () => {
      seen.length = 0
      redirectHost = host
      const c = client()
      await c.get('aa11')
      await c.put('aa11', new Blob(['x']), { durationMs: 1 })
      expect(seen).toEqual([
        { method: 'GET', auth },
        { method: 'PUT', auth },
      ])
    })
  }
}
