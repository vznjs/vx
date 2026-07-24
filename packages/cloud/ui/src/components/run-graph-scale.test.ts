// Scale guard for the dashboard run-graph pure layout functions. A big run's
// DAG (a monorepo `vx run` can spawn thousands of task nodes) flows through
// contractGroups → layoutLevels (columns) and criticalPath + parallelism
// (the cockpit's wall-time floor / observed concurrency). These are O(N+E)
// but RECURSION-based (level()/finish()/resolve() recurse over deps), so the
// two risks at scale are (1) a super-linear blowup and (2) stack overflow on
// a DEEP dependency chain.
//
// Methodology mirrors tests/scheduler.test.ts's priority-scale guard: min of
// several runs (de-noises machine load), a generous bound guarding
// ALGORITHMIC COMPLEXITY (not absolute speed), and a functional correctness
// pin at scale (validated against an INDEPENDENT iterative oracle, not the
// implementation).

import { describe, expect, it } from 'bun:test'
import { contractGroups, layoutLevels } from './run-graph-layout.ts'
import { criticalPath, parallelism } from './critical-path.ts'

interface GNode {
  id: string
  deps: string[]
  isGroup: boolean
}

/**
 * A wide, dense DAG: `levels` columns of `width` nodes, each node depending on
 * a few nodes drawn from the previous 3 levels. Nodes are emitted in level
 * order, so INPUT ORDER IS A TOPOLOGICAL ORDER — the oracle below can relax in
 * one linear pass. Mirrors the scheduler guard's 100×30 shape.
 */
function denseDag(levels: number, width: number): GNode[] {
  const nodes: GNode[] = []
  const byLevel: string[][] = []
  for (let l = 0; l < levels; l++) {
    const cur: string[] = []
    const pool = byLevel.slice(Math.max(0, l - 3), l).flat()
    for (let w = 0; w < width; w++) {
      const id = `l${l}-${w}`
      const deps: string[] = []
      if (pool.length > 0) {
        for (let k = 0; k < 4; k++) {
          const pick = pool[(w * 7 + k * 13 + l * 5) % pool.length]!
          if (!deps.includes(pick)) deps.push(pick)
        }
      }
      nodes.push({ id, deps, isGroup: false })
      cur.push(id)
    }
    byLevel.push(cur)
  }
  return nodes
}

/** Independent longest-dependency-DEPTH per node (topo order = input order). */
function depthOracle(nodes: GNode[]): { depthOf: Map<string, number>; levelCount: number } {
  const has = new Set(nodes.map((n) => n.id))
  const depthOf = new Map<string, number>()
  let max = 0
  for (const n of nodes) {
    const deps = n.deps.filter((d) => has.has(d))
    const d = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((x) => depthOf.get(x)!))
    depthOf.set(n.id, d)
    if (d > max) max = d
  }
  return { depthOf, levelCount: nodes.length === 0 ? 0 : max + 1 }
}

/** Independent longest-DURATION path total (topo order = input order). */
function longestDurationOracle(nodes: GNode[], dur: (id: string) => number): number {
  const has = new Set(nodes.map((n) => n.id))
  const finish = new Map<string, number>()
  let best = 0
  for (const n of nodes) {
    let depMax = 0
    for (const d of n.deps) if (has.has(d)) depMax = Math.max(depMax, finish.get(d)!)
    const f = depMax + Math.max(0, dur(n.id))
    finish.set(n.id, f)
    if (f > best) best = f
  }
  return best
}

const bestOf = (n: number, fn: () => void): number => {
  let best = Infinity
  for (let i = 0; i < n; i++) {
    const t = performance.now()
    fn()
    best = Math.min(best, performance.now() - t)
  }
  return best
}

describe('run-graph layout — wide dense DAG (~3000 nodes)', () => {
  const nodes = denseDag(100, 30)
  const dur = (id: string): number => (Number(id.slice(id.indexOf('-') + 1)) % 50) + 1

  it('lays out correctly at scale: strict dep-before-dependent levels', () => {
    const contracted = contractGroups(nodes)
    const { pos, levelCount } = layoutLevels(contracted)
    expect(contracted.length).toBe(3000)

    // Every edge points from a strictly lower level to a higher one.
    for (const n of contracted) {
      const lv = pos.get(n.id)!.level
      for (const d of n.deps) {
        expect(pos.get(d)!.level).toBeLessThan(lv)
      }
    }
    // levelCount matches the independent longest-depth oracle.
    const oracle = depthOracle(nodes)
    expect(levelCount).toBe(oracle.levelCount)
    for (const n of nodes) expect(pos.get(n.id)!.level).toBe(oracle.depthOf.get(n.id))
  })

  it('critical path equals the true longest-duration chain', () => {
    const cp = criticalPath(nodes, dur)
    expect(cp.totalMs).toBe(longestDurationOracle(nodes, dur))
    // The returned chain is a real dependency chain whose own durations sum to
    // the reported floor.
    let sum = 0
    for (let i = 0; i < cp.chain.length; i++) {
      sum += dur(cp.chain[i]!)
      if (i > 0) {
        const node = nodes.find((n) => n.id === cp.chain[i])!
        expect(node.deps).toContain(cp.chain[i - 1])
      }
    }
    expect(sum).toBe(cp.totalMs)
  })

  it('stays within a generous wall-clock bound', () => {
    // Calibration (this machine): contractGroups→layoutLevels ~11 ms,
    // criticalPath ~2 ms over 3000 nodes / ~12k edges. Bound at ~30-45x —
    // separates a linear layout from an accidental O(N^2) (which on this shape
    // would be seconds) while staying robust to CI noise.
    const layoutMs = bestOf(5, () => {
      layoutLevels(contractGroups(nodes))
    })
    const critMs = bestOf(5, () => {
      criticalPath(nodes, dur)
    })
    expect(layoutMs).toBeLessThan(500)
    expect(critMs).toBeLessThan(300)
  }, 120_000)
})

describe('run-graph layout — deep linear chain (stack safety)', () => {
  // A long dependency chain is the real scale risk for the recursion-based
  // traversals (V8's stack is ~10-15k frames; graph/scheduler.ts:detectCycle
  // was rewritten iteratively for exactly this). Observed here: under Bun
  // (JSC, the test runtime) layoutLevels survives to ~800k deep and
  // criticalPath / contractGroups well past that; Node 22 (V8) survives past
  // 50k in this env. So this depth is comfortably within the runtime's stack
  // and pins that deep chains neither throw nor mis-compute.
  const DEPTH = 8000

  function deepChain(n: number): GNode[] {
    const out: GNode[] = []
    for (let i = 0; i < n; i++) {
      out.push({ id: `n${i}`, deps: i === 0 ? [] : [`n${i - 1}`], isGroup: false })
    }
    return out
  }

  // leaf(non-group) → g1(group) → g2(group) → … → gN(group) → top(non-group):
  // contracting `top` walks resolve() N deep through the group spine.
  function deepGroupChain(n: number): GNode[] {
    const out: GNode[] = [{ id: 'leaf', deps: [], isGroup: false }]
    let prev = 'leaf'
    for (let i = 1; i < n; i++) {
      const id = `g${i}`
      out.push({ id, deps: [prev], isGroup: true })
      prev = id
    }
    out.push({ id: 'top', deps: [prev], isGroup: false })
    return out
  }

  it('layoutLevels handles a deep chain without overflow or mis-leveling', () => {
    const chain = deepChain(DEPTH)
    const { pos, levelCount, maxRows } = layoutLevels(chain)
    expect(levelCount).toBe(DEPTH) // each link one level deeper
    expect(maxRows).toBe(1) // one node per level
    expect(pos.get('n0')!.level).toBe(0)
    expect(pos.get(`n${DEPTH - 1}`)!.level).toBe(DEPTH - 1)
  })

  it('criticalPath handles a deep chain — the whole chain is the floor', () => {
    const chain = deepChain(DEPTH)
    const dur = (id: string): number => (Number(id.slice(1)) % 10) + 1
    const cp = criticalPath(chain, dur)
    expect(cp.chain.length).toBe(DEPTH)
    expect(cp.chain[0]).toBe('n0')
    expect(cp.chain[DEPTH - 1]).toBe(`n${DEPTH - 1}`)
    let expected = 0
    for (let i = 0; i < DEPTH; i++) expected += (i % 10) + 1
    expect(cp.totalMs).toBe(expected)
  })

  it('contractGroups handles a deep group spine without overflow', () => {
    const gchain = deepGroupChain(DEPTH)
    const out = contractGroups(gchain)
    // Only the two non-group nodes survive; `top`'s edge contracts through the
    // entire group spine straight to `leaf`.
    expect(out.map((n) => n.id).sort()).toEqual(['leaf', 'top'])
    const top = out.find((n) => n.id === 'top')!
    expect(top.deps).toEqual(['leaf'])
  })

  it('stays within a generous wall-clock bound at depth', () => {
    // Calibration (this machine): layoutLevels ~10 ms, criticalPath ~7 ms,
    // contractGroups ~5 ms at depth 8000. Bound the combined pass generously.
    const chain = deepChain(DEPTH)
    const gchain = deepGroupChain(DEPTH)
    const dur = (id: string): number => 1
    const ms = bestOf(5, () => {
      layoutLevels(chain)
      criticalPath(chain, dur)
      contractGroups(gchain)
    })
    expect(ms).toBeLessThan(2000)
  }, 120_000)
})

describe('parallelism sweep at scale', () => {
  it('finds peak concurrency over many intervals, fast', () => {
    // 5000 intervals all overlapping one window → peak concurrency = 5000.
    const N = 5000
    const overlapping = Array.from({ length: N }, (_, i) => ({
      startedAt: 1_000_000 + i,
      endedAt: 2_000_000 - i,
    }))
    const stats = parallelism(overlapping)
    expect(stats.maxConcurrent).toBe(N)

    // A staircase (each starts after the previous ends) → peak 1.
    const staircase = Array.from({ length: N }, (_, i) => ({
      startedAt: i * 10,
      endedAt: i * 10 + 10,
    }))
    expect(parallelism(staircase).maxConcurrent).toBe(1)

    // Calibration: ~2 ms for 5000 intervals (an O(N log N) sort). Bound ~100x.
    const ms = bestOf(5, () => {
      parallelism(overlapping)
    })
    expect(ms).toBeLessThan(300)
  }, 120_000)
})
