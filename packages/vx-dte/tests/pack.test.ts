import { expect, it } from 'bun:test'
import { Placing } from '../src/dispatch.js'
import { pack } from '../src/pack.js'
import type { PlanTask, PlanWorker, Size } from '../src/planner.js'

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
