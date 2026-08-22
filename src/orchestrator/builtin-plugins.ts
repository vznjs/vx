// Core's own behaviour, shipped as plugins through the same capabilities a
// third party uses. This is what makes "a plugin can replace any part"
// provable rather than promised: there is no hidden fallback for executing
// a task or holding the cache — the built-ins ARE the fallback, appended
// last unless the workspace declares them itself (then their declared
// position is the precedence). A run with no user plugins resolves to
// exactly these two and is byte-identical to pre-seam vx.

import { localExecutor } from '../exec/index.js'
import type { VxPlugin } from './plugin.js'

export const LOCAL_EXECUTOR_PLUGIN = 'vx/local-executor'
export const LOCAL_CACHE_PLUGIN = 'vx/local-cache'

/** In-process spawn — `runCommand` / `runSandboxed`. Accepts every task. */
export function localExecutorPlugin(): VxPlugin {
  return { name: LOCAL_EXECUTOR_PLUGIN, executor: () => localExecutor() }
}

/** The bare local cache handle the host already opened (`.vx/cache`). */
export function localCachePlugin(): VxPlugin {
  return { name: LOCAL_CACHE_PLUGIN, cache: (ctx) => ctx.localCache }
}

/** Declaration order = precedence order for the capabilities they carry. */
export function builtinPlugins(): VxPlugin[] {
  return [localExecutorPlugin(), localCachePlugin()]
}

/**
 * The run's effective plugin list: the workspace's declared plugins, then
 * every built-in the workspace did not declare itself (matched by name).
 */
export function withBuiltins(declared: readonly VxPlugin[] | undefined): VxPlugin[] {
  const user = declared ?? []
  const names = new Set(user.map((p) => p.name))
  return [...user, ...builtinPlugins().filter((b) => !names.has(b.name))]
}
