// The results a watch cycle may keep instead of running a task again
// (orchestrator/watch-kept.ts): each uncached pass and each failure, by task,
// as the last cycle that ran it left it.

import path from 'node:path'
import { keepsOutcome } from '../orchestrator/index.js'
import type { TaskOutcome } from '../graph/index.js'

export class KeptResults {
  private readonly last = new Map<string, TaskOutcome>()

  /** A cycle's outcomes: each one that may stand replaces the last, any other drops it. */
  record(outcomes: readonly TaskOutcome[]): void {
    for (const o of outcomes) {
      if (keepsOutcome(o)) this.last.set(o.node.id, o)
      else this.last.delete(o.node.id)
    }
  }

  /**
   * What the next cycle may keep, given the paths that started it: none when
   * a path lies outside every project (a root file a task may read without
   * declaring it) or none is known, else every result whose project holds
   * none of them. An uncached task reads what it likes in its project.
   */
  forCycle(
    changed: readonly string[],
    projectDirs: readonly string[],
  ): ReadonlyMap<string, TaskOutcome> | undefined {
    if (this.last.size === 0 || changed.length === 0) return undefined
    const under = (p: string, dir: string): boolean => p === dir || p.startsWith(dir + path.sep)
    if (changed.some((p) => !projectDirs.some((d) => under(p, d)))) return undefined
    const kept = new Map<string, TaskOutcome>()
    for (const [id, o] of this.last)
      if (!changed.some((p) => under(p, o.node.projectDir))) kept.set(id, o)
    return kept.size === 0 ? undefined : kept
  }
}
