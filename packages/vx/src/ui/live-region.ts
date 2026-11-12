// The live region: a block of lines redrawn in place under the log, with
// clear-line / cursor-up and no alternate screen (NOT a TUI). The writer is
// the serialization point for ALL of a screen's output: every ordinary write
// erases the region first, writes its content, then redraws, so the region
// never interleaves with what scrolls above it.

import { rawBytes } from '../util/index.js'
import { dumbTerminal } from './theme.js'

/** Erase the current line and return the cursor to column 0. */
const CLEAR = '\x1b[2K\r'

export interface StatusStream {
  write(chunk: string | Uint8Array): unknown
  isTTY?: boolean
  /**
   * Terminal width in columns. Read fresh on every draw — `process.stdout`
   * updates it on SIGWINCH, so a mid-run resize is picked up. Absent (not a
   * TTY) means the region is never drawn anyway.
   */
  columns?: number
  /** Terminal height in rows, read per draw as `columns` is. */
  rows?: number
}

/** A region's lines, or what builds them when it is drawn. */
export type Region = readonly string[] | (() => readonly string[])

export interface OutputWriter {
  /** True only when the stream is a TTY and the run isn't CI. */
  readonly enabled: boolean
  /** Serialized content write: erase status → content → redraw. */
  write(chunk: string): void
  /**
   * The same, to another stream on the same terminal (stderr): the region
   * on this one is erased first and redrawn after.
   */
  writeTo(target: StatusStream, chunk: string): void
  /**
   * Replace the status line's content. Redraws are throttled to
   * `minRedrawMs` unless `force` (task start/finish) is set.
   */
  setStatus(line: string, opts?: { force?: boolean }): void
  /**
   * Replace the multi-line status region. Same throttle contract as
   * `setStatus`; the two share one display slot. A function is called
   * when the region is next drawn, once: a set the throttle coalesces
   * builds nothing.
   */
  setRegion(lines: Region, opts?: { force?: boolean }): void
  /** Hand over what `coalesce` holds and write straight through from now on. */
  settle(): void
  /** Permanently remove the status display; later set* is a no-op. */
  clearStatus(): void
  /**
   * Erase the status display and draw none until the returned release:
   * a prompt on the terminal (a secret's) waits for its answer there.
   */
  hold(): () => void
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
  /**
   * Off a TTY, hold writes and hand them to the stream once per turn of the
   * event loop, or once 64 KiB are held, until `settle()`. A warm 476-package
   * run wrote each of its 952 task lines as its own syscall. Off by default: a
   * caller reading its stream right after a write sees it.
   */
  coalesce?: boolean
  /** Floor between two coalesced writes; 0 writes once per turn. */
  coalesceMs?: number
}

/** What `coalesce` holds before it writes without waiting for the turn's end. */
const HELD_MAX_CHARS = 64 * 1024

/** The longest piece of a string handed to the stream in one write. */
const WRITE_SLICE_CHARS = 1024 * 1024

/**
 * `text` in slices: a stream encodes a string whole before it writes, and
 * a frame's furniture makes its text two bytes a character, so one 100 MB
 * frame took ~300 MB more to write than to build.
 */
function writeSliced(stream: StatusStream, text: string): void {
  let at = 0
  while (text.length - at > WRITE_SLICE_CHARS) {
    let end = at + WRITE_SLICE_CHARS
    // Never between the halves of a surrogate pair.
    const c = text.charCodeAt(end - 1)
    if (c >= 0xd800 && c <= 0xdbff) end--
    stream.write(rawBytes(text.slice(at, end)))
    at = end
  }
  stream.write(rawBytes(at === 0 ? text : text.slice(at)))
}

export function createOutputWriter(
  stream: StatusStream,
  opts: OutputWriterOptions = {},
): OutputWriter {
  const enabled = (opts.enabled ?? true) && stream.isTTY === true && !dumbTerminal()
  const minRedrawMs = opts.minRedrawMs ?? 100
  const forceFloorMs = opts.forceFloorMs ?? 30
  const now = opts.now ?? Date.now
  const coalesceMs = opts.coalesceMs ?? 25
  // The coalesced writes not yet handed over; null once settled or when
  // not coalescing.
  let held: string[] | null = !enabled && opts.coalesce === true ? [] : null
  let heldChars = 0
  let flushQueued = false
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let lastFlush = -Infinity
  const writeHeld = (): void => {
    if (held === null || held.length === 0) return
    const text = held.join('')
    held.length = 0
    heldChars = 0
    lastFlush = now()
    writeSliced(stream, text)
  }
  const flushHeld = (): void => {
    flushQueued = false
    if (flushTimer !== null) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    writeHeld()
  }

  let current: Region | null = null
  let shown = false
  // PHYSICAL rows the shown region occupies, not logical lines — see
  // `regionRows`.
  let shownRows = 0
  let dead = false
  let holds = 0
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
  // A line's rows, memoized per width: most of a frame's lines are the
  // last frame's, and measuring each one again was the most of a redraw's
  // CPU (a 2,000-task run's profile).
  let rowsWidth = -1
  const rowsOf = new Map<string, number>()
  const lineRows = (line: string): number => {
    const cols = stream.columns
    if (cols === undefined || cols <= 0) return 1
    if (cols !== rowsWidth || rowsOf.size > 4096) {
      rowsWidth = cols
      rowsOf.clear()
    }
    let rows = rowsOf.get(line)
    if (rows === undefined) {
      rows = Math.max(1, Math.ceil(Bun.stringWidth(line) / cols))
      rowsOf.set(line, rows)
    }
    return rows
  }
  const regionRows = (lines: readonly string[]): number => {
    let rows = 0
    for (const line of lines) rows += lineRows(line)
    return rows
  }

  /**
   * The leading lines that fit the terminal's height, one row spared. Cursor-up
   * stops at the top of the screen, and a row that scrolled into the scrollback
   * is out of the erase's reach: a region taller than the terminal left its top
   * behind on every redraw, one stacked block per tick (VS Code's short panel).
   * The first line always shows.
   */
  const fitted = (lines: readonly string[]): readonly string[] => {
    const height = stream.rows
    if (height === undefined || height <= 0) return lines
    let rows = 0
    let n = 0
    for (const line of lines) {
      rows += lineRows(line)
      if (n > 0 && rows > height - 1) break
      n++
    }
    return n === lines.length ? lines : lines.slice(0, n)
  }

  // Erase sequence for whatever is currently shown. A single row keeps
  // the exact legacy bytes (ESC[2K\r); anything taller moves to its
  // top row and clears to end of screen.
  const eraseSeq = (): string => (shownRows > 1 ? `\r\x1b[${shownRows - 1}A\x1b[J` : CLEAR)

  // Content written since the last frame, drawn with it: one write per
  // frame, the region erased and redrawn once around all of it. Each row
  // used to be three writes (erase, row, region) and a whole region
  // redraw: 2,000 rows wrote 8.5 MB.
  const pending: string[] = []
  // The region's text as last written: a frame that would write the same
  // bytes writes nothing.
  let shownText = ''

  /** Write what is pending and, where it may show, the region: one write. */
  const draw = (): void => {
    cancelTrailing()
    let text = ''
    const content = pending.length > 0
    if (content) {
      text = (shown ? eraseSeq() : '') + pending.join('')
      pending.length = 0
      shown = false
      shownRows = 0
    }
    if (!dead && current !== null && atLineStart && holds === 0) {
      // Built here, not at the set: a warm run's task events set the
      // region hundreds of times inside one floor, and each build was a
      // forecast pass and a summary render no frame showed (200 hits on a
      // terminal: run graph 62 → 9 ms). Kept built: a write redraws it.
      if (typeof current === 'function') current = current()
      const lines = fitted(current!)
      const region = lines.join('\n')
      if (shown && region === shownText) {
        if (text !== '') stream.write(rawBytes(text))
        lastDraw = now()
        return
      }
      text += (shown ? eraseSeq() : CLEAR) + region
      shown = true
      shownRows = regionRows(lines)
      shownText = region
    }
    if (text !== '') stream.write(rawBytes(text))
    lastDraw = now()
  }
  /**
   * The next frame: now if the floor has passed since the last one, else
   * once it does. A timer holding content keeps the process open until it
   * lands; one that only redraws the region never does.
   */
  const frame = (): void => {
    const since = now() - lastDraw
    if (since >= forceFloorMs) {
      draw()
      return
    }
    if (trailing === null) {
      trailing = setTimeout(() => {
        trailing = null
        draw()
      }, forceFloorMs - since)
      if (pending.length === 0) trailing.unref?.()
    } else if (pending.length > 0) trailing.ref?.()
  }
  const set = (lines: Region, o: { force?: boolean }): void => {
    if (!enabled || dead) return
    current = lines
    if (!atLineStart || holds > 0) return
    if (o.force) {
      // A burst coalesces: `current` is already the latest state, so one
      // frame at the floor's expiry lands it.
      frame()
      return
    }
    const since = now() - lastDraw
    if (since >= minRedrawMs) draw()
  }

  return {
    enabled,
    write(chunk) {
      if (!enabled) {
        if (held === null) {
          writeSliced(stream, chunk)
          return
        }
        // A big write goes as it is: joined with what is held, it was copied.
        if (chunk.length >= HELD_MAX_CHARS) {
          writeHeld()
          writeSliced(stream, chunk)
          return
        }
        held.push(chunk)
        heldChars += chunk.length
        // A warm run replays its hits without yielding to the event loop,
        // so the turn's end came only after every hit's log: 500 hits
        // printing 1 MiB each were held at once (2 GB of heap).
        if (heldChars >= HELD_MAX_CHARS) {
          writeHeld()
          return
        }
        if (!flushQueued) {
          flushQueued = true
          // At most one write per floor: a restore settles its hits over
          // hundreds of turns, and a write per turn cost the 9,603-task restore
          // ~100 ms of its main thread.
          const wait = lastFlush + coalesceMs - now()
          if (wait > 0) flushTimer = setTimeout(flushHeld, wait)
          else setImmediate(flushHeld)
        }
        return
      }
      if (chunk.length > 0) atLineStart = chunk.endsWith('\n')
      pending.push(chunk)
      // A held terminal (a prompt waits on it) or a dead region takes the
      // write now: nothing will draw a frame for it.
      if (holds > 0 || dead) draw()
      else frame()
    },
    writeTo(target, chunk) {
      if (target === stream) return this.write(chunk)
      // Held stdout is older than this chunk.
      flushHeld()
      if (!enabled) {
        target.write(rawBytes(chunk))
        return
      }
      // What this stream holds is older than the chunk: it lands first,
      // with the region erased, and the region returns after the chunk.
      let text = pending.join('')
      pending.length = 0
      if (shown) {
        text = eraseSeq() + text
        shown = false
        shownRows = 0
      }
      if (text !== '') stream.write(rawBytes(text))
      target.write(rawBytes(chunk))
      if (!dead && current !== null && atLineStart && holds === 0) draw()
    },
    setStatus(line, o = {}) {
      set([line], o)
    },
    setRegion(lines, o = {}) {
      set(lines, o)
    },
    settle() {
      flushHeld()
      held = null
    },
    clearStatus() {
      if (!enabled || dead) return
      dead = true
      current = null
      cancelTrailing()
      // Content still waiting for a frame lands now, over the erased region.
      let text = pending.join('')
      pending.length = 0
      if (shown) {
        text = eraseSeq() + text
        shown = false
        shownRows = 0
      }
      if (text !== '') stream.write(rawBytes(text))
    },
    hold() {
      if (!enabled || dead) return () => undefined
      holds++
      cancelTrailing()
      let text = pending.join('')
      pending.length = 0
      if (shown) {
        text = eraseSeq() + text
        shown = false
        shownRows = 0
      }
      if (text !== '') stream.write(rawBytes(text))
      let released = false
      return () => {
        if (released) return
        released = true
        holds--
        if (holds === 0 && !dead && current !== null && atLineStart) draw()
      }
    },
  }
}
