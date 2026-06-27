// Declarative formatting + tone hints used by catalog components.
//
// json-render specs are plain data — they can't carry formatter functions.
// Instead a cell/axis carries a string hint ('duration', 'bytes', …) and the
// component resolves it to the right formatter from format.ts. This keeps the
// specs pure JSON and centralises display logic.

import {
  formatBytes,
  formatCount,
  formatDate,
  formatDateTime,
  formatDuration,
  formatHour,
  formatPercent,
  formatRelativeTime,
} from '../format.ts'

export type FormatHint =
  | 'duration'
  | 'bytes'
  | 'count'
  | 'percent'
  | 'percent0'
  | 'relativeTime'
  | 'date'
  | 'dateTime'
  | 'hour'
  | 'number'
  | 'multiplier'
  | 'text'

export function formatValue(hint: FormatHint | undefined, v: number): string {
  switch (hint) {
    case 'duration':
      return formatDuration(v)
    case 'bytes':
      return formatBytes(v)
    case 'count':
      return formatCount(v)
    case 'percent':
      return formatPercent(v, 1)
    case 'percent0':
      return formatPercent(v, 0)
    case 'relativeTime':
      return formatRelativeTime(v)
    case 'date':
      return formatDate(v)
    case 'dateTime':
      return formatDateTime(v)
    case 'hour':
      return formatHour(v)
    case 'number':
      return Number.isFinite(v) ? String(Math.round(v)) : '—'
    case 'multiplier':
      return `${v.toFixed(2)}×`
    default:
      return String(v)
  }
}

export function axisFormatter(hint: FormatHint | undefined): (v: number) => string {
  return (v: number) => formatValue(hint, v)
}

// Tone tokens → literal classes. Kept literal here (a file UnoCSS scans) so the
// classes are always generated even though specs reference them by token name.
export type Tone = 'default' | 'muted' | 'faint' | 'danger' | 'success' | 'warn' | 'cache' | 'accent'

const TONE_TEXT: Record<Tone, string> = {
  default: 'text-fg',
  muted: 'text-fg-2',
  faint: 'text-fg-3',
  danger: 'text-danger',
  success: 'text-success',
  warn: 'text-warn',
  cache: 'text-cache-local',
  accent: 'text-accent',
}

export function toneText(tone: Tone | undefined): string {
  return TONE_TEXT[tone ?? 'default']
}
