// The projects a task's cache key answers for: K(T) in
// docs/design/linked-sibling-reads-2026-09.md. A sandboxed task that
// declares `cache` is granted a sibling's `node_modules` link only when its
// key already moves with that sibling's files, and this is where "already"
// is decided — on the graph, before any hash exists, through the same
// selection the hash path applies (`selectFoldedDeps`).

import { isGroupTask, type TaskNode } from '../graph/index.js'
import { selectFoldedDeps, type FoldCandidate } from './upstream.js'

/**
 * A run's keyed-set lookup: for a task, the directories of every project
 * holding an exec task whose key the task's key folds, transitively. The
 * task itself is not counted.
 *
 * The fold relation is the hash path's, computed on the graph:
 *   - an exec task folds its dependencies as its own `cache.inputs.tasks`
 *     selects them (absent, or no `cache` at all, means all);
 *   - a group folds every dependency (`computeGroupHash`) and folds no
 *     files of its own;
 *   - a persistent task has no hash on the live path, so it is folded by
 *     no one and its own dependencies reach no key through it. (The local
 *     classify pass does give it one — stable-keys.ts — so a key there can
 *     move with more than this set names; never with less.)
 *
 * Every exec task reached contributes its project, cached or not: a key
 * folds the task's own project files, and a task with no `cache` declares
 * no `inputs.files`, so it folds every file of its project (inputs.ts's
 * `DEFAULT_FILE_GLOBS`). `tests/keyed-projects.test.ts` holds that to the
 * key itself.
 *
 * Lazy and memoized by task id: only a sandboxed task that executes asks,
 * so a run of hits walks nothing, and a shared subgraph is walked once.
 */
export function keyedProjects(
  nodes: ReadonlyMap<string, TaskNode>,
): (node: TaskNode) => ReadonlySet<string> {
  const below = new Map<string, ReadonlySet<string>>()
  const walk = (node: TaskNode): ReadonlySet<string> => {
    const memo = below.get(node.id)
    if (memo !== undefined) return memo
    const out = new Set<string>()
    for (const { node: dep } of folded(node, nodes)) {
      if (!isGroupTask(dep)) out.add(dep.projectDir)
      for (const dir of walk(dep)) out.add(dir)
    }
    below.set(node.id, out)
    return out
  }
  return walk
}

/** The dependencies `node`'s key folds, per the hash path's rules above. */
function folded(node: TaskNode, nodes: ReadonlyMap<string, TaskNode>): FoldCandidate[] {
  const candidates: FoldCandidate[] = []
  for (const id of node.deps) {
    const dep = nodes.get(id)!
    if (dep.config.exec?.persistent !== undefined) continue
    candidates.push({ node: dep, unit: foldUnit(dep) })
  }
  if (isGroupTask(node)) return candidates
  return selectFoldedDeps(candidates, node.config.cache?.inputs?.tasks, node.projectName, node.id)
}

/**
 * What stands in for a dependency's hash in the dedup: equal exactly when
 * the hashes are. An exec task's key folds its own id (`task:<id>`), so its
 * id is enough; a group's hash is a roll-up of its members' ids and hashes
 * with no id of its own, so two groups over the same members hash alike.
 */
function foldUnit(node: TaskNode): string {
  return isGroupTask(node) ? `group|${[...node.deps].sort().join('|')}` : `task|${node.id}`
}
