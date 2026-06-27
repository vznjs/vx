// Remote-cache prefetch (remote-only). When a run is backed by a
// LayeredCache, the network latency of every remote cache GET would
// otherwise sit on the critical path of the task that needs it. This
// module derives every cacheable task's pure-input key UP FRONT
// (reusing the run's hashCache memo, so execute-task's later
// computeTaskHash for the same task hits the memo — no double hashing)
// and fires the remote GETs concurrently, in the background, before
// execution starts. LayeredCache.prefetch ingests each hit into the
// LOCAL cache and de-dups against the lazy read-through, so when
// execute-task calls cache.get it transparently awaits the already
// in-flight (resolved-or-pending) remote promise — at most ONE remote
// GET per key.
//
// HARD SCOPE: this runs ONLY when a remote layer is configured. It
// NEVER touches the local cache (no local get / no isOutputsCurrent /
// no stat pass) — it derives keys and probes REMOTE only. Local-only
// runs are byte-identical to before; the caller gates on `cache
// instanceof LayeredCache`.

import { isGroupTask, type TaskNode, type TaskOutcome } from '../graph/index.js'
import type { GitFilesCache, LayeredCache } from '../cache/index.js'
import { computeGroupHash, computeTaskHash, type HashCache } from './task-hash.js'

export interface PrefetchArgs {
  nodes: Map<string, TaskNode>
  cache: LayeredCache
  workspaceRoot: string
  workspaceFingerprint: string
  forwardArgs?: readonly string[] | undefined
  nestedDirsByProject: Map<string, string[]>
  gitFilesCache: GitFilesCache
  hashCache: HashCache
  /** Cap on concurrent in-flight prefetches — the run's concurrency. */
  concurrency: number
  /** When false (remote reads disabled), no prefetch fires. */
  remoteRead: boolean
}

/**
 * Fire remote prefetches for every STABLE cached task in the graph.
 * Fire-and-forget from the caller's perspective: this kicks off an
 * async derivation + bounded prefetch pool and returns immediately so
 * execution starts concurrently. A remote-read-off policy short-circuits.
 *
 * Stability gate: a task's key is "stable" only if its inputs can't be
 * altered by an upstream task's outputs (a `cache.inputs.files` glob
 * that could match a sibling's declared output has a PRELIMINARY key
 * until that upstream runs — prefetching it would target the wrong
 * artifact). Unstable tasks fall back to lazy read-through in
 * execute-task, which is always correct. The check is conservative:
 * when unsure, treat as unstable and skip.
 */
export function startRemotePrefetch(args: PrefetchArgs): Promise<void> {
  if (!args.remoteRead) return Promise.resolve()
  // Detached from EXECUTION: the caller does NOT await this before
  // scheduling, so prefetch network latency overlaps the run. But the
  // caller DOES await the returned handle before closing the cache, so
  // a still-in-flight prefetch can never ingest into a closed DB. Errors
  // degrade inside LayeredCache.prefetch; the catch keeps the handle
  // from ever rejecting.
  return runPrefetch(args).catch(() => {})
}

async function runPrefetch(args: PrefetchArgs): Promise<void> {
  const stableKeys = await deriveStableKeys(args)
  if (stableKeys.length === 0) return

  // Bounded worker pool over the stable keys. Each prefetch is
  // self-contained (LayeredCache owns the in-flight map + ingest); we
  // cap concurrency so a 1000-task run doesn't open 1000 sockets at
  // once. The pumps race alongside execution.
  let next = 0
  const workers = Math.max(1, Math.min(args.concurrency, stableKeys.length))
  const pump = async (): Promise<void> => {
    while (next < stableKeys.length) {
      const { hash, node } = stableKeys[next++]!
      await args.cache
        .prefetch(hash, { taskId: node.id, command: node.config.exec?.command ?? '' })
        .catch(() => false)
    }
  }
  await Promise.all(Array.from({ length: workers }, () => pump()))
}

interface StableKey {
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
async function deriveStableKeys(args: PrefetchArgs): Promise<StableKey[]> {
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
function synthUpstream(
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
function dependsOnSiblingOutputs(node: TaskNode, nodes: Map<string, TaskNode>): boolean {
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

function topoOrder(nodes: Map<string, TaskNode>): string[] {
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
  const queue: string[] = []
  for (const [id, deg] of indegree) if (deg === 0) queue.push(id)
  const out: string[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    out.push(id)
    for (const d of dependents.get(id) ?? []) {
      const rem = (indegree.get(d) ?? 0) - 1
      indegree.set(d, rem)
      if (rem === 0) queue.push(d)
    }
  }
  return out
}
