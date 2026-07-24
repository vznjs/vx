// Single source of truth for how a task status renders EVERYWHERE — graph
// cards, flame bars, tables, the cockpit detail panel. One map kills the
// cross-view drift (different colors/labels for the same status) and keeps
// remote vs local cache hits visually distinct in every view.
//
// Everything is expressed in astryx primitives: StatusDot variants, Token
// colors, and design-token CSS vars for the SVG surfaces (flamegraph, DAG,
// charts) that need literal fill/stroke values.

import type { JSX } from 'react'
import { StatusDot } from '@astryxdesign/core/StatusDot'
import { Token } from '@astryxdesign/core/Token'

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

type DotVariant = 'success' | 'warning' | 'error' | 'accent' | 'neutral'
type TokenColor = 'default' | 'red' | 'orange' | 'yellow' | 'green' | 'teal' | 'cyan' | 'blue' | 'purple' | 'pink' | 'gray'

export interface StatusViz {
  label: string
  dot: DotVariant
  pulse: boolean
  token: TokenColor
  /** Design-token color for SVG fills/strokes (flame bars, DAG rails). */
  fill: string
}

export const STATUS: Record<VizState, StatusViz> = {
  queued: { label: 'queued', dot: 'neutral', pulse: false, token: 'gray', fill: 'var(--color-icon-gray, #748695)' },
  running: { label: 'running', dot: 'accent', pulse: true, token: 'blue', fill: 'var(--color-accent, #2694FE)' },
  success: { label: 'success', dot: 'success', pulse: false, token: 'green', fill: 'var(--color-success, #0D8626)' },
  'cache-hit': { label: 'cache hit', dot: 'success', pulse: false, token: 'cyan', fill: 'var(--color-icon-cyan, #26C6DA)' },
  'cache-hit-remote': { label: 'remote cache', dot: 'success', pulse: false, token: 'blue', fill: 'var(--color-icon-blue, #2694FE)' },
  failed: { label: 'failed', dot: 'error', pulse: false, token: 'red', fill: 'var(--color-error, #F5394F)' },
  skipped: { label: 'skipped', dot: 'warning', pulse: false, token: 'yellow', fill: 'var(--color-warning, #F2C00B)' },
  aborted: { label: 'aborted', dot: 'neutral', pulse: false, token: 'gray', fill: 'var(--color-icon-gray, #748695)' },
  group: { label: 'group', dot: 'neutral', pulse: false, token: 'default', fill: 'var(--color-border-emphasized, #494D53)' },
}

/**
 * Predicted cache status (the /v1/graph `cacheStatus` field) → chip visuals.
 * Shown on QUEUED cockpit cards before live events arrive, so a run's "what
 * will actually execute" is visible up front.
 */
export type PredictedStatus = 'hit-local' | 'hit-remote' | 'miss' | 'no-cache' | 'group'

export const PREDICTED: Record<PredictedStatus, { label: string; token: TokenColor } | null> = {
  'hit-local': { label: 'cached', token: 'cyan' },
  'hit-remote': { label: 'remote', token: 'blue' },
  miss: { label: 'will run', token: 'gray' },
  'no-cache': { label: 'will run', token: 'gray' },
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

/** Status dot + visible label — the standard row-leading status cell. */
export function StatusCell({ state }: { state: VizState }): JSX.Element {
  const viz = STATUS[state]
  return (
    <>
      <StatusDot variant={viz.dot} label={viz.label} isPulsing={viz.pulse} />
      <Token label={viz.label} color={viz.token} size="sm" />
    </>
  )
}

/** Compact status token (tables where the dot would be noise). */
export function StatusToken({ state }: { state: VizState }): JSX.Element {
  const viz = STATUS[state]
  return <Token label={viz.label} color={viz.token} size="sm" />
}
