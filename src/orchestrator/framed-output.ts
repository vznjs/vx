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
//   ┌─ @vzn/vx#lint > cache hit • abc12345
//   $ oxlint --type-aware --type-check
//   Found 0 warnings and 0 errors.
//   └─ @vzn/vx#lint ──
//
// Output is buffered per-task and the whole block is emitted at task
// completion — concurrent tasks don't interleave their lines, but the
// price is no live progress within a task. This matches Turbo's
// `--ui=stream` mode.

import { isGroupTask, type TaskNode, type TaskOutcome } from '../graph/index.js'
import { paint, type ColorSupport } from './colors.js'
import { formatDuration } from './summary.js'

const NO_COLOR: ColorSupport = { enabled: false }

const ACCENT = '#06b6d4' // cyan-500 — bullets, task ids, remote-hit hint
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
}

export function formatHeader(input: HeaderInput, colors: ColorSupport = NO_COLOR): string[] {
  const bullet = paint(ACCENT, '•', colors)
  const taskList = input.tasks.join(', ')
  const pkgs = `${input.packageCount} package${input.packageCount === 1 ? '' : 's'}`
  const tasks = `${input.taskCount} task${input.taskCount === 1 ? '' : 's'}`
  return [
    `${bullet} ${paint('', `vx ${input.version}`, colors, { bold: true })}`,
    '',
    `   ${bullet} Running ${taskList} in ${pkgs} (${tasks})`,
    `   ${bullet} Remote caching ${input.remoteCacheEnabled ? 'enabled' : 'disabled'}`,
    '',
  ]
}

export interface TaskBlockBody {
  /** stdout chunks accumulated during the task. Renders in the body unprefixed-section. */
  stdout?: string
  /** stderr chunks. Renders under an `├─ Error` section header. */
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

  const id = node.id
  const idPainted = paint(ACCENT, id, colors, { bold: true })
  const corner = (s: string) => paint('', s, colors, { dim: true })
  const bar = corner('│')
  const tee = corner('├─')
  const header = formatBlockHeader(node, outcome, colors)
  const lines: string[] = [`${corner('┌─')} ${idPainted} ${corner('>')} ${header}`]

  // Show the command for executed tasks so the user sees what ran;
  // skip for cache hits (the captured stdout/stderr is the interesting
  // part). isGroupTask early-return above guarantees exec is defined;
  // TS can't see through the predicate's negation, so we re-narrow.
  const cmd = node.config.exec?.command ?? ''
  if (outcome.status === 'success') {
    lines.push(`${bar}   $ ${cmd}`)
  }

  pushBodyLines(lines, stdout, bar)

  if (stderr.length > 0) {
    lines.push(`${tee} ${paint(ERROR, 'Error', colors, { bold: true })}`)
    pushBodyLines(lines, stderr, bar)
  }

  // Sandbox violations get a dedicated section inside the frame so the
  // user sees them in context with the failing task, not as loose
  // status output above the box. Section header uses a T-junction
  // (├─) to read as part of the frame.
  const vlines = outcome.sandboxViolationLines
  if (vlines && vlines.length > 0) {
    const sectionTitle = paint(ERROR, `Sandbox Violations (${vlines.length})`, colors, {
      bold: true,
    })
    lines.push(`${tee} ${sectionTitle}`)
    for (const v of vlines) lines.push(`${bar}   ${v}`)
  }

  lines.push(`${corner('└─')} ${idPainted} ${corner('──')}${formatBlockFooter(outcome, colors)}`)
  return lines.join('\n') + '\n'
}

/**
 * Append each line of `text` to `lines`, prefixed by the frame's
 * vertical bar with 3 spaces of indent. Indent makes body content
 * visually nested under section headers (├─ Error, ├─ Sandbox
 * Violations, etc.). Empty body is skipped; trailing newlines are
 * trimmed; blank lines inside the body render as a lone bar.
 */
function pushBodyLines(lines: string[], text: string, bar: string): void {
  if (text.length === 0) return
  const trimmed = text.replace(/\n$/, '')
  for (const line of trimmed.split('\n')) {
    lines.push(line.length > 0 ? `${bar}   ${line}` : bar)
  }
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
        ? paint(ACCENT, 'remote-cache', colors)
        : paint(SUCCESS, 'local-cache', colors)
  const mark = paint(SUCCESS, '◌', colors)
  return `${mark} ${node.id} ${dim('──')} ${label} ${dim(`• ${shortHash}`)}`
}

function formatBlockHeader(node: TaskNode, o: TaskOutcome, colors: ColorSupport): string {
  const shortHash = o.hash ? o.hash.slice(0, 8) : ''
  const dim = (s: string) => paint('', s, colors, { dim: true })
  switch (o.status) {
    case 'cache-hit':
      if (o.restored === false) {
        return `${paint(SUCCESS, 'up-to-date', colors)} ${dim(`• ${shortHash}`)}`
      }
      return `${paint(SUCCESS, 'local-cache', colors)} ${dim(`• ${shortHash}`)}`
    case 'cache-hit-remote':
      if (o.restored === false) {
        return `${paint(SUCCESS, 'up-to-date', colors)} ${dim(`• ${shortHash}`)}`
      }
      return `${paint(ACCENT, 'remote-cache', colors)} ${dim(`• ${shortHash}`)}`
    case 'failed':
      return `$ ${node.config.exec?.command ?? '(no command)'}`
    case 'skipped':
      return paint(WARN, 'skipped (upstream failed)', colors)
    case 'success':
      return dim('cache-miss')
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
      return paint('', o.restored === false ? 'up-to-date' : 'local-cache', colors, { dim: true })
    case 'cache-hit-remote':
      return paint('', o.restored === false ? 'up-to-date' : 'remote-cache', colors, { dim: true })
    case 'success':
      return paint('', 'cache-miss', colors, { dim: true })
    case 'failed':
      return paint(ERROR, `FAILED (exit ${o.exitCode})`, colors, { bold: true })
    case 'skipped':
      return paint(WARN, 'skipped', colors)
    default:
      return o.status
  }
}
