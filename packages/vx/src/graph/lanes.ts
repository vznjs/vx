/**
 * The slots a run's tasks hold while they run: the exec lane (local work,
 * `concurrency` at once), the restore lane, and one per remote pool.
 *
 * Restore-tier work is disk I/O — a confirmed hit's tar extract is ~8
 * filesystem round trips and no CPU — so it gets its own lane, twice
 * the exec cap: on the 1,000-project bench with every task a restore,
 * 4 → 8 workers cut the run-graph stage 683–754 → 556–595 ms and 16 was
 * no better (2026-09-10). Exec-tier work keeps the CPU-shaped cap; the
 * two lanes never wait on each other. `--concurrency 1` stays serial:
 * the two lanes share its one slot, where a lane each let an 80 MB
 * restore run inside another task's execution (item 1103).
 */
export class Lanes {
  active = 0
  activeRestore = 0
  /** An exclusive task holds the terminal: nothing else starts. */
  holding = false
  private readonly restoreConcurrency: number
  private readonly serial: boolean
  private readonly poolActive = new Map<string, number>()
  // Every pool a task of the run is placed in, by name: a task's pool is
  // fixed for the run, so read once here.
  private readonly pools = new Map<string, number>()

  constructor(
    private readonly concurrency: number,
    restoreConcurrency: number | undefined,
    private readonly poolOf:
      | ((id: string) => { name: string; capacity: number } | undefined)
      | undefined,
    ids: Iterable<string>,
  ) {
    this.restoreConcurrency = restoreConcurrency ?? 2 * concurrency
    this.serial = concurrency === 1
    if (poolOf !== undefined)
      for (const id of ids) {
        const p = poolOf(id)
        if (p !== undefined) this.pools.set(p.name, p.capacity)
      }
  }

  execRoom(): boolean {
    return this.serial ? this.active + this.activeRestore < 1 : this.active < this.concurrency
  }

  restoreRoom(): boolean {
    return this.serial
      ? this.active + this.activeRestore < 1
      : this.activeRestore < this.restoreConcurrency
  }

  poolRoom(): boolean {
    for (const [name, capacity] of this.pools)
      if ((this.poolActive.get(name) ?? 0) < capacity) return true
    return false
  }

  // A pooled task is admitted against ITS pool's capacity, a local one
  // against `concurrency`; pooled tasks reserve no local resources. A
  // restore is local disk work wherever its task was placed: on the pool's
  // arm it bypassed the restore lane's cap.
  hasRoom(id: string, restore: boolean): boolean {
    if (restore) return this.restoreRoom()
    const pool = this.poolOf?.(id)
    if (pool === undefined) return this.execRoom()
    return (this.poolActive.get(pool.name) ?? 0) < pool.capacity
  }

  busy(): boolean {
    if (this.active > 0 || this.activeRestore > 0) return true
    for (const n of this.poolActive.values()) if (n > 0) return true
    return false
  }

  /** Take the task's slot; the returned function gives it back. */
  take(id: string, exclusive: boolean, restore: boolean): () => void {
    if (exclusive) {
      this.holding = true
      this.active++
      return () => {
        this.holding = false
        this.active--
      }
    }
    if (restore) {
      this.activeRestore++
      return () => {
        this.activeRestore--
      }
    }
    const pool = this.poolOf?.(id)
    if (pool === undefined) {
      this.active++
      return () => {
        this.active--
      }
    }
    const poolActive = this.poolActive
    poolActive.set(pool.name, (poolActive.get(pool.name) ?? 0) + 1)
    return () => {
      poolActive.set(pool.name, (poolActive.get(pool.name) ?? 1) - 1)
    }
  }
}
