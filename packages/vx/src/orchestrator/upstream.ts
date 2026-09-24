import {
  DependencySpecError,
  compileTaskPattern,
  isTaskPattern,
  parseDependencySpec,
  type DependencySpec,
  type TaskNode,
  type TaskOutcome,
} from '../graph/index.js'
import { UserError } from '../util/index.js'

/**
 * A task's upstream as its KEY reads it: the live outcomes of its scheduled
 * dependencies, plus the keys of any `--exclude-dependencies` took out of
 * the schedule (`excluded-keys.ts`). Every key site goes through this —
 * the run, the plan, the up-front classify — so a selection cannot change
 * a key at one of them and not the others.
 */
export function keyUpstream(node: TaskNode, upstream: TaskOutcome[]): TaskOutcome[] {
  return node.excludedUpstream === undefined ? upstream : [...upstream, ...node.excludedUpstream]
}

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
 * The selection itself is `selectFoldedDeps`, which the sandbox's keyed
 * set (keyed-projects.ts) walks over the graph before any hash exists:
 * one matcher, so what the key folds and what the sandbox believes it
 * folds cannot drift.
 *
 * Returns `[upstreamTaskId, hash]` pairs. The hash is the only thing
 * folded into the cache key (the fold sorts by hash, so ordering here
 * doesn't affect derivation); the task id rides along so Tier-3's
 * `entry_inputs` rows can NAME which upstream a hash came from. An
 * upstream with no hash (a persistent task) folds nothing.
 */
export function filterUpstreamHashes(
  upstream: TaskOutcome[],
  filter: readonly string[] | undefined,
  selfProjectName: string,
  selfTaskId: string,
): Array<[upstreamTaskId: string, hash: string]> {
  const candidates: FoldCandidate[] = []
  for (const u of upstream) if (u.hash) candidates.push({ node: u.node, unit: u.hash })
  return selectFoldedDeps(candidates, filter, selfProjectName, selfTaskId).map((c) => [
    c.node.id,
    c.unit,
  ])
}

/**
 * One dependency as the key fold sees it: the task, and the value the
 * fold dedups by — its hash on the hash path, a structural stand-in for
 * the hash on the graph (`foldUnit` in keyed-projects.ts).
 */
export interface FoldCandidate {
  node: TaskNode
  unit: string
}

/**
 * The dependencies a task's key folds, per its `cache.inputs.tasks`.
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
 *   - `filter === undefined` → every candidate, as given.
 *   - `filter === []`        → none (fully decoupled).
 *
 * Otherwise deduped by `unit`, first candidate kept. The unit is the
 * fold's own identity, not the task's: two groups over the same members
 * share one hash, so excluding either excludes both, and a selection by
 * task id would keep the other while the key folded neither.
 */
export function selectFoldedDeps(
  deps: readonly FoldCandidate[],
  filter: readonly string[] | undefined,
  selfProjectName: string,
  selfTaskId: string,
): FoldCandidate[] {
  if (filter === undefined) return [...deps]

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

  const selected = new Map<string, FoldCandidate>()
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!
    const matches = matchers[i]!
    for (const d of deps) {
      const isSelf = d.node.projectName === selfProjectName
      if (!matches(d.node, isSelf)) continue
      if (spec.negated) selected.delete(d.unit)
      else if (!selected.has(d.unit)) selected.set(d.unit, d)
    }
  }
  return [...selected.values()]
}

/**
 * Expand any GROUP among these outcomes into the real tasks it stands for,
 * transitively, preserving order and de-duplicating by task id.
 *
 * A group has no `exec`, so it has no outputs and no cache entry — its hash
 * is a synthetic roll-up. A dependent that asked the local index what its
 * upstream produced therefore got an EMPTY output list for a group, which is
 * invisible locally (the members' outputs are already on disk, put there by
 * their own tasks) and fatal for an input-shipping executor, where that list
 * IS the input root: `dependsOn: ['install']` shipped a worker an action with
 * none of what `install` chains.
 *
 * Groups may nest, as deep as the graph (the builder takes a 50,000-deep
 * chain, item 737), so the walk keeps its own stack; and a group reached
 * along two paths (a group `build` whose `^build` meets a package diamond)
 * is expanded once, or the walk doubles per layer. Only what the FILTER
 * already selected is passed in, so a group excluded from a task's
 * `cache.inputs.tasks` brings no members with it.
 */
export function expandGroupUpstream(upstream: readonly TaskOutcome[]): TaskOutcome[] {
  const out: TaskOutcome[] = []
  const seen = new Set<string>()
  const expanded = new Set<TaskOutcome>()
  const stack = upstream.toReversed()
  while (stack.length > 0) {
    const u = stack.pop()!
    if (expanded.has(u)) continue
    const members = u.groupUpstream
    if (members !== undefined) {
      expanded.add(u)
      for (let i = members.length - 1; i >= 0; i--) stack.push(members[i]!)
      continue
    }
    if (seen.has(u.node.id)) continue
    seen.add(u.node.id)
    out.push(u)
  }
  return out
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
function specMatcher(spec: DependencySpec): (n: TaskNode, isSelf: boolean) => boolean {
  switch (spec.kind) {
    case 'wildcardSelf':
      return (_n, isSelf) => isSelf
    case 'wildcardDeps':
      return (_n, isSelf) => !isSelf
    case 'self': {
      const task = nameMatcher(spec.task)
      return (n, isSelf) => isSelf && task(n.taskName)
    }
    case 'deps': {
      const task = nameMatcher(spec.task)
      return (n, isSelf) => !isSelf && task(n.taskName)
    }
    case 'cross': {
      const project = nameMatcher(spec.project)
      const task = nameMatcher(spec.task)
      return (n) => project(n.projectName) && task(n.taskName)
    }
  }
}
