import path from 'node:path'
import type { ProjectEntry } from './workspace.js'

/**
 * For each project, the absolute dirs of other projects that live
 * underneath it. Used to enforce project-boundary isolation: a
 * project's task cannot see files inside another project, even if its
 * globs would otherwise match.
 *
 * Sort once, then scan: nested projects of `p` form a contiguous run
 * immediately after `p` in the sorted order (any non-descendant breaks
 * the prefix-match). O(P log P) instead of the naive O(P²) cross
 * product. Stable for any project set with no dir collisions, which
 * the workspace loader already enforces.
 */
export function computeNestedProjectDirs(
  entries: Array<Pick<ProjectEntry, 'name' | 'dir'>>,
): Map<string, string[]> {
  const result = new Map<string, string[]>()
  if (entries.length === 0) return result
  const sorted = [...entries].sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0))
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i]!
    const prefix = p.dir + path.sep
    const nested: string[] = []
    for (let j = i + 1; j < sorted.length; j++) {
      const other = sorted[j]!
      if (!other.dir.startsWith(prefix)) break
      nested.push(other.dir)
    }
    result.set(p.name, nested)
  }
  return result
}
