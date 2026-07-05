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
  const stableKeys: StableKey[] = []

  for (const id of order) {
    const node = args.nodes.get(id)!
    const upstream = synthUpstream(node, args.nodes, keyById)

    if (isGroupTask(node)) {
      // Groups have no exec/cache; they only fold upstream keys so
      // dependents that filter inputs.tasks through the group still
      // cascade. They inherit instability from any unstable member.
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
      node.deps.some((d) => unstableById.has(d)) || dependsOnSiblingOutputs(node, args.nodes)
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
 * Conservative stability check: does any UPSTREAM task whose outputs
 * could land where this task reads its inputs make this task's key
 * preliminary?
 *
 *   - Same-project upstream with declared `cache.outputs.files`: its
 *     outputs land inside this project's dir, which this task's input
 *     globs (default `**` / anything project-relative) can match —
 *     the upstream must run before this key is final. Project
 *     boundaries are hard, so only SAME-project outputs can reach a
 *     project-relative input.
 *   - Any upstream with declared `cache.outputs.workspaceFiles` when
 *     this task reads `cache.inputs.workspaceFiles`: root-anchored
 *     outputs ignore boundaries and can land anywhere the root-anchored
 *     inputs read.
 *
 * Either case → unstable → skip prefetch (lazy read-through in
 * execute-task stays correct). When in doubt, unstable.
 */
export function dependsOnSiblingOutputs(node: TaskNode, nodes: Map<string, TaskNode>): boolean {
  const inputs = node.config.cache?.inputs
  // A cache-disabled task has no key to prefetch anyway; treat as
  // unstable-irrelevant (caller filters on cacheEnabled).
  if (node.config.cache === undefined) return false
  const readsWorkspaceFiles = (inputs?.workspaceFiles?.length ?? 0) > 0

  for (const dep of node.deps) {
    const depNode = nodes.get(dep)
    if (!depNode) continue
    const depOutputs = depNode.config.cache?.outputs
    if (depOutputs === undefined) continue
    const sameProject = depNode.projectName === node.projectName
    if (sameProject && (depOutputs.files?.length ?? 0) > 0) return true
    if (readsWorkspaceFiles && (depOutputs.workspaceFiles?.length ?? 0) > 0) return true
  }
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
