import { expect, it } from 'bun:test'
import type { TaskNode } from '@vzn/vx'
import {
  candidates,
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
// the work at 46% (2026-10-23).
it('plans main’s run on two workers: only its misses are work, never a group or a hit', () => {
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
  expect(p.start).toEqual([small, small])
  expect(p.release).toEqual([])
  // The plan's core-time used: its tasks' cores over the workers' after they join.
  const used = work.reduce((n, t) => n + t.cores * t.ms!, 0)
  const had = p.start.length * small.cpu * (p.endsInMs - WARM)
  expect(used / had).toBeGreaterThan(0.6)
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
