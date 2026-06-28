import {
  DependencySpecError,
  parseDependencySpec,
  type DependencySpec,
  type TaskOutcome,
} from '../graph/index.js'
import { UserError } from '../util/index.js'

/**
 * Pick which upstream task hashes participate in the current task's
 * cache key, filtered by `cache.inputs.tasks`. The folded value is the
 * upstream's own cache key (its input-based task hash) — pure-input
 * transitive hashing, like Turbo/Nx. An upstream change propagates
 * through its key into every dependent's key. There is deliberately NO
 * output-content folding: an upstream that re-runs but emits identical
 * output still re-runs its dependents (early cutoff was removed —
 * rare in practice, not worth the cascade complexity).
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
 *
 * Returns `[upstreamTaskId, hash]` pairs. The hash is the only thing
 * folded into the cache key (the fold sorts by hash, so ordering here
 * doesn't affect derivation); the task id rides along so Tier-3's
 * `entry_inputs` rows can NAME which upstream a hash came from. The
 * filter dedups by hash, as before — two upstream tasks with identical
 * hashes contribute one pair (first id wins; their key contribution is
 * identical anyway).
 */
export function filterUpstreamHashes(
  upstream: TaskOutcome[],
  filter: readonly string[] | undefined,
  selfProjectName: string,
  selfTaskId: string,
): Array<[upstreamTaskId: string, hash: string]> {
  if (filter === undefined) {
    const out: Array<[string, string]> = []
    for (const u of upstream) if (u.hash) out.push([u.node.id, u.hash])
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

  // Dedup by hash (the key fold's unit), but remember the first task id
  // seen for each hash so the diff row can name the upstream.
  const selected = new Map<string, string>()
  for (const spec of specs) {
    for (const u of upstream) {
      if (!u.hash) continue
      const isSelf = u.node.projectName === selfProjectName
      if (!matches(spec, u, isSelf)) continue
      if (spec.negated) selected.delete(u.hash)
      else if (!selected.has(u.hash)) selected.set(u.hash, u.node.id)
    }
  }
  return [...selected].map(([hash, id]) => [id, hash])
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
