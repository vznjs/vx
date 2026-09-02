// Module contract. Cross-module imports must come through here; see
// docs/design/module-isolation-2026-06.md and tests/module-boundaries.test.ts.

export { affectedProjects, defaultAffectedBase, workspaceGlobsMatch } from './affected.js'
export { applyFilters, parseFilter } from './filter.js'
export { computeWorkspaceFingerprint, WORKSPACE_FINGERPRINT_FILES } from './fingerprint.js'
export { computeNestedProjectDirs } from './nested-dirs.js'
export { buildPackageGraph, type PackageGraph } from './package-graph.js'
export {
  frozenProjectConfig,
  LOCKFILE_NAME,
  LOCKFILE_VERSION,
  lockfilePath,
  readLockfile,
  writeLockfile,
  type Lockfile,
  type LockfileEntry,
} from './lockfile.js'
export { loadProjectConfig, loadWorkspaceConfig, validateProjectConfig } from './project-loader.js'
export type { LoadProjectConfigOptions } from './project-loader.js'
export {
  CONFIG_EVAL_VERSION,
  configEvalKey,
  stripLiterals,
  type ConfigEvalStore,
} from './config-cache.js'
export {
  findWorkspaceRoot,
  listProjects,
  loadWorkspace,
  resolveCacheDir,
  type ProjectEntry,
  type ProjectMeta,
} from './workspace.js'
