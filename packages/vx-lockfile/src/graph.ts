// The importers each importer reaches through installed packages, from the
// graph its digest folds: a registry package's dependency the install
// resolved to a workspace package (npm and bun link it when the workspace
// satisfies the range, Yarn's transparent workspaces, a pnpm override to
// `workspace:`). Read from each importer's own dependencies alone, such a
// workspace was no edge, so the dependent's key folded none of its task's
// key, and an edit to it replayed the dependent's old output.

/**
 * Each importer's other importers it reaches by a path through one or more
 * package nodes, sorted; one with none is left out. `nodes` maps each node
 * that stands for an importer to its dir: the importer's own, and an entry
 * that only links it (npm's `link: true`, bun's `workspace:` package, a
 * yarn `link:`), so a direct link is no path through a package. Walked
 * backwards from each package node with an edge into an importer, through
 * package nodes alone: a lockfile with no such path costs a pass over the
 * edges.
 */
export function reachedImporters(
  edges: readonly (readonly number[])[],
  nodes: ReadonlyMap<number, string>,
): Map<string, string[]> {
  const into: number[][] = Array.from({ length: edges.length }, () => [])
  for (let v = 0; v < edges.length; v++) for (const w of edges[v]!) into[w]!.push(v)
  const targets = new Map<string, number[]>()
  for (const [i, dir] of nodes) {
    const list = targets.get(dir)
    if (list === undefined) targets.set(dir, [i])
    else list.push(i)
  }
  const found = new Map<string, Set<string>>()
  // Which target last visited a node: no set to clear per target.
  const seen = new Int32Array(edges.length)
  let stamp = 0
  for (const [target, own] of targets) {
    stamp++
    const stack: number[] = []
    const visit = (u: number): void => {
      const dir = nodes.get(u)
      if (dir === undefined) {
        if (seen[u] !== stamp) {
          seen[u] = stamp
          stack.push(u)
        }
      } else if (dir !== target) {
        let set = found.get(dir)
        if (set === undefined) found.set(dir, (set = new Set()))
        set.add(target)
      }
    }
    for (const t of own) for (const u of into[t]!) if (!nodes.has(u)) visit(u)
    while (stack.length > 0) for (const v of into[stack.pop()!]!) visit(v)
  }
  return new Map([...found].map(([dir, set]) => [dir, [...set].sort()]))
}

/**
 * `links` with `transitive` set to what `reached` names beyond its deps and
 * peers; unchanged when that is nothing, so a lockfile with no such path
 * memoises what it did.
 */
export function withTransitive<T extends { deps: object; peers: object }>(
  links: T,
  reached: readonly string[] | undefined,
): T & { transitive?: readonly string[] } {
  if (reached === undefined) return links
  const direct = new Set<string>([
    ...(Object.values(links.deps) as string[]),
    ...(Object.values(links.peers) as string[]),
  ])
  const transitive = reached.filter((d) => !direct.has(d))
  return transitive.length === 0 ? links : { ...links, transitive }
}
