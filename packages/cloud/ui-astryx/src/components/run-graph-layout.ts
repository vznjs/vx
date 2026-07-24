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
