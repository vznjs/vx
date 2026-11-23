import path from 'node:path'
import type { ProjectEntry } from './workspace.js'

/**
 * For each project, the absolute dirs of other projects that live
 * underneath it. Used to enforce project-boundary isolation: a
 * project's task cannot see files inside another project, even if its
 * globs would otherwise match.
 *
 * Sort once, then scan forward: every dir sharing `p.dir` as a string
 * prefix is contiguous, and `p`'s descendants (`p.dir + sep + …`) lie in that
 * block. A sibling extending `p.dir` by a char below `sep` (`foo-utils` for
 * `foo`) sorts between them, so skip it and stop only past the block.
 *
 * `workspaces`: the absolute roots of nested workspaces (each holds its own
 * `.vx/workspace.*`), a boundary for outputs: each joins the dirs of every
 * project it lies under. An outer output glob that ran into one let the
 * clean before a run delete its files. Never passed for inputs: a task may
 * read them, and an input left out of the key is a stale hit.
 */
export function computeNestedProjectDirs(
  entries: Array<Pick<ProjectEntry, 'name' | 'dir'>>,
  workspaces: readonly string[] = [],
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
      if (other.dir.startsWith(prefix)) {
        nested.push(other.dir)
      } else if (!other.dir.startsWith(p.dir)) {
        break
      }
    }
    for (const w of workspaces) if (w.startsWith(prefix)) nested.push(w)
    result.set(p.name, nested)
  }
  return result
}
