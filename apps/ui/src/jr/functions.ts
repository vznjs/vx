// Named functions for `$computed` in pure-JSON specs. The renderer resolves
// `{ $computed: 'aggFmt', args: { arr: { $state: '/projects' }, field: 'runs',
// op: 'sum', fmt: 'number' } }` to the call below. args resolve recursively, so
// $computed nests. This keeps state RAW and all formatting / aggregation
// declarative — referenced by name from the JSON, no per-page code.

import { formatBytes, formatCount, formatDate, formatDuration, formatPercent, formatRelativeTime, paletteFor } from '../format.ts'
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
  // `_heatToken` (a failureMode token the dots map colors). Pure, raw fields.
  coldEntries: (a) => {
    const now = Date.now()
    return arr(a.arr).map((r) => {
      const heat = entryHeat(r, now)
      return { ...r, _heat: heat, _heatToken: HEAT_TOKEN[heat] }
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
}
