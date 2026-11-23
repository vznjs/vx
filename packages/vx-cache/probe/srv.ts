// Probe server: the real cache server behind a fault switch read from a file.
import { readFileSync, existsSync } from 'node:fs'
import { oidcAuth } from '@vzn/vx-devtools'
import { createCacheServer } from '@vzn/vx-cache-server'
import { issuer, ALLOW, MAIN_JOB } from '../../vx-cache-server/tests/issuer.js'
import { memBlobs } from '../../vx-cache-server/tests/mem-blobs.js'
const iss = await issuer()
const blobs = new Map<string, Uint8Array>()
const handle = createCacheServer({
  blobs: memBlobs(blobs),
  authorize: oidcAuth({ allow: ALLOW, fetchJson: (u) => iss.fetchJson(u) }),
  limits: { maxUploadBytes: 1 << 30 },
})
const MODE = process.argv[2]!
const mode = () => (existsSync(MODE) ? readFileSync(MODE, 'utf8').trim() : '')
const srv = Bun.serve({
  port: 0, hostname: '127.0.0.1', idleTimeout: 0, maxRequestBodySize: 2 ** 31,
  fetch: async (req) => {
    const m = mode(); const p = new URL(req.url).pathname
    const get = req.method === 'GET' && p.startsWith('/v1/artifacts/')
    const put = req.method === 'PUT'
    const check = req.method === 'POST'
    console.error(`[srv] ${m || '-'} ${req.method} ${p}`)
    if (m === 'get500' && get) return new Response('boom', { status: 500 })
    if (m === 'get404' && get) return new Response('gone', { status: 404 })
    if (m === 'gethang' && get) return new Promise(() => {})
    if (m === 'check500' && check) return new Response('boom', { status: 500 })
    if (m === 'checkhang' && check) return new Promise(() => {})
    if (m === 'put500' && put) return new Response('boom', { status: 500 })
    if (m === 'puthang' && put) return new Promise(() => {})
    if (m === 'put401' && put) return new Response('{"error":"token expired"}', { status: 401 })
    if (m === 'all401') return new Response('{"error":"token expired"}', { status: 401 })
    if (m === 'getgarbage' && get) return new Response(crypto.getRandomValues(new Uint8Array(5000)))
    if (m === 'getempty' && get) return new Response(new Uint8Array(0))
    if (m === 'checkbadjson' && check) return new Response('{"x":', { headers: { 'content-type': 'application/json' } })
    if (m === 'checkwrong' && check) { const b = await req.clone().json() as {hashes:string[]}; return Response.json(Object.fromEntries(b.hashes.map(h => [h, { size: 10, scope: 'x' }]))) }
    if (m === 'html' ) return new Response('<html>captive portal</html>', { headers: { 'content-type': 'text/html' } })
    return handle(req as never)
  },
})
console.log(srv.url.href.replace(/\/$/, ''))
console.log(await iss.sign(MAIN_JOB, srv.url.origin))
