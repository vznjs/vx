import { expect, it } from 'bun:test'
import type { TaskNode } from '@vzn/vx'
import {
  advise,
  candidates,
  decide,
  type Forecast,
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

it('plays two warm-ups and the longest task ahead, and plans again as that window moves', () => {
  // A 200 s chain, then 16 wide: the wide part is past the window.
  const tasks = [
    task('a', 100_000),
    task('b', 100_000, ['a']),
    ...Array.from({ length: 16 }, (_, i) => task(`w${i}`, 30_000, ['b'])),
  ]
  const online = [worker('one', { idle: false, running: [] })]
  const p = plan(tasks, online, candidates([small], new Map(), [], tasks.length), WARM)
  expect(p.start).toEqual([])
  // Not asked for the wide part yet: planned again half its window on.
  expect(p.againInMs).toBe((2 * WARM + 100_000) / 2)
  // The rest ends no sooner than its chain.
  expect(p.endsInMs).toBeGreaterThanOrEqual(230_000)
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
  const lull = [worker('busy', { idle: false }), worker('idle', { size: 'small' })]
  expect(plan(late, lull, [small], WARM).release).toEqual(['idle'])
  // With its size's starts spent, none could: it stays (fuzz, 2026-10-25).
  const kept = plan(late, lull, [], WARM)
  expect(kept.release).toEqual([])
  expect(kept.endsInMs).toBe(330_000)
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

// 2026-10-23: five workers joined to nothing queued and were let go at once.
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

// Main 005e8f2: asked at 2.1 s, mac#2 was cancelled 0.2 s later as adding
// nothing to the run's end, and a mac asked again at 19.9 s joined 20 s late.
it('keeps a starting worker the plan gives a task, though the run ends no sooner', () => {
  const one = worker('one', { idle: false })
  const three = worker('three', { idle: false })
  const two = worker('two', { at: 1_000, idle: false, starting: true })
  const tasks = [task('a', 40_000, [], 4), task('b', 3_000, [], 4), task('c', 3_000, [], 4)]
  expect(simulate(tasks, [one, three])).toBe(simulate(tasks, [one, three, two]))
  expect(plan(tasks, [one, three, two], [], WARM).release).toEqual([])
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
  // Two workers end it in 40 s: the run may end 5 s past that.
  const work = [task('a', 40_000, [], 4), task('b', 4_000, [], 4)]
  const two = [worker('x'), worker('y')]
  expect(plan(work, two, [], WARM).boundMs).toBe(45_000)
  // A deadline 2 s past the best is kept.
  expect(plan(work, two, [], WARM, true, 42_000).boundMs).toBe(42_000)
})

// Main e05bd71: mac#2 joined at 18.4 s and was let go, the run ending
// within its margin without it; a mac asked 4 s later joined at 44 s.
it('keeps an idle worker the plan gives a task, though the run ends within its margin without it', () => {
  const work = [task('a', 40_000, [], 4), task('b', 4_000, [], 4)]
  const two = [worker('x'), worker('y')]
  expect(simulate(work, [two[0]!])).toBeLessThanOrEqual(simulate(work, two) + 5_000)
  expect(plan(work, two, [], WARM).release).toEqual([])
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

// A Mac task that filled its Mac: a bigger Linux worker cannot take it,
// so the plan neither waits for one nor starts one for it.
it('plays a task that filled its worker on no bigger one of another platform', () => {
  const mac = 'darwin-arm64'
  const heavy: PlanTask = {
    id: 'ios',
    cores: Infinity,
    memory: Infinity,
    above: { cores: 4, memory: 4e9 },
    ms: 10_000,
    deps: [],
    platform: mac,
  }
  const workers: PlanWorker[] = [
    worker('mac#1', { memory: 4e9, platform: mac }),
    worker('big#1', { cores: 8, at: WARM, idle: false, starting: true, platform: 'linux-x64' }),
  ]
  expect(simulate([heavy], workers)).toBe(10_000)
  const big: Size = { name: 'big', max: 2, cpu: 8, memory: 32e9, platform: 'linux-x64' }
  const macBig: Size = { name: 'mac-big', max: 2, cpu: 8, memory: 32e9, platform: mac }
  const sizes = candidates([big, macBig], new Map(), [{ ...heavy.above!, platform: mac }], 0)
  expect(sizes.map((s) => s.name)).toEqual(['mac-big'])
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

// Main e38d1d2: check.build-cold, uncached, waited on install; counted
// only once handed over, the first plan asked one Mac for a 37 s lane.
it('counts an uncached task as work before it is handed over', () => {
  const nodes = new Map(
    [
      ['install', [], true],
      ['cold', ['install'], false],
      ['after', ['cold'], true],
    ].map(([id, deps, cached]) => [
      id as string,
      {
        id,
        deps,
        config: { exec: { command: 'x' }, ...(cached ? { cache: {} } : {}) },
      } as unknown as TaskNode,
    ]),
  )
  const one = () => ({ cores: 1, memory: 1e9 })
  const remaining = new Set(['install', 'cold', 'after'])
  // Nothing missed: the uncached task still runs, and its dependant's key holds.
  expect(missedWork(remaining, nodes, new Set(), one, () => 1000).map((t) => t.id)).toEqual([
    'cold',
  ])
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

// Main e118ccf (2026-10-24): five Linux tasks fit one small, the two Mac
// ones needed two Macs. Sizes come in turns (small mac small mac), and
// the shortest prefix with the second Mac took a second small too: it was
// asked, given nothing, and cancelled unjoined.
it('asks the fewest of each size, not the shortest prefix of the turns', () => {
  const linux = { ...small, platform: 'linux-x64' }
  const mac: Size = { name: 'mac', max: 4, cpu: 3, memory: 7e9, platform: 'darwin-arm64' }
  const on = (t: PlanTask, platform: string): PlanTask => ({ ...t, platform })
  const tasks = [
    on(task('check.bun', 300, [], 2), 'linux-x64'),
    on(task('migrate.live', 25_800, [], 1.31), 'linux-x64'),
    on(task('reapi.live', 11_300, [], 0.52), 'linux-x64'),
    on(task('release.sync', 1_400, [], 0.25), 'linux-x64'),
    on(task('deploy.pages', 26_900, [], 0.25), 'linux-x64'),
    on(task('check.sandbox-canary', 5_200, [], 1.31), 'darwin-arm64'),
    on(task('check.build-cold', 32_800, [], 2.11), 'darwin-arm64'),
  ]
  const sizes = candidates(
    [linux, mac],
    new Map(),
    [],
    tasks.length,
    new Map([
      ['linux-x64', 5],
      ['darwin-arm64', 2],
    ]),
  )
  expect(sizes.slice(0, 4).map((s) => s.name)).toEqual(['small', 'mac', 'small', 'mac'])
  const p = plan(tasks, [], sizes, WARM)
  expect(p.start.map((s) => s.name).sort()).toEqual(['mac', 'mac', 'small'])
})

// 2026-10-25: a run of 9000 tasks failed every one: each plan read every
// ready task at each step of its play-out, and the orchestrator, planning,
// stopped answering its workers. A complexity guard: timed in CPU, not wall.
it('plans 9000 ready tasks of mixed needs in seconds of CPU, not minutes', () => {
  const tasks: PlanTask[] = Array.from({ length: 9000 }, (_, i) => ({
    id: `t${i}`,
    cores: [0.25, 0.7, 1, 1.5][i % 4]!,
    memory: 0,
    ms: 100 + (i % 7) * 30,
    deps: [],
  }))
  tasks.push({ id: 'final', cores: 1, memory: 0, ms: 100, deps: tasks.map((t) => t.id) })
  const sizes = Array.from({ length: 3 }, () => ({ name: 'small', cpu: 2, memory: 8e9, max: 3 }))
  const start = process.cpuUsage()
  plan(tasks, [], sizes, 3000)
  const { user, system } = process.cpuUsage(start)
  expect((user + system) / 1000).toBeLessThan(5000)
}, 60_000)

// 2026-10-25: measured needs are unrounded, so every task can be its own
// kind; read kind by kind, a plan of 1000 took 37 s. Read task by task,
// each pass asked every ready one that fit nowhere: 9000 took 15 s.
it('plans 9000 ready tasks each of its own need in seconds of CPU', () => {
  const tasks: PlanTask[] = Array.from({ length: 9000 }, (_, i) => ({
    id: `t${i}`,
    cores: 0.25 + ((i * 7919) % 1000) / 700,
    memory: (i * 104729) % 3e8,
    ms: 100 + (i % 7) * 30,
    deps: [],
  }))
  const sizes = Array.from({ length: 3 }, () => ({ name: 'small', cpu: 2, memory: 8e9, max: 3 }))
  const start = process.cpuUsage()
  plan(tasks, [], sizes, 3000)
  const { user, system } = process.cpuUsage(start)
  expect((user + system) / 1000).toBeLessThan(8000)
  // CPU is the guard; the wall clock of a loaded runner is not (2.2 s here, over 5 s on CI).
}, 60_000)

// 2026-10-25: each play-out copied a task's dependant list to add one,
// so one install under 9000 tasks was 40 million copies a play, and a
// plan 9.5 s of CPU. A complexity guard: timed in CPU, not wall.
it('plans 9000 tasks behind one install in seconds of CPU', () => {
  const tasks: PlanTask[] = [{ id: 'install', cores: 1, memory: 0, ms: 30_000, deps: [] }]
  for (let i = 0; i < 9000; i++)
    tasks.push({ id: `t${i}`, cores: 1, memory: 0, ms: 500, deps: ['install'] })
  const sizes = candidates([{ ...small, max: 20 }], new Map(), [], tasks.length)
  const start = process.cpuUsage()
  plan(tasks, [], sizes, WARM)
  const { user, system } = process.cpuUsage(start)
  expect((user + system) / 1000).toBeLessThan(5000)
}, 60_000)

it('plans a 6000-task tree in seconds of CPU', () => {
  let seed = 1
  const random = (): number => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32
  const tasks: PlanTask[] = []
  for (let i = 0; i < 6000; i++)
    tasks.push({
      id: `t${i}`,
      cores: 1,
      memory: 0,
      ms: 500 + (i % 4) * 250,
      deps: i === 0 ? [] : [`t${Math.floor(random() * i)}`],
    })
  const sizes = candidates([{ ...small, max: 20 }], new Map(), [], tasks.length)
  const start = process.cpuUsage()
  plan(tasks, [], sizes, WARM)
  const { user, system } = process.cpuUsage(start)
  expect((user + system) / 1000).toBeLessThan(10_000)
}, 120_000)

// 2026-11-05: "what would be the optimal number and spec of workers for
// the simulated run, and what would be optimal numbers based on provided
// specification. So I can add more or change their specs".
it('advises the workers that would have run it best: of the declared sizes, past their max, and of any cores', () => {
  const tasks = Array.from({ length: 16 }, (_, i) => task(`t${i}`, 10_000))
  const two: Size = { ...small, max: 2 }
  const advice = advise(tasks, [two], () => 0)
  // Two of four cores: 16 one-core tasks of 10 s, in two waves.
  expect(advice.declared).toEqual({
    fleet: [{ count: 2, cores: 4, memory: 16e9, platform: undefined, size: 'small' }],
    endMs: 20_000,
  })
  // Four end it in one wave, past the margin sooner.
  expect(advice.more).toEqual({
    fleet: [{ count: 4, cores: 4, memory: 16e9, platform: undefined, size: 'small' }],
    endMs: 10_000,
  })
  // Of any cores, as cheap in core time from 2 to 16: the fewest machines.
  expect(advice.any).toEqual({
    fleet: [{ count: 1, cores: 16, memory: 64e9, platform: undefined }],
    endMs: 10_000,
  })
  // As many as it needs already: nothing more to say.
  expect(advise(tasks, [{ ...small, max: 4 }], () => 0).more).toBeUndefined()
})

it('advises each platform its own workers, joined after its warm-up', () => {
  const tasks = [
    ...Array.from({ length: 4 }, (_, i) => ({ ...task(`l${i}`, 10_000), platform: 'linux' })),
    { ...task('m', 10_000), platform: 'mac' },
  ]
  const sizes: Size[] = [
    { name: 'linux', max: 4, cpu: 2, memory: 8e9, platform: 'linux' },
    { name: 'mac', max: 1, cpu: 3, memory: 7e9, platform: 'mac' },
  ]
  const advice = advise(tasks, sizes, (p) => (p === 'mac' ? 30_000 : 5_000))
  // The Mac's task ends at 40 s: one Linux worker's two waves end at 25 s.
  expect(advice.declared).toEqual({
    fleet: [
      { count: 1, cores: 2, memory: 8e9, platform: 'linux', size: 'linux' },
      { count: 1, cores: 3, memory: 7e9, platform: 'mac', size: 'mac' },
    ],
    endMs: 40_000,
  })
  expect(advice.more).toBeUndefined()
})

// 2026-11-05: "Simulations should be turbo fast". A plan tried every
// candidate while its end lay past their warm-up: 60 plays of 40 tasks
// though the tenth new worker already sat idle. Its twins after it get
// nothing either, so the plan stops there, and plans the same.
it('stops trying workers once one like the rest sits idle in its play', () => {
  let plays = 0
  const counted: PlanWorker = {
    ...worker('w', { idle: false }),
    get running() {
      plays++
      return []
    },
  }
  const tasks = Array.from({ length: 40 }, (_, i) => task(`t${i}`, 60_000))
  const sixty = Array.from({ length: 60 }, () => ({ ...small, max: 60 }))
  const p = plan(tasks, [counted], sixty, WARM)
  expect([p.start.length, p.endsInMs]).toEqual([9, 80_000])
  // Two reads a play; every candidate tried read 144.
  expect(plays).toBeLessThan(60)
})

// 2026-11-05: "It's just about filling boxes to full"; "Reality changes
// by leave some margin. 5% or sth"; "And resource usage". Planned at
// each task's end, a 1000-task run replayed itself ten thousand times.
// While what the plan saw holds within 5%, the next is that plan again.
it('follows the plan, played again only when an event moves past 5%', () => {
  const ids = Array.from({ length: 6 }, (_, i) => `t${i}`)
  const nodes = new Map(
    ids.map((id) => [
      id,
      { id, deps: [], config: { exec: { command: 'x' }, cache: {} } } as unknown as TaskNode,
    ]),
  )
  let plays = 0
  // A play reads each worker's cores; telling whether the plan holds does not.
  const counted = (running: PlanWorker['running'], idle = false): PlanWorker => ({
    ...worker('w', { idle, running }),
    get cores() {
      plays++
      return 4
    },
  })
  const last: { forecast?: Forecast } = {}
  const at = (
    now: number,
    o: {
      ms?: number
      cores?: number
      memory?: number
      runCores?: number
      endsIn?: number
      idle?: boolean
    } = {},
  ) => {
    const before = plays
    const p = decide({
      remaining: ids,
      nodes,
      executed: new Set(ids),
      need: () => ({ cores: o.cores ?? 1, memory: o.memory ?? 1e9 }),
      durationMs: () => o.ms ?? 10_000,
      workers: [
        counted(
          o.idle === true
            ? []
            : [{ id: 'r', cores: o.runCores ?? 1, memory: 1e9, endsIn: o.endsIn ?? 5_000 }],
          o.idle,
        ),
      ],
      running: new Set(),
      sizes: [small],
      started: new Map(),
      final: false,
      warmUpMs: WARM,
      replaceable: true,
      last,
      now,
    })
    return [plays > before, p.endsInMs, p.release] as const
  }
  const [first, ends] = at(0)
  expect(first).toBe(true)
  // A second on, all as planned: the same plan, a second shorter.
  expect(at(1_000)).toEqual([false, ends - 1_000, []])
  // A waiting task's estimate is not read again: what it runs shows it.
  expect(at(2_000, { ms: 12_000, cores: 1.2, memory: 2e9 })[0]).toBe(false)
  // A running task's cores within 5%: as planned; past it, played again.
  expect(at(3_000, { runCores: 1.04 })[0]).toBe(false)
  expect(at(4_000, { runCores: 1.2 })[0]).toBe(true)
  // Past its time by 5% of the run's plays again; a moment late does not.
  expect(at(5_000, { runCores: 1.2, endsIn: -100 })[0]).toBe(false)
  expect(at(6_000, { runCores: 1.2, endsIn: -20_000 })[0]).toBe(true)
  expect(at(7_000, { runCores: 1.2, endsIn: -20_000 })[0]).toBe(false)
  // Ended, idle between the tasks the plan gives it: as planned.
  expect(at(8_000, { idle: true })[0]).toBe(false)
  // Idle with its planned work done, it goes as the plan foresaw: not played again.
  const [played, , release] = at(10_000_000, { idle: true })
  expect([played, release]).toEqual([false, ['w']])
})

it('starts a worker the plan foresaw without reading the work, and none past its size', () => {
  // One task, then 16 long and wide: workers for those start later.
  const ids = ['a', ...Array.from({ length: 16 }, (_, i) => `w${i}`)]
  const nodes = new Map(
    ids.map((id) => [
      id,
      {
        id,
        deps: id === 'a' ? [] : ['a'],
        config: { exec: { command: 'x' }, cache: {} },
      } as unknown as TaskNode,
    ]),
  )
  let reads = 0
  const remaining = {
    *[Symbol.iterator]() {
      reads++
      yield* ids
    },
  }
  const at = (now: number, started: number, last: { forecast?: Forecast }) =>
    decide({
      remaining,
      nodes,
      executed: new Set(ids),
      need: () => ({ cores: 1, memory: 1e9 }),
      durationMs: (id) => (id === 'a' ? 60_000 : 100_000),
      workers: [
        worker('one', {
          idle: false,
          running: [{ id: 'a', cores: 1, memory: 1e9, endsIn: 60_000 - now }],
        }),
      ],
      running: new Set(['a']),
      sizes: [small],
      started: new Map([['small', started]]),
      final: false,
      warmUpMs: WARM,
      replaceable: true,
      last,
      now,
    })
  const last: { forecast?: Forecast } = {}
  const first = at(0, 0, last)
  expect(first.start).toEqual([])
  const due = first.againInMs!
  reads = 0
  const now = at(due, 0, last)
  expect(now.start.length).toBeGreaterThan(0)
  // Each start read every task: a run of 10 000 read them at each one.
  expect(reads).toBe(0)
  // Its size's max spent since: played again, and none started past it.
  const spent: { forecast?: Forecast } = {}
  at(0, 0, spent)
  expect(at(due, small.max, spent).start).toEqual([])
})
