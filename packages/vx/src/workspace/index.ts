// Module contract. Cross-module imports must come through here; see
// docs/design/module-isolation-2026-06.md and tests/module-boundaries.test.ts.

export {
  affectedProjects,
  defaultAffectedBase,
  type FingerprintClaims,
  workspaceGlobsMatch,
} from './affected.js'
export { applyFilters, parseFilter } from './filter.js'
export {
  computeWorkspaceFingerprint,
  computeWorkspaceFingerprints,
  WORKSPACE_FINGERPRINT_FILES,
  type WorkspaceFingerprints,
} from './fingerprint.js'
export { computeNestedProjectDirs } from './nested-dirs.js'
export { buildPackageGraph, type PackageGraph } from './package-graph.js'
export {
  frozenProjectConfig,
  LOCKFILE_NAME,
  LOCKFILE_VERSION,
  lockfilePath,
  FROZEN_WITHOUT_LOCK,
  readLockfile,
  writeLockfile,
  type Lockfile,
  type LockfileEntry,
} from './lockfile.js'
export {
  loadProjectConfig,
  loadProjectConfigs,
  loadWorkspaceConfig,
  WORKSPACE_CONFIG_FILENAMES,
} from './project-loader.js'
export { validateProjectConfig } from './config-schema.js'
export type { LoadProjectConfigOptions } from './project-loader.js'
export {
  blobOidOf,
  configEvalKey,
  configEvalKeyFromClosure,
  type ConfigEvalStore,
} from './config-cache.js'
export {
  findWorkspaceRoot,
  listProjects,
  loadWorkspace,
  memberBaseDirs,
  resolveCacheDir,
  type ProjectEntry,
  type ProjectMeta,
} from './workspace.js'
// The migration seam (see migration.ts) and core's own mapper, the scripts one.
export {
  applyMigration,
  PERSISTENT_TASK_NAMES,
  PERSISTENT_TODO,
  quoteTsLiteral,
  type ApplyMigrationArgs,
  type MigrationFormat,
  type GeneratedProject,
  type GeneratedTask,
  type MigrationPlan,
  type RawExpr,
} from './migration.js'
export { delegatedScript, migrateScripts } from './migrate-scripts.js'
