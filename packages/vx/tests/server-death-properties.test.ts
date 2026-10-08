// What a server's death mid-run does to the rest of the graph (C-88,
// C-89), over seeded random graphs with groups and servers that die at
// random points: a dependant that starts after its server died, directly
// or through groups, is a defect under `deps-ok`; under `never` nothing
// starts after any death; a skip charged to a server names a dead one;
// every task gets an outcome and the run ends. Seeded: a failure
// reproduces. The walk through groups is held by
// `server-crash-through-group.test.ts`: a group finishes the moment its
// server is ready, so a task behind it starts after the death only when
// another dep holds it, a shape these graphs seldom draw.

import { expect, it } from 'bun:test'
import type { TaskNode } from '../src/graph/index.js'
import { deadServerBehind, runGraph, type TaskOutcome } from '../src/graph/scheduler.js'
import { rng } from './helpers/rng.js'

it('a dead server stops what depends on it, over random graphs', async () => {
  const violations: string[] = []
  let exercised = 0
  for (let seed = 1; seed <= 600; seed++) {
    const rnd = rng(seed)
    const nodes = new Map<string, TaskNode>()
    const servers = new Set<string>()
    const n = 3 + Math.floor(rnd() * 10)
    for (let i = 0; i < n; i++) {
      const deps: string[] = []
      for (let j = 0; j < i; j++) if (rnd() < 0.3) deps.push(`p${j}#t`)
      const r = rnd()
      const group = r < 0.15
      const server = !group && r < 0.4
      if (server) servers.add(`p${i}#t`)
      const exec = server ? { command: 'x', persistent: {} } : { command: 'x' }
      nodes.set(`p${i}#t`, {
        id: `p${i}#t`,
        projectName: `p${i}`,
        taskName: 't',
        projectDir: '/',
        config: group ? {} : { exec },
        deps,
        requested: true,
      } as TaskNode)
    }
    const mode = (['never', 'deps-ok', 'always'] as const)[seed % 3]!
    // A server dies once it has started and `after` more tasks finished.
    const dieAfter = new Map(
      [...servers].filter(() => rnd() < 0.5).map((s) => [s, Math.floor(rnd() * 6)]),
    )
    const diedAt = new Map<string, number>()
    const started: Array<[string, number]> = []
    let finished = 0
    const execute = async (node: TaskNode): Promise<TaskOutcome> => {
      started.push([node.id, finished])
      await Bun.sleep(Math.floor(rnd() * 3))
      finished++
      for (const [s, after] of dieAfter) {
        if (diedAt.has(s) || finished < after) continue
        if (started.some(([id]) => id === s)) diedAt.set(s, finished)
      }
      return { node, status: 'success', exitCode: 0, durationMs: 1 }
    }
    const said = (why: string): void => void violations.push(`seed ${seed} (${mode}): ${why}`)
    const out = await Promise.race([
      runGraph({
        nodes,
        concurrency: 1 + Math.floor(rnd() * 3),
        continueMode: mode,
        execute,
        serverDied: (id) => diedAt.has(id),
      }),
      Bun.sleep(5_000).then(() => 'hang' as const),
    ])
    if (out === 'hang') {
      said('the run did not end')
      continue
    }
    if (out.size !== nodes.size) said(`${out.size} outcomes for ${nodes.size} tasks`)
    for (const o of out.values()) {
      if (o.status !== 'skipped' || o.blockedBy === undefined || !servers.has(o.blockedBy)) continue
      if (!diedAt.has(o.blockedBy)) said(`${o.node.id} charged to ${o.blockedBy}, which lives`)
    }
    for (const [id, at] of started) {
      for (const [s, died] of diedAt) {
        if (at < died) continue
        exercised++
        if (mode === 'never') said(`${id} started after ${s} died`)
        const via = (d: string) => deadServerBehind(nodes, (x) => x === s, d) === s
        if (mode === 'deps-ok' && nodes.get(id)!.deps.some(via))
          said(`${id} started after ${s}, which it depends on, died`)
      }
    }
  }
  expect(violations).toEqual([])
  // The property is about tasks that start after a death: hold the
  // generator to producing them, or the row checks nothing.
  expect(exercised).toBeGreaterThan(100)
}, 60_000)

const group = (id: string, deps: string[]): TaskNode =>
  ({
    id,
    projectName: 'p',
    taskName: id,
    projectDir: '/',
    config: {},
    deps,
    requested: true,
  }) as TaskNode

it('a dead server is found behind a 50,000-deep chain of groups', () => {
  const DEPTH = 50_000
  const nodes = new Map<string, TaskNode>()
  for (let i = 0; i < DEPTH; i++)
    nodes.set(`g${i}`, group(`g${i}`, [i + 1 < DEPTH ? `g${i + 1}` : 'srv']))
  expect(deadServerBehind(nodes, (x) => x === 'srv', 'g0')).toBe('srv')
})

it('a ladder of group diamonds asks of each node once', () => {
  // Each rung's two groups both lead to the next rung: 2^20 paths, 40 nodes.
  const RUNGS = 20
  const nodes = new Map<string, TaskNode>()
  for (let i = 0; i < RUNGS; i++) {
    const next = i + 1 < RUNGS ? [`l${i + 1}`, `r${i + 1}`] : ['srv']
    nodes.set(`l${i}`, group(`l${i}`, next))
    nodes.set(`r${i}`, group(`r${i}`, next))
  }
  let asked = 0
  const died = (): boolean => {
    asked++
    return false
  }
  expect(deadServerBehind(nodes, died, 'l0')).toBeUndefined()
  expect(asked).toBe(2 * RUNGS)
})
