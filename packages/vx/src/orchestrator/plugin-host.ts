// Plugin consultation for the run-level extension points (cache / executor).
// Each function asks the plugins in order, and CORE IS THE TAIL: running
// here and caching here are what those words mean in the absence of a
// plugin placing work elsewhere or storing it somewhere else. A plugin
// goes in front — it takes what it accepts, and what it declines lands on
// the floor. No plugin is required for a plain local run.
//
// See docs/design/pipeline-2026-09.md.

import path from 'node:path'
import {
  type Cache,
  type CacheLayer,
  type CachePolicy,
  LayeredCache,
  absentPluginCache,
  type PluginCache,
  type ResolvedRemote,
} from '../cache/index.js'
import { localExecutor, type TaskExecutor } from '../exec/index.js'
import { maskedLine, settleWithin, teardownTimeoutMs, UserError } from '../util/index.js'
import { PLATFORMS, type ProjectConfig, type WorkspaceConfig } from '../config.js'
import { checkGraph, type GraphRules, type TaskNode } from '../graph/index.js'
import type {
  CacheContext,
  DiscoverContext,
  ExecutorContext,
  FingerprintChange,
  FingerprintContext,
  GraphHookContext,
  KeyHookContext,
  DiscoveredProject,
  ProjectHookContext,
  RunReport,
  ScheduleHookContext,
  VxPlugin,
  ConfigContext,
} from './plugin.js'
import type { ProjectMeta } from '../workspace/index.js'

/** `a string`, `an array`, `null`, `a number` — for a refusal that names what came back. */
function describeValue(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'an array'
  const t = typeof v
  if (t !== 'object') return `a ${t}`
  const proto: unknown = Object.getPrototypeOf(v)
  if (proto === Object.prototype || proto === null) return 'an object'
  return `a ${(v as object).constructor?.name || 'class instance'}`
}

function isRecord(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false
  const proto: unknown = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/** Every method a `cache` hook's `RemoteCacheLayer` requires (`hasMany` is optional). */
export const REMOTE_CACHE_METHODS: readonly string[] = ['has', 'get', 'put']

/** What a capability hook handed back must be what the seam runs. */
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

/**
 * Run a capability factory with crash isolation. A throw becomes a clean
 * `UserError` naming the plugin + hook: every stage and capability resolved
 * here is load-bearing, so a broken one must abort with a clear message,
 * never silently degrade. (Telemetry sinks are the observe-only exception,
 * and telemetry-host.ts logs-and-skips them instead.)
 */
async function safe<T>(plugin: VxPlugin, hook: string, fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    // Masked here, not by whoever prints it: an embedder of `run()` and
    // a plugin's verb print it as they get it, and the throw quotes what the
    // plugin was told (a remote's reply, a header) (L-11).
    throw new UserError(
      maskedLine(
        `plugin '${plugin.name}' failed in ${hook}: ${err instanceof Error ? err.message : String(err)}`,
      ),
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
  hook: 'config' | 'discover' | 'project' | 'graph' | 'key' | 'schedule' | 'admit',
): boolean {
  for (const p of plugins) if (p[hook] !== undefined) return true
  return false
}

/**
 * An in-place stage reads nothing a hook returns: Vite's `config` hook
 * returns a partial config, and one written that way here loaded, changed
 * nothing and said nothing. Returning the object it was handed is harmless.
 */
function assertEditedInPlace(
  plugin: VxPlugin,
  hook: 'config' | 'project' | 'graph',
  returned: unknown,
  edited: unknown,
  what: string,
): void {
  if (returned === undefined || returned === edited) return
  throw new UserError(
    `plugin '${plugin.name}' failed in ${hook}: returned ${describeValue(returned)}, which core ` +
      `ignores — edit ${what} in place`,
  )
}

/** `config` stage: every plugin edits the workspace config in place. */
export async function applyConfigHooks(
  plugins: readonly VxPlugin[],
  workspace: WorkspaceConfig,
  ctx: ConfigContext,
  /** Runs after EACH plugin's edit, so a refusal can name the plugin that made it. */
  afterEach?: (plugin: VxPlugin) => void,
): Promise<void> {
  for (const plugin of plugins) {
    if (plugin.config === undefined) continue
    const returned = await safe(plugin, 'config', () => plugin.config!(workspace, ctx))
    assertEditedInPlace(plugin, 'config', returned, workspace, 'the workspace config')
    afterEach?.(plugin)
  }
}

/**
 * `discover` stage: each plugin names directories to add to `projects`,
 * seeing the ones earlier plugins added. `add` turns one entry into the
 * project it names, `added` when it is new, or refuses it. Returns every
 * entry's edges with the project and plugin they came from, for the caller
 * to resolve once every plugin has run.
 */
export async function applyDiscoverHooks(
  plugins: readonly VxPlugin[],
  projects: ProjectMeta[],
  ctx: Omit<DiscoverContext, 'projects'>,
  add: (
    entry: DiscoveredProject,
    plugin: VxPlugin,
  ) => Promise<{ meta: ProjectMeta; added: boolean }>,
): Promise<DiscoveredEdges[]> {
  const edges: DiscoveredEdges[] = []
  for (const plugin of plugins) {
    if (plugin.discover === undefined) continue
    const named = await safe(plugin, 'discover', () => plugin.discover!({ ...ctx, projects }))
    if (!Array.isArray(named)) {
      throw new UserError(
        `plugin '${plugin.name}' failed in discover: expected an array, got ${describeValue(named)}`,
      )
    }
    for (const entry of named as readonly DiscoveredProject[]) {
      const { meta, added } = await add(entry, plugin)
      if (added) projects.push(meta)
      if (entry.deps !== undefined || entry.reach !== undefined) {
        edges.push({ by: plugin.name, meta, deps: entry.deps, reach: entry.reach ?? [] })
      }
    }
  }
  return edges
}

export interface DiscoveredEdges {
  readonly by: string
  readonly meta: ProjectMeta
  /** Absent when the entry carried none; `[]` still makes the workspace an edge source. */
  readonly deps: readonly string[] | undefined
  readonly reach: readonly string[]
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
    const returned = await safe(plugin, 'project', () => plugin.project!(config, ctx))
    assertEditedInPlace(plugin, 'project', returned, config, "the project's config")
    afterEach?.(plugin)
  }
}

/**
 * `graph` stage: every plugin edits the task graph in place, then the graph
 * is checked ONCE the way the builder checks its own output (`checkGraph`:
 * each node under its own id, every dep a node, no cycle, no two tasks
 * deleting each other's outputs). A violation is reported
 * against the LAST plugin that ran: usually the one whose edit made it so,
 * but an earlier plugin's edit that a later one left in place is blamed on
 * the later one, since the structure is not checked between plugins.
 * Each node's task config is re-validated after EACH plugin (`afterEach`),
 * like the `project` stage's.
 */
export async function applyGraphHooks(
  plugins: readonly VxPlugin[],
  nodes: Map<string, TaskNode>,
  ctx: GraphHookContext,
  /** Runs after EACH plugin's edit, so a refused task config names the plugin that wrote it. */
  afterEach?: (plugin: VxPlugin) => void,
  rules?: GraphRules,
): Promise<void> {
  let last: VxPlugin | undefined
  for (const plugin of plugins) {
    if (plugin.graph === undefined) continue
    const returned = await safe(plugin, 'graph', () => plugin.graph!(nodes, ctx))
    assertEditedInPlace(plugin, 'graph', returned, nodes, 'the task graph')
    await safe(plugin, 'graph', () => checkNodeShapes(nodes))
    afterEach?.(plugin)
    last = plugin
  }
  if (last === undefined) return
  await safe(last, 'graph', () => checkGraph(nodes, ctx.workspaceRoot, rules))
}

/**
 * A hook writes the graph as plain JS: `deps = null` surfaced as "null is
 * not an object", naming no task (X-15). Checked per plugin, before its
 * edits are read, so the refusal names the plugin that wrote them.
 */
function checkNodeShapes(nodes: Map<string, TaskNode>): void {
  const what = (v: unknown): string => (v === null ? 'null' : typeof v)
  for (const [key, node] of nodes as Map<string, unknown>) {
    if (typeof node !== 'object' || node === null) {
      throw new Error(`'${key}' holds ${what(node)}, not a task`)
    }
    const deps = (node as { deps?: unknown }).deps
    if (!Array.isArray(deps)) {
      throw new Error(`${key}'s deps is ${what(deps)}, not an array of task ids`)
    }
    // A node a hook adds is read as it wrote it: one with no `projectDir`
    // ran as `internal error in a#x: TypeError: The "path" property must
    // be of type string`, and a relative one keyed and ran against
    // whatever directory vx was started in.
    const fields = node as { projectName?: unknown; taskName?: unknown; projectDir?: unknown }
    const shown = (v: unknown): string => (typeof v === 'string' ? JSON.stringify(v) : what(v))
    for (const field of ['projectName', 'taskName'] as const) {
      if (typeof fields[field] !== 'string' || fields[field] === '') {
        throw new Error(`${key}'s ${field} is ${shown(fields[field])}, not a name`)
      }
    }
    // A node copied under a new id kept the old taskName: the key read
    // the id, `--exclude-dependencies` the name, and the two disagreed.
    const id = (node as { id?: unknown }).id
    if (id !== `${fields.projectName as string}#${fields.taskName as string}`) {
      throw new Error(
        `${key}'s id is ${shown(id)}, not its projectName#taskName (${fields.projectName as string}#${fields.taskName as string})`,
      )
    }
    const dir = fields.projectDir
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) {
      throw new Error(`${key}'s projectDir is ${shown(dir)}, not an absolute path`)
    }
  }
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
      // '0', '1', '2' into every key — silently, and permanently. A Map or a
      // class instance keeps its data off own enumerable keys, so
      // `Object.entries` read it as no material at all: a silent miskey.
      if (!isRecord(material)) {
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
        // The fold joins a part as `name\0value`: a NUL in the name let
        // `{ 'a\0b': 'c' }` and `{ a: 'b\0c' }` fold the same bytes.
        if (name.includes('\0')) {
          throw new UserError(
            `plugin '${plugin.name}' failed in key: a name on ${node.id} holds a NUL, the fold's delimiter`,
          )
        }
        parts.push([`${plugin.name}/${name}`, value])
      }
    }
    if (parts.length > 0) {
      const byName = (a: readonly [string, string], b: readonly [string, string]): number =>
        a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0
      parts.sort(byName)
      // A plugin's name is its package's, and one package may define two
      // plugins (`@vzn/vx-migrate`'s `turbo()` and `turboCache()`): two
      // parts named alike folded both values under one name, and `vx why`
      // could not say which moved (item 1028). The repeats take `#2`, `#3`
      // in value order, so declaration order still keys nothing.
      let previous = ''
      let n = 0
      for (const [i, [name, value]] of parts.entries()) {
        n = name === previous ? n + 1 : 1
        previous = name
        if (n > 1) parts[i] = [`${name}#${n}`, value]
      }
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
 * The files a claimed file names that its plugin keys too
 * (`FingerprintClaim.extraFiles`); `undefined` when it names none it can
 * answer for, and a plugin that throws is refused by its name.
 */
export function claimedExtraFiles(
  plugin: VxPlugin,
  file: string,
  bytes: Uint8Array,
): readonly string[] | undefined {
  const read = plugin.fingerprint?.extraFiles
  if (read === undefined) return undefined
  let names: unknown
  try {
    names = read.call(plugin.fingerprint, file, bytes)
  } catch (err) {
    throw new UserError(
      maskedLine(
        `plugin '${plugin.name}' failed in fingerprint: ${err instanceof Error ? err.message : String(err)}`,
      ),
    )
  }
  if (!Array.isArray(names) || names.some((n) => typeof n !== 'string')) {
    throw new UserError(
      `plugin '${plugin.name}' failed in fingerprint: extraFiles returned ${describeValue(names)}, not a list of paths`,
    )
  }
  return names as string[]
}

/** What a run hands the `schedule` stage: a step per plugin, and where refined weights go. */
export interface ScheduleRun {
  readonly step?: <T>(id: string, work: () => Promise<T>) => Promise<T>
  readonly refined?: (merged: ReadonlyMap<string, number>) => void
}

/**
 * `schedule` stage: the merged priorities map (a later plugin's weight for
 * a task overrides an earlier one's). Empty when no plugin answered. Each
 * plugin's call is the step `<plugin>:schedule`. A plugin's `ctx.refine`
 * replaces its own weights and hands `refined` the merge again; with no
 * `refined` (a plan), it is ignored.
 */
export async function applyScheduleHooks(
  plugins: readonly VxPlugin[],
  nodes: ReadonlyMap<string, TaskNode>,
  ctx: Omit<ScheduleHookContext, 'cache' | 'refine' | 'onRefine' | 'refining'>,
  cacheFor: (plugin: string) => PluginCache = () => absentPluginCache,
  run: ScheduleRun = {},
): Promise<ReadonlyMap<string, number>> {
  const sets: (ReadonlyMap<string, number> | undefined)[] = []
  const listeners: { plugin: VxPlugin; i: number; listener: () => void }[] = []
  const promised = new Set<Promise<void>>()
  const refining = async (): Promise<void> => {
    while (promised.size > 0) await Promise.all(promised)
  }
  const merged = (): ReadonlyMap<string, number> => {
    const out = new Map<string, number>()
    for (const set of sets) if (set !== undefined) for (const [id, w] of set) out.set(id, w)
    return out
  }
  for (const [i, plugin] of plugins.entries()) {
    if (plugin.schedule === undefined) continue
    const refine = (
      weights: ReadonlyMap<string, number> | Promise<ReadonlyMap<string, number> | undefined>,
    ): void => {
      if (weights instanceof Promise) {
        const p: Promise<void> = weights
          .then(
            (w) => {
              if (w !== undefined) refine(w)
            },
            (err: unknown) =>
              ctx.warn(
                `[vx] plugin '${plugin.name}' failed to refine: ${err instanceof Error ? err.message : String(err)}`,
              ),
          )
          .finally(() => promised.delete(p))
        promised.add(p)
        return
      }
      if (run.refined === undefined) return
      try {
        sets[i] = scheduleWeights(plugin, weights, nodes)
      } catch (err) {
        ctx.warn(`[vx] ${err instanceof Error ? err.message : String(err)}; refine ignored`)
        return
      }
      run.refined(merged())
      for (const l of listeners) {
        if (l.i === i) continue
        try {
          l.listener()
        } catch (err) {
          ctx.warn(
            `[vx] plugin '${l.plugin.name}' failed in onRefine: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
    }
    const onRefine = (listener: () => void): void => {
      if (run.refined !== undefined) listeners.push({ plugin, i, listener })
    }
    const own = { ...ctx, cache: cacheFor(plugin.name), refine, onRefine, refining }
    const call = (): Promise<ReadonlyMap<string, number> | undefined> =>
      safe(plugin, 'schedule', () => plugin.schedule!(nodes, own))
    const weights = await (run.step === undefined
      ? call()
      : run.step(`${plugin.name}:schedule`, call))
    // A refine that landed while the call ran is the newer set.
    if (weights !== undefined) sets[i] ??= scheduleWeights(plugin, weights, nodes)
  }
  return merged()
}

/** A `schedule` answer's weights for tasks in the graph, refused by name when it is not a Map of finite numbers. */
function scheduleWeights(
  plugin: VxPlugin,
  weights: unknown,
  nodes: ReadonlyMap<string, TaskNode>,
): ReadonlyMap<string, number> {
  // Iterating a string destructures its characters into `[id, w]` pairs
  // that match no task — a plugin returning `'fast'` used to be a no-op
  // with no word said.
  if (!(weights instanceof Map)) {
    throw new UserError(
      `plugin '${plugin.name}' failed in schedule: returned ${describeValue(weights)}, not a Map of task id → weight`,
    )
  }
  const out = new Map<string, number>()
  for (const [id, w] of weights as Map<unknown, unknown>) {
    if (typeof id !== 'string' || !nodes.has(id)) continue
    if (typeof w !== 'number' || !Number.isFinite(w)) {
      throw new UserError(
        `plugin '${plugin.name}' failed in schedule: weight for ${id} is not a finite number`,
      )
    }
    out.set(id, w)
  }
  return out
}

/**
 * `admit` stage, built once per run into the predicate the scheduler asks
 * at every local dispatch: every plugin that answers must admit. A plugin
 * that throws is reported once and admits from then on — a policy never
 * breaks a run — and one that refuses while nothing local is running is
 * overridden with a word, since only a completion asks again: that
 * refusal stalled the run for good (item 1023). So the predicate is never
 * the reason a task hangs.
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
  const overridden = new Set<VxPlugin>()
  return (id, running) => {
    // The scheduler asks only about ids in this same map, so the lookup
    // always lands: an unknown-id arm here was deleted with the whole core
    // suite green (item 651).
    const task = nodes.get(id)!
    const ctx = {
      running: [...running].flatMap((r) => nodes.get(r) ?? []),
      concurrency,
    }
    for (const plugin of answering) {
      if (broken.has(plugin)) continue
      try {
        const verdict: unknown = plugin.admit!(task, ctx)
        // An `async admit` answers a Promise: truthy, so it admitted every
        // task and its policy never ran, and its rejection was unhandled and
        // ended the run with a stack (H-16). Named once, admitting after.
        if (verdict instanceof Promise) {
          verdict.catch(() => {})
          throw new Error('returned a Promise; admit is synchronous')
        }
        if (verdict !== false) continue
        if (running.size > 0) return false
        if (!overridden.has(plugin)) {
          overridden.add(plugin)
          warn(
            `[vx] plugin '${plugin.name}' refused ${id} in admit with nothing running; admitting it, since no completion would ask again`,
          )
        }
      } catch (err) {
        broken.add(plugin)
        const m = err instanceof Error ? err.message : String(err)
        warn(
          `[vx] plugin '${plugin.name}' failed in admit: ${m}; admitting every task from here on`,
        )
      }
    }
    return true
  }
}

/** What `resolveCache` needs beyond a hook's context: the store and policy core owns. */
export interface CacheHost extends CacheContext {
  readonly localCache: Cache
  readonly policy: CachePolicy
  /** Filled with each remote and what its policy lets it do, for the plugins' `ctx.cache`. */
  readonly remotes?: ResolvedRemote[]
  /** Uploads at once, per remote (`cache.concurrency.upload`). */
  readonly uploadConcurrency?: number
  /** What another machine's run lent, by plugin: each plugin's `ctx.lent`. */
  readonly lentBy?: () => Readonly<Record<string, string>> | undefined
}

/**
 * Collect every plugin's remote (`cache` hook) in declaration order and
 * layer each over the local store: a lookup asks the local store first,
 * then each remote in order (2026-10-13), and a save reaches every
 * remote. The run's policy alone gates each remote (2026-10-16: a
 * plugin moves bytes, it never decides reads or writes); a remote's throw is a miss and a warning naming its plugin. No
 * remote → the local store alone.
 */
export async function resolveCache(
  plugins: readonly VxPlugin[],
  host: CacheHost,
): Promise<CacheLayer> {
  const { localCache, policy, remotes, uploadConcurrency, lentBy, ...base } = host
  const resolved: ResolvedRemote[] = []
  for (const plugin of plugins) {
    if (plugin.cache === undefined) continue
    const ctx: CacheContext =
      lentBy === undefined ? base : { ...base, lent: () => lentBy()?.[plugin.name] }
    const remote = await safe(plugin, 'cache', () => plugin.cache!(ctx))
    if (remote === undefined) continue
    assertShape(plugin, 'cache', remote, REMOTE_CACHE_METHODS, 'a remote cache layer')
    const entry: ResolvedRemote = {
      remote,
      plugin: plugin.name,
      read: policy.remoteRead,
      write: policy.remoteWrite,
      onError: (err) => ctx.warn(`[vx] plugin '${plugin.name}': ${err.message}`),
    }
    resolved.push(entry)
    remotes?.push(entry)
  }
  return resolved.length === 0
    ? localCache
    : new LayeredCache(localCache, resolved, uploadConcurrency)
}

/** The plugin each resolved executor came from, so a hook of it that throws is named. */
const executorPlugin = new WeakMap<TaskExecutor, string>()

/**
 * A plugin executor's throw from `execute`, named as every other hook's
 * is: `plugin 'p' (executor 'e') failed in execute: …`. It read `internal
 * error in <task>: pool down`, naming neither (C-63). A refusal, as
 * `safe()` makes every stage's throw: the plugin is named, so it is not
 * vx's bug, and an `internal error` line said it was (C-85). A fresh error
 * with the plugin's as its cause, never the plugin's own renamed: one
 * error an executor rejects every task with was named once per task
 * (C-74). The floor's own throw is vx's and stays as it is.
 */
export function nameExecutorFailure(executor: TaskExecutor, err: unknown): unknown {
  if (!executorPlugin.has(executor)) return err
  const named = new UserError(
    `${executorLabel(executor)} failed in execute: ${err instanceof Error ? err.message : String(err)}`,
  )
  named.cause = err
  return named
}

/** How a message names `executor`: its plugin and its own name, or its name alone (the floor). */
export function executorLabel(executor: TaskExecutor): string {
  const plugin = executorPlugin.get(executor)
  return plugin === undefined
    ? `executor '${executor.name}'`
    : `plugin '${plugin}' (executor '${executor.name}')`
}

/** What `executorDemand` returns: the run's three calls into it. */
export interface ExecutorDemand {
  /** Whether any executor asked: with none, every call does nothing. */
  readonly any: boolean
  /** A task finished: dropped, and its executor told once demand settled. */
  finished(id: string): void
  /**
   * The placed tasks the run's cache answers: dropped, and each executor
   * told its demand for the first time. Before it a finish narrows
   * silently, so an executor never sizes for what restores. The first
   * call counts; the rest do nothing.
   */
  settle(hits: Iterable<string>, missed?: Iterable<string>): void
  /** A task about to execute: back in if `settle` dropped it (its artifact was gone). */
  executing(id: string): void
}

const NO_DEMAND: ExecutorDemand = {
  any: false,
  finished: () => {},
  settle: () => {},
  executing: () => {},
}

/**
 * Demand: what each executor still has left to run. An executor that
 * provisions per task (a container, an allocation, a pod) otherwise has to
 * guess from `capacity` alone and hold everything until teardown. Built
 * ONLY for executors that asked: with none declared there is no map, no
 * set, and every call does nothing.
 *
 * The SAME set is handed back every time, narrowed in place: a consumer
 * reading it later sees the truth rather than a stale snapshot. A hint,
 * as `admit` is: one that throws is named once and asked no more, where
 * it surfaced as a bare stack, or mid-run from the completion path
 * (item 1022).
 */
export function executorDemand(
  placed: ReadonlyMap<string, TaskExecutor>,
  warn: (message: string) => void,
): ExecutorDemand {
  const demandOf = new Map<TaskExecutor, Set<string>>()
  for (const [id, executor] of placed) {
    if (executor.demand === undefined) continue
    let remaining = demandOf.get(executor)
    if (remaining === undefined) demandOf.set(executor, (remaining = new Set()))
    remaining.add(id)
  }
  if (demandOf.size === 0) return NO_DEMAND
  // Of the placed tasks, those the cache was asked and holds nowhere.
  const missed = new Set<string>()
  const tell = (executor: TaskExecutor, remaining: ReadonlySet<string>): void => {
    const failed = (err: unknown): void => {
      if (!demandOf.delete(executor)) return
      const m = err instanceof Error ? err.message : String(err)
      warn(`[vx] ${executorLabel(executor)} failed in demand: ${m}; not asked again this run`)
    }
    try {
      // An `async demand` that rejects did so where no one listened: an
      // unhandled rejection, a stack, the run killed. Its rejection is a
      // throw like any other.
      const ret: unknown = executor.demand!(remaining, missed)
      if (ret instanceof Promise) ret.catch(failed)
    } catch (err) {
      failed(err)
    }
  }
  let settled = false
  const done = new Set<string>()
  const ran = new Set<string>()
  const dropped = new Set<string>()
  return {
    any: true,
    finished(id) {
      done.add(id)
      missed.delete(id)
      for (const [executor, remaining] of demandOf) {
        if (remaining.delete(id) && settled) tell(executor, remaining)
      }
    },
    settle(hits, misses = []) {
      if (settled) return
      settled = true
      for (const id of misses) if (placed.has(id) && !done.has(id)) missed.add(id)
      for (const id of hits) {
        if (ran.has(id) || done.has(id)) continue
        const executor = placed.get(id)
        if (executor !== undefined && demandOf.get(executor)?.delete(id)) dropped.add(id)
      }
      for (const [executor, remaining] of demandOf) tell(executor, remaining)
    },
    executing(id) {
      ran.add(id)
      if (!dropped.delete(id)) return
      const executor = placed.get(id)!
      const remaining = demandOf.get(executor)
      if (remaining === undefined) return
      remaining.add(id)
      tell(executor, remaining)
    },
  }
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
    // The pool's room is `active < capacity`: 0 or NaN parks its tasks for good.
    const capacity: unknown = executor.capacity
    if (capacity !== undefined && !(Number.isInteger(capacity) && (capacity as number) > 0)) {
      throw new UserError(
        `plugin '${plugin.name}' returned executor '${executor.name}' with capacity ${typeof capacity === 'number' ? String(capacity) : JSON.stringify(capacity)}: it must be a positive integer`,
      )
    }
    const platforms: unknown = executor.platforms
    if (
      platforms !== undefined &&
      !(
        Array.isArray(platforms) &&
        platforms.length > 0 &&
        platforms.every((p) => (PLATFORMS as readonly unknown[]).includes(p))
      )
    ) {
      throw new UserError(
        `plugin '${plugin.name}' returned executor '${executor.name}' with platforms ${JSON.stringify(platforms)}: it must be a non-empty array of ${PLATFORMS.join(', ')}`,
      )
    }
    executorPlugin.set(executor, plugin.name)
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
 * declaration order, a plugin that supplies a remote cache after every
 * other: a teardown may write through the cache (`RunReport`), and one
 * that revoked its token first refused the write (main 7bdbf01: the
 * schedule's timings, put after the Vercel token's revoke). Crash-isolated — a throwing teardown is logged and
 * skipped, never propagated — and each call is time-bounded by
 * {@link teardownTimeoutMs}. Runs on every exit of a run once its plugins'
 * factories ran, and of a plan (item 1021); the finally-path disposers
 * just unsubscribe. (Telemetry sinks flush before this, in
 * telemetry-host.ts, with the same reporting rule.)
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
  report?: RunReport,
  step: <T>(id: string, work: () => Promise<T>) => Promise<T> = (_id, work) => work(),
): Promise<void> {
  const last = (p: VxPlugin): number => (p.cache === undefined ? 0 : 1)
  for (const plugin of plugins.toSorted((a, b) => last(a) - last(b))) {
    if (plugin.teardown === undefined) continue
    const ms = teardownTimeoutMs()
    try {
      const settled = await step(`${plugin.name}:teardown`, () =>
        settleWithin(Promise.resolve(plugin.teardown?.(report)), ms),
      )
      // Same rule as the flush above. A teardown that never settles has left
      // whatever it owns un-released, and the run exits anyway — silence would
      // present that as a clean shutdown.
      if (!settled) {
        warn(`[vx] plugin '${plugin.name}' teardown timed out after ${ms}ms; it did not complete`)
      }
    } catch (err) {
      warn(
        `[vx] plugin '${plugin.name}' failed in teardown: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
}
