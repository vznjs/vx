// Module contract. Cross-module imports must come through here; see
// docs/design/module-isolation-2026-06.md and tests/module-boundaries.test.ts.
// archive.ts / tar-stream.ts / zstd.ts are internal — artifact pack, extract
// and framing are implementation details; the layer CONTRACT is layer.ts,
// re-exported through cache.ts.

export {
  ArtifactVanishedError,
  Cache,
  type CacheEntry,
  type CacheKeyInput,
  type CacheLayer,
  type CachePolicy,
  EXECUTED_RUNS_SQL,
  FULL_CACHE_POLICY,
  type InvocationRecord,
  KEYED_RUNS_SQL,
  parseCachePolicy,
  scopeCachePolicy,
  type RunRecord,
  type TaskInputRow,
  WORKSPACE_OUTPUT_PREFIX,
  type OutputDirRow,
  OUTPUT_DIRS_CAP,
  FILE_HASH_RACY_MS,
  OUTPUT_DIRS_RACY_MS,
  racyWindowMs,
  type SchemaReset,
  SCHEMA_VERSION,
} from './cache.js'
export { ABSENT_INPUT, absentOr, CACHE_VERSION } from './key-fold.js'
export {
  cleanOutputs,
  cleanWorkspaceOutputs,
  declaresInput,
  resolveInputs,
  resolveOutputs,
  resolveWorkspaceOutputs,
  asTrees,
  type ProjectFilesCache,
  type WorkspaceFilesCache,
  cleanOutputPaths,
  ownOutputsSince,
  ownWorkspaceOutputsSince,
  stampOutputs,
  stampWorkspaceOutputs,
  stopRuntimeProbes,
  type OutputStamp,
} from './inputs.js'
export {
  GitFilesCache,
  applyGitEnumeration,
  gitPathspecs,
  MAX_SCOPED_PATHSPECS,
  repoRootOf,
  startGitEnumeration,
  lazyGitEnumeration,
  type LazyGitEnumeration,
  type GitEnumeration,
  type BlobSizeMemo,
} from './git-inputs.js'
export { LayeredCache, type RemoteCacheLayer } from './layered-cache.js'
export { ChainedCache } from './chained-cache.js'
