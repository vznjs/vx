// Module contract. Cross-module imports must come through here; see
// docs/design/module-isolation-2026-06.md and tests/module-boundaries.test.ts.

export {
  affectedChanges,
  type AffectedChanges,
  affectedProjects,
  defaultAffectedBase,
  type FingerprintClaims,
  headBase,
  mergeBaseWith,
} from './affected.js'
export { applyFilters, parseFilter } from './filter.js'
export { readClaimedFiles } from './fingerprint.js'
export { checkBracketLiterals } from './bracket-literal.js'
export { checkDependencyRules } from './dependency-rules.js'
export { computeNestedProjectDirs } from './nested-dirs.js'
export { buildPackageGraph, type PackageGraph } from './package-graph.js'
export {
  frozenProjectConfigs,
  LOCKFILE_NAME,
  LOCKFILE_VERSION,
  LOCK_INVALID,
  EMPTY_LOCK,
  lockDigest,
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
  ConfigsRefused,
  loadProjectConfig,
  loadProjectConfigs,
  loadWorkspaceConfig,
  WORKSPACE_CONFIG_FILENAMES,
} from './project-loader.js'
export {
  branchCacheScope,
  cacheScopeEnvError,
  cacheScopeError,
  configuredBaseBranch,
  inputStabilityEnv,
  isCacheScope,
  taskNameProblem,
  validateProjectConfig,
  validateWorkspace,
} from './config-schema.js'
export { configImports } from './config-imports.js'
export {
  checkProjectNames,
  findWorkspaceRoot,
  findProjectConfigs,
  REVIEW_FILE,
  discoveredProject,
  linkDiscoveredEdges,
  lockedProjects,
  pathName,
  PROJECT_CONFIG_FILENAMES,
  resolveCacheDir,
  resolveStoreRoot,
  ROOT_NAME,
  type ConfigDir,
  type ProjectConfigs,
  type ProjectEntry,
  type ProjectMeta,
} from './workspace.js'
export type { LoadReads } from './load-reads.js'
// The migration seam (see migration.ts).
export {
  applyMigration,
  foldScriptHooks,
  isStarterConfig,
  PERSISTENT_TODO,
  pruneOrphanPersistentNotes,
  quoteTsLiteral,
  renderWorkspace,
  starterProject,
  type ApplyMigrationArgs,
  type MigrationFormat,
  type MigrationMember,
  type GeneratedProject,
  type GeneratedTask,
  type MigrationPlan,
  type RawExpr,
} from './migration.js'
