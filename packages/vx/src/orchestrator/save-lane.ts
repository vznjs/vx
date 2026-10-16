// The save lane: a miss's cache save runs OFF the execution slot. The
// slot is CPU-shaped (`--concurrency`) and the save is not — pack, write,
// rename and one index transaction, ~2.5 ms of mostly I/O per one-file
// artifact against ~5 ms of execution on the 1,000-project bench
// (2026-09-10) — so holding the slot for it serialized I/O behind CPU.
// A bounded number run at once (memory: each pack holds an artifact's
// bytes); the scheduler finishes a task only once its save has settled
// (`settledOf`), so a run ends with every save in the cache; and a save
// that fails degrades to a miss next time, said once — the task's work
// ran.

export interface SaveLane {
  /**
   * Start `save` now if the lane has room, else when one finishes. Resolves
   * once the save has settled, true when the entry landed — a failure is
   * reported and resolves false — for the readers that must know: the
   * task's outcome, and a duplicate of the same task in another run
   * (admission's in-flight join).
   */
  defer(save: () => Promise<void>): Promise<boolean>
}

export function createSaveLane(cap: number, onError: (err: unknown) => void): SaveLane {
  const queue: Array<{ save: () => Promise<void>; settle: (stored: boolean) => void }> = []
  let running = 0
  const start = (save: () => Promise<void>, settle: (stored: boolean) => void): void => {
    void save()
      .then(
        () => true,
        (err: unknown) => {
          onError(err)
          return false
        },
      )
      .then((stored) => {
        running--
        settle(stored)
        const next = queue.shift()
        if (next !== undefined) start(next.save, next.settle)
      })
    running++
  }
  return {
    defer(save) {
      return new Promise<boolean>((settle) => {
        if (running < cap) start(save, settle)
        else queue.push({ save, settle })
      })
    },
  }
}
