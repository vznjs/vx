import {
  DependencySpecError,
  compileTaskPattern,
  isTaskPattern,
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
 *   'name.*'    patterns — EITHER half of any form above may contain `*`
 *               (same glob as dependsOn patterns), including the project
 *               half of `pkg#name`. A filter that matched literally here
 *               would silently select ZERO upstream hashes and decouple the
 *               task from its dependencies — a stale-hit trap, so every
 *               name is matched through the shared glob.
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

  // Per-spec predicate, compiled once (exact compares + patterns).
  const matchers = specs.map((spec) => specMatcher(spec))

  // Dedup by hash (the key fold's unit), but remember the first task id
  // seen for each hash so the diff row can name the upstream.
  const selected = new Map<string, string>()
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!
    const matches = matchers[i]!
    for (const u of upstream) {
      if (!u.hash) continue
      const isSelf = u.node.projectName === selfProjectName
      if (!matches(u, isSelf)) continue
      if (spec.negated) selected.delete(u.hash)
      else if (!selected.has(u.hash)) selected.set(u.hash, u.node.id)
    }
  }
  return [...selected].map(([hash, id]) => [id, hash])
}

/** Exact-name compare, or the shared `*`-glob when the name is a pattern. */
function nameMatcher(name: string): (candidate: string) => boolean {
  if (isTaskPattern(name)) {
    const re = compileTaskPattern(name)
    return (candidate) => re.test(candidate)
  }
  return (candidate) => candidate === name
}

/**
 * Compile one spec into an upstream predicate. BOTH halves of a `pkg#task`
 * form glob: a filter only ever selects from upstreams that already exist,
 * so a package pattern is unambiguous here — unlike dependsOn, which must
 * materialize concrete edges and therefore rejects it.
 */
function specMatcher(spec: DependencySpec): (u: TaskOutcome, isSelf: boolean) => boolean {
  switch (spec.kind) {
    case 'wildcardSelf':
      return (_u, isSelf) => isSelf
    case 'wildcardDeps':
      return (_u, isSelf) => !isSelf
    case 'self': {
      const task = nameMatcher(spec.task)
      return (u, isSelf) => isSelf && task(u.node.taskName)
    }
    case 'deps': {
      const task = nameMatcher(spec.task)
      return (u, isSelf) => !isSelf && task(u.node.taskName)
    }
    case 'cross': {
      const project = nameMatcher(spec.project)
      const task = nameMatcher(spec.task)
      return (u) => project(u.node.projectName) && task(u.node.taskName)
    }
  }
}
