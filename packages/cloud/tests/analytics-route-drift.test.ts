// The analytics allowlist must admit exactly the routes the analytics router
// answers.
//
// Two independent lists describe the same set: `dispatchAnalytics`
// (db/analytics-routes.ts) decides what the router ANSWERS, and
// `isAnalyticsSurface` (cli/server.ts) decides what the server ROUTES to it.
// Nothing has ever tied them together, and they have drifted three times.
// The failure is quiet and identical each time: a session request for a route
// missing from the allowlist falls through to the SPA catch-all, so the browser
// receives HTML where it expected JSON and the card renders empty rather than
// erroring. `/v1/notifications`, `/v1/why` and `/v1/branch-failures` each
// shipped broken this way.
//
// So this asserts the two directions separately, because they fail differently:
//
//   handled ⊆ allowed   a route the router answers but the server does not
//                       route → the falls-through-to-SPA bug above.
//   allowed ⊆ handled   a route the server routes to analytics but the router
//                       does not answer → a confusing 404 from the analytics
//                       layer instead of the SPA, and a dead allowlist entry
//                       that outlives the feature it was added for.
//
// It works by parsing the router's source for the literals and regexes it
// dispatches on, then driving the REAL `isAnalyticsSurface` with concrete
// paths built from them — so it asserts behaviour, not that two files contain
// matching text.
//
// TRAP, the same one tests/cli-doc-drift.test.ts documents: parsing only works
// while both sides are literal. If the router ever dispatches through a
// computed table, these regexes match nothing and the test would pass
// vacuously — asserting a healthy set is present is what stops that, and those
// assertions must FAIL LOUDLY rather than be relaxed if the shape changes.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { isAnalyticsSurface } from '../src/cli/server.js'

const SRC = path.join(import.meta.dir, '..', 'src')
const ROUTER_SRC = readFileSync(path.join(SRC, 'db', 'analytics-routes.ts'), 'utf8')
const SERVER_SRC = readFileSync(path.join(SRC, 'cli', 'server.ts'), 'utf8')

/**
 * Routes the router dispatches on with an exact match, split by the method it
 * requires. The ingest family is POST-gated on both sides; everything else is
 * read-only and method-agnostic.
 */
function handledExactRoutes(): { post: string[]; any: string[] } {
  const post: string[] = []
  const any: string[] = []
  // `if (p === '/v1/x' && req.method === 'POST') {` vs plain `if (p === '/v1/x')`.
  const re = /p === '(\/v1\/[^']*)'(\s*&&\s*req\.method === '([A-Z]+)')?/g
  for (const m of ROUTER_SRC.matchAll(re)) {
    const route = m[1]!
    if (m[3] === 'POST') post.push(route)
    else any.push(route)
  }
  return { post: [...new Set(post)].sort(), any: [...new Set(any)].sort() }
}

/**
 * The parameterized patterns the router matches, as their raw regex sources.
 * Each is a `/^\/v1\/…$/.exec(p)` in a dispatch branch.
 */
function handledParamPatterns(): string[] {
  const out = new Set<string>()
  for (const m of ROUTER_SRC.matchAll(/(\/\^\\\/v1\\\/.*?\$\/)\.exec\(p\)/g)) out.add(m[1]!)
  return [...out].sort()
}

/** The `EXACT` set literal inside `isAnalyticsSurface`. */
function allowlistExactRoutes(): string[] {
  const block = /const EXACT = new Set\(\[([\s\S]*?)\]\)/.exec(SERVER_SRC)
  if (block === null) {
    throw new Error(
      'analytics-route-drift: could not find the EXACT set in cli/server.ts — ' +
        'the allowlist shape changed and this guard must be rewritten, not deleted',
    )
  }
  return [...block[1]!.matchAll(/'(\/v1\/[^']*)'/g)].map((m) => m[1]!).sort()
}

/**
 * Turn a handled param pattern into a concrete path the allowlist must admit.
 * `([^/]+)` is one segment; `(.+)` is satisfied by one segment too, and the
 * multi-segment case is covered separately below.
 */
function sampleFor(patternSource: string): string {
  return patternSource
    .slice(2, -2) // strip the leading `/^` and trailing `$/`
    .replaceAll('\\/', '/')
    .replaceAll('([^/]+)', 'sample-id')
    .replaceAll('(.+)', 'sample-id')
}

describe('analytics route allowlist — parse sanity', () => {
  // Guards against the vacuous-pass trap: if the router's dispatch shape
  // changes, the regexes above stop matching and every assertion below would
  // pass against an empty set. These bounds are deliberately loose — they only
  // need to catch "matched nothing", not pin an exact count that churns.
  it('extracts a healthy set from both sources', () => {
    const { post, any } = handledExactRoutes()
    expect(post.length).toBeGreaterThanOrEqual(4)
    expect(any.length).toBeGreaterThanOrEqual(25)
    expect(handledParamPatterns().length).toBeGreaterThanOrEqual(8)
    expect(allowlistExactRoutes().length).toBeGreaterThanOrEqual(25)
  })

  it('the ingest family is the POST-gated set', () => {
    // If a read route ever acquires a method gate, or an ingest route loses
    // one, the two sides' method handling has to be re-reasoned rather than
    // silently absorbed by this guard.
    expect(handledExactRoutes().post).toEqual([
      '/v1/catalog',
      '/v1/ingest',
      '/v1/ingest/logs',
      '/v1/ingest/task',
      '/v1/otlp/v1/logs',
      '/v1/otlp/v1/traces',
    ])
  })
})

describe('analytics route allowlist — handled ⊆ allowed', () => {
  // The falls-through-to-SPA direction. A failure here means the named route
  // returns HTML to a browser session that asked for JSON.
  const { post, any } = handledExactRoutes()

  for (const route of any) {
    it(`admits ${route}`, () => {
      expect(isAnalyticsSurface(route, 'GET')).toBe(true)
    })
  }

  for (const route of post) {
    it(`admits ${route} for POST`, () => {
      expect(isAnalyticsSurface(route, 'POST')).toBe(true)
    })
  }

  for (const pattern of handledParamPatterns()) {
    const sample = sampleFor(pattern)
    it(`admits ${sample} (from ${pattern})`, () => {
      expect(isAnalyticsSurface(sample, 'GET')).toBe(true)
    })
  }
})

describe('analytics route allowlist — allowed ⊆ handled', () => {
  // The dead-entry direction. A failure here means the server routes a request
  // into the analytics layer that has no handler, so the caller gets a 404 from
  // a surface that should not have seen it at all.
  const handled = new Set([...handledExactRoutes().any, ...handledExactRoutes().post])

  for (const route of allowlistExactRoutes()) {
    it(`${route} has a handler`, () => {
      expect(handled.has(route)).toBe(true)
    })
  }
})

describe('analytics route allowlist — multi-segment tails', () => {
  // Five patterns end in `(.+)`, which matches across `/`. A task id is
  // `project#task` so it carries no slash, but `/v1/explain/:taskId` and
  // `/v1/tasks/:taskId` take a percent-decoded value, and the allowlist's
  // mirror regexes use `.+` for exactly this reason. If one side were narrowed
  // to `[^/]+` the route would 404 only for the values that contain a slash —
  // the kind of partial breakage that survives a smoke test.
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['/v1/tasks/a/b', 'tasks tail'],
    ['/v1/explain/a/b', 'explain tail'],
    ['/v1/why/run-1/a/b', 'per-task why tail'],
    ['/v1/diff/run-1/a/b', 'diff tail'],
    ['/v1/runs/run-1/logs/a/b', 'logs tail'],
  ]

  for (const [pathname, what] of cases) {
    it(`admits a multi-segment ${what}: ${pathname}`, () => {
      expect(isAnalyticsSurface(pathname, 'GET')).toBe(true)
    })
  }
})

describe('analytics route allowlist — surfaces it must NOT claim', () => {
  // Machine surfaces the server answers itself, before the analytics branch.
  // The reachable way to break each is for someone to "fix" a 404 by adding it
  // to EXACT — which would hand the artifact store's or cache wire's traffic to
  // the analytics dispatcher, which has no handler for it. Verified: adding
  // either of these to EXACT fails this suite.
  //
  // Deliberately NOT asserted here: that a hash-shaped `/v1/cache/<hex>` is
  // refused. It is refused STRUCTURALLY — such a path is in neither EXACT nor
  // any parameterized regex, so it returns false whether or not the early
  // exclusion block exists. Mutation-testing confirmed nothing can flip it, so
  // an assertion would have been a false guarantee rather than a guard. What
  // the exclusion block genuinely protects is the OTHER side of that boundary:
  // a hash regex loose enough to also swallow the sibling `/v1/cache/*`
  // analytics routes. That IS covered — loosening it to `[0-9a-z]{4,64}` fails
  // six of the generated `handled ⊆ allowed` assertions above.
  const excluded: ReadonlyArray<readonly [string, string]> = [
    ['/v1/artifacts', 'artifact listing is served by the store, not analytics'],
    ['/v1/cache/batch', 'batch existence probe is machine-token-only'],
    ['/v1/workspace/projects', 'colocated workspace catalog'],
    ['/v1/workspace/tasks', 'colocated workspace catalog'],
  ]

  for (const [pathname, why] of excluded) {
    it(`refuses ${pathname} — ${why}`, () => {
      expect(isAnalyticsSurface(pathname, 'GET')).toBe(false)
    })
  }

  it('refuses an unknown /v1 path so it can reach the SPA', () => {
    expect(isAnalyticsSurface('/v1/not-a-real-route', 'GET')).toBe(false)
  })

  it('refuses a non-/v1 path', () => {
    expect(isAnalyticsSurface('/dashboard', 'GET')).toBe(false)
  })

  it('does not admit an ingest route for GET', () => {
    // The ingest family is a write surface; admitting a GET would route a
    // read into a handler that only answers POST.
    expect(isAnalyticsSurface('/v1/ingest', 'GET')).toBe(false)
    expect(isAnalyticsSurface('/v1/catalog', 'GET')).toBe(false)
  })
})
