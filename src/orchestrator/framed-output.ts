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

import { isGroupTask, type TaskNode, type TaskOutcome } from '../graph/index.js'
import { paint, type ColorSupport } from './colors.js'
import { formatDuration } from './summary.js'

const NO_COLOR: ColorSupport = { enabled: false }

const ACCENT = '#06b6d4' // cyan-500 — bullets, remote-hit hint
// Identity hues — deliberately outside the status palette (green /
// red / yellow / cyan) so a task id can never read as an outcome.
// Projects hash to a stable hue (same project = same color in every
// run, list, and region row); tasks keep one fixed hue excluded from
// the project palette so the two halves always read apart.
// Section rules + the summary rule share one frame width.
const FRAME_WIDTH = 60

const PROJECT_PALETTE = [
  '#a78bfa', // violet-400
  '#60a5fa', // blue-400
  '#e879f9', // fuchsia-400
  '#818cf8', // indigo-400
  '#c084fc', // purple-400
  '#93c5fd', // blue-300
] as const
const TASK = '#f472b6' // pink-400 — task part of an id
const SUCCESS = '#22c55e' // green-500 — success / fresh
const WARN = '#eab308' // yellow-500 — skipped
const ERROR = '#ef4444' // red-500 — failed
const LOCAL = '#38bdf8' // sky-400 — local cache hit
const REMOTE = '#2563eb' // blue-600 — remote cache hit

export interface TaskBlockBody {
  /** stdout chunks accumulated during the task. Renders under `├─ stdout`. */
  stdout?: string
  /** stderr chunks. Renders under `├─ stderr`. */
  stderr?: string
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
): string {
  // Group tasks (no `exec`) do no work and have no body — they're
  // organizational nodes the user wrote so a `vx run ci` invocation
  // has a single name to address. Showing an empty box for them is
  // pure noise. Same exclusion the summary totals + analytics
  // pass already make.
  if (isGroupTask(node)) return ''

  const stdout = body.stdout ?? ''
  const stderr = body.stderr ?? ''

  const idPainted = paintTaskId(node, colors, { bold: true })
  const corner = (s: string) => paint('', s, colors, { dim: true })
  const section = (title: string, color?: string) => sectionLine(title, color ?? '', colors)
  const header = formatBlockHeader(outcome, colors)
  const lines: string[] = [`${corner('┌─')} ${idPainted} ${corner('>')} ${header}`]

  // The command section shows what actually ran — executed tasks
  // (success and failed). Cache hits normally skip it (the stored
  // output is the interesting part), but `forceCommand` keeps it for
  // focused requested tasks so their frame is hit/miss-identical.
  if (forceCommand || outcome.status === 'success' || outcome.status === 'failed') {
    // No section label for the command (owner cut it) — the dim `$ `
    // line under the header reads as the command on its own.
    lines.push('', corner(`$ ${node.config.exec?.command ?? ''}`), '')
  }

  if (stdout.trim().length > 0) {
    lines.push(section('STDOUT', SUCCESS), '')
    pushBodyLines(lines, stdout)
    lines.push('')
  }

  if (stderr.trim().length > 0) {
    lines.push(section('STDERR', ERROR), '')
    pushBodyLines(lines, stderr)
    lines.push('')
  }

  // Sandbox violations get a dedicated section inside the frame so the
  // user sees them in context with the failing task, not as loose
  // status output above the box.
  const vlines = outcome.sandboxViolationLines
  if (vlines && vlines.length > 0) {
    lines.push(section(`SANDBOX VIOLATIONS (${vlines.length})`, WARN), '')
    for (const v of vlines) lines.push(v)
    lines.push('')
  }

  lines.push(`${corner('└─')} ${idPainted} ${corner('──')}${formatBlockFooter(outcome, colors)}`)
  return lines.join('\n') + '\n'
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
  const rule = corner('─'.repeat(Math.max(1, FRAME_WIDTH - 4 - title.length)))
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

/** Stable per-project hue: FNV-style fold of the name into the palette. */
export function projectColor(projectName: string): string {
  let h = 0
  for (let i = 0; i < projectName.length; i++) {
    h = (h * 31 + projectName.charCodeAt(i)) >>> 0
  }
  return PROJECT_PALETTE[h % PROJECT_PALETTE.length]!
}

/**
 * `project#task` halves in distinct identity hues (never status
 * colors); the dim separator keeps them reading apart. `hueSource`
 * exists for truncated display strings: the hue must hash from the
 * FULL project name so it survives truncation.
 */
export function paintIdParts(
  hueSource: string,
  projectText: string,
  taskText: string,
  colors: ColorSupport,
  opts: { bold?: boolean } = {},
): string {
  const dim = (t: string) => paint('', t, colors, { dim: true })
  return (
    paint(projectColor(hueSource), projectText, colors, opts) +
    dim('#') +
    paint(TASK, taskText, colors, opts)
  )
}

export function paintId(
  projectName: string,
  taskName: string,
  colors: ColorSupport,
  opts: { bold?: boolean } = {},
): string {
  return paintIdParts(projectName, projectName, taskName, colors, opts)
}

export function paintTaskId(
  node: TaskNode,
  colors: ColorSupport,
  opts: { bold?: boolean } = {},
): string {
  return paintId(node.projectName, node.taskName, colors, opts)
}

// ── Reported-line grid: glyph · time · status · cache · name ────────
// glyph SHAPE encodes the cache axis (⏺ miss · ► fresh · ⇢ local · ⇣
// remote; ◼ failed · ⊘ skipped · ⦿ running), glyph COLOR encodes the
// task axis (green/red/yellow/cyan). The status and cache WORDS spell
// the two axes out, each in its own color. Time is right-aligned in a
// fixed cell so durations line up and a ticking elapsed never shifts
// the row. All detail (exit code, output) lives in the framed block.
export const TIME_COL = 7 // "0ms" … "999.99s"
export const STATUS_COL = 7 // "success" / "running" / "skipped"
export const CACHE_COL = 6 // "remote" / "local" / "fresh" / "miss"

/** Right-align the duration in a TIME_COL cell (pad on the left). */
function timeCell(ms: number | null, colors: ColorSupport): string {
  const raw = ms === null ? '' : formatDuration(ms)
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
      return { word: 'miss', color: '' } // dim
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
export function taskGlyph(o: TaskOutcome, colors: ColorSupport): string {
  return paint(statusOf(o).color, glyphShape(o), colors)
}

/**
 * One reported task row: `<glyph> <time> <status> <cache> <name>`.
 * `glyph` is pre-painted; status/cache are raw text + color, padded to
 * their columns; `paintedId` carries identity coloring. `ms = null`
 * blanks the time (e.g. a skip never ran); `cache = ''` blanks it.
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
): string {
  const st = cell(status, statusColor, STATUS_COL, colors)
  const ca = cell(cache, cacheColor, CACHE_COL, colors)
  return ` ${glyph} ${timeCell(ms, colors)} ${st} ${ca} ${paintedId}`
}

/** Compact one-liner for a cache hit with nothing to replay. */
export function formatTaskHitLine(
  node: TaskNode,
  o: TaskOutcome,
  colors: ColorSupport = NO_COLOR,
): string {
  return formatOutcomeRow(o, paintTaskId(node, colors), o.durationMs, colors)
}

/** Compact one-liner for an executed task in broad mode. */
export function formatTaskExecutedLine(
  node: TaskNode,
  o: TaskOutcome,
  colors: ColorSupport = NO_COLOR,
): string {
  return formatOutcomeRow(o, paintTaskId(node, colors), o.durationMs, colors)
}

/** Shared: render any outcome on the grid. */
function formatOutcomeRow(
  o: TaskOutcome,
  paintedId: string,
  ms: number | null,
  colors: ColorSupport,
): string {
  const st = statusOf(o)
  const ca = cacheOf(o)
  return formatTaskRow(
    taskGlyph(o, colors),
    ms,
    st.word,
    st.color,
    ca.word,
    ca.color,
    paintedId,
    colors,
  )
}

/** Compact one-liner for a skipped task — it never ran (blank time). */
export function formatTaskSkippedLine(node: TaskNode, colors: ColorSupport = NO_COLOR): string {
  return formatTaskRow(
    paint(WARN, '\u2298', colors),
    null,
    'skipped',
    WARN,
    '',
    '',
    paintTaskId(node, colors),
    colors,
  )
}

/**
 * Live-frame brackets for focused mode: the requested task's output
 * streams raw between an opening line (id + command) and a closing
 * line (id + duration + outcome). Same visual language as
 * formatTaskBlock, but emitted in real time around the live stream
 * instead of buffered.
 */
export function formatFrameOpen(node: TaskNode, colors: ColorSupport = NO_COLOR): string {
  const corner = (t: string) => paint('', t, colors, { dim: true })
  const cmd = node.config.exec?.command ?? ''
  const mark = isPersistentNode(node) ? `${paint(ACCENT, '▸', colors)} ` : ''
  return `${corner('┌─')} ${mark}${paintTaskId(node, colors, { bold: true })} ${corner('>')} $ ${cmd}`
}

export function formatFrameClose(
  node: TaskNode,
  outcome: TaskOutcome,
  colors: ColorSupport = NO_COLOR,
): string {
  const corner = (t: string) => paint('', t, colors, { dim: true })
  const persistent = isPersistentNode(node)
  const mark = persistent ? `${paint(ACCENT, '▸', colors)} ` : ''
  // A persistent task's child keeps running past this "ready" outcome,
  // so the close reads `running` (accent), not `success` — the ▸ marks
  // both ends of the frame as a long-lived task.
  const tail =
    persistent && outcome.status === 'success'
      ? ` ${paint('', `(${formatDuration(outcome.durationMs)})`, colors, { dim: true })} ${paint(ACCENT, 'running', colors)}`
      : formatBlockFooter(outcome, colors)
  return `${corner('└─')} ${mark}${paintTaskId(node, colors, { bold: true })} ${corner('──')}${tail}`
}

function isPersistentNode(node: TaskNode): boolean {
  return node.config.exec?.persistent !== undefined
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
  body: TaskBlockBody,
  dropped: { stdout?: number; stderr?: number } = {},
  colors: ColorSupport = NO_COLOR,
): string {
  const stdout = body.stdout ?? ''
  const stderr = body.stderr ?? ''
  if (stdout.trim().length === 0 && stderr.trim().length === 0) return ''
  const lines: string[] = [formatFrameOpen(node, colors)]
  const pushStream = (text: string, title: string, color: string, lost: number): void => {
    if (text.trim().length === 0) return
    lines.push(sectionLine(title, color, colors), '')
    if (lost > 0) {
      lines.push(paint('', `… ${lost} earlier characters dropped`, colors, { dim: true }))
    }
    pushBodyLines(lines, text)
    lines.push('')
  }
  pushStream(stdout, 'STDOUT (since ready)', SUCCESS, dropped.stdout ?? 0)
  pushStream(stderr, 'STDERR (since ready)', ERROR, dropped.stderr ?? 0)
  lines.push(formatFrameClose(node, outcome, colors))
  return lines.join('\n') + '\n'
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
  switch (o.status) {
    case 'cache-hit':
      if (o.restored === false) {
        return `${paint(SUCCESS, 'up-to-date', colors)} ${dim(`• ${shortHash}`)}`
      }
      return `${paint(SUCCESS, 'restored-local', colors)} ${dim(`• ${shortHash}`)}`
    case 'cache-hit-remote':
      if (o.restored === false) {
        return `${paint(SUCCESS, 'up-to-date', colors)} ${dim(`• ${shortHash}`)}`
      }
      return `${paint(ACCENT, 'restored-remote', colors)} ${dim(`• ${shortHash}`)}`
    case 'failed':
      // The command lives in its own `├─ command` section; the header
      // carries the outcome like every other status.
      return paint(ERROR, `failed (exit ${o.exitCode})`, colors, { bold: true })
    case 'skipped':
      return paint(WARN, 'skipped (upstream failed)', colors)
    case 'success':
      return dim('success')
    default:
      return o.status
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
  const dur = paint('', `(${formatDuration(o.durationMs)})`, colors, { dim: true })
  const tag = formatStatusTag(o, colors)
  return ` ${dur} ${tag}`
}

function formatStatusTag(o: TaskOutcome, colors: ColorSupport): string {
  switch (o.status) {
    case 'cache-hit':
      return paint('', o.restored === false ? 'up-to-date' : 'restored-local', colors, {
        dim: true,
      })
    case 'cache-hit-remote':
      return paint('', o.restored === false ? 'up-to-date' : 'restored-remote', colors, {
        dim: true,
      })
    case 'success':
      return paint('', 'success', colors, { dim: true })
    case 'failed':
      return paint(ERROR, `failed (exit ${o.exitCode})`, colors, { bold: true })
    case 'skipped':
      return paint(WARN, 'skipped', colors)
    default:
      return o.status
  }
}
