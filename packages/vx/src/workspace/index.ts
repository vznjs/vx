// Module contract. Cross-module imports must come through here; see
// docs/design/module-isolation-2026-06.md and tests/module-boundaries.test.ts.

export {
  affectedChanges,
  type AffectedChanges,
  affectedProjects,
  defaultAffectedBase,
  type FingerprintClaims,
  refIsHead,
} from './affected.js'
export { applyFilters, parseFilter } from './filter.js'
export { readClaimedFiles } from './fingerprint.js'
export { checkDependencyRules } from './dependency-rules.js'
export { computeNestedProjectDirs } from './nested-dirs.js'
export { buildPackageGraph, type PackageGraph } from './package-graph.js'
export {
  frozenProjectConfigs,
  LOCKFILE_NAME,
  LOCKFILE_VERSION,
  LOCK_INVALID,
  lockEntryBroken,
  lockfilePath,
  lockKey,
  NO_LOCK,
  readLockfile,
  writeLockfile,
  type Lockfile,
  type LockedProject,
} from './lockfile.js'
export {
  loadProjectConfig,
  loadProjectConfigs,
  loadWorkspaceConfig,
  WORKSPACE_CONFIG_FILENAMES,
} from './project-loader.js'
export {
  cacheScopeEnvError,
  cacheScopeError,
  inputStabilityEnv,
  isCacheScope,
  validateProjectConfig,
  validateWorkspace,
} from './config-schema.js'
export { configImports } from './config-imports.js'
export {
  checkProjectNames,
  findWorkspaceRoot,
  findProjectConfigs,
  discoveredProject,
  linkDiscoveredEdges,
  lockedProjects,
  pathName,
  PROJECT_CONFIG_FILENAMES,
  resolveCacheDir,
  resolveStoreRoot,
  ROOT_NAME,
  type ConfigDir,
  type ProjectEntry,
  type ProjectMeta,
} from './workspace.js'
// `vx init`'s package-manager members (its scripts mapper), never a run's.
export {
  discoverPackages,
  findManifestRoot,
  listPackages,
  loadPackageWorkspace,
  type PackageMeta,
} from './packages.js'
export type { LoadReads } from './load-reads.js'
// The migration seam (see migration.ts) and core's own mapper, the scripts one.
export {
  applyMigration,
  foldScriptHooks,
  PERSISTENT_TASK_NAMES,
  PERSISTENT_TODO,
  pruneOrphanPersistentNotes,
  quoteTsLiteral,
  type ApplyMigrationArgs,
  type MigrationFormat,
  type GeneratedProject,
  type GeneratedTask,
  type MigrationPlan,
  type RawExpr,
} from './migration.js'
export { delegatedScript, migrateScripts } from './migrate-scripts.js'
