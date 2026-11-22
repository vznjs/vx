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

  /** Forget every result: a cycle that failed before its run said nothing of what it changed. */
  clear(): void {
    this.last.clear()
  }

  /**
   * What the next cycle may keep, given the paths that started it. A result
   * whose project holds one of them is forgotten for good (an interrupted
   * cycle may never record the task again), and every result is when a path
   * lies outside every project but the root one (a root file a task may read
   * without declaring it) or none is known. An uncached task reads what it
   * likes in its project.
   */
  forCycle(
    changed: readonly string[],
    projectDirs: readonly string[],
    workspaceRoot: string,
  ): ReadonlyMap<string, TaskOutcome> | undefined {
    if (this.last.size === 0) return undefined
    const under = (p: string, dir: string): boolean => p === dir || p.startsWith(dir + path.sep)
    if (
      changed.length === 0 ||
      changed.some((p) => !projectDirs.some((d) => d !== workspaceRoot && under(p, d)))
    ) {
      this.last.clear()
      return undefined
    }
    for (const [id, o] of this.last)
      if (changed.some((p) => under(p, o.node.projectDir))) this.last.delete(id)
    return this.last.size === 0 ? undefined : new Map(this.last)
  }
}
