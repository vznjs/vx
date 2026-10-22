// @vzn/vx-migrate — adoption: the Turbo and Nx project stages (a repo
// runs unchanged) and the two remote caches speaking Turbo's and Nx's
// wire. The CLI (`bunx @vzn/vx-migrate`) is `migrate.ts`; mappers and
// cache clients are internal (1.0 freezes what this file exports).
//
// Each factory loads its module on first call: a workspace evaluates this
// file on every run, and a Turbo repo paid ~4 ms per run transpiling nx()
// and both cache clients it never calls (solid, 2026-10-22).
import type * as Turbo from './turbo/index.js'
import type * as Nx from './nx/index.js'
import type * as TurboCache from './turbo-cache/index.js'
import type * as NxCache from './nx-cache/index.js'

export type { TurboPluginOptions } from './turbo/index.js'
export type {
  NxExecutors,
  NxExecutorTarget,
  NxExecutorTranslation,
  NxExecutorTranslator,
  NxPluginOptions,
} from './nx/index.js'
export type { TurboCacheOptions } from './turbo-cache/index.js'
export type { NxCacheOptions } from './nx-cache/index.js'

export const turbo: typeof Turbo.turbo = (...args) =>
  (require('./turbo/index.js') as typeof Turbo).turbo(...args)
export const nx: typeof Nx.nx = (...args) => (require('./nx/index.js') as typeof Nx).nx(...args)
export const turboCache: typeof TurboCache.turboCache = (...args) =>
  (require('./turbo-cache/index.js') as typeof TurboCache).turboCache(...args)
export const nxCache: typeof NxCache.nxCache = (...args) =>
  (require('./nx-cache/index.js') as typeof NxCache).nxCache(...args)
