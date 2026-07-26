// Planning: walk the task graph, compute every task's cache key, and
// probe the cache to predict what would happen if `vx run` actually
// ran. Used by `--dry-run` (preview output) and `--graph` (DOT export).
//
// No TASK execution happens: no task spawn, no cleanOutputs, no
// restoreOutputs. Cache probing uses the byte-free `cache.has()`
// existence probe (a remote layer answers with an HTTP HEAD — no
// artifact download, no local ingest), so the plan is read-only — with
// one deliberate exception: `cache.inputs.runtime` / `workspaceRuntime`
// probe commands DO run, because predicting a task's key requires
// resolving them (same as a real run). Keep runtime inputs
// side-effect-free pure probes.

import type { CacheLayer, CachePolicy, GitFilesCache } from '../cache/index.js'
import { FULL_CACHE_POLICY } from '../cache/index.js'
import { isGroupTask, runGraph, type TaskNode, type TaskOutcome } from '../graph/index.js'
import type { HistoryProvider } from './history.js'
import { computeGroupHash, computeTaskHash } from './task-hash.js'

export type CacheStatus =
  | 'hit-local' // entry exists in local cache
  | 'hit-remote' // entry exists in the remote layer (would be fetched)
  | 'miss' // caching enabled but no entry — would execute
  | 'no-cache' // task opts out of caching (no `cache` block) or --no-cache
  | 'group' // no `exec`; just an aggregator

export interface PlannedTask {
  node: TaskNode
  hash: string
  cacheStatus: CacheStatus
  /** Sorted task ids this task depends on (same as TaskNode.deps). */
  deps: readonly string[]
  /**
   * The task's typical executed duration (wall-clock p50 over its recent
   * non-hit runs in the local cache.db), when history exists. Attached to
   * every real task so a would-run task can show what it usually costs.
   */
  p50Ms?: number
}

/**
 * Time prediction over the plan: what would this run cost? Derived purely
 * from recorded history (each task's p50) — cache hits and groups cost 0
 * (a restore is a tar extract, near-instant next to execution).
 */
export interface PlanPrediction {
  /** Predicted wall-clock: the longest dependency chain of would-run cost. */
  wallMs: number
  /** Total predicted execution across would-run tasks (the CPU-time story). */
  workMs: number
  /** Would-run tasks with NO history — their cost is unknown and counted as
   *  0, so wallMs/workMs are lower bounds when this is > 0. */
  unknownCount: number
}

export interface RunPlan {
  tasks: PlannedTask[]
  /** Present when a history provider was available and usable. */
  predicted?: PlanPrediction
  /**
   * Requested task specs that matched no project. Non-empty means the
   * plan was abandoned: planning what WOULD run is meaningless when the
   * equivalent `vx run` would refuse to start.
   */
  unresolvedTasks?: readonly string[]
}

export interface PlanArgs {
  nodes: Map<string, TaskNode>
  workspaceRoot: string
  workspaceFingerprint: string
  cache: CacheLayer
  cachePolicy?: CachePolicy
  forwardArgs?: readonly string[] | undefined
  nestedDirsByProject: Map<string, string[]>
  gitFilesCache?: GitFilesCache
  hashCache?: import('./task-hash.js').HashCache
  /** When provided, per-task p50s are attached and `RunPlan.predicted` is
   *  computed. Failing open: a history error yields a plan without them. */
  history?: HistoryProvider
}

/**
 * Walk the task graph in topological order and produce a `RunPlan`.
 * We piggyback on the existing `runGraph` scheduler with a planning
 * `execute` closure — gets us topo ordering + upstream propagation
 * for free. Concurrency is capped at 1 because planning is fast and
 * sequential is easier to reason about.
 *
 * For each node we compute the cache key (same key the real run
 * would) and probe `cache.has(hash)` to decide hit vs miss. The probe
 * is a pure existence check — no artifact bytes move, no accessed_at
 * bump, no remote download/ingest.
 */
export async function plan(args: PlanArgs): Promise<RunPlan> {
  const cacheStatusById = new Map<string, CacheStatus>()

  const outcomes = await runGraph({
    nodes: args.nodes,
    concurrency: 1,
    execute: async (node, upstream) => {
      if (isGroupTask(node)) {
        cacheStatusById.set(node.id, 'group')
        return planOutcome(node, computeGroupHash(upstream))
      }

      const hash = await computeTaskHash({
        node,
        upstream,
        workspaceRoot: args.workspaceRoot,
        workspaceFingerprint: args.workspaceFingerprint,
        cache: args.cache,
        forwardArgs: args.forwardArgs,
        nestedProjectDirs: args.nestedDirsByProject.get(node.projectName) ?? [],
        ...(args.gitFilesCache !== undefined ? { gitFilesCache: args.gitFilesCache } : {}),
        ...(args.hashCache !== undefined ? { hashCache: args.hashCache } : {}),
      })

      // Prediction keys off READS: a no-read policy (--no-cache /
      // --force / --cache=local:,remote:) would re-execute every task,
      // so we predict misses for it. The probe below routes through the
      // policy-aware cache layer, which itself respects local/remote
      // read gating.
      const policy = args.cachePolicy ?? FULL_CACHE_POLICY
      const cacheEnabled =
        node.config.cache !== undefined && (policy.localRead || policy.remoteRead)
      let status: CacheStatus
      if (!cacheEnabled) {
        status = 'no-cache'
      } else {
        const where = await args.cache.has(hash)
        status = where === null ? 'miss' : where === 'remote' ? 'hit-remote' : 'hit-local'
      }
      cacheStatusById.set(node.id, status)
      return planOutcome(node, hash)
    },
  })

  const tasks: PlannedTask[] = []
  for (const id of args.nodes.keys()) {
    const o = outcomes.get(id)
    const node = args.nodes.get(id)
    if (!o || !node) continue
    tasks.push({
      node,
      hash: o.hash ?? '',
      cacheStatus: cacheStatusById.get(id) ?? 'no-cache',
      deps: node.deps,
    })
  }

  if (args.history !== undefined) {
    try {
      const realIds = tasks.filter((t) => t.cacheStatus !== 'group').map((t) => t.node.id)
      const table = await args.history.loadFor(realIds)
      for (const t of tasks) {
        const p50 = table.get(t.node.id)?.p50DurationMs
        if (p50 !== undefined) t.p50Ms = p50
      }
      return { tasks, predicted: predictPlan(tasks) }
    } catch {
      // Failing open: prediction is a nicety — a broken history read must
      // never break `--dry`.
    }
  }
  return { tasks }
}

/** A task the plan expects to EXECUTE (a no-cache task executes every run). */
function wouldRun(t: PlannedTask): boolean {
  return t.cacheStatus === 'miss' || t.cacheStatus === 'no-cache'
}

/**
 * Longest dependency chain of predicted cost, via one pass over a Kahn
 * topological order — no recursion, so a pathologically deep chain can't
 * overflow the stack. Hits + groups cost 0; a would-run task with no
 * history also costs 0 (counted in `unknownCount`, making the totals
 * honest lower bounds).
 */
function predictPlan(tasks: PlannedTask[]): PlanPrediction {
  const cost = (t: PlannedTask): number => (wouldRun(t) ? (t.p50Ms ?? 0) : 0)
  const byId = new Map(tasks.map((t) => [t.node.id, t]))
  const dependents = new Map<string, string[]>()
  const indeg = new Map<string, number>()
  for (const t of tasks) {
    const deps = t.deps.filter((d) => byId.has(d))
    indeg.set(t.node.id, deps.length)
    for (const d of deps) {
      const list = dependents.get(d)
      if (list) list.push(t.node.id)
      else dependents.set(d, [t.node.id])
    }
  }
  const dist = new Map<string, number>()
  const queue: string[] = []
  for (const [id, n] of indeg) if (n === 0) queue.push(id)
  let head = 0
  let wallMs = 0
  while (head < queue.length) {
    const id = queue[head++]!
    const t = byId.get(id)!
    let best = 0
    for (const d of t.deps) {
      const v = dist.get(d)
      if (v !== undefined && v > best) best = v
    }
    const v = best + cost(t)
    dist.set(id, v)
    if (v > wallMs) wallMs = v
    for (const dep of dependents.get(id) ?? []) {
      const n = indeg.get(dep)! - 1
      indeg.set(dep, n)
      if (n === 0) queue.push(dep)
    }
  }
  let workMs = 0
  let unknownCount = 0
  for (const t of tasks) {
    if (!wouldRun(t)) continue
    if (t.p50Ms === undefined) unknownCount++
    else workMs += t.p50Ms
  }
  return { wallMs, workMs, unknownCount }
}

function planOutcome(node: TaskNode, hash: string): TaskOutcome {
  return {
    node,
    status: 'success',
    exitCode: 0,
    durationMs: 0,
    hash,
  }
}
