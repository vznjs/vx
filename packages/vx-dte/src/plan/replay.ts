// A run played by the engine with every task's real time and cores known
// (2026-11-18: "use the same algorithm we have, but give it the exact
// numbers... and that's ideal of this algorithm"): what a fleet of sizes
// would have done with the run's work.

import { Engine } from './engine.js'
import type { PlanTask, Size } from './model.js'

/** What the engine did with the run's tasks on a fleet. */
export interface Replayed {
  readonly endMs: number
  /** Core-ms the workers were held, each from its ask to its leave, warm-up included. */
  readonly heldMs: number
  /** How many workers of each size it asked for, as `sizes` orders them. */
  readonly asked: readonly number[]
}

/**
 * `tasks` as each took, from nothing, on `sizes`: each worker joins its
 * platform's `warm` after the engine asks for it. Planned plain, with no
 * restarts: a live run under history's spread never restarts, and the
 * restarts doubled advice's time for ends within its margin (2026-11-20).
 */
export function replay(
  tasks: readonly PlanTask[],
  sizes: readonly Size[],
  warm: (platform: string | undefined) => number,
  /** `Date.now()` past which it stops as one that cannot finish (`endMs` Infinity). */
  deadline = Infinity,
): Replayed {
  const n = tasks.length
  const ix = new Map(tasks.map((t, i) => [t.id, i]))
  const platformOf = (p: string | undefined): string => p ?? ''
  const ms = tasks.map((t) => t.ms ?? 0)
  const cores = tasks.map((t) => Math.max(1, t.cores))
  const e = new Engine(
    {
      deps: tasks.map((t) => t.deps.flatMap((d) => (ix.has(d) ? [ix.get(d)!] : []))),
      platform: tasks.map((t) => platformOf(t.platform)),
      ms,
      sd: ms.map(() => 0),
      cores,
    },
    sizes.map((s) => ({
      cores: s.cpu,
      max: s.max,
      platform: platformOf(s.platform),
      warmUpMs: warm(s.platform),
    })),
    { restarts: false },
  )
  interface W {
    readonly z: number
    readonly cores: number
    readonly askedAt: number
    readonly joinAt: number
    joined: boolean
    leftAt?: number
    readonly run: Set<number>
  }
  const ws: W[] = []
  const progress = new Float64Array(n)
  let t = 0
  let held = 0
  let left = n
  const apply = (d: ReturnType<Engine['decide']>): number => {
    for (const [wi, z] of d.ask)
      ws[wi] = {
        z,
        cores: sizes[z]!.cpu,
        askedAt: t,
        joinAt: t + warm(sizes[z]!.platform),
        joined: false,
        run: new Set(),
      }
    for (const [i, wi] of d.start) ws[wi]!.run.add(i)
    for (const wi of d.leave) {
      const w = ws[wi]!
      w.leftAt = t
      held += w.cores * (t - w.askedAt)
    }
    return d.due
  }
  const load = (w: W): number => {
    let s = 0
    for (const j of w.run) s += cores[j]!
    return s
  }
  // A task goes only where its peak memory fits: a 25 GB one was advised a 16 GB worker.
  const fits = {
    size: (i: number, z: number) => tasks[i]!.memory <= sizes[z]!.memory,
    // One asked in this same decision: its size already passed `size`.
    on: (i: number, w: number) =>
      ws[w] === undefined || tasks[i]!.memory <= sizes[ws[w]!.z]!.memory,
  }
  let due = apply(e.decide(0, fits))
  while (left > 0) {
    let next = due
    for (const w of ws) {
      if (w.leftAt !== undefined) continue
      if (!w.joined) next = Math.min(next, w.joinAt)
      const s = Math.max(1, load(w) / w.cores)
      for (const j of w.run) next = Math.min(next, t + (ms[j]! - progress[j]!) * s)
    }
    // Nothing can run it (no size of a task's platform), or out of time: as far as it got.
    if (next === Infinity || Date.now() > deadline) break
    const dt = next - t
    for (const w of ws) {
      if (w.leftAt !== undefined) continue
      const s = Math.max(1, load(w) / w.cores)
      for (const j of w.run) progress[j]! += dt / s
    }
    t = next
    for (let wi = 0; wi < ws.length; wi++) {
      const w = ws[wi]!
      if (w.leftAt !== undefined) continue
      if (!w.joined && w.joinAt <= t) {
        w.joined = true
        e.joined(wi, t)
      }
      for (const j of [...w.run])
        if (ms[j]! - progress[j]! <= 1e-6) {
          w.run.delete(j)
          left--
          e.finished(j, t, ms[j]!)
        }
    }
    if (left === 0) break
    due = apply(e.decide(t, fits))
  }
  for (const w of ws) if (w.leftAt === undefined) held += w.cores * (t - w.askedAt)
  return {
    endMs: left === 0 ? t : Infinity,
    heldMs: held,
    asked: sizes.map((_, z) => ws.filter((w) => w.z === z).length),
  }
}
