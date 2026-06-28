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
