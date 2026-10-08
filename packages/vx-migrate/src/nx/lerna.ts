// `lerna run <x>` orders each package's <x> after its dependencies' <x>.
// Lerna 6+ runs it on Nx's task runner and passes that order as the target
// dependency `^<x>` — and drops every other one — unless the repo
// configures Nx tasks itself: nx.json `targetDefaults` (or the legacy
// `targetDependencies`), or an `nx` key in the package.json of a package
// that has <x> (lerna's `prepNxOptions`, 9.0.7). The exported graph holds
// none of this, so a Lerna repo mapped from it ran every build at once.

import path from 'node:path'

interface Target {
  dependsOn?: unknown[]
}
interface Node {
  data?: { root?: string; targets?: Record<string, Target> }
}

/** The text of `root/lerna.json`, or null when there is none. */
export async function lernaJsonText(root: string): Promise<string | null> {
  return Bun.file(path.join(root, 'lerna.json'))
    .text()
    .catch(() => null)
}

/**
 * The graph's nodes with Lerna's order applied, or `nodes` itself when the
 * repo has no lerna.json or configures Nx's task dependencies.
 * `manifest(rel)`: the package.json a root-relative node root holds.
 */
export async function withLernaOrder<N extends Node>(
  root: string,
  nodes: Record<string, N>,
  nxJson: Record<string, unknown> | undefined,
  manifest: (rel: string) => Promise<Record<string, unknown> | undefined>,
): Promise<Record<string, N>> {
  if ((await lernaJsonText(root)) === null) return nodes
  const keys = (v: unknown): number =>
    v !== null && typeof v === 'object' ? Object.keys(v).length : 0
  if (keys(nxJson?.['targetDependencies'] || nxJson?.['targetDefaults']) > 0) return nodes
  const configured = new Set<string>()
  for (const node of Object.values(nodes)) {
    const targets = node.data?.targets
    if (targets === undefined) continue
    if ((await manifest(node.data?.root ?? '.'))?.['nx'] === undefined) continue
    for (const name of Object.keys(targets)) configured.add(name)
  }
  const out: Record<string, N> = {}
  for (const [id, node] of Object.entries(nodes)) {
    const targets = node.data?.targets
    if (targets === undefined) {
      out[id] = node
      continue
    }
    const ordered: Record<string, Target> = {}
    for (const [name, t] of Object.entries(targets))
      ordered[name] = configured.has(name) ? t : { ...t, dependsOn: [`^${name}`] }
    out[id] = { ...node, data: { ...node.data, targets: ordered } }
  }
  return out
}
