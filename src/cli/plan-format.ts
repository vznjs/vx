// Formatters for `--dry-run` (human / JSON) and `--graph` (DOT).

import type { CacheStatus, RunPlan } from '../orchestrator/index.js'
import { formatDuration } from '../orchestrator/index.js'

/**
 * Human-readable preview. One line per real task (groups hidden, same
 * as the live runner), tagged with predicted cache outcome. A would-run
 * task with recorded history also shows its typical duration (~p50).
 *
 *   would run:
 *     ✓  @vzn/vx#lint       cache hit (local)        abc12345
 *     ↓  @vzn/vx#test       cache hit (remote)       def67890
 *     ▶  @vzn/vx#build      cache miss — would exec  fedcba98  ~1.2s
 *
 *   3 task(s) planned: 2 cache hits (1 local, 1 remote), 1 would run.
 *   predicted: ~1.2s wall · ~1.2s total execution
 */
export function formatPlanText(plan: RunPlan): string {
  const real = plan.tasks.filter((t) => t.cacheStatus !== 'group')
  if (real.length === 0) return 'No tasks planned.\n'

  const idWidth = Math.max(...real.map((t) => t.node.id.length))
  const tagWidth = 24

  const lines: string[] = ['would run:']
  let local = 0
  let remote = 0
  let miss = 0
  let nocache = 0
  for (const t of real) {
    const sym = symbolFor(t.cacheStatus)
    const desc = describe(t.cacheStatus)
    const shortHash = t.hash ? t.hash.slice(0, 8) : ''
    const executes = t.cacheStatus === 'miss' || t.cacheStatus === 'no-cache'
    const eta = executes && t.p50Ms !== undefined ? `  ~${formatDuration(t.p50Ms)}` : ''
    // Placement, by EXECUTOR NAME rather than a local/remote word: the
    // summary line below already spends "local" and "remote" on the cache
    // tier, and a task placed on a named executor is what the reader can
    // act on. Present only when the workspace declared a choice.
    const where = t.executor !== undefined ? `  @${t.executor}` : ''
    lines.push(
      `  ${sym}  ${t.node.id.padEnd(idWidth)}  ${desc.padEnd(tagWidth)}  ${shortHash}${eta}${where}`,
    )
    // Optional one-line description from the task config, indented
    // under the id so the eye picks up the task → blurb mapping.
    const taskDesc = t.node.config.description
    if (taskDesc) {
      lines.push(`     ${' '.repeat(idWidth)}  ${taskDesc}`)
    }
    if (t.cacheStatus === 'hit-local') local++
    else if (t.cacheStatus === 'hit-remote') remote++
    else if (t.cacheStatus === 'miss') miss++
    else if (t.cacheStatus === 'no-cache') nocache++
  }

  const hitParts: string[] = []
  if (local > 0) hitParts.push(`${local} local`)
  if (remote > 0) hitParts.push(`${remote} remote`)
  const hits = local + remote
  const summary: string[] = [`${real.length} task(s) planned`]
  if (hits > 0) summary.push(`${hits} cache hit${hits === 1 ? '' : 's'} (${hitParts.join(', ')})`)
  if (miss > 0) summary.push(`${miss} would run`)
  if (nocache > 0) summary.push(`${nocache} no-cache`)
  lines.push('')
  lines.push(summary.join(', ') + '.')

  // `--download` is invisible without this: the eligibility gate silently
  // keeps producers eager, so a user who asked for `none` and got no
  // deferral has nothing to read. Say what WOULD stay remote, and name the
  // refusals when nothing would.
  const deferred = real.filter((t) => t.download === 'deferred')
  const downgrades = plan.downloadDowngrades ?? []
  if (deferred.length > 0 || downgrades.length > 0) {
    lines.push('')
    lines.push(
      `download: ${deferred.length} task(s) would keep outputs remote` +
        (downgrades.length > 0 ? `, ${downgrades.length} kept eager:` : '.'),
    )
    for (const d of downgrades.slice(0, 3)) lines.push(`    ${d.taskId} — ${d.reason}`)
    if (downgrades.length > 3) lines.push(`    …and ${downgrades.length - 3} more`)
  }

  // Time prediction — only when history gave us something to say: at least
  // one would-run task has a p50 (an all-unknown prediction is pure noise).
  const p = plan.predicted
  const executes = miss + nocache
  if (p !== undefined && executes > 0 && executes > p.unknownCount) {
    const parts = [`predicted: ~${formatDuration(p.wallMs)} wall`]
    parts.push(`~${formatDuration(p.workMs)} total execution`)
    if (p.unknownCount > 0) {
      parts.push(`${p.unknownCount} task${p.unknownCount === 1 ? '' : 's'} without history (+?)`)
    }
    lines.push(parts.join(' · '))
  }
  return lines.join('\n') + '\n'
}

export function formatPlanJson(plan: RunPlan): string {
  return (
    JSON.stringify(
      {
        tasks: plan.tasks.map((t) => ({
          id: t.node.id,
          project: t.node.projectName,
          task: t.node.taskName,
          hash: t.hash,
          cacheStatus: t.cacheStatus,
          deps: t.deps,
          ...(t.p50Ms !== undefined ? { p50Ms: t.p50Ms } : {}),
          ...(t.executor !== undefined ? { executor: t.executor } : {}),
          ...(t.download !== undefined ? { download: t.download } : {}),

          ...(t.node.config.description !== undefined
            ? { description: t.node.config.description }
            : {}),
        })),
        ...(plan.predicted !== undefined ? { predicted: plan.predicted } : {}),
        // The gate's refusals belong on the SCRIPTING surface too: a CI job
        // asking "did --download=none actually defer anything, and if not
        // why" reads this, not the human table. (This object enumerates its
        // fields deliberately — the plan's internal shape is not the wire —
        // which is exactly why a new PlannedTask field does not appear here
        // for free, and why `download` above had to be added by hand.)
        ...(plan.downloadDowngrades !== undefined
          ? { downloadDowngrades: plan.downloadDowngrades }
          : {}),
      },
      null,
      2,
    ) + '\n'
  )
}

/**
 * Render the task graph as a Graphviz DOT document. Includes group
 * nodes — they're real nodes in the graph (just not real units of
 * work), and a `--graph` consumer wants to see the whole structure.
 *
 * Layout: `rankdir=LR`. Node fillcolor varies by predicted cache
 * status so a quick visual scan tells you which boxes get to skip
 * actual work.
 */
export function formatGraphDot(plan: RunPlan): string {
  const lines: string[] = ['digraph TaskGraph {', '  rankdir=LR;', '  node [shape=box];']
  for (const t of plan.tasks) {
    const label = `${t.node.id}\\n${t.hash.slice(0, 8)}`
    const color = dotColor(t.cacheStatus)
    lines.push(`  "${t.node.id}" [label="${label}", style="filled", fillcolor="${color}"];`)
  }
  for (const t of plan.tasks) {
    for (const dep of t.deps) {
      lines.push(`  "${dep}" -> "${t.node.id}";`)
    }
  }
  lines.push('}')
  return lines.join('\n') + '\n'
}

function symbolFor(s: CacheStatus): string {
  switch (s) {
    case 'hit-local':
      return '◉'
    case 'hit-remote':
      return '↓'
    case 'miss':
      return '▶'
    case 'no-cache':
      return '·'
    case 'group':
      return '○'
  }
}

function describe(s: CacheStatus): string {
  switch (s) {
    case 'hit-local':
      return 'cache hit (local)'
    case 'hit-remote':
      return 'cache hit (remote)'
    case 'miss':
      return 'cache miss — would exec'
    case 'no-cache':
      return 'no-cache (would exec)'
    case 'group':
      return 'group task'
  }
}

function dotColor(s: CacheStatus): string {
  switch (s) {
    case 'hit-local':
      return '#bbf7d0' // green-200
    case 'hit-remote':
      return '#bae6fd' // sky-200
    case 'miss':
      return '#fed7aa' // orange-200
    case 'no-cache':
      return '#e5e7eb' // gray-200
    case 'group':
      return '#f5d0fe' // fuchsia-200
  }
}
