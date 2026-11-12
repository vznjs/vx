// Header and per-task framed output.
//
// Per-task block: ┌─ @vzn/vx#lint > success ├─ command oxlint --type-aware
// --type-check ├─ stdout Found 0 warnings and 0 errors. └─ @vzn/vx#lint ──
// (327ms) success
//
// Content lines are raw, no border or indent: a border collides with terminal
// wrapping and pollutes copy/paste; the dim section headers carry the
// structure.
//
// Each block is emitted whole at completion, so concurrent tasks never
// interleave, at the price of no live progress within a task (Turbo's
// `--ui=stream`).

import { withForwardArgs } from '../exec/index.js'
import {
  isCacheHit,
  isGroupTask,
  isKeyFailed,
  type SandboxFix,
  type TaskNode,
  type TaskOutcome,
} from '../graph/index.js'
import { formatElapsed, maskedCommand, printable } from '../util/index.js'
import * as ui from '../ui/index.js'
import {
  fileMemo,
  GUTTER,
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
   * Characters dropped from the head of each stream, for a bounded (persistent)
   * task's output, rendered so a capped log never reads as complete.
   */
  droppedStdout?: number
  droppedStderr?: number
}

export function formatTaskBlock(
  node: TaskNode,
  outcome: TaskOutcome,
  body: TaskBlockBody,
  colors: ColorSupport = NO_COLOR,
  // Force the `$ cmd` line even for hits: a focused requested task's frame is
  // the same whether it ran or was cached.
  forceCommand = false,
  forwardArgs: readonly string[] = [],
  // The terminal opens OSC 8 links: a failed task's paths become links.
  links = false,
): string {
  // Groups do no work and have no body: an empty box is noise. The summary and
  // analytics exclude them too.
  if (isGroupTask(node)) return ''

  const output = body.output ?? []

  const idPainted = paintTaskId(node, colors, { bold: true })
  const corner = (s: string) => paint('muted', s, colors)
  // A ready server's frame reads as the live one does: marked, and running.
  const mark = persistentMark(node, colors)
  const running = mark !== '' && outcome.status === 'success' && outcome.serverExit === undefined
  const header = running ? paint('info', 'running', colors) : formatBlockHeader(outcome, colors)
  const lines: string[] = [`${corner('┌─')} ${mark}${idPainted} ${corner('>')} ${header}`]

  // The command section shows what ran. Hits skip it, unless `forceCommand`.
  if (forceCommand || ranCommand(outcome)) {
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
    '',
  )
  // Not `+ '\n'`: a rope over a 100 MB frame was flattened into a copy.
  return lines.join('\n')
}

/** What a bounded capture dropped from its head, so a capped log never reads as whole. */
function droppedNote(lost: number, colors: ColorSupport): string {
  return paint('muted', `… ${lost} earlier character${lost === 1 ? '' : 's'} dropped`, colors)
}

/**
 * One `├─ <LABEL>` section, with the head-dropped notice; shared by the task
 * frame and the persistent tail so they cannot drift.
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
 * The `├─ OUTPUT` section: lines in the order written, so an error stays beside
 * its context. A stderr line is red; uncoloured, the bytes are untouched. A
 * line the task coloured keeps its colours (a reset would end ours mid-line). A
 * line takes the stream that began it.
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
  const emit = (line: string, err: boolean): void => {
    const text = link === undefined ? line : link(line)
    if (!err || !colors.enabled) lines.push(text)
    else lines.push(hasEscape(line) ? text : paint('error', text, colors))
  }
  // A run of untouched lines is pushed as one slice: an object and string per
  // line peaked a 50 MB log's frame at ~11x its size.
  let open: { parts: string[]; err: boolean } | null = null
  for (const c of output) {
    const text = c.text
    let at = 0
    if (open !== null) {
      const nl = text.indexOf('\n')
      open.parts.push(nl < 0 ? text : text.slice(0, nl))
      if (nl < 0) continue
      emit(open.parts.join(''), open.err)
      open = null
      at = nl + 1
    }
    if (link === undefined && (!c.err || !colors.enabled)) {
      const last = text.lastIndexOf('\n')
      if (last >= at) {
        lines.push(text.slice(at, last))
        at = last + 1
      }
    } else {
      for (let nl = text.indexOf('\n', at); nl >= 0; nl = text.indexOf('\n', at)) {
        emit(text.slice(at, nl), c.err)
        at = nl + 1
      }
    }
    if (at < text.length) open = { parts: [text.slice(at)], err: c.err }
  }
  if (open !== null) emit(open.parts.join(''), open.err)
  const styled = output.findLast((c) => hasEscape(c.text))
  if (styled !== undefined && leavesStyle(styled.text)) lines.push(`${lines.pop()}${STYLE_END}`)
  lines.push('')
}

/**
 * Section labels are bold and state-coloured (stdout green, stderr red, sandbox
 * yellow, command plain); only the command content is grey. A dim rule trails
 * each label to the frame width, and sections get vertical margins.
 */
function sectionLine(title: string, color: Style, colors: ColorSupport): string {
  const corner = (s: string) => paint('muted', s, colors)
  const label = paint(color, title, colors, true)
  // As wide as the footer's rule, so the frames and the footer line up.
  const rule = corner('─'.repeat(Math.max(1, ruleWidth(colors) - 4 - title.length)))
  return `${corner('├─')} ${label} ${rule}`
}

/**
 * Append each line raw, so wrapping never meets frame glyphs; the trailing
 * newline is trimmed.
 */
function pushBodyLines(lines: string[], text: string): void {
  for (const line of text.replace(/\n$/, '').split('\n')) lines.push(line)
}

/**
 * `project#task` halves, each in its name's identity hue, a dim separator
 * between. `hueSource` hashes the full project name, so the hue survives
 * truncation.
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

// ── Reported-line grid: status · cache · usual · time · … · name ──────── No
// glyph: the status word (at the Summary's value column) and cache word are the
// two axes, each coloured. Time is right-aligned in a fixed cell so a ticking
// elapsed never shifts the row. Detail lives in the frame.
const TIME_COL = 7 // "0ms" … "999.99s", then "16m 40s" … "99m 59s"
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
  if (ms === null) return pad(TIME_COL - 1) + paint('muted', UNKNOWN, colors)
  let raw = formatElapsed(ms)
  // `1000.00s` is wider than the cell; minutes fit it up to `99m 59s`.
  if (ms !== null && raw.length > TIME_COL) raw = formatElapsed(ms, true)
  // The time is the row's fact (value level); the cells around it are meta.
  return pad(TIME_COL - raw.length) + paint('value', raw, colors)
}

/**
 * Paint `text`, padded to `width` by visible length. An empty colour renders
 * dim (`miss`); empty text is a blank cell.
 */
function cell(text: string, color: Style | '', width: number, colors: ColorSupport): string {
  const painted = text === '' ? '' : paint(color === '' ? 'muted' : color, text, colors)
  return painted + pad(width - text.length)
}

/** Task-axis word + color (a cache hit is a success). */
function statusOf(o: TaskOutcome): { word: string; color: Style } {
  switch (o.status) {
    case 'failed':
      return FAILED
    case 'skipped':
      return SKIPPED
    default:
      return SUCCEEDED
  }
}
// One each, never one per row: callers only read them.
const FAILED: { word: string; color: Style } = { word: 'failed', color: 'error' }
const SKIPPED: { word: string; color: Style } = { word: 'skipped', color: 'warn' }
const SUCCEEDED: { word: string; color: Style } = { word: 'success', color: 'ok' }

/** Whether the task ran its command: a hit whose restore failed did not, nor a task with no key. */
function ranCommand(o: TaskOutcome): boolean {
  return (
    o.status === 'success' || (o.status === 'failed' && o.restoreFailed !== true && !isKeyFailed(o))
  )
}

/**
 * Cache-axis word + color. Empty for states that never reached the cache,
 * a hit whose restore failed (neither a miss nor a hit) and a task with no key.
 */
function cacheOf(o: TaskOutcome): { word: string; color: Style } {
  if (o.restoreFailed === true || isKeyFailed(o)) return NO_CACHE_WORD
  switch (o.status) {
    case 'success':
    case 'failed':
      // A task no cache answered for never consulted one: not a miss.
      return ranNoCache(o) ? NO_CACHE : MISS // dim
    case 'cache-hit':
      return o.cache?.restored === false ? FRESH : LOCAL
    case 'cache-hit-remote':
      return o.cache?.restored === false ? FRESH : REMOTE
    default:
      return NO_CACHE_WORD
  }
}
const NO_CACHE_WORD: { word: string; color: Style } = { word: '', color: 'muted' }
const NO_CACHE: { word: string; color: Style } = { word: 'no-cache', color: 'muted' }
const MISS: { word: string; color: Style } = { word: 'miss', color: 'muted' }
const FRESH: { word: string; color: Style } = { word: 'fresh', color: 'ok' }
const LOCAL: { word: string; color: Style } = { word: 'local', color: 'local' }
const REMOTE: { word: string; color: Style } = { word: 'remote', color: 'remote' }

/**
 * One task row on the list grid: `<status> <cache> <usual> <time> <cpu> <mem>
 * <outputs> <blocks> <worker> <mark> <name>`. `ms = null` blanks the time (a
 * skip); `cache = ''` and absent cells are blank.
 */
export function formatTaskRow(
  ms: number | null,
  status: string,
  statusColor: Style | '',
  cache: string,
  cacheColor: Style | '',
  paintedId: string,
  colors: ColorSupport = NO_COLOR,
  cells: RowCells = {},
): string {
  // Every cell says something: one with nothing in it reads `—`.
  const st = cell(status || UNKNOWN, statusColor, STATUS_COL, colors)
  // `aborting` runs one into the cache cell.
  const ca = cell(
    cache || UNKNOWN,
    cache === '' ? '' : cacheColor,
    CACHE_COL - Math.max(0, status.length - STATUS_COL),
    colors,
  )
  const usual =
    cells.usual === undefined || cells.usual.text === '' ? unknownUsual(colors) : cells.usual
  const us = `${pad(USUAL_COL - usual.text.length)}${usual.painted}`
  const cpu = cells.cpu == null ? UNKNOWN : `${Math.round(cells.cpu * 100)}%`
  const mem = cells.memBytes == null ? UNKNOWN : formatSize(cells.memBytes)
  const out = cells.outputBytes == null ? UNKNOWN : formatSize(cells.outputBytes)
  const blocks = cells.blocks || UNKNOWN
  const worker = workerName(cells.worker || UNKNOWN)
  return (
    `${ROW_LEAD}${st} ${ca} ${us} ${timeCell(ms, colors)} ` +
    `${right(cpu, CPU_COL, colors)} ${right(mem, MEM_COL, colors)} ${right(out, OUT_COL, colors)} ` +
    `${pad(BLOCKED_COL - blocks.length)}${paint(blocks === '0' || blocks === UNKNOWN ? 'muted' : 'value', blocks, colors)} ` +
    `${placeCell(worker, colors)}${pad(WORKER_COL - worker.length)} ` +
    `${cells.critical === true ? paint('warn', CRITICAL_MARK, colors) : ' '} ${paintedId}`
  )
}

/** A cell with nothing in it: unknown, or not applying to the row (a hit ran nothing). */
const UNKNOWN = '\u2014'

/**
 * The critical path's mark, before the task's name: the row's task held the
 * run's end while others ran beside it. One glyph, yellow.
 */
const CRITICAL_MARK = '\u25c6'

/** A grid row's lead: the gutter, so a row starts where a field's value does. */
const ROW_LEAD = ' '.repeat(GUTTER)

/** A row's cells past time, status and cache; each blank when absent, `—` when null. */
export interface RowCells {
  /** After the time, pre-painted: `~18s` live, `+6.0s` / `−1.4s` after. */
  usual?: { text: string; painted: string }
  /** Cores in use (live) or on average (after): 1.8 prints `180%`. */
  cpu?: number | null
  /** Resident memory now (live) or at its peak (after). */
  memBytes?: number | null
  /** The bytes of the task's outputs: what its save stored, or its hit restored. */
  outputBytes?: number | null
  /** How many tasks are downstream. */
  blocks?: string
  /** The machine it runs or ran on: `local`, or the executor's name for it. */
  worker?: string
  /** On the critical path: `◆` before the task's name. */
  critical?: boolean
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
  if (worker === UNKNOWN) return paint('muted', UNKNOWN, colors)
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
  return o.usage?.cpuMs === undefined || o.durationMs <= 0
    ? undefined
    : o.usage?.cpuMs / o.durationMs
}

/**
 * The `±usual` cell: how far a run was from its usual time, red or green beyond
 * a fifth either way, dim within; `—` with no history for the task, blank with
 * no history to ask.
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
 * The header over a task list: dim and underlined across the line, straight
 * over its rows (bold in a hue, it blended in).
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
    `${'status'.padEnd(STATUS_COL)} ${'cache'.padEnd(CACHE_COL)} ${usual.padStart(USUAL_COL)} ` +
    `${'time'.padStart(TIME_COL)} ${'cpu'.padStart(CPU_COL)} ` +
    `${'mem'.padStart(MEM_COL)} ${'outputs'.padStart(OUT_COL)} ${'blocks'.padStart(BLOCKED_COL)} ${'worker'.padEnd(WORKER_COL)}   task`
  return paint('muted', head, colors)
}

/**
 * The task list on its grid, under its header: the run's results panel's
 * body, and `vx last`'s, so a replay reads as the run did.
 */
export function taskList(rows: readonly ((colors: ColorSupport) => string)[]): ui.Block {
  return { head: formatListHeader, lines: (c) => rows.map((row) => row(c)) }
}

/** What history keeps of a task's row: `vx last` draws it again from this. */
export interface RecordedRow {
  project: string
  task: string
  status: string
  durationMs: number
  /** Null on a cached task's failure: its hit's restore failed. */
  cacheHit: boolean | null
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
    config: r.cached === false ? {} : { cache: true },
  } as unknown as TaskNode
  const o = {
    node,
    status: r.status,
    durationMs: r.durationMs,
    ...(r.status === 'failed' && r.cached === true && r.cacheHit === null
      ? { restoreFailed: true }
      : {}),
    cache: {
      ...(r.restored !== null ? { restored: r.restored } : {}),
      ...(r.outputBytes !== null ? { outputBytes: r.outputBytes } : {}),
    },
    usage: {
      ...(r.cpuMs !== null ? { cpuMs: r.cpuMs } : {}),
      ...(r.peakRssBytes !== null ? { peakRssBytes: r.peakRssBytes } : {}),
    },
    ...(r.placement !== null ? { placement: { where: r.placement } } : {}),
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
 * A running task's usual duration, fixed while its elapsed counts up: `~5.2s`,
 * `~42s`, `~2m 05s`.
 */
export function formatExpected(ms: number): string {
  // The tier by the rounded value: 999.6 ms printed `~1000ms`.
  if (Math.round(ms) < 1000) return `~${Math.round(ms)}ms`
  if (ms < 9950) return `~${(ms / 1000).toFixed(1)}s`
  const s = Math.round(ms / 1000)
  if (s < 60) return `~${s}s`
  return `~${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

/** A task `--dry` lists: what the run would do with it, on the running list's grid. */
export interface PlannedRow {
  node: TaskNode
  status: string
  /** The status word's hue. */
  tone: Style
  cache: string
  cacheTone: Style | ''
  /** Its usual time, from history; null for a task that runs and history never timed. */
  usualMs?: number | null
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
    head: formatRunningHeader,
    lines: (c) =>
      rows.map((r) => {
        const usual =
          r.usualMs === undefined
            ? undefined
            : r.usualMs === null
              ? UNKNOWN
              : formatExpected(r.usualMs)
        const row = formatTaskRow(
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
  return formatOutcomeRow(
    o,
    paintTaskId(node, colors),
    o.durationMs,
    colors,
    onPath,
    ranCells(o, blocks),
  )
}

/**
 * The `--output-logs hash-only` line: outcome word, id, and key (absent when
 * never computed).
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
  const cells = executedCells(o, blocks)
  // A hit's time is a restore's, not the task's: nothing to compare.
  if (ranCommand(o)) cells.usual = usualCell(o.durationMs, usualMs, colors)
  return formatOutcomeRow(o, paintTaskId(node, colors), o.durationMs, colors, onPath, cells)
}

/**
 * An executed task's cells: where it ran, its average cores and peak
 * memory; a task that ran with either unread shows `—`, a hit nothing.
 */
export function executedCells(o: TaskOutcome, blocks: number | undefined): RowCells {
  const cores = coresOf(o)
  const ran = ranCommand(o)
  const cells = ranCells(o, blocks)
  if (cores !== undefined) cells.cpu = cores
  else if (ran) cells.cpu = null
  if (o.usage?.peakRssBytes !== undefined) cells.memBytes = o.usage.peakRssBytes
  else if (ran) cells.memBytes = null
  return cells
}

/**
 * The cells every row of a task that reached a machine carries. Assigned, not
 * spread: spreads were ~4 ms of 8,002 hits' rows.
 */
function ranCells(o: TaskOutcome, blocks: number | undefined): RowCells {
  const cells: RowCells = {}
  // A skip reached no machine.
  if (o.status !== 'skipped') cells.worker = o.placement?.where ?? 'local'
  if (blocks !== undefined) cells.blocks = String(blocks)
  // A row with no outputs size says so (`—`); blank read as a column left out.
  if (o.status !== 'skipped') cells.outputBytes = o.cache?.outputBytes ?? null
  return cells
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
      ms,
      st.word,
      st.color,
      ca.word,
      ca.color,
      paintedId,
      colors,
      onPath ? { ...cells, critical: true } : cells,
    ) + flakyNote(o, colors)
  )
}

/** Where an executor ran the task, when not here, right after its id: `@small#2`. */
function whereNote(o: TaskOutcome, colors: ColorSupport = NO_COLOR): string {
  return o.placement?.where === undefined ? '' : placeNote(o.placement?.where, colors)
}

/**
 * ` · <where>` after the id: the dot dim, the place in its own hue. Last on the
 * row, as a worker's name has no width to pad to.
 */
function placeNote(where: string, colors: ColorSupport = NO_COLOR): string {
  return `${paint('muted', ' \u00b7', colors)} ${ui.inline(ui.place(where), colors)}`
}

/**
 * The dim flaky note on a task's row and frame: nothing prints below the
 * footer. Not proved flaky: its attempts if more than one, else ''.
 */
export function flakyNote(o: TaskOutcome, colors: ColorSupport = NO_COLOR): string {
  // A retry with no key to prove a flake (no `cache: true`) still ran:
  // the row is the only place a live run says so (`vx last` did).
  const count = o.attempts?.count ?? 1
  const flaky = o.attempts?.flaky
  if (flaky === undefined) return count > 1 ? ` ${paint('muted', `${count} attempts`, colors)}` : ''
  const said: string[] = []
  if (o.status === 'failed' && flaky.passes > 0) said.push(`passed ${flaky.passes}\u00d7 before`)
  if (o.status !== 'failed' && flaky.failures > 0) {
    said.push(`failed ${flaky.failures}\u00d7 before`)
  }
  if (count > 1) said.push(`${count} attempts`)
  const text = said.length === 0 ? 'flaky' : `flaky - ${said.join(' \u00b7 ')}`
  return ` ${paint('muted', text, colors)}`
}

/**
 * One line for a skipped task (it never ran); the blocker rides the row, since
 * nothing prints below the footer.
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
 * One row for a task a shutdown killed (`aborted`, time so far) or the stop
 * reached first (`not run`). Neither reached the cache.
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
    return formatTaskRow(null, 'not run', '', '', '', id, colors, bl)
  }
  return formatTaskRow(o.durationMs, 'aborted', 'aborted', '', '', id, colors, ranCells(o, blocks))
}

/**
 * Focused mode's live frame: output streams raw between an opening line (id,
 * command) and a closing one (id, duration, outcome).
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
 * Sandbox violations get their own section in the frame, in context with the
 * failing task. Shared by both renderers: the live frame once omitted it, so
 * debugging one task showed a failure with no violations.
 */
function violationSection(outcome: TaskOutcome, colors: ColorSupport): string[] {
  const vlines = outcome.sandbox?.lines
  if (!vlines || vlines.length === 0) return []
  // Unique lines only (children trip the same denial repeatedly), printed
  // verbatim: a violation is evidence. Control bytes excepted, as `\xNN`: a
  // path named `ESC ]0;…` retitled the terminal. The outcome keeps every
  // record.
  const body = [...new Set(vlines)].map(printable)
  // Red: a violation fails the task. vx's note follows the evidence: the grants
  // that would allow it, and the reads no input glob matches, which the user
  // decides on.
  const fix = outcome.sandbox?.fix
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
                  `and, if the output depends on them, inputs.files: [${fix.inputs.map(jsString).join(', ')}]`,
                ),
              ]
            : []),
          ...(fix.workspaceFiles !== undefined
            ? [
                dim(
                  `and, if the output depends on them, inputs.workspaceFiles: [${fix.workspaceFiles.map(jsString).join(', ')}]`,
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
  // A persistent task keeps running past this outcome, so the close reads
  // `running`; ▸ marks both ends.
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
 * What a persistent task wrote after ready, as one trailing block in the live
 * frame's `▸ … running` vocabulary: a tail, not a completed log. Titles say
 * `(since ready)`; a head-dropped tail says what it lost. Empty body: ''.
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
 * A kept server's output after the summary, a line at a time under its id, so
 * several servers read apart. `text` holds whole lines.
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
 * Between the frame and the footer, one `▸ <id> running` row per persistent
 * task kept in the foreground.
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
      return `${paint(o.cache?.restored === false ? 'ok' : 'info', word, colors)} ${dim(`• ${shortHash}`)}`
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
  // Footer: ` (<dur>) <status>`. The duration is what this run spent; for a
  // hit, probe and restore, not the stored exec time
  // (`TaskOutcome.cache.stored.durationMs`).
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

/** A fix path as the single-quoted JS literal the config line pastes. */
const jsString = (p: string): string => `'${printable(p.replace(/[\\']/g, '\\$&'))}'`

/**
 * The fix as the config line it is: `exec.sandbox.allow: { read: ['a'] }`,
 * or undefined when every denial was a withheld credential path.
 */
function sandboxFixLine(f: SandboxFix): string | undefined {
  const fix = Object.entries(f as Record<string, string[]>).filter(
    ([k]) => k !== 'withheld' && k !== 'inputs' && k !== 'workspaceFiles',
  )
  if (fix.length === 0) return undefined
  const parts = fix.map(([k, list]) => `${k}: [${list.map(jsString).join(', ')}]`)
  return `exec.sandbox.allow: { ${parts.join(', ')} }`
}
