import { MANIFEST_EDGES_IMPORT } from './manifest-edges.js'

/**
 * Source for a `.vx/workspace.mjs` declaring this test's own plugins, and
 * `manifestEdges()`, the edge source a lockfile plugin is in a real repo.
 * Running here and caching here are core's fallbacks, so a fixture that
 * wants neither needs no workspace file at all.
 *
 * Local to this package on purpose: a test may not read another project's
 * files, and the sandbox enforces it.
 */
export function localWorkspaceSource(extra: readonly string[] = [], prelude = ''): string {
  return `${prelude}${MANIFEST_EDGES_IMPORT}
export default { plugins: [${[...extra, 'manifestEdges()'].join(', ')}] }
`
}
