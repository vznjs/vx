// What a distributed run must look like, played by `sim.ts` on the plugin's
// own decide + dispatch over runs main really had. A scheduling change lands
// only when these hold. `it.failing` marks what does not hold yet (2026-10-23):
// it fails the suite once fixed, so the mark comes off with the fix.

import { describe, expect, it } from 'bun:test'
import type { Size } from '../src/planner.js'
import { DEFAULT_STRATEGY, STRATEGIES } from '../src/strategy.js'
import a09 from './fixtures/main-run-a09b987.json'
import f2163 from './fixtures/main-run-2026-10-23.json'
import q2f0 from './fixtures/pr-run-2f0e2a4.json'
import { compare } from '../scripts/compare.js'
import { bestMs, simulate, type SimResult, type SimTask } from './sim.js'

const small: Size = { name: 'small', max: 12, cpu: 4, memory: 16e9 }
type Ran = { ms: number; cores: number; memory: number }

interface Fixture {
  readonly nodes: readonly { id: string; deps: string[]; exec: boolean; cache: boolean }[]
  readonly ran: Record<string, readonly number[]>
}

/** The fixture's graph; `known` is what history said before the run (default: how it ran). */
function load(f: Fixture, known?: (r: Ran) => NonNullable<SimTask['known']> | null): SimTask[] {
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
  /** Core's cache probe answered before the first plan (default true). */
  readonly probe?: boolean
  /** How long a hit takes to restore (default: it ends at once). */
  readonly restoreMs?: number
  /** A worker's start, from its ask to its join (default sim.ts's). */
  readonly warmUpMs?: number
}

/** Its true misses: a forecast that guessed right. */
const misses = (g: SimTask[]) =>
  new Set(g.filter((t) => t.ran !== undefined && t.cache).map((t) => t.id))

/** Two of a09b987's misses that the probe called hits. */
const LATE = [...misses(load(a09))].sort().slice(-2)

const cases: Case[] = [
  {
    name: 'main a09b987, its misses forecast',
    graph: load(a09),
    measured: true,
    likely: misses(load(a09)),
    failing: ['utilization'],
  },
  // The probe said a remote held these two; each GET then 404'd and core
  // ran them as misses (2026-10-23). They must join the queue and run
  // on a worker like any other.
  {
    name: 'main a09b987, two probed hits gone by their GET',
    graph: load(a09),
    measured: true,
    likely: new Set([...misses(load(a09))].filter((id) => !LATE.includes(id))),
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
  // Each unmeasured task on a free core, the run sized as if each held 2
  // (2026-10-23): it ends at 174 s where a whole worker each took 350 s.
  // An asked worker the plan gives a task stays, though tasks pack onto
  // one core each.
  {
    name: 'main a09b987, no history',
    graph: load(a09, () => null),
    measured: false,
  },
  { name: 'main 2163fff, no history', graph: load(f2163, () => null), measured: false },
  // A third of the tasks new, the rest measured: the common run.
  {
    name: 'main a09b987, a third of its tasks unmeasured',
    graph: aThirdUnmeasured(),
    measured: false,
    likely: misses(load(a09)),
  },
  // main f71b377: the last commit's changes forecast nearly every task a
  // miss, a remote held most, and its batch probe gave no answer: demand
  // counted every forecast task, 15 workers were asked for 116 tasks, 11
  // cancelled, and one joined to an empty queue. Core now asks each key
  // when the batch has no answer (`remoteHasEach`), so the probe answers.
  {
    name: 'main a09b987, all forecast, its hits measured',
    graph: hitsMeasured(),
    measured: true,
    likely: forecastAll(),
    restoreMs: 1_000,
    failing: ['utilization'],
  },
  {
    name: 'main a09b987, all forecast, no probe answer',
    graph: hitsMeasured(),
    measured: true,
    likely: forecastAll(),
    probe: false,
    restoreMs: 1_000,
    failing: ['utilization'],
  },
  // The forecast knows some keys: half its misses.
  {
    name: 'main a09b987, half its misses forecast',
    graph: load(a09),
    measured: true,
    likely: new Set([...misses(load(a09))].filter((_, i) => i % 2 === 0)),
    failing: ['utilization'],
  },
  // Short tasks: the work is gone before a worker started for it joins.
  { name: 'forty short tasks', graph: short(40, 400), measured: false },
  {
    name: 'forty short tasks, a slow start',
    graph: short(40, 400),
    measured: false,
    warmUpMs: 40_000,
  },
  {
    name: 'forty short tasks, no probe answer',
    graph: short(40, 400),
    measured: false,
    probe: false,
    restoreMs: 1_000,
  },
]

/** a09b987, each hit measured as a 10 s task on one core: it ran on an earlier run. */
function hitsMeasured(): SimTask[] {
  return load(a09).map((t) =>
    t.ran === undefined && t.exec && t.cache
      ? { ...t, known: { ms: 10_000, cores: 1, memory: 5e8 } }
      : t,
  )
}

/** Every cached task that runs a command: a forecast of a change under all of them. */
function forecastAll(): Set<string> {
  return new Set(
    load(a09)
      .filter((t) => t.exec && t.cache)
      .map((t) => t.id),
  )
}

/** `n` misses of `ms` each on one core, beside as many hits, none depending on another. */
function short(n: number, ms: number): SimTask[] {
  return Array.from({ length: n * 2 }, (_, i) => ({
    id: `t${i}`,
    deps: [],
    exec: true,
    cache: true,
    ...(i % 2 === 0 ? { ran: { ms, cores: 1, memory: 2e8 } } : {}),
  }))
}

/** a09b987 with every third task that ran never measured. */
function aThirdUnmeasured(): SimTask[] {
  let i = 0
  return load(a09).map((t) => (t.ran !== undefined && i++ % 3 === 0 ? { ...t, known: null } : t))
}

// 2026-10-23: "we can't waste whole worker for one task", "pack them
// where we have free capability". Booking each unmeasured task a whole
// worker ended this run at 195 s, its workers 37% busy.
it('a run a third unmeasured ends within 165 s, its workers 70% busy', () => {
  const r = simulate(aThirdUnmeasured(), { sizes: [small], likely: misses(load(a09)) })
  expect(r.endMs).toBeLessThanOrEqual(165_000)
  expect(r.utilization).toBeGreaterThanOrEqual(0.7)
})

for (const c of cases) {
  describe(c.name, () => {
    const r = simulate(c.graph, {
      sizes: [small],
      ...(c.likely ? { likely: c.likely } : {}),
      ...(c.probe === undefined ? {} : { probe: c.probe }),
      ...(c.restoreMs === undefined ? {} : { restoreMs: c.restoreMs }),
      ...(c.warmUpMs === undefined ? {} : { warmUpMs: () => c.warmUpMs! }),
    })
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

// 2026-10-23: "the Mac would be only for Mac tasks". With a size of
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

// `backlog` counted every core alike: Linux workers with cores to spare
// started no Mac worker, and the Mac task waited for one forever.
it('backlog starts a worker of the platform a ready task needs, though others are spare', () => {
  const linux: Size = { ...small, platform: 'linux-x64' }
  const mac: Size = { name: 'mac', max: 2, cpu: 4, memory: 16e9, platform: 'darwin-arm64' }
  const t = (id: string, deps: string[], platform?: string): SimTask => ({
    id,
    deps,
    exec: true,
    cache: true,
    ran: { ms: 10_000, cores: 1, memory: 5e8 },
    ...(platform === undefined ? {} : { platform }),
  })
  const graph = [t('build', []), t('lint', []), t('mac', ['lint'], 'darwin-arm64')]
  const r = simulate(graph, {
    sizes: [linux, mac],
    home: 'linux-x64',
    how: { ...DEFAULT_STRATEGY, scale: 'backlog' },
  })
  expect(r.workers.find((w) => w.platform === 'darwin-arm64')?.ran).toEqual(['mac'])
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

// 2026-10-23: history is an estimate; a suite given more workers (a
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

describe('the blog post: other ways to split a run', () => {
  // one-run-on-your-own-runners: vx DTE ends no later than one machine, a
  // static matrix, a build stage or naive DTE, on each of its four runs.
  for (const c of compare())
    it(c.name, () => {
      const dte = c.ways.at(-1)!
      for (const o of c.ways.slice(0, -1)) expect(dte.endMs).toBeLessThanOrEqual(o.endMs + 1e-6)
    })
})

/** A graph of 20-120 tasks whose history was 1.5-3x too short, from a seed. */
function slowerThanHistory(seed: number): SimTask[] {
  let s = seed
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647
  const n = 20 + Math.floor(rnd() * 100)
  const k = 1.5 + rnd() * 1.5
  return Array.from({ length: n }, (_, i) => {
    const deps = i > 0 && rnd() < 0.5 ? [`t${Math.floor(rnd() * i)}`] : []
    const ms = 3_000 + rnd() * 40_000
    const cores = rnd() < 0.2 ? 3 : 1
    return {
      id: `t${i}`,
      deps,
      exec: true,
      cache: true,
      known: { ms, cores, memory: 2e8 },
      ran: { ms: ms * k, cores, memory: 2e8 },
    }
  })
}

// PR #4192's run: its tasks took twice their history, a running task past
// its forecast was planned to end now, and the plan asked a worker every
// 10 s and cancelled each as not needed. What is left takes as much longer
// as what ended did. Seeds that cancelled (195 also asked one again), and
// two whose plan spun on a sub-millisecond `againInMs` (74, 283).
it.each([14, 29, 74, 90, 151, 195, 283])(
  'a run slower than its history asks for more, not a worker it then cancels (seed %d)',
  (seed) => {
    const r = simulate(slowerThanHistory(seed), { sizes: [small] })
    expect(r.workers.filter((w) => w.cancelledAt !== undefined).map((w) => w.id)).toEqual([])
    expect(r.churn).toBe(0)
  },
)

// Cold main bcc84f1: no task had a measured need, so the plan counted each
// as `unmeasured` (2 cores) while it waited and as the one core it held
// once it ran. Each start freed a core the plan then found spare, and 11
// of the 25 workers it asked were cancelled as not needed.
it('a run of unmeasured needs keeps the workers it asks', () => {
  const graph = load(a09, (r) => ({ ms: r.ms, memory: r.memory }))
  const r = simulate(graph, { sizes: [small] })
  expect(r.workers.filter((w) => w.cancelledAt !== undefined).map((w) => w.id)).toEqual([])
})

// PR 2f0e2a4 (2026-10-24): GitHub queued 9 of the 11 workers asked at 1 s
// for 30-85 s. The run planned each to join at once and asked 4 more, then
// 3 to replace those its join limit gave up on; none of the 7 got a
// runner before it was cancelled. A worker asked behind a queued one joins
// after it: none is asked while one of its size is late.
it('asks no worker while the CI queues one of its size', () => {
  const unmeasured = new Set([
    '@vzn/vx#check.bun',
    '@vzn/vx-docs#build',
    '@vzn/vx-docs#import',
    '@vzn/vx-docs#test',
    '@vzn/vx-dte#lint.oxlint',
    '@vzn/vx-dte#lint.oxfmt',
    '@vzn/vx-dte#test.wire',
    '@vzn/vx-dte#test.local-e2e',
    '@vzn/vx-dte#test.units',
    '@vzn/vx-dte#test.gitlab',
    '@vzn/vx-dte#test.rest',
  ])
  const graph = load(q2f0).map((t) =>
    t.ran !== undefined && unmeasured.has(t.id) ? { ...t, known: null } : t,
  )
  // Each worker's join, in the order the run asked them; later ones queue behind.
  const joins = [16.5, 84.3, 78.5, 67.4, 44.9, 85.9, 80.0, 18.1, 78.3, 74.3, 13.9]
  const r = simulate(graph, {
    sizes: [
      { ...small, platform: 'linux-x64' },
      { name: 'arm', max: 1, cpu: 4, memory: 16e9, platform: 'linux-arm64' },
      { name: 'mac', max: 4, cpu: 3, memory: 7e9, platform: 'darwin-arm64' },
    ],
    home: 'linux-x64',
    warmUpMs: (n) => (joins[n - 1] ?? 90) * 1_000,
  })
  expect(r.workers.filter((w) => w.cancelledAt !== undefined).map((w) => w.id)).toEqual([])
  // The run's ideal: 121.6 s.
  expect(r.endMs).toBeLessThanOrEqual(125_000)
})
