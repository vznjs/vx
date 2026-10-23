// What a distributed run must look like, played by `sim.ts` on the plugin's
// own decide + dispatch over runs main really had. A scheduling change lands
// only when these hold. `it.failing` marks what does not hold yet (2026-10-23):
// it fails the suite once fixed, so the mark comes off with the fix.

import { describe, expect, it } from 'bun:test'
import type { Size } from '../src/planner.js'
import { DEFAULT_STRATEGY, STRATEGIES } from '../src/strategy.js'
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
  /** What the forecast says misses before any does (`likelyMisses`). */
  readonly likely?: ReadonlySet<string>
}

/** Its true misses: a forecast that guessed right. */
const misses = (g: SimTask[]) =>
  new Set(g.filter((t) => t.ran !== undefined && t.cache).map((t) => t.id))

const cases: Case[] = [
  {
    name: 'main a09b987, its misses forecast',
    graph: load(a09),
    measured: true,
    likely: misses(load(a09)),
    failing: ['utilization'],
  },
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
    failing: ['utilization'],
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
    const r = simulate(c.graph, { sizes: [small], ...(c.likely ? { likely: c.likely } : {}) })
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

// Tasks core placed on a platform (`exec.platforms`) go only to workers of
// it, and the run starts a worker of each platform its work needs, though
// that size is declared after another the work fills.
describe('a graph over two platforms', () => {
  const linux: Size = { ...small, platform: 'linux-x64' }
  const mac: Size = { name: 'mac', max: 4, cpu: 4, memory: 16e9, platform: 'darwin-arm64' }
  const graph = growing().map((t, i) => (i % 3 === 0 ? { ...t, platform: 'darwin-arm64' } : t))
  const byId = new Map(graph.map((t) => [t.id, t]))
  const r = simulate(graph, { sizes: [linux, mac] })
  it('no task runs on a worker outside its platform', () => {
    const off = r.workers.flatMap((w) =>
      w.ran.filter((id) => {
        const p = byId.get(id)!.platform
        return p !== undefined && p !== w.platform
      }),
    )
    expect(off).toEqual([])
    expect(r.workers.some((w) => w.platform === 'darwin-arm64' && w.tasks > 0)).toBe(true)
  })
  it('every miss runs on a worker, once', () => {
    expect(r.workers.reduce((n, w) => n + w.tasks, 0)).toBe(r.executed)
  })
})

// M, 2026-10-23: "the Mac would be only for Mac tasks". With a size of
// this machine's platform, a task naming none runs on it only: a Mac worker
// is never filled with the rest while its own tasks wait, and leaves once
// they are done.
describe('a Mac worker beside Linux ones', () => {
  const linux: Size = { ...small, platform: 'linux-x64' }
  const mac: Size = { name: 'mac', max: 1, cpu: 4, memory: 16e9, platform: 'darwin-arm64' }
  const graph = growing().map((t, i) =>
    i >= 1 && i <= 4 ? { ...t, platform: 'darwin-arm64', ran: { ...t.ran!, ms: 60_000 } } : t,
  )
  const pinned = graph.filter((t) => t.platform !== undefined).map((t) => t.id)
  const r = simulate(graph, { sizes: [linux, mac], home: 'linux-x64' })
  const macs = r.workers.filter((w) => w.platform === 'darwin-arm64' && w.joinedAt !== undefined)
  it('runs only the Mac tasks on it, none of them waiting past its warm-up', () => {
    expect(macs.flatMap((w) => w.ran).sort()).toEqual([...pinned].sort())
    for (const id of pinned) expect(r.waitedMs.get(id)!).toBeLessThanOrEqual(20_000)
  })
  it('lets it go once they are done, before the run ends', () => {
    const last = Math.max(...pinned.map((id) => r.endedAt.get(id)!))
    for (const w of macs) expect(w.leftAt!).toBeLessThan(r.endMs)
    for (const w of macs) expect(w.leftAt! - last).toBeLessThan(1_000)
  })
})

// Each choice of each layer (`dte({ scheduler })`), the rest the default's:
// whatever a workspace picks, no worker is booked past its cores and every
// miss runs once.
describe('each scheduler choice, on main a09b987', () => {
  const graph = load(a09)
  for (const [layer, choices] of Object.entries(STRATEGIES))
    for (const choice of choices)
      it(`${layer}: ${choice}`, () => {
        const how = { ...DEFAULT_STRATEGY, [layer]: choice }
        const r = simulate(graph, { sizes: [small], how, likely: misses(graph) })
        for (const w of r.workers) expect(w.peakBooked).toBeLessThanOrEqual(w.cores + 1e-9)
        expect(r.workers.reduce((n, w) => n + w.tasks, 0)).toBe(r.executed)
      })
})

// M, 2026-10-23: history is an estimate; a suite given more workers (a
// Playwright config from 3 to 10) uses far more than it says. Four shards
// that used 0.75 cores now fill a worker: none is sent work while its
// tasks use all its cores.
it('sends no task to a worker its tasks use whole, whatever history said', () => {
  const heavy = new Set([
    '@vzn/vx#test.bun.shard-1',
    '@vzn/vx#test.bun.shard-2',
    '@vzn/vx#test.bun.shard-3',
    '@vzn/vx#test.bun.shard-4',
  ])
  const graph = load(a09).map((t) =>
    heavy.has(t.id) && t.ran !== undefined
      ? { ...t, known: t.ran, ran: { ...t.ran, cores: 4 } }
      : t,
  )
  const r = simulate(graph, { sizes: [small], likely: misses(graph) })
  expect(r.overSent).toBe(0)
  expect(r.workers.reduce((n, w) => n + w.tasks, 0)).toBe(r.executed)
})
