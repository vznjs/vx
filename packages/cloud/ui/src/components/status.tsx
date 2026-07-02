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
  pill: string // text-* bg-*/N border-*/N (StatusBadge pill)
}

export const STATUS: Record<VizState, StatusViz> = {
  queued: { label: 'queued', icon: 'i-tabler-circle-dashed', dot: 'text-fg-3', barBg: 'bg-fg-3/40', rail: 'bg-border-strong', border: 'border-border', pill: 'text-fg-2 bg-surface-2 border-border' },
  running: { label: 'running', icon: 'i-tabler-loader-2', dot: 'text-accent', barBg: 'bg-accent/70', rail: 'bg-accent', border: 'border-accent/40', pill: 'text-accent bg-accent/10 border-accent/25' },
  success: { label: 'success', icon: 'i-tabler-circle-check', dot: 'text-success', barBg: 'bg-success/70', rail: 'bg-success', border: 'border-success/40', pill: 'text-success bg-success/10 border-success/25' },
  'cache-hit': { label: 'cache hit', icon: 'i-tabler-bolt', dot: 'text-cache-local', barBg: 'bg-cache-local/70', rail: 'bg-cache-local', border: 'border-cache-local/40', pill: 'text-cache-local bg-cache-local/10 border-cache-local/25' },
  'cache-hit-remote': { label: 'remote cache', icon: 'i-tabler-cloud-download', dot: 'text-cache-remote', barBg: 'bg-cache-remote/70', rail: 'bg-cache-remote', border: 'border-cache-remote/40', pill: 'text-cache-remote bg-cache-remote/10 border-cache-remote/25' },
  failed: { label: 'failed', icon: 'i-tabler-circle-x', dot: 'text-danger', barBg: 'bg-danger/80', rail: 'bg-danger', border: 'border-danger/50', pill: 'text-danger bg-danger/10 border-danger/25' },
  skipped: { label: 'skipped', icon: 'i-tabler-circle-minus', dot: 'text-warn', barBg: 'bg-warn/70', rail: 'bg-warn', border: 'border-warn/40', pill: 'text-warn bg-warn/10 border-warn/25' },
  aborted: { label: 'aborted', icon: 'i-tabler-ban', dot: 'text-fg-3', barBg: 'bg-fg-3/40', rail: 'bg-fg-3', border: 'border-border', pill: 'text-fg-2 bg-surface-2 border-border' },
  group: { label: 'group', icon: 'i-tabler-folder', dot: 'text-fg-3', barBg: 'bg-border-strong', rail: 'bg-border-strong', border: 'border-border border-dashed', pill: 'text-fg-2 bg-surface-2 border-border' },
}

/**
 * Predicted cache status (the /v1/graph `cacheStatus` field) → chip visuals.
 * Shown on QUEUED cockpit cards before live events arrive, so a run's "what
 * will actually execute" is visible up front. Literal classes (UnoCSS).
 */
export type PredictedStatus = 'hit-local' | 'hit-remote' | 'miss' | 'no-cache' | 'group'

export const PREDICTED: Record<PredictedStatus, { label: string; icon: string; cls: string } | null> = {
  'hit-local': { label: 'cached', icon: 'i-tabler-bolt', cls: 'text-cache-local bg-cache-local/10' },
  'hit-remote': { label: 'remote', icon: 'i-tabler-cloud-download', cls: 'text-cache-remote bg-cache-remote/10' },
  miss: { label: 'will run', icon: 'i-tabler-player-play', cls: 'text-fg-3 bg-surface-2/70' },
  'no-cache': { label: 'will run', icon: 'i-tabler-player-play', cls: 'text-fg-3 bg-surface-2/70' },
  group: null,
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
