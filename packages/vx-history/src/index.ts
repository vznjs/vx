// History-based scheduling as a plugin: order ready tasks by their expected
// REMAINING critical-path duration (own p50 + the longest chain of
// dependents), learned from the local run history. This was core's opt-in
// `predictive` mode until 2026-09-02 and core's one bundled plugin until
// 2026-09-10; it is its own package now — declared like any other, paying
// its history read only in workspaces that ask for it, and core ships no
// plugin at all.
//
// Cache hits are NOT modelled as zero-cost: predicting cache state needs
// the key and a probe, which the scheduler handles at run time (a confirmed
// hit is backfill, never a critical-path task). The estimate here is "what
// if everything ran", which is exactly the case where order matters.

import {
  currentBranch,
  definePlugin,
  LocalHistoryProvider,
  machineMemoryBytes,
  Cache,
  type HistoryTable,
  type TaskNode,
  type TaskResources,
  type VxPlugin,
  loadResolvedProjects,
  criticalPath,
  taskDefinitions,
  UserError,
  refuseUnknownOptions,
  ui,
  type PluginOptionKinds,
} from '@vzn/vx'
import type { CommandContext } from '@vzn/vx'
import path from 'node:path'
import type { HistoryRow } from './history-view.js'
import type { HistoryServer, Named, ServerTiming } from './history-server.js'

export interface VxHistoryOptions {
  /** How many recent invocations to learn from. Default 20. */
  readonly window?: number
  /**
   * Pack tasks by what their last `window` executions actually used
   * (`admit` stage): a task's reservation is the largest peak RSS seen
   * times `headroom`, rounded up to 64 MB. Cores are never learned (see
   * `resourceEstimates`), only declared in `reservations`. A task is
   * admitted while the reservations of everything running beside it fit
   * the budgets, and a task over a whole budget runs alone. A task with no execution in the window
   * reserves nothing and runs freely. `false` turns packing off.
   * Default `{ headroom: 1.25 }`.
   */
  readonly resources?: false | { readonly headroom?: number }
  /**
   * Memory budget in megabytes the reservations pack against. Default:
   * what this process may use — the machine's total, capped by the
   * cgroup limit a container runs under (`os.totalmem()` alone reports
   * the HOST's RAM there). Pass it to budget below either.
   */
  readonly memory?: number
  /**
   * Reservations declared by hand (task id → cores, megabytes) for the
   * task history cannot size: a first run, or a task whose peak the
   * runner cannot see. A declared axis wins over the learned one; an axis
   * left out keeps it.
   */
  readonly reservations?: Readonly<Record<string, ResourceEstimate>>
  /**
   * Durations (task id → ms) to assume for tasks the history has not seen
   * yet. A fresh CI runner has no history at all, and there the baseline
   * order starts a long leaf task last — the one place the scheduler's
   * structural tie-break is worst. A recorded p50 always wins over an
   * assumption, and assumptions never feed the workspace median: they are
   * a hint for the cold run, not evidence.
   */
  readonly assume?: Readonly<Record<string, number>>
  /**
   * A timings file, from the workspace root, that carries the learned
   * durations between machines: read before ordering, rewritten after the
   * run with each task's p50 (task id → ms), so CI caches one file. A
   * recorded p50 here wins over it, and it wins over `assume`; like
   * `assume`, it never feeds the workspace median.
   */
  readonly file?: string
  /**
   * A vx-history server's URL (`@vzn/vx-history-server`), or
   * `VX_HISTORY_URL`. On a CI job with a token (GitHub's OIDC, or GitLab's
   * `VX_HISTORY_TOKEN`) each run asks it for its tasks' numbers, without
   * waiting, and sends its own timings once at its end.
   */
  readonly url?: string
  /**
   * Headers every request to `url` carries, for a proxy in front of it
   * (`{ 'CF-Access-Client-Id': process.env.CF_ACCESS_CLIENT_ID }`, an
   * Access service token, 2026-10-25). An unset value is left out;
   * `authorization` stays the CI token's.
   */
  readonly headers?: Record<string, string | undefined>
  /**
   * The CI issuer whose tokens `url` takes, as they name it
   * (`https://token.actions.githubusercontent.com`), and the repository at
   * it, `org/name`: required with a server. The run's query names them
   * (2026-10-25: the user names them, nothing guesses).
   */
  readonly issuer?: string
  readonly repository?: string
}

// The provider's own default (50) serves `--dry` predictions; an ordering
// hint needs less and reads a 2.5× smaller slice of the run history.
const DEFAULT_WINDOW = 20

// Each option is read in ONE place that a run's hooks and `vx history`
// share: two copies of each let either drift unseen (item 805).
const windowOf = (options: VxHistoryOptions): number =>
  usable(options.window, true) ? options.window : DEFAULT_WINDOW

/**
 * A number option's value when it is one: finite and above zero (a whole
 * number where `integer`). `memory: Number(process.env.X)` with X unset
 * is NaN, and against a NaN budget no reservation ever fits, so every
 * task that reserved memory waited for an idle machine: the run went
 * serial and said nothing. A NaN `headroom` dropped every learned
 * reservation. Each bad value is the default instead, named by
 * `numberWarnings`, as `assume` does (item 930).
 */
function usable(v: unknown, integer = false): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && (!integer || Number.isInteger(v))
}

/** One warning naming every number option that is not one, and the default it runs on. */
function numberWarnings(options: VxHistoryOptions, warn: (m: string) => void): void {
  const bad: string[] = []
  const check = (name: string, v: unknown, fallback: string, integer = false): void => {
    if (v !== undefined && !usable(v, integer)) {
      bad.push(
        `${name} ${typeof v === 'number' ? String(v) : JSON.stringify(v)} (using ${fallback})`,
      )
    }
  }
  check('window', options.window, String(DEFAULT_WINDOW), true)
  check('memory', options.memory, 'what this process may use')
  if (options.resources !== false && options.resources !== undefined) {
    check('resources.headroom', options.resources.headroom, String(DEFAULT_HEADROOM))
  }
  for (const [id, r] of Object.entries(options.reservations ?? {})) {
    if (r === null || typeof r !== 'object' || Array.isArray(r)) {
      bad.push(
        `reservations[${JSON.stringify(id)}] ${JSON.stringify(r) ?? String(r)} (using what history learned; must be { cpus?, memory? })`,
      )
      continue
    }
    for (const axis of ['cpus', 'memory'] as const) {
      const v = r[axis]
      if (v !== 0) check(`reservations[${JSON.stringify(id)}].${axis}`, v, 'what history learned')
    }
  }
  if (bad.length > 0) {
    warn(`[vx] vx-history: ignores ${bad.join(', ')} — each must be a finite number above 0`)
  }
}

/**
 * The declared reservations, each axis only where it is a number above 0,
 * or 0: a declared nothing, over what history learned. A NaN
 * (`Number(process.env.X)`, X unset) held a task alone and every
 * reserving task beside it waited — the NaN summed into what runs — so the
 * run went serial and said nothing (G-4's class). A bad axis is not
 * declared, named by `numberWarnings`.
 */
function declaredOf(
  options: VxHistoryOptions,
): Readonly<Record<string, ResourceEstimate>> | undefined {
  if (options.reservations === undefined) return undefined
  const out: Record<string, ResourceEstimate> = {}
  for (const [id, r] of Object.entries(options.reservations)) {
    const e: { cpus?: number; memory?: number } = {}
    if (r?.cpus === 0 || usable(r?.cpus)) e.cpus = r.cpus
    if (r?.memory === 0 || usable(r?.memory)) e.memory = r.memory
    out[id] = e
  }
  return out
}

const headroomOf = (options: VxHistoryOptions): number => {
  const h = options.resources === false ? undefined : options.resources?.headroom
  return usable(h) ? h : DEFAULT_HEADROOM
}

// The schedule reads no rates (`resourcesFor`); `vx history` shows runs.
const readHistory = (
  cache: Cache,
  ids: readonly string[],
  options: VxHistoryOptions,
  branch: string | null,
  defs: ReadonlyMap<string, string>,
): Promise<ReadonlyMap<string, TaskResources>> =>
  new LocalHistoryProvider(cache.dbHandle(), windowOf(options), branch, defs).resourcesFor(ids)

/** What each task reserves: learned from the history unless `resources: false`, a declared reservation over either. */
const reservationsFor = (
  ids: Iterable<string>,
  table: ReadonlyMap<string, TaskResources>,
  options: VxHistoryOptions,
): ReadonlyMap<string, ResourceEstimate> =>
  withDeclared(
    options.resources !== false ? estimatesFor(ids, table, headroomOf(options)) : new Map(),
    declaredOf(options),
  )

const memoryBudgetMb = (options: VxHistoryOptions): number =>
  usable(options.memory) ? options.memory : Math.floor(machineMemoryBytes() / MB)

/**
 * The `assume` durations that are numbers from 0 to 2^53: a larger one
 * summed along a chain to Infinity, which core refuses too. A NaN
 * (`Number(process.env.X)` with X unset) became a NaN weight and a string
 * (an untyped `.mjs` config) string weights, and core refused both as a
 * UserError: an ordering hint failed the run (item 930). The rest are
 * dropped by name, as a broken history read costs only the ordering.
 */
function assumptions(
  options: VxHistoryOptions,
  warn: (m: string) => void,
): Readonly<Record<string, number>> {
  const ok: Record<string, number> = {}
  const bad: string[] = []
  for (const [id, ms] of Object.entries(options.assume ?? {})) {
    if (isDuration(ms)) ok[id] = ms
    else bad.push(id)
  }
  if (bad.length > 0) {
    warn(
      `[vx] vx-history: assume ignores ${bad.map((id) => JSON.stringify(id)).join(', ')} — each must be a number of ms from 0 to 2^53`,
    )
  }
  return ok
}

/**
 * A duration a task can take, in ms. A chain's weight is its durations
 * summed, and two `1e308`s (a timings file a CI cache handed over, or
 * `assume`) summed to Infinity, which core refuses: the run failed in
 * `schedule`. Under 2^53 ms, any chain's sum stays finite.
 */
const isDuration = (ms: unknown): ms is number =>
  typeof ms === 'number' && ms >= 0 && ms <= Number.MAX_SAFE_INTEGER

/** The timings file's durations a run can take; the rest are not carried. */
function carriedOf(read: Readonly<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [id, ms] of Object.entries(read)) if (isDuration(ms)) out[id] = ms
  return out
}

/** Each option `VxHistoryOptions` names, with its kind: derived from the type, so the two cannot drift. */
const VX_HISTORY_KEYS: PluginOptionKinds<VxHistoryOptions> = {
  window: 'number',
  resources: 'any',
  memory: 'number',
  reservations: 'object',
  assume: 'object',
  file: 'string',
  url: 'string',
  headers: 'object',
  issuer: 'string',
  repository: 'string',
}

/** `vxHistory({ issuer, repository })`, checked; the server's requests name them. */
function namedOf(issuer: unknown, repository: unknown): Named {
  if (typeof issuer !== 'string' || !/^https?:\/\/\S+$/.test(issuer))
    throw new UserError(
      `vxHistory(): issuer must be the CI issuer's URL (https://token.actions.githubusercontent.com), got ${String(issuer)}`,
    )
  if (typeof repository !== 'string' || !/^[^/\s]+(\/[^/\s]+)+$/.test(repository))
    throw new UserError(`vxHistory(): repository must be org/name, got ${String(repository)}`)
  return { issuer: issuer.replace(/\/$/, ''), repository: repository.toLowerCase() }
}

/** `VX_HISTORY_URL` under the option, trailing slashes dropped; undefined when neither names one. */
function serverUrlOf(
  option: string | undefined,
  env: Record<string, string | undefined> = Bun.env,
): string | undefined {
  const url = (option ?? env.VX_HISTORY_URL)?.replace(/\/+$/, '')
  if (url === undefined || url === '') return undefined
  // Named as the workspace set it: a bad VX_HISTORY_URL was refused as `url`.
  const from = option === undefined ? 'VX_HISTORY_URL' : 'url'
  if (!/^https?:\/\//.test(url))
    throw new UserError(`vxHistory(): ${from} must be http(s), got ${url}`)
  // Each route is the server's /v1/…: one that names /v1 asked /v1/v1/…, and every answer was a 404.
  if (url.endsWith('/v1'))
    throw new UserError(
      `vxHistory(): ${from} is the server's base, without /v1: ${url.slice(0, -3)}`,
    )
  return url
}

/** `vxHistory({ headers })` with unset values left out; a name or value no header can carry, or `authorization`, refused, never printing a value. */
function proxyHeaders(
  headers: Record<string, string | undefined> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value === undefined) continue
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || name.toLowerCase() === 'authorization')
      throw new UserError(`vxHistory() option "headers" cannot set "${name}"`)
    if (typeof value !== 'string' || /[\r\n\0]/.test(value))
      throw new UserError(
        `vxHistory() option "headers.${name}" must be one line of text (its value is not printed)`,
      )
    out[name] = value
  }
  return out
}

export function vxHistory(options: VxHistoryOptions = {}): VxPlugin {
  refuseUnknownOptions('vxHistory()', options, VX_HISTORY_KEYS)
  const named =
    options.url === undefined && options.issuer === undefined && options.repository === undefined
      ? undefined
      : namedOf(options.issuer, options.repository)
  // At the call: refused once a server was named, a laptop passed what
  // failed the first CI run.
  const headers = proxyHeaders(options.headers)
  // `'any'` above lets `null` through, and every run then failed in
  // `schedule` reading `null.headroom`.
  const { resources } = options
  if (
    resources !== undefined &&
    resources !== false &&
    (resources === null || typeof resources !== 'object' || Array.isArray(resources))
  ) {
    throw new UserError(
      `vxHistory() option "resources" must be false or an object, got ${JSON.stringify(resources) ?? String(resources)}`,
    )
  }
  // A misspelt key inside was read as unset, unsaid. Values stay `any`:
  // a bad number warns per run (`numberWarnings`), as at the top level.
  if (resources !== undefined && resources !== false) {
    refuseUnknownOptions('vxHistory() option "resources"', resources, { headroom: 'any' })
  }
  for (const [id, r] of Object.entries(options.reservations ?? {})) {
    if (r !== null && typeof r === 'object' && !Array.isArray(r)) {
      refuseUnknownOptions(`vxHistory() option "reservations[${JSON.stringify(id)}]"`, r, {
        cpus: 'any',
        memory: 'any',
      })
    }
  }
  // Checked here, not in a run's `setup`: `vx show` and a `--dry` plan
  // took a url no request can carry, and every run failed on it.
  if (options.url !== undefined) serverUrlOf(options.url)
  // `''` resolved to the workspace root: each run warned it could not read
  // a directory and failed in teardown renaming its timings over it.
  if (options.file !== undefined && options.file.trim() === '') {
    throw new UserError(
      `vxHistory() option "file" must be a path, got ${JSON.stringify(options.file)}`,
    )
  }
  const hooks: Parameters<typeof definePlugin>[1] = {
    commands: {
      history: {
        description:
          'What vx-history learned per task (p50, peak RSS, CPU parallelism) and the reservation it packs.',
        run: (argv, ctx) => historyCmd(argv, ctx, options),
      },
    },
    // Core calls it once per run, so the history is read once per run, and
    // a second run in the same process (`vx watch`) reads its own.
    async schedule(nodes, ctx) {
      numberWarnings(options, ctx.warn)
      const file =
        options.file === undefined ? undefined : path.resolve(ctx.workspaceRoot, options.file)
      // Loaded with the option: every run evaluates the workspace config.
      const carried =
        file === undefined
          ? {}
          : carriedOf((await import('./timings-file.js')).readTimings(file, ctx.warn))
      const defs = taskDefinitions(nodes.values())
      if (file !== undefined)
        scheduled = {
          file,
          carried,
          cache: ctx.localCache,
          ids: [...nodes.keys()],
          branch: ctx.branch,
          defs,
        }
      // Only a task that runs a command has a timing: a group asked for
      // read as a task with no history on this branch, so every run
      // tried a default-branch import (and paid a query per group).
      const ids: string[] = []
      for (const n of nodes.values()) if (n.config.exec?.command !== undefined) ids.push(n.id)
      let table: ReadonlyMap<string, TaskResources>
      let provider: LocalHistoryProvider
      try {
        provider = new LocalHistoryProvider(
          ctx.localCache.dbHandle(),
          windowOf(options),
          ctx.branch,
          defs,
        )
        table = await provider.resourcesFor(ids)
      } catch (err) {
        // Failing open: a broken history read costs the ordering and the
        // learned reservations, never the run.
        ctx.warn(
          `[vx] vx-history: ordering falls back to the baseline: ${err instanceof Error ? err.message : String(err)}`,
        )
        return undefined
      }
      reservations = reservationsFor(nodes.keys(), table, options)
      // Once a run: the server's numbers order it a second time.
      const assumed = { ...assumptions(options, ctx.warn), ...carried }
      const order = (t: ReadonlyMap<string, TaskResources>): ReadonlyMap<string, number> =>
        criticalPath([...nodes.values()], t, assumed)
      // With a history server, its numbers re-rank what has not started
      // when they land; the run never waits on them.
      remote ??= await serverOf()
      // The run's refs, as a remote cache reads them: its branch, the
      // branch it merges into, the default branch (`baseBranch`). `main`
      // was assumed, so a `master` or `baseBranch: 'trunk'` repository
      // read no trunk's numbers; a run with none asks nothing.
      const refs = ctx.refs
      if (remote !== undefined && refs.length > 0) {
        const server = remote
        let late = false
        stopImport = () => (late = true)
        const weights = (async () => {
          const hashes = [...new Set(ids.flatMap((id) => defs.get(id) ?? []))]
          const got = await server.query([...new Set(refs)], hashes)
          const timings = new Map<string, number>()
          const needs = new Map<string, TaskResources>()
          for (const id of ids) {
            const t = got.get(defs.get(id) ?? '')
            if (t === undefined) continue
            timings.set(id, t.durationMs)
            needs.set(id, {
              p50DurationMs: t.durationMs,
              ...(t.cores === undefined ? {} : { maxCpuParallelism: t.cores }),
              ...(t.rssBytes === undefined ? {} : { maxPeakRssBytes: t.rssBytes }),
            })
          }
          // A run that ended first writes nothing: its cache is closing.
          if (timings.size === 0 || late) return undefined
          const sha = `vx-history-server:${Bun.hash(JSON.stringify([...got])).toString(16)}`
          if (!provider.hasImported(sha)) provider.importTimings(sha, timings, needs, defs)
          const fresh = await provider.resourcesFor(ids)
          reservations = reservationsFor(nodes.keys(), fresh, options)
          return order(fresh)
        })().catch((err: unknown) => {
          if (!late) {
            ctx.warn(
              `[vx] vx-history: the timings of the history server at ${server.url} were not applied: ${err instanceof Error ? err.message : String(err)}`,
            )
          }
          return undefined
        })
        ctx.refine(weights)
      }
      return order(table)
    },
  }
  // The run's history server, when one is named and the job has a token.
  let remote: HistoryServer | undefined
  // Loaded only when a server is named: every run evaluates the config.
  const serverOf = async (): Promise<HistoryServer | undefined> => {
    if ((options.url ?? Bun.env.VX_HISTORY_URL ?? '') === '') return undefined
    // VX_HISTORY_URL alone: the workspace names no repository to ask for,
    // so the URL is never read; parsed first, a malformed one failed the run.
    if (named === undefined) return undefined
    const m = await import('./history-server.js')
    const url = serverUrlOf(options.url)
    if (url === undefined) return undefined
    return new m.HistoryServer(url, named, Bun.env, fetch, headers)
  }
  // What the run sends the history server at its end, by task definition.
  let reported: Reported | undefined
  // The upload, once the run has ended.
  let uploading: Upload | undefined
  // Stops the server's answer from landing once the run is over: no row
  // lands after the cache closes.
  let stopImport: (() => void) | undefined
  // The timings file is written for a run only: `schedule` also orders a
  // `--dry` plan, which has no `setup` and records nothing.
  let scheduled:
    | {
        file: string
        carried: Readonly<Record<string, number>>
        cache: Cache
        ids: string[]
        branch: string | null
        defs: ReadonlyMap<string, string>
      }
    | undefined
  let inRun = false
  // A run that executed nothing and restored only tasks the file already
  // times leaves it as it was: an all-cached CI run re-reads no history.
  let changed = false
  let fileWarn: { root: string; warn: (m: string) => void } | undefined
  hooks.setup = async (ctx) => {
    remote ??= await serverOf()
    if (remote?.writes === true) {
      const { timingOf: timing } = await import('./history-server.js')
      // Only the run that ran the tasks hears them: under DTE, the
      // orchestrator, with each worker's measurements.
      const timings = new Map<string, ServerTiming>()
      const sent = (reported = { timings, warn: ctx.warn })
      const server = remote
      ctx.on('onTaskComplete', (node, outcome) => {
        if (node.config.exec?.command === undefined) return
        const def = taskDefinitions([node]).get(node.id)
        const t = timing(outcome)
        if (def !== undefined && t !== undefined) timings.set(def, t)
      })
      // Every outcome is known here, and core's own end of run (history
      // rows, cache uploads, telemetry) is still ahead: sent from teardown,
      // a new OIDC token and the upload shared its 3 s bound.
      ctx.on('onRunEnd', () => {
        if (reported === sent) uploading ??= sendTimings(server, sent)
      })
    } else if (remote !== undefined) {
      if (ctx.ci)
        ctx.warn(
          Bun.env.GITHUB_ACTIONS === 'true'
            ? '[vx] vx-history: this job gets no OIDC token for the history server (give it `permissions: id-token: write`): it reads only'
            : '[vx] vx-history: no CI token for the history server (name an id_tokens entry VX_HISTORY_TOKEN): it reads only',
        )
    } else if ((options.url ?? Bun.env.VX_HISTORY_URL ?? '') !== '') {
      ctx.warn(
        '[vx] vx-history: VX_HISTORY_URL names a server, but vxHistory() names no issuer and repository: the server is not asked',
      )
    }
    if (options.file === undefined) return
    fileWarn = { root: ctx.workspaceRoot, warn: ctx.warn }
    inRun = true
    changed = false
    ctx.on('onTaskComplete', (node, outcome) => {
      // A group runs nothing and is never timed: counting it rewrote the
      // file on every all-cached run that went through one.
      if (node.config.exec?.command === undefined) return
      if (outcome.status === 'success' || !(node.id in (scheduled?.carried ?? {}))) {
        changed = true
      }
    })
  }
  // After the run's history is recorded and before its cache closes.
  hooks.teardown = async () => {
    stopImport?.()
    stopImport = undefined
    const server = remote
    const sent = reported
    const up = uploading
    remote = undefined
    reported = undefined
    uploading = undefined
    // Counted from here: the file's write below shares the bound.
    const waited = server !== undefined && sent !== undefined ? waitFor(UPLOAD_WAIT_MS) : undefined
    const done = scheduled
    const wrote = inRun && changed
    scheduled = undefined
    inRun = false
    // The file first: core bounds a teardown (3 s), and an upload ahead of
    // it held the write hostage to the server's network. A failed write
    // still sends.
    try {
      if (wrote && done !== undefined) {
        const table = await readHistory(done.cache, done.ids, options, done.branch, done.defs)
        const timings = await import('./timings-file.js')
        // Over the file as it is now: a time another writer (a run in another
        // worktree sharing it) put there since `schedule` read it is kept. Its
        // fault, if any, was said when the run read it.
        const now = timings.readTimings(done.file, () => {})
        let written = true
        try {
          timings.writeTimings(done.file, { ...done.carried, ...now }, table)
        } catch (err) {
          // Only the file is lost: said as the read is, not as a plugin failure.
          written = false
          fileWarn?.warn(
            `[vx] vx-history: timings file ${done.file} not written: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        if (written && fileWarn !== undefined)
          timings.warnUnignored(done.file, fileWarn.root, fileWarn.warn)
      }
    } finally {
      if (server !== undefined && sent !== undefined && waited !== undefined) {
        const u = up ?? sendTimings(server, sent)
        const late = await Promise.race([u.done.then(() => false), waited.done])
        waited.cancel()
        if (late) {
          u.stop.abort()
          const n = sent.timings.size
          sent.warn(
            `[vx] vx-history: the timings of ${n} task${n === 1 ? '' : 's'} were not sent to the history server at ${server.url}: no answer in the ${UPLOAD_WAIT_MS} ms a teardown waits`,
          )
        }
      }
    }
  }
  // What the run's tasks reserve, learned in `schedule` (one history read
  // serves both) and declared in the options; asked at every dispatch.
  let reservations: ReadonlyMap<string, ResourceEstimate> = new Map(
    Object.entries(declaredOf(options) ?? {}),
  )
  if (options.resources !== false || options.reservations !== undefined) {
    // Read on the first admit: every config evaluation runs this factory,
    // and the default budget is cgroup reads on Linux.
    let memoryMb: number | undefined
    hooks.admit = (task, ctx) =>
      admits(
        task.id,
        ctx.running.map((r) => r.id),
        reservations,
        {
          cpus: ctx.concurrency,
          memory: (memoryMb ??= memoryBudgetMb(options)),
        },
      )
  }
  return definePlugin(import.meta, hooks)
}

interface Reported {
  readonly timings: Map<string, ServerTiming>
  readonly warn: (m: string) => void
}

interface Upload {
  /** Settles when sent, or once a failure is said; never rejects. */
  readonly done: Promise<void>
  readonly stop: AbortController
}

/**
 * How long a teardown waits for the upload: under core's bound on one
 * teardown (3 s, `teardownTimeoutMs`), so a dropped upload is said here,
 * with what it dropped, and not as core's line that names no cause.
 */
const UPLOAD_WAIT_MS = 2_000

function sendTimings(server: HistoryServer, sent: Reported): Upload {
  const stop = new AbortController()
  const done = server.upload(sent.timings, stop.signal).catch((err: unknown) => {
    // Abandoned by teardown, which says so itself.
    if (stop.signal.aborted) return
    sent.warn(
      `[vx] vx-history: the timings were not sent to the history server at ${server.url}: ${err instanceof Error ? err.message : String(err)}`,
    )
  })
  return { done, stop }
}

/** Resolves true after `ms`, unless cancelled first. */
function waitFor(ms: number): { done: Promise<true>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  const done = new Promise<true>((resolve) => {
    timer = setTimeout(() => resolve(true), ms)
  })
  return { done, cancel: () => clearTimeout(timer) }
}

/** Default multiplier over the largest peak RSS seen — the asymmetry: over-reserving costs some parallelism, under-reserving meets the OOM killer. */
const DEFAULT_HEADROOM = 1.25
const MB = 1024 * 1024
/** Reservations round up to this so a jittery RSS does not re-key the packing every run. */
const MEMORY_STEP_MB = 64

export interface ResourceEstimate {
  readonly cpus?: number
  readonly memory?: number
}

/**
 * What each task should reserve, from its history: memory is the largest
 * peak RSS in the window times `headroom`, rounded UP to 64 MB and omitted
 * under one step (nothing worth packing). Cores are never learned: the
 * parallelism a build shows is what the machine let it have (1.0× beside
 * three others, 2.0× alone), reserving the solo reading packs a four-core
 * box two wide, and that idles cores through every single-threaded phase —
 * 160 s against 132 s on 92 real builds (2026-09-15). `reservations` may
 * still declare `cpus`. Tasks with no execution in the window are absent.
 */
export function resourceEstimates(
  nodes: ReadonlyMap<string, TaskNode>,
  history: HistoryTable,
  headroom = DEFAULT_HEADROOM,
): ReadonlyMap<string, ResourceEstimate> {
  return estimatesFor(nodes.keys(), history, headroom)
}

function estimatesFor(
  ids: Iterable<string>,
  history: ReadonlyMap<string, TaskResources>,
  headroom: number,
): ReadonlyMap<string, ResourceEstimate> {
  const out = new Map<string, ResourceEstimate>()
  for (const id of ids) {
    const rss = history.get(id)?.maxPeakRssBytes
    if (rss === undefined) continue
    const mb = (rss * headroom) / MB
    if (mb >= MEMORY_STEP_MB)
      out.set(id, { memory: Math.ceil(mb / MEMORY_STEP_MB) * MEMORY_STEP_MB })
  }
  return out
}

/**
 * A declared axis wins over the learned one, and an axis the declaration
 * leaves out keeps it: cores are only ever declared, and declaring them
 * dropped the task's learned memory. A task with neither reserves nothing.
 */
export function withDeclared(
  learned: ReadonlyMap<string, ResourceEstimate>,
  declared: Readonly<Record<string, ResourceEstimate>> | undefined,
): ReadonlyMap<string, ResourceEstimate> {
  if (declared === undefined) return learned
  const out = new Map(learned)
  for (const [id, r] of Object.entries(declared)) {
    const merged: { cpus?: number; memory?: number } = { ...learned.get(id) }
    if (r.cpus !== undefined) merged.cpus = r.cpus
    if (r.memory !== undefined) merged.memory = r.memory
    if (merged.cpus !== undefined || merged.memory !== undefined) out.set(id, merged)
  }
  return out
}

export interface Budgets {
  /** Cores: the run's worker count, which the count gate already applies. */
  readonly cpus: number
  /** Megabytes. */
  readonly memory: number
}

/**
 * The packing rule, per axis: a task reserving nothing is admitted; one
 * within the budget needs the headroom left by what runs; one over the
 * whole budget can never have it, so it runs alone — admitted only when
 * nothing else runs, which an idle machine always reaches, so it never
 * starves. Whole megabytes and cores, so sums are exact.
 */
export function admits(
  id: string,
  running: readonly string[],
  reservations: ReadonlyMap<string, ResourceEstimate>,
  budgets: Budgets,
): boolean {
  const mine = reservations.get(id)
  if (mine === undefined) return true
  let cpus = 0
  let memory = 0
  for (const r of running) {
    const theirs = reservations.get(r)
    if (theirs === undefined) continue
    cpus += theirs.cpus ?? 0
    memory += theirs.memory ?? 0
  }
  return (
    fitsAxis(mine.cpus ?? 0, cpus, running.length, budgets.cpus) &&
    fitsAxis(mine.memory ?? 0, memory, running.length, budgets.memory)
  )
}

function fitsAxis(cost: number, reserved: number, holders: number, budget: number): boolean {
  if (cost === 0) return true
  return cost <= budget ? reserved + cost <= budget : holders === 0
}
// `vx history` — the plugin's own surface for what it learned. The
// reservations are decided at dispatch and shown nowhere by core (core
// holds no notion of them), so without this a developer could not tell
// what the plugin will pack, or why two tasks stopped overlapping.
async function historyCmd(
  argv: readonly string[],
  ctx: CommandContext,
  options: VxHistoryOptions,
): Promise<number> {
  let format: 'pretty' | 'json' = 'pretty'
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    // A plugin verb owns its help; completions offer `--help` for every verb.
    if (a === '--help' || a === '-h') {
      ui.say('info', 'Usage: vx history [--format pretty|json]', 'out')
      process.stdout.write('\n')
      ui.say(
        'info',
        'What vx-history learned per task (p50, peak RSS, CPU parallelism) and the reservation it packs.',
        'out',
      )
      return 0
    }
    if (a === '--format' || a.startsWith('--format=')) {
      const v = a === '--format' ? argv[++i] : a.slice(9)
      if (v !== 'pretty' && v !== 'json') {
        throw new UserError(
          `vx history: invalid --format: ${v ?? ''} (expected pretty | json)`,
          'VX_E_USAGE',
        )
      }
      format = v
      continue
    }
    throw new UserError(`vx history: unknown flag: ${a} (only --format pretty|json)`, 'VX_E_USAGE')
  }
  // The tasks a run would see, plugin stages included — the same ids the
  // `schedule` hook is handed.
  const projects = await loadResolvedProjects(ctx.workspaceRoot, { scope: 'all', warn: ctx.warn })
  const ids: string[] = []
  const tasks: Pick<TaskNode, 'id' | 'config'>[] = []
  for (const p of projects.values()) {
    for (const [t, config] of Object.entries(p.config.tasks ?? {})) {
      ids.push(`${p.name}#${t}`)
      tasks.push({ id: `${p.name}#${t}`, config })
    }
  }
  numberWarnings(options, ctx.warn)
  const window = windowOf(options)
  const cache = new Cache(ctx.cacheDir)
  let table: HistoryTable
  try {
    // Each task's rows of its definition as it is now, as `schedule` reads
    // them: read with every definition's, a task whose command changed
    // showed the old command's peak and a reservation no run packs.
    table = await new LocalHistoryProvider(
      cache.dbHandle(),
      window,
      currentBranch(ctx.workspaceRoot),
      // As a run reads them: a task whose command changed has no rows yet.
      taskDefinitions(tasks as TaskNode[]),
    ).loadFor(ids)
  } finally {
    cache.close()
  }
  const reservations = reservationsFor(ids, table, options)
  const budgets: Budgets = {
    cpus: ctx.concurrency,
    memory: memoryBudgetMb(options),
  }
  const rows: HistoryRow[] = ids.map((id) => {
    const h = table.get(id)
    return {
      id,
      runs: h?.runs ?? 0,
      p50DurationMs: h?.p50DurationMs ?? null,
      maxPeakRssBytes: h?.maxPeakRssBytes ?? null,
      maxCpuParallelism: h?.maxCpuParallelism ?? null,
      reservation: reservations.get(id) ?? null,
      declared: options.reservations?.[id] !== undefined,
    }
  })
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify({ window, budgets, tasks: rows })}\n`)
    return 0
  }
  // The table's module loads with the verb, off every run's path.
  const { renderHistory } = await import('./history-view.js')
  process.stdout.write(renderHistory(rows, window, budgets, usable(options.memory)))
  return 0
}
