// `--exclude-dependencies` changes what RUNS, never what a key is (nx#35234).
// The graph module takes the dropped edges out of the schedule
// (`excludeDependencies`); this derives the key each dropped dependency
// would have, without running it, and hands it to the dependant as
// `excludedUpstream`, which every key site folds next to the live outcomes
// (`keyUpstream`). A dependant's key is then the one a full run derives.
//
// Folding the key makes the dependant's own entry say "built against that
// dependency at its current inputs", and nothing here proves the
// dependency's outputs on disk are the ones those inputs produce: it did
// not run. So a task whose key folds a dropped dependency, and everything
// built on it, runs and may hit but does not SAVE (`excludedTaint` seeds
// the run's taint): a save would file stale bytes under the key the next
// full run looks up.

import type { CacheLayer, GitFilesCache } from '../cache/index.js'
import { isGroupTask, type TaskNode, type TaskOutcome } from '../graph/index.js'
import { computeGroupHash, computeTaskHash, type HashCache } from './task-hash.js'
import { filterUpstreamHashes } from './upstream.js'

export interface KeyExcludedArgs {
  /** The scheduled graph, after `excludeDependencies`. */
  nodes: Map<string, TaskNode>
  keyOnly: ReadonlyMap<string, TaskNode>
  dropped: ReadonlyMap<string, readonly string[]>
  cache: CacheLayer
  workspaceRoot: string
  workspaceFingerprint: string
  forwardArgs?: readonly string[] | undefined
  nestedDirsByProject: ReadonlyMap<string, string[]>
  gitFilesCache: GitFilesCache
  hashCache: HashCache
}

/**
 * Set `excludedUpstream` on every scheduled task that lost an edge. Keys
 * are derived over the whole graph as it stands at the start of the run,
 * the way `deriveStableKeys` derives them: a dropped task's own
 * dependencies, scheduled or not, fold theirs.
 */
export async function keyExcludedDependencies(args: KeyExcludedArgs): Promise<void> {
  const nodeOf = (id: string): TaskNode => args.nodes.get(id) ?? args.keyOnly.get(id)!
  const fullDeps = (node: TaskNode): readonly string[] => [
    ...node.deps,
    ...(args.dropped.get(node.id) ?? []),
  ]
  // Each key's promise is made after its dependencies' promises, in a
  // post-order walk on an explicit stack, so nothing recurses once per edge:
  // a dropped chain is as deep as the graph, and the builder takes 50,000
  // (item 737). The keys still resolve concurrently.
  const keys = new Map<string, Promise<string | undefined>>()
  const outcomes = (ids: readonly string[]): Promise<TaskOutcome[]> =>
    Promise.all(ids.map(async (id) => synthetic(nodeOf(id), await keys.get(id)!)))
  const derive = async (node: TaskNode): Promise<string | undefined> => {
    const upstream = await outcomes(fullDeps(node))
    if (isGroupTask(node)) return computeGroupHash(upstream)
    // A persistent task has no key on the live path, so none here either.
    if (node.config.exec?.persistent !== undefined) return undefined
    return computeTaskHash({
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
  }
  const stack: Array<[id: string, depsMade: boolean]> = []
  for (const lost of args.dropped.values()) for (const id of lost) stack.push([id, false])
  while (stack.length > 0) {
    const [id, depsMade] = stack.pop()!
    if (keys.has(id)) continue
    const node = nodeOf(id)
    if (depsMade) {
      keys.set(id, derive(node))
      continue
    }
    stack.push([id, true])
    for (const dep of fullDeps(node)) if (!keys.has(dep)) stack.push([dep, false])
  }
  for (const [id, lost] of args.dropped) {
    args.nodes.get(id)!.excludedUpstream = await outcomes(lost)
  }
}

/**
 * The taint `--exclude-dependencies` seeds: every scheduled task whose key
 * folds a dropped dependency's key, and how many cacheable tasks the taint
 * reaches from there (the run's one line says so; a persistent task or one
 * with no `cache` saves nothing anyway, so it is not counted, though the
 * taint still passes through it).
 */
export function excludedTaint(nodes: ReadonlyMap<string, TaskNode>): {
  seeds: ReadonlySet<string>
  unsaved: number
} {
  const seeds = new Set<string>()
  for (const node of nodes.values()) if (foldsExcludedKey(node)) seeds.add(node.id)
  if (seeds.size === 0) return { seeds, unsaved: 0 }
  // One walk over the dependant edges; re-scanning every node until nothing
  // grew was a pass per hop, quadratic on a chain seeded at its bottom.
  const dependants = new Map<string, string[]>()
  for (const node of nodes.values()) {
    for (const dep of node.deps) {
      const list = dependants.get(dep)
      if (list === undefined) dependants.set(dep, [node.id])
      else list.push(node.id)
    }
  }
  const reached = new Set(seeds)
  const stack = [...seeds]
  while (stack.length > 0) {
    for (const up of dependants.get(stack.pop()!) ?? []) {
      if (reached.has(up)) continue
      reached.add(up)
      stack.push(up)
    }
  }
  let unsaved = 0
  for (const id of reached) {
    const cfg = nodes.get(id)!.config
    if (cfg.cache !== undefined && cfg.exec?.persistent === undefined) unsaved++
  }
  return { seeds, unsaved }
}

/**
 * Whether `node`'s key folds a dropped dependency's key: a group folds all
 * of its dependencies, an exec task what its `cache.inputs.tasks` selects.
 * A task with `tasks: []` folds none, so its entry claims nothing about a
 * dependency and it saves as usual.
 */
function foldsExcludedKey(node: TaskNode): boolean {
  const excluded = node.excludedUpstream
  if (excluded === undefined) return false
  if (isGroupTask(node)) return true
  return (
    filterUpstreamHashes(excluded, node.config.cache?.inputs?.tasks, node.projectName, node.id)
      .length > 0
  )
}

/** A dependency as a key reads it: only `node` and `hash` matter. */
function synthetic(node: TaskNode, hash: string | undefined): TaskOutcome {
  return {
    node,
    status: 'success',
    exitCode: 0,
    durationMs: 0,
    ...(hash !== undefined ? { hash } : {}),
  }
}
