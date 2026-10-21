import {
  definePlugin,
  LocalHistoryProvider,
  refuseUnknownOptions,
  UserError,
  type PluginOptionKinds,
  type TaskNode,
  type TaskResources,
} from '@vzn/vx'
import type { Need, Orchestrator } from './orchestrator.js'

/** One kind of agent the adapter can start. */
export interface AgentSize {
  /** How many of it one run may start; absent, as many as the work needs. */
  readonly max?: number
  /** Its cores and memory (bytes, or `'8GB'`): what starting one adds, until it reports what its machine has. */
  readonly cpu: number
  readonly memory: number | string
}

/** What an adapter is asked to start: one agent of `size`. */
export interface AgentSpawn {
  readonly run: string
  readonly relay: string
  readonly size: string
  /** Its size's cores and memory (bytes), for an adapter that sets a machine's limits. */
  readonly cpu: number
  readonly memory: number
  /** 1 for the first agent this run starts, counting every size. */
  readonly index: number
  /** Its name in the run's output and its own (`small#2`), which it reports back on joining. */
  readonly id: string
  readonly workspaceRoot: string
  /** What the agent's `vx dte agent` reads: `VX_DTE_RUN`, `VX_DTE_AGENT` (`id`), `VX_DTE_RELAY`. */
  readonly env: Readonly<Record<string, string>>
  /** Says the agent ended before or without joining, and why (its exit, its last stderr line). */
  readonly exited: (reason: string) => void
}

/** How one CI starts agents: `local()`, `docker()`. */
export interface DteAdapter {
  /** A relay of its own, for a run whose `dte()` names none. */
  relay?(): Promise<string>
  spawn(agent: AgentSpawn): void | Promise<void>
  /** At run end: stop what it started. */
  close?(): void | Promise<void>
}

export interface DteOptions {
  /** What the adapter may start, by size name. */
  readonly agents?: Readonly<Record<string, AgentSize>>
  /** Starts agents; absent, the run uses the agents that join it, which needs `relay`. */
  readonly adapter?: DteAdapter
  /** The relay's URL; absent, the adapter's own. */
  readonly relay?: string
  /** Tasks the orchestrator's own machine runs at once beside the agents (default 0: agents run them all). */
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
  const sizes = Object.entries(options.agents ?? {}).map(([name, s]) => {
    const memory = bytes(s?.memory)
    if (
      !(
        (s?.max === undefined || (Number.isInteger(s.max) && s.max >= 0)) &&
        Number.isInteger(s?.cpu) &&
        s.cpu >= 1
      ) ||
      memory === undefined
    ) {
      throw new UserError(
        `dte(): agents.${name} needs cpu ≥ 1, memory such as '8GB', and a whole max ≥ 0 if any`,
      )
    }
    return { name, max: s.max ?? Infinity, cpu: s.cpu, memory }
  })
  const adapter = options.adapter
  if (adapter !== undefined && typeof adapter.spawn !== 'function') {
    throw new UserError('dte(): adapter is an adapter, such as local()')
  }
  if (adapter === undefined && options.relay === undefined) {
    throw new UserError('dte(): with no adapter, set relay: the agents that join it run the tasks')
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
    await adapter?.close?.()
  }

  return definePlugin(import.meta, {
    commands: {
      dte: {
        description: 'dte agent: run tasks for a distributed run (VX_DTE_RUN, VX_DTE_RELAY)',
        async run(argv, ctx) {
          if (argv[0] !== 'agent' || argv.length > 1) {
            throw new UserError('Usage: vx dte agent')
          }
          const run = process.env['VX_DTE_RUN']
          const relay = process.env['VX_DTE_RELAY'] ?? options.relay
          if (run === undefined || run === '' || relay === undefined) {
            throw new UserError('vx dte agent needs VX_DTE_RUN, and VX_DTE_RELAY or dte({ relay })')
          }
          const { runAgent } = await import('./agent.js')
          const id = process.env['VX_DTE_AGENT']
          return runAgent({
            relay,
            run,
            ...(id === undefined || id === '' ? {} : { id }),
            root: ctx.workspaceRoot,
            token: await token(),
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
      const relay = options.relay ?? (await adapter?.relay?.())
      if (relay === undefined)
        throw new UserError('dte(): no relay: set relay, or use an adapter that has one')
      const commit = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: ctx.workspaceRoot })
      if (commit.exitCode !== 0) throw new UserError('dte(): a distributed run needs a git commit')
      const [{ Orchestrator }, { join }, { busyCores }] = await Promise.all([
        import('./orchestrator.js'),
        import('./wire.js'),
        import('./width.js'),
      ])
      const localSlots = options.local ?? 0
      const need = (id: string): Need => {
        const r = peaks.get(id)
        // Unmeasured: a whole agent, until its first run measures it.
        if (r?.maxCpuParallelism === undefined) return { cores: Infinity, memory: Infinity }
        return {
          cores: Math.max(1, Math.ceil(r.maxCpuParallelism)),
          memory: r.maxPeakRssBytes ?? 0,
        }
      }
      const o = new Orchestrator({
        me: await join(relay, run, 'orchestrator', null, await token()),
        root: ctx.workspaceRoot,
        commit: commit.stdout.toString().trim(),
        localSlots,
        nodes: () => nodes,
        need,
      })
      orchestrator = o
      const started = new Map<string, number>()
      let index = 0
      let cores = 0
      return {
        name: 'dte',
        remote: true,
        sandbox: true,
        // Room for what agents report beyond their size and the prefetch;
        // the orchestrator holds the rest. Agents that join on their own
        // are as many as join.
        capacity:
          adapter === undefined || sizes.some((s) => s.max === Infinity)
            ? localSlots + JOINED_CAPACITY
            : Math.max(1, localSlots + sizes.reduce((n, s) => n + 2 * s.max * s.cpu, 0)),
        execute: (req) => o.execute(req),
        footer: () => o.footer(),
        running: (id) => o.where(id),
        // Agents in declared order for the cores the remaining tasks keep
        // busy (`busyCores`) beyond this machine's share; none are stopped
        // before the run ends.
        demand(remaining) {
          if (adapter === undefined) return
          // An unmeasured task takes the biggest agent there is.
          const biggest = Math.max(...sizes.map((s) => s.cpu))
          const wantCores =
            busyCores(
              remaining,
              nodes ?? new Map(),
              (id) => Math.min(need(id).cores, biggest),
              (id) => peaks.get(id)?.p50DurationMs,
            ) - localSlots
          for (const s of sizes) {
            while (cores < wantCores && (started.get(s.name) ?? 0) < s.max) {
              started.set(s.name, (started.get(s.name) ?? 0) + 1)
              cores += s.cpu
              const id = `${s.name}#${++index}`
              o.spawned(id, { size: s.name, cpu: s.cpu, memory: s.memory })
              void Promise.resolve(
                adapter.spawn({
                  run,
                  relay,
                  size: s.name,
                  cpu: s.cpu,
                  memory: s.memory,
                  index,
                  id,
                  workspaceRoot: ctx.workspaceRoot,
                  env: { VX_DTE_RUN: run, VX_DTE_AGENT: id, VX_DTE_RELAY: relay },
                  exited: (reason) => o.failed(id, reason),
                }),
              ).catch((err: unknown) =>
                o.failed(id, err instanceof Error ? err.message : String(err)),
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

/** The executor's pool when agents are uncapped: more than any run starts at once. */
const JOINED_CAPACITY = 1024

const UNITS: Record<string, number> = {
  B: 1,
  KB: 1e3,
  MB: 1e6,
  GB: 1e9,
  TB: 1e12,
  KIB: 1024,
  MIB: 1024 ** 2,
  GIB: 1024 ** 3,
  TIB: 1024 ** 4,
}

/** `8GB`, `512MiB` or a byte count; undefined for anything else. */
export function bytes(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : undefined
  if (typeof v !== 'string') return undefined
  const m = /^\s*(\d+(?:\.\d+)?)\s*([a-z]+)\s*$/i.exec(v)
  const unit = m === null ? undefined : UNITS[m[2]!.toUpperCase()]
  return unit === undefined ? undefined : Number(m![1]) * unit
}
