// The save lane: a miss's cache save runs OFF the execution slot. The
// slot is CPU-shaped (`--concurrency`) and the save is not — pack, write,
// rename and one index transaction, ~2.5 ms of mostly I/O per one-file
// artifact against ~5 ms of execution on the 1,000-project bench
// (2026-09-10) — so holding the slot for it serialized I/O behind CPU.
// A bounded number run at once (memory: each pack holds an artifact's
// bytes), the run drains them before the upload drain, and a save that
// fails degrades to a miss next time, said once — the task's work ran.

export interface SaveLane {
  /**
   * Start `save` now if the lane has room, else when one finishes. Resolves
   * once the save has settled — a failure is reported and resolves too —
   * for the one reader that must wait for the entry: a duplicate of the
   * same task in another run (admission's in-flight join).
   */
  defer(save: () => Promise<void>): Promise<void>
  /** Settle every deferred save, started or queued. */
  drain(): Promise<void>
}

export function createSaveLane(cap: number, onError: (err: unknown) => void): SaveLane {
  const queue: Array<{ save: () => Promise<void>; settle: () => void }> = []
  const running = new Set<Promise<void>>()
  const start = (save: () => Promise<void>, settle: () => void): void => {
    const p = save()
      .catch(onError)
      .then(() => {
        running.delete(p)
        settle()
        const next = queue.shift()
        if (next !== undefined) start(next.save, next.settle)
      })
    running.add(p)
  }
  return {
    defer(save) {
      return new Promise<void>((settle) => {
        if (running.size < cap) start(save, settle)
        else queue.push({ save, settle })
      })
    },
    async drain() {
      while (running.size > 0) await Promise.all([...running])
    },
  }
}
