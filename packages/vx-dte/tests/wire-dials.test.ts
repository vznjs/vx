// The relay client's dials: how long it tries a relay that answers nothing,
// and what it says when it gives up.

import { afterEach, expect, it } from 'bun:test'
import { serveRelay } from '@vzn/vx-dte-server'
import { join } from '../src/wire.js'
import { R, cleanUp, servers } from './relay-sockets.js'

afterEach(cleanUp)

// PR #4225's run (2026-10-24): a relay that held the socket and then the
// request took 10 s each, and the run failed after 21 s on a bare "The
// operation timed out".
it('gives up on a relay that answers nothing in 10 s in all, and names it', async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    // Bun's 10 s default closed the held request first: ECONNRESET at 9.4 s (CI, 2026-11-10).
    idleTimeout: 0,
    fetch: () => new Promise<Response>(() => {}),
  })
  servers.push({ url: '', stop: () => server.stop(true) })
  const url = `http://127.0.0.1:${server.port}`
  const at = performance.now()
  await expect(join(url, R, 'worker', null, undefined)).rejects.toThrow(
    `cannot connect to the relay ${url}: no answer in 10 s`,
  )
  expect(performance.now() - at).toBeLessThan(11_000)
}, 30_000)

// PR #5082's CI (2026-11-07): a Mac worker's dials failed at once, four
// in about 2 s, and it gave up saying "no answer in 10 s": the retries
// spent a fifth of the 10 s, and the words named a wait that never was.
it('spreads its dials over the 10 s, so a relay down for 3 s is still joined', async () => {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() })
  const port = probe.port!
  await probe.stop(true)
  const up = Bun.sleep(3_000).then(() => {
    const s = serveRelay({ hostname: '127.0.0.1', port })
    servers.push(s)
  })
  const a = await join(`http://127.0.0.1:${port}`, R, 'orchestrator', null, undefined)
  await up
  await a.leave()
}, 30_000)

it('says why its dials failed, and how many in how long, not a wait that never was', async () => {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() })
  const url = `http://127.0.0.1:${probe.port}`
  await probe.stop(true)
  const err = (await join(url, R, 'worker', null, undefined).catch((e: unknown) => e)) as Error
  expect(err.message).toMatch(
    new RegExp(`^cannot connect to the relay ${url}: ECONNREFUSED, 4 dials in \\d+\\.\\d s$`),
  )
}, 30_000)

// A token that could not be had was said as a relay that never answered,
// "no answer in 10 s", with the relay up and never asked, after asking
// the token's source, which tries again itself, three more times.
it('says a token it could not get as that, not as a relay that did not answer', async () => {
  const s = serveRelay({ hostname: '127.0.0.1', port: 0 })
  servers.push(s)
  let asked = 0
  const token = (): Promise<string> => (
    asked++,
    Promise.reject(new Error("GitHub's OIDC token: 403"))
  )
  const err = await join(s.url, R, 'orchestrator', null, token).catch((e: unknown) => e)
  expect([(err as Error).message, asked]).toEqual(["GitHub's OIDC token: 403", 1])
})
