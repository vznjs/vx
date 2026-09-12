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
  type Cache,
  type HistoryTable,
  type TaskNode,
  type VxPlugin,
} from '@vzn/vx'

/** Default duration when neither task history nor a workspace median exists. */
const DEFAULT_DURATION_MS = 1000

export interface ScheduleHistoryOptions {
  /** How many recent invocations to learn from. Default 20. */
  readonly window?: number
  /**
   * Pack tasks by what their last `window` executions actually used
   * (`admit` stage): a task's reservation is the largest peak RSS seen
   * times `headroom`, rounded up to 64 MB, and the most CPU parallelism
   * seen, rounded to a core; a task is admitted while the reservations of
   * everything running beside it fit the budgets, and a task over a
   * whole budget runs alone. A task with no execution in the window
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

export function scheduleHistoryPlugin(options: ScheduleHistoryOptions = {}): VxPlugin {
  // One history read per run serves both hooks: `graph` runs first and
  // keeps the table for `schedule`, keyed on the cache handle so a second
  // run in the same process (`vx watch`) reads its own, fresher history.
  let memo: { cache: Cache; table: HistoryTable } | undefined
  const load = async (
    nodes: ReadonlyMap<string, TaskNode>,
    ctx: { readonly localCache: Cache; readonly warn: (m: string) => void },
    stage: string,
  ): Promise<HistoryTable | undefined> => {
    if (memo !== undefined && memo.cache === ctx.localCache) return memo.table
    const provider = new LocalHistoryProvider(
      ctx.localCache.dbHandle(),
      options.window ?? DEFAULT_WINDOW,
    )
    try {
      const table = await provider.loadFor([...nodes.keys()])
      memo = { cache: ctx.localCache, table }
      return table
    } catch (err) {
      // Failing open: a broken history read costs the ordering (or the
      // reservations), never the run.
      ctx.warn(
        `[vx] schedule-history: ${stage} falls back to the baseline: ${err instanceof Error ? err.message : String(err)}`,
      )
      return undefined
    }
  }
  const hooks: Parameters<typeof definePlugin>[1] = {
    async schedule(nodes, ctx) {
      const table = await load(nodes, ctx, 'ordering')
      if (table === undefined) return undefined
      if (options.resources !== false) {
        reservations = withDeclared(
          resourceEstimates(nodes, table, options.resources?.headroom ?? DEFAULT_HEADROOM),
          options.reservations,
        )
      }
      return criticalPathPriorities([...nodes.values()], table, options.assume)
    },
  }
  // What the run's tasks reserve, learned in `schedule` (one history read
  // serves both) and declared in the options; asked at every dispatch.
  let reservations: ReadonlyMap<string, ResourceEstimate> = new Map(
    Object.entries(options.reservations ?? {}),
  )
  if (options.resources !== false || options.reservations !== undefined) {
    const memoryMb = options.memory ?? Math.floor(machineMemoryBytes() / MB)
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
 * under one step (nothing worth packing); cpus is the most parallelism
 * seen, rounded to a whole core and omitted at one (a worker slot already
 * is one core). Tasks with no execution in the window are absent.
 */
export function resourceEstimates(
  nodes: ReadonlyMap<string, TaskNode>,
  history: HistoryTable,
  headroom = DEFAULT_HEADROOM,
): ReadonlyMap<string, ResourceEstimate> {
  const out = new Map<string, ResourceEstimate>()
  for (const id of nodes.keys()) {
    const h = history.get(id)
    if (h === undefined) continue
    const est: { cpus?: number; memory?: number } = {}
    if (h.maxPeakRssBytes !== undefined) {
      const mb = (h.maxPeakRssBytes * headroom) / MB
      if (mb >= MEMORY_STEP_MB) est.memory = Math.ceil(mb / MEMORY_STEP_MB) * MEMORY_STEP_MB
    }
    if (h.maxCpuParallelism !== undefined) {
      const cpus = Math.round(h.maxCpuParallelism)
      if (cpus >= 2) est.cpus = cpus
    }
    if (est.memory !== undefined || est.cpus !== undefined) out.set(id, est)
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
/**
 * For each node, the expected remaining critical-path duration: its own p50
 * plus the maximum over its dependents. A node with no history takes its
 * assumed duration if one was given, else the workspace median; an empty
 * history takes a flat default.
 */
export function criticalPathPriorities(
  nodes: readonly TaskNode[],
  history: HistoryTable,
  assume: Readonly<Record<string, number>> = {},
): ReadonlyMap<string, number> {
  const p50s: number[] = []
  for (const h of history.values()) {
    if (h.p50DurationMs !== undefined) p50s.push(h.p50DurationMs)
  }
  p50s.sort((a, b) => a - b)
  const workspaceMedian =
    p50s.length > 0
      ? (p50s[Math.floor(p50s.length / 2)] ?? DEFAULT_DURATION_MS)
      : DEFAULT_DURATION_MS

  const dependentsOf = new Map<string, string[]>()
  for (const n of nodes) {
    for (const upstreamId of n.deps) {
      const list = dependentsOf.get(upstreamId)
      if (list) list.push(n.id)
      else dependentsOf.set(upstreamId, [n.id])
    }
  }
  const ownDuration = (n: TaskNode): number =>
    history.get(n.id)?.p50DurationMs ?? assume[n.id] ?? workspaceMedian

  // Reverse-topological pass: a node's value is final once every dependent's
  // is, so start from the sinks (no dependents) and release each upstream
  // when its last dependent has been scored.
  const memo = new Map<string, number>()
  const nodeById = new Map<string, TaskNode>(nodes.map((n) => [n.id, n]))
  const pending = new Map<string, number>()
  const queue: TaskNode[] = []
  for (const n of nodes) {
    const count = dependentsOf.get(n.id)?.length ?? 0
    pending.set(n.id, count)
    if (count === 0) queue.push(n)
  }
  let head = 0
  while (head < queue.length) {
    const n = queue[head++]!
    let downstream = 0
    for (const dep of dependentsOf.get(n.id) ?? []) {
      const d = memo.get(dep) ?? 0
      if (d > downstream) downstream = d
    }
    memo.set(n.id, ownDuration(n) + downstream)
    for (const up of n.deps) {
      const left = (pending.get(up) ?? 0) - 1
      pending.set(up, left)
      if (left === 0) {
        const upNode = nodeById.get(up)
        if (upNode) queue.push(upNode)
      }
    }
  }
  for (const n of nodes) if (!memo.has(n.id)) memo.set(n.id, ownDuration(n))
  return memo
}
