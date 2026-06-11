// Planning: walk the task graph, compute every task's cache key, and
// probe the cache to predict what would happen if `vx run` actually
// ran. Used by `--dry-run` (preview output) and `--graph` (DOT export).
//
// No execution happens: no spawn, no cleanOutputs, no restoreOutputs.
// The plan is read-only.

import type { CacheLayer } from '../cache/index.js'
import { isGroupTask, runGraph, type TaskNode, type TaskOutcome } from '../graph/index.js'
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
}

export interface RunPlan {
  tasks: PlannedTask[]
}

export interface PlanArgs {
  nodes: Map<string, TaskNode>
  workspaceRoot: string
  workspaceFingerprint: string
  cache: CacheLayer
  noCache: boolean
  forwardArgs?: readonly string[] | undefined
  nestedDirsByProject: Map<string, string[]>
  gitFilesCache?: Map<string, readonly string[]>
  hashCache?: import('./task-hash.js').HashCache
}

/**
 * Walk the task graph in topological order and produce a `RunPlan`.
 * We piggyback on the existing `runGraph` scheduler with a planning
 * `execute` closure — gets us topo ordering + upstream propagation
 * for free. Concurrency is capped at 1 because planning is fast and
 * sequential is easier to reason about.
 *
 * For each node we compute the cache key (same key the real run
 * would) and probe `cache.get(hash)` to decide hit vs miss. The probe
 * is read-only — it bumps the `accessed_at` column on the SQLite row
 * because that's `cache.get`'s contract, but otherwise side-effect free.
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

      const cacheEnabled = node.config.cache !== undefined && !args.noCache
      let status: CacheStatus
      if (!cacheEnabled) {
        status = 'no-cache'
      } else {
        const hit = await args.cache.get(hash, {
          taskId: node.id,
          command: node.config.exec?.command ?? '',
        })
        status = hit ? (hit.source === 'remote' ? 'hit-remote' : 'hit-local') : 'miss'
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
  return { tasks }
}

function planOutcome(node: TaskNode, hash: string): TaskOutcome {
  return { node, status: 'success', exitCode: 0, durationMs: 0, hash }
}
