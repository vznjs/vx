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
//   - A task that declares `cache.outputs.workspaceFiles` (the
//     boundary-ignoring escape hatch) can write where a restore touches,
//     so every task whose project directory a workspace-output glob's
//     static prefix REACHES stays out of the restore tier, and so does
//     every transitive dependant of one (its up-front key folds a key
//     that is preliminary). A glob with no literal prefix reaches every
//     project, which is the old graph-wide rule. Excluded tasks still get
//     an exec-tier probe reuse entry so there's no double work.

import { normalizeGlob, relPosix, span, staticPrefix } from '../util/index.js'
import type { CacheEntry, CacheLayer, GitFilesCache } from '../cache/index.js'
import type { TaskNode } from '../graph/index.js'
import { deriveStableKeys, workspaceInputsReach } from './stable-keys.js'
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
  const endKeys = span('stable keys')
  try {
    stableKeys = await deriveStableKeys(args)
  } catch {
    return EMPTY
  } finally {
    endKeys()
  }
  // Every stable key is a cacheable task's: deriveStableKeys pushes only
  // `cacheEnabled && !unstable` (item 640 deleted a second filter here and
  // nothing reddened).
  const candidates = stableKeys
  if (candidates.length === 0) return EMPTY

  const keptOut = restoreTierExclusions(args.nodes, args.workspaceRoot)

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
      const endProbe = span('probe')
      const hits = await args.cache.getMany(candidates.map((c) => c.hash))
      endProbe()
      for (const { hash, node } of candidates) {
        const hit = hits.get(hash) ?? null
        preProbed.set(node.id, { hash, hit })
        if (hit !== null && !keptOut.has(node.id)) restoreTier.add(node.id)
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
        if (hit !== null && !keptOut.has(node.id)) restoreTier.add(node.id)
      } catch {
        // Leave this task out of preProbed → it probes lazily in
        // execute(), exactly as today.
      }
    }
  }
  await Promise.all(Array.from({ length: workers }, () => pump()))

  return { preProbed, restoreTier }
}

/**
 * The tasks a workspace-output declaration keeps out of the restore tier.
 *
 * A root-anchored output can land in any project's directory, edge or no
 * edge (`tests/local-shortcircuit.test.ts` § "a workspace-output writer"
 * rows, item 425), so the question is not who depends on the writer but
 * WHERE it can write: each declared glob's static prefix is tested for
 * reach against every project directory, and against every task's own
 * `workspaceFiles` inputs, with the ancestor-or-equal relation
 * `workspaceInputsReach` already uses. A prefix that is the root reaches
 * everything — the graph-wide rule this replaced (item 584). Exclusion then
 * follows the edges DOWN: a dependant's up-front key folds an excluded
 * task's key, which is preliminary, so it cannot restore early either.
 * Cost: one pass over the nodes, no filesystem.
 */
function restoreTierExclusions(nodes: Map<string, TaskNode>, workspaceRoot: string): Set<string> {
  const prefixes: string[] = []
  let everything = false
  for (const node of nodes.values()) {
    for (const raw of node.config.cache?.outputs.workspaceFiles ?? []) {
      // No negation to skip: the schema refuses '!' in output globs
      // (`validateWorkspaceGlobs`), so the `continue` that stood here
      // guarded a shape no config can carry (item 640).
      const glob = normalizeGlob(raw)
      const prefix = staticPrefix(glob)
      if (prefix === '.' || prefix === '' || prefix === '/') everything = true
      else prefixes.push(prefix.replace(/^\.\//, ''))
    }
  }
  const out = new Set<string>()
  if (everything) {
    for (const id of nodes.keys()) out.add(id)
    return out
  }
  if (prefixes.length === 0) return out
  const reaches = (dir: string): boolean =>
    dir === '' ||
    dir === '.' ||
    prefixes.some((p) => p === dir || p.startsWith(`${dir}/`) || dir.startsWith(`${p}/`))
  const dependants = new Map<string, string[]>()
  for (const node of nodes.values()) {
    const dir = relPosix(workspaceRoot, node.projectDir)
    const wsInputs = node.config.cache?.inputs?.workspaceFiles ?? []
    if (reaches(dir) || (wsInputs.length > 0 && workspaceInputsReach(wsInputs, prefixes))) {
      out.add(node.id)
    }
    for (const dep of node.deps) {
      const list = dependants.get(dep)
      if (list === undefined) dependants.set(dep, [node.id])
      else list.push(node.id)
    }
  }
  // Up the dependant edges on an explicit stack: a chain is as deep as the
  // graph, and a recursion per edge threw `RangeError` at the 50,000 the
  // builder takes (item 737).
  const stack = [...out]
  while (stack.length > 0) {
    for (const up of dependants.get(stack.pop()!) ?? []) {
      if (out.has(up)) continue
      out.add(up)
      stack.push(up)
    }
  }
  return out
}
