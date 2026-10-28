import {
  selectFoldedDeps,
  type FoldCandidate,
  type TaskNode,
  type TaskOutcome,
} from '../graph/index.js'

/**
 * A task's upstream as its KEY reads it: the live outcomes of its scheduled
 * dependencies, plus the keys of any `--exclude-dependencies` took out of
 * the schedule (`excluded-keys.ts`). Every key site goes through this —
 * the run, the plan, the up-front classify — so a selection cannot change
 * a key at one of them and not the others.
 */
export function keyUpstream(node: TaskNode, upstream: TaskOutcome[]): TaskOutcome[] {
  const order = node.orderOnly
  // A restore-tier hit dispatches before its dependencies settle, and the
  // scheduler hands it their outcomes so far: a hole stays a hole, as it
  // does with no order-only edge (reading `.node` of one threw).
  const keyed =
    order === undefined
      ? upstream
      : upstream.filter((o) => o === undefined || !order.includes(o.node.id))
  return node.excludedUpstream === undefined ? keyed : [...keyed, ...node.excludedUpstream]
}

/** The ids some task of the run depends on; the rest run with `noDependants`. */
export function dependedOn(nodes: Iterable<TaskNode>): Set<string> {
  const ids = new Set<string>()
  for (const n of nodes) for (const d of n.deps) ids.add(d)
  return ids
}

/**
 * A server's key is read only by a dependant (A-17), so with none in the
 * run it derives none (`noDependants`), and the plan must not show one.
 */
export function keylessServer(node: TaskNode, depended: ReadonlySet<string>): boolean {
  return node.config.exec?.persistent !== undefined && !depended.has(node.id)
}

/** A dependency as a key reads it: only `node` and `hash` matter. */
export function keyedOutcome(node: TaskNode, hash: string | undefined): TaskOutcome {
  const o: TaskOutcome = { node, status: 'success', exitCode: 0, durationMs: 0 }
  if (hash !== undefined) o.hash = hash
  return o
}

/**
 * Pick which upstream task hashes participate in the current task's
 * cache key, filtered by `inputs.tasks`. The folded value is the
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
 * upstream with no hash folds nothing.
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
 * `inputs.tasks` brings no members with it.
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
