import { expect, it } from 'bun:test'
import type { TaskNode } from '@vzn/vx'
import {
  candidates,
  knownMisses,
  missedWork,
  plan,
  simulate,
  type PlanTask,
  type PlanWorker,
  type Size,
} from '../src/planner.js'
import replay from './fixtures/main-run-2026-10-23.json'

const small: Size = { name: 'small', max: 12, cpu: 4, memory: 16e9 }
const WARM = 20_000

const worker = (id: string, over: Partial<PlanWorker> = {}): PlanWorker => ({
  id,
  cores: 4,
  memory: 16e9,
  at: 0,
  running: [],
  idle: true,
  ...over,
})
const task = (id: string, ms: number, deps: string[] = [], cores = 1): PlanTask => ({
  id,
  cores,
  memory: 1e8,
  ms,
  deps,
})

// Main 2163fff asked 6 workers at 0.6 s for 109 tasks; 85 hit and 2 did
// the work at 46% (2026-10-23). Booked in full beside others, it takes three.
it('plans main’s run on three workers: only its misses are work, never a group or a hit', () => {
  const nodes = new Map(
    replay.nodes.map((n) => [
      n.id,
      {
        id: n.id,
        deps: n.deps,
        config: {
          ...(n.exec ? { exec: { command: 'x' } } : {}),
          ...(n.cache ? { cache: {} } : {}),
        },
      } as unknown as TaskNode,
    ]),
  )
  const ran = replay.ran as unknown as Record<string, [number, number, number]>
  const work = missedWork(
    nodes.keys(),
    nodes,
    new Set(Object.keys(ran)),
    (id) => ({ cores: ran[id]![1], memory: ran[id]![2] * 1e6 }),
    (id) => ran[id]?.[0],
  )
  expect(work.map((t) => t.id).sort()).toEqual(Object.keys(ran).sort())
  const p = plan(work, [], candidates([small], new Map(), [], work.length), WARM)
  expect(p.start).toEqual([small, small, small])
  expect(p.release).toEqual([])
  // How busy it keeps them is tests/sim.test.ts's to judge.
  // The longest chain, vx-docs's import, build and test, after the warm-up.
  expect(p.endsInMs).toBeLessThan(WARM + 75_000)
})

it('starts a worker the plan needs later only when its warm-up nears', () => {
  // One long task, then 16 wide: a worker for the wide part is used 60 s in.
  const tasks = [
    task('a', 60_000),
    ...Array.from({ length: 16 }, (_, i) => task(`w${i}`, 30_000, ['a'])),
  ]
  const online = [worker('one', { idle: false, running: [] })]
  const p = plan(tasks, online, candidates([small], new Map(), [], tasks.length), WARM)
  expect(p.start).toEqual([])
  expect(p.againInMs).toBe(60_000 - WARM - 5_000)
  // 35 s on, `a` near its end: the plan starts them now.
  const later = plan(
    tasks.slice(1),
    [worker('one', { idle: false, running: [{ cores: 1, memory: 1e8, endsIn: 25_000 }] })],
    candidates([small], new Map(), [], tasks.length),
    WARM,
  )
  expect(later.start.length).toBeGreaterThan(0)
  expect(later.againInMs).toBeUndefined()
})

it('changes nothing on the same signal again', () => {
  const tasks = Array.from({ length: 12 }, (_, i) => task(`t${i}`, 40_000))
  const first = plan(tasks, [], candidates([small], new Map(), [], tasks.length), WARM)
  expect(first.start.length).toBeGreaterThan(0)
  // Those it started, starting.
  const starting = first.start.map((s, i) =>
    worker(`${s.name}#${i + 1}`, { at: WARM, idle: false }),
  )
  const started = new Map([['small', first.start.length]])
  const again = plan(tasks, starting, candidates([small], started, [], tasks.length), WARM)
  expect([again.start, again.release]).toEqual([[], []])
})

it('lets an idle worker go only when one started in its place would be in time', () => {
  const soon = [
    task('a', 3_000),
    ...Array.from({ length: 8 }, (_, i) => task(`w${i}`, 30_000, ['a'])),
  ]
  const two = [
    worker('busy', { idle: false, running: [{ cores: 1, memory: 1e8, endsIn: 3_000 }] }),
    worker('idle'),
  ]
  // Its work comes in 3 s: it stays.
  expect(
    plan(
      soon.slice(1).map((t) => ({ ...t, deps: [] })),
      two,
      [],
      WARM,
    ).release,
  ).toEqual([])
  // Its work comes in 5 minutes: it goes, and a worker starts nearer then.
  const late = [
    task('a', 300_000),
    ...Array.from({ length: 8 }, (_, i) => task(`w${i}`, 30_000, ['a'])),
  ]
  const p = plan(late, [worker('busy', { idle: false }), worker('idle')], [], WARM)
  expect(p.release).toEqual(['idle'])
  // With nothing left, every idle one goes.
  expect(plan([], two, [], WARM).release).toEqual(['idle'])
})

it('plays tasks out in their dependencies’ order, packed while a core is free', () => {
  // Two at once on one worker, the third after the first.
  const tasks = [task('a', 1_000, [], 2), task('b', 2_000, [], 2), task('c', 1_000, ['a'], 2)]
  expect(simulate(tasks, [worker('w')])).toBe(2_000)
  // No worker: never.
  expect(simulate(tasks, [])).toBe(Infinity)
  // One joining later begins then.
  expect(simulate([task('a', 1_000)], [worker('w', { at: 5_000 })])).toBe(6_000)
})

// M, 2026-10-23: five workers joined to nothing queued and were let go at once.
it('cancels a worker still starting that the plan ends as well without', () => {
  const tasks = [task('a', 30_000), task('b', 30_000)]
  const online = worker('one', { idle: false, running: [{ cores: 1, memory: 1e8, endsIn: 1_000 }] })
  const starting = worker('two', { at: WARM, idle: false, starting: true })
  // One online fits both: the one starting is not needed.
  expect(plan(tasks, [online, starting], [], WARM).release).toEqual(['two'])
  // Eight 30 s tasks on 4 cores: it is needed, and stays.
  const wide = Array.from({ length: 8 }, (_, i) => task(`w${i}`, 30_000))
  expect(plan(wide, [online, starting], [], WARM).release).toEqual([])
})

// PR #4214: each plan asked one worker for a run 5% over its best, and
// the next, a second later, found it ended within the margin without it:
// 7 asked and cancelled. Asked, a worker goes only when it adds nothing.
it('keeps a starting worker that ends the run sooner, though within the margin', () => {
  const online = worker('one', { idle: false, running: [{ cores: 4, memory: 1e8, endsIn: 1_000 }] })
  const starting = worker('two', { at: 1_000, idle: false, starting: true })
  const tasks = [task('a', 40_000, [], 4), task('b', 3_000, [], 4)]
  // Without it the run ends 3 s later, within 5 s of its best: it stays.
  expect(simulate(tasks, [online])).toBeLessThanOrEqual(simulate(tasks, [online, starting]) + 5_000)
  expect(simulate(tasks, [online])).toBeGreaterThan(simulate(tasks, [online, starting]))
  expect(plan(tasks, [online, starting], [], WARM).release).toEqual([])
})

it('waits a task on the running task it depends on', () => {
  const busy = worker('busy', {
    idle: false,
    running: [{ id: 'build', cores: 1, memory: 1e8, endsIn: 10_000 }],
  })
  // Taken as ready, a growing graph's checks asked a worker that joined to nothing.
  expect(simulate([task('check', 1_000, ['build'])], [busy])).toBe(11_000)
})

it('spends its margin once: a later plan of the same work keeps the first one’s deadline', () => {
  // Two workers end it in 40 s, one in 44: within 5 s, the first plan keeps one.
  const work = [task('a', 40_000, [], 4), task('b', 4_000, [], 4)]
  const two = [worker('x'), worker('y')]
  expect(plan(work, two, [], WARM).release).toEqual(['x'])
  // A deadline 2 s past the best keeps both.
  const p = plan(work, two, [], WARM, true, 42_000)
  expect(p.release).toEqual([])
  expect(p.boundMs).toBe(42_000)
})

it('starts a worker of each platform its work needs, though that size is declared last', () => {
  const linux: Size = { ...small, max: 8, platform: 'linux-x64' }
  const mac: Size = { name: 'mac', max: 2, cpu: 4, memory: 16e9, platform: 'darwin-arm64' }
  const sizes = candidates([linux, mac], new Map(), [], 3, new Map([['darwin-arm64', 1]]))
  expect(sizes.map((s) => s.name)).toContain('mac')
  const task: PlanTask = {
    id: 'ios',
    cores: 1,
    memory: 1e9,
    ms: 1_000,
    deps: [],
    platform: 'darwin-arm64',
  }
  const workers: PlanWorker[] = [
    { id: 'l', cores: 4, memory: 16e9, at: 0, running: [], idle: true, platform: 'linux-x64' },
  ]
  expect(simulate([task], workers)).toBe(Infinity)
  expect(plan([task], workers, sizes, WARM).start.map((s) => s.name)).toEqual(['mac'])
})

// Main c27c238 asked 13 workers at 2.4 s and cancelled 7 at 2.6 s: the
// Mac came after every Linux size, so reaching it took all twelve.
it("reaches each platform's first worker without taking another's all", () => {
  const linux: Size = { ...small, platform: 'linux-x64' }
  const mac: Size = { name: 'mac', max: 4, cpu: 3, memory: 7e9, platform: 'darwin-arm64' }
  const platforms = new Map([
    ['linux-x64', 70],
    ['darwin-arm64', 4],
  ])
  const sizes = candidates([linux, mac], new Map(), [], 74, platforms)
  expect(sizes.slice(0, 2).map((s) => s.name)).toEqual(['small', 'mac'])
  const work: PlanTask[] = [
    ...Array.from({ length: 8 }, (_, i) => ({ ...task(`l${i}`, 30_000), platform: 'linux-x64' })),
    { ...task('ios', 30_000), platform: 'darwin-arm64' },
  ]
  expect(plan(work, [], sizes, WARM).start.map((s) => s.name)).toEqual(['small', 'mac', 'small'])
})

// Main c27c238 at 19.2 s: four Linux workers 17 s into their warm-up were
// cancelled while seven new ones were asked, each a warm-up away.
it('keeps a worker still starting over a new one of its shape', () => {
  const linux: Size = { ...small, platform: 'linux-x64' }
  const mac: Size = { name: 'mac', max: 4, cpu: 3, memory: 7e9, platform: 'darwin-arm64' }
  const starting = ['small#2', 'small#3'].map((id) =>
    worker(id, { at: 0, idle: false, starting: true, platform: 'linux-x64' }),
  )
  const work: PlanTask[] = [
    ...Array.from({ length: 8 }, (_, i) => ({ ...task(`l${i}`, 30_000), platform: 'linux-x64' })),
    { ...task('ios', 30_000), platform: 'darwin-arm64' },
  ]
  const sizes = candidates(
    [linux, mac],
    new Map([['small', 2]]),
    [],
    work.length,
    new Map([
      ['linux-x64', 8],
      ['darwin-arm64', 1],
    ]),
  )
  const p = plan(work, starting, sizes, WARM, true, 100_000)
  expect(p.start.map((s) => s.name)).toEqual(['mac'])
  expect(p.release).toEqual([])
})

// Main e3c76a2: the commit's forecast kept a build the probe found held,
// and every test after it counted as work: 121 tasks asked for, 16 ran.
it('counts no work after a forecast miss the probe found held', () => {
  const nodes = new Map(
    [
      ['b', []],
      ['t', ['b']],
    ].map(([id, deps]) => [
      id as string,
      { id, deps, config: { exec: { command: 'x' }, cache: {} } } as unknown as TaskNode,
    ]),
  )
  const one = () => ({ cores: 1, memory: 1e9 })
  // `b` was held, so it left `remaining`; `t`'s key, unknown until `b` ends, was not asked.
  const remaining = new Set(['t'])
  const known = knownMisses(new Set(['b']), new Set(), new Set(), remaining)
  expect(missedWork(remaining, nodes, known, one, () => 1000)).toEqual([])
  // Still remaining, the forecast stands.
  const both = new Set(['b', 't'])
  const still = knownMisses(new Set(['b']), new Set(), new Set(), both)
  expect(missedWork(both, nodes, still, one, () => 1000).map((t) => t.id)).toEqual(['b', 't'])
})

// Main fd5c72e: small workers joined in 15 s and its Mac in 27 s, while
// every plan waited 20 s for each.
it("plans each size's own warm-up", () => {
  const linux: Size = { ...small, platform: 'linux-x64' }
  const mac: Size = { name: 'mac', max: 1, cpu: 3, memory: 7e9, platform: 'darwin-arm64' }
  const work: PlanTask[] = [
    { ...task('l', 75_000), platform: 'linux-x64' },
    { ...task('ios', 10_000), platform: 'darwin-arm64' },
  ]
  const ups = new Map([
    ['small', 15_000],
    ['mac', 27_000],
  ])
  const p = plan(work, [], [linux, mac], (size) => ups.get(size!)!)
  expect(p.start.map((s) => s.name)).toEqual(['small', 'mac'])
  expect(p.endsInMs).toBe(90_000)
  expect(plan(work, [], [linux, mac], WARM).endsInMs).toBe(95_000)
})
