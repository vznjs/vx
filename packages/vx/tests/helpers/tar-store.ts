import type { StoreOptions } from '../../src/cache/index.js'

/** The `.tar.zst` form (`cache.store.decompress: false`), for the tests that pin that form. */
export const TAR_STORE: StoreOptions = { decompress: false, verify: 'stat' }
