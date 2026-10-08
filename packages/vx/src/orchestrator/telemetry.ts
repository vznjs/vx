// The telemetry contract — THE canonical, versioned data-export shape.
//
// This is the one neutral boundary the observability/integration design
// (docs/design/observability-architecture-2026-06.md) is built around.
// Core projects its live `RunEvent` stream into these records ONCE, in
// one place (`createTelemetrySource`), and hands them to every registered
// `TelemetrySink`. Exporters (OTel, a manual HTTP POST, any third-party sink) all read
// the SAME records — with the analytics fields + git/CI context already
// folded in — instead of each re-deriving an ad-hoc shape from the raw,
// rendering-oriented `WireEvent` stream.
//
// A sink is observe-only BY CONSTRUCTION: its only input is a plain-data
// record (one object every sink receives, not frozen); its `TelemetryContext` carries read-only metadata and NO mutable
// run handle (no bus, no Cache, no RunRequest). There is no API path from a
// sink back into scheduling/caching/exec — telemetry provably cannot change
// what or how tasks run. Contrast `cache`/`executor`, which return objects
// core calls INTO; those are the behavior capabilities, kept separate.

import { sampleTrees } from '../exec/index.js'
import {
  isGroupTask,
  type InputChanges,
  type TaskNode,
  type TaskOutcome,
  type TaskStatus,
} from '../graph/index.js'
import { maskedCommand, settleWithin, teardownTimeoutMs } from '../util/index.js'
import type { RunEvent, RunEventSubscriber } from './events.js'

/** Bumped when the record shape changes. Readers MUST check `v`. */
export const TELEMETRY_SCHEMA_VERSION = 3

/** Where a task's result came from, derived ONCE in core from the status. */
export type CacheSource = 'miss' | 'local' | 'remote' | 'none'

/**
 * Map a task outcome status to its cache source. `success`/`failed` ran
 * (a miss as far as the cache read is concerned); the two cache-hit
 * statuses restored from local/remote; `skipped`/`aborted` never engaged
 * the cache. Pure function — the single place this mapping is decided;
 * `isCacheHit` below is derived from it rather than re-listing the two
 * hit statuses, so there is one decision, not two that can disagree.
 */
export function deriveCacheSource(status: TaskStatus): CacheSource {
  switch (status) {
    case 'cache-hit':
      return 'local'
    case 'cache-hit-remote':
      return 'remote'
    case 'success':
    case 'failed':
      return 'miss'
    case 'skipped':
    case 'aborted':
      return 'none'
  }
}

/**
 * Whether each status counts as a PASS. Written as a `Record<TaskStatus, …>`
 * rather than a `new Set([...])` on purpose: a Record must name every member,
 * so adding a status to the union is a COMPILE error HERE and the omission
 * cannot ship. A Set of string literals has no such tripwire — it silently
 * answers `false` for the new member, which is how ten hand-rolled copies of
 * this vocabulary accumulated across core, cloud and the dashboard.
 */
const PASSES: Record<TaskStatus, boolean> = {
  success: true,
  'cache-hit': true,
  'cache-hit-remote': true,
  failed: false,
  skipped: false,
  aborted: false,
}

/**
 * Every `TaskStatus`, at runtime. Read off `PASSES`'s keys, which the
 * `Record<TaskStatus, …>` type guarantees is exactly the union — so this is
 * derived, not a second list that can fall behind. Exported so a consumer that
 * cannot import the type (a test asserting a copy of this vocabulary in
 * another package agrees) can still enumerate the real set.
 */
export const TASK_STATUSES: readonly TaskStatus[] = Object.keys(PASSES) as TaskStatus[]

/**
 * Did the task pass? A cache hit counts — it produced the same result without
 * spending the time, which is the whole point. `skipped` and `aborted` do NOT:
 * neither finished on its own terms, so neither can vouch for anything.
 *
 * Takes `string`, not `TaskStatus`, because most callers hold a status that
 * arrived over a wire or out of a database column. An unrecognised string
 * reads as NOT passing — the safe direction, since the alternative is calling
 * a run green on a status this build has never heard of.
 */
export function isPassStatus(status: string): boolean {
  return PASSES[status as TaskStatus] === true
}

/**
 * Did the task's result come out of the cache (either layer)? Derived from
 * `deriveCacheSource` rather than re-listing the two hit statuses, so the two
 * cannot disagree about what a hit is. Unknown strings read as not-a-hit.
 */
export function isCacheHit(status: string): boolean {
  // No known-status guard: an unknown string falls through the switch to
  // undefined, which is neither hit source (the guard survived item 654).
  const source = deriveCacheSource(status as TaskStatus)
  return source === 'local' || source === 'remote'
}

/** Identifies which run a record belongs to + its captured context. Maps
 *  cleanly onto OTel CI/CD + VCS resource attributes. */
export interface RunContextRecord {
  /** ULID, shared by every record in one `vx run`. */
  runId: string
  vxVersion: string
  /** The invocation command line (process.argv-derived), what follows `--` counted, not quoted. */
  command: string
  requestedTasks: readonly string[]
  /** Compact cache-policy flags, e.g. `'lR,lW,rR,rW'`. */
  cachePolicy: string
  concurrency: number
  flow: 'focused' | 'broad' | null
  /**
   * Stable workspace identity (v2) — the multi-workspace server key.
   * Derived from the normalized git remote (any checkout of the same
   * repo → same id); see run-context.ts captureWorkspaceIdentity. A v1
   * consumer synthesizes 'default' for pushes that predate it.
   */
  workspaceId: string
  workspaceName: string
  /** The origin remote, normalized (`github.com/org/repo`); absent without one. Additive. */
  repository?: string
  /** The workspace root relative to its git work tree, `.` at the top; absent outside git. Additive. */
  workspacePath?: string
  // git / CI / host — straight from run-context.ts.
  commitSha: string | null
  branch: string | null
  /**
   * The repository's DEFAULT (trunk) branch, when detectable (v2 additive).
   * A run is a TRUNK run iff `branch === defaultBranch` (both non-null);
   * everything else is PR / feature-branch work. Consumers use it to keep
   * branch-experiment timings out of the shared scheduling baseline; null
   * (undetectable) means "count all runs" — no regression. Required of a v2
   * producer (every one emits it); a reader parsing an older v1 push, which
   * predates the field, treats absent as null.
   */
  defaultBranch: string | null
  dirty: boolean | null
  ci: boolean
  ciProvider: string | null
  /** The CI provider's page for this run. */
  ciRunUrl?: string
  /** The pull or merge request number the run builds. */
  ciChange?: string
  /** The CI workflow or pipeline name. */
  ciPipeline?: string
  /** The CI job (or step) within it. */
  ciJob?: string
  /** 1 on a first run, 2 on its first re-run. */
  ciAttempt?: number
  host: string | null
  os: string
  arch: string
  /** `--tag k=v` pairs. */
  tags: Readonly<Record<string, string>>
}

/** One attempt of a retried task that failed and was run again. */
export interface FailedAttempt {
  /** When the attempt ended, epoch ms. */
  endedAt: number
  exitCode: number
  /** vx's own `timeout` ended it. */
  timedOut?: true
}

/** Denormalized per-task analytics — shared by the streaming `task.end`
 *  record and the per-run summary's `tasks[]`. */
export interface TaskTelemetry {
  taskId: string
  project: string
  task: string
  status: TaskStatus
  cacheSource: CacheSource
  exitCode: number
  durationMs: number
  hash?: string
  cpuMs?: number
  peakRssBytes?: number
  /** Executor-reported placement (a worker id) — absent for local runs.
   *  Additive-optional, no schema bump (the `attempts` precedent). */
  where?: string
  /** `'deferred'` when the outputs stayed remote (`--download=none`).
   *  Additive-optional, same no-bump precedent as `where`. */
  outputs?: 'deferred'
  /** Total attempts when the task RETRIED (>1) — set only when `exec.retries`
   *  / `--retry` produced more than one attempt. A retried-then-passed task is
   *  flaky by definition; this is the telemetry-side flaky signal. */
  attempts?: number
  /**
   * On a `skipped` task: the id of the failed (or aborted) task at the
   * root of what blocked it, through any chain of skips. Absent on a
   * fail-fast skip and on every other status. Additive (schema stays 2).
   */
  blockedBy?: string
  /** On a `failed` task: vx's own `timeout` killed it (exit 143 is the deadline, not a signal). Additive. */
  timedOut?: true
  /** On a sandboxed task: how many declared-boundary violations the sandbox recorded (a failure on its own). Additive. */
  sandboxViolations?: number
  /** On a failed persistent task: why it never became ready. `exitCode` is the child's own when it exited. Additive. */
  notReady?: 'timeout' | 'exited' | 'spawn'
  /** On a task that retried: each attempt that failed before the last, in order. Additive. */
  failedAttempts?: readonly FailedAttempt[]
  /** On a task proved flaky this run: its key's passes and failures on record. Additive. */
  flaky?: { passes: number; failures: number }
  /** On a sandboxed task: the violation lines themselves, one per denial. Additive. */
  sandboxViolationLines?: readonly string[]
  /** On a cache hit: how long the run that stored the entry took — the time this hit saved. Additive. */
  storedDurationMs?: number
  /** On a cache hit: the CPU and peak memory of the run that stored it. Additive. */
  storedCpuMs?: number
  storedPeakRssBytes?: number
  /** How long an `admit` policy held the task once it was ready. Additive. */
  admissionHeldMs?: number
  /** How long the task waited ready for a worker, any admission hold included. Additive. */
  queuedMs?: number
  /** On a cacheable task that ran: how many files its key read. Additive. */
  inputFiles?: number
  /**
   * On a cacheable task that ran, when the cache holds an earlier entry for
   * it: what its key changed since, the first ten named. Additive.
   */
  inputChanges?: InputChanges
  /** The artifact's compressed size: on a hit the entry's, on a miss the save's. Additive. */
  artifactBytes?: number
  /** On a remote hit this run pulled: the download and its ingest. Additive. */
  fetchMs?: number
  /** On a miss that saved: the save's own time (pack, write, index). Additive. */
  saveMs?: number
  /**
   * On a cache hit: whether outputs were written this run (`true`) or the
   * disk already matched the entry and nothing was restored (`false`, an
   * up-to-date hit). Absent on every other status. Additive.
   */
  restored?: boolean
  /** bigint hrtime ns relative to run t=0, encoded as a decimal string. */
  wallclockStartNs?: string
  wallclockEndNs?: string
}

/**
 * A streaming telemetry record — one per lifecycle event. A superset of the
 * rendering-oriented `WireEvent`: it carries the run context + the per-task
 * analytics fields a consumer needs WITHOUT re-deriving from the stream.
 * `task.log` records are large and OPT-IN (see `TelemetrySink.wants`).
 */
export type TelemetryRecord =
  | {
      v: number
      kind: 'run.start'
      run: RunContextRecord
      total: number
      ts: number
      /** The run's canonical start (epoch ms) — equals the summary's
       *  `startedAt`; a sink derives per-task timing from it during the run. */
      startedAt: number
    }
  | {
      v: number
      kind: 'task.start'
      runId: string
      taskId: string
      project: string
      task: string
      command?: string
      /**
       * The tasks with a command this one waits on: its direct dependencies,
       * a group's seen through to the tasks with a command behind it.
       * Additive.
       */
      dependsOn?: readonly string[]
      ts: number
    }
  | {
      v: number
      kind: 'task.log'
      runId: string
      taskId: string
      stream: 'stdout' | 'stderr'
      chunk: string
      ts: number
    }
  | {
      v: number
      kind: 'task.sample'
      runId: string
      taskId: string
      ts: number
      /** CPU time of the task's live process tree so far, in ms. */
      cpuMs: number
      /** Resident memory of the task's live process tree, in bytes. */
      rssBytes: number
    }
  | ({ v: number; kind: 'task.end'; runId: string; ts: number } & TaskTelemetry)
  | { v: number; kind: 'run.end'; runId: string; ts: number }

/**
 * A per-run SUMMARY record — the denormalized invocation header plus the
 * per-task outcome list, emitted once at run:end. An ingesting store can
 * persist a whole run in one write without replaying the stream. The
 * manual-API exporter + a service's ingest endpoint primarily speak this shape.
 */
export interface RunSummaryRecord {
  v: number
  run: RunContextRecord
  startedAt: number
  endedAt: number
  totalDurationMs: number
  taskCount: number
  failedCount: number
  /**
   * Tasks a shutdown signal or an embedder's abort killed (v3). They are
   * not in `tasks`, which holds real runs only, so without this a stopped
   * run read as a failure with nothing failed (item 851).
   */
  abortedCount: number
  hitCount: number
  /** Hits by the layer that answered, up-to-date ones included. */
  hitLocalCount: number
  hitRemoteCount: number
  /**
   * Hits by what they did to the disk, as the run's summary counts them:
   * nothing restored (up-to-date, from either layer), or outputs restored
   * from the local or the remote layer. The three sum to `hitCount`.
   */
  upToDateCount: number
  restoredLocalCount: number
  restoredRemoteCount: number
  exitOk: boolean
  tasks: readonly TaskTelemetry[]
  /**
   * The run's stages as `VX_TIMING` marks them (startup, load configs,
   * classify + probe, run graph, …), each a wall window in epoch ms. The
   * stages ahead of the run lock end before `startedAt`. Additive.
   */
  stages?: readonly RunStage[]
  /**
   * The run's uploads to a remote cache, once they settled: how many landed,
   * their bytes, their summed time (they overlap), and how many failed.
   * Absent when nothing was uploaded or tried. Additive.
   */
  uploads?: { count: number; bytes: number; ms: number; failed: number }
}

/** One stage of a run, a wall window in epoch ms. */
export interface RunStage {
  name: string
  startedAt: number
  endedAt: number
}

/**
 * Assemble the canonical per-run summary from the per-task telemetry + the
 * run-level timing/verdict. THE one place the `RunSummaryRecord` tallies are
 * computed: both a local `run()` and the distributed controller build their
 * `TaskTelemetry[]` (each via `deriveCacheSource`) and call this, so a
 * distributed run and a local run produce byte-identical summaries and land in
 * the same ingest. The per-task tallies (taskCount / failedCount /
 * hitLocal|Remote|Count) derive from `tasks`; `totalDurationMs` (wall time) and
 * `exitOk` (the run's overall verdict — which counts skipped tasks beyond the
 * recorded task list) are run-level facts and are passed in.
 */
export function assembleRunSummary(
  run: RunContextRecord,
  tasks: readonly TaskTelemetry[],
  timing: {
    startedAt: number
    endedAt: number
    totalDurationMs: number
    exitOk: boolean
    abortedCount: number
    stages?: readonly RunStage[]
    uploads?: { count: number; bytes: number; ms: number; failed: number }
  },
): RunSummaryRecord {
  let failedCount = 0
  let hitLocalCount = 0
  let hitRemoteCount = 0
  let upToDateCount = 0
  let restoredLocalCount = 0
  let restoredRemoteCount = 0
  for (const t of tasks) {
    if (t.status === 'failed') failedCount++
    if (t.cacheSource === 'local') hitLocalCount++
    else if (t.cacheSource === 'remote') hitRemoteCount++
    else continue
    if (t.restored !== true) upToDateCount++
    else if (t.cacheSource === 'local') restoredLocalCount++
    else restoredRemoteCount++
  }
  return {
    v: TELEMETRY_SCHEMA_VERSION,
    run,
    startedAt: timing.startedAt,
    endedAt: timing.endedAt,
    totalDurationMs: timing.totalDurationMs,
    taskCount: tasks.length,
    failedCount,
    abortedCount: timing.abortedCount,
    hitCount: hitLocalCount + hitRemoteCount,
    hitLocalCount,
    hitRemoteCount,
    upToDateCount,
    restoredLocalCount,
    restoredRemoteCount,
    exitOk: timing.exitOk,
    tasks,
    ...(timing.stages !== undefined && timing.stages.length > 0 ? { stages: timing.stages } : {}),
    ...(timing.uploads !== undefined && timing.uploads.count + timing.uploads.failed > 0
      ? { uploads: { ...timing.uploads } }
      : {}),
  }
}

/** A telemetry consumer. Observe-only: receives records, holds no run handle. */
export interface TelemetrySink {
  readonly name?: string
  /**
   * Which streaming record kinds to receive. Default (undefined): all
   * EXCEPT `task.log` (large; most sinks don't want build-log chunks).
   * The source checks this before projecting/cloning, so a sink pays
   * nothing for kinds it declines.
   */
  readonly wants?: ReadonlyArray<TelemetryRecord['kind']>
  /** A streaming record. MUST return promptly — buffer; do NOT await I/O. */
  onRecord?(record: TelemetryRecord): void
  /** The per-run summary, at run:end. MUST return promptly. */
  onRunSummary?(summary: RunSummaryRecord): void
  /**
   * Drain buffered data. Awaited at run:end under a deadline — a sink that
   * has not settled by then is abandoned and its buffered records are lost.
   * Losing a slow sink's telemetry is strictly better than the alternative:
   * `run()` never returns, so the cache never closes and `vx` exits 0 on a
   * failed run.
   *
   * `signal` aborts at that deadline. Abandoning a flush does not end its
   * I/O: a request still in flight keeps the event loop, and so the
   * process, alive after the run has returned — a hanging GitHub API held
   * `vx run` open until the CI job's own timeout (item 1055). A sink passes
   * the signal to its `fetch` (or closes its socket on it).
   */
  flush?(signal: AbortSignal): Promise<void>
}

/** Read-only context a sink is created with. No mutable run handle — the
 *  isolation guarantee is structural. */
export interface TelemetryContext {
  readonly workspaceRoot: string
  /** A STRING, not a Cache handle — a sink cannot reach the cache. */
  readonly cacheDir: string
  warn(message: string): void
}

/** A live telemetry source: a bus subscriber + the run-summary emit + flush. */
export interface TelemetrySource {
  /** Subscribe this to the run event bus to stream records to the sinks. */
  readonly subscriber: RunEventSubscriber
  /** Fan the per-run summary to every sink's `onRunSummary` (crash-isolated). */
  emitSummary(summary: RunSummaryRecord): void
  /** Await every sink's `flush()` (each crash-isolated, all time-bounded). */
  flush(): Promise<void>
  /**
   * Sample this task's process tree every `SAMPLE_MS` until the returned
   * function is called, the root exits, or the run ends. Present only when
   * a sink wants `task.sample`: nobody asking costs no timer and no read.
   */
  readonly track?: (taskId: string, pid: number) => () => void
}

/** How often a running task's process tree is sampled. */
const SAMPLE_MS = 1000

/** Call `fn` every `ms` until the returned stop is called. */
type Every = (ms: number, fn: () => Promise<void>) => () => void

const everyInterval: Every = (ms, fn) => {
  const timer = setInterval(() => void fn(), ms)
  timer.unref()
  return () => clearInterval(timer)
}

const DEFAULT_KINDS: ReadonlyArray<TelemetryRecord['kind']> = [
  'run.start',
  'task.start',
  'task.end',
  'run.end',
]

/**
 * Build a telemetry source over a fixed set of sinks. The returned
 * `subscriber` projects each `RunEvent` into a `TelemetryRecord` and fans
 * it to the sinks that want its kind, under crash isolation (a throwing
 * sink is disabled for the rest of the run, never propagating into the
 * orchestrator). `task.log` is projected ONLY if some sink opted in — so
 * the large-payload path costs nothing by default.
 *
 * The `run` context (captured once by run.ts) is stamped onto `run.start`
 * and supplies the `runId` every other record carries.
 */
export function createTelemetrySource(args: {
  sinks: readonly TelemetrySink[]
  run: RunContextRecord
  /** Where a dropped-flush notice goes; absent = stay silent. */
  warn?: (message: string) => void
  /** What a sink with no `name` of its own is called: its plugin's (the host's map). */
  owners?: ReadonlyMap<TelemetrySink, string>
  /** The run's task graph, to see a group dependency through to the tasks behind it. */
  nodes?: ReadonlyMap<string, TaskNode>
  /** The sampler's clock; a test ticks it by hand instead of waiting on the wall. */
  every?: Every
}): TelemetrySource {
  const { sinks, run, warn } = args
  const runId = run.runId
  // `name` is optional, and a nameless sink was reported as 'undefined'
  // (item 1027): it goes by its plugin's name, else its place in the list.
  const label = (sink: TelemetrySink): string =>
    sink.name ?? args.owners?.get(sink) ?? `#${sinks.indexOf(sink) + 1}`
  // A sink is disabled the first time it throws — its name (or index) goes
  // here and it's skipped for the rest of the run, FLUSH INCLUDED. Flushing a
  // disabled sink would write a buffer that is incomplete by construction: it
  // stopped being fed records at the moment it threw, so the export would look
  // like a run that simply had fewer tasks.
  const disabled = new Set<TelemetrySink>()
  // Never silently. The standing rule is that a never-fail path must still
  // WARN — telemetry that vanishes without a word is indistinguishable from
  // telemetry nobody configured.
  // Every hook call site skips a disabled sink first (item 654), but an
  // async hook's rejections land later, several records' worth of them
  // after the first: those are said once too.
  const disable = (sink: TelemetrySink, hook: string, err: unknown): void => {
    if (disabled.has(sink)) return
    disabled.add(sink)
    warn?.(
      `[vx] telemetry sink '${label(sink)}' threw in ${hook}; disabled for this run: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  // Precompute which sinks want each kind, so per-event fan-out is a plain
  // array walk with no per-record `wants` scanning.
  const wantsLog = sinks.some((s) => (s.wants ?? DEFAULT_KINDS).includes('task.log'))
  const wantsSample = sinks.some((s) => (s.wants ?? DEFAULT_KINDS).includes('task.sample'))

  // taskId → the pid of its running root. One timer for every task, alive
  // only while one runs; a tick still reading when the next is due is not
  // doubled.
  const tracked = new Map<string, number>()
  const every = args.every ?? everyInterval
  let stopEvery: (() => void) | undefined
  let sampling = false
  let ended = false
  const stopTimer = (): void => {
    stopEvery?.()
    stopEvery = undefined
  }
  const untrack = (taskId: string, pid: number): void => {
    if (tracked.get(taskId) === pid) tracked.delete(taskId)
    if (tracked.size === 0) stopTimer()
  }
  const tick = async (): Promise<void> => {
    if (sampling) return
    sampling = true
    try {
      const entries = [...tracked]
      const usage = await sampleTrees(entries.map(([, pid]) => pid))
      const ts = Date.now()
      for (const [taskId, pid] of entries) {
        if (ended || tracked.get(taskId) !== pid) continue
        const u = usage.get(pid)
        if (u === undefined) {
          untrack(taskId, pid)
          continue
        }
        deliver({
          v: TELEMETRY_SCHEMA_VERSION,
          kind: 'task.sample',
          runId,
          taskId,
          ts,
          cpuMs: u.cpuMs,
          rssBytes: u.rssBytes,
        })
      }
    } catch {
      // A failed look is a missing point, never a broken run.
    } finally {
      sampling = false
    }
  }
  const track = (taskId: string, pid: number): (() => void) => {
    if (ended) return () => {}
    tracked.set(taskId, pid)
    stopEvery ??= every(SAMPLE_MS, tick)
    return () => untrack(taskId, pid)
  }

  function deliver(record: TelemetryRecord): void {
    for (const sink of sinks) {
      if (disabled.has(sink) || sink.onRecord === undefined) continue
      const kinds = sink.wants ?? DEFAULT_KINDS
      if (!kinds.includes(record.kind)) continue
      try {
        // Typed `void`, yet an `async onRecord` rejects where no one
        // listened: an unhandled rejection killed the run (C-101).
        const ret: unknown = sink.onRecord(record)
        if (ret instanceof Promise) ret.catch((err) => disable(sink, 'onRecord', err))
      } catch (err) {
        disable(sink, 'onRecord', err)
      }
    }
  }

  const subscriber: RunEventSubscriber = (event: RunEvent) => {
    const ts = Date.now()
    switch (event.kind) {
      case 'run:start':
        deliver({
          v: TELEMETRY_SCHEMA_VERSION,
          kind: 'run.start',
          run,
          total: event.info.total,
          ts,
          startedAt: event.info.startedAtMs ?? ts,
        })
        return
      case 'task:start': {
        const node = event.node
        if (node.config.exec === undefined) return // group task — no command, skip
        const rec: TelemetryRecord = {
          v: TELEMETRY_SCHEMA_VERSION,
          kind: 'task.start',
          runId,
          taskId: node.id,
          project: node.projectName,
          task: node.taskName,
          ts,
        }
        if (node.config.exec.command !== undefined)
          rec.command = maskedCommand(node.config.exec.command, node.config.exec.env)
        const deps = commandDeps(node, args.nodes)
        if (deps.length > 0) rec.dependsOn = deps
        deliver(rec)
        return
      }
      case 'task:stdout':
      case 'task:stderr': {
        if (!wantsLog) return // nobody wants logs — pay nothing
        deliver({
          v: TELEMETRY_SCHEMA_VERSION,
          kind: 'task.log',
          runId,
          taskId: event.node.id,
          stream: event.kind === 'task:stdout' ? 'stdout' : 'stderr',
          chunk: event.chunk,
          ts,
        })
        return
      }
      case 'task:complete': {
        const { node, outcome } = event
        if (node.config.exec === undefined) return // group task
        deliver({
          v: TELEMETRY_SCHEMA_VERSION,
          kind: 'task.end',
          runId,
          ts,
          ...taskTelemetryOf(outcome),
        })
        return
      }
      case 'run:status':
        return // status lines are terminal-rendering noise, not telemetry
      case 'run:end':
        ended = true
        tracked.clear()
        stopTimer()
        deliver({ v: TELEMETRY_SCHEMA_VERSION, kind: 'run.end', runId, ts })
        return
    }
  }

  return {
    subscriber,
    ...(wantsSample ? { track } : {}),
    emitSummary(summary: RunSummaryRecord): void {
      for (const sink of sinks) {
        if (disabled.has(sink) || sink.onRunSummary === undefined) continue
        try {
          const ret: unknown = sink.onRunSummary(summary)
          if (ret instanceof Promise) ret.catch((err) => disable(sink, 'onRunSummary', err))
        } catch (err) {
          disable(sink, 'onRunSummary', err)
        }
      }
    },
    async flush(): Promise<void> {
      const ms = teardownTimeoutMs()
      // Bounded, for the same reason plugin teardown is bounded in
      // plugin-host.ts: run() awaits this BEFORE closeCache() and before it
      // returns, and bin.ts exits with run()'s code once it returns (through
      // stdout's end callback since 2026-09-15; the code is still that). A sink whose
      // flush never settles therefore drains the event loop with no exit code
      // pending — Bun exits 0 and a FAILED run reports green, with the cache's
      // accessed_at bumps and every later plugin's teardown lost with it.
      // Sinks race concurrently, so each still gets the whole budget.
      const deadline = new AbortController()
      const settled = await settleWithin(
        Promise.all(
          sinks.map(async (sink) => {
            if (disabled.has(sink) || sink.flush === undefined) return
            try {
              await sink.flush(deadline.signal)
            } catch (err) {
              // A flush failure can never break the run — but it still costs
              // this sink its export, so say so rather than dropping it.
              warn?.(
                `[vx] telemetry sink '${label(sink)}' failed to flush: ${err instanceof Error ? err.message : String(err)}`,
              )
            }
          }),
        ),
        ms,
      )
      if (!settled) {
        deadline.abort(new Error(`telemetry flush deadline (${ms}ms)`))
        warn?.(`[vx] telemetry flush timed out after ${ms}ms; buffered records lost`)
      }
    },
  }
}

/** `node`'s dependencies with a command; a group is seen through, once each. */
function commandDeps(node: TaskNode, nodes: ReadonlyMap<string, TaskNode> | undefined): string[] {
  if (nodes === undefined) return node.deps
  const out: string[] = []
  const seen = new Set<string>()
  const stack = [...node.deps].reverse()
  while (stack.length > 0) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    const dep = nodes.get(id)
    if (dep !== undefined && isGroupTask(dep)) stack.push(...[...dep.deps].reverse())
    else out.push(id)
  }
  return out
}

/**
 * The one projection of an outcome into `TaskTelemetry`, for the streaming
 * `task.end` record and the summary's `tasks[]` alike. Two copies drifted:
 * `task.end` dropped `blockedBy`, `timedOut`, `sandboxViolations` and
 * `notReady`, so a streaming sink saw a timed-out or blocked task as a plain
 * failure or skip (item 660).
 */
export function taskTelemetryOf(o: TaskOutcome): TaskTelemetry {
  const t: TaskTelemetry = {
    taskId: o.node.id,
    project: o.node.projectName,
    task: o.node.taskName,
    status: o.status,
    cacheSource: deriveCacheSource(o.status),
    exitCode: o.exitCode,
    durationMs: o.durationMs,
  }
  if (o.hash !== undefined) t.hash = o.hash
  if (o.cpuMs !== undefined) t.cpuMs = o.cpuMs
  if (o.peakRssBytes !== undefined) t.peakRssBytes = o.peakRssBytes
  if (o.where !== undefined) t.where = o.where
  if (o.outputs !== undefined) t.outputs = o.outputs
  if (o.attempts !== undefined) t.attempts = o.attempts
  if (o.blockedBy !== undefined) t.blockedBy = o.blockedBy
  if (o.timedOut === true) t.timedOut = true
  if (o.sandboxViolations !== undefined) t.sandboxViolations = o.sandboxViolations
  if (o.notReady !== undefined) t.notReady = o.notReady
  if (o.failedAttempts !== undefined) t.failedAttempts = o.failedAttempts
  if (o.flaky !== undefined) t.flaky = o.flaky
  if (o.sandboxViolationLines !== undefined && o.sandboxViolationLines.length > 0) {
    t.sandboxViolationLines = o.sandboxViolationLines
  }
  if (o.storedDurationMs !== undefined) t.storedDurationMs = o.storedDurationMs
  if (o.storedCpuMs !== undefined) t.storedCpuMs = o.storedCpuMs
  if (o.storedPeakRssBytes !== undefined) t.storedPeakRssBytes = o.storedPeakRssBytes
  if (o.admissionHeldMs !== undefined) t.admissionHeldMs = o.admissionHeldMs
  if (o.queuedMs !== undefined) t.queuedMs = o.queuedMs
  if (o.inputFiles !== undefined) t.inputFiles = o.inputFiles
  if (o.inputChanges !== undefined) t.inputChanges = o.inputChanges
  if (o.artifactBytes !== undefined) t.artifactBytes = o.artifactBytes
  if (o.fetchMs !== undefined) t.fetchMs = o.fetchMs
  if (o.saveMs !== undefined) t.saveMs = o.saveMs
  if (isCacheHit(o.status)) t.restored = o.restored === true
  if (o.wallclockStartNs !== undefined) t.wallclockStartNs = o.wallclockStartNs.toString()
  if (o.wallclockEndNs !== undefined) t.wallclockEndNs = o.wallclockEndNs.toString()
  return t
}
