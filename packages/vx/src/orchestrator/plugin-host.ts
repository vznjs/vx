// Plugin consultation for the run-level extension points (cache / executor).
// Each function asks the plugins in order, and CORE IS THE TAIL: running
// here and caching here are what those words mean in the absence of a
// plugin placing work elsewhere or storing it somewhere else. A plugin
// goes in front — it takes what it accepts, and what it declines lands on
// the floor. No plugin is required for a plain local run.
//
// See docs/design/pipeline-2026-09.md.

import { ChainedCache, type CacheLayer } from '../cache/index.js'
import { localExecutor, type TaskExecutor } from '../exec/index.js'
import { settleWithin, teardownTimeoutMs, UserError } from '../util/index.js'
import type { ProjectConfig, WorkspaceConfig } from '../config.js'
import { detectCycle, type TaskNode } from '../graph/index.js'
import type {
  CacheContext,
  ExecutorContext,
  FingerprintChange,
  FingerprintContext,
  GraphHookContext,
  KeyHookContext,
  ProjectHookContext,
  ScheduleHookContext,
  VxPlugin,
  WorkspaceHookContext,
} from './plugin.js'

/**
 * Run a capability factory with crash isolation. A throw becomes a clean
 * `UserError` naming the plugin + hook: every stage and capability resolved
 * here is load-bearing, so a broken one must abort with a clear message,
 * never silently degrade. (Telemetry sinks are the observe-only exception,
 * and telemetry-host.ts logs-and-skips them instead.)
 */
/** `a string`, `an array`, `null`, `a number` — for a refusal that names what came back. */
function describeValue(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'an array'
  const t = typeof v
  return t === 'object' ? 'an object' : `a ${t}`
}

/** What a capability hook handed back must be what the seam runs. */
/** Every method `CacheLayer` requires (the optional ones are probed with `?.`). */
export const CACHE_LAYER_METHODS: readonly string[] = [
  'key',
  'get',
  'has',
  'prefetch',
  'loadOutputFilesBatch',
  'isOutputsCurrent',
  'restoreOutputs',
  'save',
  'ingest',
  'recordRunBundle',
  'stats',
  'hashFile',
  'outputsPath',
  'prune',
  'close',
]

function assertShape(
  plugin: VxPlugin,
  hook: string,
  value: unknown,
  methods: readonly string[],
  what: string,
): void {
  const missing =
    value === null || typeof value !== 'object'
      ? methods
      : methods.filter((m) => typeof (value as Record<string, unknown>)[m] !== 'function')
  if (missing.length === 0) return
  throw new UserError(
    `plugin '${plugin.name}' returned from ${hook} something that is not ${what}: ` +
      `missing ${missing.map((m) => `${m}()`).join(', ')}`,
  )
}

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
  hook: 'config' | 'project' | 'graph' | 'key' | 'schedule' | 'admit',
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
  /** Runs after EACH plugin's edit, so a refusal can name the plugin that made it. */
  afterEach?: (plugin: VxPlugin) => void,
): Promise<void> {
  for (const plugin of plugins) {
    if (plugin.project === undefined) continue
    await safe(plugin, 'project', () => plugin.project!(config, ctx))
    afterEach?.(plugin)
  }
}

/**
 * `graph` stage: every plugin edits the task graph in place, then the graph
 * is checked ONCE the way the builder checks its own output — every dep
 * names a node in the graph, and there is no cycle. A violation is reported
 * against the LAST plugin that ran: usually the one whose edit made it so,
 * but an earlier plugin's edit that a later one left in place is blamed on
 * the later one, since nothing is checked between plugins.
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
 * `key` stage: every plugin may add `{ name: value }` material to every
 * task. Stored on the node as sorted `[plugin/name, value]` pairs so the
 * fold is order-independent and `vx why` can name the contributor.
 */
export async function applyKeyHooks(
  plugins: readonly VxPlugin[],
  nodes: Map<string, TaskNode>,
  ctx: KeyHookContext,
): Promise<void> {
  for (const node of nodes.values()) {
    const parts: Array<readonly [string, string]> = []
    for (const plugin of plugins) {
      if (plugin.key === undefined) continue
      const material = await safe(plugin, 'key', () => plugin.key!(node, ctx))
      if (material === undefined) continue
      // `Object.entries` over a string yields its characters as string
      // values, so a plugin returning `'v22'` used to fold parts named
      // '0', '1', '2' into every key — silently, and permanently.
      if (typeof material !== 'object' || material === null || Array.isArray(material)) {
        throw new UserError(
          `plugin '${plugin.name}' failed in key: returned ${describeValue(material)}, not a record of string values`,
        )
      }
      for (const [name, value] of Object.entries(material)) {
        if (typeof value !== 'string') {
          throw new UserError(
            `plugin '${plugin.name}' failed in key: value for '${name}' on ${node.id} is not a string`,
          )
        }
        parts.push([`${plugin.name}/${name}`, value])
      }
    }
    if (parts.length > 0) {
      parts.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      node.keyParts = parts
    }
  }
}

/**
 * The fingerprint files the plugins claim (`VxPlugin.fingerprint`), each
 * with its one claimant. The schema refused a second claimant and an
 * unknown name, so this only indexes.
 */
export function fingerprintClaims(plugins: readonly VxPlugin[]): ReadonlyMap<string, VxPlugin> {
  const claims = new Map<string, VxPlugin>()
  for (const p of plugins) {
    if (p.fingerprint === undefined) continue
    for (const f of p.fingerprint.files) claims.set(f, p)
  }
  return claims
}

/**
 * Ask a claimed file's plugin which projects a change to it affects.
 * `undefined` is "every project" — the claimant could not tell — and a
 * non-iterable answer is refused by name, so a plugin returning `'all'`
 * cannot select the projects spelled a, l, l.
 */
export async function claimedAffected(
  plugin: VxPlugin,
  change: FingerprintChange,
  ctx: FingerprintContext,
): Promise<Set<string> | undefined> {
  const answer = await safe(plugin, 'fingerprint', () => plugin.fingerprint!.affected(change, ctx))
  if (answer === undefined) return undefined
  if (typeof answer === 'string' || typeof answer !== 'object' || answer === null) {
    throw new UserError(
      `plugin '${plugin.name}' failed in fingerprint: returned ${describeValue(answer)}, not a list of project names`,
    )
  }
  const names = new Set<string>()
  for (const name of answer as Iterable<unknown>) {
    if (typeof name !== 'string') {
      throw new UserError(
        `plugin '${plugin.name}' failed in fingerprint: affected project ${describeValue(name)} is not a name`,
      )
    }
    names.add(name)
  }
  return names
}

/**
 * `schedule` stage: the merged priorities map (a later plugin's weight for
 * a task overrides an earlier one's). Empty when no plugin answered.
 */
export async function applyScheduleHooks(
  plugins: readonly VxPlugin[],
  nodes: ReadonlyMap<string, TaskNode>,
  ctx: ScheduleHookContext,
): Promise<ReadonlyMap<string, number>> {
  const merged = new Map<string, number>()
  for (const plugin of plugins) {
    if (plugin.schedule === undefined) continue
    const weights = await safe(plugin, 'schedule', () => plugin.schedule!(nodes, ctx))
    if (weights === undefined) continue
    // Iterating a string destructures its characters into `[id, w]` pairs
    // that match no task — a plugin returning `'fast'` used to be a no-op
    // with no word said.
    if (!(weights instanceof Map)) {
      throw new UserError(
        `plugin '${plugin.name}' failed in schedule: returned ${describeValue(weights)}, not a Map of task id → weight`,
      )
    }
    for (const [id, w] of weights) {
      if (!nodes.has(id)) continue
      if (typeof w !== 'number' || !Number.isFinite(w)) {
        throw new UserError(
          `plugin '${plugin.name}' failed in schedule: weight for ${id} is not a finite number`,
        )
      }
      merged.set(id, w)
    }
  }
  return merged
}

/**
 * `admit` stage, built once per run into the predicate the scheduler asks
 * at every local dispatch: every plugin that answers must admit. A plugin
 * that throws is reported once and admits from then on — a policy never
 * breaks a run — so the predicate is never the reason a task hangs.
 * Undefined when no plugin answers, which keeps the scheduler on its
 * count-only path.
 */
export function buildAdmission(
  plugins: readonly VxPlugin[],
  nodes: ReadonlyMap<string, TaskNode>,
  concurrency: number,
  warn: (message: string) => void,
): ((id: string, running: ReadonlySet<string>) => boolean) | undefined {
  const answering = plugins.filter((p) => p.admit !== undefined)
  if (answering.length === 0) return undefined
  const broken = new Set<VxPlugin>()
  return (id, running) => {
    const task = nodes.get(id)
    if (task === undefined) return true
    const ctx = {
      running: [...running].flatMap((r) => nodes.get(r) ?? []),
      concurrency,
    }
    for (const plugin of answering) {
      if (broken.has(plugin)) continue
      try {
        if (plugin.admit!(task, ctx) === false) return false
      } catch (err) {
        broken.add(plugin)
        const m = err instanceof Error ? err.message : String(err)
        warn(`plugin '${plugin.name}' failed in admit: ${m}; admitting every task from here on`)
      }
    }
    return true
  }
}

/**
 * Collect every plugin's `cache` layer in declaration order. One layer is
 * used as is; two or more are chained (lookup walks them, save reaches all;
 * see ChainedCache). A bare local layer that another declared layer already
 * wraps (`layer.local === ctx.localCache`) is dropped, so a remote plugin
 * that layers over the local handle does not also write the local store
 * directly. A plugin declaring nothing leaves that store, unwrapped.
 */
export async function resolveCache(
  plugins: readonly VxPlugin[],
  ctx: CacheContext,
): Promise<CacheLayer> {
  const layers: CacheLayer[] = []
  for (const plugin of plugins) {
    if (plugin.cache === undefined) continue
    const layer = await safe(plugin, 'cache', () => plugin.cache!(ctx))
    if (layer === undefined) continue
    // The seam's WHOLE contract, checked once here: a layer missing a
    // method otherwise failed at the first task that reached it — an
    // internal TypeError deep in the chain, naming neither the plugin nor
    // the hook. Five names were checked before, so a layer with those five
    // passed and died at its first hit inside restoreOutputs.
    assertShape(plugin, 'cache', layer, CACHE_LAYER_METHODS, 'a cache layer')
    layers.push(layer)
  }
  // Core's own store is the TAIL of the chain — the floor under every
  // lookup, not a plugin a workspace has to declare. A layer that WRAPS
  // the local handle subsumes it below, so a remote plugin does not write
  // the local store twice.
  if (!layers.includes(ctx.localCache)) layers.push(ctx.localCache)
  const wrapsLocal = layers.some((l) => l !== ctx.localCache && l.local === ctx.localCache)
  const distinct = wrapsLocal ? layers.filter((l) => l !== ctx.localCache) : layers
  return distinct.length === 1 ? distinct[0]! : new ChainedCache(distinct)
}

/**
 * Collect every plugin's `executor`, in declaration order, with core's
 * own appended at the tail: per task, `selectExecutor` takes the first
 * that accepts, and what every plugin declines runs here. A broken
 * factory aborts — an executor is load-bearing, not observational.
 */
export async function resolveExecutors(
  plugins: readonly VxPlugin[],
  ctx: ExecutorContext,
): Promise<TaskExecutor[]> {
  const executors: TaskExecutor[] = []
  for (const plugin of plugins) {
    if (plugin.executor === undefined) continue
    const executor = await safe(plugin, 'executor', () => plugin.executor!(ctx))
    if (executor === undefined) continue
    assertShape(plugin, 'executor', executor, ['execute'], 'an executor')
    if (typeof executor.name !== 'string' || executor.name.length === 0) {
      throw new UserError(`plugin '${plugin.name}' returned an executor with no name`)
    }
    executors.push(executor)
  }
  // Core's own executor is the TAIL of every list, so a plugin executor
  // that declines a task hands it back to this machine rather than
  // failing the run.
  executors.push(localExecutor())
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
