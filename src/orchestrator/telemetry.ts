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
// A sink is observe-only BY CONSTRUCTION: its only input is an immutable
// record; its `TelemetryContext` carries read-only metadata and NO mutable
// run handle (no bus, no Cache, no RunRequest). There is no API path from a
// sink back into scheduling/caching/exec — telemetry provably cannot change
// what or how tasks run. Contrast `backend`/`cache`, which return objects
// core calls INTO; those are the behavior capabilities, kept separate.

import type { OutputFingerprint, TaskStatus, VerifyVerdict } from '../graph/index.js'
import { settleWithin, teardownTimeoutMs } from '../util/index.js'
import type { RunEvent, RunEventSubscriber } from './events.js'

/** Bumped when the record shape changes. Readers MUST check `v`. */
export const TELEMETRY_SCHEMA_VERSION = 2

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

const KNOWN_STATUSES: ReadonlySet<string> = new Set(TASK_STATUSES)

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
  if (!KNOWN_STATUSES.has(status)) return false
  const source = deriveCacheSource(status as TaskStatus)
  return source === 'local' || source === 'remote'
}

/** Identifies which run a record belongs to + its captured context. Maps
 *  cleanly onto OTel CI/CD + VCS resource attributes. */
export interface RunContextRecord {
  /** ULID, shared by every record in one `vx run`. */
  runId: string
  vxVersion: string
  /** The invocation command line (process.argv-derived). */
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
  host: string | null
  os: string
  arch: string
  /** `--tag k=v` pairs. */
  tags: Readonly<Record<string, string>>
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
   *  Additive-optional, no schema bump (the `attempts`/`verify` precedent). */
  where?: string
  /** `'deferred'` when the outputs stayed remote (`--download=none`).
   *  Additive-optional, same no-bump precedent as `where`. */
  outputs?: 'deferred'
  /** Total attempts when the task RETRIED (>1) — set only when `exec.retries`
   *  / `--retry` produced more than one attempt. A retried-then-passed task is
   *  flaky by definition; this is the telemetry-side flaky signal. */
  attempts?: number
  /** Cache-correctness verdict — set ONLY on a `--verify` run (absent
   *  otherwise). A `nondeterministic` verdict means the task's cache entry is
   *  unsound (its outputs aren't a pure function of its declared inputs); this
   *  is the telemetry-side hermeticity signal a dashboard surfaces. */
  verify?: VerifyVerdict
  /** Output-tree fingerprint — set ONLY under a fingerprinting `--verify*`
   *  mode (`--verify` / `=all` / `=fingerprint`), executed tasks only. A
   *  connected serve pairs fingerprints for the SAME `hash` across platforms
   *  and names diverging outputs (the cross-machine diff). Absent on plain
   *  runs — additive-optional, no schema bump (the `attempts`/`verify`
   *  precedent). */
  outputFp?: OutputFingerprint
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
  hitCount: number
  hitLocalCount: number
  hitRemoteCount: number
  exitOk: boolean
  tasks: readonly TaskTelemetry[]
}

/**
 * Assemble the canonical per-run summary from the per-task telemetry + the
 * run-level timing/verdict. THE one place the `RunSummaryRecord` tallies are
 * computed: both a local `run()` and the distributed controller build their
 * `TaskTelemetry[]` (each via `deriveCacheSource`) and call this, so a
 * distributed run and a local run produce byte-identical summaries and land in
 * the same ingest. The per-task tallies (taskCount / failedCount /
 * hitLocal|Remote|Count) derive from `tasks`; `totalDurationMs` (wall time) and
 * `exitOk` (the run's overall verdict — which counts skipped/verify beyond the
 * recorded task list) are run-level facts and are passed in.
 */
export function assembleRunSummary(
  run: RunContextRecord,
  tasks: readonly TaskTelemetry[],
  timing: { startedAt: number; endedAt: number; totalDurationMs: number; exitOk: boolean },
): RunSummaryRecord {
  let failedCount = 0
  let hitLocalCount = 0
  let hitRemoteCount = 0
  for (const t of tasks) {
    if (t.status === 'failed') failedCount++
    if (t.cacheSource === 'local') hitLocalCount++
    else if (t.cacheSource === 'remote') hitRemoteCount++
  }
  return {
    v: TELEMETRY_SCHEMA_VERSION,
    run,
    startedAt: timing.startedAt,
    endedAt: timing.endedAt,
    totalDurationMs: timing.totalDurationMs,
    taskCount: tasks.length,
    failedCount,
    hitCount: hitLocalCount + hitRemoteCount,
    hitLocalCount,
    hitRemoteCount,
    exitOk: timing.exitOk,
    tasks,
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
   */
  flush?(): Promise<void>
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
}): TelemetrySource {
  const { sinks, run, warn } = args
  const runId = run.runId
  // A sink is disabled the first time it throws — its name (or index) goes
  // here and it's skipped for the rest of the run.
  const disabled = new Set<TelemetrySink>()
  // Precompute which sinks want each kind, so per-event fan-out is a plain
  // array walk with no per-record `wants` scanning.
  const wantsLog = sinks.some((s) => (s.wants ?? DEFAULT_KINDS).includes('task.log'))

  function deliver(record: TelemetryRecord): void {
    for (const sink of sinks) {
      if (disabled.has(sink) || sink.onRecord === undefined) continue
      const kinds = sink.wants ?? DEFAULT_KINDS
      if (!kinds.includes(record.kind)) continue
      try {
        sink.onRecord(record)
      } catch {
        disabled.add(sink)
      }
    }
  }

  let endEmitted = false
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
        if (node.config.exec.command !== undefined) rec.command = node.config.exec.command
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
        const rec: TelemetryRecord = {
          v: TELEMETRY_SCHEMA_VERSION,
          kind: 'task.end',
          runId,
          ts,
          taskId: node.id,
          project: node.projectName,
          task: node.taskName,
          status: outcome.status,
          cacheSource: deriveCacheSource(outcome.status),
          exitCode: outcome.exitCode,
          durationMs: outcome.durationMs,
        }
        if (outcome.hash !== undefined) rec.hash = outcome.hash
        if (outcome.cpuMs !== undefined) rec.cpuMs = outcome.cpuMs
        if (outcome.peakRssBytes !== undefined) rec.peakRssBytes = outcome.peakRssBytes
        if (outcome.where !== undefined) rec.where = outcome.where
        if (outcome.outputs !== undefined) rec.outputs = outcome.outputs
        if (outcome.attempts !== undefined) rec.attempts = outcome.attempts
        if (outcome.verify !== undefined) rec.verify = outcome.verify
        if (outcome.outputFp !== undefined) rec.outputFp = outcome.outputFp
        if (outcome.wallclockStartNs !== undefined)
          rec.wallclockStartNs = outcome.wallclockStartNs.toString()
        if (outcome.wallclockEndNs !== undefined)
          rec.wallclockEndNs = outcome.wallclockEndNs.toString()
        deliver(rec)
        return
      }
      case 'run:status':
        return // status lines are terminal-rendering noise, not telemetry
      case 'run:end':
        // run() emits run:end twice (normal + finally); emit one record.
        if (endEmitted) return
        endEmitted = true
        deliver({ v: TELEMETRY_SCHEMA_VERSION, kind: 'run.end', runId, ts })
        return
    }
  }

  return {
    subscriber,
    emitSummary(summary: RunSummaryRecord): void {
      for (const sink of sinks) {
        if (disabled.has(sink) || sink.onRunSummary === undefined) continue
        try {
          sink.onRunSummary(summary)
        } catch {
          disabled.add(sink)
        }
      }
    },
    async flush(): Promise<void> {
      const ms = teardownTimeoutMs()
      // Bounded, for the same reason the `eventSink` sibling is bounded in
      // plugin-host.ts: run() awaits this BEFORE closeCache() and before it
      // returns, and bin.ts is `process.exit(await run(...))`. A sink whose
      // flush never settles therefore drains the event loop with no exit code
      // pending — Bun exits 0 and a FAILED run reports green, with the cache's
      // accessed_at bumps and every later plugin's teardown lost with it.
      // Sinks race concurrently, so each still gets the whole budget.
      const settled = await settleWithin(
        Promise.all(
          sinks.map(async (sink) => {
            if (sink.flush === undefined) return
            try {
              await sink.flush()
            } catch {
              // a sink's flush failure can never break the run
            }
          }),
        ),
        ms,
      )
      if (!settled) warn?.(`[vx] telemetry flush timed out after ${ms}ms; buffered records lost`)
    },
  }
}
