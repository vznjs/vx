import { describe, expect, it } from 'bun:test'
import { expandGroupUpstream, filterUpstreamHashes } from '../src/orchestrator/upstream.js'
import type { TaskNode, TaskOutcome } from '../src/graph/index.js'
import { UserError } from '../src/util/index.js'

// filterUpstreamHashes(upstream, filter, selfProjectName, selfTaskId) →
// Array<[upstreamTaskId, hash]>. The filter is Turbo/Nx micro-syntax
// (`*`, `^*`, `name`, `^name`, `pkg#task`, and `!<form>` negation),
// applied in order with last-write-wins, deduped by hash.

function outcome(id: string, hash: string): TaskOutcome {
  const [projectName, taskName] = id.split('#') as [string, string]
  const node: TaskNode = {
    id,
    projectName,
    projectDir: '/tmp',
    taskName,
    config: { exec: { command: 'noop' } },
    deps: [],
    requested: false,
  }
  return { node, status: 'success', exitCode: 0, durationMs: 0, hash }
}

describe('filterUpstreamHashes', () => {
  it('undefined filter → every upstream with a hash contributes, keyed by node id', () => {
    const up = [outcome('self#a', 'h-a'), outcome('dep#b', 'h-b')]
    expect(filterUpstreamHashes(up, undefined, 'self', 'self#build')).toEqual([
      ['self#a', 'h-a'],
      ['dep#b', 'h-b'],
    ])
  })

  it('an upstream with NO hash contributes nothing, filtered or not', () => {
    // `TaskOutcome.hash` is optional, and core does build outcomes without
    // one: the scheduler's skipped / aborted branch omits it. Both folds
    // skip those — an absent key is not a key, and folding `undefined`
    // would put a constant where an upstream's identity belongs.
    //
    // Measured, not assumed: instrumenting the filtered fold across the
    // continue-taint, abort, restore-tier and e2e orchestrator suites
    // logged 134 upstream entries and NOT ONE without a hash, because a
    // dependent of a skipped task is itself skipped rather than keyed. So
    // the guard is defensive today — which is exactly why it is pinned at
    // the function's own boundary, where the contract is statable, rather
    // than by asserting that nothing upstream can reach it. That second
    // claim would pin the reachability, i.e. the implementation.
    const hashless = { ...outcome('dep#b', 'x'), status: 'skipped' as const }
    delete (hashless as { hash?: string }).hash
    const up = [outcome('self#a', 'h-a'), hashless]

    expect(filterUpstreamHashes(up, undefined, 'self', 'self#build')).toEqual([['self#a', 'h-a']])
    expect(filterUpstreamHashes(up, ['*', '^*'], 'self', 'self#build')).toEqual([['self#a', 'h-a']])

    // CONTROL: the same outcome WITH a hash does contribute, so the row
    // above is the missing hash and not a mis-built fixture.
    const withHash = { ...hashless, hash: 'h-b' }
    expect(
      filterUpstreamHashes([outcome('self#a', 'h-a'), withHash], ['*', '^*'], 'self', 'self#build'),
    ).toEqual([
      ['self#a', 'h-a'],
      ['dep#b', 'h-b'],
    ])
  })

  it('empty filter → nothing contributes (fully decoupled)', () => {
    const up = [outcome('self#a', 'h-a'), outcome('dep#b', 'h-b')]
    expect(filterUpstreamHashes(up, [], 'self', 'self#build')).toEqual([])
  })

  it('!name (self-project negation) removes only that same-project task', () => {
    const up = [outcome('self#foo', 'h-foo'), outcome('self#bar', 'h-bar')]
    // `*` selects both same-project upstreams, then `!foo` deletes foo.
    const out = filterUpstreamHashes(up, ['*', '!foo'], 'self', 'self#build')
    expect(out).toEqual([['self#bar', 'h-bar']])
    // The negated hash must be gone entirely.
    expect(out.some(([, h]) => h === 'h-foo')).toBe(false)
  })

  it('!^noisy (dep-workspace negation) removes only that dep task', () => {
    const up = [outcome('dep#noisy', 'h-noisy')]
    // `^*` selects every dep-workspace upstream; `!^noisy` deletes noisy.
    expect(filterUpstreamHashes(up, ['^*', '!^noisy'], 'self', 'self#build')).toEqual([])
  })

  it("['*','^*','!^noisy'] applies in order (last write wins): keeps self + non-noisy deps", () => {
    const up = [outcome('self#a', 'h-a'), outcome('dep#b', 'h-b'), outcome('dep#noisy', 'h-noisy')]
    const out = filterUpstreamHashes(up, ['*', '^*', '!^noisy'], 'self', 'self#build')
    expect(out).toEqual([
      ['self#a', 'h-a'],
      ['dep#b', 'h-b'],
    ])
    expect(out.some(([, h]) => h === 'h-noisy')).toBe(false)
  })

  it('dedups by hash, keeping the FIRST upstream id seen for that hash', () => {
    const up = [outcome('self#x', 'dup'), outcome('self#y', 'dup')]
    // Both tasks share the hash `dup`; only one pair survives, named by
    // the first task encountered (self#x).
    expect(filterUpstreamHashes(up, ['*'], 'self', 'self#build')).toEqual([['self#x', 'dup']])
  })

  it('wraps an invalid filter spec in a UserError naming the task', () => {
    const up = [outcome('self#a', 'h-a')]
    expect(() => filterUpstreamHashes(up, ['^'], 'self', 'self#build')).toThrow(UserError)
    expect(() => filterUpstreamHashes(up, ['^'], 'self', 'self#build')).toThrow(
      /self#build: cache\.inputs\.tasks/,
    )
  })

  // ─── task-name patterns — the same glob dependsOn expands must SELECT here.
  // A filter matching 'build.*' literally while dependsOn expanded it would
  // silently pick ZERO upstream hashes → stale cache hits (repro-confirmed).
  describe('task-name patterns', () => {
    const up = [
      outcome('self#build.js', 'h-js'),
      outcome('self#build.dts', 'h-dts'),
      outcome('self#lint', 'h-lint'),
      outcome('dep#build.wasm', 'h-wasm'),
      outcome('other#codegen.v2', 'h-cg'),
    ]

    it("'build.*' selects every matching same-project upstream, nothing else", () => {
      const out = filterUpstreamHashes(up, ['build.*'], 'self', 'self#top')
      expect(out.map(([id]) => id).sort()).toEqual(['self#build.dts', 'self#build.js'])
    })

    it("'^build.*' selects matching dep-workspace upstream only", () => {
      expect(filterUpstreamHashes(up, ['^build.*'], 'self', 'self#top')).toEqual([
        ['dep#build.wasm', 'h-wasm'],
      ])
    })

    it("'pkg#pattern' works as a filter (unlike dependsOn, which rejects it)", () => {
      expect(filterUpstreamHashes(up, ['other#codegen.*'], 'self', 'self#top')).toEqual([
        ['other#codegen.v2', 'h-cg'],
      ])
    })

    it("negated patterns subtract: ['*', '!build.*'] keeps only non-matching self tasks", () => {
      expect(filterUpstreamHashes(up, ['*', '!build.*'], 'self', 'self#top')).toEqual([
        ['self#lint', 'h-lint'],
      ])
    })
  })

  // The PROJECT half globs too. Comparing it literally selected ZERO upstream
  // hashes, silently decoupling the task from its dependencies — the same
  // stale-hit trap the task half had (repro-confirmed), plus a negation that
  // subtracted nothing.
  describe('project-name patterns', () => {
    const up = [
      outcome('@acme/core#build', 'h-core'),
      outcome('@acme/ui#build', 'h-ui'),
      outcome('vendor/lib#build', 'h-vendor'),
      outcome('@acme/core#lint', 'h-lint'),
    ]

    it("'@acme/*#build' selects every matching project's build, nothing else", () => {
      const out = filterUpstreamHashes(up, ['@acme/*#build'], 'self', 'self#top')
      expect(out.map(([id]) => id).sort()).toEqual(['@acme/core#build', '@acme/ui#build'])
    })

    it("'*#build' selects every project's build", () => {
      const out = filterUpstreamHashes(up, ['*#build'], 'self', 'self#top')
      expect(out.map(([id]) => id).sort()).toEqual([
        '@acme/core#build',
        '@acme/ui#build',
        'vendor/lib#build',
      ])
    })

    it("negation subtracts: ['^build', '!@acme/*#build'] drops the matched projects", () => {
      const out = filterUpstreamHashes(up, ['^build', '!@acme/*#build'], 'self', 'self#top')
      expect(out).toEqual([['vendor/lib#build', 'h-vendor']])
    })

    it('a pattern matching no project selects nothing', () => {
      expect(filterUpstreamHashes(up, ['nope-*#build'], 'self', 'self#top')).toEqual([])
    })

    it('an exact project name still matches only that project', () => {
      expect(filterUpstreamHashes(up, ['@acme/core#build'], 'self', 'self#top')).toEqual([
        ['@acme/core#build', 'h-core'],
      ])
    })
  })
})

describe('expandGroupUpstream', () => {
  const group = (id: string, members: TaskOutcome[]): TaskOutcome => ({
    ...outcome(id, `h-${id}`),
    groupUpstream: members,
  })
  const ids = (list: readonly TaskOutcome[]): string[] => list.map((u) => u.node.id)

  it('expands nested groups depth-first, in order, each task once', () => {
    const a = outcome('p#a', 'h-a')
    const up = [
      group('p#g1', [a, group('p#g2', [outcome('p#b', 'h-b'), a])]),
      outcome('p#c', 'h-c'),
    ]
    expect(ids(expandGroupUpstream(up))).toEqual(['p#a', 'p#b', 'p#c'])
  })

  // A chain of groups nests one outcome per group, and a recursion per
  // level threw `RangeError` into the consumer at 50,000 (its run failed as
  // an internal error), where the builder takes that depth (item 737).
  it('a 50,000-deep chain of groups expands to the task at its bottom', () => {
    let up = [outcome('p#leaf', 'h-leaf')]
    for (let i = 0; i < 50_000; i++) up = [group(`p#g${i}`, up)]
    expect(ids(expandGroupUpstream(up))).toEqual(['p#leaf'])
  })

  // Groups over a shared group (`build` as a group whose `^build` meets a
  // package diamond) reach it once per path; each group's members are read
  // once, or the walk doubles per layer (2^16 paths here).
  it('a group reached twice is walked once: 16 diamonds read 49 groups once each', () => {
    let reads = 0
    const counted = (id: string, members: TaskOutcome[]): TaskOutcome => {
      const o = outcome(id, `h-${id}`)
      Object.defineProperty(o, 'groupUpstream', {
        get: () => {
          reads++
          return members
        },
      })
      return o
    }
    let bottom = counted('p#g0', [outcome('p#leaf', 'h-leaf')])
    for (let i = 1; i <= 16; i++) {
      bottom = counted(`p#g${i}`, [counted(`p#l${i}`, [bottom]), counted(`p#r${i}`, [bottom])])
    }
    expect([ids(expandGroupUpstream([bottom])), reads]).toEqual([['p#leaf'], 49])
  })
})
