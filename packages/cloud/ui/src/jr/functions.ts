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

  // Annotate the FLAT runWhy diff rows (one per changed cache-key component:
  // { taskId, project, task, kind, name, change, before, after }) with the
  // display fields the DataTable reads as raw row keys:
  //   _changeToken — a failureMode token so the dots map colors the change
  //                  (added → green/stable, changed → amber, removed → red)
  //   _diff        — a readable "before → after" string. File/upstream hashes
  //                  are shortened to 12 chars; env/runtime values shown raw.
  whyRows: (a) => arr(a.arr).map((r) => ({ ...r, _changeToken: changeToken(String(r.change)), _diff: diffText(r) })),

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
    return [
      { source: 'Local', count: local, _frac: total > 0 ? local / total : 0 },
      { source: 'Remote', count: remote, _frac: total > 0 ? remote / total : 0 },
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

// added/changed/removed → a failureMode token (green / amber / red via colorOf).
function changeToken(change: string): 'stable' | 'flaky-recoverable' | 'cold' {
  if (change === 'added') return 'stable'
  if (change === 'changed') return 'flaky-recoverable'
  return 'cold' // removed
}

// "before → after" for one diff row. Hash-shaped components (file/upstream/
// package/config/workspace/ws-runtime) shorten to 12 chars; value components
// (env/runtime/forward) show verbatim. A null side renders as "∅".
const HASH_KINDS = new Set(['file', 'upstream', 'package', 'config', 'workspace', 'ws-runtime'])
function diffText(r: Row): string {
  // Reason-only rows (first run / not cacheable) carry no component — render
  // an empty cell, not "∅ → ∅".
  if (r.before == null && r.after == null) return ''
  const short = (v: unknown) => (v == null ? '∅' : HASH_KINDS.has(String(r.kind)) ? `${String(v).slice(0, 12)}…` : String(v))
  return `${short(r.before)} → ${short(r.after)}`
}

// Tags object { k: v } → "k=v, …" (empty string when no tags).
function tagsText(tags: unknown): string {
  if (!tags || typeof tags !== 'object') return ''
  return Object.entries(tags as Record<string, unknown>)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(', ')
}
