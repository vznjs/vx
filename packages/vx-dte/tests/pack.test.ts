import { expect, it } from 'bun:test'
import { Placing } from '../src/dispatch.js'
import { pack } from '../src/pack.js'
import {
  candidates,
  plan,
  spreadMs,
  type PlanTask,
  type PlanWorker,
  type Size,
} from '../src/planner.js'

const task = (id: string, ms: number, deps: string[] = [], cores = 1): PlanTask => ({
  id,
  cores,
  memory: 1e8,
  ms,
  deps,
})
const worker = (id: string, over: Partial<PlanWorker> = {}): PlanWorker => ({
  id,
  cores: 4,
  memory: 16e9,
  at: 0,
  running: [],
  idle: true,
  ...over,
})
const size = (name: string, cpu: number, platform?: string): Size => ({
  name,
  max: 10,
  cpu,
  memory: 16e9,
  ...(platform === undefined ? {} : { platform }),
})
const WARM = 20_000

// A chain on one core, and fillers with slack beside it: the fillers wait
// for the chain's worker, not a worker each.
it('packs tasks with slack beside the chain, on no worker more', () => {
  const tasks = [
    task('a', 60_000),
    task('b', 60_000, ['a']),
    ...Array.from({ length: 6 }, (_, i) => task(`f${i}`, 30_000, [], 1)),
  ]
  const p = pack(tasks, [worker('one')], [size('w', 4)], () => WARM, 120_000)
  expect(p.starts).toEqual([])
  expect(p.end).toBeLessThanOrEqual(120_000)
  expect(p.held).toBe(4 * 120_000)
})

it('starts a worker only for a task none has room for by its latest start, to join as it is ready', () => {
  const tasks = [task('a', 50_000, [], 4), task('b', 40_000, ['a'], 4), task('c', 40_000, ['a'], 4)]
  const p = pack(tasks, [worker('one')], [size('w', 4), size('w', 4)], () => WARM, 90_000)
  expect(p.end).toBe(90_000)
  expect(p.starts.map((s) => s.at)).toEqual([50_000 - WARM])
  const [b, c] = [p.placed.get('b')!, p.placed.get('c')!]
  expect([b.at, c.at]).toEqual([50_000, 50_000])
  expect(new Set([b.worker, c.worker]).size).toBe(2)
})

it('gives a task only a worker of its platform with room for all of it, none draining', () => {
  const tasks = [task('mac', 10_000, [], 2), { ...task('arm', 10_000), platform: 'linux-arm64' }]
  const p = pack(
    tasks,
    [worker('small', { cores: 1 }), worker('drained', { drainIn: 0 })],
    [size('arm', 2, 'linux-arm64'), size('big', 2)],
    () => WARM,
    30_000,
  )
  expect(p.placed.get('mac')!.worker).not.toBe('small')
  expect(p.placed.get('mac')!.worker).not.toBe('drained')
  const arm = p.starts.find((s) => s.id === p.placed.get('arm')!.worker)
  expect(arm?.size.platform).toBe('linux-arm64')
})

// Over random graphs it never ends past its deadline, the longest chain
// after a warm-up, with as many new workers as it wants.
it('ends every random graph by its chain and a warm-up', () => {
  let s = 7
  const r = () => (s = (s * 48271) % 2147483647) / 2147483647
  for (let g = 0; g < 50; g++) {
    const n = 10 + Math.floor(r() * 60)
    const tasks = Array.from({ length: n }, (_, i) =>
      task(
        `t${i}`,
        1_000 + Math.floor(r() * 60_000),
        Array.from({ length: i }, (_, j) => `t${j}`).filter(() => r() < 0.05),
        1 + Math.floor(r() * r() * 4),
      ),
    )
    const tail = new Map<string, number>()
    for (let i = n - 1; i >= 0; i--) {
      const t = tasks[i]!
      let most = 0
      for (let j = i + 1; j < n; j++)
        if (tasks[j]!.deps.includes(t.id)) most = Math.max(most, tail.get(tasks[j]!.id)!)
      tail.set(t.id, t.ms! + most)
    }
    const deadline = WARM + Math.max(...tail.values())
    const p = pack(tasks, [], Array(n).fill(size('w', 4)), () => WARM, deadline)
    expect(p.end).toBeLessThanOrEqual(deadline)
    expect(p.placed.size).toBe(n)
  }
})

it('places a task on a running task’s worker only once that has room', () => {
  const busy = worker('one', {
    idle: false,
    running: [{ id: 'r', cores: 4, memory: 1e8, endsIn: 10_000 }],
  })
  const p = pack([task('a', 5_000, ['r'], 4)], [busy], [], () => WARM, 15_000)
  expect(p.placed.get('a')).toEqual({ worker: 'one', at: 10_000, ready: 10_000 })
})

it('follows a plan: each task to its worker once joined, not before its start', () => {
  const p = new Placing()
  p.set(
    {
      placed: new Map([
        ['a', 'one'],
        ['b', '\0new'],
        ['c', 'one'],
      ]),
      after: new Map([
        ['b', 5_000],
        ['c', 9_000],
      ]),
      asap: new Set(['c']),
      fresh: [{ id: '\0new', size: 'w' }],
      exact: true,
    },
    1_000,
  )
  // 'one' has not joined: 'a' goes to any.
  expect(p.gate('a', 1_000)).toEqual({})
  p.joined('one', 'one', 'w')
  expect(p.gate('a', 1_000)).toEqual({ only: 'one' })
  // Started as soon as ready: on its worker before its planned start.
  expect(p.gate('c', 1_000)).toEqual({ only: 'one' })
  // Its worker not joined: it waits for its start, then goes to any.
  expect(p.gate('b', 5_999)).toBe('wait')
  expect(p.next(1_000)).toBe(6_000)
  expect(p.gate('b', 6_000)).toEqual({})
  p.joined('w#2', 'w#2', 'w')
  expect(p.gate('b', 6_000)).toEqual({ only: 'w#2' })
  expect(p.next(6_000)).toBe(10_000)
})

it('reads how much later each next worker of a size joins, once two did', () => {
  expect(spreadMs([])).toBe(0)
  expect(spreadMs([57_500])).toBe(0)
  expect(spreadMs([57_500, 60_000, 65_000, 62_500])).toBe(2_500)
})

// Runners asked at once join one after another: each next new one is
// asked sooner by the spread, so it still joins as its task is ready.
it('asks each next worker of a size sooner by the join spread', () => {
  const tasks = [
    task('a', 30_000),
    ...Array.from({ length: 3 }, (_, i) => task(`b${i}`, 40_000, ['a'], 4)),
  ]
  const p = pack(
    tasks,
    [worker('one', { cores: 1 })],
    Array(3).fill(size('w', 4)),
    (_, nth) => WARM + nth * 2_500,
    70_000,
  )
  expect(p.end).toBe(70_000)
  expect(p.starts.map((s) => s.at).sort((x, y) => x - y)).toEqual([5_000, 7_500, 10_000])
})

// Main 440f9dc: lints at 3.5 cores, workers planned at 3.1 and one
// running at 3.2. Held to that one's 3.2, they fit it alone, queued 12
// deep there, and the packing ended at 113 s where the play ended at 65 s.
// Over every size, a task takes any worker whole.
it('spreads tasks over every size’s cores across workers, not onto the biggest one', () => {
  const lints = Array.from({ length: 6 }, (_, i) => task(`lint${i}`, 5_000, [], 3.5))
  const p = pack(
    lints,
    [worker('big', { cores: 3.2 }), worker('w2', { cores: 3.1 }), worker('w3', { cores: 2.9 })],
    [size('small', 3.1)],
    () => WARM,
    10_000,
  )
  expect(p.end).toBe(10_000)
  expect(new Set([...p.placed.values()].map((x) => x.worker))).toEqual(new Set(['big', 'w2', 'w3']))
})

// A task measured over every size's cores: packed, it fit no worker, the
// plan placed nothing and asked for none, and the run waited forever.
it('plans a task over every size’s cores as the play does, not out of the run', () => {
  const one = size('one', 1)
  const p = plan([task('a', 2, [], 1.3)], [], candidates([one], new Map(), [], 1), WARM)
  expect(p.start).toEqual([one])
})

// As the run books it: a server's base once on each worker, from its first
// dependant there to its last, beside each dependant's own cores.
it('books a server’s base once per worker it runs on', () => {
  const servers = [{ id: 's#db', cores: 2 }]
  const plain = ['a', 'b', 'c'].map((id) => task(id, 1_000))
  const tasks = plain.map((t) => ({ ...t, servers }))
  // 2 for the base, then 1 each: two fit on 4 cores, the third after.
  expect(pack(tasks, [worker('w')], [], () => WARM, Infinity).end).toBe(2_000)
  // CONTROL: with no base all three fit at once.
  expect(pack(plain, [worker('w')], [], () => WARM, Infinity).end).toBe(1_000)
  // A worker already running it books it no more.
  const serving = worker('w', { serving: new Map([['s#db', 2]]) })
  expect(pack(tasks, [serving], [], () => WARM, Infinity).end).toBe(2_000)
  expect(pack(tasks.slice(0, 2), [serving], [], () => WARM, Infinity).end).toBe(1_000)
  // Between two dependants it runs on: no room for a 3-core task then.
  const gap = [
    { ...task('x', 1_000), servers },
    { ...task('y', 1_000, ['x']), servers },
    task('z', 1_000, [], 3),
  ]
  const p = pack(gap, [worker('w')], [], () => WARM, Infinity)
  expect(p.placed.get('z')!.at).toBeGreaterThanOrEqual(2_000)
})

// Main 6406ebd asked 10 workers where 4 ended as soon: one task with a
// server turned the packing off, and the play spread the slack over all.
it('packs a run with a server’s dependant on no worker more than without', () => {
  const tasks = [
    task('a', 60_000),
    task('b', 60_000, ['a']),
    ...Array.from({ length: 10 }, (_, i) => task(`f${i}`, 30_000, [], 1)),
  ]
  const sizes = candidates([{ ...size('w', 4), max: 9 }], new Map(), [], tasks.length)
  const plain = plan(tasks, [], sizes, WARM)
  const served = plan(
    tasks.map((t) => (t.id === 'f0' ? { ...t, servers: [{ id: 's#db', cores: 0.5 }] } : t)),
    [],
    sizes,
    WARM,
  )
  expect(served.endsInMs).toBe(plain.endsInMs)
  expect(served.start.length + served.later.length).toBe(plain.start.length + plain.later.length)
  expect(served.start.length).toBe(1)
})

// Main cc6cd1a planned its 4-core workers at 3 (the rest busy outside
// tasks), its lints booked 3.5: none fit, the packing was dropped, and the
// play asked 10 workers where 5 ended as soon.
it('packs a task booking more cores than any worker has onto a whole one', () => {
  const tasks = [
    task('a', 60_000),
    task('b', 60_000, ['a']),
    task('lint', 4_000, [], 3.5),
    // Read against the declared 4-core size: a bigger one than 3.4, which none planned is.
    { ...task('lint2', 4_000, [], 3.4), above: { cores: 3.4 - 1e-6, memory: Infinity } },
    ...Array.from({ length: 6 }, (_, i) => task(`f${i}`, 30_000, [], 1)),
  ]
  const sizes = candidates([{ ...size('w', 3), max: 9 }], new Map(), [], tasks.length)
  const p = plan(tasks, [], sizes, WARM)
  expect(p.exact).toBe(true)
  expect(p.unpacked).toBeUndefined()
  expect(p.endsInMs).toBe(WARM + 120_000)
})

// A plan that plays its work says why it did not pack it, for the profile.
it('says why it played the work rather than packed it', () => {
  const sizes = candidates([{ ...size('w', 4), max: 2 }], new Map(), [], 2)
  // One task on one worker: packed or played, it holds as much.
  expect(plan([task('a', 1_000)], [], sizes, WARM).unpacked).toBe('holds 84000, the play 84000')
  const blind = plan([{ ...task('a', 1_000), ms: undefined }], [], sizes, WARM)
  expect(blind.unpacked).toBe('a task has no history')
})

// A task known to run slow seeks room by its slow run, not its history
// and the flat margin: queued 40 s behind the cheaper worker, its 60 s
// slow run would end past the deadline, so it takes the dearer room now.
it('seeks room for a task by its slow run when one is known', () => {
  const workers = [
    worker('one', { idle: false, running: [{ id: 'x', cores: 4, memory: 1e8, endsIn: 40_000 }] }),
    worker('two', {
      cores: 8,
      idle: false,
      running: [{ id: 'y', cores: 4, memory: 1e8, endsIn: 10_000 }],
    }),
  ]
  const tasks = (slowMs?: number): PlanTask[] => [
    { ...task('b', 40_000, [], 4), ...(slowMs === undefined ? {} : { slowMs }) },
  ]
  const plain = pack(tasks(), workers, [size('w', 4)], () => WARM, 90_000)
  expect(plain.placed.get('b')).toMatchObject({ worker: 'one', at: 40_000 })
  const slow = pack(tasks(60_000), workers, [size('w', 4)], () => WARM, 90_000)
  expect(slow.placed.get('b')).toMatchObject({ worker: 'two', at: 0 })
  expect(slow.starts).toEqual([])
})
