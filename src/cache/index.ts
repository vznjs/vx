// Module contract. Cross-module imports must come through here; see
// docs/design/module-isolation-2026-06.md and tests/module-boundaries.test.ts.
// tar.ts is internal — artifact pack/extract is an implementation detail.

export { Cache, type CacheLayer, type RunRecord } from './cache.js'
export {
  cleanOutputs,
  GitFilesCache,
  populateGitFilesCache,
  resolveInputs,
  resolveOutputs,
} from './inputs.js'
export { LayeredCache } from './layered-cache.js'
export { RemoteCache } from './remote-cache.js'
