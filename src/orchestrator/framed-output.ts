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

import type { TaskNode } from '../graph/task-graph.js'
import type { TaskOutcome } from '../graph/scheduler.js'
import { paint, type ColorSupport } from './colors.js'

const NO_COLOR: ColorSupport = { enabled: false }

const ACCENT = '#06b6d4' // cyan-500 — bullets, task ids, remote-hit hint
const SUCCESS = '#22c55e' // green-500 — local cache-hit hint
const WARN = '#eab308' // yellow-500 — skipped
const ERROR = '#ef4444' // red-500 — failed

export interface HeaderInput {
  version: string
  packages: readonly string[]
  /** Display names of the tasks the user requested (already deduped). */
  tasks: readonly string[]
  remoteCacheEnabled: boolean
}

export function formatHeader(input: HeaderInput, colors: ColorSupport = NO_COLOR): string[] {
  const sortedPkgs = [...input.packages].sort()
  const bullet = paint(ACCENT, '•', colors)
  const taskList = input.tasks.length === 1 ? input.tasks[0] : input.tasks.join(', ')
  return [
    `${bullet} ${paint('', `vx ${input.version}`, colors, { bold: true })}`,
    '',
    `   ${bullet} Packages in scope: ${sortedPkgs.join(', ')}`,
    `   ${bullet} Running ${taskList} in ${sortedPkgs.length} package${sortedPkgs.length === 1 ? '' : 's'}`,
    `   ${bullet} Remote caching ${input.remoteCacheEnabled ? 'enabled' : 'disabled'}`,
    '',
  ]
}

export function formatTaskBlock(
  node: TaskNode,
  outcome: TaskOutcome,
  body: string,
  colors: ColorSupport = NO_COLOR,
): string {
  // Group tasks (no `exec`) do no work and have no body — they're
  // organizational nodes the user wrote so a `vx run ci` invocation
  // has a single name to address. Showing an empty box for them is
  // pure noise. Same exclusion the summary totals + analytics
  // pass already make.
  if (node.config.exec === undefined) return ''

  const id = node.id
  const idPainted = paint(ACCENT, id, colors, { bold: true })
  const corner = (s: string) => paint('', s, colors, { dim: true })
  const header = formatBlockHeader(node, outcome, colors)
  const lines: string[] = [`${corner('┌─')} ${idPainted} ${corner('>')} ${header}`]

  // Show the command for executed tasks so the user sees what ran;
  // skip for cache hits (the captured stdout/stderr is the interesting
  // part).
  const cmd = node.config.exec.command
  if (outcome.status === 'success') lines.push(paint('', `$ ${cmd}`, colors, { dim: true }))

  if (body.length > 0) {
    lines.push(body.replace(/\n$/, ''))
  }

  lines.push(`${corner('└─')} ${idPainted} ${corner('──')}${formatBlockFooter(outcome, colors)}`)
  return lines.join('\n') + '\n'
}

function formatBlockHeader(node: TaskNode, o: TaskOutcome, colors: ColorSupport): string {
  const shortHash = o.hash ? o.hash.slice(0, 8) : ''
  const dim = (s: string) => paint('', s, colors, { dim: true })
  switch (o.status) {
    case 'cache-hit':
      return `${paint(SUCCESS, 'cache hit', colors)} ${dim(`• ${shortHash}`)}`
    case 'cache-hit-remote':
      return `${paint(ACCENT, 'remote cache hit', colors)} ${dim(`• ${shortHash}`)}`
    case 'failed':
      return `$ ${node.config.exec?.command ?? '(no command)'}`
    case 'skipped':
      return paint(WARN, 'skipped (upstream failed)', colors)
    case 'success':
      return dim('executed')
    default:
      return o.status
  }
}

function formatBlockFooter(o: TaskOutcome, colors: ColorSupport): string {
  // Footer pattern: ` (<dur>) <status>`. Duration is always shown.
  // For cache hits it's the *original* exec time the entry was
  // stored with (set by execute-task), not the ~0ms replay cost.
  // Status differs by outcome — see formatStatusTag.
  const dur = paint('', `(${formatBriefDuration(o.durationMs)})`, colors, { dim: true })
  const tag = formatStatusTag(o, colors)
  return ` ${dur} ${tag}`
}

function formatStatusTag(o: TaskOutcome, colors: ColorSupport): string {
  switch (o.status) {
    case 'cache-hit':
      return paint('', 'from local cache', colors, { dim: true })
    case 'cache-hit-remote':
      return paint('', 'from remote cache', colors, { dim: true })
    case 'success':
      return paint('', 'executed', colors, { dim: true })
    case 'failed':
      return paint(ERROR, `FAILED (exit ${o.exitCode})`, colors, { bold: true })
    case 'skipped':
      return paint(WARN, 'skipped', colors)
    default:
      return o.status
  }
}

function formatBriefDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}
