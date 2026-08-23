// Module contract. Cross-module imports must come through here; see
// docs/design/module-isolation-2026-06.md and tests/module-boundaries.test.ts.
// tar.ts is internal — artifact pack/extract is an implementation detail.

export {
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
  type RunRecord,
  type TaskInputRow,
  WORKSPACE_OUTPUT_PREFIX,
} from './cache.js'
export { type CASBackend, FsCASBackend, MemoryCASBackend } from './cas-backend.js'
export { type Digest, digestEqual, digestString, makeDigest, parseDigest } from './digest.js'
export {
  cleanOutputs,
  cleanWorkspaceOutputs,
  GitFilesCache,
  populateGitFilesCache,
  resolveInputs,
  resolveOutputs,
  resolveWorkspaceOutputs,
} from './inputs.js'
export { LayeredCache, type RemoteCacheLayer } from './layered-cache.js'
export { ChainedCache } from './chained-cache.js'
