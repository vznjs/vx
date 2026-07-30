// `dispatch.ts` is the platform's single HTTP host — the cache wire, the batch
// probe, `/mcp`, `/v1/artifacts`, the agent + run WS upgrades, the SSE/NDJSON
// streams, and the SPA catch-all all hang off one `Bun.serve`. It is 563 lines
// reached ONLY as a fixture step (every suite that boots a platform runs
// through it; none pins its routing), and it has already produced two real
// defects that way: a cross-tenant SSE broadcast and a dropped CSWSH gate.
//
// These pin the routing RULES against a real booted platform.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { bootPlatform, type TestPlatform } from './helpers/platform.js'

// ONE platform for both describes below. They are the same subject (routing)
// and each boot costs a pg clone + a fake S3; the browser suites in this
// package already fail under full-suite load, so a needless second platform is
// a real cost rather than tidiness.
let p: TestPlatform
beforeAll(async () => {
  p = await bootPlatform()
})
afterAll(async () => {
  await p.stop()
})

const asCi = (): Record<string, string> => ({ authorization: `Bearer ${p.ciToken}` })

describe('dispatch routing', () => {
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

// --------------------------------------------------------------------------
// Every `/v1` path the dashboard calls must land on a route.
//
// This is the honest version of a fix that was tried and REVERTED in the
// dispatch audit. An unmatched `/v1/*` answers 200 with the SPA catch-all,
// which is deliberate (a route REMOVED from the platform degrades to the app
// instead of 500; the analytics allowlist must not become a catch-all) and
// which five browser suites depend on — so it cannot become a runtime 404.
//
// But the cost is real: `/v1/notifications`, `/v1/why/:runId` and
// `/v1/branch-failures` EACH shipped missing from the gate's allowlist, and the
// fallthrough hid every one. The miss surfaced as a 200 whose body would not
// parse, found late by a browser check rather than by the request failing.
//
// So the check moves to CI instead of the runtime: extract the paths the client
// actually calls, ask a real platform for each, and fail when one lands on the
// catch-all. A client call nothing routes now fails on the commit that adds it.
//
// The probe is DYNAMIC on purpose. Asking `isAnalyticsSurface` directly would
// be cheaper and wrong: the allowlist and the dispatcher are two different
// things, and it is exactly that split which produced all three bugs — a route
// the allowlist claims but dispatch never handles (or the reverse) still breaks.
// Only the real server knows.

/**
 * The `/v1` route shapes `ui/src/api.ts` issues requests for.
 *
 * Keyed on the REQUEST HELPERS rather than on every `/v1` string in the file:
 * the module is full of prose (`a /v1/* analytics pathname`) and prefix tests
 * (`pathname.startsWith('/v1/')`), and treating those as calls produced a
 * dozen phantom routes on the first attempt.
 */
function clientRouteShapes(): string[] {
  let src = readFileSync(new URL('../ui/src/api.ts', import.meta.url), 'utf8')
  src = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const call =
    /(?:getJson|doGetJson|mutate|authPost|authFetch|fetch)\s*(?:<[^>]*>)?\s*\(\s*(?:`\$\{origin\(\)\}|[`'"])(\/v1\/[^`'"]*)/g
  const shapes = new Set<string>()
  for (const m of src.matchAll(call)) {
    let p = m[1]!.split('?')[0]!
    // A trailing `${…}` NOT preceded by `/` is a query suffix (`…/stats${q}`).
    // Every other interpolation is a path segment — an earlier cut stripped
    // both and silently turned `/v1/compare/${runId}` into `/v1/compare`.
    p = p.replace(/(?<!\/)\$\{[^}]*\}$/, '')
    p = p.replace(/\$\{[^}]*\}/g, 'ID').replace(/\/$/, '')
    if (p !== '') shapes.add(p)
  }
  // Non-vacuity: the client calls ~54 shapes. A regex that quietly matched
  // nothing would make this whole suite pass while checking zero routes — the
  // failure mode that makes a guard worse than none.
  if (shapes.size < 40) {
    throw new Error(
      `extracted only ${shapes.size} client route shapes from api.ts — the extractor is broken, ` +
        'not the client. Fix THIS parser rather than lowering the bound.',
    )
  }
  return [...shapes].sort()
}

/**
 * Shapes that SHOULD reach the SPA catch-all, each for a stated reason. A new
 * entry here is a deliberate decision; an unexplained one is the bug this file
 * exists to catch.
 */
const EXPECTED_UNROUTED: ReadonlyMap<string, string> = new Map([
  [
    '/v1/graph',
    'died with the SQLite catalog (the P4 platform fold). The client probes it to detect a colocated workspace and treats the absence as a missing capability; `server.test.ts` pins that it degrades to the app rather than 500.',
  ],
  ['/v1/workspace/projects', 'same colocated-catalog removal as /v1/graph.'],
  ['/v1/workspace/projects/ID', 'same colocated-catalog removal as /v1/graph.'],
  ['/v1/workspace/tasks', 'same colocated-catalog removal as /v1/graph.'],
])

/** A path segment that will actually match the route's own shape. */
function concrete(shape: string): string {
  // The cache wire is hex-only (`[0-9a-f]{16,64}`) so it can never shadow the
  // named `/v1/cache/*` analytics routes — a UUID does NOT match it, and an
  // earlier probe reported `/v1/cache/:hash` as unrouted for exactly that
  // reason. The substitution has to fit the route, or the test measures itself.
  if (shape.startsWith('/v1/cache/')) return shape.replace(/\/ID/g, '/0123456789abcdef')
  return shape.replace(/\/ID/g, '/00000000-0000-7000-8000-000000000000')
}

describe('every /v1 path the dashboard calls is routed', () => {
  it('none of them lands on the SPA catch-all', async () => {
    const unrouted: { shape: string; body: string }[] = []
    for (const shape of clientRouteShapes()) {
      if (EXPECTED_UNROUTED.has(shape)) continue
      const res = await fetch(`${p.origin}${concrete(shape)}`, { headers: asCi() })
      const ct = res.headers.get('content-type') ?? ''
      // Deliberately weak in the right direction: a 404 for an id that does not
      // exist is fine, a 400 is fine, a 405 is fine, 200 JSON is fine. ONLY a
      // 200 whose body is not JSON means the request fell past every route and
      // the client would receive the app instead of an answer.
      if (res.status === 200 && !ct.includes('application/json')) {
        unrouted.push({ shape, body: (await res.text()).slice(0, 60) })
      }
    }
    expect(unrouted).toEqual([])
  })

  it('the documented catch-all probes really do still fall through', async () => {
    // The other direction, and it is what keeps the exempt list honest: if one
    // of these ever starts resolving, the client is probing a capability that
    // now exists and the entry should go — otherwise the list rots into a
    // blanket suppression that hides the next real miss.
    for (const shape of EXPECTED_UNROUTED.keys()) {
      const res = await fetch(`${p.origin}${concrete(shape)}`, { headers: asCi() })
      const ct = res.headers.get('content-type') ?? ''
      expect({
        shape,
        caughtByCatchAll: res.status === 200 && !ct.includes('application/json'),
      }).toEqual({ shape, caughtByCatchAll: true })
    }
  })

  it('extracts the real call sites, not prose or prefix tests', async () => {
    // The extractor's own control. `api.ts` contains `/v1/*` in comments and
    // `startsWith('/v1/')` guards; an early cut counted those and reported
    // phantom routes like `/v1` and `/v1/admin`. Bare prefixes must be absent
    // and known real routes present.
    const shapes = clientRouteShapes()
    expect(shapes).not.toContain('/v1')
    expect(shapes).not.toContain('/v1/admin')
    expect(shapes).not.toContain('/v1/auth')
    for (const real of ['/v1/notifications', '/v1/why/ID', '/v1/branch-failures']) {
      expect({ real, found: shapes.includes(real) }).toEqual({ real, found: true })
    }
  })
})
