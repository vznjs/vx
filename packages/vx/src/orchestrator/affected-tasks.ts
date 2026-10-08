// `--affected` per task (owner, 2026-10-04). The diff seeds the tasks it
// reaches; a requested task runs when its `dependsOn` closure holds one.
// So a change reaches another project only along a task edge: `web#test`
// behind `^build` runs when `ui#build` (or what it depends on) is reached,
// and a spec edit `ui#build`'s inputs leave out stops at `ui`'s own tasks.

import { declaresInput, workspaceFilesReachInto } from '../cache/index.js'
import {
  compileTaskPattern,
  isGroupTask,
  isTaskPattern,
  parseDependencySpec,
  type TaskNode,
} from '../graph/index.js'
import {
  type AffectedChanges,
  type PackageGraph,
  PROJECT_CONFIG_FILENAMES,
  type ProjectEntry,
} from '../workspace/index.js'

/** Every file in this set re-keys each of its project's tasks, whatever their inputs. */
const KEYED_BY_EVERY_TASK = new Set(['package.json', ...PROJECT_CONFIG_FILENAMES])

/**
 * The projects every task of which the change reaches: the whole ones the
 * diff named, and those holding a changed path no cached task of theirs
 * declares as an input. vx cannot prove such a path re-keys nothing (a
 * `project` plugin may read it), so it reaches the whole project, as it did
 * before selection was per task.
 */
function wholeProjects(
  changes: AffectedChanges,
  projects: ReadonlyMap<string, ProjectEntry>,
): Set<string> {
  const whole = new Set(changes.whole)
  for (const [name, rels] of changes.paths) {
    if (whole.has(name)) continue
    const caches = Object.values(projects.get(name)?.config.tasks ?? {}).flatMap((t) =>
      t.exec !== undefined && t.cache !== undefined ? [t.cache] : [],
    )
    const unclaimed = (rel: string): boolean =>
      KEYED_BY_EVERY_TASK.has(rel) || !caches.some((c) => declaresInput(c, rel, null))
    if (rels.some(unclaimed)) whole.add(name)
  }
  return whole
}

/**
 * The task ids of `ids` whose closure the change reaches, in their order.
 * A group seeds nothing (it runs nothing) unless it is keyed, as the default
 * `build` is; an uncached task seeds when a changed path lies in its project
 * (or the whole project is reached); a cached one when a changed path is one
 * of its declared inputs. A `^name` edge the
 * graph passes through a package it loaded no config for reaches it as the
 * default `build` would: any change there reaches the task.
 */
export function affectedRoots(
  nodes: ReadonlyMap<string, TaskNode>,
  ids: readonly string[],
  changes: AffectedChanges,
  projects: ReadonlyMap<string, ProjectEntry>,
  packageGraph: PackageGraph,
): string[] {
  const whole = wholeProjects(changes, projects)
  // The builder's `^name` walk (task-graph.ts), keeping only the packages
  // it passes through: a holder's own node is already in `deps`.
  const passesChanged = (n: TaskNode): boolean => {
    for (const raw of n.config.dependsOn ?? []) {
      const spec = parseDependencySpec(raw)
      if (spec.kind !== 'deps' || spec.negated) continue
      const re = isTaskPattern(spec.task) ? compileTaskPattern(spec.task) : null
      const holds = (name: string): boolean => {
        const tasks = Object.keys(projects.get(name)?.config.tasks ?? {})
        return re === null ? tasks.includes(spec.task) : tasks.some((t) => re.test(t))
      }
      const visited = new Set([n.projectName])
      const frontier = [...packageGraph.directDeps(n.projectName)]
      while (frontier.length > 0) {
        const target = frontier.pop()!
        if (visited.has(target)) continue
        visited.add(target)
        if (holds(target)) continue
        if (changes.projects.has(target)) return true
        frontier.push(...packageGraph.directDeps(target))
      }
    }
    return false
  }
  const seeded = (n: TaskNode): boolean => {
    const cache = n.config.cache
    // Asked of every node, not only the changed projects' (the
    // `workspaceFiles` owners): a `graph` hook may have given the glob.
    if (
      cache !== undefined &&
      (changes.changed.some((rel) => declaresInput(cache, null, rel)) ||
        (changes.nested ?? []).some((dir) => workspaceFilesReachInto(cache, dir)))
    ) {
      return true
    }
    if (!changes.projects.has(n.projectName)) return false
    // A group runs nothing; only the default `build` (projects.ts) is keyed.
    // An uncached task reads its project: a root file another task of it
    // declares (`workspaceFiles`) is no change there.
    if (cache === undefined) {
      return !isGroupTask(n) && (whole.has(n.projectName) || changes.paths.has(n.projectName))
    }
    if (whole.has(n.projectName)) return true
    return (changes.paths.get(n.projectName) ?? []).some((rel) => declaresInput(cache, rel, null))
  }
  const reached = new Map<string, boolean>()
  // Post-order on an explicit stack: a closure is as deep as the graph, and
  // a recursion per edge threw `RangeError` on a chain the builder takes
  // (item 737's 50,000; ~15,000 sufficed here). A frame holds the next dep
  // to ask, -1 before the task itself is.
  const reaches = (root: string): boolean => {
    const stack: Array<[id: string, next: number]> = [[root, -1]]
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!
      const id = frame[0]
      if (frame[1] === -1) {
        if (reached.has(id)) {
          stack.pop()
          continue
        }
        const n = nodes.get(id)
        if (n === undefined || seeded(n) || passesChanged(n)) {
          reached.set(id, n !== undefined)
          stack.pop()
          continue
        }
        frame[1] = 0
      }
      const deps = nodes.get(id)!.deps
      let i = frame[1]
      while (i < deps.length && reached.get(deps[i]!) === false) i++
      frame[1] = i
      if (i === deps.length || reached.get(deps[i]!) === true) {
        reached.set(id, i < deps.length)
        stack.pop()
        continue
      }
      stack.push([deps[i]!, -1])
    }
    return reached.get(root)!
  }
  return ids.filter(reaches)
}
