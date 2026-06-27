// Plugin consultation for the three run-level extension points
// (backend / cache / eventSink). Each function asks the declared plugins
// in order and falls back to today's exact default, so a workspace with
// no capability plugin is byte-identical to before the inversion.
//
// See docs/design/core-cloud-split-2026-06.md §5.1.

import type { Cache, CacheLayer } from '../cache/index.js'
import { UserError } from '../util/index.js'
import type { EventBus } from './events.js'
import { wireForwarder } from './events.js'
import type { Logger } from './logger.js'
import type { BackendContext, CacheContext, EventSinkContext, VxPlugin } from './plugin.js'
import type { RunBackend } from './protocol.js'

/**
 * Run a capability factory with crash isolation. A throw becomes a clean
 * `UserError` naming the plugin + hook for the load-bearing capabilities
 * (`backend`/`cache`/`setup`) — a broken backend or cache must abort with
 * a clear message, never silently degrade. For `eventSink` the caller
 * logs-and-skips instead (observability must never break a run).
 */
async function safe<T>(plugin: VxPlugin, hook: string, fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw new UserError(
      `plugin '${plugin.name}' failed in ${hook}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * Resolve the run backend. First plugin returning a non-undefined
 * `backend` wins (declaration order); otherwise the caller's `fallback`
 * (today's local/serve env-probe). A broken backend factory aborts.
 */
export async function resolveBackend(
  plugins: readonly VxPlugin[],
  ctx: BackendContext,
  fallback: () => Promise<RunBackend>,
): Promise<RunBackend> {
  for (const plugin of plugins) {
    if (plugin.backend === undefined) continue
    const backend = await safe(plugin, 'backend', () => plugin.backend!(ctx))
    if (backend !== undefined) return backend
  }
  return await fallback()
}

/**
 * Resolve the cache layer. First plugin returning a non-undefined `cache`
 * wins; otherwise the caller's `fallback` (today's env-var Turbo-wire
 * `wrapWithRemoteCache`). When a plugin cache wins AND the env vars are
 * also set, a one-line note records that the plugin overrides them
 * (explicit beats ambient). A broken cache factory aborts.
 */
export async function resolveCache(
  plugins: readonly VxPlugin[],
  _localCache: Cache,
  ctx: CacheContext,
  log: Logger,
  fallback: () => CacheLayer,
): Promise<CacheLayer> {
  for (const plugin of plugins) {
    if (plugin.cache === undefined) continue
    const cache = await safe(plugin, 'cache', () => plugin.cache!(ctx))
    if (cache !== undefined) {
      if (process.env.VX_REMOTE_CACHE_URL)
        log.status(`[vx] plugin '${plugin.name}' cache overrides VX_REMOTE_CACHE_*`)
      return cache
    }
  }
  return fallback()
}

/**
 * Subscribe every plugin's `eventSink` to the bus via `wireForwarder`,
 * each isolated so a throwing sink can never break the run. Additive: with
 * no eventSink plugin nothing subscribes and behavior is unchanged.
 * Returns a disposer that removes every subscription.
 */
export async function subscribeEventSinks(
  plugins: readonly VxPlugin[],
  bus: EventBus,
  ctx: EventSinkContext,
): Promise<() => void> {
  const disposers: Array<() => void> = []
  for (const plugin of plugins) {
    if (plugin.eventSink === undefined) continue
    let sink
    try {
      sink = await plugin.eventSink(ctx)
    } catch (err) {
      ctx.warn(
        `[vx] plugin '${plugin.name}' eventSink failed to initialize; disabled for this run: ${err instanceof Error ? err.message : String(err)}`,
      )
      continue
    }
    if (sink === undefined) continue
    disposers.push(
      bus.subscribe(
        wireForwarder((event) => {
          try {
            sink.onEvent(event)
          } catch {
            // observability is isolated — a sink fault can't break the run
          }
        }),
      ),
    )
  }
  return () => {
    for (const dispose of disposers) dispose()
  }
}
