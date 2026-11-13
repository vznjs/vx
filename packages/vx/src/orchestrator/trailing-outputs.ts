// Outputs still on their way to this machine after their task ended
// (`ExecuteResult.outputs` `trailing`): a task another machine ran is done
// once it ran there, and its dependants there start at once; its files come
// here meanwhile. Only a task no later reader on this machine can observe
// may trail (`trailable`), and whatever does write or read this disk after
// it waits (`settle`).

import { isGroupTask, type TaskNode } from '../graph/index.js'
import { thrownMessage } from '../util/index.js'

/**
 * The tasks whose outputs may trail: uncached commands placed on another
 * machine, none of whose dependants, however far, runs here or takes a key
 * from this disk after it. `upfront` says a task's key is already taken;
 * `remote` that it is placed on another machine.
 */
export function trailable(
  nodes: ReadonlyMap<string, TaskNode>,
  upfront: (id: string) => boolean,
  remote: (id: string) => boolean,
): Set<string> {
  const dependants = new Map<string, string[]>()
  for (const n of nodes.values())
    for (const d of n.deps) {
      const list = dependants.get(d)
      if (list === undefined) dependants.set(d, [n.id])
      else list.push(n.id)
    }
  // A dependant that reads this disk after the task: one that runs here, or
  // whose key is still to be taken from files.
  const reads = (n: TaskNode): boolean =>
    isGroupTask(n)
      ? n.config.inputs !== undefined && !upfront(n.id)
      : !remote(n.id) || (n.config.inputs !== undefined && !upfront(n.id))
  // Whether a reader is below: memoized, on an explicit stack (a graph is as
  // deep as its longest chain).
  const below = new Map<string, boolean>()
  const readerBelow = (start: string): boolean => {
    const stack = [start]
    while (stack.length > 0) {
      const id = stack[stack.length - 1]!
      if (below.has(id)) {
        stack.pop()
        continue
      }
      let found = false
      let pending = false
      for (const d of dependants.get(id) ?? []) {
        const node = nodes.get(d)
        if (node === undefined) continue
        if (reads(node) || below.get(d) === true) {
          found = true
          break
        }
        if (!below.has(d)) {
          stack.push(d)
          pending = true
        }
      }
      if (found) below.set(id, true)
      else if (!pending) below.set(id, false)
      if (found || !pending) stack.pop()
    }
    return below.get(start)!
  }
  const out = new Set<string>()
  for (const n of nodes.values()) {
    if (isGroupTask(n) || n.config.exec?.persistent !== undefined) continue
    if (n.config.cache === true || !remote(n.id)) continue
    if (!readerBelow(n.id)) out.add(n.id)
  }
  return out
}

/** The run's trailing outputs: who is still coming, and whose never came. */
export class TrailingOutputs {
  private readonly coming = new Map<string, Promise<void>>()
  /** Each task whose files did not come, with why. */
  readonly lost: { id: string; message: string }[] = []

  add(id: string, landed: Promise<void>): void {
    const settled = landed.then(
      () => {},
      (err: unknown) => {
        this.lost.push({ id, message: thrownMessage(err) })
      },
    )
    const kept = settled.then(() => {
      if (this.coming.get(id) === kept) this.coming.delete(id)
    })
    this.coming.set(id, kept)
  }

  /** Every file on its way is here, or lost: before this disk is written or read for a task. */
  async settle(): Promise<void> {
    while (this.coming.size > 0) await Promise.all(this.coming.values())
  }
}
