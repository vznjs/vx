// Stable-key derivation, shared by remote-prefetch and the local
// short-circuit. Both need to identify the tasks whose cache key is
// provably independent of any upstream task's OUTPUTS — those are the
// only tasks safe to probe / restore ahead of the schedule. Factored
// out so the two callers can never drift on the stability gate.
//
// A task's key is "stable" only if its inputs can't be altered by an
// upstream's outputs (a `cache.inputs.files` glob that could match a
// sibling's declared output has a PRELIMINARY key until that upstream
// runs — probing it would target the wrong artifact). Unstable tasks
// fall back to lazy read-through in execute-task, which is always
// correct. The check is conservative: when unsure, treat as unstable.

import { isGroupTask, type TaskNode, type TaskOutcome } from '../graph/index.js'
import type { CacheLayer, GitFilesCache } from '../cache/index.js'
import { computeGroupHash, computeTaskHash, type HashCache } from './task-hash.js'

export interface DeriveStableKeysArgs {
  nodes: Map<string, TaskNode>
  cache: CacheLayer
  workspaceRoot: string
  workspaceFingerprint: string
  forwardArgs?: readonly string[] | undefined
  nestedDirsByProject: Map<string, string[]>
  gitFilesCache: GitFilesCache
  hashCache: HashCache
}

export interface StableKey {
  hash: string
  node: TaskNode
}

/**
 * Walk the graph in topological order, deriving every task's key the
 * SAME way execute-task does (folding upstream keys via the synthetic
 * {node, hash} outcomes filterUpstreamHashes / computeGroupHash read)
 * and classifying each as stable / unstable. Returns the stable,
 * cache-enabled, non-group tasks paired with their keys.
 *
 * Reuses the run's `hashCache`, so execute-task's later computeTaskHash
 * for the same node hits the memo (package.json bytes + task config) —
 * the key bytes are derived here, the heavy per-project hashing is
 * shared. No cache layer is touched: keys only.
 */
export async function deriveStableKeys(args: DeriveStableKeysArgs): Promise<StableKey[]> {
  const order = topoOrder(args.nodes)
  const keyById = new Map<string, string>()
  const unstableById = new Set<string>()
  // Transitive-upstream output producers, accumulated in topo order — the
  // inputs to the stability gate. A task's key is preliminary if an upstream
  // writes where its inputs read, and that reach is TRANSITIVE: a producer
  // reached through a no-output intermediate still poisons the key, so each
  // dep's accumulated producers fold forward.
  //   - outputProjects: the project names of every upstream task declaring
  //     cache.outputs.files (project-relative outputs land in the producer's
  //     own dir).
  //   - wsOutputUpstream: any upstream declares cache.outputs.workspaceFiles
  //     (root-anchored, boundary-ignoring outputs).
  const outputProjectsById = new Map<string, ReadonlySet<string>>()
  const wsOutputUpstreamById = new Map<string, boolean>()
  const stableKeys: StableKey[] = []

  for (const id of order) {
    const node = args.nodes.get(id)!
    const upstream = synthUpstream(node, args.nodes, keyById)

    // Fold every dep's accumulated producers + the dep's own declared
    // outputs into this node's transitive-upstream producer sets.
    const outputProjects = new Set<string>()
    let wsOutputUpstream = false
    for (const dep of node.deps) {
      const depNode = args.nodes.get(dep)
      if (!depNode) continue
      for (const p of outputProjectsById.get(dep) ?? []) outputProjects.add(p)
      if (wsOutputUpstreamById.get(dep) === true) wsOutputUpstream = true
      const depOut = depNode.config.cache?.outputs
      if ((depOut?.files?.length ?? 0) > 0) outputProjects.add(depNode.projectName)
      if ((depOut?.workspaceFiles?.length ?? 0) > 0) wsOutputUpstream = true
    }
    outputProjectsById.set(id, outputProjects)
    wsOutputUpstreamById.set(id, wsOutputUpstream)

    if (isGroupTask(node)) {
      // Groups have no exec/cache; they only fold upstream keys so
      // dependents that filter inputs.tasks through the group still
      // cascade (and forward their producers, above). They inherit
      // instability from any unstable member.
      keyById.set(id, computeGroupHash(upstream))
      if (node.deps.some((d) => unstableById.has(d))) unstableById.add(id)
      continue
    }

    const hash = await computeTaskHash({
      node,
      upstream,
      workspaceRoot: args.workspaceRoot,
      workspaceFingerprint: args.workspaceFingerprint,
      cache: args.cache,
      forwardArgs: args.forwardArgs,
      nestedProjectDirs: args.nestedDirsByProject.get(node.projectName) ?? [],
      gitFilesCache: args.gitFilesCache,
      hashCache: args.hashCache,
    })
    keyById.set(id, hash)

    const unstable =
      node.deps.some((d) => unstableById.has(d)) ||
      dependsOnSiblingOutputs(node, outputProjects, wsOutputUpstream)
    if (unstable) unstableById.add(id)

    const cacheEnabled = node.config.cache !== undefined
    if (cacheEnabled && !unstable) stableKeys.push({ hash, node })
  }
  return stableKeys
}

/**
 * Synthetic upstream outcomes for key derivation. Only `node` + `hash`
 * are read by filterUpstreamHashes / computeGroupHash; the rest of
 * TaskOutcome is irrelevant here, so we cast a minimal shape.
 */
export function synthUpstream(
  node: TaskNode,
  nodes: Map<string, TaskNode>,
  keyById: Map<string, string>,
): TaskOutcome[] {
  const out: TaskOutcome[] = []
  for (const dep of node.deps) {
    const depNode = nodes.get(dep)
    if (!depNode) continue
    out.push({
      node: depNode,
      status: 'success',
      exitCode: 0,
      durationMs: 0,
      hash: keyById.get(dep),
    } as TaskOutcome)
  }
  return out
}

/**
 * Conservative stability check: does any TRANSITIVE-upstream task whose
 * outputs could land where this task reads its inputs make this task's
 * key preliminary? The producers are pre-folded by `deriveStableKeys`
 * (`upstreamOutputProjects` = projects declaring `cache.outputs.files`
 * upstream; `hasWsOutputUpstream` = any `cache.outputs.workspaceFiles`
 * upstream), so a producer reached through a no-output intermediate is
 * caught too.
 *
 *   - Project-relative inputs (default `**` / anything project-relative)
 *     read THIS project's dir, so a same-project upstream's
 *     `outputs.files` — direct or transitive — makes the key
 *     preliminary. Project boundaries are hard, so only SAME-project
 *     outputs can reach a project-relative input.
 *   - `cache.inputs.workspaceFiles` is boundary-free: it can read ANY
 *     project's dir (so any upstream `outputs.files`, in any project,
 *     matters) or a root-anchored location (so any upstream
 *     `outputs.workspaceFiles` matters). Either → preliminary key. This
 *     is the reach the earlier per-dep check missed — it only compared a
 *     dep's `outputs.workspaceFiles`, never a dep's `outputs.files`.
 *
 * Either case → unstable → skip prefetch AND probe reuse (execute-task
 * recomputes the key lazily once the upstream ran). When in doubt,
 * unstable.
 */
export function dependsOnSiblingOutputs(
  node: TaskNode,
  upstreamOutputProjects: ReadonlySet<string>,
  hasWsOutputUpstream: boolean,
): boolean {
  const cache = node.config.cache
  // A cache-disabled task has no key to prefetch anyway; treat as
  // unstable-irrelevant (caller filters on cacheEnabled).
  if (cache === undefined) return false
  if (upstreamOutputProjects.has(node.projectName)) return true
  // A root-anchored output is boundary-IGNORING by design, so it can land
  // inside THIS task's own project dir — where an ordinary project-relative
  // input reads it. Neither other clause sees that: `upstreamOutputProjects`
  // holds the PRODUCER's project, not this one, and the reader clause below
  // requires this task to read workspace-anchored inputs, which it need not.
  // That gap was a real stale hit (a producer writing `pkgs/app/gen/**` while
  // `app` read `gen/**` project-relative), so the mere presence of a
  // workspace-output producer upstream makes the key preliminary.
  if (hasWsOutputUpstream) return true
  const readsWorkspaceFiles = (cache.inputs?.workspaceFiles?.length ?? 0) > 0
  if (readsWorkspaceFiles && upstreamOutputProjects.size > 0) return true
  return false
}

export function topoOrder(nodes: Map<string, TaskNode>): string[] {
  const indegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const node of nodes.values()) {
    indegree.set(node.id, node.deps.length)
    for (const dep of node.deps) {
      const list = dependents.get(dep)
      if (list) list.push(node.id)
      else dependents.set(dep, [node.id])
    }
  }
  // Kahn's algorithm with a head pointer instead of `queue.shift()` — a shift
  // reindexes the whole array (O(N) each), making the walk O(N²) on a big
  // graph. `out` doubles as the queue (every dequeued id is already in topo
  // order); we only ever append and advance `head`. Same pattern as
  // computeReverseDepCount / package-graph.
  const out: string[] = []
  for (const [id, deg] of indegree) if (deg === 0) out.push(id)
  for (let head = 0; head < out.length; head++) {
    for (const d of dependents.get(out[head]!) ?? []) {
      const rem = (indegree.get(d) ?? 0) - 1
      indegree.set(d, rem)
      if (rem === 0) out.push(d)
    }
  }
  return out
}
