// Plugin consultation for the run-level extension points (cache / executor).
// Each function asks the plugins in order. Nothing is applied by default:
// core's own executor and cache are plugins under src/plugins/ that a
// workspace declares like any other, so a list with no provider for a
// load-bearing capability fails fast with MISSING_PLUGIN_HINT.
//
// See docs/design/core-cloud-split-2026-06.md §5.1.

import { ChainedCache, type CacheLayer } from '../cache/index.js'
import type { TaskExecutor } from '../exec/index.js'
import { settleWithin, teardownTimeoutMs, UserError } from '../util/index.js'
import type { ProjectConfig, WorkspaceConfig } from '../config.js'
import { detectCycle, type TaskNode } from '../graph/index.js'
import { MISSING_PLUGIN_HINT } from './missing-plugin.js'
import type {
  CacheContext,
  ExecutorContext,
  GraphHookContext,
  ProjectHookContext,
  VxPlugin,
  WorkspaceHookContext,
} from './plugin.js'

/**
 * Run a capability factory with crash isolation. A throw becomes a clean
 * `UserError` naming the plugin + hook for the load-bearing capabilities
 * (`cache`/`executor`/`setup`) — a broken cache or executor must abort with
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

// --- Pipeline stages ---------------------------------------------------------
//
// Each stage hands plugins the object core is about to use, in declaration
// order, and the caller re-validates afterwards. `hasHook` is the zero-cost
// gate: with no plugin declaring a stage the caller skips the loop AND the
// re-validation, so a workspace without pipeline plugins pays nothing.

export function hasHook(
  plugins: readonly VxPlugin[],
  hook: 'config' | 'project' | 'graph',
): boolean {
  for (const p of plugins) if (p[hook] !== undefined) return true
  return false
}

/** `config` stage: every plugin edits the workspace config in place. */
export async function applyConfigHooks(
  plugins: readonly VxPlugin[],
  workspace: WorkspaceConfig,
  ctx: WorkspaceHookContext,
): Promise<void> {
  for (const plugin of plugins) {
    if (plugin.config === undefined) continue
    await safe(plugin, 'config', () => plugin.config!(workspace, ctx))
  }
}

/** `project` stage: every plugin edits one project's config in place. */
export async function applyProjectHooks(
  plugins: readonly VxPlugin[],
  config: ProjectConfig,
  ctx: ProjectHookContext,
): Promise<void> {
  for (const plugin of plugins) {
    if (plugin.project === undefined) continue
    await safe(plugin, 'project', () => plugin.project!(config, ctx))
  }
}

/**
 * `graph` stage: every plugin edits the task graph in place, then the graph
 * is checked the way the builder checks its own output — every dep names a
 * node in the graph, and there is no cycle. A violation is reported against
 * the LAST plugin that ran, which is the one whose edit made it so.
 */
export async function applyGraphHooks(
  plugins: readonly VxPlugin[],
  nodes: Map<string, TaskNode>,
  ctx: GraphHookContext,
): Promise<void> {
  let last: VxPlugin | undefined
  for (const plugin of plugins) {
    if (plugin.graph === undefined) continue
    await safe(plugin, 'graph', () => plugin.graph!(nodes, ctx))
    last = plugin
  }
  if (last === undefined) return
  await safe(last, 'graph', () => {
    for (const node of nodes.values()) {
      for (const dep of node.deps) {
        if (!nodes.has(dep)) {
          throw new Error(`${node.id} depends on '${dep}', which is not a task in this run's graph`)
        }
      }
    }
    detectCycle(nodes)
  })
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
 * Collect every plugin's `executor`, in declaration order. Unlike
 * `cache` this is a LIST: per task, `selectExecutor` takes the first
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

/**
 * End-of-run plugin lifecycle: each plugin's optional `teardown()`, in
 * declaration order. Crash-isolated — a throwing teardown is logged and
 * skipped, never propagated — and each call is time-bounded by
 * {@link teardownTimeoutMs}. Runs on the normal completion path only; the
 * finally-path disposers just unsubscribe. (Telemetry sinks flush before
 * this, in telemetry-host.ts, with the same reporting rule.)
 *
 * The bound is PER CALL and the calls are sequential, so the worst case
 * composes: measured at the 3s default, 1/2/3 simultaneously-hung plugins
 * cost 3.0/6.0/9.0s. That is deliberate rather than overlooked — the
 * telemetry sibling races its sinks concurrently, but a plugin's teardown
 * may release something a later one still holds, and declaration order is
 * the contract this file keeps elsewhere. Each hung call names itself, so
 * the delay is attributable instead of mysterious.
 */
export async function teardownPlugins(
  plugins: readonly VxPlugin[],
  warn: (message: string) => void,
): Promise<void> {
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
