// Named functions for `$computed` in pure-JSON specs. The renderer resolves
// `{ $computed: 'aggFmt', args: { arr: { $state: '/projects' }, field: 'runs',
// op: 'sum', fmt: 'number' } }` to the call below. args resolve recursively, so
// $computed nests. This keeps state RAW and all formatting / aggregation
// declarative — referenced by name from the JSON, no per-page code.

import { formatBytes, formatCount, formatDate, formatDuration, formatPercent, formatRelativeTime, formatSignedDuration, paletteFor } from '../format.ts'
import { type FormatHint, formatValue } from './hints.ts'

type Args = Record<string, unknown>
type Row = Record<string, unknown>
const n = (v: unknown) => Number(v)
const arr = (v: unknown): Row[] => (Array.isArray(v) ? v : [])

// --- Cache-entry heat (cold / stale / warm) ---------------------------------
// The cache bumps `accessed_at` on every restore. An entry whose accessed time
// barely moved past its created time was written but NEVER re-hit since creation
// — a cold cache key (the task ran, cached, and never paid off). An entry that
// HAS been re-hit but not in a long while is stale. Everything else is warm.
const COLD_TOLERANCE_MS = 2000 // accessed within ~2s of created ⇒ never re-hit
const STALE_DAYS = 14
const STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000

/** 'cold' | 'stale' | 'warm' for one entry (uses createdAt/accessedAt epoch ms). */
function entryHeat(row: Row, now: number): 'cold' | 'stale' | 'warm' {
  const created = n(row.createdAt)
  const accessed = n(row.accessedAt)
  if (!Number.isFinite(accessed) || !Number.isFinite(created)) return 'warm'
  if (accessed - created <= COLD_TOLERANCE_MS) return 'cold'
  if (now - accessed >= STALE_MS) return 'stale'
  return 'warm'
}

// Map heat → a `failureMode` token so the existing dots/tone map colors it:
// stable=green (warm), flaky-recoverable=amber (stale), else=red (cold).
const HEAT_TOKEN = { warm: 'stable', stale: 'flaky-recoverable', cold: 'cold' } as const

function aggregate(a: Args): number {
  const rows = arr(a.arr)
  const field = String(a.field)
  if (a.op === 'count') return rows.length
  if (a.op === 'max') return Math.max(0, ...rows.map((r) => n(r[field])))
  if (a.op === 'avg') return rows.length ? rows.reduce((acc, r) => acc + n(r[field]), 0) / rows.length : 0
  return rows.reduce((acc, r) => acc + n(r[field]), 0) // sum (default)
}

export const FUNCTIONS: Record<string, (args: Args) => unknown> = {
  // formatters (single value)
  fmtDuration: (a) => formatDuration(n(a.ms)),
  // Signed delta — a negative delta (FASTER) renders '−1.2s', not '—'.
  fmtSignedDuration: (a) => formatSignedDuration(n(a.ms)),
  fmtBytes: (a) => formatBytes(n(a.b)),
  fmtCount: (a) => formatCount(n(a.n)),
  fmtPercent: (a) => formatPercent(n(a.n), 1),
  fmtPercent0: (a) => formatPercent(n(a.n), 0),
  fmtRelTime: (a) => formatRelativeTime(n(a.t)),
  fmtDate: (a) => formatDate(n(a.t)),
  fmtNumber: (a) => (Number.isFinite(n(a.n)) ? String(Math.round(n(a.n))) : '—'),

  // aggregate a state array → raw / formatted / tone / text
  agg: (a) => aggregate(a),
  aggFmt: (a) => formatValue(a.fmt as FormatHint, aggregate(a)),
  ratioFmt: (a) => {
    const b = aggregate({ arr: a.arr, field: a.b, op: 'sum' })
    const top = aggregate({ arr: a.arr, field: a.a, op: 'sum' })
    return formatValue(a.fmt as FormatHint, b > 0 ? top / b : 0)
  },
  aggTone: (a) => (aggregate(a) > n(a.gt) ? a.then : (a.else ?? 'default')),

  // string composition: text({ tpl: '{a} / {b} runs', a, b })
  text: (a) => String(a.tpl ?? '').replace(/\{(\w+)\}/g, (_m, k) => (a[k] === undefined ? '' : String(a[k]))),

  // tone selection on a single value (since $cond can't compare a $computed)
  gt: (a) => (n(a.v) > n(a.n) ? a.then : (a.else ?? 'default')),
  lt: (a) => (n(a.v) < n(a.n) ? a.then : (a.else ?? 'default')),

  // chart-palette token for a category key
  palette: (a) => paletteFor(String(a.key)),

  // count rows where a field equals a value (e.g. status === 'success')
  countWhere: (a) => arr(a.arr).filter((r) => r[String(a.field)] === a.eq).length,

  // Annotate cache entries with heat: adds `_heat` ('cold'|'stale'|'warm') and
  // `_heatToken` (a failureMode token the dots map colors), plus `_taskId` for
  // the task-entity link column. Pure, raw fields.
  coldEntries: (a) => {
    const now = Date.now()
    return arr(a.arr).map((r) => {
      const heat = entryHeat(r, now)
      return { ...r, _heat: heat, _heatToken: HEAT_TOKEN[heat], _taskId: `${String(r.project)}#${String(r.task)}` }
    })
  },

  // # of cold (written-but-never-rehit) entries.
  countCold: (a) => {
    const now = Date.now()
    return arr(a.arr).filter((r) => entryHeat(r, now) === 'cold').length
  },

  // Reclaimable bytes = total size of cold entries, formatted.
  coldBytes: (a) => {
    const now = Date.now()
    const b = arr(a.arr).reduce((acc, r) => (entryHeat(r, now) === 'cold' ? acc + n(r.sizeBytes) : acc), 0)
    return formatValue('bytes', b)
  },

  // max(end) - min(start) across rows (run wall time)
  span: (a) => {
    const rows = arr(a.arr)
    if (!rows.length) return 0
    return Math.max(...rows.map((r) => n(r[String(a.end)]))) - Math.min(...rows.map((r) => n(r[String(a.start)])))
  },

  // CPU utilization stat ('avg' | 'max') across recent runs, as "N%".
  // pct = cpuMs / durationMs * 100; cache hits / zero-duration excluded.
  cpuStat: (a) => {
    const vals = arr(a.rows)
      .map((r) => (r.cpuMs != null && n(r.durationMs) > 0 && r.cacheHit !== true ? (n(r.cpuMs) / n(r.durationMs)) * 100 : null))
      .filter((v): v is number => v != null && Number.isFinite(v))
    if (!vals.length) return '—'
    const v = a.stat === 'max' ? Math.max(...vals) : vals.reduce((s, x) => s + x, 0) / vals.length
    return `${Math.round(v)}%`
  },

  // One InvocationDetail → a display-ready entry for the run-detail header
  // Facts strip (command / branch / commit / dirty / CI / tags / cache policy /
  // concurrency / vx version). Null-safe: absent fields render '—'.
  invocationFacts: (a) => {
    const inv = a.inv as Row | null | undefined
    if (!inv || typeof inv !== 'object') return null
    return {
      command: inv.command ?? null,
      branch: inv.branch ?? null,
      commit: inv.commitSha ? `${String(inv.commitSha).slice(0, 10)}` : null,
      worktree: inv.dirty === true ? 'dirty' : inv.dirty === false ? 'clean' : null,
      ci: inv.ci ? String(inv.ciProvider ?? 'CI') : 'local',
      tags: tagsText(inv.tags) || null,
      cachePolicy: inv.cachePolicy ?? null,
      concurrency: inv.concurrency ?? null,
      vx: inv.vxVersion ?? null,
    }
  },

  // Two rows (Local / Remote) for the cache hit-source split table — each with
  // its raw count and a 0..1 share fraction for the bar column. Built here so
  // the view passes only plain $state counts (directives don't deep-resolve
  // inside literal array props).
  hitSplitRows: (a) => {
    const local = n(a.local)
    const remote = n(a.remote)
    const total = local + remote
    // Empty when there were no hits at all, so the DataTable renders its honest
    // "No cache hits in the last 24h" empty state instead of two noisy 0/0 rows.
    if (total === 0) return []
    return [
      { source: 'Local', count: local, _frac: local / total, _color: 'cache-local' },
      { source: 'Remote', count: remote, _frac: remote / total, _color: 'cache-remote' },
    ]
  },

  // Catalog ∪ analytics joins (cloud-data-model-2026-07 §4.1): the entity
  // pages list the CATALOG (every project/task, incl. never-run) joined with
  // history rollups by name/id. No catalog (remote/older serve) → the rollups
  // pass through untouched — today's behavior, the capabilities pattern.
  joinProjects: (a) => joinProjects(arr(a.rollups), a.catalog),
  joinTasks: (a) => joinTasks(arr(a.history), a.catalog),

  // Annotate rows carrying {project, task} with `_taskRef` = "project#task"
  // (raw — href templates URL-encode it), for /runs/{runId}?task={_taskRef}
  // deep links from failure/history rows.
  withTaskRef: (a) => arr(a.arr).map((r) => ({ ...r, _taskRef: `${String(r.project)}#${String(r.task)}` })),

  // Entity hrefs that need URL-encoding (text() can't encode).
  taskHref: (a) => `/tasks/${encodeURIComponent(`${String(a.project)}#${String(a.task)}`)}`,
  projectHref: (a) => `/projects/${encodeURIComponent(String(a.project))}`,

  // One-line flaky badge for task detail (fed by the taskFlaky source).
  flakyText: (a) => {
    const f = a.flaky as Row | null | undefined
    if (!f || typeof f !== 'object') return ''
    if (f.flakyConfirmed === true) {
      const worst = f.maxAttempts !== undefined ? ` (worst: ${String(f.maxAttempts)} attempts)` : ''
      return `Flaky — CONFIRMED by within-run retries in ${String(f.withinRunRetries)} run(s)${worst}. Consider exec.retries.`
    }
    return `Flaky — inferred from a ${formatPercent(n(f.failureRate), 0)} failure rate over ${String(f.runs)} runs.`
  },

  // Annotate flaky rows for the Insights table with a copy-able suggested fix:
  // CONFIRMED-flaky rows get `exec.retries: N`; inferred-only rows get '' (the
  // DataTable renders an empty cell as '—'). Pure — raw fields preserved.
  withFlakyFix: (a) =>
    arr(a.arr).map((r) => {
      const retries = suggestedRetriesFor(r)
      return { ...r, suggestedRetries: retries, fixText: retries !== undefined ? `exec.retries: ${retries}` : '' }
    }),
}

/**
 * One actionable recommendation for a task — a short rationale + an optional
 * copy-pasteable config snippet. The task-detail Recommendations card renders
 * a list of these.
 */
export interface Recommendation {
  /** Drives the card's tone/icon: 'flaky-retries' | 'flaky-persistent' | 'non-hermetic' | 'uncached'. */
  kind: string
  title: string
  detail: string
  /** A copy-able config snippet, when the fix is a config change. */
  snippet?: string
}

// Structurally-loose views of the api rows the recommendation logic reads, so
// both the raw `Row` (from $computed/$state) AND the concrete api types
// (FlakyTask / DivergentKeyRow — no index signature) are assignable.
interface FlakyLike {
  flakyConfirmed?: unknown
  maxAttempts?: unknown
  withinRunRetries?: unknown
}
interface DivergentLike {
  crossPlatform?: unknown
  changed?: unknown
  reports?: unknown
}

/**
 * Suggested `exec.retries` for a CONFIRMED-flaky task: `max(maxAttempts ?? 2, 2)`
 * — always at least 2 so the retry survives a second bad draw. `undefined` for
 * inferred-only (not `flakyConfirmed`) or missing flaky rows — no suggestion.
 */
export function suggestedRetriesFor(flaky: FlakyLike | null | undefined): number | undefined {
  if (!flaky || flaky.flakyConfirmed !== true) return undefined
  const max = typeof flaky.maxAttempts === 'number' && Number.isFinite(flaky.maxAttempts) ? flaky.maxAttempts : 2
  return Math.max(max, 2)
}

// A task's typical duration at/above which "add caching" is worth suggesting.
const SLOW_MS = 1000

/** The declared `exec.retries` from a resolved task config, or undefined. */
function declaredRetries(taskConfig: Row): number | undefined {
  const exec = taskConfig.exec
  if (exec && typeof exec === 'object') {
    const r = (exec as Row).retries
    if (typeof r === 'number' && Number.isFinite(r)) return r
  }
  return undefined
}

/** Whether a resolved task config declares any `cache` block. */
function hasCacheBlock(taskConfig: Row): boolean {
  return taskConfig.cache !== undefined && taskConfig.cache !== null
}

/** Platforms a divergent hermeticity key spans, for the recommendation detail. */
function divergentPlatforms(d: DivergentLike): string {
  if (d.crossPlatform !== true) return 'The same platform, run-to-run,'
  const reports = arr(d.reports)
  const platforms = [...new Set(reports.map((r) => `${String(r.os)}-${String(r.arch)}`))]
  return platforms.join(' ⇄ ')
}

/** The diverging output rels (first 3 + count), for the recommendation detail. */
function divergentChanged(d: DivergentLike): string {
  const changed = Array.isArray(d.changed) ? (d.changed as string[]) : []
  if (changed.length === 0) return 'the output tree — file list truncated'
  const shown = changed.slice(0, 3).join(', ')
  return changed.length > 3 ? `${shown} +${changed.length - 3} more` : shown
}

/**
 * Aggregate every applicable, actionable recommendation for one task from its
 * flaky / hermeticity / catalog signals. Pure — the task-detail source fetches
 * the inputs, this decides what to suggest. `taskConfig === null` means the
 * catalog is unavailable (remote/ingest-only serve), which disables the
 * catalog-gated refinements (already-retries, add-caching).
 */
export function computeRecommendations(input: {
  flaky: FlakyLike | null
  divergent: DivergentLike | null
  taskConfig: Row | null
  avgDurationMs: number | null
}): Recommendation[] {
  const { flaky, divergent, taskConfig, avgDurationMs } = input
  const recs: Recommendation[] = []

  // 1. Flaky → retries (or "already retries, still flaky" when the catalog
  //    shows it already declares enough).
  if (flaky && flaky.flakyConfirmed === true) {
    const nRetries = suggestedRetriesFor(flaky) ?? 2
    const declared = taskConfig ? declaredRetries(taskConfig) : undefined
    if (taskConfig !== null && declared !== undefined && declared >= nRetries) {
      recs.push({
        kind: 'flaky-persistent',
        title: 'Already retries, still flaky',
        detail: `Declares retries: ${declared} but still flakes — the failure is nondeterministic, not transient. Investigate the root cause, or run \`vx run --verify\` to check hermeticity.`,
      })
    } else {
      const runs = Number(flaky.withinRunRetries) || 0
      recs.push({
        kind: 'flaky-retries',
        title: 'Flaky — add retries',
        detail: `Failed then passed under identical inputs in ${runs} run(s) — nondeterministic. Retries make CI resilient.`,
        snippet: `exec: { retries: ${nRetries} }`,
      })
    }
  }

  // 2. Non-hermetic → split the key per platform, or fix the bug.
  if (divergent) {
    recs.push({
      kind: 'non-hermetic',
      title: 'Non-hermetic outputs',
      detail: `${divergentPlatforms(divergent)} produce different outputs for the same cache key (${divergentChanged(divergent)}). Either fix the hermeticity bug (absolute paths, timestamps, hashmap order), or — if the task is legitimately platform-dependent — split the key so each platform caches separately.`,
      snippet: `cache.inputs.runtime: ['uname -sm']`,
    })
  }

  // 3. Slow + uncached → add caching (catalog-gated; skip when unknown or
  //    already cached).
  if (taskConfig !== null && !hasCacheBlock(taskConfig) && avgDurationMs !== null && avgDurationMs >= SLOW_MS) {
    recs.push({
      kind: 'uncached',
      title: 'Not cached',
      detail: `Takes ~${formatDuration(avgDurationMs)} and isn't cached — add a \`cache\` block so re-runs restore instead of re-executing.`,
      snippet: `cache: {\n  inputs: { files: ['src/**'] },\n  outputs: { files: ['dist/**'] },\n}`,
    })
  }

  return recs
}

// --- Runs view: faceted filters + CI health (pure derivations) --------------
// Extracted so the Runs surface stays declarative and these decisions are
// unit-pinned. Structurally-loose inputs so both raw rows and the concrete
// InvocationDetail api type are assignable.

/** Result facet for the Runs table. */
export type RunResultFilter = 'all' | 'passed' | 'failed'

interface InvocationLike {
  runId?: unknown
  branch?: unknown
  commitSha?: unknown
  failedCount?: unknown
  exitOk?: unknown
  startedAt?: unknown
  totalDurationMs?: unknown
  requestedTasks?: unknown
}

/** A run passed iff no task failed AND it exited ok. */
export function invocationPassed(inv: InvocationLike): boolean {
  return (Number(inv.failedCount) || 0) === 0 && inv.exitOk !== false
}

/**
 * Apply the result + branch + commit facets to invocation rows client-side (all
 * three fields live on the row). Project filtering needs a per-project runId set
 * and is handled by the caller. `commit` matches by prefix so a shortened SHA
 * from the URL still selects the run.
 */
export function filterInvocations<T extends InvocationLike>(
  rows: readonly T[],
  f: { result: RunResultFilter; branch: string; commit?: string },
): T[] {
  const commit = f.commit ?? ''
  return rows.filter((r) => {
    if (f.result === 'passed' && !invocationPassed(r)) return false
    if (f.result === 'failed' && invocationPassed(r)) return false
    if (f.branch !== '' && String(r.branch ?? '') !== f.branch) return false
    if (commit !== '' && !String(r.commitSha ?? '').startsWith(commit)) return false
    return true
  })
}

/** Distinct non-empty branch names across invocation rows, sorted. */
export function distinctBranches(rows: readonly InvocationLike[]): string[] {
  const set = new Set<string>()
  for (const r of rows) {
    if (typeof r.branch === 'string' && r.branch !== '') set.add(r.branch)
  }
  return Array.from(set).sort()
}

/** Distinct non-empty commit SHAs across invocation rows, most-recent-first. */
export function distinctCommits(rows: readonly InvocationLike[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of rows) {
    if (typeof r.commitSha === 'string' && r.commitSha !== '' && !seen.has(r.commitSha)) {
      seen.add(r.commitSha)
      out.push(r.commitSha)
    }
  }
  return out
}

/** One tick in the CI-health strip. */
export interface RunTick {
  runId: string
  ok: boolean
  startedAt: number
  /** requested tasks, joined — the tooltip's headline. */
  label: string
  durationMs: number
}

/**
 * The last `count` runs as ticks, ordered most-recent-LAST (invocation rows
 * arrive newest-first, so take the head then reverse) — the strip reads
 * left→right chronological with the newest on the right.
 */
export function runTicks(rows: readonly InvocationLike[], count: number): RunTick[] {
  return rows
    .slice(0, count)
    .map((r): RunTick => ({
      runId: String(r.runId ?? ''),
      ok: invocationPassed(r),
      startedAt: Number(r.startedAt) || 0,
      label: Array.isArray(r.requestedTasks) ? r.requestedTasks.join(' ') : '',
      durationMs: Number(r.totalDurationMs) || 0,
    }))
    .reverse()
}

/**
 * Pass rate over the invocations whose start falls within `windowMs` of `now`.
 * `undefined` when none did — the tile then reads '—' instead of a fake 0%.
 */
export function passRateWithin(
  rows: readonly InvocationLike[],
  windowMs: number,
  now: number,
): number | undefined {
  const inWindow = rows.filter((r) => now - (Number(r.startedAt) || 0) <= windowMs)
  if (inWindow.length === 0) return undefined
  return inWindow.filter(invocationPassed).length / inWindow.length
}

/** Tone for a higher-is-better rate (pass rate, hit rate): green/amber/red. */
export function rateTone(value: number, good: number, warn: number): 'good' | 'warn' | 'bad' {
  if (value >= good) return 'good'
  if (value >= warn) return 'warn'
  return 'bad'
}

/** Tone for a lower-is-better problem count — 0 is good, more is worse. */
export function countTone(n: number, badAt = 3): 'good' | 'warn' | 'bad' {
  if (n <= 0) return 'good'
  if (n < badAt) return 'warn'
  return 'bad'
}

/** All catalog projects joined with their analytics rollups, keyed by name. */
function joinProjects(rollups: Row[], catalog: unknown): Row[] {
  const cat = catalog as { projects?: unknown; staleProjects?: unknown } | null | undefined
  if (!cat || !Array.isArray(cat.projects)) return rollups
  const byName = new Map(rollups.map((r) => [String(r.project), r]))
  const stale = new Set(Array.isArray(cat.staleProjects) ? (cat.staleProjects as string[]) : [])
  const zero = {
    runs: 0,
    failures: 0,
    hits: 0,
    hitRate: 0,
    totalDurationMs: 0,
    avgDurationMs: 0,
    cacheBytes: 0,
    cacheEntries: 0,
    estimatedTimeSavedMs: 0,
  }
  const rows: Row[] = (cat.projects as Row[]).map((cp) => ({
    ...zero,
    ...(byName.get(String(cp.name)) ?? {}),
    // Catalog fields win where both exist: it knows the TRUE task count
    // (rollups only count tasks that ever ran) and the project dir.
    project: cp.name,
    taskCount: cp.taskCount,
    dir: cp.dir,
    _stale: stale.has(String(cp.name)),
  }))
  // History for projects the catalog no longer knows (renamed/removed).
  const known = new Set((cat.projects as Row[]).map((cp) => String(cp.name)))
  for (const r of rollups) if (!known.has(String(r.project))) rows.push(r)
  return rows
}

/** All catalog tasks joined with their history aggregates, keyed by id. */
function joinTasks(history: Row[], catalog: unknown): Row[] {
  const cat = catalog as { tasks?: unknown } | null | undefined
  if (!cat || !Array.isArray(cat.tasks)) return history
  const byId = new Map(history.map((h) => [String(h.id), h]))
  const rows: Row[] = (cat.tasks as Row[]).map((ct) => {
    const kind = ct.group === true ? 'group' : ct.persistent === true ? 'persistent' : ct.cacheable === true ? 'cacheable' : ''
    return {
      // Zero-run defaults: a never-run task renders 0 runs and '—' stats
      // (renderField treats undefined as '—'); no failures yet = stable.
      runs: 0,
      totalDurationMs: 0,
      failureMode: 'stable',
      ...(byId.get(String(ct.id)) ?? {}),
      id: ct.id,
      project: ct.project,
      task: ct.task,
      _kind: kind,
    }
  })
  const known = new Set((cat.tasks as Row[]).map((ct) => String(ct.id)))
  for (const h of history) if (!known.has(String(h.id))) rows.push(h)
  return rows
}

// Tags object { k: v } → "k=v, …" (empty string when no tags).
function tagsText(tags: unknown): string {
  if (!tags || typeof tags !== 'object') return ''
  return Object.entries(tags as Record<string, unknown>)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(', ')
}
