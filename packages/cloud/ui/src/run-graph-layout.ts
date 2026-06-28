// Pure layered (Sugiyama-lite) layout for the run DAG. Each node's layer is the
// longest dependency path to a root, so deps always sit to the left of their
// dependents; rows pack nodes within a layer in input order. The component maps
// (layer, row) → pixel coords and draws edges between them.

export interface LayoutNode {
  id: string
  layer: number
  row: number
}

export interface GraphLayout {
  nodes: Map<string, LayoutNode>
  layerCount: number
  maxRows: number
}

export function layoutGraph(input: ReadonlyArray<{ id: string; deps: readonly string[] }>): GraphLayout {
  const byId = new Map(input.map((n) => [n.id, n]))
  const layerOf = new Map<string, number>()
  const visiting = new Set<string>()
  const layer = (id: string): number => {
    const cached = layerOf.get(id)
    if (cached !== undefined) return cached
    if (visiting.has(id)) return 0 // cycle guard — the graph is a DAG, but be safe
    visiting.add(id)
    const deps = (byId.get(id)?.deps ?? []).filter((d) => byId.has(d))
    const l = deps.length === 0 ? 0 : 1 + Math.max(...deps.map(layer))
    visiting.delete(id)
    layerOf.set(id, l)
    return l
  }
  for (const n of input) layer(n.id)

  const rowCounter = new Map<number, number>()
  const nodes = new Map<string, LayoutNode>()
  for (const n of input) {
    const l = layerOf.get(n.id) ?? 0
    const row = rowCounter.get(l) ?? 0
    rowCounter.set(l, row + 1)
    nodes.set(n.id, { id: n.id, layer: l, row })
  }
  const layerCount = input.length === 0 ? 0 : Math.max(...layerOf.values()) + 1
  let maxRows = 0
  for (const c of rowCounter.values()) maxRows = Math.max(maxRows, c)
  return { nodes, layerCount, maxRows }
}
