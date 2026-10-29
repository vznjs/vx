// Dynamic status display for interactive runs. NOT a TUI: a
// fixed-height worker region redrawn in place with clear-line /
// cursor-up — no alternate screen.
// The writer is the serialization point for ALL logger stdout: every
// ordinary write erases the status display first, writes its content,
// then redraws, so the display can never interleave with task output.

import { dumbTerminal, paint, type ColorSupport } from '../util/index.js'
import {
  formatListTitle,
  formatRunningHeader,
  formatTaskRow,
  paintIdParts,
  pathNote,
  type RowCells,
  unknownUsual,
} from './framed-output.js'
import type { BlockedTask } from './forecast.js'

const NO_COLOR: ColorSupport = { enabled: false }
// Same palette as framed-output.ts so glyphs and stats agree.
const ACCENT = '#06b6d4'
const ERROR = '#ef4444'
const WARN = '#eab308' // yellow-500, as the summary's
const SUCCESS = '#22c55e'

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
   * Off a TTY, hold writes and hand them to the stream once per turn of
   * the event loop until `settle()`. A warm 476-package run wrote each of
   * its 952 task lines as its own syscall (item 753). Off by default: a
   * caller reading its stream right after a write sees it.
   */
  coalesce?: boolean
}

export function createOutputWriter(
  stream: StatusStream,
  opts: OutputWriterOptions = {},
): OutputWriter {
  const enabled = (opts.enabled ?? true) && stream.isTTY === true && !dumbTerminal()
  const minRedrawMs = opts.minRedrawMs ?? 100
  const forceFloorMs = opts.forceFloorMs ?? 30
  const now = opts.now ?? Date.now
  // The coalesced writes not yet handed over; null once settled or when
  // not coalescing.
  let held: string[] | null = !enabled && opts.coalesce === true ? [] : null
  let flushQueued = false
  const flushHeld = (): void => {
    flushQueued = false
    if (held === null || held.length === 0) return
    const text = held.join('')
    held.length = 0
    stream.write(text)
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
  const lineRows = (line: string): number => {
    const cols = stream.columns
    if (cols === undefined || cols <= 0) return 1
    return Math.max(1, Math.ceil(Bun.stringWidth(line) / cols))
  }
  const regionRows = (lines: readonly string[]): number => {
    let rows = 0
    for (const line of lines) rows += lineRows(line)
    return rows
  }

  /**
   * The leading lines that fit the terminal's height, one row spared.
   * Cursor-up stops at the top of the screen, and a row that scrolled into
   * the scrollback is out of the erase's reach: a region taller than the
   * terminal left its top behind on every redraw, one stacked block per tick
   * (VS Code's short panel, 2026-10-14). The first line always shows.
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

  const draw = (): void => {
    // Whatever was pending is now painted — the trailing draw would
    // only repeat these bytes.
    cancelTrailing()
    const erase = shown ? eraseSeq() : CLEAR
    // Built here, not at the set: a warm run's task events set the
    // region hundreds of times inside one floor, and each build was a
    // forecast pass and a summary render no frame showed (200 hits on a
    // terminal: run graph 62 → 9 ms). Kept built: a write redraws it.
    if (typeof current === 'function') current = current()
    const lines = fitted(current!)
    stream.write(erase + lines.join('\n'))
    shown = true
    shownRows = regionRows(lines)
    lastDraw = now()
  }
  const set = (lines: Region, o: { force?: boolean }): void => {
    if (!enabled || dead) return
    current = lines
    if (!atLineStart || holds > 0) return
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
          if (dead || current === null || !atLineStart || holds > 0) return
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
        if (held === null) {
          stream.write(chunk)
          return
        }
        held.push(chunk)
        if (!flushQueued) {
          flushQueued = true
          setImmediate(flushHeld)
        }
        return
      }
      if (shown) {
        stream.write(eraseSeq())
        shown = false
        shownRows = 0
      }
      stream.write(chunk)
      if (chunk.length > 0) atLineStart = chunk.endsWith('\n')
      if (!dead && current !== null && atLineStart && holds === 0) draw()
    },
    writeTo(target, chunk) {
      if (target === stream) return this.write(chunk)
      // Held stdout is older than this chunk.
      flushHeld()
      if (!enabled) {
        target.write(chunk)
        return
      }
      if (shown) {
        stream.write(eraseSeq())
        shown = false
        shownRows = 0
      }
      target.write(chunk)
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
      if (shown) {
        stream.write(eraseSeq())
        shown = false
        shownRows = 0
      }
    },
    hold() {
      if (!enabled || dead) return () => undefined
      holds++
      cancelTrailing()
      if (shown) {
        stream.write(eraseSeq())
        shown = false
        shownRows = 0
      }
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

export interface WorkerSlot {
  id: string
  startedMs: number
  /** Its executor holds it for a machine to begin it (`TaskExecutor.running` is `null`). */
  waiting?: boolean
  /** Its cache cell: `no-cache` for a task that caches nothing, else `miss` (the default). */
  cache?: 'miss' | 'no-cache'
}

/** What a running task's process tree uses now. */
export interface LiveUsage {
  cores: number
  rssBytes: number
}

export interface StatusRegionState {
  /** The running task at the head of the longest unfinished chain. */
  critical?: string
  /** Where a running task runs, when not here (`TaskExecutor.running`); its row shows it. */
  where?: (taskId: string) => string | null | undefined
  /**
   * A task's usual duration from history, undefined for one it never
   * timed; its row shows it, `unknown` for none. Absent: no history to ask.
   */
  usual?: (taskId: string) => number | undefined
  /** A running task's live CPU and memory; its row's `cpu` and `mem`. */
  usage?: (taskId: string) => LiveUsage | undefined
  /**
   * Ready persistent tasks (dev servers …) whose children keep
   * running after their outcome lands. Pinned until runEnd — the
   * orchestrator SIGTERMs them when the graph finishes, so runEnd is
   * the honest end of their life.
   */
  pinnedPersistent: readonly string[]
  /** The running tasks by slot, null for a free one; a task past the slots follows them. */
  slots: readonly (WorkerSlot | null)[]
  /** The list's height: one row per worker, whatever runs, so it never jumps. */
  size?: number
  /**
   * The tasks the scheduler has picked for the next free workers, each
   * nested under the running task it waits on, in the rows no running task
   * takes; nothing further ahead.
   */
  next?: readonly BlockedTask[]
  /** Each running task's count of the tasks it holds back: its `blocked` cell. */
  blockedBy?: ReadonlyMap<string, number>
  /** The run was stopped: running rows say `aborting`, idle rows leave. */
  stopping?: boolean
  /**
   * vx's own steps still running, shown below the worker rows: no worker
   * slot or `--concurrency` bounds them (2026-10-15).
   */
  steps?: readonly WorkerSlot[]
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
  if (sep >= 0) return paintIdParts(id.slice(0, sep), id.slice(0, sep), id.slice(sep + 1), colors)
  // One of vx's own steps: `<owner>:<step>`, painted as a task id is.
  const step = id.lastIndexOf(':')
  if (step < 0) return id
  const owner = id.slice(0, step)
  return paintIdParts(owner, owner, id.slice(step + 1), colors, { sep: ':' })
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
  cells: RowCells = {},
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
    cells,
  )
}

/** A step's cache column, dim as `no-cache` is. */
const INTERNAL = 'internal'

/**
 * The list row of one of vx's own steps (`vx:uploads`), on the task grid
 * with `internal` in the cache column: a step is no task and caches
 * nothing (2026-10-16: `4.60s success internal vx:keep-run`).
 */
export function formatStepLine(
  id: string,
  durationMs: number,
  ok: boolean,
  colors: ColorSupport = NO_COLOR,
): string {
  return formatTaskRow(
    ok ? paint(SUCCESS, '\u23fa\uFE0E', colors) : paint(ERROR, '\u25fc\uFE0E', colors),
    durationMs,
    ok ? 'success' : 'failed',
    ok ? SUCCESS : ERROR,
    INTERNAL,
    '',
    paintPinnedId(id, colors),
    colors,
    { worker: 'local' },
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
  // A task's usual duration, the live list's `usual` cell: `~18s`.
  const usualOf = (id: string): { text: string; painted: string } => {
    if (s.usual === undefined) return { text: '', painted: '' }
    const ms = s.usual(id)
    if (ms === undefined) return unknownUsual(colors)
    const text = formatExpected(ms)
    return { text, painted: dim(text) }
  }
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
        { worker: 'local' },
      ),
    )
  }

  // Running rows: NO glyph — the live elapsed time leads (no spinner;
  // the ticking time IS the motion), then `running`, the usual duration,
  // how many tasks wait on it, and the full id (never truncated — name is
  // the last column). The rows no task runs in hold the tasks planned
  // next, each nested under what it waits on. No blank rows pad the list
  // to the worker count: a run using 2 of 12 workers left 10 empty lines
  // between its rows and the footer (2026-10-29).
  const running = s.slots.filter((x): x is WorkerSlot => x !== null && x.waiting !== true)
  // Placed by an executor (DTE), the list is what runs: blocked tasks are
  // the tasks line's count alone, and its size is no machine's.
  const placed = s.where !== undefined
  const free = Math.max(0, (s.size ?? 0) - running.length)
  const nested = new Map<string, BlockedTask[]>()
  if (!placed && s.stopping !== true) {
    const ids = new Set(running.map((x) => x.id))
    let n = 0
    for (const b of s.next ?? []) {
      if (n === free) break
      if (!ids.has(b.by)) continue
      let list = nested.get(b.by)
      if (list === undefined) nested.set(b.by, (list = []))
      list.push(b)
      n++
    }
  }
  for (const slot of running) {
    if (s.stopping === true) {
      lines.push(
        formatTaskRow(
          ' ',
          Math.max(0, s.nowMs - slot.startedMs),
          'aborting',
          WARN,
          '',
          '',
          paintPinnedId(slot.id, colors),
          colors,
          { worker: s.where?.(slot.id) ?? 'local' },
        ),
      )
      continue
    }
    const at = s.where?.(slot.id)
    const use = s.usage?.(slot.id)
    lines.push(
      formatTaskRow(
        ' ',
        Math.max(0, s.nowMs - slot.startedMs),
        'running',
        ACCENT,
        slot.cache ?? 'miss',
        '',
        paintPinnedId(slot.id, colors),
        colors,
        {
          usual: usualOf(slot.id),
          ...(use !== undefined ? { cpu: use.cores, memBytes: use.rssBytes } : {}),
          blocks: String(s.blockedBy?.get(slot.id) ?? 0),
          worker: at ?? 'local',
        },
      ) + (s.critical === slot.id ? pathNote(colors) : ''),
    )
    for (const b of nested.get(slot.id) ?? []) {
      lines.push(
        formatTaskRow(
          ' ',
          null,
          'blocked',
          '',
          '',
          '',
          `${dim('\u2514')} ${paintPinnedId(b.id, colors)}`,
          colors,
          { usual: usualOf(b.id) },
        ),
      )
    }
  }
  for (const step of s.steps ?? []) {
    lines.push(
      formatTaskRow(
        ' ',
        Math.max(0, s.nowMs - step.startedMs),
        'running',
        ACCENT,
        INTERNAL,
        '',
        paintPinnedId(step.id, colors),
        colors,
        { worker: 'local' },
      ),
    )
  }
  if (lines.length > 1)
    lines.splice(1, 0, formatListTitle('Running', colors), formatRunningHeader(colors))
  // The live summary section — identical shape to the final printout,
  // so the region visually BECOMES the summary when the run ends.
  lines.push(...s.summaryLines)
  return lines
}

/**
 * A running task's usual duration, fixed while the elapsed time counts up
 * toward it (2026-10-14): `~5.2s`, `~42s`, `~2m 05s`. Fits the cache
 * column below 100 minutes.
 */
function formatExpected(ms: number): string {
  // The tier by the rounded value: 999.6 ms printed `~1000ms` (item 1034's class).
  if (Math.round(ms) < 1000) return `~${Math.round(ms)}ms`
  if (ms < 9950) return `~${(ms / 1000).toFixed(1)}s`
  const s = Math.round(ms / 1000)
  if (s < 60) return `~${s}s`
  return `~${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}
