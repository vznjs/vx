// The taint rule as a rule, apart from the run that exercises it.
//
// `continue-taint.test.ts` drives `--continue=always` end to end and reaches
// exactly two of the four upstream outcomes `taintTracker` treats as poison:
// a `failed` upstream and the transitive hop through it. Dropping `'aborted'`
// or `'skipped'` from the rule survives every test in the repo (measured
// 2026-09-20), and no e2e can close that: the run shapes that produce those
// statuses under `--continue=always` are the ones a SIGINT or a filter
// creates, and arranging them races the thing being tested.
//
// `taintTracker` takes the upstream outcomes directly, which is exactly the
// fabrication an e2e cannot do — and it lives here rather than in that file
// because that file's fixture builds a git repo per case, which these rows
// have no use for.

import { describe, expect, it } from 'bun:test'
import { taintTracker } from '../src/orchestrator/admission.js'
import { excludedTaint } from '../src/orchestrator/excluded-keys.js'
import type { TaskNode, TaskOutcome } from '../src/graph/index.js'

describe('taintTracker — which upstream outcomes poison a task', () => {
  const node = (id: string): TaskNode => ({ id }) as TaskNode
  const from = (id: string, status: TaskOutcome['status']): TaskOutcome =>
    ({ node: node(id), status }) as TaskOutcome
  const NONE: ReadonlySet<string> = new Set()

  for (const status of ['failed', 'aborted', 'skipped'] as const) {
    it(`an upstream that ${status} taints its dependent`, () => {
      const isTainted = taintTracker(true, NONE)
      expect(isTainted(node('b'), [from('a', status)])).toBe(true)
    })
  }

  it('a successful upstream does not', () => {
    const isTainted = taintTracker(true, NONE)
    expect(isTainted(node('b'), [from('a', 'success')])).toBe(false)
    expect(isTainted(node('c'), [from('a', 'cache-hit')])).toBe(false)
  })

  it('the taint is TRANSITIVE: a grand-dependent of a failure is poisoned too', () => {
    // Without this the grand-dependent caches the same partial tree one hop
    // later, which is the comment's own reason for tracking at all.
    const isTainted = taintTracker(true, NONE)
    expect(isTainted(node('b'), [from('a', 'failed')])).toBe(true)
    expect(isTainted(node('c'), [from('b', 'success')])).toBe(true)
  })

  // `--exclude-dependencies`: a task keyed on a dependency that did not run
  // (excluded-keys.ts) is poison from the start, and so is what it feeds.
  it('a seed is tainted with no failure upstream, and passes it on', () => {
    const isTainted = taintTracker(false, new Set(['b']))
    expect(isTainted(node('a'), [])).toBe(false)
    expect(isTainted(node('b'), [from('a', 'success')])).toBe(true)
    expect(isTainted(node('c'), [from('b', 'success')])).toBe(true)
    expect(isTainted(node('d'), [from('a', 'success')])).toBe(false)
  })

  it('a seed does not make a failure poison outside --continue=always', () => {
    const isTainted = taintTracker(false, new Set(['z']))
    expect(isTainted(node('b'), [from('a', 'failed')])).toBe(false)
  })

  it('disabled unless the run is --continue=always: nothing is poison', () => {
    // The zero-cost gate for every other mode. Only `always` ever executes a
    // task behind a failure, so the other modes carry no check at all.
    const isTainted = taintTracker(false, NONE)
    expect(isTainted(node('b'), [from('a', 'failed')])).toBe(false)
    expect(isTainted(node('c'), [from('b', 'aborted')])).toBe(false)
  })
})

// The count behind `--exclude-dependencies`' one line walks the scheduled
// graph from its seeds. A walk that re-scanned every node until nothing
// grew was one pass per hop, quadratic on a deep chain whose seed sits at
// the bottom (a name-list flag drops one edge 50,000 tasks down).
describe('excludedTaint — which scheduled tasks build on a skipped key', () => {
  const task = (id: string, deps: string[], cached: boolean): TaskNode =>
    ({
      id,
      deps,
      projectName: 'app',
      config: cached ? { cache: { inputs: { files: ['src/**'] } } } : {},
    }) as unknown as TaskNode
  const skipped = (node: TaskNode): TaskNode => ({
    ...node,
    excludedUpstream: [
      { node: task('lib#gen', [], true), status: 'success', exitCode: 0, durationMs: 0, hash: 'h' },
    ],
  })

  it('reaches every dependant of a seed, counting only what would save', () => {
    const nodes = new Map<string, TaskNode>()
    for (const n of [
      task('app#top', ['app#mid'], true),
      task('app#mid', ['app#seed'], false),
      skipped(task('app#seed', [], true)),
      task('app#aside', [], true),
    ]) {
      nodes.set(n.id, n)
    }
    const { seeds, unsaved } = excludedTaint(nodes)
    expect([[...seeds], unsaved]).toEqual([['app#seed'], 2])
  })

  it('a 50,000-deep chain seeded at the bottom is one walk, not one pass per hop', () => {
    const DEPTH = 50_000
    const nodes = new Map<string, TaskNode>()
    for (let i = 0; i < DEPTH; i++) {
      const n = task(`app#t${i}`, i + 1 < DEPTH ? [`app#t${i + 1}`] : [], true)
      nodes.set(n.id, i + 1 < DEPTH ? n : skipped(n))
    }
    expect(excludedTaint(nodes).unsaved).toBe(DEPTH)
  })
})
