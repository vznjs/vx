// Planning: walk the task graph, compute every task's cache key, and
// probe the cache to predict what would happen if `vx run` actually
// ran. Used by `--dry`.
//
// No TASK execution happens: no task spawn, no cleanOutputs, no
// restoreOutputs. Cache probing uses the byte-free `cache.has()`
// existence probe (a remote layer answers it its own way — no
// artifact download, no local ingest), so the plan is read-only — with
// one deliberate exception: `inputs.runtime` / `workspaceRuntime`
// probe commands DO run, because predicting a task's key requires
// resolving them (same as a real run). Keep runtime inputs
// side-effect-free pure probes.

import type { CacheLayer, CachePolicy, GitFilesCache } from '../cache/index.js'
import { cachesNothing, FULL_CACHE_POLICY } from '../cache/index.js'
import { ranNoCache } from '../report/index.js'
import { idleServers, isGroupTask, runGraph, type TaskNode } from '../graph/index.js'
import type { AffectedReason } from './affected-tasks.js'
import type { HistoryProvider } from '../history/index.js'
import { hostPlatform } from '../exec/index.js'
import { computeGroupKey, computeTaskHash } from './task-hash.js'
import { dependedOn, keyedOutcome, keylessServer, keyUpstream } from './upstream.js'

export type CacheStatus =
  | 'hit-local' // entry exists in local cache
  | 'hit-remote' // entry exists in the remote layer (would be fetched)
  | 'miss' // caching enabled but no entry — would execute
  | 'no-cache' // task opts out of caching (no `cache` block) or --no-cache
  | 'group' // no `exec`; just an aggregator
  | 'not-started' // a server every dependant of which restores early: the run never spawns it
  | 'skipped' // `exec.platforms` leave this machine out, or a task it depends on is skipped

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
  /**
   * Name of the executor this task would be PLACED on. Attached only when
   * the workspace declares more than one executor — with a single one every
   * line would carry the same label and say nothing — except `'noop'`: a
   * remote-only task no remote executor takes, which the run skips. Absent for group tasks
   * and persistent tasks, which never reach an executor.
   */
  executor?: string
  /**
   * `'deferred'` when this task's outputs would stay in the remote store
   * (`--cache-download=none` / `toplevel`). Attached only when it is TRUE — an
   * eager task is the default and saying so on every line says nothing.
   */
  download?: 'deferred'
  /** A remote hit's stored size, when the remote said it: what restoring it downloads. */
  remoteBytes?: number
  /** Why `--affected` kept this requested task; absent without `--affected` and on a dependency it pulled in. */
  affected?: AffectedReason
  /** A `skipped` task's own platforms, and this machine's. */
  otherPlatform?: { readonly needs: readonly string[]; readonly host: string }
  /** A `skipped` task's root: the task off this machine's platform it depends on. */
  blockedBy?: string
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
  /** The would-run tasks with history along the chain `wallMs` measures,
   *  dependencies first; empty when nothing with history would run. */
  criticalPath: string[]
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
  /** What `vx run` appends to that refusal: the nearest declared names, or how to declare one. */
  unresolvedHint?: string
  /** Set when `--affected` left nothing to run: the line the run would print, and why. */
  noneAffected?: string
  /**
   * Producers `--cache-download` WANTED to defer but could not, mapped to why.
   * Without this the gate is invisible: a user asks for `--cache-download=none`,
   * gets no deferral, and has nothing to read. Empty/absent under
   * `--cache-download=all`, which defers nothing by definition.
   */
  downloadDowngrades?: ReadonlyArray<{ taskId: string; reason: string }>
}

export interface PlanArgs {
  nodes: Map<string, TaskNode>
  /** Per-task `--cache-download` decision, when the policy is not `all`. */
  downloadOf?: (id: string) => 'eager' | 'deferred' | 'never' | undefined
  /** See `RunPlan.downloadDowngrades`. */
  downloadDowngrades?: ReadonlyArray<{ taskId: string; reason: string }>
  workspaceRoot: string
  cache: CacheLayer
  cachePolicy?: CachePolicy
  forwardArgs?: readonly string[] | undefined
  nestedDirsByProject: Map<string, string[]>
  gitFilesCache?: GitFilesCache
  hashCache?: import('./task-hash.js').HashCache
  /** When provided, per-task p50s are attached and `RunPlan.predicted` is
   *  computed. Failing open: a history error yields a plan without them. */
  history?: HistoryProvider
  /** Placement lookup (`placement.ts`): >1 executor declared, or a `noop` task. */
  executorOf?: (id: string) => string | undefined
  /**
   * The tasks the run's short-circuit would restore ahead of their deps on
   * a hit (stable key, no workspace-output reach). A server whose every
   * dependant is one of those and a hit, local or remote, is never spawned:
   * the run holds it for the remote's answer (`held-servers.ts`).
   */
  restorable?: ReadonlySet<string>
  /** Tasks whose `exec.platforms` leave this machine out (`placement.ts`), each → its platforms. */
  otherPlatform?: ReadonlyMap<string, readonly string[]>
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
  const remoteBytesById = new Map<string, number>()
  // Keyed first, probed after: a remote that can batch (`hasMany`) is
  // asked once for every key, one that cannot is asked per key.
  const probed = new Map<string, string>()
  const depended = dependedOn(args.nodes.values())

  const outcomes = await runGraph({
    nodes: args.nodes,
    concurrency: 1,
    // A plan's keys and probes do not depend on the order it walks in, so
    // it ranks nothing: the default ranking's closure over every task was
    // ~30 ms of a 1,000-project `--dry`.
    strategy: 'ready-order',
    execute: async (node, live) => {
      const upstream = keyUpstream(node, live)
      const hashArgs = {
        node,
        upstream,
        workspaceRoot: args.workspaceRoot,
        cache: args.cache,
        forwardArgs: args.forwardArgs,
        nestedProjectDirs: args.nestedDirsByProject.get(node.projectName) ?? [],
        ...(args.gitFilesCache !== undefined ? { gitFilesCache: args.gitFilesCache } : {}),
        ...(args.hashCache !== undefined ? { hashCache: args.hashCache } : {}),
      }
      if (isGroupTask(node)) {
        cacheStatusById.set(node.id, 'group')
        return keyedOutcome(node, await computeGroupKey(hashArgs))
      }

      const hash = keylessServer(node, depended) ? undefined : await computeTaskHash(hashArgs)

      // Prediction keys off READS: a no-read policy re-executes every task,
      // so nothing is probed. Whether that run is a miss or no cache at all
      // is the WRITE axes': `--force` and `--cache-policy=local:w` save what they
      // run, and the plan called them `no-cache`, the label a task with no
      // `cache` block gets (item 991). The probe below routes through the
      // policy-aware cache layer, which itself respects read gating.
      const policy = args.cachePolicy ?? FULL_CACHE_POLICY
      const reads = policy.localRead || policy.remoteRead
      let status: CacheStatus
      if (hash === undefined || ranNoCache({ node, cacheOff: cachesNothing(policy) })) {
        status = 'no-cache'
      } else if (!reads) {
        status = 'miss'
      } else {
        probed.set(node.id, hash)
        return keyedOutcome(node, hash)
      }
      cacheStatusById.set(node.id, status)
      return keyedOutcome(node, hash)
    },
  })
  if (probed.size > 0) {
    const infos = await args.cache.remoteHasMany?.([...new Set(probed.values())])
    for (const [id, hash] of probed) {
      const where = await args.cache.has(hash)
      cacheStatusById.set(
        id,
        where === null ? 'miss' : where === 'remote' ? 'hit-remote' : 'hit-local',
      )
      const size = where === 'remote' ? infos?.get(hash)?.size : undefined
      if (size !== undefined) remoteBytesById.set(id, size)
    }
  }

  if (args.restorable !== undefined) {
    const restoreTier = new Set(
      [...args.restorable].filter((id) => {
        const status = cacheStatusById.get(id)
        return status === 'hit-local' || status === 'hit-remote'
      }),
    )
    const dependents = new Map<string, string[]>()
    for (const node of args.nodes.values())
      for (const dep of node.deps) dependents.set(dep, [...(dependents.get(dep) ?? []), node.id])
    for (const id of idleServers(args.nodes, dependents, restoreTier))
      cacheStatusById.set(id, 'not-started')
  }

  const skips = platformSkips(args.nodes, args.otherPlatform)
  const tasks: PlannedTask[] = []
  for (const id of args.nodes.keys()) {
    const o = outcomes.get(id)
    const node = args.nodes.get(id)
    if (!o || !node) continue
    const executor = args.executorOf?.(id)
    tasks.push({
      node,
      hash: o.hash ?? '',
      cacheStatus: skips.has(id) ? 'skipped' : (cacheStatusById.get(id) ?? 'no-cache'),
      deps: node.deps,
      ...(executor !== undefined ? { executor } : {}),
      ...(args.downloadOf?.(id) === 'deferred' ? { download: 'deferred' as const } : {}),
      ...(remoteBytesById.has(id) ? { remoteBytes: remoteBytesById.get(id)! } : {}),
      ...skips.get(id),
    })
  }

  if (args.history !== undefined) {
    try {
      const realIds = tasks.filter((t) => t.cacheStatus !== 'group').map((t) => t.node.id)
      const p50s =
        args.history.p50sFor !== undefined
          ? await args.history.p50sFor(realIds)
          : new Map(
              [...(await args.history.loadFor(realIds))].flatMap(([id, h]) =>
                h.p50DurationMs === undefined ? [] : [[id, h.p50DurationMs] as const],
              ),
            )
      for (const t of tasks) {
        const p50 = p50s.get(t.node.id)
        if (p50 !== undefined) t.p50Ms = p50
      }
      return { tasks, predicted: predictPlan(tasks), ...downgradeField(args) }
    } catch {
      // Failing open: prediction is a nicety — a broken history read must
      // never break `--dry`.
    }
  }
  return { tasks, ...downgradeField(args) }
}

/**
 * What the run skips here, as its scheduler does: a task its `exec.platforms`
 * leave this machine out of, and every task that depends on one, named by
 * the root of the block. In every `--continue` mode: a skip is no failure.
 */
function platformSkips(
  nodes: ReadonlyMap<string, TaskNode>,
  otherPlatform: ReadonlyMap<string, readonly string[]> | undefined,
): Map<string, Pick<PlannedTask, 'otherPlatform' | 'blockedBy'>> {
  const skips = new Map<string, Pick<PlannedTask, 'otherPlatform' | 'blockedBy'>>()
  if (otherPlatform === undefined || otherPlatform.size === 0) return skips
  const host = hostPlatform()
  const settled = new Set<string>()
  const visit = (id: string): void => {
    const stack = [id]
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!
      if (settled.has(top)) {
        stack.pop()
        continue
      }
      const node = nodes.get(top)!
      const open = node.deps.filter((d) => !settled.has(d))
      if (open.length > 0) {
        stack.push(...open)
        continue
      }
      stack.pop()
      settled.add(top)
      const needs = otherPlatform.get(top)
      if (needs !== undefined) {
        skips.set(top, { otherPlatform: { needs, host } })
        continue
      }
      const via = node.deps.find((d) => skips.has(d))
      if (via !== undefined) skips.set(top, { blockedBy: skips.get(via)!.blockedBy ?? via })
    }
  }
  for (const id of nodes.keys()) visit(id)
  return skips
}

/** Carried onto the plan only when the gate actually refused something. */
function downgradeField(args: PlanArgs): {
  downloadDowngrades?: ReadonlyArray<{ taskId: string; reason: string }>
} {
  const d = args.downloadDowngrades
  return d !== undefined && d.length > 0 ? { downloadDowngrades: d } : {}
}

/** A task the plan expects to EXECUTE (a no-cache task executes every run). */
function wouldRun(t: PlannedTask): boolean {
  // A `noop` task succeeds without running (execute-task.ts), whatever its key.
  if (t.executor === 'noop') return false
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
  // Every dep is a planned task: the task graph refuses a dep it does not
  // hold, and every task of it runs in plan().
  for (const t of tasks) {
    indeg.set(t.node.id, t.deps.length)
    for (const d of t.deps) {
      const list = dependents.get(d)
      if (list) list.push(t.node.id)
      else dependents.set(d, [t.node.id])
    }
  }
  const dist = new Map<string, number>()
  const queue: string[] = []
  for (const [id, n] of indeg) if (n === 0) queue.push(id)
  const via = new Map<string, string>()
  let head = 0
  let wallMs = 0
  let end: string | undefined
  while (head < queue.length) {
    const id = queue[head++]!
    const t = byId.get(id)!
    let best = 0
    for (const d of t.deps) {
      const v = dist.get(d)
      if (v !== undefined && v > best) {
        best = v
        via.set(id, d)
      }
    }
    const v = best + cost(t)
    dist.set(id, v)
    if (v > wallMs) {
      wallMs = v
      end = id
    }
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
  const criticalPath: string[] = []
  for (let id = end; id !== undefined; id = via.get(id))
    if (cost(byId.get(id)!) > 0) criticalPath.push(id)
  return { wallMs, workMs, unknownCount, criticalPath: criticalPath.reverse() }
}
