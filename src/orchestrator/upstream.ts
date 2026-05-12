import type { TaskDependsOn } from '../config.js'
import type { TaskOutcome } from '../graph/scheduler.js'

/**
 * Pick which upstream task hashes participate in the current task's
 * cache key, filtered by `cache.inputs.tasks`.
 *
 * Per-bucket default: an omitted bucket → all upstream from that
 * source contribute. An explicit array supports three pattern kinds,
 * applied in order:
 *   '*'      include all from this bucket
 *   'name'   include the literal task name
 *   '!name'  exclude the literal task name
 * Last write wins, so `['*', '!noisy']` reads as "all minus noisy".
 */
export function filterUpstreamHashes(
  upstream: TaskOutcome[],
  filter: TaskDependsOn | undefined,
  selfProjectName: string,
): string[] {
  const out: string[] = []
  for (const u of upstream) {
    if (!u.hash) continue
    const isSameProject = u.node.projectName === selfProjectName
    const bucket = isSameProject ? filter?.self : filter?.dependencies

    if (bucket === undefined) {
      out.push(u.hash)
      continue
    }

    let included = false
    for (const pattern of bucket) {
      if (pattern === '*') included = true
      else if (pattern.startsWith('!')) {
        if (pattern.slice(1) === u.node.taskName) included = false
      } else if (pattern === u.node.taskName) included = true
    }
    if (included) out.push(u.hash)
  }
  return out
}
