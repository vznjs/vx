// Core's cache as a plugin: the `.vx/cache` handle the host opened (the run
// index + the local artifact store). Declared like any other cache layer;
// put a remote layer BEFORE it to look there first.

import type { VxPlugin } from '@vzn/vx'

export const LOCAL_CACHE_PLUGIN = 'vx/local-cache'

export function localCachePlugin(): VxPlugin {
  return { name: LOCAL_CACHE_PLUGIN, cache: (ctx) => ctx.localCache }
}
