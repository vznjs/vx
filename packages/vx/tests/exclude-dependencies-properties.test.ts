// `--exclude-dependencies` over seeded random graphs: it takes edges out
// of the schedule, never an ORDER. If a scheduled task reached another
// scheduled task through the original graph, it still does (item 1019's
// rule: a task reached through a dropped one still runs after it), a
// direct edge to a task still scheduled stays a real one (item 980), and
// no edge names a task the schedule no longer holds (C-71).

import { expect, it } from 'bun:test'
import type { TaskNode } from '../src/graph/index.js'
import { excludeDependencies } from '../src/graph/task-graph.js'
import { rng } from './helpers/rng.js'

const NAMES = ['build', 'gen', 'test', 'lint']

function reaches(graph: Map<string, readonly string[]>, from: string, to: string): boolean {
  const seen = new Set<string>()
  const stack = [...(graph.get(from) ?? [])]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (id === to) return true
    if (seen.has(id)) continue
    seen.add(id)
    stack.push(...(graph.get(id) ?? []))
  }
  return false
}

it('keeps every order between the tasks it still schedules', () => {
  const rnd = rng(1019)
  const broken: string[] = []
  for (let iter = 0; iter < 2000; iter++) {
    const n = 2 + Math.floor(rnd() * 10)
    const nodes = new Map<string, TaskNode>()
    for (let i = 0; i < n; i++) {
      const deps: string[] = []
      for (let j = 0; j < i; j++) if (rnd() < 0.35) deps.push(`p${j}#${NAMES[j % 4]}`)
      const id = `p${i}#${NAMES[i % 4]}`
      nodes.set(id, {
        id,
        projectName: `p${i}`,
        taskName: NAMES[i % 4]!,
        projectDir: '/',
        config: rnd() < 0.15 ? {} : { exec: { command: 'x' } },
        deps: deps.sort(),
        requested: rnd() < 0.3,
      } as TaskNode)
    }
    const before = new Map([...nodes].map(([id, node]) => [id, [...node.deps]]))
    const exclude = rnd() < 0.3 ? ('all' as const) : NAMES.filter(() => rnd() < 0.4)
    excludeDependencies(nodes, exclude)
    const after = new Map([...nodes].map(([id, node]) => [id, node.deps]))
    for (const [a, deps] of after) {
      for (const d of deps)
        if (!nodes.has(d)) broken.push(`#${iter} ${a} -> ${d} left the schedule`)
      // A direct edge to a task still scheduled stays a real edge, not an
      // order-only one: the dependant's key folds it (item 980).
      const orderOnly = nodes.get(a)!.orderOnly ?? []
      for (const d of before.get(a)!) {
        if (nodes.has(d) && (!deps.includes(d) || orderOnly.includes(d)))
          broken.push(`#${iter} ${a} -> ${d} became order-only`)
      }
      for (const b of nodes.keys()) {
        if (a !== b && reaches(before, a, b) && !reaches(after, a, b))
          broken.push(`#${iter} ${a} no longer after ${b} (${JSON.stringify(exclude)})`)
      }
    }
  }
  expect(broken).toEqual([])
})
