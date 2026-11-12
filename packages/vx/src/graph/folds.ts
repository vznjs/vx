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
import { standInsOf, type StandIns } from './stand-ins.js'
import type { TaskNode } from './task-graph.js'

/**
 * A task with no `exec` is a group: it only chains `dependsOn`. It never
 * spawns, never touches the cache, and appears in no summary, history row or
 * output frame.
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
 * A filter selects among the task's own dependencies, never through a group:
 * over a group `build` of `build.a` and `build.b`, a pattern matching only a
 * member (`build.*`) would fold neither it nor the group, and the key would
 * stop moving with that member: a stale hit. So such a spec is refused, unless
 * it matches the group itself (negating the group is a decision). One that
 * matches nothing anywhere stays legal (a preset's pattern needn't match in
 * every project). An exact name is refused earlier, at load, unless `dependsOn`
 * names it (`assertFilterNamesDeclaredDeps`).
 */
export function refuseFiltersThroughGroups(nodes: ReadonlyMap<string, TaskNode>): void {
  for (const node of nodes.values()) {
    const filter = node.config.inputs?.tasks
    if (filter === undefined || filter.length === 0) continue
    const deps = keyedDeps(node).flatMap((id) => nodes.get(id) ?? [])
    const groups = deps.filter(isGroupTask)
    const folded = new Set<TaskNode>()
    if (groups.length > 0) {
      const units = deps.map((n) => ({ node: n, unit: n.id }))
      const picked = selectFoldedDeps(units, filter, node.projectName, node.id, standInsOf(node))
      for (const { node: n } of picked) {
        folded.add(n)
        if (isGroupTask(n)) for (const m of groupMembers(n, nodes)) folded.add(m)
      }
    }
    for (const raw of filter) {
      const spec = parseSpec(raw, node.id)
      if (spec.negated) continue
      const matches = specMatcher(spec)
      const hit = (n: TaskNode): boolean => matches(n, n.projectName === node.projectName)
      const direct = deps.some(hit)
      for (const group of groups) {
        if (hit(group)) continue
        const member = groupMembers(group, nodes).find(
          (m) => hit(m) && !folded.has(m) && !deps.includes(m),
        )
        if (member === undefined) continue
        const outcome = direct ? 'so the key leaves it out' : 'so it selects nothing'
        throw new UserError(
          `${node.id}: inputs.tasks: '${raw}' matches ${member.id} only through the group ${group.id}, ${outcome}; name '${group.taskName}' or depend on ${member.id} directly`,
        )
      }
      if (direct) continue
      if (
        namesNoDependency(spec, node.config.dependsOn ?? []) ||
        namesTransitiveDependency(spec, node, nodes, hit)
      ) {
        const named = deps.map((d) => d.id).join(', ') || 'none'
        throw new UserError(
          `${node.id}: inputs.tasks: '${raw}' names none of its dependencies (${named}), so it selects nothing and the key would not move with them; fix the name, or use [] to decouple on purpose`,
        )
      }
    }
  }
}

/**
 * An exact filter that matched no dependency, where no `dependsOn` entry may
 * resolve to nothing for it. The load check pairs `pkg#task` forms by task half
 * alone (it cannot tell this project's name from another's), so
 * `['nope#build']` over `dependsOn: ['build']` selected nothing and the key
 * stopped moving: a stale hit. A `^` entry or a pattern naming the task may
 * match nothing in a preset's project, so it lets the entry through.
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

/**
 * An exact `pkg#task` filter that matched no dependency but names a task
 * reached only through one: `a → b → c` with `dependsOn: ['^build']` and
 * `['c#build']` selected none of a's direct deps, and an edit to c replayed a's
 * hit.
 */
function namesTransitiveDependency(
  spec: DependencySpec,
  node: TaskNode,
  nodes: ReadonlyMap<string, TaskNode>,
  hit: (n: TaskNode) => boolean,
): boolean {
  if (spec.kind !== 'cross' || isTaskPattern(spec.project) || isTaskPattern(spec.task)) return false
  const seen = new Set<string>([node.id])
  const stack = [...keyedDeps(node)]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    const n = nodes.get(id)
    if (n === undefined) continue
    if (hit(n)) return true
    stack.push(...keyedDeps(n))
  }
  return false
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
 * Patterns (Turbo/Nx syntax plus extensions): '*' all same-project upstream
 * '^*' all dep-workspace upstream 'name' same-project task `name` '^name'
 * `name` in every dep workspace 'pkg#name' one package's `name` 'name.*' either
 * half of any form may glob (one matched literally would select nothing and
 * decouple the task: a stale hit) '!<form>' exclude
 *
 * Applied in order, last write wins: `['*', '^*', '!^noisy']` is all minus
 * deps' noisy. `undefined` is every candidate; `[]` is none.
 *
 * Deduped by `unit`, the fold's identity (two groups over the same members
 * share one hash), after every entry: a negation drops only the candidates it
 * names, so a unit still selected through another stays folded. Deleting by
 * unit let `['^*', '!c#build']` drop b#build's group with c#build's: a stale
 * hit.
 *
 * `standIns`: an edge added past a default build on a package cycle is selected
 * whenever an edge it went past is, or `['build']` on `a ↔ b` dropped b#build:
 * a stale hit.
 */
export function selectFoldedDeps(
  deps: readonly FoldCandidate[],
  filter: readonly string[] | undefined,
  selfProjectName: string,
  selfTaskId: string,
  standIns?: StandIns,
): FoldCandidate[] {
  if (filter === undefined) return [...deps]

  const specs: DependencySpec[] = filter.map((raw) => parseSpec(raw, selfTaskId))

  // Per-spec predicate, compiled once (exact compares + patterns).
  const matchers = specs.map((spec) => specMatcher(spec))

  const selected = new Set<FoldCandidate>()
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!
    const matches = matchers[i]!
    for (const d of deps) {
      const isSelf = d.node.projectName === selfProjectName
      if (!matches(d.node, isSelf)) continue
      if (spec.negated) selected.delete(d)
      else selected.add(d)
    }
  }
  if (standIns !== undefined) {
    const ids = new Set<string>()
    for (const d of selected) ids.add(d.node.id)
    for (const d of deps) if (standIns[d.node.id]?.some((p) => ids.has(p))) selected.add(d)
  }
  const byUnit = new Map<string, FoldCandidate>()
  for (const d of selected) if (!byUnit.has(d.unit)) byUnit.set(d.unit, d)
  return [...byUnit.values()]
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
 * Compile one spec into an upstream predicate. Both halves of `pkg#task` glob:
 * a filter only selects among existing upstreams, so a package pattern is
 * unambiguous here, unlike in dependsOn.
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
 * The dependencies `node`'s key folds, as `keyUpstream` hands them to the key:
 * the scheduled ones less the order-only edges `--exclude-dependencies` left,
 * plus the dropped ones it keys anyway (`excludedUpstream`), whose own deps
 * come from the run's `keyOnly` map.
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
  return selectFoldedDeps(
    candidates,
    node.config.inputs?.tasks,
    node.projectName,
    node.id,
    standInsOf(node),
  )
}

/**
 * What stands in for a dependency's hash in the dedup, equal exactly when the
 * hashes are: an exec task's key folds its id, so the id is enough; a group's
 * hash rolls up its members' (from `keyUpstream`, not `node.deps`) with no id
 * of its own, so two groups over the same members hash alike.
 */
function foldUnit(node: TaskNode): string {
  if (!isGroupTask(node) || node.config.inputs !== undefined) return `task|${node.id}`
  const members = [...keyedDeps(node), ...(node.excludedUpstream ?? []).map((u) => u.node.id)]
  return `group|${members.sort().join('|')}`
}
