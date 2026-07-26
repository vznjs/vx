export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1) return '<1ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`
  if (ms < 3600_000) {
    const m = Math.floor(ms / 60_000)
    const s = Math.floor((ms % 60_000) / 1000)
    return `${m}m ${s}s`
  }
  const h = Math.floor(ms / 3600_000)
  const m = Math.floor((ms % 3600_000) / 60_000)
  return `${h}h ${m}m`
}

/**
 * Signed delta form — `formatDuration` rejects negatives (a duration can't be
 * negative), so deltas go through here: `−1.2s` for faster, `+300ms` for
 * slower, `±0` for no change.
 */
export function formatSignedDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '—'
  if (ms === 0) return '±0'
  const sign = ms > 0 ? '+' : '−'
  return `${sign}${formatDuration(Math.abs(ms))}`
}

/**
 * CPU utilization % for one task run. Cache hits (and zero/unknown durations)
 * have no meaningful utilization — returns undefined. The ONE derivation every
 * surface (graph cards, cockpit, tables, task metrics) shares.
 */
export function cpuPct(
  cpuMs: number | null | undefined,
  durationMs: number | null | undefined,
  cacheHit?: boolean | null,
): number | undefined {
  if (cacheHit === true) return undefined
  if (cpuMs === null || cpuMs === undefined) return undefined
  const dur = Number(durationMs)
  if (!Number.isFinite(dur) || dur <= 0) return undefined
  return Math.round((Number(cpuMs) / dur) * 100)
}

/** Tight form for chart axes and table cells (e.g. `1.2k`, `3.4M`). */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs < 1_000) return String(Math.round(n))
  if (abs < 1_000_000) return `${(n / 1_000).toFixed(abs < 10_000 ? 1 : 0)}k`
  if (abs < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  return `${(n / 1_000_000_000).toFixed(1)}G`
}

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

export function formatBytes(b: number): string {
  if (!Number.isFinite(b) || b <= 0) return '0 B'
  // Clamp to [0, SIZE_UNITS.length-1]. Fractional inputs (chart Y mid-ticks)
  // can produce a negative log and an undefined unit otherwise.
  const i = Math.max(0, Math.min(SIZE_UNITS.length - 1, Math.floor(Math.log(b) / Math.log(1024))))
  return `${(b / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${SIZE_UNITS[i]}`
}

export function formatRelativeTime(date: Date | number): string {
  const ts = typeof date === 'number' ? date : date.getTime()
  const diff = Date.now() - ts
  if (diff < 0) return 'in the future'
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.floor(d / 30)
  return `${mo}mo ago`
}

export function formatPercent(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return '—'
  return `${(n * 100).toFixed(digits)}%`
}

export function formatHour(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** Time-of-day with seconds — for per-task started/ended timestamps. */
export function formatTime(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function formatDate(t: number): string {
  return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export function formatDateTime(t: number): string {
  return new Date(t).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Stable hash → chart-palette token for category coloring. */
export function paletteFor(key: string): string {
  let h = 5381
  for (let i = 0; i < key.length; i++) h = ((h * 33) ^ key.charCodeAt(i)) >>> 0
  return `chart-${(h % 8) + 1}`
}

/** Stable hash → identity token for a PROJECT name (`ident-0..5`, the cool
 *  set — deliberately outside the status palette so an id can never read as
 *  an outcome). Same hash shape as `paletteFor` so hues are stable. */
export function identFor(name: string): string {
  let h = 5381
  for (let i = 0; i < name.length; i++) h = ((h * 33) ^ name.charCodeAt(i)) >>> 0
  return `ident-${h % 6}`
}

// Literal class maps (this file is NOT UnoCSS-scanned — the classes are
// safelisted in uno.config.ts; never interpolate `text-${x}`).
const IDENT_TEXT: Record<string, string> = {
  'ident-0': 'text-ident-0',
  'ident-1': 'text-ident-1',
  'ident-2': 'text-ident-2',
  'ident-3': 'text-ident-3',
  'ident-4': 'text-ident-4',
  'ident-5': 'text-ident-5',
}

/** The text class rendering a project name in its identity hue. */
export function identTextClass(name: string): string {
  return IDENT_TEXT[identFor(name)] ?? 'text-ident-0'
}

/** The fixed task-half identity class (tasks are always pink). */
export const IDENT_TASK_TEXT = 'text-ident-task'
