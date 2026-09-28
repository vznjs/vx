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
// `taintTracker` takes the outcomes directly, which is exactly the
// fabrication an e2e cannot do — and it lives here rather than in that file
// because that file's fixture builds a git repo per case, which these rows
// have no use for.

import { describe, expect, it } from 'bun:test'
import { taintTracker } from '../src/orchestrator/admission.js'
import { excludedTaint } from '../src/orchestrator/excluded-keys.js'
import type { TaskNode, TaskOutcome } from '../src/graph/index.js'

describe('taintTracker — which upstream outcomes poison a task', () => {
  // A graph of `id: deps` and a tracker over it; `settle` feeds it what the
  // scheduler's `onFinish` would.
  const graph = (edges: Record<string, string[]>): Map<string, TaskNode> =>
    new Map(Object.entries(edges).map(([id, deps]) => [id, { id, deps } as TaskNode]))
  const EDGES = { a: [], b: ['a'], c: ['b'], d: ['a'] }
  const node = (id: string): TaskNode => ({ id, deps: [] }) as unknown as TaskNode
  const from = (id: string, status: TaskOutcome['status']): TaskOutcome =>
    ({ node: node(id), status }) as TaskOutcome
  const NONE: ReadonlySet<string> = new Set()

  for (const status of ['failed', 'aborted', 'skipped'] as const) {
    it(`an upstream that ${status} taints its dependent`, () => {
      const t = taintTracker(true, NONE, graph(EDGES))
      expect(t.judge(node('b'), [from('a', status)])).toBe(true)
    })
  }

  it('a successful upstream does not', () => {
    const t = taintTracker(true, NONE, graph(EDGES))
    expect(t.judge(node('b'), [from('a', 'success')])).toBe(false)
    expect(t.judge(node('c'), [from('a', 'cache-hit')])).toBe(false)
  })

  it('the taint is TRANSITIVE: a grand-dependent of a failure is poisoned too', () => {
    // Without this the grand-dependent caches the same partial tree one hop
    // later, which is the comment's own reason for tracking at all.
    const t = taintTracker(true, NONE, graph(EDGES))
    t.settled(from('a', 'failed'))
    expect(t.judge(node('b'), [from('a', 'failed')])).toBe(true)
    t.settled(from('b', 'success'))
    expect(t.judge(node('c'), [from('b', 'success')])).toBe(true)
  })

  // C-1: a restore-tier hit dispatches before its deps settle and sees a
  // hole where the failure will be. Its dependent asked the verdict that
  // hole gave, heard "clean", and saved the partial tree on its healthy key.
  it('a hit judged before its deps settled passes on the failure they settled to', () => {
    const t = taintTracker(true, NONE, graph(EDGES))
    expect(t.judge(node('b'), [undefined as unknown as TaskOutcome])).toBe(false)
    t.settled(from('b', 'cache-hit'))
    t.settled(from('a', 'failed'))
    expect(t.judge(node('c'), [from('b', 'cache-hit')])).toBe(true)
    // CONTROL: the same order over a dep that succeeded passes nothing on.
    const clean = taintTracker(true, NONE, graph(EDGES))
    expect(clean.judge(node('b'), [undefined as unknown as TaskOutcome])).toBe(false)
    clean.settled(from('b', 'cache-hit'))
    clean.settled(from('a', 'success'))
    expect(clean.judge(node('c'), [from('b', 'cache-hit')])).toBe(false)
  })

  // C-23: `c`'s answer was kept once its direct dep `b` had settled, while
  // `a` below `b` still ran. When `a` failed, whatever hung off `c` was
  // judged clean and saved the partial tree on its healthy key.
  it('a clean answer is not kept while a dep further down still runs', () => {
    const t = taintTracker(true, NONE, graph({ a: [], b: ['a'], c: ['b'] }))
    t.settled(from('b', 'cache-hit'))
    t.settled(from('c', 'cache-hit'))
    expect(t.judge(node('d'), [from('c', 'cache-hit')])).toBe(false)
    t.settled(from('a', 'failed'))
    expect(t.judge(node('d'), [from('c', 'cache-hit')])).toBe(true)
  })

  it('a 50,000-deep chain of early hits is judged without a frame per hop', () => {
    const DEPTH = 50_000
    const edges: Record<string, string[]> = {}
    for (let i = 0; i < DEPTH; i++) edges[`t${i}`] = i + 1 < DEPTH ? [`t${i + 1}`] : []
    const t = taintTracker(true, NONE, graph(edges))
    for (let i = 0; i < DEPTH - 1; i++) t.settled(from(`t${i}`, 'cache-hit'))
    t.settled(from(`t${DEPTH - 1}`, 'failed'))
    expect(t.judge(node('top'), [from('t0', 'cache-hit')])).toBe(true)
  })

  // `--exclude-dependencies`: a task keyed on a dependency that did not run
  // (excluded-keys.ts) is poison from the start, and so is what it feeds.
  it('a seed is tainted with no failure upstream, and passes it on', () => {
    const t = taintTracker(false, new Set(['b']), graph(EDGES))
    expect(t.judge(node('a'), [])).toBe(false)
    t.settled(from('a', 'success'))
    expect(t.judge(node('b'), [from('a', 'success')])).toBe(true)
    t.settled(from('b', 'success'))
    expect(t.judge(node('c'), [from('b', 'success')])).toBe(true)
    expect(t.judge(node('d'), [from('a', 'success')])).toBe(false)
  })

  it('a seed does not make a failure poison outside --continue=always', () => {
    const t = taintTracker(false, new Set(['z']), graph(EDGES))
    t.settled(from('a', 'failed'))
    expect(t.judge(node('b'), [from('a', 'failed')])).toBe(false)
  })

  // A graph whose lookups are counted: the walk reads a node's deps once per
  // visit, so the count is what an ask cost. Past `limit` it throws, so a
  // walk that never ends fails the row instead of hanging the file.
  const counted = (edges: Record<string, string[]>, limit = 1_000) => {
    const g = graph(edges)
    let gets = 0
    const nodes = {
      get: (id: string) => {
        if (++gets > limit) throw new Error('the walk did not end')
        return g.get(id)
      },
    } as unknown as ReadonlyMap<string, TaskNode>
    return { nodes, gets: () => gets }
  }

  // A hit's dependent can be asked while a dep below the hit still runs.
  // "Clean so far" is not an answer to keep: that dep may yet fail.
  it('a clean answer given while a dep is still running is not kept', () => {
    const { nodes } = counted({ a: [], b: ['a'], c: ['b'] })
    const t = taintTracker(true, NONE, nodes)
    t.settled(from('c', 'cache-hit'))
    t.settled(from('b', 'cache-hit'))
    expect(t.judge(node('x'), [from('c', 'cache-hit')])).toBe(false)
    expect(t.judge(node('x'), [from('b', 'cache-hit')])).toBe(false)
    t.settled(from('a', 'failed'))
    expect(t.judge(node('x'), [from('b', 'cache-hit')])).toBe(true)
  })

  it('a settled answer is walked once, and a failed dep is not walked', () => {
    const edges: Record<string, string[]> = { e: ['f', 'g'], f: ['h'], g: [], h: [] }
    for (let i = 0; i < 10; i++) edges[`t${i}`] = i < 9 ? [`t${i + 1}`] : []
    const { nodes, gets } = counted(edges)
    const t = taintTracker(true, NONE, nodes)
    for (let i = 0; i < 9; i++) t.settled(from(`t${i}`, 'cache-hit'))
    t.settled(from('t9', 'success'))
    t.settled(from('e', 'cache-hit'))
    t.settled(from('f', 'failed'))
    t.settled(from('h', 'success'))
    const cost: number[] = []
    const ask = (dep: string): boolean => {
      const before = gets()
      const tainted = t.judge(node('x'), [from(dep, 'cache-hit')])
      cost.push(gets() - before)
      return tainted
    }
    // `e` is tainted by `f` while `g` still runs: taint only grows, so it
    // is kept at once.
    expect([ask('t5'), ask('t0'), ask('t0'), ask('e'), ask('e')]).toEqual([
      false,
      false,
      false,
      true,
      true,
    ])
    expect(cost).toEqual([9, 9, 0, 1, 0])
  })

  it('a seed is tainted without a walk below it', () => {
    const { nodes, gets } = counted({ s: ['a'], a: [] })
    const t = taintTracker(false, new Set(['s']), nodes)
    t.settled(from('a', 'success'))
    t.settled(from('s', 'success'))
    expect(t.judge(node('x'), [from('s', 'success')])).toBe(true)
    expect(gets()).toBe(0)
  })

  it('a disabled tracker never walks', () => {
    const { nodes, gets } = counted(EDGES)
    const t = taintTracker(false, NONE, nodes)
    t.settled(from('a', 'success'))
    expect(t.judge(node('b'), [from('a', 'success')])).toBe(false)
    expect(gets()).toBe(0)
  })

  it('disabled unless the run is --continue=always: nothing is poison', () => {
    // The zero-cost gate for every other mode. Only `always` ever executes a
    // task behind a failure, so the other modes carry no check at all.
    const t = taintTracker(false, NONE, graph(EDGES))
    t.settled(from('a', 'failed'))
    expect(t.judge(node('b'), [from('a', 'failed')])).toBe(false)
    expect(t.judge(node('c'), [from('b', 'aborted')])).toBe(false)
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
