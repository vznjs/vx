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
import { isGroupTask, type TaskNode, type TaskOutcome } from '../graph/index.js'
import {
  formatElapsed,
  identityColor,
  maskedCommand,
  paint,
  printable,
  ruleWidth,
  ui,
  type ColorSupport,
} from '../util/index.js'
import { neverStarted } from './summary.js'
import { outcomeLabel, outcomeWord, ranNoCache, skippedReason } from './events.js'
import { fileMemo, linkPaths } from './path-links.js'

const NO_COLOR: ColorSupport = { enabled: false }
// Ends any colour a task's output left on, so vx's own lines below never
// take it (a task killed mid-write leaves one open).
export const RESET = '\x1b[0m'

/** Whether `text`'s last colour code sets a style rather than resetting it. */
export function leavesStyle(text: string): boolean {
  const at = text.lastIndexOf('\x1b[')
  if (at < 0) return false
  const sgr = /^\[([\d;]*)m/.exec(text.slice(at + 1, at + 64))
  // Not a colour code (a cursor move): look no further, as a reset costs nothing.
  if (sgr === null) return true
  return sgr[1] !== '' && sgr[1] !== '0'
}

const ACCENT = '#06b6d4' // cyan-500 — bullets, remote-hit hint
// Identity hues (`identityColor`) are outside the status palette (green /
// red / yellow / cyan) so a task id can never read as an outcome. Each
// half of an id hashes its own name: same project, same hue; same target,
// same hue, in every run, list and region row.

const SUCCESS = '#22c55e' // green-500 — success / fresh
const WARN = '#eab308' // yellow-500 — skipped
const ERROR = '#ef4444' // red-500 — failed
const ABORTED = '#f97316' // orange-500 — killed by a shutdown signal
const LOCAL = '#38bdf8' // sky-400 — local cache hit
const REMOTE = '#2563eb' // blue-600 — remote cache hit

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
  const corner = (s: string) => paint('', s, colors, { dim: true })
  // A ready server's frame reads as the live one does: marked, and running.
  const mark = persistentMark(node, colors)
  const running = mark !== '' && outcome.status === 'success' && outcome.serverExit === undefined
  const header = running ? paint(ACCENT, 'running', colors) : formatBlockHeader(outcome, colors)
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
  return paint('', `… ${lost} earlier character${lost === 1 ? '' : 's'} dropped`, colors, {
    dim: true,
  })
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
  color: string,
  lost: number,
  colors: ColorSupport,
): void {
  if (text.trim().length === 0) return
  lines.push(sectionLine(title, color, colors), '')
  if (lost > 0) {
    lines.push(droppedNote(lost, colors))
  }
  pushBodyLines(lines, text)
  if (leavesStyle(text)) lines.push(`${lines.pop()}${RESET}`)
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
  lines.push(sectionLine('OUTPUT', '', colors), '')
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
    else lines.push(l.text.includes('\x1b') ? text : paint(ERROR, text, colors))
  }
  const styled = output.findLast((c) => c.text.includes('\x1b['))
  if (styled !== undefined && leavesStyle(styled.text)) lines.push(`${lines.pop()}${RESET}`)
  lines.push('')
}

/**
 * Section labels are bold + state-colored (owner design): stdout green,
 * stderr red, sandbox yellow, command plain white — only the command
 * CONTENT is greyed (context, not signal). A dim rule trails each label to
 * the frame width, and sections get vertical margins so content stands
 * clear of the furniture.
 */
function sectionLine(title: string, color: string, colors: ColorSupport): string {
  const corner = (s: string) => paint('', s, colors, { dim: true })
  const label = paint(color, title, colors, { bold: true })
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
  const dim = (t: string) => paint('', t, colors, { dim: true })
  const { sep = '#', ...style } = opts
  return (
    paint(identityColor(hueSource), projectText, colors, style) +
    dim(sep) +
    paint(identityColor(taskText), taskText, colors, style)
  )
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
const WAITED_COL = 7 // the time cell's width: "1.20s"
const CPU_COL = 5 // "180%", "1200%"
const MEM_COL = 6 // "412MB", "1.1GB", "1023MB"
const OUT_COL = 7 // `outputs`: "12MB", "900B"
const WORKER_COL = 12 // `local`, or a plugin's name for the machine, cut at 12
/** The list header's colour: violet-400, the summary rule's first stop. */

/** Right-align the duration in a TIME_COL cell (pad on the left). */
function timeCell(ms: number | null, colors: ColorSupport): string {
  let raw = ms === null ? '' : formatElapsed(ms)
  // `1000.00s` is wider than the cell; minutes fit it up to `99m 59s`.
  if (ms !== null && raw.length > TIME_COL) raw = formatElapsed(ms, true)
  return ' '.repeat(Math.max(0, TIME_COL - raw.length)) + paint('', raw, colors, { dim: true })
}

/**
 * Paint `text` then pad to `width` by VISIBLE length (trailing spaces).
 * An empty color string renders the text dim (used for the `miss` cache
 * word); empty text is a blank cell.
 */
function cell(text: string, color: string, width: number, colors: ColorSupport): string {
  const painted =
    text === ''
      ? ''
      : color === ''
        ? paint('', text, colors, { dim: true })
        : paint(color, text, colors)
  return painted + ' '.repeat(Math.max(0, width - text.length))
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
function statusOf(o: TaskOutcome): { word: string; color: string } {
  switch (o.status) {
    case 'failed':
      return { word: 'failed', color: ERROR }
    case 'skipped':
      return { word: 'skipped', color: WARN }
    default:
      return { word: 'success', color: SUCCESS }
  }
}

/** Cache-axis word + color. Empty for states that never reached the cache. */
function cacheOf(o: TaskOutcome): { word: string; color: string } {
  switch (o.status) {
    case 'success':
    case 'failed':
      // A task no cache answered for never consulted one: not a miss.
      return { word: ranNoCache(o) ? 'no-cache' : 'miss', color: '' } // dim
    case 'cache-hit':
      return o.restored === false
        ? { word: 'fresh', color: SUCCESS }
        : { word: 'local', color: LOCAL }
    case 'cache-hit-remote':
      return o.restored === false
        ? { word: 'fresh', color: SUCCESS }
        : { word: 'remote', color: REMOTE }
    default:
      return { word: '', color: '' }
  }
}

/** The painted status glyph (shape = cache axis, color = task axis). */
function taskGlyph(o: TaskOutcome, colors: ColorSupport): string {
  return paint(statusOf(o).color, glyphShape(o), colors)
}

/**
 * One reported task row on the list grid: `<glyph> <time> <usual> <waited>
 * <status> <cache> <cpu> <mem> <blocks> <worker> <name>`. `glyph` is
 * pre-painted; status/cache are raw text + color, padded to their
 * columns; `paintedId` carries identity coloring. `ms = null` blanks the
 * time (a skip never ran); `cache = ''` and an absent cell blank theirs.
 */
export function formatTaskRow(
  glyph: string,
  ms: number | null,
  status: string,
  statusColor: string,
  cache: string,
  cacheColor: string,
  paintedId: string,
  colors: ColorSupport = NO_COLOR,
  cells: RowCells = {},
): string {
  const st = cell(status, statusColor, STATUS_COL, colors)
  // `aborting` runs one into the cache cell, which is blank beside it.
  const ca = cell(cache, cacheColor, CACHE_COL - Math.max(0, status.length - STATUS_COL), colors)
  const usual = cells.usual ?? { text: '', painted: '' }
  const us = `${' '.repeat(Math.max(0, USUAL_COL - usual.text.length))}${usual.painted}`
  const waited = cells.waitedMs === undefined ? '' : formatElapsed(cells.waitedMs)
  const cpu = cells.cpu === undefined ? '' : `${Math.round(cells.cpu * 100)}%`
  const mem = cells.memBytes === undefined ? '' : formatSize(cells.memBytes)
  const out = cells.outputBytes === undefined ? '' : formatSize(cells.outputBytes)
  const blocks = cells.blocks ?? ''
  const worker = workerName(cells.worker ?? '')
  return (
    ` ${glyph} ${timeCell(ms, colors)} ${us} ${right(waited, WAITED_COL, colors)} ${st} ${ca} ` +
    `${right(cpu, CPU_COL, colors)} ${right(mem, MEM_COL, colors)} ${right(out, OUT_COL, colors)} ` +
    `${' '.repeat(Math.max(0, BLOCKED_COL - blocks.length))}${paint(WARN, blocks, colors)} ` +
    `${worker === '' ? '' : ui.inline(ui.place(worker), colors)}${' '.repeat(WORKER_COL - worker.length)} ${paintedId}`
  )
}

/** A row's cells past time, status and cache; each blank when absent. */
export interface RowCells {
  /** After the time, pre-painted: `~18s` live, `+6.0s` / `−1.4s` after. */
  usual?: { text: string; painted: string }
  /** How long the task waited ready for a slot. */
  waitedMs?: number
  /** Cores in use (live) or on average (after): 1.8 prints `180%`. */
  cpu?: number
  /** Resident memory now (live) or at its peak (after). */
  memBytes?: number
  /** The bytes of the task's outputs: what its save stored, or its hit restored. */
  outputBytes?: number
  /** How many tasks are downstream. */
  blocks?: string
  /** The machine it runs or ran on: `local`, or the executor's name for it. */
  worker?: string
}

function right(text: string, width: number, colors: ColorSupport): string {
  return ' '.repeat(Math.max(0, width - text.length)) + paint('', text, colors, { dim: true })
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

/** A worker's name in its 12 columns: a longer one ends in `…`. */
function workerName(name: string): string {
  return name.length > WORKER_COL ? `${name.slice(0, WORKER_COL - 1)}\u2026` : name
}

/**
 * A wait worth a cell: under 50 ms the task started at once, the
 * scheduler's own tick and a sibling's spawn, not a full pool.
 */
export function waited(ms: number | undefined): boolean {
  return ms !== undefined && ms >= 50
}

/** A task's average cores over its run: CPU time over wall time. */
function coresOf(o: TaskOutcome): number | undefined {
  return o.cpuMs === undefined || o.durationMs <= 0 ? undefined : o.cpuMs / o.durationMs
}

/**
 * The results list's `±usual` cell: how far an executed task ran from its
 * usual time, `+6.0s` red or `−1.4s` green, only past a fifth of the usual
 * either way; blank with no usual time to compare.
 */
function usualDelta(
  ms: number,
  usualMs: number | undefined,
  colors: ColorSupport = NO_COLOR,
): { text: string; painted: string } {
  if (usualMs === undefined || usualMs <= 0 || Math.abs(ms - usualMs) <= usualMs * 0.2)
    return { text: '', painted: '' }
  const d = ms - usualMs
  const text = `${d > 0 ? '+' : '\u2212'}${formatElapsed(Math.abs(d), true)}`
  return { text, painted: paint(d > 0 ? ERROR : SUCCESS, text, colors) }
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
    `   ${'time'.padStart(TIME_COL)} ${usual.padStart(USUAL_COL)} ${'waited'.padStart(WAITED_COL)} ` +
    `${'status'.padEnd(STATUS_COL)} ${'cache'.padEnd(CACHE_COL)} ${'cpu'.padStart(CPU_COL)} ` +
    `${'mem'.padStart(MEM_COL)} ${'outputs'.padStart(OUT_COL)} ${'blocks'.padStart(BLOCKED_COL)} ${'worker'.padEnd(WORKER_COL)} task`
  return paint('', head, colors, { dim: true, underline: true })
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
  const color = o.status === 'aborted' ? ABORTED : statusOf(o).color
  const key = o.hash === undefined ? '' : ` ${paint('', o.hash, colors, { dim: true })}`
  return `${paint(color, outcomeWord(o), colors)} ${paintTaskId(node, colors)}${key}`
}

/** Compact one-liner for an executed task in broad mode. */
export function formatTaskExecutedLine(
  node: TaskNode,
  o: TaskOutcome,
  colors: ColorSupport = NO_COLOR,
  onPath = false,
  blocks?: number,
  usualMs?: number,
): string {
  return formatOutcomeRow(o, paintTaskId(node, colors), o.durationMs, colors, onPath, {
    ...executedCells(o, blocks),
    usual: usualDelta(o.durationMs, usualMs, colors),
  })
}

/** An executed task's cells: where and how long it waited, its average cores and peak memory. */
export function executedCells(o: TaskOutcome, blocks: number | undefined): RowCells {
  const cores = coresOf(o)
  return {
    ...ranCells(o, blocks),
    ...(cores !== undefined ? { cpu: cores } : {}),
    ...(o.peakRssBytes !== undefined ? { memBytes: o.peakRssBytes } : {}),
  }
}

/** The cells every row of a task that reached a machine carries. */
function ranCells(o: TaskOutcome, blocks: number | undefined): RowCells {
  return {
    // A skip reached no machine.
    ...(o.status === 'skipped' ? {} : { worker: o.where ?? 'local' }),
    ...(blocks !== undefined ? { blocks: String(blocks) } : {}),
    ...(waited(o.queuedMs) ? { waitedMs: o.queuedMs! } : {}),
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
  return `  ${paint(ERROR, 'critical path', colors)}`
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
  return `${paint('', ' \u00b7', colors, { dim: true })} ${ui.inline(ui.place(where), colors)}`
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
  return ` ${paint('', text, colors, { dim: true })}`
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
  const suffix = why === '' ? '' : ` ${paint('', `• ${why}`, colors, { dim: true })}`
  return (
    formatTaskRow(
      paint(WARN, '\u2298', colors),
      null,
      'skipped',
      WARN,
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
      paint('', '\u25cc', colors, { dim: true }),
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
    paint(ABORTED, '\u2717', colors),
    o.durationMs,
    'aborted',
    ABORTED,
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
  const corner = (t: string) => paint('', t, colors, { dim: true })
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
  const dim = (text: string): string => paint('', text, colors, { dim: true })
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
    sectionLine(denials > 0 ? `SANDBOX VIOLATIONS (${denials})` : 'SANDBOX', ERROR, colors),
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
  const corner = (t: string) => paint('', t, colors, { dim: true })
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
  return node.config.exec?.persistent !== undefined ? `${paint(ACCENT, '▸', colors)} ` : ''
}

function runningFooter(o: TaskOutcome, colors: ColorSupport): string {
  return ` ${paint('', `(${formatElapsed(o.durationMs)})`, colors, { dim: true })} ${paint(ACCENT, 'running', colors)}`
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
  pushStreamSection(lines, stdout, 'STDOUT (since ready)', SUCCESS, dropped.stdout ?? 0, colors)
  pushStreamSection(lines, stderr, 'STDERR (since ready)', ERROR, dropped.stderr ?? 0, colors)
  lines.push(formatFrameClose(node, outcome, colors))
  return lines.join('\n') + '\n'
}

/**
 * What a kept server writes after the summary, one line at a time under its
 * id (`app#dev │ Local: http://localhost:5173`), so several servers'
 * logs read apart. `text` holds whole lines, its last newline cut off.
 */
export function formatKeptLines(node: TaskNode, text: string, colors: ColorSupport): string {
  const prefix = `${paintTaskId(node, colors)} ${paint('', '│', colors, { dim: true })} `
  return text
    .split('\n')
    .map((line) => {
      const shown = lastRedraw(line)
      return `${prefix}${shown}${leavesStyle(shown) ? RESET : ''}\n`
    })
    .join('')
}

// eslint-disable-next-line no-control-regex -- ESC is the point
const LINE_RESET = /\r|\x1b\[[12]K|\x1b\[[01]?G/g
// eslint-disable-next-line no-control-regex -- ESC is the point
const TRAILING_RESETS = /(?:\r|\x1b\[[12]K|\x1b\[[01]?G)+$/
// eslint-disable-next-line no-control-regex -- ESC is the point
const SGR = /\x1b\[[0-9;]*m/g

/**
 * What a line shows once its redraws have played: the text after its last
 * `\r`, line erase (`CSI 1K`/`2K`) or move to column 1 (`CSI G`), with the
 * colours set before it. Written after an id prefix, a dev server's redraw
 * (`\x1b[2K\x1b[1Gbuilt in 30ms`, a `10%\r100%` progress line) erased or
 * overwrote the prefix on a terminal. A reset that ends the line, as in
 * CRLF, redraws nothing.
 */
function lastRedraw(line: string): string {
  if (!line.includes('\r') && !line.includes('\x1b')) return line
  const text = line.replace(TRAILING_RESETS, '')
  let cut = -1
  for (const m of text.matchAll(LINE_RESET)) cut = m.index + m[0].length
  if (cut === -1) return text
  return (text.slice(0, cut).match(SGR) ?? []).join('') + text.slice(cut)
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
      `  ${paint(ACCENT, '▸', colors)} ${paintTaskId(n, colors)} ${paint('', 'running', colors, { dim: true })}`,
  )
}

function formatBlockHeader(o: TaskOutcome, colors: ColorSupport): string {
  const shortHash = o.hash ? o.hash.slice(0, 8) : ''
  const dim = (s: string) => paint('', s, colors, { dim: true })
  const word = outcomeLabel(o)
  switch (o.status) {
    case 'cache-hit':
      return `${paint(SUCCESS, word, colors)} ${dim(`• ${shortHash}`)}`
    case 'cache-hit-remote':
      // A remote restore is the one hit painted accent: bytes came off the wire.
      return `${paint(o.restored === false ? SUCCESS : ACCENT, word, colors)} ${dim(`• ${shortHash}`)}`
    case 'failed':
      // The command lives in its own `├─ command` section; the header
      // carries the outcome like every other status.
      return paint(ERROR, word, colors, { bold: true })
    case 'skipped':
      return paint(WARN, word, colors)
    case 'aborted':
      return paint(ABORTED, word, colors)
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
  const dur = paint('', `(${formatElapsed(o.durationMs)})`, colors, { dim: true })
  const tag = formatStatusTag(o, colors)
  return ` ${dur} ${tag}${flakyNote(o, colors)}`
}

function formatStatusTag(o: TaskOutcome, colors: ColorSupport): string {
  const word = outcomeLabel(o)
  switch (o.status) {
    case 'failed':
      return paint(ERROR, word, colors, { bold: true })
    case 'skipped':
      return paint(WARN, word, colors)
    case 'aborted':
      return paint(ABORTED, word, colors)
    default:
      return paint('', word, colors, { dim: true })
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
