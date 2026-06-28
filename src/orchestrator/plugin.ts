// Plugin API — in-process extensions on top of the run event bus.
//
// Collapses what `architecture-review-2026-06.md §4.1` calls the
// in-process subscriber + the WS subscriber into ONE Plugin contract.
// Users register plugins via defineWorkspace({ plugins }); each plugin
// receives a PluginContext with the bus + workspace metadata and can
// install lifecycle hooks. Plugins observe; they do not redirect.
//
// Crash isolation: a plugin that throws on setup() is wrapped in a
// UserError-style failure message naming the plugin (clean abort, no
// stack), matching the existing 'broken vx.config.ts' error style. A
// plugin that throws inside a hook is logged + the plugin is disabled
// for the remainder of the run (mirrors the deleted Observer's
// makeSafeObserver pattern; surfaces are isolated from execution).
//
// Hook return values: today every hook is fire-and-forget (the bus IS
// the message pipe; hooks just give users an ergonomic place to read
// it). One write-capable hook is reserved for a future iteration —
// onCacheLookup returning { skip: true } — but not in v1.

import type { Cache, CacheLayer, CachePolicy } from '../cache/index.js'
import type { TaskNode, TaskOutcome } from '../graph/index.js'
import { UserError } from '../util/index.js'
import type { EventBus, RunStartInfo, WireEvent } from './events.js'
import type { RunBackend, RunRequest } from './protocol.js'
import type { TelemetryContext, TelemetrySink } from './telemetry.js'

/**
 * A vx plugin. Contributes any subset of three RUN-LEVEL infrastructure
 * capabilities — where work routes (backend), which cache is used (cache),
 * who observes the run (eventSink). It NEVER changes how a task executes
 * (Architecture principle #3: shell is the API). Registered explicitly in
 * vx.workspace.ts via defineWorkspace({ plugins: [...] }). No auto-discovery.
 *
 * The old observe-only `Plugin` (`{ name, setup(ctx) }`) is a subset of
 * this shape: a plugin with only `setup` installs and runs exactly as
 * before via `installPlugins`. The new capabilities are consulted by
 * `plugin-host.ts`, each falling back to today's default.
 */
export interface VxPlugin {
  /** Stable identifier, convention `'org/name'`. Used in errors + precedence logs. */
  readonly name: string

  // --- BEHAVIOR capabilities (change WHAT/HOW work runs — opt-in) -----------

  /**
   * Contribute a run backend. Returns a RunBackend (run(request) → result),
   * or undefined to decline (core then tries the next plugin, else the
   * fallback). Consulted ONCE per run, before scheduling. At most one
   * plugin's backend is used (first non-undefined, in declaration order).
   */
  backend?(ctx: BackendContext): RunBackend | undefined | Promise<RunBackend | undefined>

  /**
   * Contribute a cache layer. Returns a CacheLayer wrapping (or replacing)
   * the local Cache, or undefined to decline. Consulted ONCE per prepareRun.
   * Precedence: first non-undefined plugin cache wins; else core's env-var
   * Turbo-wire LayeredCache; else the bare local Cache.
   */
  cache?(ctx: CacheContext): CacheLayer | undefined | Promise<CacheLayer | undefined>

  // --- OBSERVE-ONLY capability (cannot change behavior — by construction) ---

  /**
   * Contribute one or more telemetry sinks — the canonical data-export path.
   * A sink receives versioned `TelemetryRecord` / `RunSummaryRecord` values
   * and holds NO run handle (no bus, no cache, no request), so it provably
   * cannot change what or how tasks run. ALL plugins' sinks are active at
   * once (additive); a throwing/slow sink is isolated and can never fail or
   * stall a run. This is THE export contract OTel, the manual HTTP API, and
   * vx-cloud all speak. See docs/design/observability-architecture-2026-06.md.
   */
  telemetry?(
    ctx: TelemetryContext,
  ):
    | TelemetrySink
    | TelemetrySink[]
    | undefined
    | Promise<TelemetrySink | TelemetrySink[] | undefined>

  /**
   * @deprecated Prefer `telemetry`. Contribute an event sink — a consumer of
   * the serializable WireEvent stream, subscribed for the whole run via
   * wireForwarder. Fire-and-forget; a throwing sink is isolated and cannot
   * break the run. Kept as a back-compat path; `telemetry` is the canonical,
   * analytics-shaped export contract.
   */
  eventSink?(ctx: EventSinkContext): EventSink | undefined | Promise<EventSink | undefined>

  /**
   * Optional one-time setup before any capability is consulted (validate the
   * workspace, open a connection, read a token). Throwing aborts the run with
   * a clean UserError naming the plugin — same contract as the old setup().
   */
  setup?(ctx: PluginSetupContext): void | Promise<void>

  /** Optional teardown at end-of-run (flush a sink, close a socket). Errors are logged, never thrown. */
  teardown?(): void | Promise<void>
}

/** A WireEvent consumer. onEvent is fire-and-forget; flush is awaited at teardown. */
export interface EventSink {
  onEvent(event: WireEvent): void
  flush?(): Promise<void>
}

/** Shared, read-only context every capability factory receives. */
interface BaseContext {
  readonly workspaceRoot: string
  readonly cacheDir: string
  /** Funnel warnings into the run:status channel (framed output). */
  warn(message: string): void
}

export interface PluginSetupContext extends BaseContext {}
export interface EventSinkContext extends BaseContext {}

export interface BackendContext extends BaseContext {
  /** The resolved RunRequest about to be executed — cwd, tasks, policy, flow. */
  readonly request: RunRequest
}

export interface CacheContext extends BaseContext {
  /** The local Cache handle the plugin may wrap (LayeredCache(local, remote)). */
  readonly localCache: Cache
  /** The run's cache policy (the 4 read/write axes). */
  readonly policy: CachePolicy
}

export interface PluginContext {
  /** Where the workspace lives on disk. */
  readonly workspaceRoot: string
  /** Where vx's cache lives — read-only as far as the plugin is concerned. */
  readonly cacheDir: string
  /** The run event bus. A plugin can subscribe directly if its needs exceed the hooks. */
  readonly bus: EventBus
  /**
   * Convenience: register a typed handler keyed off `RunEvent.kind`.
   * Multiple hooks can chain via repeated calls.
   */
  on<K extends PluginHookName>(hook: K, handler: PluginHookHandlers[K]): void
}

export type PluginHookName =
  | 'onRunStart'
  | 'onTaskStart'
  | 'onTaskStdout'
  | 'onTaskStderr'
  | 'onTaskComplete'
  | 'onRunStatus'
  | 'onRunEnd'

export interface PluginHookHandlers {
  onRunStart: (info: RunStartInfo) => void | Promise<void>
  onTaskStart: (node: TaskNode) => void | Promise<void>
  onTaskStdout: (node: TaskNode, chunk: string) => void | Promise<void>
  onTaskStderr: (node: TaskNode, chunk: string) => void | Promise<void>
  onTaskComplete: (node: TaskNode, outcome: TaskOutcome) => void | Promise<void>
  onRunStatus: (line: string) => void | Promise<void>
  onRunEnd: () => void | Promise<void>
}

export interface Plugin {
  /** Logged on errors; the convention is `'org/plugin-name'`. */
  readonly name: string
  /**
   * Called once at the start of every run. Register hooks via
   * `ctx.on(name, fn)` or subscribe to `ctx.bus` directly. Returning
   * a promise lets a plugin do async setup; the bus subscription must
   * be installed synchronously inside setup() so no events are missed.
   *
   * OPTIONAL: a capability-only plugin (one that contributes
   * `backend`/`cache`/`eventSink` but no `setup`) is simply skipped by
   * `installPlugins` — its capabilities are consulted by `plugin-host.ts`.
   */
  setup?(ctx: PluginContext): void | Promise<void>
}

export interface InstallPluginsArgs {
  plugins: readonly Plugin[]
  workspaceRoot: string
  cacheDir: string
  bus: EventBus
  /**
   * Where plugin-throw warnings go. Defaults to console.error; passing
   * a callback lets the orchestrator funnel into the framed-output
   * `run:status` channel.
   */
  warn?: (message: string) => void
}

/**
 * Install every plugin's `setup` hook against a shared bus + context.
 * Synchronous loop; setup() promises are awaited in order so a plugin's
 * hooks are subscribed before the next plugin's setup runs. Throws if any
 * plugin's setup() throws (the run cannot start with a broken plugin).
 *
 * A plugin without a `setup` is a capability-only plugin (backend / cache
 * / eventSink) — skipped here; those capabilities are consulted by
 * `plugin-host.ts`.
 */
export async function installPlugins(args: InstallPluginsArgs): Promise<() => void> {
  const { plugins, bus, workspaceRoot, cacheDir } = args
  const warn = args.warn ?? ((m) => console.error(m))
  const disposers: Array<() => void> = []
  const disabled = new Set<string>()

  for (const plugin of plugins) {
    if (typeof plugin.name !== 'string' || plugin.name.length === 0) {
      throw new UserError('plugin missing `name` field')
    }
    // No setup → a capability-only plugin (backend / cache / eventSink),
    // consulted by plugin-host.ts; skip the hook install. A setup that's
    // present but not callable is a real authoring error — reject it.
    if (plugin.setup === undefined) continue
    if (typeof plugin.setup !== 'function') {
      throw new UserError(`plugin '${plugin.name}' setup is not a function`)
    }

    const ctx: PluginContext = {
      workspaceRoot,
      cacheDir,
      bus,
      on(hook, handler) {
        const dispose = bus.subscribe((event) => {
          if (disabled.has(plugin.name)) return
          // void each handler call: hooks may return Promise; we
          // intentionally don't await (the bus is synchronous;
          // long-running plugin work happens off the critical path).
          try {
            switch (hook) {
              case 'onRunStart':
                if (event.kind === 'run:start')
                  void (handler as PluginHookHandlers['onRunStart'])(event.info)
                break
              case 'onTaskStart':
                if (event.kind === 'task:start')
                  void (handler as PluginHookHandlers['onTaskStart'])(event.node)
                break
              case 'onTaskStdout':
                if (event.kind === 'task:stdout')
                  void (handler as PluginHookHandlers['onTaskStdout'])(event.node, event.chunk)
                break
              case 'onTaskStderr':
                if (event.kind === 'task:stderr')
                  void (handler as PluginHookHandlers['onTaskStderr'])(event.node, event.chunk)
                break
              case 'onTaskComplete':
                if (event.kind === 'task:complete')
                  void (handler as PluginHookHandlers['onTaskComplete'])(event.node, event.outcome)
                break
              case 'onRunStatus':
                if (event.kind === 'run:status')
                  void (handler as PluginHookHandlers['onRunStatus'])(event.line)
                break
              case 'onRunEnd':
                if (event.kind === 'run:end') void (handler as PluginHookHandlers['onRunEnd'])()
                break
            }
          } catch (err) {
            disabled.add(plugin.name)
            warn(
              `[vx] plugin '${plugin.name}' threw in ${hook}; disabled for this run: ${err instanceof Error ? err.message : String(err)}`,
            )
          }
        })
        disposers.push(dispose)
      },
    }

    try {
      await plugin.setup(ctx)
    } catch (err) {
      throw new UserError(
        `plugin '${plugin.name}' failed to load: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  return () => {
    for (const d of disposers) d()
  }
}
