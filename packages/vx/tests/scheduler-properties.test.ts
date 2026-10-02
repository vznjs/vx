// The scheduler's invariants over seeded random graphs: restore tier,
// demoted restores, groups, pools, an admission policy, failures, a stop,
// all three `--continue` modes. Each run is checked against what the
// module promises (scheduler.md), not against a recorded order, so a
// change that keeps them keeps this green. Seeded: a failure reproduces.
// The taint tracker is checked against its definition the same way (C-70).

import { describe, expect, it } from 'bun:test'
import type { TaskNode } from '../src/graph/index.js'
import { RestoreDemoted, runGraph, type TaskOutcome } from '../src/graph/scheduler.js'
import { taintTracker } from '../src/orchestrator/admission.js'

function rng(seed: number): () => number {
  let s = seed
  return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648
}

interface Scenario {
  nodes: Map<string, TaskNode>
  restore: Set<string>
  demote: Set<string>
  fail: Set<string>
  pooled: Set<string>
}

function scenario(rnd: () => number): Scenario {
  const n = 2 + Math.floor(rnd() * 10)
  const nodes = new Map<string, TaskNode>()
  for (let i = 0; i < n; i++) {
    const deps: string[] = []
    for (let j = 0; j < i; j++) if (rnd() < 0.3) deps.push(`p${j}#t`)
    const group = rnd() < 0.15
    nodes.set(`p${i}#t`, {
      id: `p${i}#t`,
      projectName: `p${i}`,
      taskName: 't',
      projectDir: '/',
      config: group ? {} : { exec: { command: 'x' } },
      deps,
      requested: true,
    } as TaskNode)
  }
  const restore = new Set<string>()
  const demote = new Set<string>()
  const fail = new Set<string>()
  const pooled = new Set<string>()
  for (const [id, node] of nodes) {
    const r = rnd()
    if (node.config.exec !== undefined && r < 0.35) {
      restore.add(id)
      if (rnd() < 0.2) demote.add(id)
    } else if (r < 0.55) fail.add(id)
    else if (r < 0.7) pooled.add(id)
  }
  return { nodes, restore, demote, fail, pooled }
}

function ancestors(nodes: Map<string, TaskNode>, id: string): Set<string> {
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

const yieldTurns = (k: number) =>
  Array.from({ length: k }).reduce<Promise<void>>(
    (p) => p.then(() => Bun.sleep(0)),
    Promise.resolve(),
  )

describe('the scheduler over random graphs', () => {
  for (const mode of ['never', 'deps-ok', 'always'] as const) {
    it(`keeps its promises under --continue=${mode}`, async () => {
      const rnd = rng(mode.length * 7919)
      const broken: string[] = []
      for (let iter = 0; iter < 150; iter++) {
        const sc = scenario(rnd)
        const conc = 1 + Math.floor(rnd() * 3)
        const cap = 1 + Math.floor(rnd() * 2)
        const usePool = rnd() < 0.5
        const useAdmit = rnd() < 0.4
        const stopAt = rnd() < 0.3 ? Math.floor(rnd() * 6) : -1
        const ac = new AbortController()
        let clock = 0
        let stoppedAt = Infinity
        const started = new Map<string, number>()
        const finished = new Map<string, number>()
        const demoted = new Set<string>()
        let local = 0
        let pool = 0
        let rest = 0
        const bad = (m: string) => broken.push(`#${iter} ${m}`)
        const out = await runGraph({
          nodes: sc.nodes,
          concurrency: conc,
          continueMode: mode,
          restoreTier: sc.restore,
          signal: ac.signal,
          ...(usePool
            ? {
                poolOf: (id: string) =>
                  sc.pooled.has(id) ? { name: 'pool', capacity: cap } : undefined,
              }
            : {}),
          ...(useAdmit
            ? { admit: (_id: string, running) => running.size === 0 || rnd() < 0.5 }
            : {}),
          onFinish: (o) => finished.set(o.node.id, ++clock),
          execute: async (node) => {
            const id = node.id
            const restoring = sc.restore.has(id) && !demoted.has(id)
            if (restoring && sc.demote.has(id)) {
              demoted.add(id)
              await Bun.sleep(0)
              throw new RestoreDemoted(id)
            }
            started.set(id, ++clock)
            if (stopAt >= 0 && started.size > stopAt && stoppedAt === Infinity) {
              stoppedAt = clock
              ac.abort()
            }
            const lane = restoring ? 'restore' : usePool && sc.pooled.has(id) ? 'pool' : 'local'
            if (lane === 'restore') rest++
            else if (lane === 'pool') pool++
            else local++
            if (conc === 1 && local + rest > 1) bad('two in the serial slot')
            if (conc > 1 && local > conc) bad(`local ${local} > ${conc}`)
            if (conc > 1 && rest > 2 * conc) bad(`restore ${rest} > ${2 * conc}`)
            if (pool > cap) bad(`pool ${pool} > ${cap}`)
            await yieldTurns(Math.floor(rnd() * 3))
            if (lane === 'restore') rest--
            else if (lane === 'pool') pool--
            else local--
            const status = restoring ? 'cache-hit' : sc.fail.has(id) ? 'failed' : 'success'
            return {
              node,
              status,
              exitCode: status === 'failed' ? 1 : 0,
              durationMs: 0,
            } as TaskOutcome
          },
        })
        if (out.size !== sc.nodes.size) bad(`${out.size} outcomes for ${sc.nodes.size} tasks`)
        for (const [id, o] of out) {
          const restoring = sc.restore.has(id) && !demoted.has(id)
          const at = started.get(id)
          if (at !== undefined && at > stoppedAt && !restoring) bad(`${id} started after the stop`)
          if (o.status === 'aborted' && stoppedAt === Infinity) bad(`${id} aborted with no stop`)
          // An exec-tier task starts after everything above it has
          // finished, a restore's own deps included (item 963).
          if (at !== undefined && !restoring) {
            for (const a of ancestors(sc.nodes, id)) {
              if (!(finished.get(a)! < at)) bad(`${id} started before ${a} finished`)
            }
          }
          if (stoppedAt === Infinity && mode === 'deps-ok' && !restoring && at !== undefined) {
            for (const a of ancestors(sc.nodes, id)) {
              const s = out.get(a)!.status
              if (s === 'failed' || s === 'skipped') bad(`${id} ran over ${a} ${s}`)
            }
          }
          if (o.status === 'skipped') {
            if (o.blockedBy !== undefined) {
              const root = out.get(o.blockedBy)
              if (!ancestors(sc.nodes, id).has(o.blockedBy) || root?.status !== 'failed')
                bad(`${id} blocked by ${o.blockedBy}`)
            } else if (mode !== 'never') bad(`${id} skipped by nothing`)
          }
        }
      }
      expect(broken).toEqual([])
    })
  }
})

describe('the taint tracker over random graphs', () => {
  it('judges each executed task as its definition does', async () => {
    const rnd = rng(4099)
    const broken: string[] = []
    for (let iter = 0; iter < 300; iter++) {
      const sc = scenario(rnd)
      const seeds = new Set([...sc.nodes.keys()].filter(() => rnd() < 0.05))
      const tracker = taintTracker(true, seeds, sc.nodes)
      const judged = new Map<string, boolean>()
      const out = await runGraph({
        nodes: sc.nodes,
        concurrency: 1 + Math.floor(rnd() * 3),
        continueMode: 'always',
        restoreTier: sc.restore,
        onFinish: (o) => tracker.settled(o),
        execute: async (node, upstream) => {
          if (!sc.restore.has(node.id)) judged.set(node.id, tracker.judge(node, upstream))
          await yieldTurns(Math.floor(rnd() * 3))
          const restoring = sc.restore.has(node.id)
          const status = restoring ? 'cache-hit' : sc.fail.has(node.id) ? 'failed' : 'success'
          return { node, status, exitCode: 0, durationMs: 0 } as TaskOutcome
        },
      })
      // Tainted: a seed, or a dep that did not succeed, or a tainted dep.
      const memo = new Map<string, boolean>()
      const tainted = (id: string): boolean => {
        const known = memo.get(id)
        if (known !== undefined) return known
        const t =
          seeds.has(id) ||
          sc.nodes.get(id)!.deps.some((d) => {
            const s = out.get(d)!.status
            return s === 'failed' || s === 'skipped' || s === 'aborted' || tainted(d)
          })
        memo.set(id, t)
        return t
      }
      for (const [id, j] of judged) if (j !== tainted(id)) broken.push(`#${iter} ${id}: ${j}`)
    }
    expect(broken).toEqual([])
  })
})
