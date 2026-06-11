// Module contract. Cross-module imports must come through here; see
// docs/design/module-isolation-2026-06.md and tests/module-boundaries.test.ts.

export { affectedProjects, defaultAffectedBase } from './affected.js'
export { applyFilters, parseFilter } from './filter.js'
export { computeWorkspaceFingerprint } from './fingerprint.js'
export { computeNestedProjectDirs } from './nested-dirs.js'
export { buildPackageGraph, type PackageGraph } from './package-graph.js'
export { loadProjectConfig, loadWorkspaceConfig } from './project-loader.js'
export {
  findWorkspaceRoot,
  listProjects,
  loadWorkspace,
  resolveCacheDir,
  type ProjectEntry,
  type ProjectMeta,
} from './workspace.js'
