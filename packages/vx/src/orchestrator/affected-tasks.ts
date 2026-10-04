// `--affected` per task (owner, 2026-10-04). The diff seeds the tasks it
// reaches; a requested task runs when its `dependsOn` closure holds one.
// So a change reaches another project only along a task edge: `web#test`
// behind `^build` runs when `ui#build` (or what it depends on) is reached,
// and a spec edit `ui#build`'s inputs leave out stops at `ui`'s own tasks.

import { declaresInput } from '../cache/index.js'
import { isGroupTask, type TaskNode } from '../graph/index.js'
import {
  type AffectedChanges,
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
 * The task ids of `ids` whose closure the change reaches, in their order. A group seeds nothing (it runs nothing); an uncached task seeds
 * whenever its project changed; a cached one when a changed path is one of
 * its declared inputs.
 */
export function affectedRoots(
  nodes: ReadonlyMap<string, TaskNode>,
  ids: readonly string[],
  changes: AffectedChanges,
  projects: ReadonlyMap<string, ProjectEntry>,
): string[] {
  const whole = wholeProjects(changes, projects)
  const seeded = (n: TaskNode): boolean => {
    if (isGroupTask(n) || !changes.projects.has(n.projectName)) return false
    const cache = n.config.cache
    if (cache === undefined || whole.has(n.projectName)) return true
    if ((changes.paths.get(n.projectName) ?? []).some((rel) => declaresInput(cache, rel, null))) {
      return true
    }
    return changes.changed.some((rel) => declaresInput(cache, null, rel))
  }
  const reached = new Map<string, boolean>()
  const reaches = (id: string): boolean => {
    const known = reached.get(id)
    if (known !== undefined) return known
    // The graph is acyclic (the builder refuses a cycle); the mark only
    // stops a diamond being walked twice.
    reached.set(id, false)
    const n = nodes.get(id)
    const hit = n !== undefined && (seeded(n) || n.deps.some(reaches))
    reached.set(id, hit)
    return hit
  }
  return ids.filter(reaches)
}
