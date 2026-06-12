// Dynamic status display for interactive runs. NOT a TUI: a
// fixed-height worker region redrawn in place with clear-line /
// cursor-up — no alternate screen.
// The writer is the serialization point for ALL logger stdout: every
// ordinary write erases the status display first, writes its content,
// then redraws, so the display can never interleave with task output.

import { paint, type ColorSupport } from './colors.js'
import { paintIdParts } from './framed-output.js'

const NO_COLOR: ColorSupport = { enabled: false }
// Same palette as framed-output.ts so glyphs and stats agree.
const ACCENT = '#06b6d4'
const SUCCESS = '#22c55e'
const WARN = '#eab308'
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
  /** Serialized content write: erase status → content → redraw. */
  write(chunk: string): void
  /**
   * Replace the status line's content. Redraws are throttled to
   * `minRedrawMs` unless `force` (task start/finish) is set.
   */
  setStatus(line: string, opts?: { force?: boolean }): void
  /**
   * Replace the multi-line status region. Same throttle contract as
   * `setStatus`; the two share one display slot.
   */
  setRegion(lines: readonly string[], opts?: { force?: boolean }): void
  /** Permanently remove the status display; later set* is a no-op. */
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

  let current: readonly string[] | null = null
  let shown = false
  let shownHeight = 0
  let dead = false
  let lastDraw = -Infinity
  // Streamed task output (focused mode) can end mid-line; redrawing
  // the status display would wipe the partial line, so we hold off
  // until a write restores column 0.
  let atLineStart = true

  // Erase sequence for whatever is currently shown. Single line keeps
  // the exact legacy bytes (ESC[2K\r); a taller region moves to its
  // top line and clears to end of screen.
  const eraseSeq = (): string => (shownHeight > 1 ? `\r\x1b[${shownHeight - 1}A\x1b[J` : CLEAR)

  const draw = (): void => {
    const erase = shown ? eraseSeq() : CLEAR
    stream.write(erase + current!.join('\n'))
    shown = true
    shownHeight = current!.length
    lastDraw = now()
  }
  const set = (lines: readonly string[], o: { force?: boolean }): void => {
    if (!enabled || dead) return
    current = lines
    if (!atLineStart) return
    if (o.force || now() - lastDraw >= minRedrawMs) draw()
  }

  return {
    enabled,
    write(chunk) {
      if (!enabled) {
        stream.write(chunk)
        return
      }
      if (shown) {
        stream.write(eraseSeq())
        shown = false
        shownHeight = 0
      }
      stream.write(chunk)
      if (chunk.length > 0) atLineStart = chunk.endsWith('\n')
      if (!dead && current !== null && atLineStart) draw()
    },
    setStatus(line, o = {}) {
      set([line], o)
    },
    setRegion(lines, o = {}) {
      set(lines, o)
    },
    clearStatus() {
      if (!enabled || dead) return
      dead = true
      current = null
      if (shown) {
        stream.write(eraseSeq())
        shown = false
        shownHeight = 0
      }
    },
  }
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const IDLE = '#6b7280'
/** Slot-id column never exceeds this; longer ids middle-truncate. */
const MAX_ID_WIDTH = 40

export interface WorkerSlot {
  id: string
  startedMs: number
}

export interface StatusRegionState {
  /** Fixed-size slot array; null = idle worker. Index = display row. */
  slots: readonly (WorkerSlot | null)[]
  done: number
  total: number
  succeeded: number
  upToDate: number
  restoredLocal: number
  restoredRemote: number
  failed: number
  /** Running tasks beyond the displayed slots. */
  overflow: number
  elapsedMs: number
  /** Clock value used for per-slot elapsed (injectable for tests). */
  nowMs: number
  /** Monotonic redraw counter driving the spinner animation. */
  spinnerFrame: number
}

/** Elapsed run time as mm:ss (61s → 01:01). */
function formatClock(ms: number): string {
  const total = Math.floor(ms / 1000)
  const m = Math.floor(total / 60)
  const sec = total % 60
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

function truncateId(id: string, width: number): string {
  if (id.length <= width) return id
  const head = Math.ceil((width - 1) / 2)
  const tail = width - 1 - head
  return `${id.slice(0, head)}…${id.slice(id.length - tail)}`
}

/**
 * Identity-colored slot id padded to `width` by VISIBLE length (the
 * ANSI escapes from paintIdParts would defeat padEnd). The hue hashes
 * from the FULL project name so it survives truncation; if truncation
 * ate the separator the remnant prints plain.
 */
function paintSlotId(id: string, width: number, colors: ColorSupport): string {
  const vis = truncateId(id, width)
  const pad = ' '.repeat(Math.max(0, width - vis.length))
  const sep = vis.indexOf('#')
  if (sep < 0) return vis + pad
  const fullProject = id.slice(0, id.indexOf('#'))
  return paintIdParts(fullProject, vis.slice(0, sep), vis.slice(sep + 1), colors) + pad
}

/**
 * Fixed-height worker region. One row per worker slot — a task stays
 * in its slot for its whole life, so names never jump — plus a stats
 * line at the bottom: two labeled groups (run progress, then cache
 * provenance) with every bucket always present in fixed order (stable
 * layout beats compactness: layout shift IS the bug this display
 * exists to fix).
 */
export function formatStatusRegion(
  s: StatusRegionState,
  colors: ColorSupport = NO_COLOR,
): string[] {
  const spin = SPINNER[s.spinnerFrame % SPINNER.length]!
  const width = Math.min(
    Math.max(4, ...s.slots.map((slot) => (slot ? slot.id.length : 0))),
    MAX_ID_WIDTH,
  )
  // No worker indexes — the rows ARE the workers (the header already
  // states the pool size). Idle rows hold their place dimmed so the
  // region height never changes.
  const lines = s.slots.map((slot) => {
    if (slot === null) return `  ${paint(IDLE, 'idle', colors, { dim: true })}`
    const elapsed = `${(Math.max(0, s.nowMs - slot.startedMs) / 1000).toFixed(1)}s`
    return `${spin} ${paintSlotId(slot.id, width, colors)} ${elapsed}`
  })
  // Labeled colored pairs in two groups: run progress, then cache
  // provenance. Every bucket always present in fixed order.
  const dim = (t: string) => paint('', t, colors, { dim: true })
  const progress = [
    paint(ERROR, `${s.failed} failed`, colors),
    paint(SUCCESS, `${s.succeeded} success`, colors),
    paint(WARN, `${s.total - s.done} left`, colors),
    paint(ACCENT, `${s.total} total`, colors),
  ].join(' · ')
  const cache = [
    paint(ERROR, `${s.succeeded + s.failed} miss`, colors),
    paint(SUCCESS, `${s.upToDate} up-to-date`, colors),
    paint(WARN, `${s.restoredLocal} local`, colors),
    paint(ACCENT, `${s.restoredRemote} remote`, colors),
  ].join(' · ')
  let stats = `▶ ${progress} ${dim('│')} ${cache} ${dim('│')} ${formatClock(s.elapsedMs)}`
  if (s.overflow > 0) stats += ` · +${s.overflow} more`
  lines.push(stats)
  return lines
}
