// Plugin consultation for the run-level extension points (backend / cache / executor / eventSink).
// Each function asks the plugins in order. Nothing is applied by default:
// core's own executor and cache are plugins under src/plugins/ that a
// workspace declares like any other, so a list with no provider for a
// load-bearing capability fails fast with MISSING_PLUGIN_HINT.
//
// See docs/design/core-cloud-split-2026-06.md §5.1.

import { ChainedCache, type CacheLayer } from '../cache/index.js'
import type { TaskExecutor } from '../exec/index.js'
import { settleWithin, teardownTimeoutMs, UserError } from '../util/index.js'
import type { EventBus } from './events.js'
import { wireForwarder } from './events.js'
import { MISSING_PLUGIN_HINT } from './missing-plugin.js'
import type {
  BackendContext,
  CacheContext,
  EventSink,
  EventSinkContext,
  ExecutorContext,
  VxPlugin,
} from './plugin.js'
import type { RunBackend } from './protocol.js'

/**
 * Run a capability factory with crash isolation. A throw becomes a clean
 * `UserError` naming the plugin + hook for the load-bearing capabilities
 * (`backend`/`cache`/`executor`/`setup`) — a broken backend or cache must abort with
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
 * Collect every plugin's `cache` layer in declaration order. One layer is
 * used as is; two or more are chained (lookup walks them, save reaches all;
 * see ChainedCache). A bare local layer that another declared layer already
 * wraps (`layer.local === ctx.localCache`) is dropped, so a remote plugin
 * that layers over the local handle composes with `localCachePlugin()`
 * instead of writing the local store twice. No layer at all is a named error.
 */
export async function resolveCache(
  plugins: readonly VxPlugin[],
  ctx: CacheContext,
): Promise<CacheLayer> {
  const layers: CacheLayer[] = []
  for (const plugin of plugins) {
    if (plugin.cache === undefined) continue
    const layer = await safe(plugin, 'cache', () => plugin.cache!(ctx))
    if (layer !== undefined) layers.push(layer)
  }
  if (layers.length === 0) {
    const declined = plugins.filter((p) => p.cache !== undefined).map((p) => `${p.name} declined`)
    throw new UserError(
      `no cache plugin declared${declined.length > 0 ? ` (${declined.join(', ')})` : ''}. ${MISSING_PLUGIN_HINT}`,
    )
  }
  const wrapsLocal = layers.some((l) => l !== ctx.localCache && l.local === ctx.localCache)
  const distinct = wrapsLocal ? layers.filter((l) => l !== ctx.localCache) : layers
  return distinct.length === 1 ? distinct[0]! : new ChainedCache(distinct)
}

/**
 * Collect every plugin's `executor`, in declaration order. Unlike `backend`
 * and `cache` this is a LIST: per task, `selectExecutor` takes the first
 * that accepts. An empty list is the same authoring error as a missing
 * cache provider and fails the same way. A broken factory aborts — an
 * executor is load-bearing, not observational.
 */
export async function resolveExecutors(
  plugins: readonly VxPlugin[],
  ctx: ExecutorContext,
): Promise<TaskExecutor[]> {
  const executors: TaskExecutor[] = []
  for (const plugin of plugins) {
    if (plugin.executor === undefined) continue
    const executor = await safe(plugin, 'executor', () => plugin.executor!(ctx))
    if (executor !== undefined) executors.push(executor)
  }
  if (executors.length === 0) {
    const declined = plugins
      .filter((p) => p.executor !== undefined)
      .map((p) => `${p.name} declined`)
    throw new UserError(
      `no executor plugin declared${declined.length > 0 ? ` (${declined.join(', ')})` : ''}. ${MISSING_PLUGIN_HINT}`,
    )
  }
  return executors
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
    // A sink is disabled the first time it throws, matching the telemetry
    // source's rule for the same reason: a sink that throws once is broken,
    // and re-entering it for every remaining event of the run only reaches an
    // identical throw. Swallowing silently keeps the isolation the run needs
    // ("observability must never break a run") while leaving the operator with
    // no way to learn their sink never ran — so say it once, by name.
    let disabled = false
    disposers.push(
      bus.subscribe(
        wireForwarder((event) => {
          if (disabled) return
          try {
            sink.onEvent(event)
          } catch (err) {
            disabled = true
            ctx.warn(
              `[vx] plugin '${plugin.name}' event sink threw; disabled for this run: ${err instanceof Error ? err.message : String(err)}`,
            )
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
 *
 * The bound is PER CALL and the phases are sequential, so the worst case
 * composes: measured at the 3s default, 1/2/3 simultaneously-hung plugins
 * cost 3.0/6.0/9.0s. That is deliberate rather than overlooked — the
 * telemetry sibling races its sinks concurrently, but a plugin's teardown
 * may release something a later one still holds, and declaration order is
 * the contract this file keeps elsewhere. Each hung call now names itself,
 * so the delay is attributable instead of mysterious.
 */
export async function teardownPlugins(
  plugins: readonly VxPlugin[],
  sinks: ReadonlyArray<{ pluginName: string; sink: EventSink }>,
  warn: (message: string) => void,
): Promise<void> {
  for (const { pluginName, sink } of sinks) {
    if (sink.flush === undefined) continue
    const ms = teardownTimeoutMs()
    try {
      const settled = await settleWithin(Promise.resolve(sink.flush()), ms)
      // `settleWithin` returns false when the deadline won, and its docstring
      // leaves it to the caller to decide whether a lost result is worth
      // reporting. It is: a flush is the sink's LAST chance to ship what it
      // buffered, so a timeout means those records are gone. Dropping the
      // verdict made this function speak for a rejecting flush and stay silent
      // for a hanging one, and made it disagree with its documented sibling in
      // telemetry.ts, which reports exactly this.
      if (!settled) {
        warn(
          `[vx] plugin '${pluginName}' event sink flush timed out after ${ms}ms; buffered records lost`,
        )
      }
    } catch (err) {
      warn(
        `[vx] plugin '${pluginName}' event sink flush failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  for (const plugin of plugins) {
    if (plugin.teardown === undefined) continue
    const ms = teardownTimeoutMs()
    try {
      const settled = await settleWithin(Promise.resolve(plugin.teardown()), ms)
      // Same rule as the flush above. A teardown that never settles has left
      // whatever it owns un-released, and the run exits anyway — silence would
      // present that as a clean shutdown.
      if (!settled) {
        warn(`[vx] plugin '${plugin.name}' teardown timed out after ${ms}ms; it did not complete`)
      }
    } catch (err) {
      warn(
        `[vx] plugin '${plugin.name}' teardown failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
}
