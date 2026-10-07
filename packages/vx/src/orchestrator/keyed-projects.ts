// The projects a task's cache key answers for: K(T) in
// docs/design/linked-sibling-reads-2026-09.md. A sandboxed task that
// declares `cache` is granted a sibling's `node_modules` link only when its
// key already moves with that sibling's files, and this is where "already"
// is decided — on the graph, before any hash exists, through the same
// selection the hash path applies (`selectFoldedDeps`).

import { isGroupTask, type TaskNode } from '../graph/index.js'
import { keyedDeps, selectFoldedDeps, type FoldCandidate } from './upstream.js'

/**
 * A run's keyed-set lookup: for a task, the directories of every project
 * holding an exec task whose key the task's key folds, transitively. The
 * task itself is not counted.
 *
 * The fold relation is the hash path's, computed on the graph:
 *   - an exec task folds its dependencies as its own `cache.inputs.tasks`
 *     selects them (absent, or no `cache` at all, means all);
 *   - a group folds every dependency (`computeGroupKey`) and folds no
 *     files of its own, but for the default `build`, which folds every
 *     file of its project as a task does;
 *   - a persistent task is keyed as a task with no `cache` (A-17).
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
  keyOnly: ReadonlyMap<string, TaskNode> = new Map(),
): (node: TaskNode) => ReadonlySet<string> {
  const nodeOf = (id: string): TaskNode => nodes.get(id) ?? keyOnly.get(id)!
  const below = new Map<string, ReadonlySet<string>>()
  // Post-order on an explicit stack: a fold is as deep as the graph, and a
  // recursion per edge threw `RangeError` at the 50,000 the builder takes
  // (item 737). A frame's folded dependencies are listed when it is first
  // reached and combined once each has its set.
  return (root) => {
    const stack: Array<[node: TaskNode, deps: FoldCandidate[] | undefined]> = [[root, undefined]]
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!
      const [node, deps] = frame
      if (below.has(node.id)) {
        stack.pop()
        continue
      }
      if (deps === undefined) {
        frame[1] = foldedDeps(node, nodeOf)
        for (const { node: dep } of frame[1]) if (!below.has(dep.id)) stack.push([dep, undefined])
        continue
      }
      stack.pop()
      const out = new Set<string>()
      for (const { node: dep } of deps) {
        if (!isGroupTask(dep) || dep.config.cache !== undefined) out.add(dep.projectDir)
        for (const dir of below.get(dep.id)!) out.add(dir)
      }
      below.set(node.id, out)
    }
    return below.get(root.id)!
  }
}

/**
 * The dependencies `node`'s key folds, per the hash path's rules above, as
 * `keyUpstream` hands them to the key: the scheduled ones less the edges
 * `--exclude-dependencies` left for order alone, plus the dropped ones it
 * keys all the same (`excludedUpstream`), whose own dependencies the walk
 * reads from the run's `keyOnly` map. `node.deps` held the order-only
 * edges and lacked the dropped ones: the sandbox granted a sibling the key
 * does not answer for.
 */
export function foldedDeps(node: TaskNode, nodeOf: (id: string) => TaskNode): FoldCandidate[] {
  const candidates: FoldCandidate[] = []
  for (const id of keyedDeps(node)) {
    const dep = nodeOf(id)
    candidates.push({ node: dep, unit: foldUnit(dep) })
  }
  for (const { node: dep } of node.excludedUpstream ?? []) {
    candidates.push({ node: dep, unit: foldUnit(dep) })
  }
  if (isGroupTask(node) && node.config.cache === undefined) return candidates
  return selectFoldedDeps(candidates, node.config.cache?.inputs?.tasks, node.projectName, node.id)
}

/**
 * What stands in for a dependency's hash in the dedup: equal exactly when
 * the hashes are. An exec task's key folds its own id (`task:<id>`), so its
 * id is enough; a group's hash is a roll-up of its members' ids and hashes
 * with no id of its own, so two groups over the same members hash alike.
 */
function foldUnit(node: TaskNode): string {
  return isGroupTask(node) && node.config.cache === undefined
    ? `group|${[...node.deps].sort().join('|')}`
    : `task|${node.id}`
}
