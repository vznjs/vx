// The RunOptions ⇄ RunRequest wire mapping.
//
// Every flag added over the last months had to be threaded through BOTH
// mappers by hand, and at least one was silently dropped on the way: `--tag`
// reached the parser and the invocation row's schema but not the request, so a
// delegated run recorded no tags and nothing failed. That is the shape of every
// bug this file exists to catch — not a crash, but a flag the user passed that
// the executing side never hears about.
//
// So the load-bearing tests are COMPLETENESS ones, not round-trip examples:
//
//   1. `RunOptions` partitions exactly into "on the wire" plus "host-side".
//      Add a serializable option and forget `RunRequest`, and that fails.
//   2. Every `RunRequest` field is named in both mapper bodies. Add a field to
//      the interface and forget a mapper, and that fails.
//
// Both read the SOURCE, because the failure is an omission and an omission has
// no runtime shape to assert against — an unmapped field is simply absent, and
// absent is indistinguishable from "the caller didn't set it".
//
// TRAP, as in tests/cli-doc-drift.test.ts: source parsing only works while
// these stay literal `if (x !== undefined)` assignments. If either mapper
// becomes a computed key loop the regexes match nothing, so the parse
// assertions below must FAIL LOUDLY rather than be relaxed.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { optionsToRequest, requestToOptions } from '../src/orchestrator/index.js'
import type { RunOptions, RunRequest } from '../src/orchestrator/index.js'

const SRC = path.join(import.meta.dir, '..', 'src', 'orchestrator')
const PROTOCOL_SRC = readFileSync(path.join(SRC, 'protocol.ts'), 'utf8')
const OPTIONS_SRC = readFileSync(path.join(SRC, 'options.ts'), 'utf8')

/**
 * Fields of `RunOptions` that must NEVER cross the wire, with the reason. Each
 * is either a function-bearing object (unserializable) or a decision belonging
 * to whichever process actually executes.
 */
const HOST_ONLY: Readonly<Record<string, string>> = {
  log: 'a Logger — methods do not serialize',
  bus: 'an event bus — the service owns its own',
  handleSignals: "signal disposition belongs to the executing process's lifetime",
  inflight: 'an in-process dedup Map, meaningless across a hop',
  telemetrySinks: 'sink functions — the executing side resolves its own plugins',
  remoteCache: 'a live cache layer object with methods',
}

/** Field names declared on an exported interface, read from source. */
function interfaceFields(src: string, name: string): string[] {
  const m = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(src)
  if (m === null) {
    throw new Error(
      `protocol-map: could not find "export interface ${name}" — the declaration shape ` +
        'changed and this guard must be rewritten, not deleted',
    )
  }
  const fields = new Set<string>()
  // Only top-level members: a nested object literal (verify) is indented deeper.
  for (const line of m[1]!.split('\n')) {
    const f = /^ {2}(\w+)\??:/.exec(line)
    if (f !== null) fields.add(f[1]!)
  }
  return [...fields].sort()
}

/** Field names a mapper function body actually reads or writes. */
function mappedFields(fnName: string): string[] {
  const m = new RegExp(`export function ${fnName}\\([\\s\\S]*?\\n\\}`).exec(PROTOCOL_SRC)
  if (m === null) throw new Error(`protocol-map: could not find ${fnName}`)
  const body = m[0]
  const fields = new Set<string>()
  for (const hit of body.matchAll(/\b(?:options|request|req)\.(\w+)/g)) fields.add(hit[1]!)
  return [...fields].sort()
}

const REQUEST_FIELDS = interfaceFields(PROTOCOL_SRC, 'RunRequest')
const OPTIONS_FIELDS = interfaceFields(OPTIONS_SRC, 'RunOptions')

describe('the wire contract is parsed, not assumed', () => {
  // If these bounds ever fail, the parse found nothing and every completeness
  // assertion below would pass vacuously.
  it('reads a healthy field set from both interfaces', () => {
    expect(REQUEST_FIELDS.length).toBeGreaterThanOrEqual(18)
    expect(OPTIONS_FIELDS.length).toBeGreaterThanOrEqual(24)
    expect(REQUEST_FIELDS).toContain('tasks')
    expect(OPTIONS_FIELDS).toContain('tasks')
  })

  it('reads a healthy field set from both mapper bodies', () => {
    expect(mappedFields('optionsToRequest').length).toBeGreaterThanOrEqual(18)
    expect(mappedFields('requestToOptions').length).toBeGreaterThanOrEqual(18)
  })
})

describe('RunOptions partitions into wire fields and host-only fields', () => {
  // THE test. A new serializable option that nobody put on `RunRequest` shows
  // up here as an unclassified field, with a message saying which decision is
  // owed — rather than silently never reaching a delegated run.
  it('every RunOptions field is either on the wire or explicitly host-only', () => {
    const onWire = new Set(REQUEST_FIELDS)
    const unclassified = OPTIONS_FIELDS.filter((f) => !onWire.has(f) && !(f in HOST_ONLY))
    expect({ unclassified }).toEqual({ unclassified: [] })
  })

  it('every host-only field really is absent from the wire', () => {
    // The other direction: if one of these ever DID become serializable it
    // should be moved out of HOST_ONLY deliberately, not left double-listed.
    const leaked = Object.keys(HOST_ONLY).filter((f) => REQUEST_FIELDS.includes(f))
    expect({ leaked }).toEqual({ leaked: [] })
  })

  it('every host-only field is actually declared on RunOptions', () => {
    // Keeps HOST_ONLY from rotting into a list of fields that no longer exist,
    // which would silently weaken the partition test above.
    const stale = Object.keys(HOST_ONLY).filter((f) => !OPTIONS_FIELDS.includes(f))
    expect({ stale }).toEqual({ stale: [] })
  })
})

describe('both mappers name every RunRequest field', () => {
  // Catches the `--tag` class directly: a field on the interface that one
  // mapper forgot. Split per field so the failure names the culprit.
  const toReq = new Set(mappedFields('optionsToRequest'))
  const toOpts = new Set(mappedFields('requestToOptions'))

  for (const field of REQUEST_FIELDS) {
    it(`optionsToRequest maps ${field}`, () => {
      expect(toReq.has(field)).toBe(true)
    })
    it(`requestToOptions maps ${field}`, () => {
      expect(toOpts.has(field)).toBe(true)
    })
  }
})

/** A request with every field set to a distinctive, non-default value. */
function fullRequest(): RunRequest {
  return {
    tasks: ['build', 'test'],
    cwd: '/somewhere/else',
    projects: ['@acme/a', '@acme/b'],
    concurrency: 7,
    cache: { localRead: false, localWrite: true, remoteRead: true, remoteWrite: false },
    cacheDir: 'build/.vx-cache',
    continueMode: 'always',
    frozen: true,
    retries: 3,
    timeout: 12_345,
    memory: 8 * 1024 * 1024 * 1024,
    verify: { determinism: true, inputs: true, fingerprint: true, allow: ['a#b', 'c#d'] },
    flow: 'broad',
    outputLogs: 'errors-only',
    excludeDependencies: ['@acme/skipme'],
    forwardArgs: ['--watch', '--bail'],
    summarize: 'out/summary.json',
    profile: 'out/profile.json',
    tags: { pr: '42', queue: 'merge' },
    command: 'vx run build test --frozen',
  }
}

describe('round-trip preserves every field', () => {
  it('request → options → request is deep-equal', () => {
    const req = fullRequest()
    const back = optionsToRequest(requestToOptions(req))
    expect(back).toEqual(req)
  })

  it('the fixture really does set every declared field', () => {
    // Without this the round-trip above would silently stop covering any field
    // added later — it would pass on a fixture that omits it.
    const missing = REQUEST_FIELDS.filter((f) => !(f in fullRequest()))
    expect({ missing }).toEqual({ missing: [] })
  })

  it('every value survives, not just the shape', () => {
    const opts = requestToOptions(fullRequest())
    expect(opts.concurrency).toBe(7)
    expect(opts.retries).toBe(3)
    expect(opts.timeout).toBe(12_345)
    expect(opts.frozen).toBe(true)
    expect(opts.cacheDir).toBe('build/.vx-cache')
    expect(opts.continueMode).toBe('always')
    expect(opts.tags).toEqual({ pr: '42', queue: 'merge' })
    expect(opts.command).toBe('vx run build test --frozen')
    expect(opts.forwardArgs).toEqual(['--watch', '--bail'])
    expect(opts.cache).toEqual({
      localRead: false,
      localWrite: true,
      remoteRead: true,
      remoteWrite: false,
    })
  })
})

describe('verify: the Set ⇄ array boundary', () => {
  // `allow` is a Set in RunOptions and an array on the wire, because Sets do
  // not survive JSON. Both conversions are hand-written, so both are pinned.
  it('an array becomes a Set with the same members', () => {
    const opts = requestToOptions({
      tasks: ['t'],
      cwd: '/w',
      verify: { determinism: true, inputs: false, allow: ['x#y', 'p#q'] },
    })
    expect(opts.verify!.allow).toBeInstanceOf(Set)
    expect([...opts.verify!.allow].sort()).toEqual(['p#q', 'x#y'])
  })

  it('a Set becomes a plain array', () => {
    const req = optionsToRequest({
      tasks: ['t'],
      cwd: '/w',
      verify: { determinism: true, inputs: false, fingerprint: false, allow: new Set(['x#y']) },
    })
    expect(Array.isArray(req.verify!.allow)).toBe(true)
    expect(req.verify!.allow).toEqual(['x#y'])
  })

  it('copies the Set rather than aliasing it', () => {
    // The request must be a snapshot: mutating the caller's Set afterwards
    // cannot retroactively change what was submitted.
    const allow = new Set(['x#y'])
    const req = optionsToRequest({
      tasks: ['t'],
      cwd: '/w',
      verify: { determinism: true, inputs: false, fingerprint: false, allow },
    })
    allow.add('late#addition')
    expect(req.verify!.allow).toEqual(['x#y'])
  })

  it('an empty allow list stays empty in both directions', () => {
    const opts = requestToOptions({
      tasks: ['t'],
      cwd: '/w',
      verify: { determinism: true, inputs: true, allow: [] },
    })
    expect(opts.verify!.allow.size).toBe(0)
    expect(optionsToRequest(opts).verify!.allow).toEqual([])
  })

  it('an absent fingerprint degrades to false, not undefined', () => {
    // The documented additive-optional contract: an OLD serve omits
    // `fingerprint`, and the executing side must read that as "off" rather
    // than letting undefined flow into a boolean check.
    const opts = requestToOptions({
      tasks: ['t'],
      cwd: '/w',
      verify: { determinism: true, inputs: false, allow: [] },
    })
    expect(opts.verify!.fingerprint).toBe(false)
  })

  it('a fingerprint-only verify survives the round trip', () => {
    const req: RunRequest = {
      tasks: ['t'],
      cwd: '/w',
      verify: { determinism: false, inputs: false, fingerprint: true, allow: [] },
    }
    expect(optionsToRequest(requestToOptions(req)).verify).toEqual(req.verify!)
  })
})

describe('absent stays absent', () => {
  // Under exactOptionalPropertyTypes an explicit `undefined` is NOT the same as
  // a missing key, and these mappers gate on `!== undefined` for exactly that
  // reason. A mapper that assigned unconditionally would put `foo: undefined`
  // on the wire, which `JSON.stringify` then drops — so the bug would only
  // appear across a real transport, not in a local test.
  const minimal: RunRequest = { tasks: ['build'], cwd: '/w' }

  it('a minimal request maps to a minimal options object', () => {
    expect(Object.keys(requestToOptions(minimal)).sort()).toEqual(['cwd', 'tasks'])
  })

  it('a minimal options object maps to a minimal request', () => {
    expect(Object.keys(optionsToRequest({ tasks: ['build'], cwd: '/w' })).sort()).toEqual([
      'cwd',
      'tasks',
    ])
  })

  it('no optional key is present-but-undefined after either mapping', () => {
    const asRecord = requestToOptions(minimal) as unknown as Record<string, unknown>
    const undef = Object.keys(asRecord).filter((k) => asRecord[k] === undefined)
    expect({ undef }).toEqual({ undef: [] })
  })

  it('survives a JSON hop, which is what the wire actually is', () => {
    // The real transport stringifies. Anything that only round-trips
    // in-process is not actually on the wire.
    const req = fullRequest()
    const hopped = JSON.parse(JSON.stringify(req)) as RunRequest
    expect(optionsToRequest(requestToOptions(hopped))).toEqual(req)
  })
})

describe('collections are snapshots, not aliases', () => {
  it('tasks and projects are copied on the way back', () => {
    // `requestToOptions` spreads these. If it aliased instead, the executing
    // side could mutate the submitter's arrays across an in-process hop.
    const tasks = ['build']
    const projects = ['@acme/a']
    const opts = requestToOptions({ tasks, cwd: '/w', projects })
    expect(opts.tasks).toEqual(tasks)
    expect(opts.tasks).not.toBe(tasks)
    expect(opts.projects).not.toBe(projects)
  })

  it('an empty projects list is preserved, not dropped as falsy', () => {
    // `projects: []` means "an explicitly empty scope", which is different
    // from "no scope given". A truthiness gate would collapse the two.
    const req = optionsToRequest({ tasks: ['t'], cwd: '/w', projects: [] })
    expect(req.projects).toEqual([])
    expect('projects' in req).toBe(true)
  })

  it('an empty forwardArgs list is preserved', () => {
    // Bare `--` is documented as NOT changing the cache key, so it must still
    // arrive as an empty array rather than vanishing.
    const req = optionsToRequest({ tasks: ['t'], cwd: '/w', forwardArgs: [] })
    expect(req.forwardArgs).toEqual([])
    expect('forwardArgs' in req).toBe(true)
  })

  it("excludeDependencies keeps the 'all' sentinel distinct from a list", () => {
    const all = optionsToRequest({ tasks: ['t'], cwd: '/w', excludeDependencies: 'all' })
    expect(all.excludeDependencies).toBe('all')
    const some = optionsToRequest({ tasks: ['t'], cwd: '/w', excludeDependencies: ['a'] })
    expect(some.excludeDependencies).toEqual(['a'])
  })
})

describe('falsy values are transmitted, not swallowed', () => {
  // Every one of these is a legitimate, documented value whose meaning is the
  // opposite of "unset". A `if (options.x)` gate instead of `!== undefined`
  // would drop them, and the user would silently get the default.
  const cases: ReadonlyArray<readonly [string, Partial<RunOptions>, (r: RunRequest) => unknown]> = [
    ['retries: 0 — explicitly no retries', { retries: 0 }, (r) => r.retries],
    ['timeout: 0', { timeout: 0 }, (r) => r.timeout],
    ['concurrency: 0', { concurrency: 0 }, (r) => r.concurrency],
    ['memory: 0', { memory: 0 }, (r) => r.memory],
    ['frozen: false', { frozen: false }, (r) => r.frozen],
    ['summarize: "" — the bare-flag default', { summarize: '' }, (r) => r.summarize],
    ['profile: ""', { profile: '' }, (r) => r.profile],
    ['command: ""', { command: '' }, (r) => r.command],
    ['cacheDir: ""', { cacheDir: '' }, (r) => r.cacheDir],
  ]

  for (const [what, patch, read] of cases) {
    it(`transmits ${what}`, () => {
      const req = optionsToRequest({ tasks: ['t'], cwd: '/w', ...patch })
      const expected = Object.values(patch)[0]
      expect(read(req)).toBe(expected as never)
      // …and back again, since either mapper could be the one that drops it.
      expect(read(optionsToRequest(requestToOptions(req)))).toBe(expected as never)
    })
  }

  it('transmits a fully-disabled cache policy', () => {
    // All four axes off is exactly `--no-cache`; an object-truthiness gate
    // would pass it, but a per-axis one would not.
    const cache = { localRead: false, localWrite: false, remoteRead: false, remoteWrite: false }
    const req = optionsToRequest({ tasks: ['t'], cwd: '/w', cache })
    expect(req.cache).toEqual(cache)
    expect(requestToOptions(req).cache).toEqual(cache)
  })

  it('transmits an empty tags object', () => {
    const req = optionsToRequest({ tasks: ['t'], cwd: '/w', tags: {} })
    expect(req.tags).toEqual({})
    expect('tags' in req).toBe(true)
  })
})

describe('host-only fields never reach the request', () => {
  it('drops log, bus, handleSignals and the rest', () => {
    // The submitting side holds a Logger and an event bus; putting either on
    // the request would throw on `JSON.stringify` at the transport boundary.
    const req = optionsToRequest({
      tasks: ['t'],
      cwd: '/w',
      handleSignals: false,
      // NonNullable, because `RunOptions['log']` includes undefined and
      // exactOptionalPropertyTypes refuses that for an exact-optional field.
      log: { status: () => {} } as unknown as NonNullable<RunOptions['log']>,
      telemetrySinks: [],
    })
    for (const field of Object.keys(HOST_ONLY)) {
      expect(field in req).toBe(false)
    }
    expect(() => JSON.stringify(req)).not.toThrow()
  })
})
