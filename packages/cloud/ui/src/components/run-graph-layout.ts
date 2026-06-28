// Staged (topological-wave) layout for the run DAG. A node's STAGE is the
// longest dependency path to a root, so each stage is a set of tasks that can
// run once everything before it is done — the run's natural "stages". Deps
// always sit in an earlier stage (to the left) than their dependents. Within a
// stage, nodes pack in input order. The component maps (stage, row) → pixels
// and draws edges between them.

export interface StageLayout {
  pos: Map<string, { stage: number; row: number }>
  stageCount: number
  maxRows: number
  /** Per-stage parallel wall-time proxy = the longest task in that stage. */
  stageDurationMs: number[]
}

export function layoutStages(
  nodes: ReadonlyArray<{ id: string; deps: readonly string[] }>,
  durationOf?: (id: string) => number | undefined,
): StageLayout {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const stageOf = new Map<string, number>()
  const visiting = new Set<string>()
  const stage = (id: string): number => {
    const cached = stageOf.get(id)
    if (cached !== undefined) return cached
    if (visiting.has(id)) return 0 // cycle guard — the graph is a DAG, but be safe
    visiting.add(id)
    const deps = (byId.get(id)?.deps ?? []).filter((d) => byId.has(d))
    const s = deps.length === 0 ? 0 : 1 + Math.max(...deps.map(stage))
    visiting.delete(id)
    stageOf.set(id, s)
    return s
  }
  for (const n of nodes) stage(n.id)

  const rowCounter = new Map<number, number>()
  const pos = new Map<string, { stage: number; row: number }>()
  const stageDurationMs: number[] = []
  for (const n of nodes) {
    const s = stageOf.get(n.id) ?? 0
    const row = rowCounter.get(s) ?? 0
    rowCounter.set(s, row + 1)
    pos.set(n.id, { stage: s, row })
    stageDurationMs[s] = Math.max(stageDurationMs[s] ?? 0, durationOf?.(n.id) ?? 0)
  }
  const stageCount = nodes.length === 0 ? 0 : Math.max(...stageOf.values()) + 1
  let maxRows = 0
  for (const c of rowCounter.values()) maxRows = Math.max(maxRows, c)
  return { pos, stageCount, maxRows, stageDurationMs }
}
