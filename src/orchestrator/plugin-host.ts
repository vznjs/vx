// Plugin consultation for the three run-level extension points
// (backend / cache / eventSink). Each function asks the declared plugins
// in order and falls back to today's exact default, so a workspace with
// no capability plugin is byte-identical to before the inversion.
//
// See docs/design/core-cloud-split-2026-06.md §5.1.

import type { Cache, CacheLayer } from '../cache/index.js'
import { settleWithin, teardownTimeoutMs, UserError } from '../util/index.js'
import type { EventBus } from './events.js'
import { wireForwarder } from './events.js'
import type { Logger } from './logger.js'
import type {
  BackendContext,
  CacheContext,
  EventSink,
  EventSinkContext,
  VxPlugin,
} from './plugin.js'
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
 * wins; otherwise the caller's `fallback` (the plain local cache — core
 * ships no wire client; a remote layer comes from a plugin or from
 * `RunOptions.remoteCache`). A broken cache factory aborts.
 */
export async function resolveCache(
  plugins: readonly VxPlugin[],
  _localCache: Cache,
  ctx: CacheContext,
  _log: Logger,
  fallback: () => CacheLayer,
): Promise<CacheLayer> {
  for (const plugin of plugins) {
    if (plugin.cache === undefined) continue
    const cache = await safe(plugin, 'cache', () => plugin.cache!(ctx))
    if (cache !== undefined) return cache
  }
  return fallback()
}

export interface SubscribedEventSinks {
  /** Removes every bus subscription. Called in run()'s finally. */
  dispose(): void
  /** The installed sinks (with the owning plugin's name for warnings),
   *  so run() can await each sink's `flush()` at end-of-run. */
  sinks: ReadonlyArray<{ pluginName: string; sink: EventSink }>
}

/**
 * Subscribe every plugin's `eventSink` to the bus via `wireForwarder`,
 * each isolated so a throwing sink can never break the run. Additive: with
 * no eventSink plugin nothing subscribes and behavior is unchanged.
 * Returns the disposer plus the installed sinks (for the end-of-run flush).
 */
export async function subscribeEventSinks(
  plugins: readonly VxPlugin[],
  bus: EventBus,
  ctx: EventSinkContext,
): Promise<SubscribedEventSinks> {
  const disposers: Array<() => void> = []
  const sinks: Array<{ pluginName: string; sink: EventSink }> = []
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
    sinks.push({ pluginName: plugin.name, sink })
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
  return {
    dispose: () => {
      for (const dispose of disposers) dispose()
    },
    sinks,
  }
}

/**
 * End-of-run plugin lifecycle: await each event sink's optional
 * `flush()` (its last chance to ship buffered records), then each
 * plugin's optional `teardown()`. Crash-isolated — a throwing
 * flush/teardown is logged and skipped, never propagated — and each
 * call is time-bounded by {@link teardownTimeoutMs}. Runs on the
 * normal completion path only; the finally-path disposers just
 * unsubscribe.
 */
export async function teardownPlugins(
  plugins: readonly VxPlugin[],
  sinks: ReadonlyArray<{ pluginName: string; sink: EventSink }>,
  warn: (message: string) => void,
): Promise<void> {
  for (const { pluginName, sink } of sinks) {
    if (sink.flush === undefined) continue
    try {
      await settleWithin(Promise.resolve(sink.flush()), teardownTimeoutMs())
    } catch (err) {
      warn(
        `[vx] plugin '${pluginName}' event sink flush failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  for (const plugin of plugins) {
    if (plugin.teardown === undefined) continue
    try {
      await settleWithin(Promise.resolve(plugin.teardown()), teardownTimeoutMs())
    } catch (err) {
      warn(
        `[vx] plugin '${plugin.name}' teardown failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
}
