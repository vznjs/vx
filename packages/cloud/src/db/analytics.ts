// The Postgres analytics store (docs/design/cloud-platform-2026-07.md §5.4-5.6)
// — the org/workspace-clamped port of core's `src/orchestrator/metrics.ts`.
//
// This is a DELIBERATE dialect fork: core's metrics.ts stays untouched (it
// serves the LOCAL bun:sqlite cache.db for `vx mcp`/`vx info`); this file is
// the multi-tenant Postgres half. Response shapes MUST stay byte-identical to
// core's — the dashboard reads both through the same wire contract — but the
// metrics response TYPES aren't on the `@vzn/vx` façade (only the query
// functions are), so the shapes are MIRRORED here and kept in lockstep by the
// seeded pinned tests (analytics-read.test.ts). The known drift traps the
// decision log names (periodStats NULL folding, the regressions tiebreaker,
// half-open windows) are carried over.
//
// Every read takes (orgId, workspaceId) and filters by workspace_id — the
// tenant clamp is structural, a caller can never read across the boundary.
// Every write routes the pushed client workspaceId to a server workspace
// (§5.5) and auto-provisions on first push.

import type { SQL } from 'bun'
import { diffOutputTrees } from '@vzn/vx'
import type { OutputFingerprint, RunSummaryRecord, TaskTelemetry } from '@vzn/vx'
import {
  RUN_LOG_BUDGET_CHARS,
  TASK_LOG_TAIL_CHARS,
  type TaskLogBundle,
} from '../task-log-capture.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Server-side per-file fingerprint cap, re-applied regardless of the wire claim. */
export const FP_MAX_FILES = 500

/** A log/fp blob at/over this many bytes is stored zstd-compressed. */
const COMPRESS_THRESHOLD_BYTES = 4 * 1024

/**
 * A workspace-scoped token tried to write history that resolves to a DIFFERENT
 * workspace — a 403. Never a data-shape error; the route maps it to a status.
 */
export class WorkspaceForbiddenError extends Error {
  readonly status = 403
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceForbiddenError'
  }
}

/** Postgres unique-violation (SQLSTATE 23505) — used to retry a lost
 *  auto-provision race rather than surface the raw constraint error. */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null
  return e?.code === '23505' || /duplicate key|unique constraint/i.test(e?.message ?? '')
}

export interface WorkspaceEntry {
  id: string
  name: string
  slug: string
  lastSeenAt: number
  runCount: number
}

/** The lock-derived catalog push (§5.6) — one project + its resolved tasks. */
export interface CatalogPushTask {
  task: string
  config?: unknown
  cacheable?: boolean
  isGroup?: boolean
  persistent?: boolean
}
export interface CatalogPushProject {
  name: string
  tasks?: CatalogPushTask[]
}
export interface CatalogPush {
  v: 1
  workspaceId: string
  workspaceName?: string
  projects: CatalogPushProject[]
}

interface RouteArgs {
  orgId: string
  /** Set when the token is workspace-scoped — the summary MUST resolve here. */
  tokenWorkspaceId?: string | undefined
  clientWorkspaceId: string
  workspaceName: string
  now: number
}

function slugify(base: string): string {
  const s = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return s === '' ? 'workspace' : s
}

/** Validate + re-truncate a fingerprint's file map to FP_MAX_FILES (server-side). */
function normalizeFpFiles(
  files: ReadonlyArray<readonly [string, string]> | undefined,
  truncatedIn: boolean | undefined,
): { files: Array<[string, string]> | null; truncated: boolean } {
  if (files === undefined) return { files: null, truncated: truncatedIn === true }
  let list = files as ReadonlyArray<readonly [string, string]>
  let truncated = truncatedIn === true
  if (list.length > FP_MAX_FILES) {
    list = [...list].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(0, FP_MAX_FILES)
    truncated = true
  }
  return { files: list.map((p) => [p[0], p[1]] as [string, string]), truncated }
}

function isPairArray(v: unknown): v is ReadonlyArray<readonly [string, string]> {
  return (
    Array.isArray(v) &&
    v.every(
      (p) =>
        Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && typeof p[1] === 'string',
    )
  )
}

/** Structural validation of one fingerprint at the network boundary. */
function validFingerprint(fp: OutputFingerprint | undefined): fp is OutputFingerprint {
  if (fp === undefined) return false
  const f = fp as unknown as { tree?: unknown; fileCount?: unknown; files?: unknown }
  return (
    typeof f.tree === 'string' &&
    f.tree !== '' &&
    Number.isInteger(f.fileCount) &&
    (f.fileCount as number) >= 0 &&
    (f.files === undefined || isPairArray(f.files))
  )
}

// ---------------------------------------------------------------------------
// Mirrored response types (kept byte-identical to src/orchestrator/metrics.ts;
// the façade doesn't export these, so they're duplicated here — see the file
// header). Grouped by query for lockstep review against core.
// ---------------------------------------------------------------------------

export interface RunSummaryRow {
  runId: string | null
  project: string
  task: string
  status: string
  exitCode: number
  durationMs: number
  startedAt: number
  endedAt: number
  cacheHit: boolean | null
  hash: string
  cpuMs: number | null
  peakRssBytes: number | null
  wallclockStartNs: string | null
  wallclockEndNs: string | null
}

export interface ListRunsArgs {
  limit?: number
  project?: string
  task?: string
  runId?: string
}

export interface InvocationDetail {
  runId: string
  command: string
  requestedTasks: string[]
  cachePolicy: string
  concurrency: number
  flow: 'focused' | 'broad' | null
  startedAt: number
  endedAt: number
  totalDurationMs: number
  taskCount: number
  failedCount: number
  hitCount: number
  hitLocalCount: number
  hitRemoteCount: number
  exitOk: boolean
  commitSha: string | null
  branch: string | null
  dirty: boolean | null
  ci: boolean
  ciProvider: string | null
  host: string | null
  os: string | null
  arch: string | null
  vxVersion: string
  tags: Record<string, string>
}

/** The per-task incremental ingest wire (`POST /v1/ingest/task`): one task's
 *  result + optional log tail, shipped the moment it finishes. `runStartedAt`
 *  anchors the started_at derivation so it matches the end-of-run batch. */
export interface TaskIngestRecord {
  v: number
  runId: string
  /** Client workspace id (16-hex) — routed exactly like an ingest push. */
  workspaceId: string
  workspaceName?: string
  /** The run's start (epoch ms) — the started_at base for this task's row. */
  runStartedAt: number
  /** The run's end if known (else the server uses `now`; only cache-hit rows
   *  with null wallclock ns use it, and it's not part of the dedup key). */
  runEndedAt?: number
  task: TaskTelemetry
  /** The task's captured log tail, if any (miss + success/failed). */
  log?: { content: string; charsFull: number; truncatedHeadChars: number }
}

/** A notification-bell item: a build that broke. Lean by design — the bell
 *  polls frequently, so it reads only what a compact row needs. */
export interface NotificationItem {
  kind: 'run-failed'
  runId: string
  startedAt: number
  branch: string | null
  commitSha: string | null
  failedCount: number
  taskCount: number
  /** Projects with failed tasks in the run — lets the client scope the feed
   *  to a dev's pinned "my projects" set. */
  failingProjects: string[]
}

export interface ListInvocationsArgs {
  limit?: number
  branch?: string
  ci?: boolean
  tagKey?: string
  tagValue?: string
}

export interface RunDetail {
  runId: string
  startedAt: number
  endedAt: number
  tasks: RunSummaryRow[]
}

export interface CacheStatsResult {
  entryCount: number
  totalBytes: number
  runCountLast24h: number
  hitCountLast24h: number
  hitRate24h: number
  hitLocalCountLast24h: number
  hitRemoteCountLast24h: number
}

export interface HitRateSplit {
  total: number
  hits: number
  hitLocal: number
  hitRemote: number
  hitRate: number
  localShare: number
  remoteShare: number
}

export interface TaskHistoryRow {
  id: string
  project: string
  task: string
  runs: number
  successes: number
  failures: number
  hits: number
  successRate: number
  hitRate: number
  failureMode: 'stable' | 'flaky-recoverable' | 'flaky-fatal'
  p50DurationMs: number | undefined
  p99DurationMs: number | undefined
  minDurationMs: number | undefined
  maxDurationMs: number | undefined
  avgDurationMs: number | undefined
  totalDurationMs: number
  lastSeenAt: number | undefined
}

export interface GetHistoryArgs {
  project?: string
  task?: string
  limit?: number
}

export interface TopTaskRow {
  id: string
  project: string
  task: string
  runs: number
  totalDurationMs: number
  avgDurationMs: number
}

export interface FailureRow {
  runId: string | null
  project: string
  task: string
  exitCode: number
  durationMs: number
  startedAt: number
  hash: string
}

export interface CacheEntryRow {
  hash: string
  project: string
  task: string
  command: string
  exitCode: number
  durationMs: number
  sizeBytes: number
  createdAt: number
  accessedAt: number
}

export interface ListCacheEntriesArgs {
  limit?: number
  orderBy?: 'created_at' | 'accessed_at' | 'size_bytes' | 'duration_ms'
  project?: string
}

export interface CacheProjectRow {
  project: string
  entries: number
  totalBytes: number
}

export interface TaskDetail {
  project: string
  task: string
  aggregate: TaskHistoryRow | null
  recent: RunSummaryRow[]
  latestEntry: CacheEntryRow | null
}

export interface CacheSavings {
  hitsLast24h: number
  estimatedTimeSavedMs: number
  estimatedTimeSavedTotalMs: number
}

export interface CacheKeyExplanation {
  taskId: string
  project: string
  task: string
  latestEntry: {
    hash: string
    command: string
    exitCode: number
    durationMs: number
    sizeBytes: number
    createdAt: number
  } | null
  note: string
}

export interface WhyDidThisRerun {
  runId: string
  taskId: string
  found: boolean
  thisRun?: { hash: string; status: string; cacheHit: boolean | null; startedAt: number }
  previousRun?: { hash: string; status: string; cacheHit: boolean | null; startedAt: number } | null
  hashChanged?: boolean | null
  note: string
}

export interface InputDiffEntry {
  kind: string
  name: string
  change: 'added' | 'removed' | 'changed'
  before: string | null
  after: string | null
}

export interface CacheKeyDiff {
  runId: string
  taskId: string
  found: boolean
  previousRunId: string | null
  entries: InputDiffEntry[]
  unchangedCount: number
  note: string
}

/** One executed task's re-run verdict — the batched `/v1/why/:runId` row. */
export interface WhyRunRow {
  taskId: string
  project: string
  task: string
  previousRunId: string | null
  reason: string
}

/**
 * One failed task's triage verdict — the batched `/v1/triage/:runId` row.
 * Answers the PR author's sharpest question: "is this failure mine?"
 *
 * - `flaky`        — the SAME cache key (identical inputs) succeeded in other
 *                    runs; nondeterminism, not this change.
 * - `pre-existing` — the default branch's latest run of this task is ALSO
 *                    failing; inherited, not introduced.
 * - `new-failure`  — first failure of this key with no trunk failure behind
 *                    it; `keyChanged` says whether this run altered the
 *                    task's inputs (the "probably yours" signal).
 */
export interface TriageRow {
  taskId: string
  project: string
  task: string
  verdict: 'flaky' | 'pre-existing' | 'new-failure'
  /** Green runs (success or cache hit) of this exact cache key elsewhere. */
  sameKeySuccesses: number
  /** The default branch's most-recent run of this task is currently failed. */
  defaultBranchFailing: boolean
  /** That trunk run's id (evidence link), when one exists. */
  defaultBranchRunId: string | null
  /** Key differs from the task's previous run; null = no prior run. */
  keyChanged: boolean | null
  previousRunId: string | null
}

export interface CompareTaskSide {
  status: string
  durationMs: number
  hash: string
  cacheHit: boolean | null
  exitCode: number
}

export interface CompareTaskRow {
  taskId: string
  project: string
  task: string
  a: CompareTaskSide | null
  b: CompareTaskSide | null
  hashChanged: boolean
  durationDeltaMs: number | null
  statusChanged: boolean
}

export interface CompareRuns {
  runId: string
  previousRunId: string | null
  startedAt: number | null
  prevStartedAt: number | null
  found: boolean
  summary: {
    aTotalMs: number
    bTotalMs: number
    totalDeltaMs: number
    tasksChanged: number
    tasksOnlyInA: number
    tasksOnlyInB: number
  }
  tasks: CompareTaskRow[]
  note: string
}

export interface ProjectRollup {
  project: string
  taskCount: number
  runs: number
  failures: number
  hits: number
  hitRate: number
  totalDurationMs: number
  avgDurationMs: number
  cacheBytes: number
  cacheEntries: number
  lastRunAt: number | undefined
  estimatedTimeSavedMs: number
}

export type TrendBucket = 'hour' | 'day'

export interface TrendPoint {
  t: number
  runs: number
  hits: number
  hitsLocal: number
  hitsRemote: number
  failures: number
  totalDurationMs: number
}

export interface HeatmapCell {
  dayOfWeek: number
  hourOfDay: number
  runs: number
  totalDurationMs: number
}

export interface FlakyTask {
  id: string
  project: string
  task: string
  runs: number
  failures: number
  failureRate: number
  withinRunRetries: number
  maxAttempts: number | undefined
  flakyConfirmed: boolean
  /**
   * Distinct cache keys that produced BOTH a failure and a success across
   * runs — the cross-run nondeterminism signal (identical inputs, different
   * outcomes). Failures that each sit on their own key are legitimate breaks
   * (the regressions surface owns those) and do NOT flag a task as flaky.
   */
  mixedOutcomeKeys: number
  durationTailRatio: number | undefined
  p50DurationMs: number | undefined
  p99DurationMs: number | undefined
}

export interface RegressedTask {
  id: string
  project: string
  task: string
  branchesFailing: number
  branchesTotal: number
  branches: string[]
  regressed: boolean
  firstFailedAt: number
  lastRunAt: number
  failures: number
  runs: number
}

export interface RegressionArgs {
  sinceDays?: number
  minBranches?: number
  limit?: number
}

/** Per-task branch failure attribution for the project view: which branch a
 *  task FIRST started failing on (rank 1), when, and the per-branch breakdown —
 *  "where was the issue first noticed". */
export interface ProjectBranchFailure {
  task: string
  firstBranch: string
  firstFailedAt: number
  firstCommit: string | null
  lastFailedAt: number
  branchesFailing: number
  branches: {
    branch: string
    firstFailedAt: number
    firstCommit: string | null
    failures: number
  }[]
}

/** One (task, time-bucket) cell for the project view's per-task sparklines —
 *  flat long-format; the client groups by task into a bucket-filled series. */
export interface ProjectTaskTrendPoint {
  task: string
  t: number
  runs: number
  failures: number
  avgDurationMs: number
  p95DurationMs: number
}

export interface PeriodStats {
  runs: number
  taskRuns: number
  executed: number
  failures: number
  cacheHits: number
  totalDurationMs: number
  avgDurationMs: number
  p50DurationMs: number | undefined
  p95DurationMs: number | undefined
  failureRate: number
  cacheHitRate: number
}

export interface TaskMover {
  id: string
  project: string
  task: string
  currentAvgMs: number
  previousAvgMs: number
  deltaMs: number
  deltaPct: number
  currentRuns: number
  previousRuns: number
}

export interface PeriodComparison {
  windowDays: number
  current: { from: number; to: number; stats: PeriodStats }
  previous: { from: number; to: number; stats: PeriodStats }
  movers: TaskMover[]
}

export interface PeriodComparisonArgs {
  windowDays?: number
  endMs?: number
  minRuns?: number
  limit?: number
  project?: string
  task?: string
}

export interface BottleneckRow {
  id: string
  project: string
  task: string
  runsRecent: number
  totalDurationMs: number
  avgDurationMs: number
  runsPerDay: number
  weeklySavingsAt25PctCutMs: number
}

export interface ParallelismPoint {
  runId: string
  startedAt: number
  cpuSumMs: number
  wallMs: number
  factor: number
  taskCount: number
}

export interface StoragePoint {
  t: number
  bytesAdded: number
  entriesAdded: number
}

export interface PrunableEntry {
  hash: string
  project: string
  task: string
  sizeBytes: number
  createdAt: number
  accessedAt: number
  ageDays: number
}

/** A stored task-log tail (mirrors the deleted log-store's StoredTaskLog). */
export interface StoredTaskLog {
  runId: string
  taskId: string
  hash?: string
  status: 'success' | 'failed'
  content: string
  charsFull: number
  truncatedHeadChars: number
}

export interface HermeticityReport {
  os: string
  arch: string
  tree: string
  runId: string
  host: string | null
  at: number
}

export interface DivergentKey {
  hash: string
  taskId: string
  crossPlatform: boolean
  changed: string[]
  changedComplete: boolean
  reports: HermeticityReport[]
}

export interface HermeticityResult {
  divergent: DivergentKey[]
  keysTracked: number
  reportCount: number
}

/** Provenance for an artifact hash — the most recent producing task/run. */
export interface HashProvenance {
  project: string
  task: string
  runId: string | null
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, Math.floor(n)))
}

/**
 * Hard cap on the number of time buckets a trend fill-loop may emit. The
 * server is single-threaded and multi-tenant, so a client passing an enormous
 * `from`/`to`/`days` span (e.g. `?from=0&to=1e15`) must NOT be able to drive a
 * synchronous fill loop into hundreds of millions of allocations — that would
 * freeze or OOM the replica for EVERY tenant. 10k covers >400 days of hourly
 * buckets, far beyond any real dashboard range.
 */
const MAX_TREND_BUCKETS = 10_000

/**
 * Cap on a client-supplied day/window span for the raw-row-fetch analytics
 * (heatmap, period comparison). A huge span makes `WHERE started_at >= <since>`
 * degenerate to a full scan of every partition; clamping to ~1 year keeps the
 * fetch bounded to the intended range (the SQL-side percentile/bucket rewrite
 * is the deeper scale fix, tracked separately).
 */
const MAX_WINDOW_DAYS = 366

function pickPercentile(sorted: number[], q: number): number | undefined {
  if (sorted.length === 0) return undefined
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length))
  return sorted[idx]
}

/** A wallclock-ns wire value → bigint, or null when absent/malformed. Only an
 *  integer string is accepted, so a garbage field (`"1.5"`, `"NaN"`) is dropped
 *  instead of throwing out of the ingest transaction. */
function intNsOrNull(v: string | undefined): bigint | null {
  return v !== undefined && /^-?\d+$/.test(v) ? BigInt(v) : null
}

/** Collision-free composite map key for a (project, task) pair — either field
 *  may contain spaces or `#`. */
function pairKey(project: string, task: string): string {
  return JSON.stringify([project, task])
}

/** Group a flat `{project, task, duration_ms}` result into ascending
 *  per-pair duration arrays — the batched equivalent of `successDurations`. */
function durationsByPair(
  rows: { project: string; task: string; duration_ms: number }[],
): Map<string, number[]> {
  const map = new Map<string, number[]>()
  for (const r of rows) {
    const key = pairKey(r.project, r.task)
    const list = map.get(key)
    if (list) list.push(r.duration_ms)
    else map.set(key, [r.duration_ms])
  }
  for (const list of map.values()) list.sort((a, b) => a - b)
  return map
}

/** Build one TaskHistoryRow from a pair's aggregate + its ascending success
 *  durations. Shared by the batched `getHistory` and the single-pair
 *  `historyFor` so their output can never drift. */
function historyRowFrom(
  project: string,
  task: string,
  agg: {
    total: number
    successes: number
    failures: number
    hits: number
    retried: number
    total_duration_ms: number | null
    last_seen_at: string | null
  },
  sorted: number[],
  mixedOutcomeKeys: number,
): TaskHistoryRow {
  const total = agg.total || 0
  const failures = agg.failures || 0
  // Flaky requires a nondeterminism SIGNAL: a within-run retry, or a cache
  // key that both failed and succeeded. Failures alone (each on its own key)
  // are legitimate breaks, not flakiness.
  const flakySignal = (agg.retried || 0) > 0 || mixedOutcomeKeys > 0
  const failureMode: TaskHistoryRow['failureMode'] = !flakySignal
    ? 'stable'
    : failures < total / 5
      ? 'flaky-recoverable'
      : 'flaky-fatal'
  const avg = sorted.length > 0 ? sorted.reduce((a, b) => a + b, 0) / sorted.length : undefined
  return {
    id: `${project}#${task}`,
    project,
    task,
    runs: total,
    successes: agg.successes || 0,
    failures,
    hits: agg.hits || 0,
    successRate: total > 0 ? (agg.successes || 0) / total : 0,
    hitRate: total > 0 ? (agg.hits || 0) / total : 0,
    failureMode,
    p50DurationMs: pickPercentile(sorted, 0.5),
    p99DurationMs: pickPercentile(sorted, 0.99),
    minDurationMs: sorted[0],
    maxDurationMs: sorted[sorted.length - 1],
    avgDurationMs: avg !== undefined ? Math.round(avg) : undefined,
    totalDurationMs: agg.total_duration_ms ?? 0,
    lastSeenAt: numOrNull(agg.last_seen_at) ?? undefined,
  }
}

function num(v: string | number): number {
  return Number(v)
}

function numOrNull(v: string | number | null): number | null {
  return v === null ? null : Number(v)
}

// jsonb columns are written as objects (not JSON.stringify'd strings — that
// double-encodes into a jsonb string scalar and breaks `@>`), so Bun.sql reads
// them back as parsed JS values. These parsers accept the object form and, for
// robustness, still parse a legacy string form.
function asJsonValue(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function parseTags(raw: unknown): Record<string, string> {
  const parsed = asJsonValue(raw)
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
    )
  }
  return {}
}

function parseRequestedTasks(raw: unknown): string[] {
  const parsed = asJsonValue(raw)
  return Array.isArray(parsed) ? parsed.map(String) : []
}

// The pass statuses for regression state — a cache hit counts as a pass.
const PASS_STATUSES = ['success', 'cache-hit', 'cache-hit-remote'] as const
const BRANCH_CAP = 12

/** Bounded per-hash fingerprint rows loaded for the O(N²) divergence diff. */
const FP_MAX_ROWS_PER_HASH = 64

interface RawRunRow {
  run_id: string
  project: string
  task: string
  status: string
  exit_code: number
  duration_ms: number
  started_at: string
  ended_at: string
  cache_hit: boolean | null
  hash: string
  cpu_ms: number | null
  peak_rss_bytes: string | null
  wallclock_start_ns: string | null
  wallclock_end_ns: string | null
}

const RUN_COLUMNS = `run_id, project, task, status, exit_code, duration_ms, started_at, ended_at,
  cache_hit, hash, cpu_ms, peak_rss_bytes, wallclock_start_ns, wallclock_end_ns`

function mapRunRow(r: RawRunRow): RunSummaryRow {
  return {
    runId: r.run_id,
    project: r.project,
    task: r.task,
    status: r.status,
    exitCode: r.exit_code,
    durationMs: r.duration_ms,
    startedAt: num(r.started_at),
    endedAt: num(r.ended_at),
    cacheHit: r.cache_hit,
    hash: r.hash,
    cpuMs: r.cpu_ms,
    peakRssBytes: numOrNull(r.peak_rss_bytes),
    wallclockStartNs: r.wallclock_start_ns,
    wallclockEndNs: r.wallclock_end_ns,
  }
}

interface RawInvocationRow {
  run_id: string
  command: string
  requested_tasks: string
  cache_policy: string
  concurrency: number
  flow: string | null
  started_at: string
  ended_at: string
  total_duration_ms: number
  task_count: number
  failed_count: number
  hit_count: number
  hit_local_count: number
  hit_remote_count: number
  exit_ok: boolean
  commit_sha: string | null
  branch: string | null
  dirty: boolean | null
  ci: boolean
  ci_provider: string | null
  host: string | null
  os: string | null
  arch: string | null
  vx_version: string
  tags: string
}

const INVOCATION_COLUMNS = `run_id, command, requested_tasks, cache_policy, concurrency, flow,
  started_at, ended_at, total_duration_ms, task_count, failed_count, hit_count, hit_local_count,
  hit_remote_count, exit_ok, commit_sha, branch, dirty, ci, ci_provider, host, os, arch,
  vx_version, tags`

function mapInvocation(r: RawInvocationRow): InvocationDetail {
  return {
    runId: r.run_id,
    command: r.command,
    requestedTasks: parseRequestedTasks(r.requested_tasks),
    cachePolicy: r.cache_policy,
    concurrency: r.concurrency,
    flow: r.flow === 'focused' || r.flow === 'broad' ? r.flow : null,
    startedAt: num(r.started_at),
    endedAt: num(r.ended_at),
    totalDurationMs: r.total_duration_ms,
    taskCount: r.task_count,
    failedCount: r.failed_count,
    hitCount: r.hit_count,
    hitLocalCount: r.hit_local_count,
    hitRemoteCount: r.hit_remote_count,
    exitOk: r.exit_ok,
    commitSha: r.commit_sha,
    branch: r.branch,
    dirty: r.dirty,
    ci: r.ci,
    ciProvider: r.ci_provider,
    host: r.host,
    os: r.os,
    arch: r.arch,
    vxVersion: r.vx_version,
    tags: parseTags(r.tags),
  }
}

/** Duration-hint memo TTL — the hints only order dispatch (never affect
 *  correctness), and they barely move between submissions minutes apart, so a
 *  short cache keeps a full-history GROUP BY off the submit critical path. */
const DURATION_HINT_TTL_MS = 30_000

/** The submitting run's scope for the trust-scoped duration hint. A run is
 *  TRUNK iff `branch === defaultBranch` (both non-null); an undetectable scope
 *  ({} / nulls) is treated as trunk — the strict, leak-free default. */
export interface DurationHintScope {
  branch?: string | null
  defaultBranch?: string | null
}

export class Analytics {
  constructor(private readonly sql: SQL) {}

  private readonly hintCache = new Map<string, { hints: Map<string, number>; expiresAt: number }>()

  // -------------------------------------------------------------------------
  // Ingest routing + auto-provision (§5.5)
  // -------------------------------------------------------------------------

  /**
   * Route a pushed client workspaceId to a server workspace within the token's
   * org. Auto-provisions a workspace + repo on first push (§5.5.2). A
   * workspace-scoped token can never resolve to another workspace — throws
   * WorkspaceForbiddenError otherwise.
   *
   * Concurrent first-pushes race on BOTH the workspace slug (`UNIQUE(org_id,
   * slug)`) and the repo claim (`UNIQUE(org_id, client_workspace_id)`); the
   * `workspaces` INSERT can lose that race and abort the transaction. Retry
   * from the fast-path read: after the winner commits, the SAME client id
   * resolves to the winner's workspace (convergence), and a slug-colliding
   * DIFFERENT client picks the next free slug — so a CI matrix's N parallel
   * first-pushes all land instead of N-1 being rejected with lost history.
   */
  async routeWorkspace(args: RouteArgs): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.routeWorkspaceOnce(args)
      } catch (err) {
        if (attempt < 4 && isUniqueViolation(err)) continue
        throw err
      }
    }
  }

  private async routeWorkspaceOnce(args: RouteArgs): Promise<string> {
    return this.sql.begin(async (tx) => {
      const existing = await tx<{ workspace_id: string }[]>`
        SELECT workspace_id FROM repos
        WHERE org_id = ${args.orgId} AND client_workspace_id = ${args.clientWorkspaceId}`
      if (existing.length > 0) {
        const wsId = existing[0]!.workspace_id
        if (args.tokenWorkspaceId !== undefined && wsId !== args.tokenWorkspaceId) {
          throw new WorkspaceForbiddenError('token is scoped to a different workspace')
        }
        await tx`UPDATE repos SET last_seen_at = ${args.now}
                 WHERE org_id = ${args.orgId} AND client_workspace_id = ${args.clientWorkspaceId}`
        return wsId
      }

      // A workspace-scoped token maps its (new) client id to its OWN workspace
      // — it can only ever write there, so no cross-workspace risk.
      if (args.tokenWorkspaceId !== undefined) {
        const ws = await tx<{ id: string }[]>`
          SELECT id FROM workspaces WHERE id = ${args.tokenWorkspaceId} AND org_id = ${args.orgId}`
        if (ws.length === 0) {
          throw new WorkspaceForbiddenError('token workspace does not exist in this org')
        }
        await tx`INSERT INTO repos
            (id, org_id, workspace_id, client_workspace_id, remote_url, first_seen_at, last_seen_at)
          VALUES (${Bun.randomUUIDv7()}, ${args.orgId}, ${args.tokenWorkspaceId},
                  ${args.clientWorkspaceId}, ${args.workspaceName}, ${args.now}, ${args.now})
          ON CONFLICT (org_id, client_workspace_id) DO UPDATE SET last_seen_at = ${args.now}`
        return args.tokenWorkspaceId
      }

      // Org-scoped token, first push → auto-provision a workspace + repo.
      const slug = await this.uniqueSlug(tx, args.orgId, args.workspaceName)
      const wsId = Bun.randomUUIDv7()
      await tx`INSERT INTO workspaces (id, org_id, slug, name, created_at)
               VALUES (${wsId}, ${args.orgId}, ${slug}, ${args.workspaceName}, ${args.now})`
      const claimed = await tx<{ workspace_id: string }[]>`
        INSERT INTO repos
            (id, org_id, workspace_id, client_workspace_id, remote_url, first_seen_at, last_seen_at)
          VALUES (${Bun.randomUUIDv7()}, ${args.orgId}, ${wsId},
                  ${args.clientWorkspaceId}, ${args.workspaceName}, ${args.now}, ${args.now})
          ON CONFLICT (org_id, client_workspace_id) DO UPDATE SET last_seen_at = ${args.now}
          RETURNING workspace_id`
      const finalWs = claimed[0]!.workspace_id
      if (finalWs !== wsId) {
        // A concurrent first-push won the repo row; drop our orphan workspace.
        await tx`DELETE FROM workspaces WHERE id = ${wsId}`
      }
      return finalWs
    })
  }

  /** A slug unique within the org (`base`, then `base-2`, `base-3`, …). */
  private async uniqueSlug(tx: SQL, orgId: string, base: string): Promise<string> {
    const root = slugify(base)
    for (let i = 1; i < 10_000; i++) {
      const candidate = i === 1 ? root : `${root}-${i}`
      const hit = await tx<{ one: number }[]>`
        SELECT 1 AS one FROM workspaces WHERE org_id = ${orgId} AND slug = ${candidate} LIMIT 1`
      if (hit.length === 0) return candidate
    }
    return `${root}-${Bun.randomUUIDv7().slice(0, 8)}`
  }

  // -------------------------------------------------------------------------
  // Ingest — a RunSummaryRecord into invocations + task_runs + fingerprints
  // -------------------------------------------------------------------------

  /**
   * Persist one pushed run. Routes the workspace (§5.5), then writes the
   * invocation header + task rows + fingerprints and auto-provisions the
   * projects/tasks the run names — all in ONE transaction, idempotent on
   * (started_at, run_id). Returns whether the run was newly stored + the
   * resolved server workspace id.
   */
  async ingest(args: {
    orgId: string
    tokenWorkspaceId?: string | undefined
    summary: RunSummaryRecord
    tokenId?: string | undefined
    now?: number
  }): Promise<{ stored: boolean; workspaceId: string }> {
    const now = args.now ?? Date.now()
    const r = args.summary.run
    const clientWorkspaceId =
      typeof r.workspaceId === 'string' && r.workspaceId !== '' ? r.workspaceId : 'default'
    const workspaceName =
      typeof r.workspaceName === 'string' && r.workspaceName !== ''
        ? r.workspaceName
        : clientWorkspaceId
    const workspaceId = await this.routeWorkspace({
      orgId: args.orgId,
      tokenWorkspaceId: args.tokenWorkspaceId,
      clientWorkspaceId,
      workspaceName,
      now,
    })

    const summary = args.summary
    const tokenId = args.tokenId ?? null
    const stored = await this.sql.begin(async (tx) => {
      const inserted = await tx<{ run_id: string }[]>`
        INSERT INTO invocations (
          run_id, org_id, workspace_id, command, requested_tasks, cache_policy, concurrency, flow,
          started_at, ended_at, total_duration_ms, task_count, failed_count, hit_count,
          hit_local_count, hit_remote_count, exit_ok, commit_sha, branch, default_branch, dirty,
          ci, ci_provider, host, os, arch, vx_version, tags, ingested_by_token)
        VALUES (
          ${r.runId}, ${args.orgId}, ${workspaceId}, ${r.command},
          ${r.requestedTasks}::jsonb, ${r.cachePolicy}, ${r.concurrency}, ${r.flow},
          ${summary.startedAt}, ${summary.endedAt}, ${summary.totalDurationMs}, ${summary.taskCount},
          ${summary.failedCount}, ${summary.hitCount}, ${summary.hitLocalCount},
          ${summary.hitRemoteCount}, ${summary.exitOk}, ${r.commitSha}, ${r.branch},
          ${r.defaultBranch ?? null}, ${r.dirty},
          ${r.ci}, ${r.ciProvider}, ${r.host}, ${r.os}, ${r.arch}, ${r.vxVersion},
          ${r.tags}::jsonb, ${tokenId})
        ON CONFLICT (started_at, run_id) DO NOTHING
        RETURNING run_id`
      if (inserted.length === 0) return false

      const projectTasks = new Map<string, Set<string>>()
      for (const t of summary.tasks) {
        if (t.status === 'aborted') continue
        // The end-of-run backstop: re-insert every task_run with ON CONFLICT
        // DO NOTHING so a task already delivered incrementally (POST
        // /v1/ingest/task) is skipped, and any incremental push that dropped
        // is backfilled here. Shared derivation → identical (started_at,
        // run_id, project, task) key in both paths.
        await this.insertTaskRun(
          tx,
          args.orgId,
          workspaceId,
          r.runId,
          summary.startedAt,
          summary.endedAt,
          t,
        )
        let names = projectTasks.get(t.project)
        if (names === undefined) {
          names = new Set()
          projectTasks.set(t.project, names)
        }
        names.add(t.task)
      }

      // Auto-provision projects + task names (name-only; a catalog push
      // enriches them with config — DO NOTHING preserves that).
      for (const [project, taskNames] of projectTasks) {
        const projectId = await this.upsertProject(tx, args.orgId, workspaceId, project, now)
        for (const task of taskNames) {
          await tx`INSERT INTO project_tasks (project_id, task, updated_at)
                   VALUES (${projectId}, ${task}, ${now})
                   ON CONFLICT (project_id, task) DO NOTHING`
        }
      }

      // Output fingerprints (verify-cross-machine): idempotent per platform.
      for (const t of summary.tasks) {
        if (t.hash === undefined || !validFingerprint(t.outputFp)) continue
        const fp = t.outputFp
        const { files, truncated } = normalizeFpFiles(fp.files, fp.truncated)
        await tx`INSERT INTO output_fingerprints (
            org_id, workspace_id, hash, os, arch, tree, file_count, files, truncated,
            task_id, run_id, host, created_at)
          VALUES (
            ${args.orgId}, ${workspaceId}, ${t.hash}, ${r.os}, ${r.arch}, ${fp.tree},
            ${fp.fileCount}, ${files}::jsonb,
            ${truncated}, ${t.taskId}, ${r.runId}, ${r.host}, ${now})
          ON CONFLICT (workspace_id, hash, os, arch, tree) DO NOTHING`
      }
      return true
    })
    return { stored, workspaceId }
  }

  private async upsertProject(
    tx: SQL,
    orgId: string,
    workspaceId: string,
    name: string,
    now: number,
  ): Promise<string> {
    const rows = await tx<{ id: string }[]>`
      INSERT INTO projects (id, org_id, workspace_id, name, first_seen_at, last_seen_at)
      VALUES (${Bun.randomUUIDv7()}, ${orgId}, ${workspaceId}, ${name}, ${now}, ${now})
      ON CONFLICT (workspace_id, name) DO UPDATE SET last_seen_at = ${now}
      RETURNING id`
    return rows[0]!.id
  }

  /**
   * Insert ONE task_run row, idempotently. Shared by the end-of-run batch
   * (`ingest`) and the per-task incremental path (`ingestTask`) so both derive
   * the SAME (started_at, run_id, project, task) key — `runStartedAt` +
   * the task's wallclock-ns offset — and the unique index dedups a task that
   * arrives twice. A malformed wallclock-ns string is treated as absent (never
   * aborts the transaction). started_at falls back to the run start; ended_at
   * to `runEndedAt` (the incremental path passes `now`, since the run isn't
   * over yet — only cache-hit rows with null wallclock ns use it, and their
   * duration is ~0, so it's immaterial and NOT part of the dedup key).
   */
  private async insertTaskRun(
    tx: SQL,
    orgId: string,
    workspaceId: string,
    runId: string,
    runStartedAt: number,
    runEndedAt: number,
    t: TaskTelemetry,
  ): Promise<void> {
    const startNs = intNsOrNull(t.wallclockStartNs)
    const endNs = intNsOrNull(t.wallclockEndNs)
    const startedAt =
      startNs !== null ? runStartedAt + Math.round(Number(startNs) / 1e6) : runStartedAt
    const endedAt = endNs !== null ? runStartedAt + Math.round(Number(endNs) / 1e6) : runEndedAt
    const cacheHit = t.cacheSource === 'local' || t.cacheSource === 'remote'
    await tx`INSERT INTO task_runs (
        org_id, workspace_id, run_id, hash, project, task, status, exit_code, duration_ms,
        started_at, ended_at, cpu_ms, peak_rss_bytes, wallclock_start_ns, wallclock_end_ns,
        cache_hit, attempts)
      VALUES (
        ${orgId}, ${workspaceId}, ${runId}, ${t.hash ?? ''}, ${t.project}, ${t.task},
        ${t.status}, ${t.exitCode}, ${t.durationMs}, ${startedAt}, ${endedAt},
        ${t.cpuMs ?? null}, ${t.peakRssBytes ?? null}, ${startNs}, ${endNs},
        ${cacheHit}, ${t.attempts ?? null})
      ON CONFLICT (started_at, run_id, project, task) DO NOTHING`
  }

  /**
   * Per-task incremental ingest: one task's result + (optionally) its log tail,
   * shipped the moment the task finishes — so the run's detail fills in live
   * instead of appearing only at end-of-run. Idempotent (the task_run unique
   * index + the log existence check); the end-of-run summary is the
   * completeness backstop that backfills anything a per-task push dropped.
   * Routes the workspace exactly like `ingest` (from the token, or the client
   * workspace id on first push). Aborted tasks are ignored (no meaningful row).
   */
  async ingestTask(args: {
    orgId: string
    tokenWorkspaceId?: string | undefined
    record: TaskIngestRecord
    now?: number
  }): Promise<{ stored: boolean; workspaceId: string }> {
    const now = args.now ?? Date.now()
    const rec = args.record
    if (rec.task.status === 'aborted') {
      // Still route the workspace so a workspace-scoped token's clamp is honored
      // consistently, but store nothing.
      const workspaceId = await this.routeWorkspace({
        orgId: args.orgId,
        tokenWorkspaceId: args.tokenWorkspaceId,
        clientWorkspaceId: rec.workspaceId,
        workspaceName: rec.workspaceName ?? rec.workspaceId,
        now,
      })
      return { stored: false, workspaceId }
    }
    const workspaceId = await this.routeWorkspace({
      orgId: args.orgId,
      tokenWorkspaceId: args.tokenWorkspaceId,
      clientWorkspaceId: rec.workspaceId,
      workspaceName: rec.workspaceName ?? rec.workspaceId,
      now,
    })
    await this.sql.begin(async (tx) => {
      await this.insertTaskRun(
        tx,
        args.orgId,
        workspaceId,
        rec.runId,
        rec.runStartedAt,
        rec.runEndedAt ?? now,
        rec.task,
      )
      // Provision the project + task name (metadata only; a catalog push enriches).
      const projectId = await this.upsertProject(tx, args.orgId, workspaceId, rec.task.project, now)
      await tx`INSERT INTO project_tasks (project_id, task, updated_at)
               VALUES (${projectId}, ${rec.task.task}, ${now})
               ON CONFLICT (project_id, task) DO NOTHING`
      // The task's log tail (idempotent per (workspace, run, task); the same
      // existence check the batch log path uses, so an end-of-run re-send is a
      // no-op). Capped to the per-task tail server-side — the wire is untrusted.
      if (rec.log !== undefined) {
        const exists = await tx<{ one: number }[]>`
          SELECT 1 AS one FROM task_logs
          WHERE workspace_id = ${workspaceId} AND run_id = ${rec.runId}
            AND task_id = ${rec.task.taskId}
          LIMIT 1`
        if (exists.length === 0) {
          let content = rec.log.content
          let extraTrunc = 0
          if (content.length > TASK_LOG_TAIL_CHARS) {
            const keep = content.slice(content.length - TASK_LOG_TAIL_CHARS)
            extraTrunc = content.length - keep.length
            content = keep
          }
          const raw = Buffer.from(content, 'utf8')
          const useZstd = raw.length >= COMPRESS_THRESHOLD_BYTES
          const blob = useZstd ? Bun.zstdCompressSync(raw) : raw
          await tx`INSERT INTO task_logs (
              org_id, workspace_id, run_id, task_id, hash, status, codec, content,
              chars_full, truncated_head, created_at)
            VALUES (
              ${args.orgId}, ${workspaceId}, ${rec.runId}, ${rec.task.taskId}, ${rec.task.hash ?? null},
              ${rec.task.status}, ${useZstd ? 'zstd' : 'plain'}, ${blob}, ${rec.log.charsFull},
              ${rec.log.truncatedHeadChars + extraTrunc}, ${now})`
        }
      }
    })
    return { stored: true, workspaceId }
  }

  // -------------------------------------------------------------------------
  // Log ingest — bounded per-task tails, idempotent, re-truncated server-side
  // -------------------------------------------------------------------------

  async ingestLogs(args: {
    orgId: string
    tokenWorkspaceId?: string | undefined
    bundle: TaskLogBundle
    now?: number
  }): Promise<{ stored: number; workspaceId: string }> {
    const now = args.now ?? Date.now()
    const workspaceId = await this.routeWorkspace({
      orgId: args.orgId,
      tokenWorkspaceId: args.tokenWorkspaceId,
      clientWorkspaceId: args.bundle.workspaceId,
      workspaceName: args.bundle.workspaceId,
      now,
    })
    const bundle = args.bundle
    const stored = await this.sql.begin(async (tx) => {
      let runBudget = RUN_LOG_BUDGET_CHARS
      let count = 0
      // Failures already lead the bundle (drain order); process in order so a
      // hostile/huge body drops later successes, never the failures.
      for (const t of bundle.tasks) {
        if (runBudget <= 0) break
        const exists = await tx<{ one: number }[]>`
          SELECT 1 AS one FROM task_logs
          WHERE workspace_id = ${workspaceId} AND run_id = ${bundle.runId} AND task_id = ${t.taskId}
          LIMIT 1`
        if (exists.length > 0) continue
        let content = t.content
        let extraTrunc = 0
        if (content.length > TASK_LOG_TAIL_CHARS) {
          const keep = content.slice(content.length - TASK_LOG_TAIL_CHARS)
          extraTrunc = content.length - keep.length
          content = keep
        }
        if (content.length > runBudget) {
          const keep = content.slice(content.length - runBudget)
          extraTrunc += content.length - keep.length
          content = keep
        }
        runBudget -= content.length
        const raw = Buffer.from(content, 'utf8')
        const useZstd = raw.length >= COMPRESS_THRESHOLD_BYTES
        const blob = useZstd ? Bun.zstdCompressSync(raw) : raw
        await tx`INSERT INTO task_logs (
            org_id, workspace_id, run_id, task_id, hash, status, codec, content,
            chars_full, truncated_head, created_at)
          VALUES (
            ${args.orgId}, ${workspaceId}, ${bundle.runId}, ${t.taskId}, ${t.hash ?? null},
            ${t.status}, ${useZstd ? 'zstd' : 'plain'}, ${blob}, ${t.charsFull},
            ${t.truncatedHeadChars + extraTrunc}, ${now})`
        count++
      }
      return count
    })
    return { stored, workspaceId }
  }

  // -------------------------------------------------------------------------
  // Catalog push (§5.6) — the lock-derived project + task index
  // -------------------------------------------------------------------------

  async ingestCatalog(args: {
    orgId: string
    tokenWorkspaceId?: string | undefined
    push: CatalogPush
    now?: number
  }): Promise<{ workspaceId: string }> {
    const now = args.now ?? Date.now()
    const workspaceId = await this.routeWorkspace({
      orgId: args.orgId,
      tokenWorkspaceId: args.tokenWorkspaceId,
      clientWorkspaceId: args.push.workspaceId,
      workspaceName:
        args.push.workspaceName !== undefined && args.push.workspaceName !== ''
          ? args.push.workspaceName
          : args.push.workspaceId,
      now,
    })
    await this.sql.begin(async (tx) => {
      for (const p of args.push.projects) {
        const projectId = await this.upsertProject(tx, args.orgId, workspaceId, p.name, now)
        for (const t of p.tasks ?? []) {
          await tx`INSERT INTO project_tasks
              (project_id, task, config, cacheable, is_group, persistent, updated_at)
            VALUES (
              ${projectId}, ${t.task},
              ${t.config ?? null}::jsonb,
              ${t.cacheable ?? null}, ${t.isGroup ?? null}, ${t.persistent ?? null}, ${now})
            ON CONFLICT (project_id, task) DO UPDATE SET
              config = EXCLUDED.config, cacheable = EXCLUDED.cacheable,
              is_group = EXCLUDED.is_group, persistent = EXCLUDED.persistent, updated_at = ${now}`
        }
      }
    })
    return { workspaceId }
  }

  // -------------------------------------------------------------------------
  // Workspace selection (the read-side org clamp)
  // -------------------------------------------------------------------------

  /**
   * Resolve which workspace a session read targets. `wsParam` (the `?ws=`
   * query) must belong to the org — a foreign/unknown/malformed id returns
   * null (→ 404). No param → the most-recently-active workspace, or null when
   * the org has none yet.
   */
  async resolveReadWorkspace(orgId: string, wsParam?: string | null): Promise<string | null> {
    if (wsParam !== null && wsParam !== undefined && wsParam !== '') {
      if (!UUID_RE.test(wsParam)) return null
      const rows = await this.sql<{ id: string }[]>`
        SELECT id FROM workspaces WHERE id = ${wsParam} AND org_id = ${orgId}`
      return rows.length > 0 ? wsParam : null
    }
    const rows = await this.sql<{ id: string }[]>`
      SELECT w.id AS id,
             COALESCE((SELECT MAX(last_seen_at) FROM repos WHERE workspace_id = w.id), w.created_at) AS seen
      FROM workspaces w WHERE w.org_id = ${orgId}
      ORDER BY seen DESC LIMIT 1`
    return rows[0]?.id ?? null
  }

  /**
   * Read-only map a pushed client workspaceId (the core 16-hex fingerprint) to
   * its server workspace UUID within an org — the dist duration-hint lookup.
   * Never provisions (unlike `routeWorkspace`); an un-ingested workspace → null
   * (the caller degrades to FIFO dispatch). Scoped by orgId so it never crosses
   * the tenant boundary.
   */
  async resolveClientWorkspace(orgId: string, clientWorkspaceId: string): Promise<string | null> {
    const rows = await this.sql<{ workspace_id: string }[]>`
      SELECT workspace_id FROM repos
      WHERE org_id = ${orgId} AND client_workspace_id = ${clientWorkspaceId} LIMIT 1`
    return rows[0]?.workspace_id ?? null
  }

  /** Every workspace in an org (id, name, slug, lastSeen, runCount) — the switcher. */
  async workspacesForOrg(orgId: string): Promise<WorkspaceEntry[]> {
    const rows = await this.sql<
      { id: string; name: string; slug: string; last_seen: string; run_count: number }[]
    >`
      SELECT w.id AS id, w.name AS name, w.slug AS slug,
             COALESCE((SELECT MAX(last_seen_at) FROM repos WHERE workspace_id = w.id), w.created_at) AS last_seen,
             (SELECT count(*)::int FROM invocations WHERE workspace_id = w.id) AS run_count
      FROM workspaces w WHERE w.org_id = ${orgId}
      ORDER BY last_seen DESC`
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      lastSeenAt: Number(r.last_seen),
      runCount: Number(r.run_count),
    }))
  }

  /** Workspace count for an org — the admin rollup / `/v1/meta` (org-scoped). */
  async workspaceCount(orgId: string): Promise<number> {
    const rows = await this.sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM workspaces WHERE org_id = ${orgId}`
    return rows[0]!.c
  }

  // =========================================================================
  // Reads — the org/workspace-clamped Postgres port of metrics.ts. Every query
  // filters by workspace_id (the tenant clamp), and the cache-ENTRY inventory
  // queries return the shaped empties they already returned on the cloud store
  // (the analytics schema holds run/task history only — cache inventory is a
  // local concern / the S3 artifact list, §5.1).
  // =========================================================================

  async listRuns(workspaceId: string, args: ListRunsArgs = {}): Promise<RunSummaryRow[]> {
    const sql = this.sql
    const limit = clampInt(args.limit ?? 100, 1, 100_000)
    const fProject = args.project !== undefined ? sql`AND project = ${args.project}` : sql``
    const fTask = args.task !== undefined ? sql`AND task = ${args.task}` : sql``
    const fRun = args.runId !== undefined ? sql`AND run_id = ${args.runId}` : sql``
    const rows = await sql<RawRunRow[]>`
      SELECT ${sql.unsafe(RUN_COLUMNS)} FROM task_runs
      WHERE workspace_id = ${workspaceId} ${fProject} ${fTask} ${fRun}
      ORDER BY started_at DESC LIMIT ${limit}`
    return rows.map(mapRunRow)
  }

  async getInvocation(workspaceId: string, runId: string): Promise<InvocationDetail | null> {
    const rows = await this.sql<RawInvocationRow[]>`
      SELECT ${this.sql.unsafe(INVOCATION_COLUMNS)} FROM invocations
      WHERE workspace_id = ${workspaceId} AND run_id = ${runId}`
    return rows[0] ? mapInvocation(rows[0]) : null
  }

  async listInvocations(
    workspaceId: string,
    args: ListInvocationsArgs = {},
  ): Promise<InvocationDetail[]> {
    const sql = this.sql
    const limit = clampInt(args.limit ?? 50, 1, 500)
    const fBranch = args.branch !== undefined ? sql`AND branch = ${args.branch}` : sql``
    const fCi = args.ci !== undefined ? sql`AND ci = ${args.ci}` : sql``
    // jsonb containment (the Postgres-correct form of core's tags LIKE hack).
    const fTag =
      args.tagKey !== undefined && args.tagValue !== undefined
        ? sql`AND tags @> ${{ [args.tagKey]: args.tagValue }}::jsonb`
        : sql``
    const rows = await sql<RawInvocationRow[]>`
      SELECT ${sql.unsafe(INVOCATION_COLUMNS)} FROM invocations
      WHERE workspace_id = ${workspaceId} ${fBranch} ${fCi} ${fTag}
      ORDER BY started_at DESC LIMIT ${limit}`
    return rows.map(mapInvocation)
  }

  /**
   * The notification feed: recent invocations that broke (`failed_count > 0`),
   * newest first. Workspace-clamped; one indexed scan over the invocations
   * header table (never the task_runs partitions), so it is cheap to poll. The
   * client computes the unread count from a last-seen watermark.
   */
  async getNotifications(workspaceId: string, limit = 20): Promise<NotificationItem[]> {
    // failing_projects rides a LATERAL json_agg over the run's failed task
    // rows — bounded by the feed's own LIMIT, and JSON (not a pg array) so the
    // driver hands back a parsed string[] without array-literal parsing.
    const rows = await this.sql<
      {
        run_id: string
        started_at: number
        branch: string | null
        commit_sha: string | null
        failed_count: number
        task_count: number
        failing_projects: string[] | null
      }[]
    >`
      SELECT i.run_id, i.started_at, i.branch, i.commit_sha, i.failed_count, i.task_count,
             fp.projects AS failing_projects
      FROM invocations i
      LEFT JOIN LATERAL (
        SELECT json_agg(DISTINCT t.project) AS projects
        FROM task_runs t
        WHERE t.workspace_id = i.workspace_id AND t.run_id = i.run_id
          AND t.status = 'failed'
      ) fp ON true
      WHERE i.workspace_id = ${workspaceId} AND i.failed_count > 0
      ORDER BY i.started_at DESC LIMIT ${clampInt(limit, 1, 100)}`
    return rows.map((r) => ({
      kind: 'run-failed',
      runId: r.run_id,
      startedAt: Number(r.started_at),
      branch: r.branch,
      commitSha: r.commit_sha,
      failedCount: r.failed_count,
      taskCount: r.task_count,
      failingProjects: Array.isArray(r.failing_projects) ? r.failing_projects : [],
    }))
  }

  async getRun(workspaceId: string, runId: string): Promise<RunDetail | null> {
    const tasks = await this.listRuns(workspaceId, { runId, limit: 100_000 })
    if (tasks.length === 0) return null
    // Reduce, not spread — a run with tens of thousands of task rows would
    // overflow the argument-list limit of `Math.min(...)`.
    let startedAt = Infinity
    let endedAt = -Infinity
    for (const t of tasks) {
      if (t.startedAt < startedAt) startedAt = t.startedAt
      if (t.endedAt > endedAt) endedAt = t.endedAt
    }
    return { runId, startedAt, endedAt, tasks }
  }

  async getCacheStatsSql(workspaceId: string, windowDays = 1): Promise<CacheStatsResult> {
    // `windowDays` scopes the run/hit counts (the Insights timeframe selector);
    // default 1 = 24h keeps every caller that omits it byte-identical. Field
    // names keep the `Last24h` suffix as an internal wire label — the value
    // reflects the requested window and the UI relabels it.
    const since = Date.now() - clampInt(windowDays, 1, MAX_WINDOW_DAYS) * 24 * 60 * 60 * 1000
    const runs = (
      await this.sql<{ total: number; hit_local: number; hit_remote: number }[]>`
        SELECT count(*)::int AS total,
               COALESCE(SUM(CASE WHEN status = 'cache-hit' THEN 1 ELSE 0 END), 0)::int AS hit_local,
               COALESCE(SUM(CASE WHEN status = 'cache-hit-remote' THEN 1 ELSE 0 END), 0)::int AS hit_remote
        FROM task_runs WHERE workspace_id = ${workspaceId} AND started_at >= ${since}`
    )[0]!
    const hits = runs.hit_local + runs.hit_remote
    // The analytics schema holds no cache-entry inventory (§5.1) — entryCount /
    // totalBytes are 0; run/hit counts are real.
    return {
      entryCount: 0,
      totalBytes: 0,
      runCountLast24h: runs.total,
      hitCountLast24h: hits,
      hitRate24h: runs.total > 0 ? hits / runs.total : 0,
      hitLocalCountLast24h: runs.hit_local,
      hitRemoteCountLast24h: runs.hit_remote,
    }
  }

  async getHitRateSplit(workspaceId: string, days = 1): Promise<HitRateSplit> {
    const since = Date.now() - days * 24 * 60 * 60 * 1000
    const r = (
      await this.sql<{ total: number; hit_local: number; hit_remote: number }[]>`
        SELECT count(*)::int AS total,
               COALESCE(SUM(CASE WHEN status = 'cache-hit' THEN 1 ELSE 0 END), 0)::int AS hit_local,
               COALESCE(SUM(CASE WHEN status = 'cache-hit-remote' THEN 1 ELSE 0 END), 0)::int AS hit_remote
        FROM task_runs WHERE workspace_id = ${workspaceId} AND started_at >= ${since}`
    )[0]!
    const hits = r.hit_local + r.hit_remote
    return {
      total: r.total,
      hits,
      hitLocal: r.hit_local,
      hitRemote: r.hit_remote,
      hitRate: r.total > 0 ? hits / r.total : 0,
      localShare: hits > 0 ? r.hit_local / hits : 0,
      remoteShare: hits > 0 ? r.hit_remote / hits : 0,
    }
  }

  async getHistory(workspaceId: string, args: GetHistoryArgs = {}): Promise<TaskHistoryRow[]> {
    const sql = this.sql
    const limit = clampInt(args.limit ?? 50, 1, 500)
    const fProject = args.project !== undefined ? sql`AND project = ${args.project}` : sql``
    const fTask = args.task !== undefined ? sql`AND task = ${args.task}` : sql``
    // The pairs to render (unchanged set + order — the DISTINCT scan).
    const pairs = (
      await sql<{ project: string; task: string }[]>`
        SELECT DISTINCT project, task FROM task_runs
        WHERE workspace_id = ${workspaceId} ${fProject} ${fTask}`
    ).slice(0, limit)
    if (pairs.length === 0) return []
    // TWO set-based queries replace the former 1 + 2N per-pair fan-out: one
    // GROUP BY for every pair's aggregate, one windowed query for the last-50
    // successful non-hit durations per pair (ROW_NUMBER — the same rows the
    // per-pair `successDurations` fetched). The per-row math below is shared
    // with `historyFor`, so the result matches the old loop exactly.
    const aggRows = await sql<
      {
        project: string
        task: string
        total: number
        successes: number
        failures: number
        hits: number
        retried: number
        total_duration_ms: number | null
        last_seen_at: string | null
      }[]
    >`
      SELECT project, task,
             count(*)::int AS total,
             SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END)::int AS successes,
             SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)::int AS failures,
             SUM(CASE WHEN cache_hit = true OR status LIKE 'cache-hit%' THEN 1 ELSE 0 END)::int AS hits,
             SUM(CASE WHEN attempts > 1 THEN 1 ELSE 0 END)::int AS retried,
             SUM(duration_ms)::float8 AS total_duration_ms,
             MAX(ended_at) AS last_seen_at
      FROM task_runs WHERE workspace_id = ${workspaceId} ${fProject} ${fTask}
      GROUP BY project, task`
    const durRows = await sql<{ project: string; task: string; duration_ms: number }[]>`
      SELECT project, task, duration_ms FROM (
        SELECT project, task, duration_ms,
               ROW_NUMBER() OVER (PARTITION BY project, task ORDER BY started_at DESC) AS rn
        FROM task_runs
        WHERE workspace_id = ${workspaceId} ${fProject} ${fTask}
          AND (cache_hit IS NULL OR cache_hit = false) AND status = 'success'
      ) t WHERE rn <= 50`
    const aggByKey = new Map(aggRows.map((r) => [pairKey(r.project, r.task), r]))
    const dursByKey = durationsByPair(durRows)
    const mixedByKey = await this.mixedOutcomeKeyCounts(workspaceId, args)
    return pairs.map((p) => {
      const key = pairKey(p.project, p.task)
      const agg = aggByKey.get(key) ?? {
        project: p.project,
        task: p.task,
        total: 0,
        successes: 0,
        failures: 0,
        hits: 0,
        retried: 0,
        total_duration_ms: null,
        last_seen_at: null,
      }
      return historyRowFrom(
        p.project,
        p.task,
        agg,
        dursByKey.get(key) ?? [],
        mixedByKey.get(key) ?? 0,
      )
    })
  }

  private async historyFor(
    workspaceId: string,
    project: string,
    task: string,
  ): Promise<TaskHistoryRow> {
    const agg = (
      await this.sql<
        {
          total: number
          successes: number
          failures: number
          hits: number
          retried: number
          total_duration_ms: number | null
          last_seen_at: string | null
        }[]
      >`
        SELECT count(*)::int AS total,
               SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END)::int AS successes,
               SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)::int AS failures,
               SUM(CASE WHEN cache_hit = true OR status LIKE 'cache-hit%' THEN 1 ELSE 0 END)::int AS hits,
               SUM(CASE WHEN attempts > 1 THEN 1 ELSE 0 END)::int AS retried,
               SUM(duration_ms)::float8 AS total_duration_ms,
               MAX(ended_at) AS last_seen_at
        FROM task_runs WHERE workspace_id = ${workspaceId} AND project = ${project} AND task = ${task}`
    )[0]!
    const sorted = await this.successDurations(workspaceId, project, task)
    const mixedByKey = await this.mixedOutcomeKeyCounts(workspaceId, { project, task })
    return historyRowFrom(project, task, agg, sorted, mixedByKey.get(pairKey(project, task)) ?? 0)
  }

  /** Last 50 successful non-hit durations, ascending — the percentile base. */
  private async successDurations(
    workspaceId: string,
    project: string,
    task: string,
  ): Promise<number[]> {
    const rows = await this.sql<{ duration_ms: number }[]>`
      SELECT duration_ms FROM task_runs
      WHERE workspace_id = ${workspaceId} AND project = ${project} AND task = ${task}
        AND (cache_hit IS NULL OR cache_hit = false) AND status = 'success'
      ORDER BY started_at DESC LIMIT 50`
    return rows.map((r) => r.duration_ms).sort((a, b) => a - b)
  }

  async getTopTimeBurners(workspaceId: string, limit = 10): Promise<TopTaskRow[]> {
    const rows = await this.sql<
      {
        id: string
        project: string
        task: string
        runs: number
        total_duration_ms: number
        avg_duration_ms: number
      }[]
    >`
      SELECT project || '#' || task AS id, project, task, count(*)::int AS runs,
             SUM(duration_ms)::float8 AS total_duration_ms,
             trunc(avg(duration_ms))::int AS avg_duration_ms
      FROM task_runs
      WHERE workspace_id = ${workspaceId} AND (cache_hit IS NULL OR cache_hit = false)
        AND status = 'success'
      GROUP BY project, task
      ORDER BY SUM(duration_ms) DESC LIMIT ${clampInt(limit, 1, 100)}`
    return rows.map((r) => ({
      id: r.id,
      project: r.project,
      task: r.task,
      runs: r.runs,
      totalDurationMs: r.total_duration_ms,
      avgDurationMs: r.avg_duration_ms,
    }))
  }

  async getRecentFailures(workspaceId: string, limit = 25): Promise<FailureRow[]> {
    const rows = await this.sql<
      {
        run_id: string
        project: string
        task: string
        exit_code: number
        duration_ms: number
        started_at: string
        hash: string
      }[]
    >`
      SELECT run_id, project, task, exit_code, duration_ms, started_at, hash
      FROM task_runs WHERE workspace_id = ${workspaceId} AND status = 'failed'
      ORDER BY started_at DESC LIMIT ${clampInt(limit, 1, 200)}`
    return rows.map((r) => ({
      runId: r.run_id,
      project: r.project,
      task: r.task,
      exitCode: r.exit_code,
      durationMs: r.duration_ms,
      startedAt: num(r.started_at),
      hash: r.hash,
    }))
  }

  // The analytics schema has no cache-entry inventory (§5.1); these return the
  // shaped empties the cloud store already returned.
  async listCacheEntries(
    _workspaceId: string,
    _args: ListCacheEntriesArgs = {},
  ): Promise<CacheEntryRow[]> {
    return []
  }

  async getCacheBreakdown(_workspaceId: string, _limit = 20): Promise<CacheProjectRow[]> {
    return []
  }

  async getPrunableEntries(
    _workspaceId: string,
    _minAgeDays = 7,
    _limit = 50,
  ): Promise<PrunableEntry[]> {
    return []
  }

  /** Daily storage growth — all-zero buckets (no cache-entry inventory, §5.1). */
  async getStorageGrowth(_workspaceId: string, days = 30): Promise<StoragePoint[]> {
    const bucketMs = 24 * 60 * 60 * 1000
    // Bound the fill loop: a hostile `?days=1e9` would otherwise push ~1e9
    // zero-points and freeze the server.
    const since = Date.now() - clampInt(days, 1, MAX_WINDOW_DAYS) * bucketMs
    const start = Math.floor(since / bucketMs) * bucketMs
    const end = Math.floor(Date.now() / bucketMs) * bucketMs
    const out: StoragePoint[] = []
    for (let t = start; t <= end; t += bucketMs) out.push({ t, bytesAdded: 0, entriesAdded: 0 })
    return out
  }

  async getTaskDetail(workspaceId: string, taskId: string): Promise<TaskDetail | null> {
    const [project, task] = taskId.split('#', 2) as [string, string]
    const exists = await this.sql<{ one: number }[]>`
      SELECT 1 AS one FROM task_runs
      WHERE workspace_id = ${workspaceId} AND project = ${project} AND task = ${task} LIMIT 1`
    if (exists.length === 0) return null
    const recent = await this.listRuns(workspaceId, { project, task, limit: 100 })
    const hist = await this.getHistory(workspaceId, { project, task, limit: 1 })
    return { project, task, aggregate: hist[0] ?? null, recent, latestEntry: null }
  }

  async getCacheSavings(workspaceId: string): Promise<CacheSavings> {
    const since = Date.now() - 24 * 60 * 60 * 1000
    // One set-based query instead of two per-hit-row correlated subqueries.
    // `uncached` = the avg uncached-success duration per (project, task); each
    // cache-hit row joins to its task's baseline (the inner join is the old
    // `WHERE avg_dur IS NOT NULL`), and the 24h figures are a FILTER on the
    // same scan. Output-identical to the prior two queries.
    const r = (
      await this.sql<{ saved24: number; hits24: number; savedAll: number }[]>`
        WITH uncached AS (
          SELECT project, task, trunc(avg(duration_ms))::int AS avg_dur
          FROM task_runs
          WHERE workspace_id = ${workspaceId}
            AND (cache_hit IS NULL OR cache_hit = false) AND status = 'success'
          GROUP BY project, task
        )
        SELECT
          COALESCE(SUM(u.avg_dur) FILTER (WHERE h.started_at >= ${since}), 0)::float8 AS "saved24",
          count(*) FILTER (WHERE h.started_at >= ${since})::int AS "hits24",
          COALESCE(SUM(u.avg_dur), 0)::float8 AS "savedAll"
        FROM task_runs h JOIN uncached u ON u.project = h.project AND u.task = h.task
        WHERE h.workspace_id = ${workspaceId}
          AND (h.cache_hit = true OR h.status LIKE 'cache-hit%')`
    )[0]!
    return {
      hitsLast24h: r.hits24,
      estimatedTimeSavedMs: r.saved24,
      estimatedTimeSavedTotalMs: r.savedAll,
    }
  }

  async explainCacheKey(_workspaceId: string, taskId: string): Promise<CacheKeyExplanation> {
    const [project, task] = taskId.split('#', 2) as [string, string]
    return {
      taskId,
      project,
      task,
      latestEntry: null,
      note: 'cache key components (files / env / runtime / upstream) require live config evaluation; this surface returns persisted entry metadata',
    }
  }

  /**
   * Batched "why did this re-run" over EVERY executed task of a run — one
   * LATERAL query instead of the client's per-task `/v1/diff` fan-out (a
   * 500-task run was 500 requests). For each success/failed task, find the
   * most-recent prior run of the same (project, task) and compare cache keys:
   * no prior → first run; key changed → inputs changed; key same → ran without
   * a cache hit (not cacheable / forced). Input-component detail lives in the
   * local cache.db (not the platform), so only the hash-change verdict is known
   * here — the same limit the per-task path has, now computed in one round-trip.
   */
  async whyRunReran(workspaceId: string, runId: string): Promise<WhyRunRow[]> {
    const rows = await this.sql<
      {
        project: string
        task: string
        this_hash: string
        prev_run_id: string | null
        prev_hash: string | null
      }[]
    >`
      SELECT t.project, t.task, t.hash AS this_hash, p.run_id AS prev_run_id, p.hash AS prev_hash
      FROM task_runs t
      LEFT JOIN LATERAL (
        SELECT run_id, hash FROM task_runs
        WHERE workspace_id = t.workspace_id AND project = t.project AND task = t.task
          AND started_at < t.started_at
        ORDER BY started_at DESC LIMIT 1
      ) p ON true
      WHERE t.workspace_id = ${workspaceId} AND t.run_id = ${runId}
        AND t.status IN ('success', 'failed')
      ORDER BY t.project, t.task`
    return rows.map((r) => ({
      taskId: `${r.project}#${r.task}`,
      project: r.project,
      task: r.task,
      previousRunId: r.prev_run_id,
      reason:
        r.prev_run_id === null
          ? 'first run'
          : r.prev_hash !== r.this_hash
            ? 'inputs changed'
            : 'ran without a cache hit (not cacheable / forced)',
    }))
  }

  /**
   * Batched failure triage over EVERY failed task of a run — one query, three
   * signals per task (see `TriageRow`): same-key green runs elsewhere (flaky),
   * the default branch's latest outcome for the task (pre-existing), and the
   * key-changed-vs-previous comparison (the why panel's signal). Trunk-ness
   * comes from the run's invocation header (`branch = default_branch`, both
   * non-null) via EXISTS — never a row-multiplying join, so a re-pushed run's
   * duplicate headers (the documented invocations-uniqueness wrinkle) cannot
   * skew the result.
   */
  async triageRun(workspaceId: string, runId: string): Promise<TriageRow[]> {
    const rows = await this.sql<
      {
        project: string
        task: string
        this_hash: string
        same_key_successes: number
        prev_run_id: string | null
        prev_hash: string | null
        trunk_run_id: string | null
        trunk_status: string | null
      }[]
    >`
      SELECT t.project, t.task, t.hash AS this_hash,
             (SELECT count(*)::int FROM task_runs s
               WHERE s.workspace_id = t.workspace_id AND s.project = t.project
                 AND s.task = t.task AND s.hash = t.hash AND s.run_id <> t.run_id
                 AND (s.status = 'success' OR s.status LIKE 'cache-hit%' OR s.cache_hit = true)
             ) AS same_key_successes,
             p.run_id AS prev_run_id, p.hash AS prev_hash,
             d.run_id AS trunk_run_id, d.status AS trunk_status
      FROM task_runs t
      LEFT JOIN LATERAL (
        SELECT run_id, hash FROM task_runs
        WHERE workspace_id = t.workspace_id AND project = t.project AND task = t.task
          AND started_at < t.started_at
        ORDER BY started_at DESC LIMIT 1
      ) p ON true
      LEFT JOIN LATERAL (
        SELECT r.run_id, r.status FROM task_runs r
        WHERE r.workspace_id = t.workspace_id AND r.project = t.project AND r.task = t.task
          AND r.run_id <> t.run_id
          AND EXISTS (
            SELECT 1 FROM invocations i
            WHERE i.workspace_id = r.workspace_id AND i.run_id = r.run_id
              AND i.branch IS NOT NULL AND i.default_branch IS NOT NULL
              AND i.branch = i.default_branch
          )
        ORDER BY r.started_at DESC LIMIT 1
      ) d ON true
      WHERE t.workspace_id = ${workspaceId} AND t.run_id = ${runId} AND t.status = 'failed'
      ORDER BY t.project, t.task`
    return rows.map((r) => {
      const sameKey = r.same_key_successes
      const trunkFailing = r.trunk_status === 'failed'
      return {
        taskId: `${r.project}#${r.task}`,
        project: r.project,
        task: r.task,
        verdict: sameKey > 0 ? 'flaky' : trunkFailing ? 'pre-existing' : 'new-failure',
        sameKeySuccesses: sameKey,
        defaultBranchFailing: trunkFailing,
        defaultBranchRunId: r.trunk_run_id,
        keyChanged: r.prev_hash === null ? null : r.prev_hash !== r.this_hash,
        previousRunId: r.prev_run_id,
      }
    })
  }

  async whyDidThisRerun(
    workspaceId: string,
    runId: string,
    taskId: string,
  ): Promise<WhyDidThisRerun> {
    const [project, task] = taskId.split('#', 2) as [string, string]
    const this_ = (
      await this.sql<
        { hash: string; status: string; cache_hit: boolean | null; started_at: string }[]
      >`
        SELECT hash, status, cache_hit, started_at FROM task_runs
        WHERE workspace_id = ${workspaceId} AND run_id = ${runId}
          AND project = ${project} AND task = ${task}`
    )[0]
    if (this_ === undefined) {
      return { runId, taskId, found: false, note: 'no row matching that runId + taskId' }
    }
    const prev = (
      await this.sql<
        { hash: string; status: string; cache_hit: boolean | null; started_at: string }[]
      >`
        SELECT hash, status, cache_hit, started_at FROM task_runs
        WHERE workspace_id = ${workspaceId} AND project = ${project} AND task = ${task}
          AND started_at < ${num(this_.started_at)}
        ORDER BY started_at DESC LIMIT 1`
    )[0]
    return {
      runId,
      taskId,
      found: true,
      thisRun: {
        hash: this_.hash,
        status: this_.status,
        cacheHit: this_.cache_hit,
        startedAt: num(this_.started_at),
      },
      previousRun:
        prev !== undefined
          ? {
              hash: prev.hash,
              status: prev.status,
              cacheHit: prev.cache_hit,
              startedAt: num(prev.started_at),
            }
          : null,
      hashChanged: prev !== undefined ? prev.hash !== this_.hash : null,
      note:
        prev !== undefined && prev.hash !== this_.hash
          ? 'cache key changed between the previous run and this one (inputs differ)'
          : prev !== undefined
            ? 'cache key unchanged — re-run with the same key (likely --no-cache or unrelated)'
            : 'no prior run for this (project, task)',
    }
  }

  /**
   * Resolve the two runs' task hashes and report whether the key changed. The
   * analytics schema stores no per-component input fingerprints (there is no
   * `entry_inputs`), so a changed key degrades to the "unavailable" note — the
   * exact branch core takes when an entry has been pruned.
   */
  async cacheKeyDiff(workspaceId: string, runId: string, taskId: string): Promise<CacheKeyDiff> {
    const [project, task] = taskId.split('#', 2) as [string, string]
    const this_ = (
      await this.sql<{ hash: string; started_at: string }[]>`
        SELECT hash, started_at FROM task_runs
        WHERE workspace_id = ${workspaceId} AND run_id = ${runId}
          AND project = ${project} AND task = ${task}`
    )[0]
    if (this_ === undefined) {
      return {
        runId,
        taskId,
        found: false,
        previousRunId: null,
        entries: [],
        unchangedCount: 0,
        note: 'no row matching that runId + taskId',
      }
    }
    const prev = (
      await this.sql<{ run_id: string; hash: string }[]>`
        SELECT run_id, hash FROM task_runs
        WHERE workspace_id = ${workspaceId} AND project = ${project} AND task = ${task}
          AND started_at < ${num(this_.started_at)}
        ORDER BY started_at DESC LIMIT 1`
    )[0]
    if (prev === undefined) {
      return {
        runId,
        taskId,
        found: true,
        previousRunId: null,
        entries: [],
        unchangedCount: 0,
        note: 'no prior run for this (project, task) — nothing to diff',
      }
    }
    if (prev.hash === this_.hash) {
      return {
        runId,
        taskId,
        found: true,
        previousRunId: prev.run_id,
        entries: [],
        unchangedCount: 0,
        note: 'cache key unchanged between the previous run and this one (same inputs)',
      }
    }
    return {
      runId,
      taskId,
      found: true,
      previousRunId: prev.run_id,
      entries: [],
      unchangedCount: 0,
      note: 'cache key changed but input fingerprints are unavailable (entry pruned); only the hash change is known',
    }
  }

  async compareRuns(workspaceId: string, runId: string): Promise<CompareRuns> {
    const empty: CompareRuns = {
      runId,
      previousRunId: null,
      startedAt: null,
      prevStartedAt: null,
      found: false,
      summary: {
        aTotalMs: 0,
        bTotalMs: 0,
        totalDeltaMs: 0,
        tasksChanged: 0,
        tasksOnlyInA: 0,
        tasksOnlyInB: 0,
      },
      tasks: [],
      note: 'no run matching that runId',
    }
    const aRun = await this.getRun(workspaceId, runId)
    if (aRun === null) return empty
    // The immediately-previous run: a single-row index seek on the
    // `invocations` header table (one row per run, `(workspace_id, started_at
    // DESC)` indexed) instead of a full-history `GROUP BY run_id` over every
    // prior task_run. The reference point is the current run's OWN invocation
    // start, so both sides compare in the same time frame.
    const prev = (
      await this.sql<{ run_id: string }[]>`
        SELECT run_id FROM invocations
        WHERE workspace_id = ${workspaceId} AND run_id != ${runId}
          AND started_at < (
            -- MIN(): invocations' uniqueness is (started_at, run_id), so a
            -- re-pushed summary yields >1 header for one run. A bare
            -- single-value scalar subquery then raises a cardinality error
            -- (500); MIN collapses it to the earliest header (the
            -- LATERAL-pick-one convention used across this file).
            SELECT MIN(started_at) FROM invocations
            WHERE workspace_id = ${workspaceId} AND run_id = ${runId})
        ORDER BY started_at DESC LIMIT 1`
    )[0]
    const bRun = prev !== undefined ? await this.getRun(workspaceId, prev.run_id) : null

    const byKeyA = new Map(aRun.tasks.map((t) => [`${t.project}#${t.task}`, t]))
    const byKeyB = new Map((bRun?.tasks ?? []).map((t) => [`${t.project}#${t.task}`, t]))
    const keys = [...new Set([...byKeyA.keys(), ...byKeyB.keys()])].sort()

    let aTotalMs = 0
    let bTotalMs = 0
    let tasksChanged = 0
    let tasksOnlyInA = 0
    let tasksOnlyInB = 0
    const sideOf = (row: RunSummaryRow): CompareTaskSide => ({
      status: row.status,
      durationMs: row.durationMs,
      hash: row.hash,
      cacheHit: row.cacheHit,
      exitCode: row.exitCode,
    })
    const tasks: CompareTaskRow[] = keys.map((key) => {
      const ra = byKeyA.get(key)
      const rb = byKeyB.get(key)
      const a = ra ? sideOf(ra) : null
      const b = rb ? sideOf(rb) : null
      if (a) aTotalMs += a.durationMs
      if (b) bTotalMs += b.durationMs
      const hashChanged = a !== null && b !== null ? a.hash !== b.hash : true
      const statusChanged = a !== null && b !== null ? a.status !== b.status : true
      const durationDeltaMs = a !== null && b !== null ? a.durationMs - b.durationMs : null
      if (!b) tasksOnlyInA++
      if (!a) tasksOnlyInB++
      if (hashChanged || statusChanged) tasksChanged++
      const [project, task] = key.split('#', 2) as [string, string]
      return { taskId: key, project, task, a, b, hashChanged, durationDeltaMs, statusChanged }
    })
    return {
      runId,
      previousRunId: prev?.run_id ?? null,
      startedAt: aRun.startedAt,
      // bRun.startedAt is MIN(task started_at) for the previous run — the same
      // value the old `MIN(started_at)` select returned.
      prevStartedAt: bRun !== null ? bRun.startedAt : null,
      found: prev !== undefined,
      summary: {
        aTotalMs,
        bTotalMs,
        totalDeltaMs: aTotalMs - bTotalMs,
        tasksChanged,
        tasksOnlyInA,
        tasksOnlyInB,
      },
      tasks,
      note:
        prev !== undefined
          ? 'compared against the immediately-previous invocation'
          : 'no previous invocation to compare against',
    }
  }

  async listProjects(workspaceId: string, limit = 100): Promise<ProjectRollup[]> {
    const rows = await this.sql<
      {
        project: string
        task_count: number
        runs: number
        failures: number
        hits: number
        total_duration_ms: number | null
        avg_duration_ms: number | null
        last_run_at: string | null
      }[]
    >`
      SELECT project,
             count(DISTINCT task)::int AS task_count,
             count(*)::int AS runs,
             SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)::int AS failures,
             SUM(CASE WHEN cache_hit = true OR status LIKE 'cache-hit%' THEN 1 ELSE 0 END)::int AS hits,
             SUM(duration_ms)::float8 AS total_duration_ms,
             trunc(avg(duration_ms))::int AS avg_duration_ms,
             MAX(ended_at) AS last_run_at
      FROM task_runs WHERE workspace_id = ${workspaceId}
      GROUP BY project ORDER BY SUM(duration_ms) DESC LIMIT ${clampInt(limit, 1, 500)}`
    // Estimated time saved per project, computed for ALL projects in ONE
    // set-based query instead of a correlated subquery per project (the old
    // N+1). Output-identical: for each project it sums, over its cache-hit
    // rows, the avg uncached-success duration of that (project, task) — which
    // equals SUM(hit_count × avg_uncached) over tasks that have an uncached
    // baseline (the inner join drops tasks without one, matching the old
    // `WHERE avg_dur IS NOT NULL`).
    const savedByProject = new Map<string, number>()
    const savedRows = await this.sql<{ project: string; saved: number }[]>`
      WITH uncached AS (
        SELECT project, task, trunc(avg(duration_ms))::int AS avg_dur
        FROM task_runs
        WHERE workspace_id = ${workspaceId}
          AND (cache_hit IS NULL OR cache_hit = false) AND status = 'success'
        GROUP BY project, task
      ),
      hits AS (
        SELECT project, task, count(*)::int AS hit_count
        FROM task_runs
        WHERE workspace_id = ${workspaceId}
          AND (cache_hit = true OR status LIKE 'cache-hit%')
        GROUP BY project, task
      )
      SELECT h.project AS project, COALESCE(SUM(h.hit_count * u.avg_dur), 0)::float8 AS saved
      FROM hits h JOIN uncached u ON u.project = h.project AND u.task = h.task
      GROUP BY h.project`
    for (const s of savedRows) savedByProject.set(s.project, s.saved)
    return rows.map((r) => ({
      project: r.project,
      taskCount: r.task_count,
      runs: r.runs,
      failures: r.failures,
      hits: r.hits,
      hitRate: r.runs > 0 ? r.hits / r.runs : 0,
      totalDurationMs: r.total_duration_ms ?? 0,
      avgDurationMs: r.avg_duration_ms ?? 0,
      cacheBytes: 0,
      cacheEntries: 0,
      lastRunAt: numOrNull(r.last_run_at) ?? undefined,
      estimatedTimeSavedMs: savedByProject.get(r.project) ?? 0,
    }))
  }

  async getRunTrends(
    workspaceId: string,
    args: { bucket?: TrendBucket; from?: number; to?: number; project?: string } = {},
  ): Promise<TrendPoint[]> {
    const bucket: TrendBucket = args.bucket ?? 'hour'
    const bucketMs = bucket === 'hour' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000
    // Optional project scope (the project analytics view's failures-over-time
    // series) — byte-identical when absent.
    const fProject =
      args.project !== undefined ? this.sql`AND project = ${args.project}` : this.sql``
    // Clamp the window before it reaches the fill loop below: `to` no later
    // than now, and `from` no earlier than MAX_TREND_BUCKETS buckets back —
    // so a hostile `?from=0&to=1e15` can't drive the synchronous loop into a
    // hundreds-of-millions-iteration server freeze (bounds the loop, the array
    // allocation, AND the SQL range). Legitimate ranges (24h hourly / 30d
    // daily) are far under the cap, so results are unchanged.
    const now = Date.now()
    const to = Math.min(args.to ?? now, now)
    const defaultRangeMs = bucket === 'hour' ? 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000
    const minFrom = to - (MAX_TREND_BUCKETS - 1) * bucketMs
    const from = Math.max(args.from ?? to - defaultRangeMs, minFrom)
    const rows = await this.sql<
      {
        t: string
        runs: number
        hits: number
        hits_local: number
        hits_remote: number
        failures: number
        total_duration_ms: number
      }[]
    >`
      SELECT (started_at / ${bucketMs}::bigint) * ${bucketMs}::bigint AS t,
             count(*)::int AS runs,
             SUM(CASE WHEN cache_hit = true OR status LIKE 'cache-hit%' THEN 1 ELSE 0 END)::int AS hits,
             SUM(CASE WHEN status = 'cache-hit' THEN 1 ELSE 0 END)::int AS hits_local,
             SUM(CASE WHEN status = 'cache-hit-remote' THEN 1 ELSE 0 END)::int AS hits_remote,
             SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)::int AS failures,
             SUM(duration_ms)::float8 AS total_duration_ms
      FROM task_runs
      WHERE workspace_id = ${workspaceId} AND started_at >= ${from} AND started_at <= ${to} ${fProject}
      GROUP BY t ORDER BY t ASC`
    const byT = new Map(rows.map((r) => [num(r.t), r]))
    const start = Math.floor(from / bucketMs) * bucketMs
    const end = Math.floor(to / bucketMs) * bucketMs
    const out: TrendPoint[] = []
    for (let t = start; t <= end; t += bucketMs) {
      const r = byT.get(t)
      out.push(
        r !== undefined
          ? {
              t,
              runs: r.runs,
              hits: r.hits,
              hitsLocal: r.hits_local,
              hitsRemote: r.hits_remote,
              failures: r.failures,
              totalDurationMs: r.total_duration_ms,
            }
          : { t, runs: 0, hits: 0, hitsLocal: 0, hitsRemote: 0, failures: 0, totalDurationMs: 0 },
      )
    }
    return out
  }

  async getRunHeatmap(workspaceId: string, days = 30): Promise<HeatmapCell[]> {
    // Clamp the span so a hostile `?days=1e9` can't turn the bounded fetch into
    // a full scan of every partition.
    const since = Date.now() - clampInt(days, 1, MAX_WINDOW_DAYS) * 24 * 60 * 60 * 1000
    // Bucket in SQL (≤168 rows out) instead of streaming every row into JS — at
    // the platform's target scale (50-100M task_runs/day) the raw fetch would be
    // tens of millions of rows over the wire. Bucketed in UTC: Postgres
    // EXTRACT(DOW) is Sun=0..Sat=6 (identical to JS getUTCDay), and integer
    // `started_at / 1000` drops the sub-second remainder, which can never cross
    // an hour boundary — so the grid is byte-identical to the former JS pass.
    const rows = await this.sql<{ dow: number; hour: number; runs: number; total: number }[]>`
      SELECT EXTRACT(DOW  FROM to_timestamp(started_at / 1000) AT TIME ZONE 'UTC')::int AS dow,
             EXTRACT(HOUR FROM to_timestamp(started_at / 1000) AT TIME ZONE 'UTC')::int AS hour,
             count(*)::int AS runs,
             COALESCE(SUM(duration_ms), 0)::float8 AS total
      FROM task_runs
      WHERE workspace_id = ${workspaceId} AND started_at >= ${since}
      GROUP BY dow, hour`
    const grid: HeatmapCell[] = []
    for (let d = 0; d < 7; d++)
      for (let h = 0; h < 24; h++)
        grid.push({ dayOfWeek: d, hourOfDay: h, runs: 0, totalDurationMs: 0 })
    for (const r of rows) {
      const cell = grid[r.dow * 24 + r.hour]!
      cell.runs = r.runs
      cell.totalDurationMs = r.total
    }
    return grid
  }

  /**
   * Per-(project, task) count of cache keys that produced BOTH a failure and
   * a success — the batched cross-run nondeterminism signal (see
   * `FlakyTask.mixedOutcomeKeys`). One grouped scan for every pair at once,
   * keyed by `pairKey`.
   */
  private async mixedOutcomeKeyCounts(
    workspaceId: string,
    args: { project?: string; task?: string } = {},
  ): Promise<Map<string, number>> {
    const sql = this.sql
    const fProject = args.project !== undefined ? sql`AND project = ${args.project}` : sql``
    const fTask = args.task !== undefined ? sql`AND task = ${args.task}` : sql``
    const rows = await sql<{ project: string; task: string; mixed: number }[]>`
      SELECT project, task, count(*)::int AS mixed FROM (
        SELECT project, task, hash FROM task_runs
        WHERE workspace_id = ${workspaceId} ${fProject} ${fTask}
          AND hash IS NOT NULL AND hash != ''
        GROUP BY project, task, hash
        HAVING SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) > 0
           AND SUM(CASE WHEN status = 'success' OR status LIKE 'cache-hit%' OR cache_hit = true
                   THEN 1 ELSE 0 END) > 0
      ) m GROUP BY project, task`
    return new Map(rows.map((r) => [pairKey(r.project, r.task), r.mixed]))
  }

  async getFlakiestTasks(workspaceId: string, limit = 25): Promise<FlakyTask[]> {
    const pairs = await this.sql<
      {
        project: string
        task: string
        runs: number
        failures: number
        within_run_retries: number
        max_attempts: number | null
      }[]
    >`
      SELECT project, task, count(*)::int AS runs,
             SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)::int AS failures,
             SUM(CASE WHEN attempts > 1 THEN 1 ELSE 0 END)::int AS within_run_retries,
             MAX(attempts)::int AS max_attempts
      FROM task_runs WHERE workspace_id = ${workspaceId}
      GROUP BY project, task
      HAVING count(*) >= 3 OR SUM(CASE WHEN attempts > 1 THEN 1 ELSE 0 END) > 0`
    if (pairs.length === 0) return []
    // ONE windowed durations query for ALL candidates (the last-50 successful
    // non-hit rows per pair — the same set `successDurations` fetched),
    // replacing the former per-candidate round-trip.
    const durRows = await this.sql<{ project: string; task: string; duration_ms: number }[]>`
      SELECT project, task, duration_ms FROM (
        SELECT project, task, duration_ms,
               ROW_NUMBER() OVER (PARTITION BY project, task ORDER BY started_at DESC) AS rn
        FROM task_runs
        WHERE workspace_id = ${workspaceId}
          AND (cache_hit IS NULL OR cache_hit = false) AND status = 'success'
      ) t WHERE rn <= 50`
    const dursByKey = durationsByPair(durRows)
    const mixedByKey = await this.mixedOutcomeKeyCounts(workspaceId)
    const out: FlakyTask[] = pairs.map((p) => {
      const sorted = dursByKey.get(pairKey(p.project, p.task)) ?? []
      const p50 = pickPercentile(sorted, 0.5)
      const p99 = pickPercentile(sorted, 0.99)
      const ratio = p50 !== undefined && p50 > 0 && p99 !== undefined ? p99 / p50 : undefined
      return {
        id: `${p.project}#${p.task}`,
        project: p.project,
        task: p.task,
        runs: p.runs,
        failures: p.failures,
        failureRate: p.runs > 0 ? p.failures / p.runs : 0,
        withinRunRetries: p.within_run_retries,
        maxAttempts: p.max_attempts ?? undefined,
        flakyConfirmed: p.within_run_retries > 0,
        mixedOutcomeKeys: mixedByKey.get(pairKey(p.project, p.task)) ?? 0,
        durationTailRatio: ratio,
        p50DurationMs: p50,
        p99DurationMs: p99,
      }
    })
    return out
      .filter(
        (r) =>
          r.flakyConfirmed ||
          r.mixedOutcomeKeys > 0 ||
          (r.durationTailRatio !== undefined && r.durationTailRatio > 2),
      )
      .sort((a, b) => {
        // Confirmed (within-run retry) outranks same-key inferred, which
        // outranks wide-tail-only; failure rate then tail break ties.
        const score = (r: FlakyTask): number =>
          (r.flakyConfirmed ? 100 : 0) +
          (r.mixedOutcomeKeys > 0 ? 50 : 0) +
          r.failureRate * 10 +
          (r.durationTailRatio ?? 1)
        return score(b) - score(a)
      })
      .slice(0, clampInt(limit, 1, 200))
  }

  async getRegressions(workspaceId: string, args: RegressionArgs = {}): Promise<RegressedTask[]> {
    // Clamp the window (MAX_WINDOW_DAYS): an unclamped hostile `sinceDays=1e15`
    // makes `since` hugely negative → the per-row LATERAL invocations join + the
    // GROUP BY degenerate to a full scan of every task_runs partition on the
    // single-threaded, multi-tenant server (the 2026-07-14 degenerate-scan
    // class, applied here + getBottlenecks).
    const sinceDays = clampInt(args.sinceDays ?? 7, 1, MAX_WINDOW_DAYS)
    const minBranches = Math.max(1, args.minBranches ?? 2)
    const limit = clampInt(args.limit ?? 25, 1, 200)
    const since = Date.now() - sinceDays * 86_400_000

    const latest = await this.sql<
      { project: string; task: string; branch: string; status: string }[]
    >`
      WITH windowed AS (
        SELECT r.project AS project, r.task AS task, inv.branch AS branch, r.status AS status,
               ROW_NUMBER() OVER (
                 PARTITION BY r.project, r.task, inv.branch
                 ORDER BY r.started_at DESC, r.run_id DESC
               ) AS rn
        -- LATERAL pick-one (the getProjectBranchFailures fix): invocations'
        -- uniqueness is (started_at, run_id), so a re-pushed summary with a
        -- changed startedAt yields TWO headers for one run — a plain join
        -- lands the same task_run in two branch partitions, falsely crossing
        -- the minBranches bar. Keep the earliest header per run.
        FROM task_runs r
        JOIN LATERAL (
          SELECT i.branch FROM invocations i
          WHERE i.run_id = r.run_id AND i.workspace_id = ${workspaceId}
          ORDER BY i.started_at ASC LIMIT 1
        ) inv ON true
        WHERE r.workspace_id = ${workspaceId} AND inv.branch IS NOT NULL
          AND r.started_at >= ${since}
          AND r.status IN ('success', 'failed', 'cache-hit', 'cache-hit-remote')
      )
      SELECT project, task, branch, status FROM windowed WHERE rn = 1`

    const byTask = new Map<
      string,
      { project: string; task: string; failing: string[]; total: Set<string> }
    >()
    for (const r of latest) {
      const id = `${r.project}#${r.task}`
      let agg = byTask.get(id)
      if (agg === undefined) {
        agg = { project: r.project, task: r.task, failing: [], total: new Set() }
        byTask.set(id, agg)
      }
      agg.total.add(r.branch)
      if (r.status === 'failed') agg.failing.push(r.branch)
    }

    // Batched, replacing the per-candidate `win` + `everPassed` fan-out (the
    // old 1+2K queries). Windowed stats for EVERY (project, task) in the range
    // in one GROUP BY; ever-passed as one DISTINCT set over full history. A
    // candidate always appears in `latest` (started_at >= since), so it always
    // has a windowed row — the `?? …` default is defensive only.
    const winRows = await this.sql<
      {
        project: string
        task: string
        runs: number
        failures: number | null
        first_failed: string | null
        last_run: string | null
      }[]
    >`
      SELECT project, task, count(*)::int AS runs,
             SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)::int AS failures,
             MIN(CASE WHEN status = 'failed' THEN started_at END) AS first_failed,
             MAX(started_at) AS last_run
      FROM task_runs WHERE workspace_id = ${workspaceId} AND started_at >= ${since}
      GROUP BY project, task`
    const winByTask = new Map(winRows.map((w) => [`${w.project}#${w.task}`, w]))
    const passedRows = await this.sql<{ project: string; task: string }[]>`
      SELECT DISTINCT project, task FROM task_runs
      WHERE workspace_id = ${workspaceId}
        AND status IN ${this.sql(PASS_STATUSES as unknown as string[])}`
    const passedSet = new Set(passedRows.map((p) => `${p.project}#${p.task}`))

    const out: RegressedTask[] = []
    for (const [id, agg] of byTask) {
      if (agg.failing.length < minBranches) continue
      const win = winByTask.get(id) ?? {
        runs: 0,
        failures: 0,
        first_failed: null as string | null,
        last_run: null as string | null,
      }
      const everPassed = passedSet.has(id)
      out.push({
        id,
        project: agg.project,
        task: agg.task,
        branchesFailing: agg.failing.length,
        branchesTotal: agg.total.size,
        branches: agg.failing.sort().slice(0, BRANCH_CAP),
        regressed: everPassed,
        firstFailedAt: numOrNull(win.first_failed) ?? 0,
        lastRunAt: numOrNull(win.last_run) ?? 0,
        failures: win.failures ?? 0,
        runs: win.runs,
      })
    }
    return out
      .sort(
        (a, b) =>
          Number(b.regressed) - Number(a.regressed) ||
          b.branchesFailing - a.branchesFailing ||
          b.firstFailedAt - a.firstFailedAt,
      )
      .slice(0, limit)
  }

  /**
   * "Where was the issue first noticed" for one project: per failing task, the
   * branch that failed FIRST (rank 1) + the per-branch first-failure breakdown.
   * ONE set-based query — earliest failing run per (task, branch), then a
   * `ROW_NUMBER` rank so `branch_rank = 1` is the first branch to fail.
   * Workspace-clamped, project-scoped, `started_at`-partition-pruned, reads only
   * `status='failed'` rows; no N+1.
   */
  async getProjectBranchFailures(
    workspaceId: string,
    project: string,
    args: { sinceDays?: number; limit?: number } = {},
  ): Promise<ProjectBranchFailure[]> {
    const since = Date.now() - clampInt(args.sinceDays ?? 14, 1, MAX_WINDOW_DAYS) * 86_400_000
    const limit = clampInt(args.limit ?? 25, 1, 200)
    const rows = await this.sql<
      {
        task: string
        branch: string
        first_failed_at: string
        first_commit: string | null
        last_failed_at: string
        failures: number
        branch_rank: string
      }[]
    >`
      WITH failed AS (
        SELECT r.task AS task, inv.branch AS branch,
               MIN(r.started_at)::bigint AS first_failed_at,
               (ARRAY_AGG(inv.commit_sha ORDER BY r.started_at ASC))[1] AS first_commit,
               MAX(r.started_at)::bigint AS last_failed_at,
               COUNT(*)::int AS failures
        FROM task_runs r
        -- LATERAL pick-one: invocations' uniqueness is (started_at, run_id),
        -- so a re-pushed summary with a changed startedAt yields TWO header
        -- rows for one run — a plain join would attribute a single failure to
        -- multiple branches. Keep the earliest header (the original push);
        -- indexed per failed row via invocations(run_id).
        JOIN LATERAL (
          SELECT i.branch, i.commit_sha FROM invocations i
          WHERE i.run_id = r.run_id AND i.workspace_id = ${workspaceId}
          ORDER BY i.started_at ASC LIMIT 1
        ) inv ON true
        WHERE r.workspace_id = ${workspaceId} AND r.project = ${project}
          AND r.started_at >= ${since} AND r.status = 'failed'
          AND inv.branch IS NOT NULL
        GROUP BY r.task, inv.branch
      )
      SELECT task, branch, first_failed_at, first_commit, last_failed_at, failures,
             ROW_NUMBER() OVER (PARTITION BY task ORDER BY first_failed_at ASC, branch ASC) AS branch_rank
      FROM failed
      ORDER BY task, first_failed_at ASC`

    const byTask = new Map<string, ProjectBranchFailure>()
    for (const r of rows) {
      let agg = byTask.get(r.task)
      if (agg === undefined) {
        agg = {
          task: r.task,
          firstBranch: '',
          firstFailedAt: 0,
          firstCommit: null,
          lastFailedAt: 0,
          branchesFailing: 0,
          branches: [],
        }
        byTask.set(r.task, agg)
      }
      agg.branchesFailing++ // true count, even if `branches` is capped below
      if (Number(r.branch_rank) === 1) {
        agg.firstBranch = r.branch
        agg.firstFailedAt = num(r.first_failed_at)
        agg.firstCommit = r.first_commit
      }
      const lf = num(r.last_failed_at)
      if (lf > agg.lastFailedAt) agg.lastFailedAt = lf
      if (agg.branches.length < BRANCH_CAP) {
        agg.branches.push({
          branch: r.branch,
          firstFailedAt: num(r.first_failed_at),
          firstCommit: r.first_commit,
          failures: r.failures,
        })
      }
    }
    // Most-recent first-failures on top (a fresh regression is the news).
    return [...byTask.values()].sort((a, b) => b.firstFailedAt - a.firstFailedAt).slice(0, limit)
  }

  /**
   * Per-task, per-bucket time-series for the project view's task sparklines
   * ("spot per-task outliers/spikes/trends"). Flat long-format rows: one per
   * (task, bucket). The task set is bounded by a `top` CTE (highest total
   * duration in the window, ≤50) so a project with many tasks can't fan out
   * unbounded; the client groups by task into a bucket-filled series.
   *
   * Percentiles/averages aggregate IN SQL (`percentile_cont` + filtered `avg`)
   * over the same non-hit executed-success subset the other duration surfaces
   * use — no raw-row stream. Workspace-clamped, project-scoped,
   * `started_at`-partition-pruned; the span is clamped to `MAX_TREND_BUCKETS`
   * like `getRunTrends`, so a hostile range can't drive an unbounded scan.
   */
  async getProjectTaskTrends(
    workspaceId: string,
    project: string,
    args: { bucket?: TrendBucket; from?: number; to?: number; limit?: number } = {},
  ): Promise<ProjectTaskTrendPoint[]> {
    const bucket: TrendBucket = args.bucket ?? 'day'
    const bucketMs = bucket === 'hour' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000
    const now = Date.now()
    const to = Math.min(args.to ?? now, now)
    const defaultRangeMs = bucket === 'hour' ? 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000
    const minFrom = to - (MAX_TREND_BUCKETS - 1) * bucketMs
    const from = Math.max(args.from ?? to - defaultRangeMs, minFrom)
    const limit = clampInt(args.limit ?? 12, 1, 50)
    const rows = await this.sql<
      {
        task: string
        t: string
        runs: number
        failures: number
        avg_dur: number
        p95: number | null
      }[]
    >`
      WITH top AS (
        SELECT task FROM task_runs
        WHERE workspace_id = ${workspaceId} AND project = ${project}
          AND started_at >= ${from} AND started_at <= ${to}
        GROUP BY task
        -- Rank by the SAME population the series displays (executed
        -- successes) — ranking over ALL rows lets a cache-hit-dominated task
        -- crowd out a genuinely slow executed task with an all-zero series.
        ORDER BY SUM(duration_ms) FILTER (
          WHERE (cache_hit IS NULL OR cache_hit = false) AND status = 'success'
        ) DESC NULLS LAST
        LIMIT ${limit}
      )
      SELECT r.task AS task,
             (r.started_at / ${bucketMs}::bigint) * ${bucketMs}::bigint AS t,
             count(*)::int AS runs,
             SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END)::int AS failures,
             COALESCE(round(avg(r.duration_ms) FILTER (
               WHERE (r.cache_hit IS NULL OR r.cache_hit = false) AND r.status = 'success')), 0)::int AS avg_dur,
             round(percentile_cont(0.95) WITHIN GROUP (ORDER BY r.duration_ms) FILTER (
               WHERE (r.cache_hit IS NULL OR r.cache_hit = false) AND r.status = 'success'))::int AS p95
      FROM task_runs r JOIN top USING (task)
      WHERE r.workspace_id = ${workspaceId} AND r.project = ${project}
        AND r.started_at >= ${from} AND r.started_at <= ${to}
      GROUP BY r.task, t ORDER BY r.task, t`
    return rows.map((r) => ({
      task: r.task,
      t: num(r.t),
      runs: r.runs,
      failures: r.failures,
      avgDurationMs: r.avg_dur,
      p95DurationMs: r.p95 ?? 0,
    }))
  }

  async getPeriodComparison(
    workspaceId: string,
    args: PeriodComparisonArgs = {},
  ): Promise<PeriodComparison> {
    // Clamp the window so a hostile `?window=1e9` can't push `prevFrom` far
    // enough negative to make `avgByTask` scan every partition.
    const windowDays = clampInt(args.windowDays ?? 7, 1, MAX_WINDOW_DAYS)
    const minRuns = Math.max(1, args.minRuns ?? 3)
    // 500 matches the project view's task-table bound — its Δavg column joins
    // movers by task, so a lower clamp silently zeroes the tail's deltas. The
    // movers set is already aggregated in SQL; the clamp only bounds the
    // sorted slice returned.
    const limit = clampInt(args.limit ?? 8, 1, 500)
    const scope: { project?: string; task?: string } = {}
    if (args.project !== undefined) scope.project = args.project
    if (args.task !== undefined) scope.task = args.task
    const to = args.endMs ?? Date.now()
    const win = windowDays * 86_400_000
    const curFrom = to - win
    const prevTo = curFrom
    const prevFrom = curFrom - win

    const cur = await this.avgByTask(workspaceId, curFrom, to, scope)
    const prev = await this.avgByTask(workspaceId, prevFrom, prevTo, scope)
    const movers: TaskMover[] = []
    for (const [id, c] of cur) {
      const p = prev.get(id)
      if (p === undefined || c.runs < minRuns || p.runs < minRuns) continue
      movers.push({
        id,
        project: c.project,
        task: c.task,
        currentAvgMs: Math.round(c.avg),
        previousAvgMs: Math.round(p.avg),
        deltaMs: Math.round(c.avg - p.avg),
        deltaPct: p.avg > 0 ? (c.avg - p.avg) / p.avg : 0,
        currentRuns: c.runs,
        previousRuns: p.runs,
      })
    }
    movers.sort((a, b) => Math.abs(b.deltaMs) - Math.abs(a.deltaMs))
    return {
      windowDays,
      current: {
        from: curFrom,
        to,
        stats: await this.periodStats(workspaceId, curFrom, to, scope),
      },
      previous: {
        from: prevFrom,
        to: prevTo,
        stats: await this.periodStats(workspaceId, prevFrom, prevTo, scope),
      },
      movers: movers.slice(0, limit),
    }
  }

  private async periodStats(
    workspaceId: string,
    from: number,
    to: number,
    scope: { project?: string; task?: string },
  ): Promise<PeriodStats> {
    const sql = this.sql
    const fProject = scope.project !== undefined ? sql`AND project = ${scope.project}` : sql``
    const fTask = scope.task !== undefined ? sql`AND task = ${scope.task}` : sql``
    // avg + p50 + p95 are computed IN SQL over the executed-success subset (a
    // FILTER), so we never stream every duration into JS — at the platform's
    // target scale the window can hold tens of millions of rows. percentile_cont
    // is exact over the full window and returns NULL for an empty filtered set
    // (→ undefined, unchanged). The executed-success FILTER matches the former
    // `durs` query exactly (non-hit AND status='success'); `total_duration_ms`
    // stays the executed-incl-failed sum. COALESCE every plain SUM — over an
    // empty window SUM() is NULL, and the previous window is empty for any
    // workspace younger than it.
    const agg = (
      await sql<
        {
          task_runs: number
          runs: number
          failures: number
          cache_hits: number
          executed: number
          total_duration_ms: number
          avg_dur: number
          p50: number | null
          p95: number | null
        }[]
      >`
        SELECT count(*)::int AS task_runs,
               count(DISTINCT run_id)::int AS runs,
               COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0)::int AS failures,
               COALESCE(SUM(CASE WHEN cache_hit = true THEN 1 ELSE 0 END), 0)::int AS cache_hits,
               COALESCE(SUM(CASE WHEN cache_hit IS NULL OR cache_hit = false THEN 1 ELSE 0 END), 0)::int AS executed,
               COALESCE(SUM(CASE WHEN cache_hit IS NULL OR cache_hit = false THEN duration_ms ELSE 0 END), 0)::float8 AS total_duration_ms,
               COALESCE(round(avg(duration_ms) FILTER (
                 WHERE (cache_hit IS NULL OR cache_hit = false) AND status = 'success')), 0)::int AS avg_dur,
               round(percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (
                 WHERE (cache_hit IS NULL OR cache_hit = false) AND status = 'success'))::int AS p50,
               round(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (
                 WHERE (cache_hit IS NULL OR cache_hit = false) AND status = 'success'))::int AS p95
        FROM task_runs WHERE workspace_id = ${workspaceId}
          AND started_at >= ${from} AND started_at < ${to} ${fProject} ${fTask}`
    )[0]!
    const taskRuns = agg.task_runs
    return {
      runs: agg.runs,
      taskRuns,
      executed: agg.executed,
      failures: agg.failures,
      cacheHits: agg.cache_hits,
      totalDurationMs: agg.total_duration_ms,
      avgDurationMs: agg.avg_dur,
      p50DurationMs: agg.p50 ?? undefined,
      p95DurationMs: agg.p95 ?? undefined,
      failureRate: taskRuns > 0 ? agg.failures / taskRuns : 0,
      cacheHitRate: taskRuns > 0 ? agg.cache_hits / taskRuns : 0,
    }
  }

  private async avgByTask(
    workspaceId: string,
    from: number,
    to: number,
    scope: { project?: string; task?: string },
  ): Promise<Map<string, { avg: number; runs: number; project: string; task: string }>> {
    const sql = this.sql
    const fProject = scope.project !== undefined ? sql`AND project = ${scope.project}` : sql``
    const fTask = scope.task !== undefined ? sql`AND task = ${scope.task}` : sql``
    const rows = await sql<{ project: string; task: string; avg: number; runs: number }[]>`
      SELECT project, task, avg(duration_ms)::float8 AS avg, count(*)::int AS runs
      FROM task_runs WHERE workspace_id = ${workspaceId}
        AND started_at >= ${from} AND started_at < ${to}
        AND (cache_hit IS NULL OR cache_hit = false) AND status = 'success' ${fProject} ${fTask}
      GROUP BY project, task`
    return new Map(
      rows.map((r) => [
        `${r.project}#${r.task}`,
        { avg: r.avg, runs: r.runs, project: r.project, task: r.task },
      ]),
    )
  }

  async getBottlenecks(
    workspaceId: string,
    lookbackDays = 14,
    limit = 15,
  ): Promise<BottleneckRow[]> {
    // Clamp (MAX_WINDOW_DAYS): a hostile `?days=1e15` → hugely negative `since`
    // → `started_at >= since` matches every row → full scan of every task_runs
    // partition. Same degenerate-window class as getRegressions. The default
    // (14) and any legitimate dashboard window are far under the cap.
    lookbackDays = clampInt(lookbackDays, 1, MAX_WINDOW_DAYS)
    const since = Date.now() - lookbackDays * 24 * 60 * 60 * 1000
    const rows = await this.sql<
      {
        project: string
        task: string
        runs_recent: number
        total_duration_ms: number
        avg_duration_ms: number
      }[]
    >`
      SELECT project, task, count(*)::int AS runs_recent,
             SUM(duration_ms)::float8 AS total_duration_ms,
             trunc(avg(duration_ms))::int AS avg_duration_ms
      FROM task_runs WHERE workspace_id = ${workspaceId} AND started_at >= ${since}
        AND (cache_hit IS NULL OR cache_hit = false) AND status = 'success'
      GROUP BY project, task ORDER BY SUM(duration_ms) DESC LIMIT ${clampInt(limit, 1, 100)}`
    return rows.map((r) => {
      const runsPerDay = r.runs_recent / Math.max(1, lookbackDays)
      return {
        id: `${r.project}#${r.task}`,
        project: r.project,
        task: r.task,
        runsRecent: r.runs_recent,
        totalDurationMs: r.total_duration_ms,
        avgDurationMs: r.avg_duration_ms,
        runsPerDay,
        weeklySavingsAt25PctCutMs: Math.round(runsPerDay * 7 * r.avg_duration_ms * 0.25),
      }
    })
  }

  async getParallelismHistory(workspaceId: string, limit = 50): Promise<ParallelismPoint[]> {
    const rows = await this.sql<
      {
        run_id: string
        started_at: string
        min_start: string
        max_end: string
        cpu_sum_ms: number | null
        task_count: number
      }[]
    >`
      SELECT run_id, MIN(started_at) AS started_at, MIN(started_at) AS min_start,
             MAX(ended_at) AS max_end,
             SUM(COALESCE(cpu_ms, duration_ms))::float8 AS cpu_sum_ms,
             count(*)::int AS task_count
      FROM task_runs WHERE workspace_id = ${workspaceId} AND run_id IS NOT NULL
      GROUP BY run_id
      HAVING count(*) > 1 AND (MAX(ended_at) - MIN(started_at)) >= 50
      ORDER BY MAX(started_at) DESC LIMIT ${clampInt(limit, 1, 500)}`
    return rows.map((r) => {
      const wallMs = Math.max(1, num(r.max_end) - num(r.min_start))
      const cpuSumMs = r.cpu_sum_ms ?? 0
      return {
        runId: r.run_id,
        startedAt: num(r.started_at),
        cpuSumMs,
        wallMs,
        factor: cpuSumMs / wallMs,
        taskCount: r.task_count,
      }
    })
  }

  // -------------------------------------------------------------------------
  // Task logs
  // -------------------------------------------------------------------------

  async logFor(
    workspaceId: string,
    runId: string,
    taskId: string,
  ): Promise<StoredTaskLog | undefined> {
    const rows = await this.sql<RawLogRow[]>`
      SELECT run_id, task_id, hash, status, codec, content, chars_full, truncated_head
      FROM task_logs
      WHERE workspace_id = ${workspaceId} AND run_id = ${runId} AND task_id = ${taskId}`
    return rows[0] ? decodeLog(rows[0]) : undefined
  }

  async logByHash(workspaceId: string, hash: string): Promise<StoredTaskLog | undefined> {
    const rows = await this.sql<RawLogRow[]>`
      SELECT run_id, task_id, hash, status, codec, content, chars_full, truncated_head
      FROM task_logs WHERE workspace_id = ${workspaceId} AND hash = ${hash}
      ORDER BY created_at DESC LIMIT 1`
    return rows[0] ? decodeLog(rows[0]) : undefined
  }

  // -------------------------------------------------------------------------
  // Hermeticity (cross-machine fingerprint divergence)
  // -------------------------------------------------------------------------

  async hermeticity(workspaceId: string, limit: number): Promise<HermeticityResult> {
    const totals = (
      await this.sql<{ keys: number; reports: number }[]>`
        SELECT count(DISTINCT hash)::int AS keys, count(*)::int AS reports
        FROM output_fingerprints WHERE workspace_id = ${workspaceId}`
    )[0]!
    const hashes = await this.sql<{ hash: string }[]>`
      SELECT hash FROM output_fingerprints WHERE workspace_id = ${workspaceId}
      GROUP BY hash HAVING count(DISTINCT tree) > 1
      ORDER BY MAX(created_at) DESC LIMIT ${limit}`
    const divergent: DivergentKey[] = []
    for (const h of hashes) {
      const rows = await this.sql<RawFpRow[]>`
        SELECT hash, os, arch, tree, files, truncated, task_id, run_id, host, created_at
        FROM output_fingerprints WHERE workspace_id = ${workspaceId} AND hash = ${h.hash}
        ORDER BY created_at DESC LIMIT ${FP_MAX_ROWS_PER_HASH}`
      divergent.push(divergenceOf(rows))
    }
    return { divergent, keysTracked: totals.keys, reportCount: totals.reports }
  }

  // -------------------------------------------------------------------------
  // Wiring helpers (used by the serve routes / dist)
  // -------------------------------------------------------------------------

  /** Most-recent producing task/run for each artifact hash (the /v1/artifacts join). */
  async provenanceForHashes(
    workspaceId: string,
    hashes: readonly string[],
  ): Promise<Map<string, HashProvenance>> {
    const out = new Map<string, HashProvenance>()
    if (hashes.length === 0) return out
    const rows = await this.sql<
      { hash: string; project: string; task: string; run_id: string | null }[]
    >`
      SELECT hash, project, task, run_id FROM task_runs
      WHERE workspace_id = ${workspaceId} AND hash IN ${this.sql(hashes as string[])}
      ORDER BY started_at DESC`
    for (const r of rows) {
      if (!out.has(r.hash)) out.set(r.hash, { project: r.project, task: r.task, runId: r.run_id })
    }
    return out
  }

  /**
   * Mean executed-run duration per `project#task` — the duration-aware dispatch
   * hint. Memoized per (workspace, scope) for DURATION_HINT_TTL_MS: this is a
   * history GROUP BY that ran synchronously on EVERY `dist:submit` (the
   * latency-critical submit path); the hints are advisory (LPT ordering only),
   * so a value up to the TTL stale never affects a run's outcome.
   *
   * TRUST-SCOPED like the cache (owner 2026-07-14: "it should work like with
   * cache — timing from main accessible in branch but nothing from branch leaks
   * to main; it is untrusted"). Mirrors the artifact store's `readScopeSpecs`:
   *   - a TRUNK submission (`branch === defaultBranch`, or an undetectable
   *     scope — the strict default) reads ONLY the trunk baseline. A branch
   *     experiment's slow timings can NEVER reach it; a task with no trunk
   *     timing simply has no hint (→ FIFO for it), never a branch value.
   *   - a BRANCH submission reads its OWN branch's timings FIRST, falling
   *     through to the trunk baseline for tasks it hasn't run on its branch —
   *     and NEVER another branch's (one PR can't see another's, exactly like
   *     the per-PR untrusted sub-scope). So a dev on a branch benefits from its
   *     own accumulated (changed) durations layered over main.
   * A task with no timing in ANY readable scope is absent (a cache miss → no
   * hint). The LEFT JOIN means a task_run without an invocation header is
   * un-attributable to any branch, so it feeds no scope — correct: only
   * provably-scoped runs move a baseline.
   */
  async taskDurationHints(
    workspaceId: string,
    scope: DurationHintScope = {},
  ): Promise<Map<string, number>> {
    const branch = scope.branch ?? null
    const defaultBranch = scope.defaultBranch ?? null
    // Undetectable branch/default → treat as trunk: a run whose scope we can't
    // determine gets the clean trunk baseline, never branch pollution.
    const isTrunk = branch === null || defaultBranch === null || branch === defaultBranch
    // `isTrunk` is a DISTINCT key segment, never the raw branch, so no branch
    // value — not even one literally named the trunk sentinel — can alias the
    // trunk memo entry and leak its timings into main's hint (git branch names
    // cannot contain a tab, so a branch value can never forge the `trunk` key).
    const memoKey = isTrunk ? `${workspaceId}\ttrunk` : `${workspaceId}\tbranch\t${branch}`
    const now = Date.now()
    const cached = this.hintCache.get(memoKey)
    if (cached !== undefined && cached.expiresAt > now) return cached.hints

    const sql = this.sql
    // The readable-scope aggregate: trunk reads only trunk; a branch reads its
    // own timings then falls through to trunk (COALESCE precedence == the
    // own-sub-scope-then-trusted order of readScopeSpecs).
    const readable = isTrunk
      ? sql`avg(duration_ms) FILTER (WHERE trunk)`
      : sql`COALESCE(avg(duration_ms) FILTER (WHERE branch = ${branch}), avg(duration_ms) FILTER (WHERE trunk))`
    const rows = await this.sql<{ id: string; avg: number | null }[]>`
      WITH d AS (
        SELECT tr.project AS project, tr.task AS task, tr.duration_ms AS duration_ms,
          inv.branch AS branch,
          (inv.default_branch IS NOT NULL AND inv.branch = inv.default_branch) AS trunk
        FROM task_runs tr
        -- LATERAL pick-one (the getRegressions / getProjectBranchFailures fix):
        -- invocations' uniqueness is (started_at, run_id), so a re-pushed
        -- summary with a changed started_at yields TWO headers for one run. A
        -- plain join would then DUPLICATE each task_run — inflating avg() toward
        -- re-pushed runs, and (if the re-push changed branch) letting one run
        -- feed BOTH the trunk baseline AND a branch scope, defeating the trust
        -- isolation. Take the earliest header per run_id; byte-identical on
        -- well-formed (single-header) data.
        LEFT JOIN LATERAL (
          SELECT i.branch, i.default_branch FROM invocations i
          WHERE i.run_id = tr.run_id AND i.workspace_id = ${workspaceId}
          ORDER BY i.started_at ASC, i.run_id ASC
          LIMIT 1
        ) inv ON true
        WHERE tr.workspace_id = ${workspaceId}
          AND (tr.cache_hit IS NULL OR tr.cache_hit = false) AND tr.status = 'success'
      )
      SELECT project || '#' || task AS id, ${readable}::float8 AS avg
      FROM d
      GROUP BY project, task`
    const hints = new Map<string, number>()
    for (const r of rows) if (r.avg !== null) hints.set(r.id, r.avg)
    // Bound the memo so per-branch churn can't grow it unbounded.
    if (this.hintCache.size > 256) this.hintCache.clear()
    this.hintCache.set(memoKey, { hints, expiresAt: now + DURATION_HINT_TTL_MS })
    return hints
  }
}

interface RawLogRow {
  run_id: string
  task_id: string
  hash: string | null
  status: string
  codec: string
  content: Uint8Array
  chars_full: number
  truncated_head: number
}

function decodeLog(row: RawLogRow): StoredTaskLog {
  const bytes = row.codec === 'zstd' ? Bun.zstdDecompressSync(row.content) : row.content
  return {
    runId: row.run_id,
    taskId: row.task_id,
    ...(row.hash !== null ? { hash: row.hash } : {}),
    status: row.status === 'failed' ? 'failed' : 'success',
    content: Buffer.from(bytes).toString('utf8'),
    charsFull: row.chars_full,
    truncatedHeadChars: row.truncated_head,
  }
}

interface RawFpRow {
  hash: string
  os: string
  arch: string
  tree: string
  // jsonb — Bun.sql reads it back as the parsed value (array of [path,hash]).
  files: unknown
  truncated: boolean
  task_id: string
  run_id: string
  host: string | null
  created_at: string
}

/** Diff the distinct output trees reported for one cache key (verify §4). */
function divergenceOf(rows: RawFpRow[]): DivergentKey {
  let crossPlatform = false
  outer: for (const a of rows) {
    for (const b of rows) {
      if (a.tree !== b.tree && (a.os !== b.os || a.arch !== b.arch)) {
        crossPlatform = true
        break outer
      }
    }
  }
  const changedComplete = rows.every((r) => r.files !== null && !r.truncated)
  const byTree = new Map<string, Map<string, string>>()
  for (const r of rows) {
    if (r.files === null || byTree.has(r.tree)) continue
    // `files` is jsonb — Bun.sql reads it back as the parsed array (a legacy
    // double-encoded string still parses via asJsonValue).
    const pairs = asJsonValue(r.files)
    if (Array.isArray(pairs)) byTree.set(r.tree, new Map(pairs as Array<[string, string]>))
  }
  const changed = new Set<string>()
  const maps = [...byTree.values()]
  for (let i = 0; i < maps.length; i++) {
    for (let j = i + 1; j < maps.length; j++) {
      for (const rel of diffOutputTrees(maps[i]!, maps[j]!)) changed.add(rel)
    }
  }
  return {
    hash: rows[0]!.hash,
    taskId: rows[0]!.task_id,
    crossPlatform,
    changed: [...changed].sort(),
    changedComplete,
    reports: rows.map((r) => ({
      os: r.os,
      arch: r.arch,
      tree: r.tree,
      runId: r.run_id,
      host: r.host,
      at: num(r.created_at),
    })),
  }
}
