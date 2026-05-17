import {
  DependencySpecError,
  parseDependencySpec,
  type DependencySpec,
} from '../graph/dependency-spec.js'
import type { TaskOutcome } from '../graph/scheduler.js'
import { UserError } from '../util/errors.js'

/**
 * Pick which upstream task hashes participate in the current task's
 * cache key, filtered by `cache.inputs.tasks`.
 *
 * Patterns (Turbo/Nx micro-syntax + filter extensions):
 *   '*'         all same-project upstream
 *   '^*'        all dep-workspace upstream
 *   'name'      same-project task `name`
 *   '^name'     `name` task in every dep workspace
 *   'pkg#name'  specific package's `name` task
 *   '!<form>'   exclude — any of the above with a leading `!`
 *
 * Patterns are applied in order; last write wins, so
 * `['*', '^*', '!^noisy']` reads as "all minus deps' noisy".
 *
 * Defaults:
 *   - `filter === undefined` → all upstream contribute.
 *   - `filter === []`        → none contribute (fully decoupled).
 */
export function filterUpstreamHashes(
  upstream: TaskOutcome[],
  filter: readonly string[] | undefined,
  selfProjectName: string,
  selfTaskId: string,
): string[] {
  if (filter === undefined) {
    const out: string[] = []
    for (const u of upstream) if (u.hash) out.push(u.hash)
    return out
  }

  const specs: DependencySpec[] = filter.map((raw) => {
    try {
      return parseDependencySpec(raw)
    } catch (err) {
      if (err instanceof DependencySpecError) {
        throw new UserError(`${selfTaskId}: cache.inputs.tasks: ${err.message}`)
      }
      throw err
    }
  })

  const selected = new Set<string>()
  for (const spec of specs) {
    for (const u of upstream) {
      if (!u.hash) continue
      const isSelf = u.node.projectName === selfProjectName
      if (!matches(spec, u, isSelf)) continue
      if (spec.negated) selected.delete(u.hash)
      else selected.add(u.hash)
    }
  }
  return [...selected]
}

function matches(spec: DependencySpec, u: TaskOutcome, isSelf: boolean): boolean {
  switch (spec.kind) {
    case 'wildcardSelf':
      return isSelf
    case 'wildcardDeps':
      return !isSelf
    case 'self':
      return isSelf && u.node.taskName === spec.task
    case 'deps':
      return !isSelf && u.node.taskName === spec.task
    case 'cross':
      return u.node.projectName === spec.project && u.node.taskName === spec.task
  }
}
