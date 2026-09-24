// schedule-policy.ts decides whether a task with no history should run
// first (item 669), so its simulator is pinned twice: on graphs whose
// schedules are computed by hand below, and against the REAL `runGraph`
// driven on a virtual clock, which holds the mirrored dispatch loop (the
// enqueue-order tie-break, one completion settled at a time) to core's.

import { describe, expect, it } from 'bun:test'
import type { TaskOutcome } from '@vzn/vx'
import { runGraph } from '../../vx/src/graph/scheduler.js'
import {
  instance,
  nodeMap,
  pluginPriorities,
  POLICIES,
  priorities,
  SHAPES,
  simulate,
  type Policy,
  type SimSpan,
  type SimTask,
} from '../schedule-policy.js'

// Nx's `should schedule task with no historial runtime first`
// (tasks-schedule.spec.ts:497): lib1 blocks app1; app2 and app3 have no
// history; app4 took 500, app1 200, lib1 100. Nx dispatches lib1, app2,
// app3, app4, app1. The true durations of the unknowns are 300 and 50.
const nx: SimTask[] = [
  { id: 'lib1', deps: [], dur: 100 },
  { id: 'app1', deps: ['lib1'], dur: 200 },
  { id: 'app2', deps: [], dur: 300 },
  { id: 'app3', deps: [], dur: 50 },
  { id: 'app4', deps: [], dur: 500 },
]
const nxUnknown = new Set(['app2', 'app3'])

const run = (policy: Policy, workers: number) =>
  simulate(nx, priorities(policy, nx, nxUnknown), workers)

describe('schedule-policy simulator', () => {
  it('dispatches the Nx fixture in each policy order on one worker', () => {
    // count: lib1 alone gates work (1 dependent); the rest tie at 0 and go
    // in enqueue order, app1 last because it enqueues when lib1 finishes.
    expect(run('count', 1).order).toEqual(['lib1', 'app2', 'app3', 'app4', 'app1'])
    // median: the unknowns take the known median, 200; lib1 ranks 100+200.
    expect(run('median', 1).order).toEqual(['app4', 'lib1', 'app2', 'app3', 'app1'])
    // unknown-first: the unknowns assume 501, one above the longest known
    // path (app4, 500), so both outrank every known task.
    expect(run('unknown-first', 1).order).toEqual(['app2', 'app3', 'app4', 'lib1', 'app1'])
    // oracle: app4 500 · lib1 300 (+1 dependent) · app2 300 · app1 200 · app3 50.
    expect(run('oracle', 1).order).toEqual(['app4', 'lib1', 'app2', 'app1', 'app3'])
  })

  it('schedules the Nx fixture on two workers to the hand-computed makespan', () => {
    // count: lib1 0–100, app2 0–300, app3 100–150, app4 150–650, app1 300–500.
    expect(run('count', 2).makespan).toBe(650)
    // median: app4 0–500, lib1 0–100, app2 100–400, app3 400–450, app1 450–650.
    expect(run('median', 2).makespan).toBe(650)
    // unknown-first: app2 0–300, app3 0–50, app4 50–550, lib1 300–400, app1 400–600.
    expect(run('unknown-first', 2).makespan).toBe(600)
    // oracle: app4 0–500, lib1 0–100, app2 100–400, app1 400–600, app3 500–550.
    expect(run('oracle', 2).makespan).toBe(600)
  })
})

/** The real scheduler, every task a timer on a virtual clock. */
async function realRun(
  tasks: readonly SimTask[],
  plugin: ReadonlyMap<string, number> | undefined,
  workers: number,
): Promise<{ makespan: number; order: string[]; spans: SimSpan[] }> {
  const dur = new Map(tasks.map((t) => [t.id, t.dur]))
  const running: Array<{ end: number; started: number; settle: () => void }> = []
  const order: string[] = []
  const spans: SimSpan[] = []
  let now = 0
  const done = runGraph({
    nodes: nodeMap(tasks),
    concurrency: workers,
    ...(plugin !== undefined ? { priorities: plugin } : {}),
    execute: (node) =>
      new Promise<TaskOutcome>((resolve) => {
        const ms = dur.get(node.id)!
        running.push({
          end: now + ms,
          started: order.length,
          settle: () => resolve({ node, status: 'success', exitCode: 0, durationMs: ms }),
        })
        order.push(node.id)
        spans.push({ id: node.id, start: now, end: now + ms })
      }),
  })
  const drain = () => new Promise<void>((r) => setImmediate(r))
  await drain()
  while (running.length > 0) {
    running.sort((a, b) => a.end - b.end || a.started - b.started)
    const next = running.shift()!
    now = next.end
    next.settle()
    await drain()
  }
  await done
  return { makespan: now, order, spans }
}

describe('the simulator against runGraph', () => {
  // The spans are what the Learn page's Gantt chart draws (item 685), so
  // they are held to the real scheduler's start times too.
  it('reproduces the real dispatch order, start times and makespan', async () => {
    const cases: Array<[string, SimTask[], ReadonlySet<string>, number]> = [
      ['nx/1w', nx, nxUnknown, 1],
      ['nx/2w', nx, nxUnknown, 2],
    ]
    for (const name of [
      'wide-fan(500)',
      'diamond(200)',
      'cp-bound(60chain+300filler)',
      'mixed-layered(20x40/8w)',
      'monorepo(200pkg/8w)',
    ]) {
      const shape = SHAPES.find((s) => s.name === name)!
      for (const mask of [0.1, 0.5]) {
        const { tasks, unknown } = instance(shape, 1, mask)
        cases.push([`${name}@${mask}`, tasks, unknown, shape.workers])
      }
    }
    for (const [name, tasks, unknown, workers] of cases) {
      for (const policy of POLICIES) {
        const sim = simulate(tasks, priorities(policy, tasks, unknown), workers)
        const real = await realRun(tasks, pluginPriorities(policy, tasks, unknown), workers)
        expect({ case: `${name} ${policy}`, ...real }).toEqual({
          case: `${name} ${policy}`,
          makespan: sim.makespan,
          order: [...sim.order],
          spans: [...sim.spans],
        })
      }
    }
  })
})
