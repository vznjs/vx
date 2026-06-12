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
const SUCCESS = '#22c55e' // green-500 — local cache-hit hint
const WARN = '#eab308' // yellow-500 — skipped
const ERROR = '#ef4444' // red-500 — failed

export interface HeaderInput {
  version: string
  /** Number of unique projects covered by the graph (group tasks included). */
  packageCount: number
  /** Display names of the tasks the user requested (already deduped). */
  tasks: readonly string[]
  /**
   * Number of (project, task) executions in the graph, excluding group
   * tasks (no `exec`). This is the count of real work the run will do —
   * matches the "total" the end-of-run summary reports.
   */
  taskCount: number
  remoteCacheEnabled: boolean
  /** Worker-pool size for this run; shown so the region rows have context. */
  concurrency?: number
}

export function formatHeader(input: HeaderInput, colors: ColorSupport = NO_COLOR): string[] {
  const bullet = paint(ACCENT, '•', colors)
  const taskList = input.tasks.join(', ')
  const pkgs = `${input.packageCount} package${input.packageCount === 1 ? '' : 's'}`
  const tasks = `${input.taskCount} task${input.taskCount === 1 ? '' : 's'}`
  const workers = input.concurrency !== undefined ? `, ${input.concurrency} workers` : ''
  return [
    `${bullet} ${paint('', `vx ${input.version}`, colors, { bold: true })}`,
    '',
    `   ${bullet} Running ${taskList} in ${pkgs} (${tasks}${workers})`,
    `   ${bullet} Remote caching ${input.remoteCacheEnabled ? 'enabled' : 'disabled'}`,
    '',
  ]
}

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
  // Section labels are bold + state-colored (owner design): stdout
  // green, stderr red, sandbox yellow, command plain white — only
  // the command CONTENT is greyed (context, not signal). A dim rule
  // trails each label to the frame width, and sections get vertical
  // margins so content stands clear of the furniture.
  const section = (title: string, color?: string) => {
    const label = paint(color ?? '', title, colors, { bold: true })
    const rule = corner('\u2500'.repeat(Math.max(1, FRAME_WIDTH - 4 - title.length)))
    return `${corner('\u251c\u2500')} ${label} ${rule}`
  }
  const header = formatBlockHeader(outcome, colors)
  const lines: string[] = [`${corner('┌─')} ${idPainted} ${corner('>')} ${header}`]

  // The command section shows what actually ran — executed tasks only
  // (success and failed); cache hits replay stored output and skip it,
  // skips never ran anything.
  if (outcome.status === 'success' || outcome.status === 'failed') {
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

/**
 * Compact one-liner for a cache hit with nothing to replay. Every
 * task stays visible in the log, but a hit costs one line instead of
 * a two-line frame — at 2000+ tasks that's the difference between a
 * scannable log and noise.
 */
export function formatTaskHitLine(
  node: TaskNode,
  o: TaskOutcome,
  colors: ColorSupport = NO_COLOR,
): string {
  const shortHash = o.hash ? o.hash.slice(0, 8) : ''
  const dim = (s: string) => paint('', s, colors, { dim: true })
  const label =
    o.restored === false
      ? paint(SUCCESS, 'up-to-date', colors)
      : o.status === 'cache-hit-remote'
        ? paint(ACCENT, 'restored-remote', colors)
        : paint(SUCCESS, 'restored-local', colors)
  const mark = paint(SUCCESS, '◌', colors)
  return `${mark} ${paintTaskId(node, colors)} ${dim('──')} ${label} ${dim(`• ${shortHash}`)}`
}

/**
 * Compact one-liner for an executed task in broad mode. Same shape as
 * the hit one-liner so the two read as one list; the extra after the
 * label is the exec duration instead of a cache hash.
 */
export function formatTaskExecutedLine(
  node: TaskNode,
  o: TaskOutcome,
  colors: ColorSupport = NO_COLOR,
): string {
  const dim = (s: string) => paint('', s, colors, { dim: true })
  const mark = paint(SUCCESS, '●', colors)
  return `${mark} ${paintTaskId(node, colors)} ${dim('──')} success ${dim(`• ${formatDuration(o.durationMs)}`)}`
}

/**
 * Compact one-liner for a skipped task — a skip produces no output by
 * definition, so a frame would be furniture without content. The
 * upstream-failed reason rides where the others carry hash/duration.
 */
export function formatTaskSkippedLine(node: TaskNode, colors: ColorSupport = NO_COLOR): string {
  const dim = (s: string) => paint('', s, colors, { dim: true })
  const mark = paint(WARN, '⊘', colors)
  return `${mark} ${paintTaskId(node, colors)} ${dim('──')} ${paint(WARN, 'skipped', colors)} ${dim('• upstream failed')}`
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
  return `${corner('┌─')} ${paintTaskId(node, colors, { bold: true })} ${corner('>')} $ ${cmd}`
}

export function formatFrameClose(
  node: TaskNode,
  outcome: TaskOutcome,
  colors: ColorSupport = NO_COLOR,
): string {
  const corner = (t: string) => paint('', t, colors, { dim: true })
  return `${corner('└─')} ${paintTaskId(node, colors, { bold: true })} ${corner('──')}${formatBlockFooter(outcome, colors)}`
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
  // Footer pattern: ` (<dur>) <status>`. Duration is always shown.
  // For cache hits it's the *original* exec time the entry was
  // stored with (set by execute-task), not the ~0ms replay cost.
  // Status differs by outcome — see formatStatusTag.
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
