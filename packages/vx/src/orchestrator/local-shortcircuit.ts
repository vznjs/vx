// Local cache short-circuit (default-on) — the classify phase. The
// owner's scheduling policy: "prioritize running cache MISSES; only if
// required, or if there are free workers, add cache restores." So a
// confirmed stable-key LOCAL cache HIT should not have to wait for its
// dependencies to finish RUNNING — its bytes are derivable now and its
// restore needs none of its deps' output — but it must NOT preempt a
// real cache MISS for a worker slot.
//
// This module owns the UP-FRONT CLASSIFY: for every STABLE-key,
// cacheable, local-read task it derives the key (reusing the run's
// hashCache memo) and probes `cache.get` ONCE, building a `preProbed`
// map that covers stable HITS and stable MISSES alike. The scheduler
// (two-tier) and execute-task (probe reuse) consume it:
//
//   - hit  → RESTORE-TIER: scheduler makes it ready immediately (LOW
//            priority), execute reuses the probed entry → restoreHit
//            (no second cache.get).
//   - miss → EXEC-TIER (stable): scheduler runs it dep-gated at normal
//            priority; execute skips the first cache.get (it's a known
//            miss) and goes to the run path.
//   - unstable / not-probed → EXEC-TIER: execute probes lazily, exactly
//            as today (a codegen-consumer's key isn't computable until
//            its upstream runs — see dependsOnSiblingOutputs).
//
// Because EVERY task still runs through execute(), the logger emits the
// same taskStart + stdout replay + taskComplete it always did — the
// focused live frame is preserved with zero special-casing — and the
// up-front probes are just the probes execute() would have done,
// hoisted (no double work — the warm path stays free).
//
// SCOPE / safety:
//   - Only STABLE-key, cacheable, local-read tasks are classified. A
//     stable miss stays in the normal (dep-gated) schedule; an unstable
//     task is never probed here.
//   - If ANY task in the graph declares `cache.outputs.workspaceFiles`,
//     no task is restore-tiered (the boundary-ignoring escape hatch
//     could let a task write where a restore touches — a blanket
//     conservative exclusion). Those tasks still get an exec-tier probe
//     reuse entry so there's no double work.

import type { CacheEntry, CacheLayer, GitFilesCache } from '../cache/index.js'
import type { TaskNode } from '../graph/index.js'
import { deriveStableKeys } from './stable-keys.js'
import type { HashCache } from './task-hash.js'

export interface ShortCircuitArgs {
  nodes: Map<string, TaskNode>
  cache: CacheLayer
  workspaceRoot: string
  workspaceFingerprint: string
  forwardArgs?: readonly string[] | undefined
  nestedDirsByProject: Map<string, string[]>
  gitFilesCache: GitFilesCache
  hashCache: HashCache
  /** Cap on concurrent probes — the run's concurrency. */
  concurrency: number
}

/** Per-task result of the up-front probe. `hit` null = a confirmed
 *  stable miss (skips the lazy probe in execute, goes to the run path).
 *  `hash` is the up-front-derived stable key (reused so a restore-tier
 *  task that runs before its deps doesn't recompute against an
 *  incomplete upstream). */
export interface ProbedEntry {
  hash: string
  hit: CacheEntry | null
}

export interface ShortCircuit {
  /**
   * Every stable, cacheable, local-read task → its up-front probe.
   * Threaded into executeCachedTask so it reuses the probe (no second
   * cache.get). Covers hits AND stable misses.
   */
  preProbed: Map<string, ProbedEntry>
  /**
   * Task ids that are confirmed stable LOCAL hits — the restore-tier.
   * The scheduler makes these ready immediately (dep-independent) and
   * LOW priority (backfill only). A subset of `preProbed` keys (those
   * with a non-null hit, minus the workspace-outputs exclusion).
   */
  restoreTier: Set<string>
}

const EMPTY: ShortCircuit = { preProbed: new Map(), restoreTier: new Set() }

/**
 * Classify the graph's stable tasks: derive keys + probe local ONCE,
 * returning the `preProbed` map (probe reuse) and the `restoreTier` set
 * (confirmed hits the scheduler may run ahead of their deps).
 *
 * Never throws — any error in derivation / probing degrades to "no
 * short-circuit" (an empty result), so every task falls back to the
 * normal lazy-probe schedule, identical to today.
 */
export async function startLocalShortCircuit(args: ShortCircuitArgs): Promise<ShortCircuit> {
  let stableKeys
  try {
    stableKeys = await deriveStableKeys(args)
  } catch {
    return EMPTY
  }
  const candidates = stableKeys.filter(({ node }) => node.config.cache !== undefined)
  if (candidates.length === 0) return EMPTY

  // Belt-and-suspenders for the boundary-ignoring escape hatch: a
  // root-anchored output can land anywhere, so if ANY task declares
  // workspace outputs a task could in principle write where a
  // restore-tier task restores. Disable the RESTORE tier graph-wide —
  // workspace outputs are rare bad-practice. (Probe reuse still applies,
  // so there's no double work; those tasks just stay dep-gated.)
  let anyWorkspaceOutputs = false
  for (const node of args.nodes.values()) {
    if ((node.config.cache?.outputs.workspaceFiles?.length ?? 0) > 0) {
      anyWorkspaceOutputs = true
      break
    }
  }

  const preProbed = new Map<string, ProbedEntry>()
  const restoreTier = new Set<string>()

  // Bounded pool over the stable candidates: probe local ONCE each. A
  // confirmed hit becomes restore-tier (unless workspace outputs disable
  // it); a miss stays exec-tier with a known-miss reuse entry. The pool
  // keeps the up-front pass from being a serial pre-phase on a wide warm
  // graph — the probes parallelize at the run's concurrency.
  // A layer with a batched `get` answers every probe in a couple of
  // queries; the pool below is for layers without one.
  if (args.cache.getMany !== undefined) {
    try {
      const hits = await args.cache.getMany(candidates.map((c) => c.hash))
      for (const { hash, node } of candidates) {
        const hit = hits.get(hash) ?? null
        preProbed.set(node.id, { hash, hit })
        if (hit !== null && !anyWorkspaceOutputs) restoreTier.add(node.id)
      }
      return { preProbed, restoreTier }
    } catch {
      // Fall through to the per-hash pool, which isolates a failing probe
      // to its own task.
    }
  }
  let next = 0
  const workers = Math.max(1, Math.min(args.concurrency, candidates.length))
  const pump = async (): Promise<void> => {
    while (next < candidates.length) {
      const { hash, node } = candidates[next++]!
      try {
        const command = node.config.exec?.command ?? ''
        const hit = await args.cache.get(hash, { taskId: node.id, command })
        preProbed.set(node.id, { hash, hit })
        if (hit !== null && !anyWorkspaceOutputs) restoreTier.add(node.id)
      } catch {
        // Leave this task out of preProbed → it probes lazily in
        // execute(), exactly as today.
      }
    }
  }
  await Promise.all(Array.from({ length: workers }, () => pump()))

  return { preProbed, restoreTier }
}
