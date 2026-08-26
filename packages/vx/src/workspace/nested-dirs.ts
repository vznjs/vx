import path from 'node:path'
import type { ProjectEntry } from './workspace.js'

/**
 * For each project, the absolute dirs of other projects that live
 * underneath it. Used to enforce project-boundary isolation: a
 * project's task cannot see files inside another project, even if its
 * globs would otherwise match.
 *
 * Sort once, then scan forward: every dir sharing `p.dir` as a STRING
 * prefix is contiguous in sorted order, and `p`'s nested descendants
 * (`p.dir + sep + …`) are a sub-run within that block. But a SIBLING whose
 * name extends `p.dir` by a char that sorts BELOW `sep` (`-`, `.`, `+`, a
 * space; `/` is 0x2F) lands BETWEEN `p.dir` and `p.dir + sep` — so a plain
 * `break` on the first non-descendant would stop before reaching the nested
 * children (e.g. `foo`, `foo-utils`, `foo/nested` → `foo/nested` missed,
 * silently breaking the project-boundary invariant). So: collect descendants,
 * SKIP interlopers that merely share the `p.dir` string prefix, and break only
 * once we leave the `p.dir` block entirely. The inner loop is still bounded by
 * that block (near-O(P log P) on real trees; interlopers are few), not the
 * full tail.
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
      if (other.dir.startsWith(prefix)) {
        nested.push(other.dir)
      } else if (!other.dir.startsWith(p.dir)) {
        // Past every dir sharing `p.dir`'s string prefix — no descendant can
        // follow (they'd sort inside this block), so stop.
        break
      }
      // else: an interloping sibling (`foo-utils` for `foo`) that shares the
      // string prefix but isn't nested — skip it, descendants may follow.
    }
    result.set(p.name, nested)
  }
  return result
}
