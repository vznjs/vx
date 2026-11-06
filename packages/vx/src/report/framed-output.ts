// Turbo-style header + per-task framed output.
//
// Header:
//   • vx 0.0.0
//
//      • Packages in scope: @vzn/vx, @repo/ui
//      • Running ci in 2 packages
//      • Remote caching disabled
//
// Per-task block:
//   ┌─ @vzn/vx#lint > success
//   ├─ command
//   oxlint --type-aware --type-check
//   ├─ stdout
//   Found 0 warnings and 0 errors.
//   └─ @vzn/vx#lint ── (327ms) success
//
// Content lines are RAW — no left border, no indent. A border would
// collide with terminal wrapping on long lines and pollute
// copy/paste; the dim ├─ section headers carry the structure instead
// (owner feedback, 2026-06).
//
// Output is buffered per-task and the whole block is emitted at task
// completion — concurrent tasks don't interleave their lines, but the
// price is no live progress within a task. This matches Turbo's
// `--ui=stream` mode.

import { withForwardArgs } from '../exec/index.js'
import { isCacheHit, isGroupTask, type TaskNode, type TaskOutcome } from '../graph/index.js'
import { formatElapsed, maskedCommand, printable } from '../util/index.js'
import * as ui from '../ui/index.js'
import {
  fileMemo,
  hasEscape,
  idParts,
  lastRedraw,
  leavesStyle,
  linkPaths,
  paint,
  ruleWidth,
  STYLE_END,
  type ColorSupport,
  type Style,
} from '../ui/index.js'
import { neverStarted } from './summary.js'
import { outcomeLabel, outcomeWord, ranNoCache, skippedReason } from './events.js'

const NO_COLOR: ColorSupport = { enabled: false }
/** A piece of a task's output, as written: `err` for stderr. */
export interface OutputChunk {
  text: string
  err: boolean
}

export interface TaskBlockBody {
  /** What the task wrote, in order. Renders under `├─ OUTPUT`, stderr lines marked. */
  output?: readonly OutputChunk[]
  /**
   * Characters the capture dropped from the head of each stream. Non-zero
   * only for a task whose output is bounded (a persistent one — nothing
   * else can outrun its own exit), and rendered so a capped log can never
   * read as a complete one.
   */
  droppedStdout?: number
  droppedStderr?: number
}

export function formatTaskBlock(
  node: TaskNode,
  outcome: TaskOutcome,
  body: TaskBlockBody,
  colors: ColorSupport = NO_COLOR,
  // Force the `$ cmd` line even for cache hits. Focused requested
  // tasks set this so a requested task's frame is identical whether it
  // ran or was cached — you asked for it, you see what it would run.
  forceCommand = false,
  forwardArgs: readonly string[] = [],
  // The terminal opens OSC 8 links: a failed task's paths become links.
  links = false,
): string {
  // Group tasks (no `exec`) do no work and have no body — they're
  // organizational nodes the user wrote so a `vx run ci` invocation
  // has a single name to address. Showing an empty box for them is
  // pure noise. Same exclusion the summary totals + analytics
  // pass already make.
  if (isGroupTask(node)) return ''

  const output = body.output ?? []

  const idPainted = paintTaskId(node, colors, { bold: true })
  const corner = (s: string) => paint('muted', s, colors)
  // A ready server's frame reads as the live one does: marked, and running.
  const mark = persistentMark(node, colors)
  const running = mark !== '' && outcome.status === 'success' && outcome.serverExit === undefined
  const header = running ? paint('info', 'running', colors) : formatBlockHeader(outcome, colors)
  const lines: string[] = [`${corner('┌─')} ${mark}${idPainted} ${corner('>')} ${header}`]

  // The command section shows what actually ran — executed tasks
  // (success and failed). Cache hits normally skip it (the stored
  // output is the interesting part), but `forceCommand` keeps it for
  // focused requested tasks so their frame is hit/miss-identical.
  if (forceCommand || outcome.status === 'success' || outcome.status === 'failed') {
    // No section label for the command (owner cut it) — the dim `$ `
    // line under the header reads as the command on its own.
    lines.push('', corner(`$ ${shownCommand(node, forwardArgs)}`), '')
  }

  const isFile = links && outcome.status === 'failed' ? fileMemo() : undefined
  const link =
    isFile === undefined ? undefined : (t: string) => linkPaths(t, node.projectDir, isFile)
  pushOutputSection(
    lines,
    output,
    (body.droppedStdout ?? 0) + (body.droppedStderr ?? 0),
    colors,
    link,
  )

  lines.push(...violationSection(outcome, colors))

  lines.push(
    `${corner('└─')} ${mark}${idPainted}${whereNote(outcome, colors)} ${corner('──')}${running ? runningFooter(outcome, colors) : formatBlockFooter(outcome, colors)}`,
  )
  return lines.join('\n') + '\n'
}

/** What a bounded capture dropped from its head, so a capped log never reads as whole. */
function droppedNote(lost: number, colors: ColorSupport): string {
  return paint('muted', `… ${lost} earlier character${lost === 1 ? '' : 's'} dropped`, colors)
}

/**
 * One `├─ <LABEL>` section of captured output, with the head-dropped notice
 * when the capture was bounded. Shared by the task frame and the persistent
 * tail block so the two renderings of the same bytes cannot drift.
 */
function pushStreamSection(
  lines: string[],
  text: string,
  title: string,
  color: Style,
  lost: number,
  colors: ColorSupport,
): void {
  if (text.trim().length === 0) return
  lines.push(sectionLine(title, color, colors), '')
  if (lost > 0) {
    lines.push(droppedNote(lost, colors))
  }
  pushBodyLines(lines, text)
  if (leavesStyle(text)) lines.push(`${lines.pop()}${STYLE_END}`)
  lines.push('')
}

/**
 * The one `├─ OUTPUT` section: the task's lines in the order it wrote
 * them, so an error stays beside what it is about (a test runner prints
 * progress to stdout and the failure to stderr). A stderr line is red;
 * without colour it is the task's bytes untouched. A line the task
 * coloured itself keeps its own colours, since a reset inside it would
 * end ours mid-line. A line takes the stream that began it.
 */
function pushOutputSection(
  lines: string[],
  output: readonly OutputChunk[],
  lost: number,
  colors: ColorSupport,
  link?: (line: string) => string,
): void {
  if (output.every((c) => c.text.trim().length === 0)) return
  lines.push(sectionLine('OUTPUT', 'strong', colors), '')
  if (lost > 0) {
    lines.push(droppedNote(lost, colors))
  }
  const body: Array<{ text: string; err: boolean }> = []
  let open: { parts: string[]; err: boolean } | null = null
  for (const c of output) {
    let rest = c.text
    while (rest.length > 0) {
      const nl = rest.indexOf('\n')
      const piece = nl < 0 ? rest : rest.slice(0, nl)
      if (open === null) open = { parts: [], err: c.err }
      open.parts.push(piece)
      if (nl < 0) break
      body.push({ text: open.parts.join(''), err: open.err })
      open = null
      rest = rest.slice(nl + 1)
    }
  }
  if (open !== null) body.push({ text: open.parts.join(''), err: open.err })
  for (const l of body) {
    const text = link === undefined ? l.text : link(l.text)
    if (!l.err || !colors.enabled) lines.push(text)
    else lines.push(hasEscape(l.text) ? text : paint('error', text, colors))
  }
  const styled = output.findLast((c) => hasEscape(c.text))
  if (styled !== undefined && leavesStyle(styled.text)) lines.push(`${lines.pop()}${STYLE_END}`)
  lines.push('')
}

/**
 * Section labels are bold + state-colored (owner design): stdout green,
 * stderr red, sandbox yellow, command plain white — only the command
 * CONTENT is greyed (context, not signal). A dim rule trails each label to
 * the frame width, and sections get vertical margins so content stands
 * clear of the furniture.
 */
function sectionLine(title: string, color: Style, colors: ColorSupport): string {
  const corner = (s: string) => paint('muted', s, colors)
  const label = paint(color, title, colors, true)
  // As wide as the footer's rule, so the frames and the footer line up.
  const rule = corner('─'.repeat(Math.max(1, ruleWidth(colors) - 4 - title.length)))
  return `${corner('├─')} ${label} ${rule}`
}

/**
 * Append each line of `text` raw. Content carries no border/indent so
 * terminal wrapping never collides with frame glyphs and copy/paste
 * stays clean; trailing newline is trimmed so the frame stays tight.
 */
function pushBodyLines(lines: string[], text: string): void {
  for (const line of text.replace(/\n$/, '').split('\n')) lines.push(line)
}

/**
 * `project#task` halves, each in its name's identity hue (never a status
 * color); the dim separator keeps them reading apart. `hueSource`
 * exists for truncated display strings: the hue must hash from the
 * FULL project name so it survives truncation.
 */
export function paintIdParts(
  hueSource: string,
  projectText: string,
  taskText: string,
  colors: ColorSupport,
  opts: { bold?: boolean; sep?: '#' | ':' } = {},
): string {
  return idParts(hueSource, projectText, taskText, colors, opts)
}

function paintId(
  projectName: string,
  taskName: string,
  colors: ColorSupport,
  opts: { bold?: boolean } = {},
): string {
  return paintIdParts(projectName, projectName, taskName, colors, opts)
}

function paintTaskId(node: TaskNode, colors: ColorSupport, opts: { bold?: boolean } = {}): string {
  return paintId(node.projectName, node.taskName, colors, opts)
}

// ── Reported-line grid: glyph · time · status · cache · name ────────
// glyph SHAPE encodes the cache axis (⏺ miss · ► fresh · ⇢ local · ⇣
// remote; ◼ failed · ⊘ skipped · ✗ aborted · ◌ not run), glyph COLOR encodes the
// task axis (green/red/yellow/cyan). The status and cache WORDS spell
// the two axes out, each in its own color. Time is right-aligned in a
// fixed cell so durations line up and a ticking elapsed never shifts
// the row. All detail (exit code, output) lives in the framed block.
export const TIME_COL = 7 // "0ms" … "999.99s", then "16m 40s" … "99m 59s"
const STATUS_COL = 7 // "success" / "running" / "skipped" / "aborted" / "not run"
const CACHE_COL = 8 // "no-cache" / "remote" / "local" / "fresh" / "miss"
const BLOCKED_COL = 7 // `blocks`: how many tasks are downstream of the row's
const USUAL_COL = 7 // "~18s" live, "+6.0s" / "−1m 05s" after
const CPU_COL = 5 // "180%", "1200%"
const MEM_COL = 6 // "412MB", "1.1GB", "1023MB"
const OUT_COL = 7 // `outputs`: "12MB", "900B"
const WORKER_COL = 12 // `local`, or a plugin's name for the machine, cut at 12

// A row's padding, built once: `' '.repeat` per cell was ~7 ms of an
// 8,002-hit warm run's rows, the largest single cost of writing them.
const SPACES = Array.from({ length: 33 }, (_, n) => ' '.repeat(n))

/** `n` spaces (none below 1). */
function pad(n: number): string {
  return n <= 0 ? '' : (SPACES[n] ?? ' '.repeat(n))
}

/** Right-align the duration in a TIME_COL cell (pad on the left). */
function timeCell(ms: number | null, colors: ColorSupport): string {
  let raw = ms === null ? '' : formatElapsed(ms)
  // `1000.00s` is wider than the cell; minutes fit it up to `99m 59s`.
  if (ms !== null && raw.length > TIME_COL) raw = formatElapsed(ms, true)
  // The time is the row's fact (value level); the cells around it are meta.
  return pad(TIME_COL - raw.length) + paint('value', raw, colors)
}

/**
 * Paint `text` then pad to `width` by VISIBLE length (trailing spaces).
 * An empty color string renders the text dim (used for the `miss` cache
 * word); empty text is a blank cell.
 */
function cell(text: string, color: Style | '', width: number, colors: ColorSupport): string {
  const painted = text === '' ? '' : paint(color === '' ? 'muted' : color, text, colors)
  return painted + pad(width - text.length)
}

/** The cache-shape glyph (task-shape for non-success). */
function glyphShape(o: TaskOutcome): string {
  switch (o.status) {
    case 'success':
      return '⏺\uFE0E' // ⏺ miss (ran), text-presentation (narrow)
    case 'cache-hit':
      return o.restored === false ? '\u25ba' : '\u21e2' // ► fresh : ⇢ local
    case 'cache-hit-remote':
      return o.restored === false ? '\u25ba' : '\u21e3' // ► fresh : ⇣ remote
    case 'failed':
      return '\u25fc\uFE0E' // ◼ failed, text-presentation (narrow)
    case 'skipped':
      return '\u2298' // ⊘ skipped
    default:
      return '⏺\uFE0E'
  }
}

/** Task-axis word + color (a cache hit is a success). */
function statusOf(o: TaskOutcome): { word: string; color: Style } {
  switch (o.status) {
    case 'failed':
      return { word: 'failed', color: 'error' }
    case 'skipped':
      return { word: 'skipped', color: 'warn' }
    default:
      return { word: 'success', color: 'ok' }
  }
}

/** Cache-axis word + color. Empty for states that never reached the cache. */
function cacheOf(o: TaskOutcome): { word: string; color: Style } {
  switch (o.status) {
    case 'success':
    case 'failed':
      // A task no cache answered for never consulted one: not a miss.
      return { word: ranNoCache(o) ? 'no-cache' : 'miss', color: 'muted' } // dim
    case 'cache-hit':
      return o.restored === false
        ? { word: 'fresh', color: 'ok' }
        : { word: 'local', color: 'local' }
    case 'cache-hit-remote':
      return o.restored === false
        ? { word: 'fresh', color: 'ok' }
        : { word: 'remote', color: 'remote' }
    default:
      return { word: '', color: 'muted' }
  }
}

/** The painted status glyph (shape = cache axis, color = task axis). */
function taskGlyph(o: TaskOutcome, colors: ColorSupport): string {
  return paint(statusOf(o).color, glyphShape(o), colors)
}

/**
 * One reported task row on the list grid: `<glyph> <time> <usual>
 * <status> <cache> <cpu> <mem> <blocks> <worker> <name>`. `glyph` is
 * pre-painted; status/cache are raw text + color, padded to their
 * columns; `paintedId` carries identity coloring. `ms = null` blanks the
 * time (a skip never ran); `cache = ''` and an absent cell blank theirs.
 */
export function formatTaskRow(
  glyph: string,
  ms: number | null,
  status: string,
  statusColor: Style | '',
  cache: string,
  cacheColor: Style | '',
  paintedId: string,
  colors: ColorSupport = NO_COLOR,
  cells: RowCells = {},
): string {
  const st = cell(status, statusColor, STATUS_COL, colors)
  // `aborting` runs one into the cache cell, which is blank beside it.
  const ca = cell(cache, cacheColor, CACHE_COL - Math.max(0, status.length - STATUS_COL), colors)
  const usual = cells.usual ?? { text: '', painted: '' }
  const us = `${pad(USUAL_COL - usual.text.length)}${usual.painted}`
  const cpu =
    cells.cpu === undefined ? '' : cells.cpu === null ? UNKNOWN : `${Math.round(cells.cpu * 100)}%`
  const mem =
    cells.memBytes === undefined
      ? ''
      : cells.memBytes === null
        ? UNKNOWN
        : formatSize(cells.memBytes)
  const out = cells.outputBytes === undefined ? '' : formatSize(cells.outputBytes)
  const blocks = cells.blocks ?? ''
  const worker = workerName(cells.worker ?? '')
  return (
    ` ${glyph} ${timeCell(ms, colors)} ${us} ${st} ${ca} ` +
    `${right(cpu, CPU_COL, colors)} ${right(mem, MEM_COL, colors)} ${right(out, OUT_COL, colors)} ` +
    `${pad(BLOCKED_COL - blocks.length)}${paint(blocks === '0' ? 'muted' : 'value', blocks, colors)} ` +
    `${placeCell(worker, colors)}${pad(WORKER_COL - worker.length)} ${paintedId}`
  )
}

/**
 * A cell vx cannot know: a peak no look saw, a task history never timed.
 * Blank is a cell that does not apply (a hit ran nothing).
 */
const UNKNOWN = '\u2014'

/** A row's cells past time, status and cache; each blank when absent, `—` when null. */
export interface RowCells {
  /** After the time, pre-painted: `~18s` live, `+6.0s` / `−1.4s` after. */
  usual?: { text: string; painted: string }
  /** Cores in use (live) or on average (after): 1.8 prints `180%`. */
  cpu?: number | null
  /** Resident memory now (live) or at its peak (after). */
  memBytes?: number | null
  /** The bytes of the task's outputs: what its save stored, or its hit restored. */
  outputBytes?: number
  /** How many tasks are downstream. */
  blocks?: string
  /** The machine it runs or ran on: `local`, or the executor's name for it. */
  worker?: string
}

function right(text: string, width: number, colors: ColorSupport): string {
  return pad(width - text.length) + paint('muted', text, colors)
}

/** `900B`, `412MB`, `1.1GB`: one width for a size, whatever it is. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  const mb = bytes / 1024 / 1024
  if (mb < 1) return `${Math.round(bytes / 1024)}KB`
  if (mb < 9.95) return `${mb.toFixed(1)}MB`
  if (mb < 1000) return `${Math.round(mb)}MB`
  const gb = mb / 1024
  return gb < 10 ? `${gb.toFixed(1)}GB` : `${Math.round(gb)}GB`
}

// A run names a handful of workers over thousands of rows: each painted
// once (escaping and painting per row was ~12 ms of a 9,603-task warm run).
const placeCells = new WeakMap<ColorSupport, Map<string, string>>()

function placeCell(worker: string, colors: ColorSupport): string {
  if (worker === '') return ''
  let byName = placeCells.get(colors)
  if (byName === undefined) placeCells.set(colors, (byName = new Map()))
  let painted = byName.get(worker)
  if (painted === undefined) byName.set(worker, (painted = ui.inline(ui.place(worker), colors)))
  return painted
}

/** A worker's name in its 12 columns: a longer one ends in `…`. */
function workerName(name: string): string {
  return name.length > WORKER_COL ? `${name.slice(0, WORKER_COL - 1)}\u2026` : name
}

/** A task's average cores over its run: CPU time over wall time. */
function coresOf(o: TaskOutcome): number | undefined {
  return o.cpuMs === undefined || o.durationMs <= 0 ? undefined : o.cpuMs / o.durationMs
}

/**
 * The results list's `±usual` cell: how far an executed task ran from its
 * usual time, `+6.0s` red or `−1.4s` green past a fifth of the usual either
 * way, dim within it; `—` (null) with no history for the task, blank
 * (undefined) with no history to ask. A blank within a fifth read as no
 * usual at all (2026-10-29).
 */
export function usualCell(
  ms: number,
  usualMs: number | null | undefined,
  colors: ColorSupport = NO_COLOR,
): { text: string; painted: string } {
  if (usualMs === undefined) return { text: '', painted: '' }
  if (usualMs === null || usualMs <= 0) return unknownUsual(colors)
  const d = ms - usualMs
  const text = `${d >= 0 ? '+' : '\u2212'}${formatElapsed(Math.abs(d), true)}`
  if (Math.abs(d) <= usualMs * 0.2) return { text, painted: paint('muted', text, colors) }
  return { text, painted: paint(d > 0 ? 'error' : 'ok', text, colors) }
}

/** The `usual` cell of a task history has never timed. */
export function unknownUsual(colors: ColorSupport = NO_COLOR): { text: string; painted: string } {
  return { text: UNKNOWN, painted: paint('muted', UNKNOWN, colors) }
}

/**
 * The header over a task list, on the row grid: dim and underlined across
 * the whole line, gaps included, straight over its rows (bold in a hue, it
 * blended into rows of the same hues).
 */
export function formatListHeader(colors: ColorSupport = NO_COLOR): string {
  return header('\u00b1usual', colors)
}

/**
 * The live list's header: the usual duration where the results list has
 * how far a task ran from it; the other columns are the results'.
 */
export function formatRunningHeader(colors: ColorSupport = NO_COLOR): string {
  return header('usual', colors)
}

function header(usual: string, colors: ColorSupport): string {
  const head =
    `   ${'time'.padStart(TIME_COL)} ${usual.padStart(USUAL_COL)} ` +
    `${'status'.padEnd(STATUS_COL)} ${'cache'.padEnd(CACHE_COL)} ${'cpu'.padStart(CPU_COL)} ` +
    `${'mem'.padStart(MEM_COL)} ${'outputs'.padStart(OUT_COL)} ${'blocks'.padStart(BLOCKED_COL)} ${'worker'.padEnd(WORKER_COL)} task`
  return paint('label', head, colors)
}

/**
 * The task list on its grid, under its header: the run's results panel's
 * body, and `vx last`'s, so a replay reads as the run did.
 */
export function taskList(rows: readonly ((colors: ColorSupport) => string)[]): ui.Block {
  return { lines: (c) => [formatListHeader(c), ...rows.map((row) => row(c))] }
}

/** What history keeps of a task's row: `vx last` draws it again from this. */
export interface RecordedRow {
  project: string
  task: string
  status: string
  durationMs: number
  restored: boolean | null
  cached: boolean | null
  cpuMs: number | null
  peakRssBytes: number | null
  placement: string | null
  outputBytes: number | null
  blocks: number | null
}

/**
 * A recorded task's row, as the run printed it; `note` (dim) after its id.
 * `usualMs` is the task's usual time now, from history (`null`: never timed).
 */
export function formatRecordedRow(
  r: RecordedRow,
  colors: ColorSupport = NO_COLOR,
  note = '',
  usualMs?: number | null,
): string {
  // The row functions read a node's names and whether it declared a cache.
  const node = {
    id: `${r.project}#${r.task}`,
    projectName: r.project,
    taskName: r.task,
    config: r.cached === false ? {} : { cache: {} },
  } as unknown as TaskNode
  const o = {
    node,
    status: r.status,
    durationMs: r.durationMs,
    ...(r.restored !== null ? { restored: r.restored } : {}),
    ...(r.cpuMs !== null ? { cpuMs: r.cpuMs } : {}),
    ...(r.peakRssBytes !== null ? { peakRssBytes: r.peakRssBytes } : {}),
    ...(r.placement !== null ? { where: r.placement } : {}),
    ...(r.outputBytes !== null ? { outputBytes: r.outputBytes } : {}),
  } as TaskOutcome
  const blocks = r.blocks ?? undefined
  const row =
    o.status === 'skipped'
      ? formatTaskSkippedLine(node, colors, undefined, blocks)
      : o.status === 'aborted'
        ? formatTaskAbortedLine(node, o, colors, blocks)
        : isCacheHit(o.status)
          ? formatTaskHitLine(node, o, colors, false, blocks)
          : formatTaskExecutedLine(node, o, colors, false, blocks, usualMs)
  return note === '' ? row : `${row}  ${paint('muted', note, colors)}`
}

/**
 * A running task's usual duration, fixed while the elapsed time counts up
 * toward it (2026-10-14): `~5.2s`, `~42s`, `~2m 05s`. Fits the cache
 * column below 100 minutes.
 */
export function formatExpected(ms: number): string {
  // The tier by the rounded value: 999.6 ms printed `~1000ms` (item 1034's class).
  if (Math.round(ms) < 1000) return `~${Math.round(ms)}ms`
  if (ms < 9950) return `~${(ms / 1000).toFixed(1)}s`
  const s = Math.round(ms / 1000)
  if (s < 60) return `~${s}s`
  return `~${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

/** A task `--dry` lists: what the run would do with it, on the running list's grid. */
export interface PlannedRow {
  node: TaskNode
  glyph: string
  status: string
  /** The glyph's and the status word's hue. */
  tone: Style
  cache: string
  cacheTone: Style | ''
  /** Its usual time, from history. */
  usualMs?: number
  /** What a remote hit would download. */
  outputBytes?: number
  /** How many tasks are downstream of it. */
  blocks?: number
  worker: string
  /** Dim, after the id: its description, why it is affected. */
  note: string
}

/** `--dry`'s list: the running list's header and grid, so a plan reads as the run would. */
export function planList(rows: readonly PlannedRow[]): ui.Block {
  return {
    lines: (c) => [
      formatRunningHeader(c),
      ...rows.map((r) => {
        const usual = r.usualMs === undefined ? undefined : formatExpected(r.usualMs)
        const row = formatTaskRow(
          paint(r.tone, r.glyph, c),
          null,
          r.status,
          r.tone,
          r.cache,
          r.cacheTone,
          paintTaskId(r.node, c),
          c,
          {
            ...(usual !== undefined
              ? { usual: { text: usual, painted: paint('muted', usual, c) } }
              : {}),
            ...(r.outputBytes !== undefined ? { outputBytes: r.outputBytes } : {}),
            ...(r.blocks !== undefined ? { blocks: String(r.blocks) } : {}),
            worker: r.worker,
          },
        )
        return r.note === '' ? row : `${row}  ${paint('muted', r.note, c)}`
      }),
    ],
  }
}

/** Compact one-liner for a cache hit with nothing to replay. */
export function formatTaskHitLine(
  node: TaskNode,
  o: TaskOutcome,
  colors: ColorSupport = NO_COLOR,
  onPath = false,
  blocks?: number,
): string {
  return formatOutcomeRow(o, paintTaskId(node, colors), o.durationMs, colors, onPath, {
    ...ranCells(o, blocks),
  })
}

/**
 * The `--output-logs hash-only` line: outcome word, task id, cache key —
 * absent for a task that never computed one (skipped, uncacheable). The
 * word in its outcome's colour, the key dim.
 */
export function formatTaskHashLine(
  node: TaskNode,
  o: TaskOutcome,
  colors: ColorSupport = NO_COLOR,
): string {
  const color = o.status === 'aborted' ? 'aborted' : statusOf(o).color
  const key = o.hash === undefined ? '' : ` ${paint('muted', o.hash, colors)}`
  return `${paint(color, outcomeWord(o), colors)} ${paintTaskId(node, colors)}${key}`
}

/** Compact one-liner for an executed task in broad mode. */
export function formatTaskExecutedLine(
  node: TaskNode,
  o: TaskOutcome,
  colors: ColorSupport = NO_COLOR,
  onPath = false,
  blocks?: number,
  usualMs?: number | null,
): string {
  return formatOutcomeRow(o, paintTaskId(node, colors), o.durationMs, colors, onPath, {
    ...executedCells(o, blocks),
    // A hit's time is a restore's, not the task's: nothing to compare.
    ...(o.status === 'success' || o.status === 'failed'
      ? { usual: usualCell(o.durationMs, usualMs, colors) }
      : {}),
  })
}

/**
 * An executed task's cells: where it ran, its average cores and peak
 * memory; a task that ran with either unread shows `—`, a hit nothing.
 */
export function executedCells(o: TaskOutcome, blocks: number | undefined): RowCells {
  const cores = coresOf(o)
  const ran = o.status === 'success' || o.status === 'failed'
  return {
    ...ranCells(o, blocks),
    ...(cores !== undefined ? { cpu: cores } : ran ? { cpu: null } : {}),
    ...(o.peakRssBytes !== undefined
      ? { memBytes: o.peakRssBytes }
      : ran
        ? { memBytes: null }
        : {}),
  }
}

/** The cells every row of a task that reached a machine carries. */
function ranCells(o: TaskOutcome, blocks: number | undefined): RowCells {
  return {
    // A skip reached no machine.
    ...(o.status === 'skipped' ? {} : { worker: o.where ?? 'local' }),
    ...(blocks !== undefined ? { blocks: String(blocks) } : {}),
    ...(o.outputBytes !== undefined ? { outputBytes: o.outputBytes } : {}),
  }
}

/** Shared: render any outcome on the grid. */
function formatOutcomeRow(
  o: TaskOutcome,
  paintedId: string,
  ms: number | null,
  colors: ColorSupport,
  onPath: boolean,
  cells: RowCells,
): string {
  const st = statusOf(o)
  const ca = cacheOf(o)
  return (
    formatTaskRow(
      taskGlyph(o, colors),
      ms,
      st.word,
      st.color,
      ca.word,
      ca.color,
      paintedId,
      colors,
      cells,
    ) +
    (onPath ? pathNote(colors) : '') +
    flakyNote(o, colors)
  )
}

/** `critical path`: the row's task held the run's end while others ran beside it. */
export function pathNote(colors: ColorSupport = NO_COLOR): string {
  // A fact worth knowing, not a failure: never red.
  return `  ${paint('info', 'critical path', colors)}`
}

/** Where an executor ran the task, when not here, right after its id: `@small#2` (2026-10-21). */
function whereNote(o: TaskOutcome, colors: ColorSupport = NO_COLOR): string {
  return o.where === undefined ? '' : placeNote(o.where, colors)
}

/**
 * ` · <where>` after the id: the dot dim, the place in its own hue. Last
 * on the row, as a worker's name has no width to pad to (2026-10-21).
 */
function placeNote(where: string, colors: ColorSupport = NO_COLOR): string {
  return `${paint('muted', ' \u00b7', colors)} ${ui.inline(ui.place(where), colors)}`
}

/**
 * The dim note a flaky task's row and frame carry (`flaky - failed 1×
 * before`): nothing prints below the footer, so the task's own line is
 * where the reader learns it. '' when the run did not prove it flaky.
 */
export function flakyNote(o: TaskOutcome, colors: ColorSupport = NO_COLOR): string {
  if (o.flaky === undefined) return ''
  const said: string[] = []
  if (o.status === 'failed' && o.flaky.passes > 0)
    said.push(`passed ${o.flaky.passes}\u00d7 before`)
  if (o.status !== 'failed' && o.flaky.failures > 0) {
    said.push(`failed ${o.flaky.failures}\u00d7 before`)
  }
  if ((o.attempts ?? 1) > 1) said.push(`${o.attempts} attempts`)
  const text = said.length === 0 ? 'flaky' : `flaky - ${said.join(' \u00b7 ')}`
  return ` ${paint('muted', text, colors)}`
}

/**
 * Compact one-liner for a skipped task — it never ran (blank time). The
 * blocker rides the row (`• blocked by lib#build`): nothing prints below
 * the footer, so the row is where the reader learns what blocked it.
 */
export function formatTaskSkippedLine(
  node: TaskNode,
  colors: ColorSupport = NO_COLOR,
  skip?: Parameters<typeof skippedReason>[0],
  blocks?: number,
): string {
  const why = skippedReason(skip)
  const suffix = why === '' ? '' : ` ${paint('muted', `• ${why}`, colors)}`
  return (
    formatTaskRow(
      paint('warn', '\u2298', colors),
      null,
      'skipped',
      'warn',
      '',
      '',
      paintTaskId(node, colors),
      colors,
      blocks === undefined ? {} : { blocks: String(blocks) },
    ) + suffix
  )
}

/**
 * One row for a task a shutdown signal killed (`aborted`, its time so far)
 * or one the stop reached before it ran (`not run`, no time). Neither
 * reached the cache, so the cache cell is blank, as a skip's is.
 */
export function formatTaskAbortedLine(
  node: TaskNode,
  o: TaskOutcome,
  colors: ColorSupport = NO_COLOR,
  blocks?: number,
): string {
  const id = paintTaskId(node, colors)
  const bl: RowCells = blocks === undefined ? {} : { blocks: String(blocks) }
  if (neverStarted(o)) {
    return formatTaskRow(
      paint('muted', '\u25cc', colors),
      null,
      'not run',
      '',
      '',
      '',
      id,
      colors,
      bl,
    )
  }
  return formatTaskRow(
    paint('aborted', '\u2717', colors),
    o.durationMs,
    'aborted',
    'aborted',
    '',
    '',
    id,
    colors,
    ranCells(o, blocks),
  )
}

/**
 * Live-frame brackets for focused mode: the requested task's output
 * streams raw between an opening line (id + command) and a closing
 * line (id + duration + outcome). Same visual language as
 * formatTaskBlock, but emitted in real time around the live stream
 * instead of buffered.
 */
export function formatFrameOpen(
  node: TaskNode,
  colors: ColorSupport = NO_COLOR,
  forwardArgs: readonly string[] = [],
): string {
  const corner = (t: string) => paint('muted', t, colors)
  const cmd = shownCommand(node, forwardArgs)
  const mark = persistentMark(node, colors)
  return `${corner('┌─')} ${mark}${paintTaskId(node, colors, { bold: true })} ${corner('>')} $ ${cmd}`
}

/**
 * Sandbox violations get a dedicated section inside the frame so the user
 * sees them in context with the failing task, not as loose status output
 * above the box. Shared by BOTH renderers: the focused/live frame used to
 * omit it, so a single-task run — exactly how someone debugging one task
 * invokes vx — showed a failure with no violations at all
 * (2026-09-05).
 */
function violationSection(outcome: TaskOutcome, colors: ColorSupport): string[] {
  const vlines = outcome.sandboxViolationLines
  if (!vlines || vlines.length === 0) return []
  // Unique lines only — a task's children trip the same denial many times
  // and the repeats bury everything else. The lines themselves are printed
  // VERBATIM: a violation is evidence, and evidence that has been rewritten
  // for display is not the thing the sandbox reported. The outcome keeps
  // every record for telemetry.
  // Verbatim but for control bytes: a denied path is anyone's bytes, and
  // one named `ESC ]0;…` retitled the terminal (the `\xNN` is still exact).
  const body = [...new Set(vlines)].map(printable)
  // Red, not amber: a violation fails the task, so it reads as a failure.
  // vx's note, after the evidence: the grants that would have allowed it.
  // A read the output depends on is a key input too; the sandbox never
  // adds one (2026-10-09), so the note names the reads no input
  // glob matches and the user decides.
  const fix = outcome.sandboxFix
  const line = fix === undefined ? undefined : sandboxFixLine(fix)
  const dim = (text: string): string => paint('muted', text, colors)
  const note =
    fix === undefined
      ? []
      : [
          ...(line !== undefined ? [dim(`fix: ${line}`)] : []),
          ...(fix.inputs !== undefined
            ? [
                dim(
                  `and, if the output depends on them, inputs.files: [${fix.inputs.map((p) => `'${printable(p)}'`).join(', ')}]`,
                ),
              ]
            : []),
          ...(fix.withheld !== undefined
            ? [
                dim(
                  `credential path, grant it only on purpose: ${fix.withheld.map(printable).join(', ')}`,
                ),
              ]
            : []),
          '',
        ]
  // vx's own notes (`vx: …`) explain a failure; they are not denials.
  const denials = body.filter((l) => !l.startsWith('vx: ')).length
  return [
    sectionLine(denials > 0 ? `SANDBOX VIOLATIONS (${denials})` : 'SANDBOX', 'error', colors),
    '',
    ...body,
    '',
    ...note,
  ]
}

export function formatFrameClose(
  node: TaskNode,
  outcome: TaskOutcome,
  colors: ColorSupport = NO_COLOR,
): string {
  const corner = (t: string) => paint('muted', t, colors)
  const mark = persistentMark(node, colors)
  // A persistent task's child keeps running past this "ready" outcome,
  // so the close reads `running` (accent), not `success` — the ▸ marks
  // both ends of the frame as a long-lived task.
  const tail =
    mark !== '' && outcome.status === 'success' && outcome.serverExit === undefined
      ? runningFooter(outcome, colors)
      : formatBlockFooter(outcome, colors)
  const close = `${corner('└─')} ${mark}${paintTaskId(node, colors, { bold: true })}${whereNote(outcome, colors)} ${corner('──')}${tail}`
  const violations = violationSection(outcome, colors)
  return violations.length === 0 ? close : `${violations.join('\n')}\n${close}`
}

/** What ran: a requested task gets the args after `--`, as execute-task.ts appends them. */
function shownCommand(node: TaskNode, forwardArgs: readonly string[]): string {
  const exec = node.config.exec
  return maskedCommand(
    withForwardArgs(exec?.command ?? '', node.requested ? forwardArgs : []),
    exec?.env,
  )
}

function persistentMark(node: TaskNode, colors: ColorSupport): string {
  return node.config.exec?.persistent !== undefined ? `${paint('info', '▸', colors)} ` : ''
}

function runningFooter(o: TaskOutcome, colors: ColorSupport): string {
  return ` ${paint('muted', `(${formatElapsed(o.durationMs)})`, colors)} ${paint('info', 'running', colors)}`
}

/**
 * Everything a persistent task wrote AFTER it signalled ready, as one
 * trailing block. Its outcome landed at ready while the child kept
 * running, so this uses the live frame's `▸ … running` vocabulary rather
 * than the success frame `formatTaskBlock` renders — the block is a tail,
 * not a completed task's log. Section titles say `(since ready)` because
 * the pre-ready output already went out with the outcome, and a
 * head-dropped tail names how much it lost so a truncated log can never
 * read as complete. Empty body → '' (the caller writes nothing).
 */
export function formatPersistentTailBlock(
  node: TaskNode,
  outcome: TaskOutcome,
  // Two bounded tails, one per stream: their order is lost, so the
  // streams print apart.
  body: { stdout?: string; stderr?: string },
  dropped: { stdout?: number; stderr?: number } = {},
  colors: ColorSupport = NO_COLOR,
  forwardArgs: readonly string[] = [],
): string {
  const stdout = body.stdout ?? ''
  const stderr = body.stderr ?? ''
  if (stdout.trim().length === 0 && stderr.trim().length === 0) return ''
  const lines: string[] = [formatFrameOpen(node, colors, forwardArgs)]
  pushStreamSection(lines, stdout, 'STDOUT (since ready)', 'ok', dropped.stdout ?? 0, colors)
  pushStreamSection(lines, stderr, 'STDERR (since ready)', 'error', dropped.stderr ?? 0, colors)
  lines.push(formatFrameClose(node, outcome, colors))
  return lines.join('\n') + '\n'
}

/**
 * What a kept server writes after the summary, one line at a time under its
 * id (`app#dev │ Local: http://localhost:5173`), so several servers'
 * logs read apart. `text` holds whole lines, its last newline cut off.
 */
export function formatKeptLines(node: TaskNode, text: string, colors: ColorSupport): string {
  const prefix = `${paintTaskId(node, colors)} ${paint('muted', '│', colors)} `
  return text
    .split('\n')
    .map((line) => {
      const shown = lastRedraw(line)
      return `${prefix}${shown}${leavesStyle(shown) ? STYLE_END : ''}\n`
    })
    .join('')
}

/**
 * Between the requested task's frame and the summary footer, list the
 * persistent tasks (dev servers / watchers) the run is keeping alive in
 * the foreground — one `▸ <id> running` row each, so it's clear which
 * children are still up and how many. Same ▸ vocabulary as the frame
 * marks and the live region's persistent pins.
 */
export function formatPersistentList(
  nodes: readonly TaskNode[],
  colors: ColorSupport = NO_COLOR,
): string[] {
  return nodes.map(
    (n) =>
      `  ${paint('info', '▸', colors)} ${paintTaskId(n, colors)} ${paint('muted', 'running', colors)}`,
  )
}

function formatBlockHeader(o: TaskOutcome, colors: ColorSupport): string {
  const shortHash = o.hash ? o.hash.slice(0, 8) : ''
  const dim = (s: string) => paint('muted', s, colors)
  const word = outcomeLabel(o)
  switch (o.status) {
    case 'cache-hit':
      return `${paint('ok', word, colors)} ${dim(`• ${shortHash}`)}`
    case 'cache-hit-remote':
      // A remote restore is the one hit painted accent: bytes came off the wire.
      return `${paint(o.restored === false ? 'ok' : 'info', word, colors)} ${dim(`• ${shortHash}`)}`
    case 'failed':
      // The command lives in its own `├─ command` section; the header
      // carries the outcome like every other status.
      return paint('error', word, colors, true)
    case 'skipped':
      return paint('warn', word, colors)
    case 'aborted':
      return paint('aborted', word, colors)
    default:
      return dim(word)
  }
}

function formatBlockFooter(o: TaskOutcome, colors: ColorSupport): string {
  // Footer pattern: ` (<dur>) <status>`. Duration is always shown, and it is
  // always what THIS run spent — for a cache hit, the probe + restore, not
  // the exec time the entry was stored with. (The comment here used to claim
  // the opposite; the code never did, and `--report` summed these as "time
  // saved" on the strength of it. The stored time lives on
  // `TaskOutcome.storedDurationMs`.) Status differs by outcome — see
  // formatStatusTag.
  const dur = paint('muted', `(${formatElapsed(o.durationMs)})`, colors)
  const tag = formatStatusTag(o, colors)
  return ` ${dur} ${tag}${flakyNote(o, colors)}`
}

function formatStatusTag(o: TaskOutcome, colors: ColorSupport): string {
  const word = outcomeLabel(o)
  switch (o.status) {
    case 'failed':
      return paint('error', word, colors, true)
    case 'skipped':
      return paint('warn', word, colors)
    case 'aborted':
      return paint('aborted', word, colors)
    default:
      return paint('muted', word, colors)
  }
}

/**
 * The fix as the config line it is: `exec.sandbox.allow: { read: ['a'] }`,
 * or undefined when every denial was a withheld credential path.
 */
function sandboxFixLine(f: NonNullable<TaskOutcome['sandboxFix']>): string | undefined {
  const fix = Object.entries(f).filter(([k]) => k !== 'withheld' && k !== 'inputs')
  if (fix.length === 0) return undefined
  const parts = fix.map(
    ([k, list]: [string, string[]]) => `${k}: [${list.map((p) => `'${printable(p)}'`).join(', ')}]`,
  )
  return `exec.sandbox.allow: { ${parts.join(', ')} }`
}
