import path from 'node:path'
import {
  definePlugin,
  hostPlatform,
  LocalHistoryProvider,
  PLATFORMS,
  refuseUnknownOptions,
  taskDefinitions,
  ui,
  UserError,
  type CommandContext,
  type Platform,
  type PluginCache,
  type PluginOptionKinds,
  type TaskNode,
  type TaskResources,
} from '@vzn/vx'
import type { DteInit, DteSetup } from './init.js'
import type { Need } from './dispatch.js'
import { booked, DEFAULT_STRATEGY, STRATEGIES, type Strategy } from './strategy.js'
import type { Orchestrator } from './orchestrator.js'
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
  /** Its machines' platform, which a joining worker must report; absent, planned as this machine's and not checked. A task naming `exec.platforms` runs only on a worker of one of them. */
  readonly platform?: Platform
}

/** What an adapter is asked to start: one worker of `size`. */
export interface WorkerSpawn {
  readonly run: string
  readonly relay: string
  readonly size: string
  /** Its size's `max`: `Infinity` when uncapped. */
  readonly max: number
  /** Its size's cores and memory (bytes), for an adapter that sets a machine's limits. */
  readonly cpu: number
  readonly memory: number
  /** 1 for the first worker this run starts, counting every size: unique where `id` is per size. */
  readonly index: number
  /** Its name in the run's output and its own (`small#2`, numbered within its size), which it reports back on joining. */
  readonly id: string
  readonly workspaceRoot: string
  /** The commit of the tracked files as the run saw them at its start, whose tree a worker must check out. */
  readonly commit: string
  /**
   * The run's cache directory, absolute, when the workspace names one
   * (`cache.dir`, `VX_CACHE_DIR`, `--cache-dir`): an adapter starting workers on this
   * machine points them at it, where the run reads what they save.
   */
  readonly cacheDir?: string
  /** What the worker's `vx dte worker` reads: `VX_DTE_RUN`, `VX_DTE_WORKER` (`id`), `VX_DTE_RELAY`, `VX_DTE_SECRET` (the run’s). */
  readonly env: Readonly<Record<string, string>>
  /** Says the worker's job or process ended, a success too, and why (its exit, its last stderr line). */
  readonly exited: (reason: string) => void
}

export interface DteAdapter {
  /** A relay of its own, for a run whose `dte()` names none. */
  relay?(): Promise<string>
  spawn(worker: WorkerSpawn): void | Promise<void>
  /** At run end: stop what it started. */
  close?(): void | Promise<void>
  /** Workers `ids` it started are not needed: stop each that has not joined, if it can. */
  cancel?(ids: readonly string[]): void
  /** The CI files that start its workers, which `vx dte init` writes; none for an adapter that starts them on this machine. */
  init?(setup: DteSetup): Promise<DteInit>
  /** Where it says a fault it works around (a status poll or a cancel that failed); called as the run starts. */
  report?(warn: (message: string) => void): void
  /** Its workers prove themselves by their CI identity (GitHub OIDC): the run makes no secret for them. */
  readonly keyless?: boolean
  /**
   * A keyless adapter's: the CI runs (GitHub workflow run ids) whose jobs
   * alone may join as its workers; `undefined` admits any job of the
   * repository.
   */
  workerRuns?(): ReadonlySet<string> | undefined
  /** A worker's name in a job its CI started for several, when `VX_DTE_WORKER` is unset. */
  workerId?(): string | undefined
  /** The run's id when `VX_DTE_RUN` is unset, in a CI job it starts workers from; none elsewhere. */
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
  /** How the run orders, places, books and scales (`Strategy`); each layer absent is the default's. */
  readonly scheduler?: Partial<Strategy>
  /**
   * What a task with no measure counts for when the run decides how many
   * workers to start (default 2 cores, 4GB). It books next to nothing, so
   * it runs on any free core.
   */
  readonly unmeasured?: { readonly cpu: number; readonly memory: number | string }
  /**
   * Headers every dial to the relay carries, the orchestrator's and each
   * worker's, for a proxy in front of it (`{ 'CF-Access-Client-Id':
   * process.env.CF_ACCESS_CLIENT_ID }`, an Access service token,
   * 2026-10-25). An unset value is left out; `authorization` stays the
   * token's.
   */
  readonly headers?: Readonly<Record<string, string | undefined>>
}

const KEYS: PluginOptionKinds<DteOptions> = {
  workers: 'object',
  adapter: 'object',
  relay: 'string',
  token: 'function',
  scheduler: 'object',
  unmeasured: 'object',
  headers: 'object',
}

const USAGE = 'Usage: vx dte worker | vx dte init [--dry] [--force]'

/** `headers` with unset values left out; a name or value no header can carry, or `authorization`, refused. */
function proxyHeaders(headers: DteOptions['headers']): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value === undefined) continue
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || name.toLowerCase() === 'authorization')
      throw new UserError(`dte() option "headers" cannot set "${name}"`)
    if (typeof value !== 'string' || /[\r\n\0]/.test(value))
      throw new UserError(
        `dte() option "headers.${name}" must be one line of text (its value is not printed)`,
      )
    out[name] = value
  }
  return out
}

export function dte(options: DteOptions) {
  refuseUnknownOptions('dte()', options, KEYS)
  const headers = proxyHeaders(options.headers)
  const how: Strategy = { ...DEFAULT_STRATEGY }
  for (const [layer, choice] of Object.entries(options.scheduler ?? {})) {
    const choices = STRATEGIES[layer as keyof Strategy] as readonly string[] | undefined
    if (choices === undefined)
      throw new UserError(
        `dte() option "scheduler" has no layer ${JSON.stringify(layer)} (layers: ${Object.keys(STRATEGIES).join(', ')})`,
      )
    if (!choices.includes(choice as string))
      refuse(`scheduler.${layer}`, `one of ${choices.join(', ')}`, choice)
    ;(how as unknown as Record<string, unknown>)[layer] = choice
  }
  const sizes = Object.entries(options.workers ?? {}).map(([name, s]) => {
    const at = `workers.${name}`
    if (!(Number.isInteger(s?.cpu) && s.cpu >= 1)) refuse(`${at}.cpu`, 'a whole number ≥ 1', s?.cpu)
    const memory = bytes(s.memory)
    if (memory === undefined)
      refuse(`${at}.memory`, "bytes above 0 or a size such as '8GB'", s.memory)
    if (!(s.max === undefined || (Number.isInteger(s.max) && s.max >= 0)))
      refuse(`${at}.max`, 'a whole number ≥ 0', s.max)
    if (s.platform !== undefined && !PLATFORMS.includes(s.platform))
      refuse(`${at}.platform`, `one of ${PLATFORMS.join(', ')}`, s.platform)
    return {
      name,
      max: s.max ?? Infinity,
      cpu: s.cpu,
      memory: memory!,
      platform: s.platform ?? hostPlatform(),
    }
  })
  // Only a platform the size names refuses a worker reporting another: an
  // unnamed one is planned as this machine's, and takes whatever joins.
  const named = (size: string): { platform?: Platform } => {
    const platform = options.workers?.[size]?.platform
    return platform === undefined ? {} : { platform }
  }
  const home = homeOf(sizes, hostPlatform())
  const unmeasured = unmeasuredOf(options.unmeasured)
  const adapter = options.adapter
  // An adapter's run in its own CI with a relay names itself: the CI file
  // sets nothing (2026-10-23: "super simple" CI).
  let made: string | undefined
  /** Each task's sends under the run's id, across the runs `vx watch` makes. */
  const sent = new Map<string, number>()
  const runOf = (): string | undefined =>
    givenRun() ??
    (options.relay === undefined
      ? undefined
      : (made ??=
          adapter?.keyless === true && onGitHub() ? crypto.randomUUID() : adapter?.runId?.()))
  if (adapter !== undefined && typeof adapter.spawn !== 'function') {
    throw new UserError('dte(): adapter is an adapter, such as local()')
  }
  // With none, no worker was ever asked for and the run waited until killed.
  if (adapter !== undefined && !sizes.some((s) => s.max > 0)) {
    throw new UserError(
      "dte(): workers names no size the adapter may start (one with max above 0), such as small: { cpu: 2, memory: '8GB' }",
    )
  }
  if (adapter === undefined && options.relay === undefined) {
    throw new UserError('dte(): with no adapter, set relay: the workers that join it run the tasks')
  }
  // With no scheme the run failed in the executor as a bare "Invalid URL".
  if (options.relay !== undefined && !/^https?:\/\//.test(options.relay)) {
    throw new UserError(
      `dte() option "relay" must be an http(s) URL, got ${JSON.stringify(options.relay)}`,
    )
  }
  // On GitHub Actions with none given, one for the relay's URL.
  const token = async (relay: string): Promise<string | undefined> =>
    (await options.token?.()) ??
    (process.env['VX_DTE_TOKEN'] ||
      (await import('./github.js').then((g) => g.githubRelayToken(relay))))

  let nodes: ReadonlyMap<string, TaskNode> | undefined
  /** The workspace names its cache dir (`cache.dir`): `config` reads it. */
  let namesCache = false
  let peaks: ReadonlyMap<string, TaskResources> = new Map()
  /** Each size's warm-up an earlier run learned (`warm-ups.ts`), and the read of it. */
  let learned: ReadonlyMap<string, number> = new Map()
  let warming: Promise<void> = Promise.resolve()
  /** On CI, where the run keeps the warm-ups it learned: `setup`'s cache, root and warn. */
  let keep: { cache: PluginCache; root: string; warn: (m: string) => void } | undefined
  /** Each task's tail by `nodes` and `peaks`, made again when either changes. */
  let tails: ((id: string) => number) | undefined
  /** Settles once the needs other plugins fetch are in `peaks`: `ctx.refining()`, then the read. */
  let needsIn: (() => Promise<void>) | undefined
  /** Called when `schedule` has read history; set by the executor, which core makes first. */
  let scheduled: (() => void) | undefined
  /** The cached tasks the last commit's changes make miss (`forecast.ts`): work before any worker can say. */
  let likely: ReadonlySet<string> = new Set()
  // Each finished task's cache key, a hit's too: what a worker restores a
  // dependency by.
  const keys = new Map<string, string>()
  let orchestrator: Orchestrator | undefined
  let closing: Promise<void> | undefined

  const close = async (): Promise<void> => {
    const o = orchestrator
    orchestrator = undefined
    nodes = undefined
    const ups = o?.warmUpsMs()
    const k = keep
    keep = undefined
    if (k !== undefined && ups !== undefined) {
      const { writeWarmUps } = await import('./warm-ups.js')
      await writeWarmUps(k.cache, k.root, learned, ups).catch((err: unknown) =>
        k.warn(`dte: warm-ups not kept: ${err instanceof Error ? err.message : String(err)}`),
      )
    }
    learned = new Map()
    warming = Promise.resolve()
    peaks = new Map()
    tails = undefined
    needsIn = undefined
    scheduled = undefined
    likely = new Set()
    keys.clear()
    await o?.close()
    await adapter?.close?.()
  }

  /** `vx dte init [--dry] [--force]`: the run's CI and its workers', from these sizes. */
  const init = async (args: readonly string[], ctx: CommandContext): Promise<number> => {
    const extra = args.find((a) => a !== '--dry' && a !== '--force')
    if (extra !== undefined)
      throw new UserError(
        `vx dte init: unknown argument ${extra}; it takes --dry and --force`,
        'VX_E_USAGE',
      )
    const root = ctx.workspaceRoot
    if (adapter === undefined)
      throw new UserError(
        'vx dte init: dte() names no adapter, so vx starts no workers and needs no CI files',
      )
    if (adapter.init === undefined) {
      ui.say(
        'info',
        'vx dte init: this adapter starts workers on this machine; no CI files to write',
        'out',
      )
      return 0
    }
    const { askTasks, managerOf, originOf, writeInit } = await import('./init.js')
    // CI reads its files at the repository's root; a workspace in a
    // subdirectory got them in its own, which no CI reads (2026-10-25).
    const git = (arg: string): string =>
      Bun.spawnSync(['git', 'rev-parse', arg], { cwd: root, stderr: 'ignore' })
        .stdout.toString()
        .trim()
    const top = git('--show-toplevel') || root
    const files = await adapter.init({
      workspaceRoot: root,
      dir: git('--show-prefix').replace(/\/$/, ''),
      ...(options.relay !== undefined ? { relay: options.relay } : {}),
      sizes: sizes.map((s) => ({
        name: s.name,
        ...(s.max === Infinity ? {} : { max: s.max }),
        ...named(s.name),
      })),
      manager: managerOf(root),
      tasks: askTasks(),
      ...originOf(root),
    })
    const out = (line: string): void => ui.say('info', line, 'out')
    if (args.includes('--dry')) {
      for (const [rel, text] of Object.entries(files.files)) ui.print('out', ui.excerpt(rel, text))
      for (const line of files.next) out(line)
      return 0
    }
    return writeInit(top, files, args.includes('--force'), out)
  }

  return definePlugin(import.meta, {
    commands: {
      dte: {
        description: "Write a DTE run's CI (dte init) or run its tasks (dte worker).",
        async run(argv, ctx) {
          // Asked for, the usage is an answer: `vx dte --help` exited 1 (2026-10-26).
          if (argv.some((a) => a === '--help' || a === '-h') || argv[0] === 'help') {
            ui.say('info', USAGE, 'out')
            return 0
          }
          if (argv[0] === 'init') return init(argv.slice(1), ctx)
          // The bare usage said nothing of what was wrong with the line typed.
          if (argv[0] === undefined)
            throw new UserError(`missing subcommand\n${USAGE}`, 'VX_E_USAGE')
          if (argv[0] !== 'worker')
            throw new UserError(`unknown subcommand: ${argv[0]}\n${USAGE}`, 'VX_E_USAGE')
          if (argv.length > 1)
            throw new UserError(
              `vx dte worker takes no arguments: ${argv.slice(1).join(' ')}`,
              'VX_E_USAGE',
            )
          const run = runOf()
          const relay = process.env['VX_DTE_RELAY'] ?? options.relay
          // Only what is missing: with VX_DTE_RUN set, the old line still asked for it.
          if (run === undefined || relay === undefined) {
            const missing = [
              ...(run === undefined ? ['VX_DTE_RUN'] : []),
              ...(relay === undefined ? ['VX_DTE_RELAY or dte({ relay })'] : []),
            ]
            throw new UserError(`vx dte worker needs ${missing.join(', and ')}`)
          }
          if (!/^https?:\/\//.test(relay))
            throw new UserError(`vx dte worker: VX_DTE_RELAY must be http(s), got ${relay}`)
          const secret = givenSecret()
          if (secret === undefined && !onGitHub()) {
            throw new UserError(
              'vx dte worker needs VX_DTE_SECRET, the run’s, or a GitHub Actions job with id-token: write',
            )
          }
          const [{ runWorker }, seal] = await Promise.all([
            import('./worker.js'),
            import('./seal.js'),
          ])
          const id = process.env['VX_DTE_WORKER'] || adapter?.workerId?.()
          return runWorker({
            relay,
            run,
            ...(id === undefined || id === '' ? {} : { id }),
            root: ctx.workspaceRoot,
            token: () => token(relay),
            headers,
            proof: secret === undefined ? seal.githubProof() : seal.secretProof(secret),
            artifacts: ctx.artifactsFor,
          })
        },
      },
    },

    config(workspace) {
      namesCache = workspace.cache?.dir !== undefined
    },

    setup(ctx) {
      // A run that is not distributed subscribes nothing.
      if (runOf() === undefined) return
      if (ctx.ci) keep = { cache: ctx.cache, root: ctx.workspaceRoot, warn: (m) => ctx.warn(m) }
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
            taskDefinitions(graph.values()),
          ).resourcesFor(ids)
          tails = undefined
        } catch (err) {
          ctx.warn(
            `dte: tasks are packed one core each: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
      let reading = read()
      warming = import('./warm-ups.js')
        .then((w) => w.readWarmUps(ctx.cache, ctx.workspaceRoot))
        .then(
          (m) => void (learned = m),
          (err: unknown) =>
            ctx.warn(
              `dte: no warm-ups learned: ${err instanceof Error ? err.message : String(err)}`,
            ),
        )
      const guess = changedSinceParent(ctx.workspaceRoot).then(async (changed) => {
        const { likelyMisses } = await import('./forecast.js')
        likely = likelyMisses(graph, changed, ctx.workspaceRoot)
      })
      await Promise.all([reading, guess])
      // Needs another plugin fetched (the default branch's timings) land
      // in history after this: the tasks not yet placed pack by them, and
      // the first ask for workers waits for them.
      ctx.onRefine(() => void (reading = read()))
      // Asked at the first ask, when every plugin's schedule has promised its
      // own. Read again then: a refine that landed before `onRefine` above
      // was listening left the first read's empty history, and main planned
      // 9 asks on 0 measured tasks, 25% of its cores used (2026-10-23).
      needsIn = () =>
        Promise.all([ctx.refining().then(() => (reading = read())), warming]).then(() => {})
      scheduled?.()
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
        { decide, knownMisses, slowdown, tailsMs, WARM_UP_MS },
        { snapshot },
        seal,
      ] = await Promise.all([
        import('./orchestrator.js'),
        import('./wire.js'),
        import('./planner.js'),
        import('./tree.js'),
        import('./seal.js'),
      ])
      // VX_DTE_SECRET wins. On GitHub, workers that join on their own or
      // an adapter's keyless ones prove themselves by OIDC; the workers
      // another adapter starts get a secret made for this run.
      let secret = givenSecret()
      let proof: Proof | undefined
      if (secret === undefined) {
        if ((adapter === undefined || adapter.keyless === true) && onGitHub())
          proof = seal.githubProof(
            undefined,
            adapter?.workerRuns === undefined ? undefined : () => adapter.workerRuns!(),
          )
        else if (adapter === undefined)
          throw new UserError(
            'dte(): with no adapter, set VX_DTE_SECRET here and on each worker, or run on GitHub Actions with id-token: write',
          )
        else secret = seal.runSecret()
      }
      proof ??= seal.secretProof(secret!)
      const { commit, tree } = await snapshot(ctx.workspaceRoot)
      if (tree === '') throw new UserError('dte(): a DTE run needs a git commit')
      const need = (id: string): Need => booked(needOf(peaks.get(id), unmeasured), how.book)
      // The run plans again on it, now when `now`; set once the plan is.
      let onChange = (_now?: boolean): void => {}
      const o = new Orchestrator({
        me: seal.sealOrchestrator(
          await join(relay, run, 'orchestrator', null, () => token(relay), headers),
          run,
          proof,
          ctx.warn,
        ),
        root: ctx.workspaceRoot,
        tree,
        nodes: () => nodes,
        need,
        artifacts: ctx.artifacts,
        cacheFacts: () => ctx.cacheFacts(),
        run,
        sent,
        keyOf: (id) => keys.get(id),
        tail: (id) =>
          (tails ??= tailsMs(nodes ?? new Map(), (x) => peaks.get(x)?.p50DurationMs))(id),
        how,
        home,
        lost: (id) => {
          const s = sizeOf.get(id)
          if (s === undefined) return
          sizeOf.delete(id)
          started.set(s.name, started.get(s.name)! - 1)
          // Before the run counts what is left to start: none would fail it.
          onChange(true)
        },
        joined: () => onChange(),
        // A worker given up on joining: its job, still queued or stuck, is stopped.
        overdue: (id) => adapter?.cancel?.([id]),
        // Before the run counts what is left to start: a worker that let a
        // task's lease end failed main's macOS run with another to start
        // (2026-10-23).
        faulted: () => onChange(true),
        stalled: (waiting) =>
          ctx.warn(`dte(): no task began or ended for a minute; waiting on\n${waiting}`),
        warn: ctx.warn,
      })
      orchestrator = o
      const started = new Map<string, number>()
      const sizeOf = new Map<string, Size>()
      let index = 0
      // Numbered within its size: one count across sizes left M asking
      // where small#1 was (mac#1 had it, 2026-10-23).
      const numbered = new Map<string, number>()
      const nextId = (size: string): string => {
        const n = (numbered.get(size) ?? 0) + 1
        numbered.set(size, n)
        return `${size}#${n}`
      }
      // A worker the run counts as started, against its size's max.
      const spawnOf = (s: Size, id: string, n: number): WorkerSpawn => {
        started.set(s.name, (started.get(s.name) ?? 0) + 1)
        o.spawned(id, {
          size: s.name,
          cpu: s.cpu,
          memory: s.memory,
          ...named(s.name),
        })
        sizeOf.set(id, s)
        return {
          run,
          relay,
          size: s.name,
          max: s.max,
          cpu: s.cpu,
          memory: s.memory,
          index: n,
          id,
          workspaceRoot: ctx.workspaceRoot,
          commit,
          ...(namesCache ||
          process.env['VX_CACHE_DIR'] ||
          ctx.cacheDir !== path.join(ctx.workspaceRoot, '.vx', 'cache')
            ? { cacheDir: ctx.cacheDir }
            : {}),
          env: {
            VX_DTE_RUN: run,
            VX_DTE_WORKER: id,
            VX_DTE_RELAY: relay,
            ...(secret === undefined ? {} : { VX_DTE_SECRET: secret }),
          },
          exited: (reason) => o.failed(id, reason),
        }
      }
      adapter?.report?.(ctx.warn)
      // Workers the CI started before the run did (`DteAdapter.adopt`).
      adapter?.adopt?.((id, size) => {
        const s = sizes.find((x) => x.name === size)
        const n = Number(id.slice(id.lastIndexOf('#') + 1))
        if (s === undefined || !Number.isInteger(n) || n < 1)
          throw new UserError(`dte(): a started worker ${id} is no worker of a declared size`)
        numbered.set(size, Math.max(numbered.get(size) ?? 0, n))
        return spawnOf(s, id, ++index)
      })
      // Tasks core handed over: each missed the cache (`missedWork`).
      const executed = new Set<string>()
      // The run's deadline (`Plan.boundMs`), and the work its plans knew.
      let deadline: number | undefined
      const known = new Set<string>()
      // A plan that needs a worker later plans again then.
      let again: ReturnType<typeof setTimeout> | undefined
      // The fewest workers that end the run's known work within a margin of
      // the most would, played out (`planner.ts`); idle ones it does
      // without leave. Again at each miss, finish, join and history read.
      const shape = (remaining: ReadonlySet<string>): void => {
        // This run's for the size, else an earlier run's, else any size's
        // this run, else the default.
        const ups = o.warmUpsMs()
        const any = o.warmUpMs()
        const warmUp = (size: string | undefined): number =>
          (size === undefined ? undefined : (ups.get(size) ?? learned.get(size))) ??
          any ??
          WARM_UP_MS
        // What is left takes as much longer than history as what ended did.
        const p50 = (id: string): number | undefined => peaks.get(id)?.p50DurationMs
        const slow = slowdown(o.finished(p50))
        const ms = (id: string): number | undefined => {
          const m = p50(id)
          return m === undefined ? undefined : m * slow
        }
        const { workers, running } = o.planState(ms, warmUp)
        const final = adapter === undefined
        const p = decide({
          remaining,
          nodes: nodes ?? new Map(),
          executed: knownMisses(likely, sure, executed, remaining),
          // As the run books them: a plan of history alone asks for workers it then fills less.
          need: (id) => o.booking(need(id)),
          durationMs: ms,
          workers,
          running,
          sizes,
          started,
          final,
          warmUpMs: warmUp,
          replaceable: adapter !== undefined,
          limitMs: deadline === undefined ? undefined : deadline - performance.now(),
          known,
          how,
          home,
          queued: o.queued(warmUp),
        })
        deadline = performance.now() + p.boundMs
        for (const t of p.tasks) known.add(t.id)
        if ((p.start.length > 0 && !final) || p.release.length > 0)
          o.planned({
            start: final ? [] : p.start.map((s) => s.name),
            release: p.release,
            tasks: p.tasks.length,
            endsInMs: p.endsInMs,
            boundMs: p.boundMs,
            workers,
            ...(p.start.length > 0 && !final
              ? { work: p.tasks, warmUps: new Map(sizes.map((s) => [s.name, warmUp(s.name)])) }
              : {}),
          })
        const { tasks } = p
        // At the end the relay closing ends them all.
        if (p.release.length > 0 && remaining.size > 0) {
          const cancelled = o.release(p.release)
          for (const id of cancelled) {
            const s = sizeOf.get(id)
            if (s === undefined) continue
            sizeOf.delete(id)
            started.set(s.name, started.get(s.name)! - 1)
          }
          if (cancelled.length > 0) adapter?.cancel?.(cancelled)
        }
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
          tasks.filter((t) => !measured(t.id)).map((t) => t.id),
        )
        for (const s of p.start) {
          ++index
          const id = nextId(s.name)
          const a = spawnOf(s, id, index)
          void Promise.resolve(adapter.spawn(a)).catch((err: unknown) =>
            o.failed(id, err instanceof Error ? err.message : String(err)),
          )
        }
      }
      // Events come in bursts (core hands over tasks ready at once): one
      // plan per tick, paced by its cost.
      const paced = pace(() => {
        if (pending !== undefined) shape(pending)
      })
      const replan = (now?: boolean): void => {
        if (!missed || pending === undefined || !ready()) return
        if (now === true) return paced.now()
        paced.soon()
      }
      // Until a task misses, demand waits: a run all hits starts no worker.
      let missed = false
      let pending: ReadonlySet<string> | undefined
      // The tasks core's probe found in no cache: they run, known before any worker keys them.
      let sure: ReadonlySet<string> = new Set()
      const measured = (id: string): boolean => peaks.get(id)?.maxCpuParallelism !== undefined
      // Needs another plugin fetches (the default branch's timings) land a
      // moment into the run. Asked before them, every task books a whole
      // worker: main asked 12 workers for 13 misses and 5 ran nothing
      // (2026-10-23). The first ask waits for them.
      // Core makes the executor and settles its demand before `schedule`
      // reads history: asked then, main's first ask booked a whole worker
      // for each of 122 tasks, 0 measured, and cancelled 13 of 14
      // (2026-10-23). A run that never reaches `schedule` (every task a
      // restore) waits for its first miss.
      let waited: boolean | undefined
      const ready = (): boolean => {
        if (waited === true) return true
        if (needsIn === undefined) return executed.size > 0
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
      // Work the last commit's changes make: planned before any task misses.
      const forecast = (): void => {
        if (likely.size > 0) missed = true
        replan()
      }
      if (needsIn === undefined) scheduled = forecast
      else forecast()
      return {
        name: 'dte',
        remote: true,
        // No task runs on the orchestrator; only hits restore here (2026-10-24).
        exclusive: true,
        // Each worker times a task from its start: a wait for a booting worker is not its run.
        timeouts: true,
        sandbox: true,
        // A task's persistent dependencies start on its worker, never here.
        servers: true,
        // A worker answers a task's runtime probes before it runs it.
        runtime: true,
        // Its sizes' platforms; workers that join on their own, this machine's.
        platforms:
          sizes.length === 0 ? [hostPlatform()] : [...new Set(sizes.map((s) => s.platform))],
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
        footer: () => o.footer(() => o.idealMs((id) => nodes?.get(id)?.deps ?? [], sizes)),
        machines: () => o.machines(),
        idealMs: () => o.idealMs((id) => nodes?.get(id)?.deps ?? [], sizes),
        profile: () => o.profile(),
        running: (id) => o.where(id),
        demand(remaining, misses) {
          if (pending === undefined) o.probed(remaining.size, misses.size)
          o.missed = misses
          pending = remaining
          sure = misses
          if (misses.size > 0) missed = true
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

/** A GitHub Actions job that may ask for OIDC tokens. */
function onGitHub(): boolean {
  return Boolean(process.env['ACTIONS_ID_TOKEN_REQUEST_URL'] && process.env['GITHUB_REPOSITORY_ID'])
}

/** `VX_DTE_SECRET`: the run's, given. */
function givenSecret(): string | undefined {
  return process.env['VX_DTE_SECRET'] || undefined
}

/** A plan waits this many times the last one's length after it: its share of the CPU at most one in eleven. */
const PLAN_GAP = 10

/**
 * `fn` at most once a tick (`soon`), and no sooner than `PLAN_GAP` times
 * its last run's length after that run; `now` runs it at once. Planned
 * after each task's end, 2000 tasks made 1281 plans and 9 s of the
 * orchestrator's 19: workers waited on it, and its relay found them lost
 * (2026-10-25).
 */
export function pace(fn: () => void): { soon(): void; now(): void } {
  let pending: { cancel(): void } | undefined
  let next = 0
  const run = (): void => {
    pending?.cancel()
    pending = undefined
    const start = performance.now()
    try {
      fn()
    } finally {
      const end = performance.now()
      next = end + PLAN_GAP * (end - start)
    }
  }
  return {
    now: run,
    soon() {
      if (pending !== undefined) return
      const wait = next - performance.now()
      if (wait <= 0) {
        const t = setImmediate(run)
        pending = { cancel: () => clearImmediate(t) }
      } else {
        const t = setTimeout(run, wait)
        t.unref?.()
        pending = { cancel: () => clearTimeout(t) }
      }
    },
  }
}

/**
 * What an unmeasured task counts for in the worker ask (`dte({ unmeasured
 * })`): fixed, since a plan cannot know which worker it lands on
 * (2026-10-23: "by default, 2 cores, 4 gigs").
 */
const FRESH: Need = { cores: 2, memory: 4e9 }
/**
 * What it books: one free core, no memory (2026-10-23: "pack them
 * where we have free capability"). Simulated on main's graph with a third
 * of its tasks unmeasured, it ended at 161 s where a whole worker each
 * ended at 195 s; a quarter core packed a cold run's tasks 16 to a
 * 4-core worker and ended at 267 s.
 */
const PLACED = { cores: 1, memory: 0 }

function unmeasuredOf(u: DteOptions['unmeasured']): Need {
  if (u === undefined) return FRESH
  if (!(typeof u.cpu === 'number' && u.cpu > 0 && Number.isFinite(u.cpu)))
    refuse('unmeasured.cpu', 'a number above 0', u.cpu)
  const memory = bytes(u.memory)
  if (memory === undefined)
    refuse('unmeasured.memory', "bytes above 0 or a size such as '4GB'", u.memory)
  return { cores: u.cpu, memory: memory! }
}

/** A `dte()` option it cannot use, named with the value as written (a NaN as NaN, not null). */
function refuse(option: string, want: string, got: unknown): never {
  const said = typeof got === 'number' ? String(got) : (JSON.stringify(got) ?? String(got))
  throw new UserError(`dte() option "${option}" must be ${want}, got ${said}`)
}

/** What a task asks of a worker, from its history. */
export function needOf(r: TaskResources | undefined, ask: Need = FRESH): Need {
  // Unmeasured (new, or over before the Linux sandbox's first look, which
  // leaves no CPU): any free core, counted as `ask` when the run is sized.
  // A whole worker each left main's small#1 at 13% for three sub-second
  // tasks (2026-10-23: "we can't waste whole worker for one task").
  // One that filled its worker: a whole bigger one.
  if (r?.maxCpuParallelism === undefined)
    return { ...PLACED, ask: { cores: ask.cores, memory: ask.memory } }
  if (r.saturatedCores !== undefined || r.saturatedMemoryBytes !== undefined)
    return {
      cores: Infinity,
      memory: Infinity,
      above: { cores: r.saturatedCores ?? 0, memory: r.saturatedMemoryBytes ?? 0 },
    }
  // The cores it keeps busy on average, unrounded: a suite at 0.7 booked a
  // whole core and CI's workers ran at 30-50% (2026-10-22: "close to
  // 100%"). A quarter at least, so a task that only waits is not free.
  return { cores: Math.max(0.25, r.maxCpuParallelism), memory: r.maxPeakRssBytes ?? 0 }
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
  const n = unit === undefined ? 0 : Number(m![1]) * unit
  // `'0GB'` is no more a size than `0`: a worker of no memory fits nothing beside.
  return n > 0 ? n : undefined
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

/**
 * The workspace-relative paths changed since HEAD's first parent, the
 * working tree's changes included: none when git cannot say (no parent, a
 * shallow clone), and the run waits for its misses as before.
 */
export async function changedSinceParent(workspaceRoot: string): Promise<string[]> {
  try {
    const proc = Bun.spawn({
      cmd: ['git', 'diff', '--name-only', '-z', '--relative', '--no-renames', 'HEAD^', '--'],
      cwd: workspaceRoot,
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const [out, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    return exit === 0 ? out.split('\0').filter((l) => l !== '') : []
    // quiet: a local git read; no files is the answer
  } catch {
    return []
  }
}

/**
 * The platform a task naming none runs on: `host`, when the sizes run it
 * and another. A worker of another platform then runs only the tasks that
 * name it, so they never wait behind the rest, and leaves when they are
 * done (2026-10-23). No size of `host`: anywhere, or nothing runs them.
 */
export function homeOf(sizes: readonly Size[], host: string): string | undefined {
  const of = new Set(sizes.filter((s) => s.max > 0).map((s) => s.platform))
  return of.has(host) && of.size > 1 ? host : undefined
}
