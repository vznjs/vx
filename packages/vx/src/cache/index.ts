// Module contract. Cross-module imports must come through here; see
// docs/design/module-isolation-2026-06.md and tests/module-boundaries.test.ts.
// archive.ts / tar-stream.ts / zstd.ts are internal — artifact pack, extract
// and framing are implementation details; the layer CONTRACT is layer.ts,
// re-exported through cache.ts.

export {
  applyCacheFlags,
  ArtifactVanishedError,
  Cache,
  DEFAULT_STORE,
  type StoreOptions,
  type CacheFlags,
  type CacheEntry,
  type CacheKeyInput,
  type CacheLayer,
  type RemoteTraffic,
  type CachePolicy,
  cachesNothing,
  EXECUTED_RUNS_SQL,
  formatCachePolicy,
  FULL_CACHE_POLICY,
  type InvocationRecord,
  KEYED_RUNS_SQL,
  parseCachePolicy,
  type RunRecord,
  type TaskInputComponent,
  type TaskInputRow,
  WORKSPACE_OUTPUT_PREFIX,
  type OutputDirRow,
  OUTPUT_DIRS_CAP,
  OUTPUT_DIRS_OVER_CAP,
  FILE_HASH_RACY_MS,
  OUTPUT_DIRS_RACY_MS,
  racyWindowMs,
  type SchemaReset,
  SCHEMA_VERSION,
  vxCacheEntries,
} from './cache.js'
export { ABSENT_INPUT, absentOr, CACHE_VERSION, foldHead } from './key-fold.js'
export type { FoldMemo } from './fold-memo.js'
export { measureFsClockLag, setFsClockLag } from './fs-clock.js'
export { behindLink, filesBehind } from './linked-inputs.js'
export {
  addedInput,
  type InputListing,
  cleanOutputs,
  committedFiles,
  cleanWorkspaceOutputs,
  declaresInput,
  namedOutright,
  workspaceFilesReachInto,
  filesToken,
  resolveInputs,
  type ResolveInputsArgs,
  resolveOutputTree,
  resolveOutputs,
  outputWalkTakes,
  resolveWorkspaceOutputs,
  resolveWorkspaceOutputTree,
  sweepRestoreTemps,
  sweepStaging,
  asTrees,
  type ProjectFilesCache,
  type WorkspaceFilesCache,
  cleanOutputPaths,
  ownOutputsSince,
  ownWorkspaceOutputsSince,
  stampOutputs,
  stampWorkspaceOutputs,
  stopRuntimeProbes,
  answerRuntime,
  type OutputStamp,
} from './inputs.js'
export {
  GitFilesCache,
  gitRefusal,
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
export {
  type ArtifactInfo,
  LayeredCache,
  type LentAccess,
  type RemoteCacheLayer,
  type RemoteOpenContext,
} from './layered-cache.js'
export { networkConcurrency, sayRemoteFault } from './remote-lane.js'
export type { ResolvedRemote } from './remote-lane.js'
export {
  absentPluginCache,
  pluginCache,
  PLUGIN_ENTRY_MAX_BYTES,
  type PluginCache,
} from './plugin-cache.js'
export { packRunOutputs, putRunEntry, runEntryName, writesRunStore } from './run-store.js'
export { branchSource } from './run-history.js'
