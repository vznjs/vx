import type { StoreOptions } from '../../src/cache/index.js'

/** The `.tar.zst` form (`cache.store.compress: true`), for the tests that pin that form. */
export const TAR_STORE: StoreOptions = { embeddings: 32 * 1024, compress: true, verify: 'stat' }
