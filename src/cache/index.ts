// Module contract. Cross-module imports must come through here; see
// docs/design/module-isolation-2026-06.md and tests/module-boundaries.test.ts.
// tar.ts is internal — artifact pack/extract is an implementation detail.

export { Cache, type CacheLayer, type RunRecord, WORKSPACE_OUTPUT_PREFIX } from './cache.js'
export {
  cleanOutputs,
  cleanWorkspaceOutputs,
  GitFilesCache,
  populateGitFilesCache,
  resolveInputs,
  resolveOutputs,
  resolveWorkspaceOutputs,
} from './inputs.js'
export { LayeredCache } from './layered-cache.js'
export { RemoteCache } from './remote-cache.js'
