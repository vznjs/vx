// bench/ideal.ts computes the benchmark's "baseline" bar: the tasks' own
// durations list-scheduled critical-path-first on N workers. A wrong
// schedule is a wrong floor on the website, and the first version was: a
// FIFO order read 4m 58s against vx's own 3m 46s. These graphs have optima
// computable by hand.

import { describe, expect, it } from 'bun:test'
import { listSchedule, type GraphNode } from '../ideal.js'

const s = 1000
describe('listSchedule', () => {
  it('a diamond of one-second tasks on two workers takes the critical path, 3 s', () => {
    const g: GraphNode[] = [
      { id: 'a', dur: s, deps: [] },
      { id: 'b', dur: s, deps: [0] },
      { id: 'c', dur: s, deps: [0] },
      { id: 'd', dur: s, deps: [1, 2] },
    ]
    expect(listSchedule(g, 2)).toEqual({ makespan: 3 * s, critical: 3 * s, work: 4 * s })
  })

  it('runs the node that gates the most downstream work first (FIFO needs 4 s; the optimum is 3 s)', () => {
    // A three-task chain beside three independent tasks, two workers. The
    // optimum interleaves the chain with the singles: 3 s (work 6 s ÷ 2, and
    // the chain is 3 s). FIFO, with the singles listed first, exhausts them
    // before starting the chain and needs 4 s.
    const g: GraphNode[] = [
      { id: 'single1', dur: s, deps: [] },
      { id: 'single2', dur: s, deps: [] },
      { id: 'single3', dur: s, deps: [] },
      { id: 'chain1', dur: s, deps: [] },
      { id: 'chain2', dur: s, deps: [3] },
      { id: 'chain3', dur: s, deps: [4] },
    ]
    expect(listSchedule(g, 2)).toEqual({ makespan: 3 * s, critical: 3 * s, work: 6 * s })
  })

  it('a pure ordering node costs nothing and a work-bound graph is bound by the work', () => {
    const g: GraphNode[] = [
      { id: 'gate', dur: 0, deps: [] },
      ...Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, dur: s, deps: [0] })),
    ]
    expect(listSchedule(g, 3)).toEqual({ makespan: 2 * s, critical: s, work: 6 * s })
    expect(listSchedule([], 4)).toEqual({ makespan: 0, critical: 0, work: 0 })
  })

  it('refuses a cycle', () => {
    const g: GraphNode[] = [
      { id: 'a', dur: s, deps: [1] },
      { id: 'b', dur: s, deps: [0] },
    ]
    expect(() => listSchedule(g, 1)).toThrow(/cycle/)
  })
})
