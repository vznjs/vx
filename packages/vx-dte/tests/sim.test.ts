// What a distributed run must look like, played by `sim.ts` on the plugin's
// own decide + dispatch over runs main really had. A scheduling change lands
// only when these hold. `it.failing` marks what does not hold yet (2026-10-23):
// it fails the suite once fixed, so the mark comes off with the fix.

import { describe, expect, it } from 'bun:test'
import type { Size } from '../src/planner.js'
import a09 from './fixtures/main-run-a09b987.json'
import f2163 from './fixtures/main-run-2026-10-23.json'
import { bestMs, simulate, type SimResult, type SimTask } from './sim.js'

const small: Size = { name: 'small', max: 12, cpu: 4, memory: 16e9 }
type Ran = { ms: number; cores: number; memory: number }

interface Fixture {
  readonly nodes: readonly { id: string; deps: string[]; exec: boolean; cache: boolean }[]
  readonly ran: Record<string, readonly number[]>
}

/** The fixture's graph; `known` is what history said before the run (default: how it ran). */
function load(f: Fixture, known?: (r: Ran) => Ran | null): SimTask[] {
  return f.nodes.map((n) => {
    const r = f.ran[n.id]
    if (r === undefined) return n
    const ran = { ms: r[0]!, cores: r[1]!, memory: r[2]! * 1e6 }
    return { ...n, ran, ...(known === undefined ? {} : { known: known(ran) }) }
  })
}

/** A build, then 32 tests on it, then 8 checks each on four tests: misses arrive in waves. */
function growing(): SimTask[] {
  const t = (id: string, deps: string[], ms: number, cores: number): SimTask => ({
    id,
    deps,
    exec: true,
    cache: true,
    ran: { ms, cores, memory: 5e8 },
  })
  const tests = Array.from({ length: 32 }, (_, i) =>
    t(`test${i}`, ['build'], 20_000 + (i % 5) * 4_000, 1),
  )
  const checks = Array.from({ length: 8 }, (_, i) =>
    t(
      `check${i}`,
      tests.slice(i * 4, i * 4 + 4).map((x) => x.id),
      15_000,
      2,
    ),
  )
  return [t('build', [], 10_000, 3), ...tests, ...checks]
}

const joined = (r: SimResult) => r.workers.filter((w) => w.joinedAt !== undefined)

interface Case {
  readonly name: string
  readonly graph: SimTask[]
  /** Its history is real, so utilization and makespan are judged. */
  readonly measured: boolean
  /** Invariants it breaks today. */
  readonly failing?: readonly string[]
}

const cases: Case[] = [
  {
    name: 'main a09b987 (65 misses)',
    graph: load(a09),
    measured: true,
    failing: ['utilization', 'makespan'],
  },
  {
    name: 'main 2163fff (23 misses)',
    graph: load(f2163),
    measured: true,
    failing: ['utilization', 'makespan'],
  },
  {
    name: 'a growing graph',
    graph: growing(),
    measured: true,
    failing: ['every worker that joins runs a task', 'utilization'],
  },
  {
    name: 'main a09b987, history 40% high on cores',
    graph: load(a09, (r) => ({ ...r, cores: r.cores * 1.4 })),
    measured: true,
    failing: ['utilization', 'makespan'],
  },
  { name: 'main a09b987, no history', graph: load(a09, () => null), measured: false },
  {
    name: 'main 2163fff, no history',
    graph: load(f2163, () => null),
    measured: false,
    failing: ['churn'],
  },
]

for (const c of cases) {
  describe(c.name, () => {
    const r = simulate(c.graph, { sizes: [small] })
    const check = (name: string, body: () => void) =>
      (c.failing?.includes(name) === true ? it.failing : it)(name, body)

    check('every worker that joins runs a task', () => {
      expect(
        joined(r)
          .filter((w) => w.tasks === 0)
          .map((w) => w.id),
      ).toEqual([])
    })
    check('no worker is booked past its cores', () => {
      for (const w of r.workers) expect(w.peakBooked).toBeLessThanOrEqual(w.cores + 1e-9)
    })
    check('every miss runs on a worker, once', () => {
      expect(r.workers.reduce((n, w) => n + w.tasks, 0)).toBe(r.executed)
    })
    check('no worker idles while a task waits', () => {
      for (const w of r.workers) expect(w.idleQueuedMs).toBeLessThan(1_000)
    })
    check('churn', () => {
      expect(r.churn).toBe(0)
    })
    if (!c.measured) return
    check('utilization', () => {
      expect(r.utilization).toBeGreaterThanOrEqual(0.9)
    })
    check('makespan', () => {
      const best = bestMs(c.graph, small)
      expect(r.endMs).toBeLessThanOrEqual(Math.max(best * 1.05, best + 5_000))
    })
  })
}
