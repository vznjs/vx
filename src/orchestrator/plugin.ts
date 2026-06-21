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

import type { TaskNode, TaskOutcome } from '../graph/index.js'
import { UserError } from '../util/index.js'
import type { EventBus, RunStartInfo } from './events.js'

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
   */
  setup(ctx: PluginContext): void | Promise<void>
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
 * Install every plugin against a shared bus + context. Synchronous
 * loop; setup() promises are awaited in order so a plugin's hooks are
 * subscribed before the next plugin's setup runs. Throws if any
 * plugin's setup() throws (the run cannot start with a broken plugin).
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
    if (typeof plugin.setup !== 'function') {
      throw new UserError(`plugin '${plugin.name}' missing setup() function`)
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
