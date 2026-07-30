// One vocabulary for "did this task pass?" and "did it come out of the cache?".
//
// Before this, that vocabulary was hand-rolled TEN times across core, cloud and
// the dashboard — four `new Set(['success', 'cache-hit', 'cache-hit-remote'])`,
// several inline disjunctions, and one `status.startsWith('cache-hit')` in the
// serve's log route. They all agreed, which is exactly why nobody noticed: the
// hazard is not today's answer, it is that a `Set` of string literals has NO
// tripwire when `TaskStatus` gains a member. Add one and each copy silently
// answers `false` for it — a wrong success rate in analytics, a wrong
// critical-path floor in the dashboard, a wrong "did the remote cache save me
// work" count in the distributed scheduler. Every one of those is a number a
// reader cannot tell is wrong by looking at it.
//
// The replacement is a `Record<TaskStatus, boolean>`, which the compiler
// REQUIRES to name every member — so the omission cannot ship. These tests pin
// the semantics (the list here is the spec, deliberately restated) and the
// mechanism (that the tripwire is still a Record, and that no consumer has
// re-inlined the enumeration).

import { describe, expect, it } from 'bun:test'
import path from 'node:path'
import {
  deriveCacheSource,
  isCacheHit,
  isPassStatus,
  TASK_STATUSES,
  type TaskStatus,
} from '../src/index.js'

const ROOT = path.join(import.meta.dir, '..')
const read = (rel: string) => Bun.file(path.join(ROOT, rel)).text()

describe('the status vocabulary', () => {
  // The spec, restated on purpose: a test asserting expected VALUES is supposed
  // to name them. What must not be restated is the implementation's list, which
  // is why `TASK_STATUSES` is derived from the Record's keys rather than typed
  // out a second time in src/.
  it.each([
    ['success', true, false],
    ['cache-hit', true, true],
    ['cache-hit-remote', true, true],
    ['failed', false, false],
    ['skipped', false, false],
    ['aborted', false, false],
  ] as const)('classifies %s', (status, pass, hit) => {
    expect({ status, pass: isPassStatus(status), hit: isCacheHit(status) }).toEqual({
      status,
      pass,
      hit,
    })
  })

  it('TASK_STATUSES is exactly the union, so the table above is exhaustive', () => {
    // Forces the table to be updated deliberately when a status is added — the
    // point being that SOMEONE has to decide whether the new member passes and
    // whether it is a hit, rather than inheriting `false` by omission.
    expect([...TASK_STATUSES].sort()).toEqual([
      'aborted',
      'cache-hit',
      'cache-hit-remote',
      'failed',
      'skipped',
      'success',
    ])
  })

  it('isCacheHit never disagrees with deriveCacheSource', () => {
    // Not a second opinion — `isCacheHit` is IMPLEMENTED over
    // `deriveCacheSource`, and this asserts that stays true rather than the
    // two drifting into independent lists. Iterates the real union, so it
    // carries no copy of the vocabulary itself.
    for (const status of TASK_STATUSES) {
      const source = deriveCacheSource(status)
      expect({ status, hit: isCacheHit(status) }).toEqual({
        status,
        hit: source === 'local' || source === 'remote',
      })
    }
  })

  // Both predicates take `string`, not `TaskStatus`, because nearly every caller
  // holds a status that came off a wire or out of a database column. The safe
  // answer for a string this build has never heard of is "no" in both
  // directions — the alternative is calling a run green on an unknown status.
  it.each([
    ['an unknown status', 'cache-hit-magnetic'],
    ['the empty string', ''],
    ['a near-miss', 'cache_hit'],
    // `PASSES` is a plain object, so a naive `status in PASSES` would answer
    // TRUE for every Object.prototype key. Both predicates must not.
    ['an inherited Object key', 'toString'],
    ['constructor', 'constructor'],
    ['__proto__', '__proto__'],
  ])('reads %s as neither a pass nor a hit', (_label, status) => {
    expect({ status, pass: isPassStatus(status), hit: isCacheHit(status) }).toEqual({
      status,
      pass: false,
      hit: false,
    })
  })
})

describe('the tripwire that makes one definition stay one definition', () => {
  it('classifies statuses with a Record over the union, not a Set of literals', async () => {
    // A SOURCE assertion because the property has no runtime shape: a `Set`
    // and a `Record` behave identically TODAY and differ only on the day a
    // member is added — when the Record fails to compile and the Set does
    // not. That compile error IS the guarantee, so it is what gets pinned.
    const src = await read('src/orchestrator/telemetry.ts')
    expect(src).toContain('const PASSES: Record<TaskStatus, boolean>')
    // Derived, not a parallel list: swapping this for a written-out array
    // reintroduces exactly the drift the Record removes.
    expect(src).toContain('Object.keys(PASSES) as TaskStatus[]')
  })

  // Files allowed to name both hit statuses on one line, each for a stated
  // reason. A file NOT on this list that inlines the pair has re-created the
  // duplicate — so adding one is a deliberate entry here, not a silent copy.
  const MAY_INLINE: ReadonlyMap<string, string> = new Map([
    [
      'src/orchestrator/execute-task.ts',
      'PRODUCES the status — it picks local vs remote, so it must name both.',
    ],
    [
      'src/orchestrator/metrics.ts',
      'SQL text. One survivor, and it is a DIFFERENT list (it includes `failed` — the latest-state filter, not the pass set).',
    ],
    [
      'src/cache/cache.ts',
      '`RunRecord.status` is a deliberate SUBSET of TaskStatus (no `aborted`, which is never recorded), plus SQL text — and `cache` cannot import `orchestrator` under the module boundary matrix, so it cannot reach the predicate at all.',
    ],
    [
      'packages/cloud/src/db/analytics.ts',
      'SQL text, and the same latest-state filter as metrics.ts. Its PASS list is derived from the union.',
    ],
  ])

  it('no consumer re-inlines the enumeration', async () => {
    // Same-line co-occurrence of both hit literals is the signature of an
    // inlined enumeration (`=== 'cache-hit' || === 'cache-hit-remote'`, or a
    // `new Set([...])`). It deliberately does NOT flag the multi-line forms —
    // a `Record`/`switch` spread over lines is the shape being encouraged, and
    // `run.ts` still counts local and remote hits SEPARATELY on separate lines,
    // which is a genuine distinction rather than a copy of this predicate.
    const roots = ['src', 'packages/cloud/src', 'packages/cloud/ui/src']
    const offenders: { file: string; line: number; text: string }[] = []
    for (const root of roots) {
      const glob = new Bun.Glob('**/*.{ts,tsx}')
      for await (const rel of glob.scan({ cwd: path.join(ROOT, root) })) {
        if (rel.includes('.test.')) continue
        const file = `${root}/${rel.split(path.sep).join('/')}`
        if (MAY_INLINE.has(file)) continue
        const lines = (await read(file)).split('\n')
        lines.forEach((text, i) => {
          if (text.includes("'cache-hit'") && text.includes("'cache-hit-remote'")) {
            offenders.push({ file, line: i + 1, text: text.trim() })
          }
        })
      }
    }
    expect(offenders).toEqual([])
  })

  it('the SQL pass-lists are built from the predicate, not retyped', async () => {
    // A query cannot call a TS predicate, so the pass set has to exist as text
    // in two places. It does NOT have to be two decisions: both filter the real
    // union through the real predicate, so a new member lands in the SQL
    // automatically. Pinned in both packages because a fix that centralises a
    // list to stop drift can itself miss a call site — which is how this whole
    // sweep started.
    for (const file of ['src/orchestrator/metrics.ts', 'packages/cloud/src/db/analytics.ts']) {
      const src = await read(file)
      expect({ file, derived: src.includes('TASK_STATUSES.filter(isPassStatus)') }).toEqual({
        file,
        derived: true,
      })
    }
  })
})

describe('the callers that used to hand-roll it', () => {
  // Each of these had its own copy. The pins are behavioural where the caller
  // can be driven cheaply, and otherwise assert the file reaches for the shared
  // predicate — which is what actually changed.
  it.each([
    ['the distributed submitter', 'packages/cloud/src/dist/submit.ts', 'isPassStatus'],
    ['the distributed scheduler', 'packages/cloud/src/dist/scheduler.ts', 'isPassStatus'],
    ['the agent loop', 'packages/cloud/src/dist/agent-loop.ts', 'isPassStatus'],
    ['the serve log route', 'packages/cloud/src/db/analytics-routes.ts', 'isCacheHit'],
    ['the run verdict', 'src/orchestrator/run.ts', 'isPassStatus'],
    ['the terminal logger', 'src/orchestrator/logger.ts', 'isCacheHit'],
  ])('%s uses the shared predicate', async (_label, file, fn) => {
    const src = await read(file)
    expect({ file, uses: src.includes(`${fn}(`) }).toEqual({ file, uses: true })
  })

  it('the serve log route no longer prefix-matches the status', async () => {
    // `status.startsWith('cache-hit')` was the sharpest copy: it answers a
    // DIFFERENT question from the enumerated ones — any future status merely
    // NAMED `cache-hit-*` would count, whether or not it restored anything.
    // `deriveCacheSource`'s docstring already claimed nobody did this.
    const src = await read('packages/cloud/src/db/analytics-routes.ts')
    expect(src).not.toContain("startsWith('cache-hit')")
  })
})

// A compile-time control: if `TaskStatus` ever stops being assignable to the
// predicates' `string` parameter, this stops type-checking. Cheap, and it keeps
// the `TaskStatus` import load-bearing rather than decorative.
const _typeControl: (s: TaskStatus) => boolean = isPassStatus
void _typeControl
