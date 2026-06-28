// Single source of truth for how a task status renders EVERYWHERE — the graph
// cards, the flame bars, the cockpit detail panel, badges. Keeping one map kills
// the cross-view drift (different colors/icons/labels for the same status) and
// makes remote vs local cache hits visually distinct in every view.
//
// All classes are LITERAL strings so UnoCSS's static extractor emits them — this
// file is scanned, the consumers reference these via the map.

export type VizState =
  | 'queued'
  | 'running'
  | 'success'
  | 'cache-hit'
  | 'cache-hit-remote'
  | 'failed'
  | 'skipped'
  | 'aborted'
  | 'group'

export interface StatusViz {
  label: string
  icon: string // i-tabler-*
  dot: string // text-* (icon / dot color)
  barBg: string // bg-*/N (flame bar fill)
  rail: string // bg-* (graph card status rail)
  border: string // border-*/N (graph card border)
}

export const STATUS: Record<VizState, StatusViz> = {
  queued: { label: 'queued', icon: 'i-tabler-circle-dashed', dot: 'text-fg-3', barBg: 'bg-fg-3/40', rail: 'bg-border-strong', border: 'border-border' },
  running: { label: 'running', icon: 'i-tabler-loader-2', dot: 'text-accent', barBg: 'bg-accent/70', rail: 'bg-accent', border: 'border-accent/40' },
  success: { label: 'success', icon: 'i-tabler-circle-check', dot: 'text-success', barBg: 'bg-success/70', rail: 'bg-success', border: 'border-success/40' },
  'cache-hit': { label: 'cache hit', icon: 'i-tabler-bolt', dot: 'text-cache-local', barBg: 'bg-cache-local/70', rail: 'bg-cache-local', border: 'border-cache-local/40' },
  'cache-hit-remote': { label: 'remote cache', icon: 'i-tabler-cloud-download', dot: 'text-cache-remote', barBg: 'bg-cache-remote/70', rail: 'bg-cache-remote', border: 'border-cache-remote/40' },
  failed: { label: 'failed', icon: 'i-tabler-circle-x', dot: 'text-danger', barBg: 'bg-danger/80', rail: 'bg-danger', border: 'border-danger/50' },
  skipped: { label: 'skipped', icon: 'i-tabler-circle-minus', dot: 'text-warn', barBg: 'bg-warn/70', rail: 'bg-warn', border: 'border-warn/40' },
  aborted: { label: 'aborted', icon: 'i-tabler-ban', dot: 'text-fg-3', barBg: 'bg-fg-3/40', rail: 'bg-fg-3', border: 'border-border' },
  group: { label: 'group', icon: 'i-tabler-folder', dot: 'text-fg-3', barBg: 'bg-border-strong', rail: 'bg-border-strong', border: 'border-border border-dashed' },
}

/**
 * Normalize a raw outcome status (+ optional cacheHit flag) to a VizState.
 * Distinguishes local vs remote cache hits — the backend reports
 * `cache-hit-remote`, which the views previously collapsed to `cache-hit`.
 */
export function toVizState(status: string, cacheHit?: boolean): VizState {
  switch (status) {
    case 'cache-hit-remote':
      return 'cache-hit-remote'
    case 'cache-hit':
      return 'cache-hit'
    case 'failed':
      return 'failed'
    case 'skipped':
      return 'skipped'
    case 'aborted':
      return 'aborted'
    case 'running':
      return 'running'
    case 'queued':
      return 'queued'
    default:
      return cacheHit ? 'cache-hit' : 'success'
  }
}
