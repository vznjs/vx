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
  definePlugin,
  LocalHistoryProvider,
  machineMemoryBytes,
  Cache,
  type HistoryTable,
  type TaskNode,
  type VxPlugin,
  loadResolvedProjects,
  UserError,
} from '@vzn/vx'
import type { CommandContext } from '@vzn/vx'
import { criticalPathPriorities } from './critical-path.js'
import { renderHistory, type HistoryRow } from './history-view.js'

export { criticalPathPriorities } from './critical-path.js'

export interface ScheduleHistoryOptions {
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
   * runner cannot see. A declared reservation wins over a learned one.
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
}

// The provider's own default (50) serves `--dry` predictions; an ordering
// hint needs less and reads a 2.5× smaller slice of the run history.
const DEFAULT_WINDOW = 20

// Each option is read in ONE place that a run's hooks and `vx history`
// share: two copies of each let either drift unseen (item 805).
const windowOf = (options: ScheduleHistoryOptions): number =>
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
function numberWarnings(options: ScheduleHistoryOptions, warn: (m: string) => void): void {
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
    for (const axis of ['cpus', 'memory'] as const) {
      const v = (r as Record<string, unknown> | null)?.[axis]
      if (v !== 0) check(`reservations[${JSON.stringify(id)}].${axis}`, v, 'none')
    }
  }
  if (bad.length > 0) {
    warn(`[vx] schedule-history: ignores ${bad.join(', ')} — each must be a finite number above 0`)
  }
}

/**
 * The declared reservations, each axis only where it is a number above 0.
 * A NaN (`Number(process.env.X)`, X unset) held a task alone and every
 * reserving task beside it waited — the NaN summed into what runs — so the
 * run went serial and said nothing (G-4's class). A bad axis reserves
 * nothing, named by `numberWarnings`.
 */
function declaredOf(
  options: ScheduleHistoryOptions,
): Readonly<Record<string, ResourceEstimate>> | undefined {
  if (options.reservations === undefined) return undefined
  const out: Record<string, ResourceEstimate> = {}
  for (const [id, r] of Object.entries(options.reservations)) {
    const e: { cpus?: number; memory?: number } = {}
    if (usable(r?.cpus)) e.cpus = r.cpus
    if (usable(r?.memory)) e.memory = r.memory
    out[id] = e
  }
  return out
}

const headroomOf = (options: ScheduleHistoryOptions): number => {
  const h = options.resources === false ? undefined : options.resources?.headroom
  return usable(h) ? h : DEFAULT_HEADROOM
}

const readHistory = (
  cache: Cache,
  ids: readonly string[],
  options: ScheduleHistoryOptions,
): Promise<HistoryTable> =>
  new LocalHistoryProvider(cache.dbHandle(), windowOf(options)).loadFor(ids)

/** What each task reserves: learned from the history unless `resources: false`, a declared reservation over either. */
const reservationsFor = (
  ids: Iterable<string>,
  table: HistoryTable,
  options: ScheduleHistoryOptions,
): ReadonlyMap<string, ResourceEstimate> =>
  withDeclared(
    options.resources !== false ? estimatesFor(ids, table, headroomOf(options)) : new Map(),
    declaredOf(options),
  )

const memoryBudgetMb = (options: ScheduleHistoryOptions): number =>
  usable(options.memory) ? options.memory : Math.floor(machineMemoryBytes() / MB)

/**
 * The `assume` durations that are finite non-negative numbers. A NaN
 * (`Number(process.env.X)` with X unset) became a NaN weight and a string
 * (an untyped `.mjs` config) string weights, and core refused both as a
 * UserError: an ordering hint failed the run (item 930). The rest are
 * dropped by name, as a broken history read costs only the ordering.
 */
function assumptions(
  options: ScheduleHistoryOptions,
  warn: (m: string) => void,
): Readonly<Record<string, number>> {
  const ok: Record<string, number> = {}
  const bad: string[] = []
  for (const [id, ms] of Object.entries(options.assume ?? {})) {
    if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) ok[id] = ms
    else bad.push(id)
  }
  if (bad.length > 0) {
    warn(
      `[vx] schedule-history: assume ignores ${bad.map((id) => JSON.stringify(id)).join(', ')} — each must be a finite number of ms`,
    )
  }
  return ok
}

export function scheduleHistoryPlugin(options: ScheduleHistoryOptions = {}): VxPlugin {
  const hooks: Parameters<typeof definePlugin>[1] = {
    commands: {
      history: {
        description:
          'what this plugin learned per task — p50, peak RSS, CPU parallelism — and the reservation it packs',
        run: (argv, ctx) => historyCmd(argv, ctx, options),
      },
    },
    // Core calls it once per run, so the history is read once per run, and
    // a second run in the same process (`vx watch`) reads its own.
    async schedule(nodes, ctx) {
      numberWarnings(options, ctx.warn)
      let table: HistoryTable
      try {
        table = await readHistory(ctx.localCache, [...nodes.keys()], options)
      } catch (err) {
        // Failing open: a broken history read costs the ordering and the
        // learned reservations, never the run.
        ctx.warn(
          `[vx] schedule-history: ordering falls back to the baseline: ${err instanceof Error ? err.message : String(err)}`,
        )
        return undefined
      }
      reservations = reservationsFor(nodes.keys(), table, options)
      return criticalPathPriorities([...nodes.values()], table, assumptions(options, ctx.warn))
    },
  }
  // What the run's tasks reserve, learned in `schedule` (one history read
  // serves both) and declared in the options; asked at every dispatch.
  let reservations: ReadonlyMap<string, ResourceEstimate> = new Map(
    Object.entries(declaredOf(options) ?? {}),
  )
  if (options.resources !== false || options.reservations !== undefined) {
    const memoryMb = memoryBudgetMb(options)
    hooks.admit = (task, ctx) =>
      admits(
        task.id,
        ctx.running.map((r) => r.id),
        reservations,
        {
          cpus: ctx.concurrency,
          memory: memoryMb,
        },
      )
  }
  return definePlugin(import.meta, hooks)
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
  history: HistoryTable,
  headroom: number,
): ReadonlyMap<string, ResourceEstimate> {
  const out = new Map<string, ResourceEstimate>()
  for (const id of ids) {
    const h = history.get(id)
    if (h === undefined) continue
    const est: { memory?: number } = {}
    if (h.maxPeakRssBytes !== undefined) {
      const mb = (h.maxPeakRssBytes * headroom) / MB
      if (mb >= MEMORY_STEP_MB) est.memory = Math.ceil(mb / MEMORY_STEP_MB) * MEMORY_STEP_MB
    }
    if (est.memory !== undefined) out.set(id, est)
  }
  return out
}

/**
 * A declared reservation wins over a learned one; a task with neither
 * reserves nothing.
 */
export function withDeclared(
  learned: ReadonlyMap<string, ResourceEstimate>,
  declared: Readonly<Record<string, ResourceEstimate>> | undefined,
): ReadonlyMap<string, ResourceEstimate> {
  if (declared === undefined) return learned
  const out = new Map(learned)
  for (const [id, r] of Object.entries(declared)) out.set(id, r)
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
  options: ScheduleHistoryOptions,
): Promise<number> {
  let format: 'pretty' | 'json' = 'pretty'
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    // A plugin verb owns its help; completions offer `--help` for every verb.
    if (a === '--help' || a === '-h') {
      process.stdout.write(
        'Usage: vx history [--format pretty|json]\n\nWhat schedule-history learned per task (p50, peak RSS, CPU parallelism) and the reservation it packs.\n',
      )
      return 0
    }
    if (a === '--format' || a.startsWith('--format=')) {
      const v = a === '--format' ? argv[++i] : a.slice(9)
      if (v !== 'pretty' && v !== 'json') {
        throw new UserError(`vx history: invalid --format: ${v ?? ''} (expected pretty | json)`)
      }
      format = v
      continue
    }
    throw new UserError(`vx history: unknown flag: ${a} (only --format pretty|json)`)
  }
  // The tasks a run would see, plugin stages included — the same ids the
  // `schedule` hook is handed.
  const projects = await loadResolvedProjects(ctx.workspaceRoot, { scope: 'all', warn: ctx.warn })
  const ids: string[] = []
  for (const p of projects.values()) {
    for (const t of Object.keys(p.config.tasks ?? {})) ids.push(`${p.name}#${t}`)
  }
  numberWarnings(options, ctx.warn)
  const window = windowOf(options)
  const cache = new Cache(ctx.cacheDir)
  let table: HistoryTable
  try {
    table = await readHistory(cache, ids, options)
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
  process.stdout.write(renderHistory(rows, window, budgets, usable(options.memory)))
  return 0
}
