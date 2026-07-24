// Dependency-DEPTH layout for the run DAG — a layout device, NOT execution
// stages. A node's LEVEL is the longest dependency chain before it
// (1 + max level of its deps), so a dependency always sits in a lower level
// (to the left) than the things that depend on it.
//
// This is purely structural. vx's scheduler has NO stage/wave barriers: a task
// starts the moment its OWN deps finish and a worker is free (see
// graph/scheduler.ts — `pending` hits 0 → pushed to the ready queue). So a
// level-2 task whose single dep was a fast level-1 task can run while a SLOW
// level-1 task is still going. Levels order the columns; they are not time
// windows. The real timing lives in the critical path + the timeline view.
//
// Within a level, nodes pack in input order.

export interface DepthLayout {
  pos: Map<string, { level: number; row: number }>
  levelCount: number
  maxRows: number
  /** Task count at each level — for the column header. */
  levelSizes: number[]
}

/**
 * Drop GROUP tasks (pure aggregators, no exec) from a graph view, contracting
 * edges through them so the DAG stays connected: every node that depended on a
 * group inherits the group's own (recursively resolved) non-group deps. Groups
 * are organizational folders — `ci`, `build.bun` — not work; a run view should
 * show the tasks that actually execute. Nested groups collapse transitively
 * (`build → build.bun → build.bun.linux-x64` ⇒ an edge straight to the leaf).
 */
export function contractGroups<N extends { id: string; isGroup: boolean; deps: readonly string[] }>(
  nodes: readonly N[],
): Array<N & { deps: string[] }> {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  // groupId → the non-group task ids reachable by walking down through that
  // group's deps. Only GROUPS are memoized (a non-group resolves to itself, an
  // unknown id to []). Computed with an EXPLICIT post-order stack rather than
  // recursion so a deep group spine can't blow the JS stack on a big graph —
  // the iterative form of the memoized DFS, byte-identical to it (children are
  // pushed in reverse so they pop in dep order, matching the left-to-right
  // recursion — this preserves the cycle-cut ordering exactly).
  const memo = new Map<string, string[]>()
  const onPath = new Set<string>()

  // Single-step resolve of one dep id from `memo` — never recurses. A group
  // that isn't memoized here is still on the current DFS path (a cycle), which
  // contributes nothing, matching the recursive `visiting` guard.
  const stepResolve = (id: string): string[] => {
    const cached = memo.get(id)
    if (cached !== undefined) return cached
    const n = byId.get(id)
    if (n === undefined) return []
    if (!n.isGroup) return [id]
    return [] // cycle guard — the graph is a DAG, but be safe
  }

  // Memoize a group id (and every group reachable from it) via post-order.
  const ensureResolved = (rootId: string): void => {
    const root = byId.get(rootId)
    if (root === undefined || !root.isGroup || memo.has(rootId)) return
    const stack: Array<{ id: string; entered: boolean }> = [{ id: rootId, entered: false }]
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!
      const node = byId.get(frame.id)!
      if (!frame.entered) {
        if (memo.has(frame.id)) {
          stack.pop()
          continue
        }
        frame.entered = true
        onPath.add(frame.id)
        // Push child GROUPS (not yet memoized, not already on the path) in
        // REVERSE so the LIFO stack processes them in dep order.
        for (let i = node.deps.length - 1; i >= 0; i--) {
          const dep = node.deps[i]!
          const d = byId.get(dep)
          if (d !== undefined && d.isGroup && !memo.has(dep) && !onPath.has(dep)) {
            stack.push({ id: dep, entered: false })
          }
        }
      } else {
        memo.set(frame.id, [...new Set(node.deps.flatMap(stepResolve))])
        onPath.delete(frame.id)
        stack.pop()
      }
    }
  }

  return nodes
    .filter((n) => !n.isGroup)
    .map((n) => {
      for (const dep of n.deps) ensureResolved(dep)
      return { ...n, deps: [...new Set(n.deps.flatMap(stepResolve))].filter((d) => d !== n.id) }
    })
}

export function layoutLevels(
  nodes: ReadonlyArray<{ id: string; deps: readonly string[] }>,
): DepthLayout {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const levelOf = new Map<string, number>()
  const visiting = new Set<string>()
  const level = (id: string): number => {
    const cached = levelOf.get(id)
    if (cached !== undefined) return cached
    if (visiting.has(id)) return 0 // cycle guard — the graph is a DAG, but be safe
    visiting.add(id)
    const deps = (byId.get(id)?.deps ?? []).filter((d) => byId.has(d))
    const l = deps.length === 0 ? 0 : 1 + Math.max(...deps.map(level))
    visiting.delete(id)
    levelOf.set(id, l)
    return l
  }
  for (const n of nodes) level(n.id)

  const rowCounter = new Map<number, number>()
  const pos = new Map<string, { level: number; row: number }>()
  const levelSizes: number[] = []
  for (const n of nodes) {
    const l = levelOf.get(n.id) ?? 0
    const row = rowCounter.get(l) ?? 0
    rowCounter.set(l, row + 1)
    pos.set(n.id, { level: l, row })
    levelSizes[l] = (levelSizes[l] ?? 0) + 1
  }
  const levelCount = nodes.length === 0 ? 0 : Math.max(...levelOf.values()) + 1
  let maxRows = 0
  for (const c of rowCounter.values()) maxRows = Math.max(maxRows, c)
  return { pos, levelCount, maxRows, levelSizes }
}
