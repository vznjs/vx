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

export interface HeaderInput {
  version: string
  packages: readonly string[]
  task: string
  remoteCacheEnabled: boolean
}

export function formatHeader(input: HeaderInput): string[] {
  const sortedPkgs = [...input.packages].sort()
  return [
    `• vx ${input.version}`,
    '',
    `   • Packages in scope: ${sortedPkgs.join(', ')}`,
    `   • Running ${input.task} in ${sortedPkgs.length} package${sortedPkgs.length === 1 ? '' : 's'}`,
    `   • Remote caching ${input.remoteCacheEnabled ? 'enabled' : 'disabled'}`,
    '',
  ]
}

export function formatTaskBlock(node: TaskNode, outcome: TaskOutcome, body: string): string {
  // Group tasks (no `exec`) do no work and have no body — they're
  // organizational nodes the user wrote so a `vx run ci` invocation
  // has a single name to address. Showing an empty box for them is
  // pure noise. Same exclusion the summary totals + analytics
  // pass already make.
  if (node.config.exec === undefined) return ''

  const id = node.id
  const header = formatBlockHeader(node, outcome)
  const lines: string[] = [`┌─ ${id} > ${header}`]

  // Show the command for executed tasks so the user sees what ran;
  // skip for cache hits (the captured stdout/stderr is the interesting
  // part).
  const cmd = node.config.exec.command
  if (outcome.status === 'success') lines.push(`$ ${cmd}`)

  if (body.length > 0) {
    lines.push(body.replace(/\n$/, ''))
  }

  lines.push(`└─ ${id} ──${formatBlockFooter(outcome)}`)
  return lines.join('\n') + '\n'
}

function formatBlockHeader(node: TaskNode, o: TaskOutcome): string {
  const shortHash = o.hash ? o.hash.slice(0, 8) : ''
  switch (o.status) {
    case 'cache-hit':
      return `cache hit • ${shortHash}`
    case 'cache-hit-remote':
      return `remote cache hit • ${shortHash}`
    case 'failed':
      return `$ ${node.config.exec?.command ?? '(no command)'}`
    case 'skipped':
      return 'skipped (upstream failed)'
    case 'success':
      return 'executed'
    default:
      return o.status
  }
}

function formatBlockFooter(o: TaskOutcome): string {
  if (o.status === 'failed')
    return ` FAILED in ${formatBriefDuration(o.durationMs)} (exit ${o.exitCode})`
  if (o.status === 'skipped') return ''
  if (o.durationMs === 0) return ''
  return ` (${formatBriefDuration(o.durationMs)})`
}

function formatBriefDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}
