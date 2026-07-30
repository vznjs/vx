// `dispatch.ts` is the platform's single HTTP host — the cache wire, the batch
// probe, `/mcp`, `/v1/artifacts`, the agent + run WS upgrades, the SSE/NDJSON
// streams, and the SPA catch-all all hang off one `Bun.serve`. It is 563 lines
// reached ONLY as a fixture step (every suite that boots a platform runs
// through it; none pins its routing), and it has already produced two real
// defects that way: a cross-tenant SSE broadcast and a dropped CSWSH gate.
//
// These pin the routing RULES against a real booted platform.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { bootPlatform, type TestPlatform } from './helpers/platform.js'

describe('dispatch routing', () => {
  let p: TestPlatform
  beforeAll(async () => {
    p = await bootPlatform()
  })
  afterAll(async () => {
    await p.stop()
  })

  const asCi = () => ({ authorization: `Bearer ${p.ciToken}` })

  it('sends an unmatched /v1 path to the SPA catch-all — deliberately, at a cost', async () => {
    // Worth stating plainly, because it looks like a bug and is not.
    //
    // An unmatched `/v1/*` answers 200 with the SPA (here the bare sentinel,
    // no build in this fixture) rather than a JSON 404. That is load-bearing
    // in two directions: a route REMOVED from the platform must degrade to
    // the app instead of 500 (`server.test.ts` pins `/v1/graph`), and the
    // analytics allowlist must not become a catch-all (`analytics-route-
    // params.test.ts` pins the same shape from the router side).
    //
    // The COST is equally real and is why this carries a comment rather than a
    // shrug: `/v1/notifications`, `/v1/why/:runId` and `/v1/branch-failures`
    // each shipped MISSING from the gate's allowlist, and this fallthrough is
    // what hid it — the miss surfaced as a 200 whose body would not parse,
    // found late by a browser check instead of by the request failing.
    //
    // Turning it into a 404 was tried in this wave and REVERTED: it broke both
    // pins above plus five browser suites on console errors. The honest fix for
    // the allowlist class is a build-time check that every route the client
    // calls is actually routed — not a runtime refusal that breaks working
    // behaviour. Recorded here so the next reader does not re-try the refusal.
    const res = await fetch(`${p.origin}/v1/bogus-route`, { headers: asCi() })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).not.toContain('application/json')
  })

  it('still resolves a route that DOES exist', async () => {
    // The control that stops the 404 guard passing by breaking routing: if
    // this ever 404s, dispatch has stopped matching real routes and the test
    // above is meaningless.
    const res = await fetch(`${p.origin}/v1/artifacts`, { headers: asCi() })
    expect(res.status).toBe(200)
    expect(await res.json()).toHaveProperty('artifacts')
  })

  it('leaves NON-api paths to the SPA catch-all', async () => {
    // The other direction: the dashboard is a hash-routed SPA, so a deep link
    // is `/#/runs` and never looks like an API path. A bare path must still
    // reach the catch-all rather than 404 — narrowing the guard to `/v1/` is
    // what keeps both true.
    const res = await fetch(`${p.origin}/some/deep/spa/path`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).not.toContain('application/json')
  })

  it('serves /health before the gate, unauthenticated', async () => {
    // Liveness must not need a credential — the Docker HEALTHCHECK probes it,
    // and an orchestrator killing a healthy platform because auth moved is the
    // failure mode. Pinned so the gate can never grow to cover it.
    const res = await fetch(`${p.origin}/health`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })

  it('refuses a cross-origin browser handshake on every stream path', async () => {
    // The CSWSH gate keys on `Upgrade: websocket` for ANY path plus the three
    // stream paths by name. It was silently DROPPED once when serve.ts was
    // folded into the platform, so it is pinned rather than assumed.
    for (const path of ['/events', '/v1/events', '/stream']) {
      const res = await fetch(`${p.origin}${path}`, {
        headers: { ...asCi(), origin: 'https://evil.example' },
      })
      expect({ path, status: res.status }).toEqual({ path, status: 403 })
    }
  })

  it('allows a no-Origin (CLI) reader on the stream paths', async () => {
    // The other half of the CSWSH pin: an agent / `vx run` submitter sends no
    // Origin, and refusing those would break every machine client. Without
    // this control, the 403 check above passes for a gate that refuses
    // everything.
    //
    // A refusal RESOLVES immediately with a 403; an accepted reader opens a
    // long-lived NDJSON body that never completes. So "not refused" is either
    // a non-403 response or no response at all inside the window — racing is
    // the honest shape here. (Awaiting the fetch outright wedges the request
    // until Bun.serve's 10s idle timeout and then ECONNRESETs.)
    const ctrl = new AbortController()
    const outcome = await Promise.race([
      fetch(`${p.origin}/stream`, { headers: asCi(), signal: ctrl.signal }).then((r) => r.status),
      Bun.sleep(400).then(() => 'still-streaming' as const),
    ]).catch(() => 'still-streaming' as const)
    ctrl.abort()
    expect(outcome).not.toBe(403)
  })

  it('requires a credential on the API surfaces', async () => {
    // `/v1/*` and `/mcp` are gated; the SPA is not. An unauthenticated API
    // request must never reach a handler.
    for (const path of ['/v1/artifacts', '/mcp']) {
      const res = await fetch(`${p.origin}${path}`)
      expect({ path, ok: res.ok }).toEqual({ path, ok: false })
    }
  })
})
