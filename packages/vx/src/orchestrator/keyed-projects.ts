// The projects a task's cache key answers for: K(T) in
// docs/design/linked-sibling-reads-2026-09.md. A sandboxed task that
// declares `cache` is granted a sibling's `node_modules` link only when its
// key already moves with that sibling's files, and this is where "already"
// is decided — on the graph, before any hash exists, through the same
// selection the hash path applies (`selectFoldedDeps`).

import { foldedDeps, isGroupTask, type FoldCandidate, type TaskNode } from '../graph/index.js'

/**
 * A run's keyed-set lookup: for a task, the directories of every project
 * holding an exec task whose key the task's key folds, transitively. The
 * task itself is not counted.
 *
 * The fold relation is the hash path's, computed on the graph:
 *   - an exec task folds its dependencies as its own `inputs.tasks`
 *     selects them (absent means all);
 *   - a group folds every dependency (`computeGroupKey`); a keyed one
 *     (`inputs`, the default `build`) folds its project's files as a task
 *     does;
 *   - a persistent task is keyed as any task with no `cache` (A-17).
 *
 * Every exec task reached contributes its project, cached or not: its key
 * folds its own project's files through its `inputs`, and one with no
 * `inputs` is keyless, so a key that folds it is never stored or read.
 * `tests/keyed-projects.test.ts` holds that to the key itself.
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
        if (!isGroupTask(dep) || dep.config.inputs !== undefined) out.add(dep.projectDir)
        for (const dir of below.get(dep.id)!) out.add(dir)
      }
      below.set(node.id, out)
    }
    return below.get(root.id)!
  }
}
