// Module contract. Cross-module imports must come through here; see
// docs/design/module-isolation-2026-06.md and tests/module-boundaries.test.ts.

export {
  affectedChanges,
  BASE_SIDE,
  type AffectedChanges,
  affectedProjects,
  defaultAffectedBase,
  type FingerprintClaims,
  headBase,
  mergeBaseWith,
} from './affected.js'
export { applyFilters, parseFilter } from './filter.js'
export { pipelineRunArgs, PIPELINE_FLAGS } from './pipeline.js'
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
  lockedDependencies,
  lockEntryBroken,
  lockfilePath,
  lockKey,
  NO_LOCK,
  readLockfile,
  lockfileWrite,
  writeLockfile,
  type Lockfile,
  type LockedProject,
} from './lockfile.js'
export {
  DEPENDENCIES_LOCK_NAME,
  dependenciesLock,
  dependenciesLockRefusal,
  parseDependenciesLock,
  readDependenciesLock,
  sameRecord,
  recordedDigests,
  dependenciesLockWrite,
  type DependenciesLock,
} from './dependencies-lock.js'
export {
  evaluatedWorkspace,
  loadProjectConfig,
  loadProjectConfigs,
  loadWorkspaceConfig,
  stdoutToStderr,
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
export { startDeferredBuilds } from './config-bytecode.js'
export { repoIdsOf } from './repo-id.js'
export {
  checkProjectNames,
  findWorkspaceRoot,
  configsOutsideLock,
  findProjectConfigs,
  REVIEW_FILE,
  discoveredProject,
  linkDiscoveredEdges,
  lockedProjects,
  pathName,
  PROJECT_CONFIG_FILENAMES,
  resolveCacheDir,
  resolveStoreRoot,
  type ConfigDir,
  type ProjectConfigs,
  type ProjectEntry,
  type ProjectMeta,
} from './workspace.js'
export type { LoadReads } from './load-reads.js'
// The migration seam (see migration.ts).
export {
  ignoredNotes,
  isStarterConfig,
  PERSISTENT_TODO,
  pruneOrphanPersistentNotes,
  quoteTsLiteral,
  renderWorkspace,
  settleToolFiles,
  starterProject,
  tscCompilesConfigNotes,
  writeMigration,
  type ApplyMigrationArgs,
  type MigrationFormat,
  type MigrationMember,
  type MigrationReport,
  type GeneratedProject,
  type GeneratedTask,
  type MigrationPlan,
  type RawExpr,
} from './migration.js'
