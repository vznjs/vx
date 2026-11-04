// The live region's panels: Warnings, Running and the live Summary,
// redrawn in place under the log by the ui module's writer.

import { paint, panelTop, type ColorSupport } from '../ui/index.js'
import {
  formatExpected,
  formatRunningHeader,
  formatTaskRow,
  paintIdParts,
  pathNote,
  type RowCells,
  unknownUsual,
} from './framed-output.js'
import type { BlockedTask } from './forecast.js'

const NO_COLOR: ColorSupport = { enabled: false }

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
    paint('error', '\u25fc\uFE0E', colors),
    durationMs,
    'failed',
    'error',
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
    ok ? paint('ok', '\u23fa\uFE0E', colors) : paint('error', '\u25fc\uFE0E', colors),
    durationMs,
    ok ? 'success' : 'failed',
    ok ? 'ok' : 'error',
    INTERNAL,
    '',
    paintPinnedId(id, colors),
    colors,
    { worker: 'local' },
  )
}

/** `rows` in a panel titled `title`, counted. */
function panel(title: string, count: string, rows: readonly string[], c: ColorSupport): string[] {
  return [panelTop(title, c, count), ...rows]
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
  const dim = (t: string) => paint('muted', t, colors)
  // A task's usual duration, the live list's `usual` cell: `~18s`.
  const usualOf = (id: string): { text: string; painted: string } => {
    if (s.usual === undefined) return { text: '', painted: '' }
    const ms = s.usual(id)
    if (ms === undefined) return unknownUsual(colors)
    const text = formatExpected(ms)
    return { text, painted: dim(text) }
  }
  // The Running panel's rows; its box and header go round them below.
  const lines: string[] = []
  // Persistent (dev-server) rows: ▸ glyph, no elapsed, `running`, no
  // cache state (it's still alive).
  for (const id of s.pinnedPersistent) {
    lines.push(
      formatTaskRow(
        paint('info', '▸', colors),
        null,
        'running',
        'info',
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
          'warn',
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
        'info',
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
        'info',
        INTERNAL,
        '',
        paintPinnedId(step.id, colors),
        colors,
        { worker: 'local' },
      ),
    )
  }
  // Panels top to bottom: what runs now, then the live Summary, the same panel the final printout is, so the region
  // BECOMES the summary when the run ends.
  const out: string[] = []
  if (lines.length > 0)
    out.push(
      '',
      ...panel(
        'Running',
        String(s.pinnedPersistent.length + running.length + (s.steps?.length ?? 0)),
        [formatRunningHeader(colors), ...lines],
        colors,
      ),
    )
  out.push(...s.summaryLines)
  return out
}
