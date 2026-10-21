import {
  definePlugin,
  LocalHistoryProvider,
  refuseUnknownOptions,
  UserError,
  type PluginOptionKinds,
  type TaskNode,
  type TaskResources,
} from '@vzn/vx'
import type { Orchestrator } from './orchestrator.js'

/** One kind of agent the CI can start. */
export interface AgentSize {
  /** How many of it one run may start. */
  readonly max: number
  /** Its cores: what starting one adds, until it reports what its machine has. */
  readonly cpu: number
}

/** What an adapter is asked to start: one agent of `size`. */
export interface AgentSpawn {
  readonly run: string
  readonly relay: string
  readonly size: string
  /** 1 for the first agent this run starts, counting every size. */
  readonly index: number
  readonly workspaceRoot: string
  /** What the agent's `vx dte agent` reads: `VX_DTE_RUN`, `VX_DTE_SIZE`, `VX_DTE_RELAY`. */
  readonly env: Readonly<Record<string, string>>
}

/** How one CI starts agents: `gitlab()`, `local()`. */
export interface DteAdapter {
  /** A relay of its own, for a run whose `dte()` names none. */
  relay?(): Promise<string>
  spawn(agent: AgentSpawn): void | Promise<void>
  /** At run end: stop what it started. */
  close?(): void | Promise<void>
}

export interface DteOptions {
  readonly agents: Readonly<Record<string, AgentSize>>
  readonly adapter: DteAdapter
  /** The relay's URL; absent, the adapter's own. */
  readonly relay?: string
  /** Tasks the orchestrator's own machine runs at once beside the agents (default: the run's worker count). */
  readonly local?: number
  /** The bearer token for the relay (default `VX_DTE_TOKEN`). */
  readonly token?: () => string | undefined | Promise<string | undefined>
}

const KEYS: PluginOptionKinds<DteOptions> = {
  agents: 'object',
  adapter: 'object',
  relay: 'string',
  local: 'number',
  token: 'function',
}

export function dte(options: DteOptions) {
  refuseUnknownOptions('dte()', options, KEYS)
  const sizes = Object.entries(options.agents ?? {})
  for (const [name, s] of sizes) {
    if (!(Number.isInteger(s?.max) && s.max >= 0 && Number.isInteger(s.cpu) && s.cpu >= 1)) {
      throw new UserError(`dte(): agents.${name} needs a whole max ≥ 0 and cpu ≥ 1`)
    }
  }
  if (typeof options.adapter?.spawn !== 'function') {
    throw new UserError('dte(): adapter is an adapter, such as local()')
  }
  if (options.local !== undefined && !(Number.isInteger(options.local) && options.local >= 0)) {
    throw new UserError('dte(): local is a whole number ≥ 0')
  }
  const token = async (): Promise<string | undefined> =>
    (await options.token?.()) ?? process.env['VX_DTE_TOKEN']

  let nodes: ReadonlyMap<string, TaskNode> | undefined
  let peaks: ReadonlyMap<string, TaskResources> = new Map()
  let orchestrator: Orchestrator | undefined
  let closing: Promise<void> | undefined

  const close = async (): Promise<void> => {
    const o = orchestrator
    orchestrator = undefined
    nodes = undefined
    peaks = new Map()
    await o?.close()
    await options.adapter.close?.()
  }

  return definePlugin(import.meta, {
    commands: {
      dte: {
        description: 'dte agent: run tasks for a distributed run (VX_DTE_RUN, VX_DTE_SIZE)',
        async run(argv, ctx) {
          if (argv[0] !== 'agent' || argv.length > 1) {
            throw new UserError('Usage: vx dte agent')
          }
          const run = process.env['VX_DTE_RUN']
          const size = process.env['VX_DTE_SIZE'] ?? ''
          const relay = process.env['VX_DTE_RELAY'] ?? options.relay
          const agent = options.agents[size]
          if (run === undefined || relay === undefined || agent === undefined) {
            throw new UserError(
              `vx dte agent needs VX_DTE_RUN, VX_DTE_SIZE (one of ${sizes.map(([n]) => n).join(', ')}) and a relay`,
            )
          }
          const { runAgent } = await import('./agent.js')
          return runAgent({
            relay,
            run,
            size,
            root: ctx.workspaceRoot,
            token: await token(),
            log: (line) => console.error(line),
          })
        },
      },
    },

    async schedule(graph, ctx) {
      nodes = graph
      // A run that is not distributed reads nothing.
      if (orchestrator === undefined) return undefined
      try {
        const ids = [...graph.values()]
          .filter((n) => n.config.exec?.command !== undefined)
          .map((n) => n.id)
        peaks = await new LocalHistoryProvider(
          ctx.localCache.dbHandle(),
          undefined,
          ctx.branch,
        ).resourcesFor(ids)
      } catch (err) {
        ctx.warn(
          `dte: tasks are packed one core each: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      return undefined
    },

    async executor(ctx) {
      await closing
      const run = process.env['VX_DTE_RUN']
      if (run === undefined || run === '') return undefined
      const relay = options.relay ?? (await options.adapter.relay?.())
      if (relay === undefined)
        throw new UserError('dte(): no relay: set relay, or use an adapter that has one')
      const commit = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: ctx.workspaceRoot })
      if (commit.exitCode !== 0) throw new UserError('dte(): a distributed run needs a git commit')
      const [{ Orchestrator }, { join }] = await Promise.all([
        import('./orchestrator.js'),
        import('./wire.js'),
      ])
      const localSlots = options.local ?? ctx.concurrency
      const o = new Orchestrator({
        me: await join(relay, run, 'orchestrator', null, await token()),
        root: ctx.workspaceRoot,
        commit: commit.stdout.toString().trim(),
        localSlots,
        nodes: () => nodes,
        need: (id) => {
          const r = peaks.get(id)
          return {
            cores: Math.max(1, Math.ceil(r?.maxCpuParallelism ?? 1)),
            memory: r?.maxPeakRssBytes ?? 0,
          }
        },
      })
      orchestrator = o
      const started = new Map<string, number>()
      let index = 0
      let slots = 0
      return {
        name: 'dte',
        remote: true,
        // Room for what agents report beyond their size and the prefetch;
        // the orchestrator holds the rest.
        capacity: Math.max(1, localSlots + sizes.reduce((n, [, s]) => n + 2 * s.max * s.cpu, 0)),
        execute: (req) => o.execute(req),
        // Agents for what this machine's share cannot take, largest
        // declared first; none are stopped before the run ends.
        demand(remaining) {
          for (const [size, s] of sizes) {
            while (slots < remaining.size - localSlots && (started.get(size) ?? 0) < s.max) {
              started.set(size, (started.get(size) ?? 0) + 1)
              slots += s.cpu
              index++
              void Promise.resolve(
                options.adapter.spawn({
                  run,
                  relay,
                  size,
                  index,
                  workspaceRoot: ctx.workspaceRoot,
                  env: { VX_DTE_RUN: run, VX_DTE_SIZE: size, VX_DTE_RELAY: relay },
                }),
              ).catch((err: unknown) =>
                ctx.warn(`dte: could not start a ${size} agent: ${String(err)}`),
              )
            }
          }
        },
      }
    },

    async teardown() {
      closing = close()
      await closing
    },
  })
}
