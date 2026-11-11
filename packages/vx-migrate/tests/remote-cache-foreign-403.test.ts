// A 403 is the token's verdict only from a host the token went to. A
// storage URL reached by a cross-origin redirect (the runtime drops
// `Authorization` there) or by a preflight `Location` that did not admit the
// token never saw it: its 403 (an expired signed URL) fails that request
// alone. It turned the remote off and deleted the keychain token. The
// same-origin rows prove the test sees a real refusal. 127.0.0.1 and
// localhost on one port are two origins.

import { afterAll, beforeAll, expect, it } from 'bun:test'
import type { RemoteOpenContext } from '@vzn/vx'
import { NxRemoteCache, resolveNxCacheConfig } from '../src/nx-cache/index.js'
import { resolveTurboCacheConfig, TurboRemoteCache } from '../src/turbo-cache/index.js'

let host = ''
let srv: ReturnType<typeof Bun.serve>
const store: { method: string; auth: string | null }[] = []

beforeAll(() => {
  srv = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url)
      if (u.pathname.startsWith('/store/')) {
        store.push({ method: req.method, auth: req.headers.get('authorization') })
        return new Response('Request has expired', { status: 403 })
      }
      const to = `http://${host}:${srv.port}/store${u.pathname}`
      if (req.method === 'OPTIONS')
        return new Response(null, {
          headers: {
            location: to,
            'access-control-allow-headers': host === '127.0.0.1' ? 'Authorization' : 'content-type',
          },
        })
      return Response.redirect(to, 307)
    },
  })
})
afterAll(() => srv.stop())

function ctx() {
  const forgot: string[] = []
  const c: RemoteOpenContext = {
    ci: false,
    warn: () => {},
    secret: async () => 'secret-token',
    async forgetSecret({ key }) {
      forgot.push(key)
    },
  }
  return { c, forgot }
}

const url = () => `http://127.0.0.1:${srv.port}`
const clients = {
  'nxCache()': () => new NxRemoteCache(resolveNxCacheConfig({ url: url() }, {})!),
  'turboCache()': () =>
    new TurboRemoteCache(resolveTurboCacheConfig({ url: url(), teamId: 'team_1' }, {})!),
  'turboCache() preflight': () =>
    new TurboRemoteCache(
      resolveTurboCacheConfig({ url: url(), teamId: 'team_1', preflight: true }, {})!,
    ),
}
const message = (p: Promise<unknown>) =>
  p.then(
    () => '(resolved)',
    (e: unknown) => (e as Error).message,
  )

for (const [name, client] of Object.entries(clients)) {
  it(`${name}: a 403 from a host the token never reached fails that request alone`, async () => {
    host = 'localhost'
    store.length = 0
    const k = ctx()
    const c = client()
    await c.open(k.c)
    for (const h of ['aa11', 'bb22']) expect(await message(c.get(h))).not.toContain('token')
    for (const h of ['aa11', 'bb22'])
      expect(await message(c.put(h, new Blob(['x']), { durationMs: 1 }))).not.toContain('token')
    expect(k.forgot).toEqual([])
    // turboCache() asks a HEAD before each upload.
    expect(store.filter((r) => r.method !== 'HEAD')).toEqual(
      ['GET', 'GET', 'PUT', 'PUT'].map((method) => ({ method, auth: null })),
    )
    expect(store.every((r) => r.auth === null)).toBe(true)
  })

  it(`${name}: a 403 from a host the token reached is the token's refusal`, async () => {
    host = '127.0.0.1'
    store.length = 0
    const k = ctx()
    const c = client()
    await c.open(k.c)
    expect(await message(c.get('aa11'))).toContain('removed it from the OS keychain')
    expect(k.forgot).toHaveLength(1)
    expect(store).toEqual([{ method: 'GET', auth: 'Bearer secret-token' }])
  })
}
