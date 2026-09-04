// Dynamic status display for interactive runs. NOT a TUI: a
// fixed-height worker region redrawn in place with clear-line /
// cursor-up — no alternate screen.
// The writer is the serialization point for ALL logger stdout: every
// ordinary write erases the status display first, writes its content,
// then redraws, so the display can never interleave with task output.

import { paint, type ColorSupport } from './colors.js'
import { formatTaskRow, paintIdParts, TIME_COL } from './framed-output.js'

const NO_COLOR: ColorSupport = { enabled: false }
// Same palette as framed-output.ts so glyphs and stats agree.
const ACCENT = '#06b6d4'
const ERROR = '#ef4444'

/** Erase the current line and return the cursor to column 0. */
const CLEAR = '\x1b[2K\r'

export interface StatusStream {
  write(chunk: string): unknown
  isTTY?: boolean
  /**
   * Terminal width in columns. Read fresh on every draw — `process.stdout`
   * updates it on SIGWINCH, so a mid-run resize is picked up. Absent (not a
   * TTY) means the region is never drawn anyway.
   */
  columns?: number
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
  /**
   * Floor between FORCED redraws. Task events force a redraw each; a
   * 3,270-task warm run produced 6,540 forced redraws ≈ 6.7 MB of
   * ANSI to the terminal. A forced set inside the floor marks the
   * content dirty and ONE trailing draw lands the final state when
   * the floor expires. 0 disables (tests asserting synchronously).
   */
  forceFloorMs?: number
  /** Injectable clock for tests. */
  now?: () => number
}

export function createOutputWriter(
  stream: StatusStream,
  opts: OutputWriterOptions = {},
): OutputWriter {
  const enabled = (opts.enabled ?? true) && stream.isTTY === true
  const minRedrawMs = opts.minRedrawMs ?? 100
  const forceFloorMs = opts.forceFloorMs ?? 30
  const now = opts.now ?? Date.now

  let current: readonly string[] | null = null
  let shown = false
  // PHYSICAL rows the shown region occupies, not logical lines — see
  // `regionRows`.
  let shownRows = 0
  let dead = false
  let lastDraw = -Infinity
  // Trailing draw scheduled when a forced set lands inside the floor.
  let trailing: ReturnType<typeof setTimeout> | null = null
  // Streamed task output (focused mode) can end mid-line; redrawing
  // the status display would wipe the partial line, so we hold off
  // until a write restores column 0.
  let atLineStart = true

  const cancelTrailing = (): void => {
    if (trailing !== null) {
      clearTimeout(trailing)
      trailing = null
    }
  }

  /**
   * How many PHYSICAL terminal rows `lines` occupies. The terminal wraps
   * any line wider than the viewport, so a region of N logical lines can
   * cover more than N rows — and erasing by the logical count moves the
   * cursor up too few rows, leaving the top of the region on screen. It
   * accumulates, because every redraw is short by the same amount.
   *
   * Both triggers are ordinary: the summary section is a fixed 62 visible
   * columns (narrower terminal ⇒ every bar row wraps), and a task id is
   * deliberately never truncated (long id ⇒ the worker row wraps at any
   * width). Width is read per draw so a mid-run resize is handled. Width
   * must be VISIBLE width — these lines carry ANSI, which occupies no
   * column.
   *
   * Unknown width falls back to the logical count, which is a KNOWN
   * residual rather than a guarantee: a wrapped line then under-erases
   * exactly as it did before this function existed. It is deliberate,
   * because the alternatives are worse — guessing a width over-erases on a
   * wider terminal, and `ESC[J` clears to end of SCREEN, so over-erasing
   * destroys output above the region instead of merely leaving junk below
   * it. Reachable only on a TTY whose winsize ioctl fails, since a non-TTY
   * disables the region outright.
   */
  const regionRows = (lines: readonly string[]): number => {
    const cols = stream.columns
    if (cols === undefined || cols <= 0) return lines.length
    let rows = 0
    for (const line of lines) rows += Math.max(1, Math.ceil(Bun.stringWidth(line) / cols))
    return rows
  }

  // Erase sequence for whatever is currently shown. A single row keeps
  // the exact legacy bytes (ESC[2K\r); anything taller moves to its
  // top row and clears to end of screen.
  const eraseSeq = (): string => (shownRows > 1 ? `\r\x1b[${shownRows - 1}A\x1b[J` : CLEAR)

  const draw = (): void => {
    // Whatever was pending is now painted — the trailing draw would
    // only repeat these bytes.
    cancelTrailing()
    const erase = shown ? eraseSeq() : CLEAR
    stream.write(erase + current!.join('\n'))
    shown = true
    shownRows = regionRows(current!)
    lastDraw = now()
  }
  const set = (lines: readonly string[], o: { force?: boolean }): void => {
    if (!enabled || dead) return
    current = lines
    if (!atLineStart) return
    const since = now() - lastDraw
    if (o.force) {
      if (since >= forceFloorMs) {
        draw()
        return
      }
      // Coalesce the burst: `current` is already the latest state, so
      // one trailing draw at floor expiry lands it. unref — a stray
      // timer must never hold the process open.
      if (trailing === null) {
        trailing = setTimeout(() => {
          trailing = null
          if (dead || current === null || !atLineStart) return
          draw()
        }, forceFloorMs - since)
        trailing.unref?.()
      }
      return
    }
    if (since >= minRedrawMs) draw()
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
        shownRows = 0
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
      cancelTrailing()
      if (shown) {
        stream.write(eraseSeq())
        shown = false
        shownRows = 0
      }
    },
  }
}

const IDLE = '#6b7280'

export interface WorkerSlot {
  id: string
  startedMs: number
}

export interface StatusRegionState {
  /**
   * Ready persistent tasks (dev servers …) whose children keep
   * running after their outcome lands. Pinned until runEnd — the
   * orchestrator SIGTERMs them when the graph finishes, so runEnd is
   * the honest end of their life.
   */
  pinnedPersistent: readonly string[]
  /** Fixed-size slot array; null = idle worker. Index = display row. */
  slots: readonly (WorkerSlot | null)[]
  /** Running tasks beyond the displayed slots. */
  overflow: number
  /** Clock value used for per-slot elapsed (injectable for tests). */
  nowMs: number
  /**
   * The live summary section (built by the logger via
   * formatSummarySection) — the SAME section the final summary
   * prints, filling in as the run progresses. Rendered verbatim
   * below the worker rows.
   */
  summaryLines: readonly string[]
}

/** Identity-colored id, full (never truncated) — name is the last column. */
function paintPinnedId(id: string, colors: ColorSupport): string {
  const sep = id.indexOf('#')
  if (sep < 0) return id
  return paintIdParts(id.slice(0, sep), id.slice(0, sep), id.slice(sep + 1), colors)
}

/**
 * Permanent one-liner logged the moment a task fails (owner design:
 * "log the failure and continue, full frames at the end"). On the grid:
 * red ◼ glyph + exec time + `failed` + `miss` + id. The exit code and
 * output live in the framed block that replays at runEnd, not the line.
 */
export function formatFailureLine(
  id: string,
  durationMs: number | null,
  colors: ColorSupport = NO_COLOR,
  cacheWord: 'miss' | 'no-cache' = 'miss',
): string {
  return formatTaskRow(
    paint(ERROR, '◼\uFE0E', colors),
    durationMs,
    'failed',
    ERROR,
    cacheWord,
    '',
    paintPinnedId(id, colors),
    colors,
  )
}

/**
 * Worker region: pinned ready persistent tasks, one row per worker
 * slot — a task stays in its slot for its whole life so names never
 * jump — then the live summary section. Every row sits on the shared
 * column grid (see formatTaskRow), so nothing shifts with id length:
 * layout shift IS the bug this display exists to fix. Height varies
 * only when pins arrive.
 */
export function formatStatusRegion(
  s: StatusRegionState,
  colors: ColorSupport = NO_COLOR,
): string[] {
  const dim = (t: string) => paint('', t, colors, { dim: true })
  // Leading blank separates the live running region from the completed
  // task list scrolling above it (owner: "separate running from list").
  const lines: string[] = ['']
  // Persistent (dev-server) rows: ▸ glyph, no elapsed, `running`, no
  // cache state (it's still alive).
  for (const id of s.pinnedPersistent) {
    lines.push(
      formatTaskRow(
        paint(ACCENT, '▸', colors),
        null,
        'running',
        ACCENT,
        '',
        '',
        paintPinnedId(id, colors),
        colors,
      ),
    )
  }

  // Worker rows: NO glyph — the live elapsed time leads (no spinner;
  // the ticking time IS the motion), then `running`, full id (never
  // truncated — name is the last column). Idle rows hold their slot's
  // place, dim, aligned under the status column.
  for (const slot of s.slots) {
    if (slot === null) {
      lines.push(`${' '.repeat(3 + TIME_COL + 1)}${paint(IDLE, 'idle', colors, { dim: true })}`)
      continue
    }
    lines.push(
      formatTaskRow(
        ' ',
        Math.max(0, s.nowMs - slot.startedMs),
        'running',
        ACCENT,
        '',
        '',
        paintPinnedId(slot.id, colors),
        colors,
      ),
    )
  }
  if (s.overflow > 0) {
    lines.push(dim(`\u2026 +${s.overflow} more running`))
  }
  // The live summary section — identical shape to the final printout,
  // so the region visually BECOMES the summary when the run ends.
  lines.push(...s.summaryLines)
  return lines
}
