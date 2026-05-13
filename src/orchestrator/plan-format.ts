// Formatters for `--dry-run` (human / JSON) and `--graph` (DOT).

import type { CacheStatus, RunPlan } from './plan.js'

/**
 * Human-readable preview. One line per real task (groups hidden, same
 * as the live runner), tagged with predicted cache outcome.
 *
 *   would run:
 *     ✓  @vzn/vx#lint       cache hit (local)        abc12345
 *     ↓  @vzn/vx#test       cache hit (remote)       def67890
 *     ▶  @vzn/vx#build      cache miss — would exec  fedcba98
 *
 *   3 task(s) planned: 2 cache hits (1 local, 1 remote), 1 would run.
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
    lines.push(`  ${sym}  ${t.node.id.padEnd(idWidth)}  ${desc.padEnd(tagWidth)}  ${shortHash}`)
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
          ...(t.node.config.description !== undefined
            ? { description: t.node.config.description }
            : {}),
        })),
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
