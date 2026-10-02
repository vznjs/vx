// The taint rule over seeded random graphs, against a brute-force
// reference. A task is tainted when it is a seed (a dependency
// `--exclude-dependencies` kept from running) or, under
// `--continue=always`, when any dependency failed, aborted or skipped, or
// is itself tainted. Outcomes settle in ANY order (a restore-tier hit
// settles before its deps), and partial asks come in between; an ask made
// once every ancestor has settled — the scheduler's guarantee (item 963) —
// must give the reference's answer, whatever the memo learned before
// (C-23, C-78).

import { expect, it } from 'bun:test'
import type { TaskNode, TaskOutcome, TaskStatus } from '../src/graph/index.js'
import { taintTracker } from '../src/orchestrator/admission.js'
import { rng } from './helpers/rng.js'

const STATUSES: TaskStatus[] = ['success', 'cache-hit', 'failed', 'skipped', 'aborted']
const BAD = new Set<TaskStatus>(['failed', 'skipped', 'aborted'])

function check(continueAlways: boolean, seed: number): string[] {
  const rnd = rng(seed)
  const broken: string[] = []
  for (let iter = 0; iter < 1500; iter++) {
    const n = 2 + Math.floor(rnd() * 11)
    const nodes = new Map<string, TaskNode>()
    for (let i = 0; i < n; i++) {
      const deps: string[] = []
      for (let j = 0; j < i; j++) if (rnd() < 0.3) deps.push(`t${j}`)
      nodes.set(`t${i}`, { id: `t${i}`, deps } as unknown as TaskNode)
    }
    const ids = [...nodes.keys()]
    const seeds = new Set(ids.filter(() => rnd() < (continueAlways ? 0.1 : 0.25)))
    const status = new Map(ids.map((id) => [id, STATUSES[Math.floor(rnd() * STATUSES.length)]!]))
    const reference = new Map<string, boolean>()
    for (const id of ids) {
      const deps = nodes.get(id)!.deps
      reference.set(
        id,
        seeds.has(id) ||
          deps.some((d) => (continueAlways && BAD.has(status.get(d)!)) || reference.get(d)!),
      )
    }
    const outcome = (id: string): TaskOutcome =>
      ({ node: nodes.get(id)!, status: status.get(id)! }) as TaskOutcome
    const ancestors = (id: string): Set<string> => {
      const out = new Set<string>()
      const stack = [...nodes.get(id)!.deps]
      while (stack.length > 0) {
        const d = stack.pop()!
        if (out.has(d)) continue
        out.add(d)
        stack.push(...nodes.get(d)!.deps)
      }
      return out
    }
    const t = taintTracker(continueAlways, seeds, nodes)
    const settled = new Set<string>()
    const order = [...ids].sort(() => rnd() - 0.5)
    const judged = new Set<string>()
    const ask = (id: string): boolean =>
      t.judge(
        nodes.get(id)!,
        nodes
          .get(id)!
          .deps.filter((d) => settled.has(d))
          .map(outcome),
      )
    for (const id of order) {
      t.settled(outcome(id))
      settled.add(id)
      // Partial asks, what a restore-tier task dispatched early hears: each
      // one feeds the memo while some ancestor is still out.
      for (const x of ids) if (rnd() < 0.5) void ask(x)
      for (const x of ids) {
        if (judged.has(x) || ![...ancestors(x)].every((a) => settled.has(a))) continue
        judged.add(x)
        const got = ask(x)
        if (got !== reference.get(x))
          broken.push(
            `#${iter} ${x}: ${got}, expected ${reference.get(x)} ` +
              `(edges ${JSON.stringify(Object.fromEntries([...nodes].map(([k, v]) => [k, v.deps])))}, ` +
              `seeds ${[...seeds].join(',')}, status ${JSON.stringify(Object.fromEntries(status))}, order ${order.join(',')})`,
          )
      }
    }
  }
  return broken
}

it('under --continue=always, a task is tainted exactly when the reference says', () => {
  expect(check(true, 23).slice(0, 3)).toEqual([])
})

it('with seeds alone, a task is tainted exactly when it reaches a seed', () => {
  expect(check(false, 1019).slice(0, 3)).toEqual([])
})
