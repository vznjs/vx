// @vzn/vx-migrate — adoption: the Turbo and Nx project stages (a repo
// runs unchanged) and the two remote caches speaking Turbo's and Nx's
// wire. The CLI (`bunx @vzn/vx-migrate`) is `migrate.ts`; mappers and
// cache clients are internal (1.0 freezes what this file exports).
export { turbo, type TurboPluginOptions } from './turbo/index.js'
export { nx, type NxPluginOptions } from './nx/index.js'
export { turboCache, type TurboCacheOptions } from './turbo-cache/index.js'
export { nxCache, type NxCacheOptions } from './nx-cache/index.js'
