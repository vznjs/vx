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
import type { Size } from './planner.js'

/** One kind of worker the adapter can start. */
export interface WorkerSize {
  /** How many of it one run may start; absent, as many as the work needs. */
  readonly max?: number
  /** Its cores: what starting one adds, until it reports what its machine has. */
  readonly cpu: number
  /** Its memory, in bytes or as `'8GB'`, `'512MiB'`: what starting one adds, until it reports what its machine has. */
  readonly memory: number | string
}

/** What an adapter is asked to start: one worker of `size`. */
export interface WorkerSpawn {
  readonly run: string
  readonly relay: string
  readonly size: string
  /** Its size's cores and memory (bytes), for an adapter that sets a machine's limits. */
  readonly cpu: number
  readonly memory: number
  /** 1 for the first worker this run starts, counting every size. */
  readonly index: number
  /** Its name in the run's output and its own (`small#2`), which it reports back on joining. */
  readonly id: string
  readonly workspaceRoot: string
  /** What the worker's `vx dte worker` reads: `VX_DTE_RUN`, `VX_DTE_WORKER` (`id`), `VX_DTE_RELAY`, `VX_DTE_SECRET` (the run’s). */
  readonly env: Readonly<Record<string, string>>
  /** Says the worker ended before or without joining, and why (its exit, its last stderr line). */
  readonly exited: (reason: string) => void
}

/** What `vx dte plan` hands an adapter that writes its CI's worker jobs. */
export interface DtePlan {
  readonly run: string
  readonly relay: string
  readonly workspaceRoot: string
  /** Every worker the run may start: `max` of each size, in declared order; `live` ones the run starts as it needs them (`spawn`). */
  readonly workers: readonly {
    id: string
    size: string
    cpu: number
    memory: number
    live: boolean
  }[]
}

/** How one CI starts workers: `local()`, `docker()`, `gitlab()`. */
export interface DteAdapter {
  /** A relay of its own, for a run whose `dte()` names none. */
  relay?(): Promise<string>
  spawn(worker: WorkerSpawn): void | Promise<void>
  /** At run end: stop what it started. */
  close?(): void | Promise<void>
  /**
   * The files that start the plan's workers (workspace-relative path to
   * text), which `vx dte plan` writes. An adapter with it starts every
   * planned worker that is not `live` up front, and `spawn`s a `live` one,
   * by its `id`, when the run needs it.
   */
  render?(plan: DtePlan): Readonly<Record<string, string>>
  /** Whether a plan's workers beyond the first wait for the run to start them. */
  live?(): boolean
  /** Its workers prove themselves by their CI identity (GitHub OIDC): the run makes no secret for them. */
  readonly keyless?: boolean
  /** The run id `vx dte plan` names when `VX_DTE_RUN` is unset. */
  runId?(): string | undefined
  /**
   * Workers the CI started for this run before it began (`size#n`): each
   * is handed to `worker`, which counts it against its size's `max` and
   * returns its spawn, for the adapter to watch and stop as its own.
   */
  adopt?(worker: (id: string, size: string) => WorkerSpawn): void
}

export interface DteOptions {
  /** What the adapter may start, by size name. */
  readonly workers?: Readonly<Record<string, WorkerSize>>
  /** Starts workers; absent, the run uses the workers that join it, which needs `relay`. */
  readonly adapter?: DteAdapter
  /** The relay's URL; absent, the adapter's own. */
  readonly relay?: string
  /** The bearer token for the relay (default `VX_DTE_TOKEN`, else on GitHub Actions an OIDC token for the relay's URL). */
  readonly token?: () => string | undefined | Promise<string | undefined>
}

const KEYS: PluginOptionKinds<DteOptions> = {
  workers: 'object',
  adapter: 'object',
  relay: 'string',
  token: 'function',
}

export function dte(options: DteOptions) {
  refuseUnknownOptions('dte()', options, KEYS)
  const sizes = Object.entries(options.workers ?? {}).map(([name, s]) => {
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
        `dte(): workers.${name} needs cpu ≥ 1, memory such as '8GB', and a whole max ≥ 0 if any`,
      )
    }
    return { name, max: s.max ?? Infinity, cpu: s.cpu, memory }
  })
  const adapter = options.adapter
  // A keyless adapter's run on GitHub Actions with a relay names its own
  // run: ci.yml sets nothing (owner, 2026-10-23: "super simple" CI).
  let made: string | undefined
  const runOf = (): string | undefined =>
    givenRun() ??
    (adapter?.keyless === true && options.relay !== undefined && onGitHub()
      ? (made ??= crypto.randomUUID())
      : undefined)
  if (adapter !== undefined && typeof adapter.spawn !== 'function') {
    throw new UserError('dte(): adapter is an adapter, such as local()')
  }
  if (adapter === undefined && options.relay === undefined) {
    throw new UserError('dte(): with no adapter, set relay: the workers that join it run the tasks')
  }
  // On GitHub Actions with none given, one for the relay's URL.
  const token = async (relay: string): Promise<string | undefined> =>
    (await options.token?.()) ??
    (process.env['VX_DTE_TOKEN'] ||
      (await import('./github.js').then((g) => g.githubRelayToken(relay))))

  let nodes: ReadonlyMap<string, TaskNode> | undefined
  let peaks: ReadonlyMap<string, TaskResources> = new Map()
  /** Each task's tail by `nodes` and `peaks`, made again when either changes. */
  let tails: ((id: string) => number) | undefined
  /** Settles once the needs other plugins fetch are in `peaks`: `ctx.refining()`, then the read. */
  let needsIn: (() => Promise<void>) | undefined
  // Each finished task's cache key, a hit's too: what a worker restores a
  // dependency by.
  const keys = new Map<string, string>()
  let orchestrator: Orchestrator | undefined
  let closing: Promise<void> | undefined

  const close = async (): Promise<void> => {
    const o = orchestrator
    orchestrator = undefined
    nodes = undefined
    peaks = new Map()
    tails = undefined
    needsIn = undefined
    keys.clear()
    await o?.close()
    await adapter?.close?.()
  }

  /**
   * `vx dte plan [run args]`: the run's id and secret, and the files its
   * adapter starts workers with. Spawning live, the first wave is what the
   * run's graph keeps busy at its start, from `vx run <args> --dry=json`
   * and history; the rest wait for the run.
   */
  const plan = async (args: readonly string[], ctx: CommandContext): Promise<number> => {
    const root = ctx.workspaceRoot
    if (adapter?.render === undefined) throw new UserError('vx dte plan: the adapter plans nothing')
    const run = runOf() ?? adapter.runId?.()
    if (!run) throw new UserError('vx dte plan needs VX_DTE_RUN, or an adapter that names the run')
    if (options.relay === undefined) throw new UserError('vx dte plan needs dte({ relay })')
    const { runSecret } = await import('./seal.js')
    const live = adapter.live?.() === true
    const workers = planned(sizes, live ? await firstWave(args, ctx, sizes) : undefined)
    const files: Record<string, string> = {
      ...adapter.render({ run, relay: options.relay, workspaceRoot: root, workers }),
    }
    if (!process.env['VX_DTE_SECRET']) files[SECRET_FILE] = `${runSecret()}\n`
    files[PLAN_FILE] = `${JSON.stringify({ run, workers })}\n`
    for (const [rel, text] of Object.entries(files)) {
      const at = path.join(root, rel)
      await mkdir(path.dirname(at), { recursive: true })
      await writeFile(at, text, rel === SECRET_FILE ? { mode: 0o600 } : {})
    }
    process.stdout.write(
      `vx dte plan: run ${run}, ${workers.length} worker${workers.length === 1 ? '' : 's'}; wrote ${Object.keys(files).join(', ')}\n`,
    )
    return 0
  }

  return definePlugin(import.meta, {
    commands: {
      dte: {
        description:
          'dte plan: write the CI jobs of a run’s workers; dte worker: run tasks for a distributed run',
        async run(argv, ctx) {
          if (argv[0] === 'plan') return plan(argv.slice(1), ctx)
          if (argv[0] !== 'worker' || argv.length > 1) {
            throw new UserError('Usage: vx dte plan [<tasks> <run flags>] | vx dte worker')
          }
          const run = runOf()
          const relay = process.env['VX_DTE_RELAY'] ?? options.relay
          if (run === undefined || relay === undefined) {
            throw new UserError(
              'vx dte worker needs VX_DTE_RUN, and VX_DTE_RELAY or dte({ relay })',
            )
          }
          const secret = givenSecret(ctx.workspaceRoot)
          if (secret === undefined && !onGitHub()) {
            throw new UserError(
              `vx dte worker needs VX_DTE_SECRET or ${SECRET_FILE}, the run’s, or a GitHub Actions job with id-token: write`,
            )
          }
          const [{ runWorker }, seal] = await Promise.all([
            import('./worker.js'),
            import('./seal.js'),
          ])
          const id = process.env['VX_DTE_WORKER']
          return runWorker({
            relay,
            run,
            ...(id === undefined || id === '' ? {} : { id }),
            root: ctx.workspaceRoot,
            token: () => token(relay),
            proof: secret === undefined ? seal.githubProof() : seal.secretProof(secret),
            artifacts: ctx.artifactsFor,
          })
        },
      },
    },

    setup(ctx) {
      // A run that is not distributed subscribes nothing.
      if (runOf() === undefined) return
      ctx.on('onTaskComplete', (node, outcome) => {
        if (outcome.hash !== undefined) keys.set(node.id, outcome.hash)
      })
    },

    async schedule(graph, ctx) {
      nodes = graph
      tails = undefined
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
          tails = undefined
        } catch (err) {
          ctx.warn(
            `dte: tasks are packed one core each: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
      let reading = read()
      await reading
      // Needs another plugin fetched (the default branch's timings) land
      // in history after this: the tasks not yet placed pack by them, and
      // the first ask for workers waits for them.
      ctx.onRefine(() => void (reading = read()))
      // Asked at the first ask, when every plugin's schedule has promised its own.
      needsIn = () => ctx.refining().then(() => reading)
      return undefined
    },

    async executor(ctx) {
      await closing
      const run = runOf()
      if (run === undefined) return undefined
      const relay = options.relay ?? (await adapter?.relay?.())
      if (relay === undefined)
        throw new UserError('dte(): no relay: set relay, or use an adapter that has one')
      const [
        { Orchestrator },
        { join },
        { candidates, missedWork, plan, tailsMs, WARM_UP_MS },
        { snapshot },
        seal,
      ] = await Promise.all([
        import('./orchestrator.js'),
        import('./wire.js'),
        import('./planner.js'),
        import('./tree.js'),
        import('./seal.js'),
      ])
      // VX_DTE_SECRET or the plan's wins. On GitHub, workers that join on
      // their own or an adapter's keyless ones prove themselves by OIDC;
      // the workers another adapter starts get a secret made for this run.
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
            'dte(): with no adapter, set VX_DTE_SECRET here and on each worker, or run on GitHub Actions with id-token: write',
          )
        else secret = seal.runSecret()
      }
      proof ??= seal.secretProof(secret!)
      const { tree } = await snapshot(ctx.workspaceRoot)
      if (tree === '') throw new UserError('dte(): a distributed run needs a git commit')
      const need = (id: string): Need => needOf(peaks.get(id))
      // The run plans again on it, now when `now`; set once the plan is.
      let onChange = (_now?: boolean): void => {}
      const o = new Orchestrator({
        me: seal.sealOrchestrator(
          await join(relay, run, 'orchestrator', null, () => token(relay)),
          run,
          proof,
        ),
        root: ctx.workspaceRoot,
        tree,
        nodes: () => nodes,
        need,
        artifacts: ctx.artifacts,
        cacheFacts: () => ctx.cacheFacts(),
        run,
        keyOf: (id) => keys.get(id),
        tail: (id) =>
          (tails ??= tailsMs(nodes ?? new Map(), (x) => peaks.get(x)?.p50DurationMs))(id),
        lost: (id) => {
          // A planned worker is not started again: its job is spent.
          const s = sizeOf.get(id)
          if (s === undefined || plannedWorkers !== undefined) return
          sizeOf.delete(id)
          started.set(s.name, started.get(s.name)! - 1)
          // Before the run counts what is left to start: none would fail it.
          onChange(true)
        },
        joined: () => onChange(),
      })
      orchestrator = o
      const started = new Map<string, number>()
      const sizeOf = new Map<string, (typeof sizes)[number]>()
      let index = 0
      // A planned run's first wave is on its way already; the rest, if
      // any, waits for the run to start it, by size.
      const later = new Map<string, string[]>()
      const plannedWorkers =
        adapter?.render === undefined ? undefined : readPlan(ctx.workspaceRoot, run)
      for (const a of plannedWorkers ?? []) {
        if (a.live) {
          later.set(a.size, [...(later.get(a.size) ?? []), a.id])
          continue
        }
        o.spawned(a.id, { size: a.size, cpu: a.cpu, memory: a.memory })
        started.set(a.size, (started.get(a.size) ?? 0) + 1)
        index++
      }
      // A worker the run counts as started, against its size's max.
      const spawnOf = (s: (typeof sizes)[number], id: string, n: number): WorkerSpawn => {
        started.set(s.name, (started.get(s.name) ?? 0) + 1)
        o.spawned(id, { size: s.name, cpu: s.cpu, memory: s.memory })
        sizeOf.set(id, s)
        return {
          run,
          relay,
          size: s.name,
          cpu: s.cpu,
          memory: s.memory,
          index: n,
          id,
          workspaceRoot: ctx.workspaceRoot,
          env: {
            VX_DTE_RUN: run,
            VX_DTE_WORKER: id,
            VX_DTE_RELAY: relay,
            ...(secret === undefined ? {} : { VX_DTE_SECRET: secret }),
          },
          exited: (reason) => o.failed(id, reason),
        }
      }
      // Workers the CI started before the run did (`DteAdapter.adopt`).
      adapter?.adopt?.((id, size) => {
        const s = sizes.find((x) => x.name === size)
        const n = Number(id.slice(id.lastIndexOf('#') + 1))
        if (s === undefined || !Number.isInteger(n) || n < 1)
          throw new UserError(`dte(): a started worker ${id} is no worker of a declared size`)
        index = Math.max(index, n)
        return spawnOf(s, id, n)
      })
      // Tasks core handed over: each missed the cache (`missedWork`).
      const executed = new Set<string>()
      // A plan that needs a worker later plans again then.
      let again: ReturnType<typeof setTimeout> | undefined
      // The fewest workers that end the run's known work within a margin of
      // the most would, played out (`planner.ts`); idle ones it does
      // without leave. Again at each miss, finish, join and history read.
      const shape = (remaining: ReadonlySet<string>): void => {
        const warmUp = o.warmUpMs() ?? WARM_UP_MS
        const { workers, running } = o.planState((id) => peaks.get(id)?.p50DurationMs, warmUp)
        const tasks = missedWork(
          remaining,
          nodes ?? new Map(),
          executed,
          need,
          (id) => peaks.get(id)?.p50DurationMs,
        ).filter((t) => !running.has(t.id))
        const final = adapter === undefined || (plannedWorkers !== undefined && later.size === 0)
        const p = plan(
          tasks,
          workers,
          final
            ? []
            : candidates(
                sizes,
                started,
                tasks.flatMap((t) => t.above ?? []),
                tasks.length,
              ),
          warmUp,
          adapter !== undefined,
        )
        // At the end the relay closing ends them all.
        if (p.release.length > 0 && remaining.size > 0) o.release(p.release)
        if (again !== undefined) clearTimeout(again)
        again = undefined
        if (p.againInMs !== undefined && !final) {
          again = setTimeout(replan, p.againInMs)
          again.unref?.()
        }
        if (p.start.length === 0 || final) return
        o.asked(
          p.start.length,
          tasks.length,
          tasks.filter((t) => measured(t.id)).length,
          p.endsInMs,
        )
        for (const s of p.start) {
          ++index
          // Counted against its size's max, so a planned one is left.
          const id =
            plannedWorkers === undefined ? `${s.name}#${index}` : later.get(s.name)!.shift()!
          const a = spawnOf(s, id, index)
          void Promise.resolve(adapter.spawn(a)).catch((err: unknown) =>
            o.failed(id, err instanceof Error ? err.message : String(err)),
          )
        }
      }
      // Events come in bursts (core hands over tasks ready at once): one
      // plan per tick.
      let planning = false
      const replan = (now?: boolean): void => {
        if (!missed || pending === undefined || !ready()) return
        if (now === true) return shape(pending)
        if (planning) return
        planning = true
        setImmediate(() => {
          planning = false
          if (pending !== undefined) shape(pending)
        })
      }
      // Until a task misses, demand waits: a run all hits starts no worker.
      let missed = false
      let pending: ReadonlySet<string> | undefined
      const measured = (id: string): boolean => peaks.get(id)?.maxCpuParallelism !== undefined
      // Needs another plugin fetches (the default branch's timings) land a
      // moment into the run. Asked before them, every task books a whole
      // worker: main asked 12 workers for 13 misses and 5 ran nothing
      // (2026-10-23). The first ask waits for them.
      let waited: boolean | undefined
      const ready = (): boolean => {
        if (waited === true || needsIn === undefined) return true
        if (waited === undefined) {
          waited = false
          void needsIn().then(() => {
            waited = true
            replan()
          })
        }
        return false
      }
      onChange = replan
      return {
        name: 'dte',
        remote: true,
        sandbox: true,
        // A task's persistent dependencies start on its worker, never here.
        servers: true,
        // A worker answers a task's runtime probes before it runs it.
        runtime: true,
        // Room for the workers' cores and their prefetch; the orchestrator
        // queues the rest. Workers that join on their own are as many as join.
        capacity:
          adapter === undefined || sizes.some((s) => s.max === Infinity)
            ? JOINED_CAPACITY
            : Math.max(
                1,
                sizes.reduce((n, s) => n + 2 * s.max * s.cpu, 0),
              ),
        execute: (req) => {
          // A miss: the run's known work grows.
          missed = true
          executed.add(req.taskId)
          replan()
          return o.execute(req)
        },
        footer: () => o.footer(),
        machines: () => o.machines(),
        running: (id) => o.where(id),
        demand(remaining) {
          pending = remaining
          replan()
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

/** What `vx dte plan` wrote for the run's orchestrator, workspace-relative: its workers and which are live. */
const PLAN_FILE = '.vx/dte/plan.json'

/** The planned workers of `run`, as `vx dte plan` wrote them. */
function readPlan(root: string, run: string): DtePlan['workers'] {
  let plan: { run?: unknown; workers?: DtePlan['workers'] }
  try {
    plan = JSON.parse(readFileSync(path.join(root, PLAN_FILE), 'utf8'))
  } catch {
    throw new UserError(`dte(): no ${PLAN_FILE}: run vx dte plan first, in a job this one needs`)
  }
  if (plan.run !== run || !Array.isArray(plan.workers))
    throw new UserError(`dte(): ${PLAN_FILE} is another run's (${String(plan.run)}), not ${run}`)
  return plan.workers
}

/**
 * The workers by size the run's start keeps busy: the tasks `vx run
 * <args>` would run (`--dry=json`), laid out by the graph and history as
 * a run's demand lays them.
 */
async function firstWave(
  args: readonly string[],
  ctx: CommandContext,
  sizes: readonly Size[],
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
      // No history: every task a whole worker, as a run packs it.
    } finally {
      db.close()
    }
  }
  const { candidates, plan, planTasks } = await import('./planner.js')
  const need = (id: string): Need => needOf(peaks.get(id))
  const work = planTasks(
    remaining,
    nodes,
    need,
    (id) => peaks.get(id)?.p50DurationMs ?? p50.get(id),
  )
  // All start at once: no warm-up between them.
  const { start } = plan(
    work,
    [],
    candidates(
      sizes,
      new Map(),
      work.flatMap((t) => t.above ?? []),
      work.length,
    ),
    0,
  )
  const wave = new Map<string, number>()
  for (const s of start) wave.set(s.name, (wave.get(s.name) ?? 0) + 1)
  return wave
}

/** A task of `vx run --dry=json` (schemas/plan.json), as far as a plan reads it. */
interface DryTask {
  readonly id: string
  readonly cacheStatus: string
  readonly deps: string[]
  readonly p50Ms?: number
}

/** What a task asks of a worker, from its history. */
export function needOf(r: TaskResources | undefined): Need {
  // Unmeasured: a whole worker, until its first run measures it. One that
  // filled its worker: a whole bigger one.
  if (r?.maxCpuParallelism === undefined) return { cores: Infinity, memory: Infinity }
  if (r.saturatedCores !== undefined || r.saturatedMemoryBytes !== undefined)
    return {
      cores: Infinity,
      memory: Infinity,
      above: { cores: r.saturatedCores ?? 0, memory: r.saturatedMemoryBytes ?? 0 },
    }
  // The cores it keeps busy on average, unrounded: a suite at 0.7 booked a
  // whole core and CI's workers ran at 30-50% (M, 2026-10-22: "close to
  // 100%"). A quarter at least, so a task that only waits is not free.
  return { cores: Math.max(0.25, r.maxCpuParallelism), memory: r.maxPeakRssBytes ?? 0 }
}

/**
 * Each size's `max` workers, numbered across sizes as a run numbers those
 * it starts. With a `wave` (workers by size), only that many of each start
 * with the run: the run starts the rest, `live`, as its work needs them.
 */
function planned(
  sizes: readonly Size[],
  wave: ReadonlyMap<string, number> | undefined,
): DtePlan['workers'] {
  const out: DtePlan['workers'][number][] = []
  for (const s of sizes) {
    if (s.max === Infinity)
      throw new UserError(`dte(): workers.${s.name} needs max: a plan writes that many`)
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

/** The executor's pool when workers are uncapped: more than any run starts at once. */
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

/** A random (v4) UUID, as the relay takes: a run id no one can guess. */
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** `VX_DTE_RUN`, which turns distribution on. */
function givenRun(): string | undefined {
  const run = process.env['VX_DTE_RUN']
  if (run === undefined || run === '') return undefined
  if (!RUN_ID.test(run)) {
    throw new UserError(
      `VX_DTE_RUN is a random UUID, such as one \`uuidgen\` prints, so no one can guess the run: not ${JSON.stringify(run)}`,
    )
  }
  return run
}
