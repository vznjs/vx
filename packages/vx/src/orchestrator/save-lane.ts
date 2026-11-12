// The save lane: a miss's cache save runs OFF the execution slot. The slot is
// CPU-shaped (`--concurrency`) and the save is not — pack, write, rename and
// one index transaction, ~2.5 ms of mostly I/O per one-file artifact against ~5
// ms of execution on the 1,000-project bench — so holding the slot for it
// serialized I/O behind CPU. A bounded number run at once (memory: each pack
// holds an artifact's bytes); the scheduler finishes a task only once its save
// has settled (`settledOf`), so a run ends with every save in the cache; and a
// save that fails degrades to a miss next time, reported with its task — the
// task's work ran.

export interface SaveLane {
  /**
   * Start `save` now if the lane has room, else when one finishes. Resolves
   * once the save has settled, true when the entry landed — a failure is
   * reported and resolves false — for the readers that must know: the
   * task's outcome, and a duplicate of the same task in another run
   * (admission's in-flight join).
   */
  defer(save: () => Promise<void>, taskId: string): Promise<boolean>
}

interface Queued {
  save: () => Promise<void>
  taskId: string
  settle: (stored: boolean) => void
}

export function createSaveLane(
  cap: number,
  onError: (err: unknown, taskId: string) => void,
): SaveLane {
  const queue: Queued[] = []
  let running = 0
  const start = (q: Queued): void => {
    void q
      .save()
      .then(
        () => true,
        (err: unknown) => {
          onError(err, q.taskId)
          return false
        },
      )
      .then((stored) => {
        running--
        q.settle(stored)
        const next = queue.shift()
        if (next !== undefined) start(next)
      })
    running++
  }
  return {
    defer(save, taskId) {
      return new Promise<boolean>((settle) => {
        const q = { save, taskId, settle }
        if (running < cap) start(q)
        else queue.push(q)
      })
    },
  }
}
