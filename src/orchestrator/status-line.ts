// Single bottom status line for interactive runs. NOT a TUI: one
// `\r` + ESC[2K rewrite of the current line — no alternate screen, no
// cursor addressing. The writer is the serialization point for ALL
// logger stdout: every ordinary write clears the status line first,
// writes its content, then redraws the line, so the status line can
// never interleave with task output.

import { paint, type ColorSupport } from './colors.js'

const NO_COLOR: ColorSupport = { enabled: false }
const ERROR = '#ef4444'

/** Erase the current line and return the cursor to column 0. */
const CLEAR = '\x1b[2K\r'

export interface StatusStream {
  write(chunk: string): unknown
  isTTY?: boolean
}

export interface OutputWriter {
  /** True only when the stream is a TTY and the run isn't CI. */
  readonly enabled: boolean
  /** Serialized content write: clear status → content → redraw. */
  write(chunk: string): void
  /**
   * Replace the status line's content. Redraws are throttled to
   * `minRedrawMs` unless `force` (task start/finish) is set.
   */
  setStatus(line: string, opts?: { force?: boolean }): void
  /** Permanently remove the status line; later setStatus is a no-op. */
  clearStatus(): void
}

export interface OutputWriterOptions {
  /** Master switch on top of the TTY check (false in CI). */
  enabled?: boolean
  /** Minimum interval between unforced redraws. */
  minRedrawMs?: number
  /** Injectable clock for tests. */
  now?: () => number
}

export function createOutputWriter(
  stream: StatusStream,
  opts: OutputWriterOptions = {},
): OutputWriter {
  const enabled = (opts.enabled ?? true) && stream.isTTY === true
  const minRedrawMs = opts.minRedrawMs ?? 100
  const now = opts.now ?? Date.now

  let current: string | null = null
  let shown = false
  let dead = false
  let lastDraw = -Infinity
  // Streamed task output (focused mode) can end mid-line; redrawing
  // the status line would wipe the partial line, so we hold off until
  // a write restores column 0.
  let atLineStart = true

  const draw = (): void => {
    stream.write(CLEAR + current)
    shown = true
    lastDraw = now()
  }

  return {
    enabled,
    write(chunk) {
      if (!enabled) {
        stream.write(chunk)
        return
      }
      if (shown) {
        stream.write(CLEAR)
        shown = false
      }
      stream.write(chunk)
      if (chunk.length > 0) atLineStart = chunk.endsWith('\n')
      if (!dead && current !== null && atLineStart) draw()
    },
    setStatus(line, o = {}) {
      if (!enabled || dead) return
      current = line
      if (!atLineStart) return
      if (o.force || now() - lastDraw >= minRedrawMs) draw()
    },
    clearStatus() {
      if (!enabled || dead) return
      dead = true
      current = null
      if (shown) {
        stream.write(CLEAR)
        shown = false
      }
    },
  }
}

export interface StatusLineState {
  /** Ids of currently-running tasks, start order. */
  running: readonly string[]
  done: number
  total: number
  failed: number
  elapsedMs: number
}

/**
 * `▶ 2 running · 5/12 · one#build, two#build · 4s` plus a red
 * ` · n failed` tail when anything failed. At most two running ids —
 * the line must stay a line.
 */
export function formatStatusLine(s: StatusLineState, colors: ColorSupport = NO_COLOR): string {
  const parts = [`▶ ${s.running.length} running`, `${s.done}/${s.total}`]
  if (s.running.length > 0) parts.push(s.running.slice(0, 2).join(', '))
  parts.push(`${Math.floor(s.elapsedMs / 1000)}s`)
  if (s.failed > 0) parts.push(paint(ERROR, `${s.failed} failed`, colors))
  return parts.join(' · ')
}
