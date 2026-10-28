// Which dependencies a task's key folds (`inputs.tasks`), on the graph
// alone: the hash path, the sandbox's keyed set and `vx lock`'s
// input-overlap rule read this one selection, so they cannot drift.

import {
  UserError,
  DependencySpecError,
  compileTaskPattern,
  isTaskPattern,
  parseDependencySpec,
  type DependencySpec,
} from '../util/index.js'
import type { TaskNode } from './task-graph.js'

/**
 * A task is a "group" if it has no `exec` — it exists only to chain
 * `dependsOn` (an umbrella for `vx run ci`). Group tasks:
 *   - never spawn a process,
 *   - never read/write the cache (it's a config error to declare one),
 *   - never appear in the run summary or `runs` analytics table,
 *   - render no framed block in the live output.
 * Six call sites used to repeat `node.config.exec === undefined`;
 * centralising the predicate prevents that check from drifting.
 */
export function isGroupTask(node: TaskNode): boolean {
  return node.config.exec === undefined
}

/** `node.deps` less its ordering-only edges: the dependencies a key may fold. */
export function keyedDeps(node: TaskNode): readonly string[] {
  const order = node.orderOnly
  return order === undefined ? node.deps : node.deps.filter((d) => !order.includes(d))
}

/**
 * A filter selects among the task's own dependencies, never through a
 * group: `dependsOn: ['build']` over a group `build` of `build.a` and
 * `build.b` offers the filter `build`, not its members. A pattern that
 * matches only a member (`build.*`) therefore selected nothing, and the key stopped moving
 * with that member's inputs: a stale hit under a green run. Such a spec
 * is refused, once, over the graph every key site reads. One that matches
 * nothing anywhere stays legal (a preset's pattern needn't match in every
 * project). An exact name is refused earlier, at load, unless `dependsOn`
 * names it (`assertFilterNamesDeclaredDeps`).
 */
export function refuseFiltersThroughGroups(nodes: ReadonlyMap<string, TaskNode>): void {
  for (const node of nodes.values()) {
    const filter = node.config.inputs?.tasks
    if (filter === undefined || filter.length === 0) continue
    const deps = keyedDeps(node).flatMap((id) => nodes.get(id) ?? [])
    const groups = deps.filter(isGroupTask)
    for (const raw of filter) {
      const spec = parseSpec(raw, node.id)
      if (spec.negated) continue
      const matches = specMatcher(spec)
      const hit = (n: TaskNode): boolean => matches(n, n.projectName === node.projectName)
      if (deps.some(hit)) continue
      for (const group of groups) {
        const member = groupMembers(group, nodes).find(hit)
        if (member === undefined) continue
        throw new UserError(
          `${node.id}: inputs.tasks: '${raw}' matches ${member.id} only through the group ${group.id}, so it selects nothing; name '${group.taskName}' or depend on ${member.id} directly`,
        )
      }
      if (namesNoDependency(spec, node.config.dependsOn ?? [])) {
        const named = deps.map((d) => d.id).join(', ') || 'none'
        throw new UserError(
          `${node.id}: inputs.tasks: '${raw}' names none of its dependencies (${named}), so it selects nothing and the key would not move with them; fix the name, or use [] to decouple on purpose`,
        )
      }
    }
  }
}

/**
 * An exact filter that matched no dependency, where no `dependsOn` entry
 * may resolve to nothing for it. The load pairs a `pkg#task` entry, or a
 * `pkg#task` dependency, with any form whose task half matches, since it
 * cannot tell this project's name from another's
 * (`assertFilterNamesDeclaredDeps`), so `['nope#build']` over
 * `dependsOn: ['build']`, `['gen']` over `['b#gen']` and `['^gen']` over
 * this project's own `['a#gen']` each selected nothing and the key stopped
 * moving with the dependency: a stale hit. A `^` entry or a pattern naming
 * the task may match nothing in a preset's project, as a `^build` filter
 * may, so it lets the entry through.
 */
function namesNoDependency(spec: DependencySpec, dependsOn: readonly string[]): boolean {
  if (spec.kind === 'wildcardSelf' || spec.kind === 'wildcardDeps' || isTaskPattern(spec.task))
    return false
  if (spec.kind === 'cross' && isTaskPattern(spec.project)) return false
  return !dependsOn.some((raw) => {
    let d: DependencySpec
    try {
      d = parseDependencySpec(raw, 'dependsOn')
    } catch {
      return false
    }
    if (d.kind !== 'self' && d.kind !== 'deps' && d.kind !== 'cross') return false
    return (d.kind === 'deps' || isTaskPattern(d.task)) && nameMatcher(d.task)(spec.task)
  })
}

function parseSpec(raw: string, selfTaskId: string): DependencySpec {
  try {
    return parseDependencySpec(raw, 'inputs.tasks')
  } catch (err) {
    if (err instanceof DependencySpecError) {
      throw new UserError(`${selfTaskId}: ${err.message}`)
    }
    throw err
  }
}

/** Every task a group stands for, through nested groups, each once. */
function groupMembers(group: TaskNode, nodes: ReadonlyMap<string, TaskNode>): TaskNode[] {
  const out: TaskNode[] = []
  const seen = new Set<string>([group.id])
  const stack = group.deps.toReversed()
  while (stack.length > 0) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    const n = nodes.get(id)
    if (n === undefined) continue
    out.push(n)
    if (isGroupTask(n)) stack.push(...n.deps.toReversed())
  }
  return out
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
 * The dependencies a task's key folds, per its `inputs.tasks`.
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

  const specs: DependencySpec[] = filter.map((raw) => parseSpec(raw, selfTaskId))

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

/**
 * The dependencies `node`'s key folds, per the hash path's rules above, as
 * `keyUpstream` hands them to the key: the scheduled ones less the edges
 * `--exclude-dependencies` left for order alone, plus the dropped ones it
 * keys all the same (`excludedUpstream`), whose own dependencies the walk
 * reads from the run's `keyOnly` map. `node.deps` held the order-only
 * edges and lacked the dropped ones: the sandbox granted a sibling the key
 * does not answer for.
 */
export function foldedDeps(node: TaskNode, nodeOf: (id: string) => TaskNode): FoldCandidate[] {
  const candidates: FoldCandidate[] = []
  for (const id of keyedDeps(node)) {
    const dep = nodeOf(id)
    candidates.push({ node: dep, unit: foldUnit(dep) })
  }
  for (const { node: dep } of node.excludedUpstream ?? []) {
    candidates.push({ node: dep, unit: foldUnit(dep) })
  }
  if (isGroupTask(node) && node.config.inputs === undefined) return candidates
  return selectFoldedDeps(candidates, node.config.inputs?.tasks, node.projectName, node.id)
}

/**
 * What stands in for a dependency's hash in the dedup: equal exactly when
 * the hashes are. An exec task's key folds its own id (`task:<id>`), so its
 * id is enough; a group's hash is a roll-up of its members' ids and hashes
 * with no id of its own, so two groups over the same members hash alike.
 * The members are `keyUpstream`'s, which `computeGroupHash` is handed: under
 * `--exclude-dependencies` `node.deps` holds order-only edges and lacks the
 * dropped ones, and two groups the key told apart shared a unit.
 */
function foldUnit(node: TaskNode): string {
  if (!isGroupTask(node) || node.config.inputs !== undefined) return `task|${node.id}`
  const members = [...keyedDeps(node), ...(node.excludedUpstream ?? []).map((u) => u.node.id)]
  return `group|${members.sort().join('|')}`
}
