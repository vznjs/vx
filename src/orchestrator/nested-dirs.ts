import path from 'node:path'
import type { ProjectEntry } from '../graph/task-graph.js'

/**
 * For each project, the absolute dirs of other projects that live
 * underneath it. Used to enforce project-boundary isolation: a
 * project's task cannot see files inside another project, even if its
 * globs would otherwise match.
 */
export function computeNestedProjectDirs(entries: ProjectEntry[]): Map<string, string[]> {
  const result = new Map<string, string[]>()
  for (const p of entries) {
    const prefix = p.dir + path.sep
    const nested = entries
      .filter((o) => o.dir !== p.dir && o.dir.startsWith(prefix))
      .map((o) => o.dir)
    result.set(p.name, nested)
  }
  return result
}
