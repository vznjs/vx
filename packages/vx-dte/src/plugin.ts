import {
  definePlugin,
  LocalHistoryProvider,
  refuseUnknownOptions,
  UserError,
  type CommandContext,
  type PluginOptionKinds,
  type TaskNode,
  type TaskResources,
} from '@vzn/vx'
import { Database } from 'bun:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Need, Orchestrator } from './orchestrator.js'
import type { Proof } from './seal.js'
import type { Size } from './width.js'

/** One kind of agent the adapter can start. */
export interface AgentSize {
  /** How many of it one run may start; absent, as many as the work needs. */
  readonly max?: number
  /** Its cores: what starting one adds, until it reports what its machine has. */
  readonly cpu: number
  /** Its memory, in bytes or as `'8GB'`, `'512MiB'`: what starting one adds, until it reports what its machine has. */
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
  /** What the agent's `vx dte agent` reads: `VX_DTE_RUN`, `VX_DTE_AGENT` (`id`), `VX_DTE_RELAY`, `VX_DTE_SECRET` (the run’s). */
  readonly env: Readonly<Record<string, string>>
  /** Says the agent ended before or without joining, and why (its exit, its last stderr line). */
  readonly exited: (reason: string) => void
}

/** What `vx dte plan` hands an adapter that writes its CI's agent jobs. */
export interface DtePlan {
  readonly run: string
  readonly relay: string
  readonly workspaceRoot: string
  /** Every agent the run may start: `max` of each size, in declared order; `live` ones the run starts as it needs them (`spawn`). */
  readonly agents: readonly {
    id: string
    size: string
    cpu: number
    memory: number
    live: boolean
  }[]
}

/** How one CI starts agents: `local()`, `docker()`, `gitlab()`. */
export interface DteAdapter {
  /** A relay of its own, for a run whose `dte()` names none. */
  relay?(): Promise<string>
  spawn(agent: AgentSpawn): void | Promise<void>
  /** At run end: stop what it started. */
  close?(): void | Promise<void>
  /**
   * The files that start the plan's agents (workspace-relative path to
   * text), which `vx dte plan` writes. An adapter with it starts every
   * planned agent that is not `live` up front, and `spawn`s a `live` one,
   * by its `id`, when the run needs it.
   */
  render?(plan: DtePlan): Readonly<Record<string, string>>
  /** Whether a plan's agents beyond the first wait for the run to start them. */
  live?(): boolean
  /** Its agents prove themselves by their CI identity (GitHub OIDC): the run makes no secret for them. */
  readonly keyless?: boolean
  /** The run id `vx dte plan` names when `VX_DTE_RUN` is unset. */
  runId?(): string | undefined
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
  /** The bearer token for the relay (default `VX_DTE_TOKEN`, else on GitHub Actions an OIDC token for the relay's URL). */
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
  // On GitHub Actions with none given, one for the relay's URL.
  const token = async (relay: string): Promise<string | undefined> =>
    (await options.token?.()) ??
    (process.env['VX_DTE_TOKEN'] ||
      (await import('./github.js').then((g) => g.githubRelayToken(relay))))

  let nodes: ReadonlyMap<string, TaskNode> | undefined
  let peaks: ReadonlyMap<string, TaskResources> = new Map()
  // Each finished task's cache key, a hit's too: what an agent restores a
  // dependency by.
  const keys = new Map<string, string>()
  let orchestrator: Orchestrator | undefined
  let closing: Promise<void> | undefined

  const close = async (): Promise<void> => {
    const o = orchestrator
    orchestrator = undefined
    nodes = undefined
    peaks = new Map()
    keys.clear()
    await o?.close()
    await adapter?.close?.()
  }

  /**
   * `vx dte plan [run args]`: the run's id and secret, and the files its
   * adapter starts agents with. Spawning live, the first wave is what the
   * run's graph keeps busy at its start, from `vx run <args> --dry=json`
   * and history; the rest wait for the run.
   */
  const plan = async (args: readonly string[], ctx: CommandContext): Promise<number> => {
    const root = ctx.workspaceRoot
    if (adapter?.render === undefined) throw new UserError('vx dte plan: the adapter plans nothing')
    const run = process.env['VX_DTE_RUN'] || adapter.runId?.()
    if (!run) throw new UserError('vx dte plan needs VX_DTE_RUN, or an adapter that names the run')
    if (options.relay === undefined) throw new UserError('vx dte plan needs dte({ relay })')
    const { runSecret } = await import('./seal.js')
    const live = adapter.live?.() === true
    const agents = planned(
      sizes,
      live ? await firstWave(args, ctx, sizes, options.local ?? 0) : undefined,
    )
    const files: Record<string, string> = {
      ...adapter.render({ run, relay: options.relay, workspaceRoot: root, agents }),
    }
    if (!process.env['VX_DTE_SECRET']) files[SECRET_FILE] = `${runSecret()}\n`
    files[PLAN_FILE] = `${JSON.stringify({ run, agents })}\n`
    for (const [rel, text] of Object.entries(files)) {
      const at = path.join(root, rel)
      await mkdir(path.dirname(at), { recursive: true })
      await writeFile(at, text, rel === SECRET_FILE ? { mode: 0o600 } : {})
    }
    process.stdout.write(
      `vx dte plan: run ${run}, ${agents.length} agent${agents.length === 1 ? '' : 's'}; wrote ${Object.keys(files).join(', ')}\n`,
    )
    return 0
  }

  return definePlugin(import.meta, {
    commands: {
      dte: {
        description:
          'dte plan: write the CI jobs of a run’s agents; dte agent: run tasks for a distributed run',
        async run(argv, ctx) {
          if (argv[0] === 'plan') return plan(argv.slice(1), ctx)
          if (argv[0] !== 'agent' || argv.length > 1) {
            throw new UserError('Usage: vx dte plan [<tasks> <run flags>] | vx dte agent')
          }
          const run = process.env['VX_DTE_RUN']
          const relay = process.env['VX_DTE_RELAY'] ?? options.relay
          if (run === undefined || run === '' || relay === undefined) {
            throw new UserError('vx dte agent needs VX_DTE_RUN, and VX_DTE_RELAY or dte({ relay })')
          }
          const secret = givenSecret(ctx.workspaceRoot)
          if (secret === undefined && !onGitHub()) {
            throw new UserError(
              `vx dte agent needs VX_DTE_SECRET or ${SECRET_FILE}, the run’s, or a GitHub Actions job with id-token: write`,
            )
          }
          const [{ runAgent }, seal] = await Promise.all([
            import('./agent.js'),
            import('./seal.js'),
          ])
          const id = process.env['VX_DTE_AGENT']
          return runAgent({
            relay,
            run,
            ...(id === undefined || id === '' ? {} : { id }),
            root: ctx.workspaceRoot,
            token: await token(relay),
            proof: secret === undefined ? seal.githubProof() : seal.secretProof(secret),
            artifacts: ctx.artifacts,
          })
        },
      },
    },

    setup(ctx) {
      // A run that is not distributed subscribes nothing.
      const run = process.env['VX_DTE_RUN']
      if (run === undefined || run === '') return
      ctx.on('onTaskComplete', (node, outcome) => {
        if (outcome.hash !== undefined) keys.set(node.id, outcome.hash)
      })
    },

    async schedule(graph, ctx) {
      nodes = graph
      // A run that is not distributed reads nothing.
      if (orchestrator === undefined) return undefined
      const ids = [...graph.values()]
        .filter((n) => n.config.exec?.command !== undefined)
        .map((n) => n.id)
      const read = async (): Promise<void> => {
        if (orchestrator === undefined) return
        try {
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
      }
      await read()
      // Needs another plugin fetched (the default branch's timings) land
      // in history after this: the tasks not yet placed pack by them.
      ctx.onRefine(() => void read())
      return undefined
    },

    async executor(ctx) {
      await closing
      const run = process.env['VX_DTE_RUN']
      if (run === undefined || run === '') return undefined
      const relay = options.relay ?? (await adapter?.relay?.())
      if (relay === undefined)
        throw new UserError('dte(): no relay: set relay, or use an adapter that has one')
      const [{ Orchestrator }, { join }, { busyCores, toStart }, { snapshot }, seal] =
        await Promise.all([
          import('./orchestrator.js'),
          import('./wire.js'),
          import('./width.js'),
          import('./tree.js'),
          import('./seal.js'),
        ])
      // VX_DTE_SECRET or the plan's wins. On GitHub, agents that join on
      // their own or an adapter's keyless ones prove themselves by OIDC;
      // the agents another adapter starts get a secret made for this run.
      let secret = givenSecret(ctx.workspaceRoot)
      let proof: Proof | undefined
      if (secret === undefined) {
        if (adapter?.render !== undefined)
          throw new UserError(
            `dte(): no ${SECRET_FILE}: run vx dte plan first, in a job this one needs`,
          )
        if ((adapter === undefined || adapter.keyless === true) && onGitHub())
          proof = seal.githubProof()
        else if (adapter === undefined)
          throw new UserError(
            'dte(): with no adapter, set VX_DTE_SECRET here and on each agent, or run on GitHub Actions with id-token: write',
          )
        else secret = seal.runSecret()
      }
      proof ??= seal.secretProof(secret!)
      const { tree } = await snapshot(ctx.workspaceRoot)
      if (tree === '') throw new UserError('dte(): a distributed run needs a git commit')
      const localSlots = options.local ?? 0
      const need = (id: string): Need => needOf(peaks.get(id))
      const o = new Orchestrator({
        me: seal.sealOrchestrator(
          await join(relay, run, 'orchestrator', null, await token(relay)),
          run,
          proof,
        ),
        root: ctx.workspaceRoot,
        tree,
        localSlots,
        nodes: () => nodes,
        need,
        artifacts: ctx.artifacts,
        run,
        keyOf: (id) => keys.get(id),
      })
      orchestrator = o
      const started = new Map<string, number>()
      let index = 0
      let cores = 0
      // A planned run's first wave is on its way already; the rest, if
      // any, waits for the run to start it, by size.
      const later = new Map<string, string[]>()
      const plannedAgents =
        adapter?.render === undefined ? undefined : readPlan(ctx.workspaceRoot, run)
      for (const a of plannedAgents ?? []) {
        if (a.live) {
          later.set(a.size, [...(later.get(a.size) ?? []), a.id])
          continue
        }
        o.spawned(a.id, { size: a.size, cpu: a.cpu, memory: a.memory })
        started.set(a.size, (started.get(a.size) ?? 0) + 1)
        cores += a.cpu
        index++
      }
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
        machines: () => o.machines(),
        running: (id) => o.where(id),
        // Agents in declared order for the cores the remaining tasks keep
        // busy (`busyCores`) beyond this machine's share; none are stopped
        // before the run ends.
        demand(remaining) {
          if (adapter === undefined || (plannedAgents !== undefined && later.size === 0)) return
          const start = (s: (typeof sizes)[number]): void => {
            started.set(s.name, (started.get(s.name) ?? 0) + 1)
            cores += s.cpu
            ++index
            // Counted against its size's max, so a planned one is left.
            const id =
              plannedAgents === undefined ? `${s.name}#${index}` : later.get(s.name)!.shift()!
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
                env: {
                  VX_DTE_RUN: run,
                  VX_DTE_AGENT: id,
                  VX_DTE_RELAY: relay,
                  ...(secret === undefined ? {} : { VX_DTE_SECRET: secret }),
                },
                exited: (reason) => o.failed(id, reason),
              }),
            ).catch((err: unknown) =>
              o.failed(id, err instanceof Error ? err.message : String(err)),
            )
          }
          // An unmeasured task takes the biggest agent there is.
          const biggest = Math.max(...sizes.map((s) => s.cpu))
          const wantCores =
            busyCores(
              remaining,
              nodes ?? new Map(),
              (id) => Math.min(need(id).cores, biggest),
              (id) => peaks.get(id)?.p50DurationMs,
            ) - localSlots
          const above = [...remaining].flatMap((id) => need(id).above ?? [])
          for (const s of toStart(sizes, started, cores, wantCores, above)) start(s)
        },
      }
    },

    async teardown() {
      closing = close()
      await closing
    },
  })
}

/** Where `vx dte plan` keeps the run's secret, workspace-relative: a CI artifact no one downloads. */
const SECRET_FILE = '.vx/dte/secret'

/** A GitHub Actions job that may ask for OIDC tokens. */
function onGitHub(): boolean {
  return Boolean(process.env['ACTIONS_ID_TOKEN_REQUEST_URL'] && process.env['GITHUB_REPOSITORY_ID'])
}

/** `VX_DTE_SECRET`, else the one `vx dte plan` wrote. */
function givenSecret(root: string): string | undefined {
  const env = process.env['VX_DTE_SECRET']
  if (env !== undefined && env !== '') return env
  try {
    return readFileSync(path.join(root, SECRET_FILE), 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}

/** What `vx dte plan` wrote for the run's orchestrator, workspace-relative: its agents and which are live. */
const PLAN_FILE = '.vx/dte/plan.json'

/** The planned agents of `run`, as `vx dte plan` wrote them. */
function readPlan(root: string, run: string): DtePlan['agents'] {
  let plan: { run?: unknown; agents?: DtePlan['agents'] }
  try {
    plan = JSON.parse(readFileSync(path.join(root, PLAN_FILE), 'utf8'))
  } catch {
    throw new UserError(`dte(): no ${PLAN_FILE}: run vx dte plan first, in a job this one needs`)
  }
  if (plan.run !== run || !Array.isArray(plan.agents))
    throw new UserError(`dte(): ${PLAN_FILE} is another run's (${String(plan.run)}), not ${run}`)
  return plan.agents
}

/**
 * The agents by size the run's start keeps busy: the tasks `vx run
 * <args>` would run (`--dry=json`), laid out by the graph and history as
 * a run's demand lays them, beyond this machine's `localSlots`.
 */
async function firstWave(
  args: readonly string[],
  ctx: CommandContext,
  sizes: readonly Size[],
  localSlots: number,
): Promise<Map<string, number>> {
  const { VX_DTE_RUN: _, ...env } = process.env
  const dry = Bun.spawnSync([...ctx.vx, 'run', ...args, '--dry=json'], {
    cwd: ctx.workspaceRoot,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (dry.exitCode !== 0) {
    const why = dry.stderr.toString().trim().split('\n').at(-1) ?? ''
    throw new UserError(`vx dte plan: vx run ${args.join(' ')} --dry=json failed: ${why}`)
  }
  const tasks = (JSON.parse(dry.stdout.toString()) as { tasks: DryTask[] }).tasks
  const hit = new Set(['hit-local', 'hit-remote', 'not-started'])
  const remaining = new Set(tasks.filter((t) => !hit.has(t.cacheStatus)).map((t) => t.id))
  const nodes = new Map(
    tasks.map((t) => [
      t.id,
      {
        id: t.id,
        deps: t.deps,
        config: t.cacheStatus === 'group' ? {} : { exec: { command: '' } },
      } as unknown as TaskNode,
    ]),
  )
  const p50 = new Map(
    tasks.flatMap((t) => (t.p50Ms === undefined ? [] : [[t.id, t.p50Ms] as const])),
  )
  let peaks: ReadonlyMap<string, TaskResources> = new Map()
  const index = path.join(ctx.cacheDir, 'cache.db')
  if (existsSync(index)) {
    const db = new Database(index, { readonly: true })
    try {
      peaks = await new LocalHistoryProvider(db).resourcesFor([...remaining])
    } catch {
      // No history: every task a whole agent, as a run packs it.
    } finally {
      db.close()
    }
  }
  const { busyCores, toStart } = await import('./width.js')
  const biggest = Math.max(...sizes.map((s) => s.cpu))
  const want =
    busyCores(
      remaining,
      nodes,
      (id) => Math.min(needOf(peaks.get(id)).cores, biggest),
      (id) => peaks.get(id)?.p50DurationMs ?? p50.get(id),
    ) - localSlots
  const above = [...remaining].flatMap((id) => needOf(peaks.get(id)).above ?? [])
  const wave = new Map<string, number>()
  for (const s of toStart(sizes, new Map(), 0, want, above))
    wave.set(s.name, (wave.get(s.name) ?? 0) + 1)
  return wave
}

/** A task of `vx run --dry=json` (schemas/plan.json), as far as a plan reads it. */
interface DryTask {
  readonly id: string
  readonly cacheStatus: string
  readonly deps: string[]
  readonly p50Ms?: number
}

/** What a task asks of an agent, from its history. */
function needOf(r: TaskResources | undefined): Need {
  // Unmeasured: a whole agent, until its first run measures it. One that
  // filled its agent: a whole bigger one.
  if (r?.maxCpuParallelism === undefined) return { cores: Infinity, memory: Infinity }
  if (r.saturatedCores !== undefined || r.saturatedMemoryBytes !== undefined)
    return {
      cores: Infinity,
      memory: Infinity,
      above: { cores: r.saturatedCores ?? 0, memory: r.saturatedMemoryBytes ?? 0 },
    }
  return { cores: Math.max(1, Math.ceil(r.maxCpuParallelism)), memory: r.maxPeakRssBytes ?? 0 }
}

/**
 * Each size's `max` agents, numbered across sizes as a run numbers those
 * it starts. With a `wave` (agents by size), only that many of each start
 * with the run: the run starts the rest, `live`, as its work needs them.
 */
function planned(
  sizes: readonly Size[],
  wave: ReadonlyMap<string, number> | undefined,
): DtePlan['agents'] {
  const out: DtePlan['agents'][number][] = []
  for (const s of sizes) {
    if (s.max === Infinity)
      throw new UserError(`dte(): agents.${s.name} needs max: a plan writes that many`)
    for (let i = 0; i < s.max; i++)
      out.push({
        id: `${s.name}#${out.length + 1}`,
        size: s.name,
        cpu: s.cpu,
        memory: s.memory,
        live: wave !== undefined && i >= (wave.get(s.name) ?? 0),
      })
  }
  return out
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
