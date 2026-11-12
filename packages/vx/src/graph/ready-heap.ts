/**
 * A binary max-heap of ready task ids, ordered by (priority DESC, enqueue-seq
 * ASC) so `pop()` returns the highest-priority task and equal-priority ties
 * break in enqueue order — the exact contract the prior sorted-array kept, but
 * O(log R) push/pop instead of O(R) splice/shift. On a wide ready frontier (the
 * 1000-package startup enqueue, or a fan-out completion), that turns the
 * queue's O(R²) maintenance into O(R log R).
 */
export class ReadyHeap {
  private readonly ids: string[] = []
  private readonly seq: number[] = []
  // Each slot's priority, read once at push: a lookup per comparison
  // was two per heap level on every push and pop.
  private readonly prio: number[] = []
  private next = 0
  /** Queued ids `counts` holds true for. */
  counted = 0
  constructor(
    private priority: (id: string) => number,
    private readonly counts?: (id: string) => boolean,
  ) {}
  get size(): number {
    return this.ids.length
  }
  /** Re-rank every queued id under `priority`, and every later push. */
  reprioritize(priority: (id: string) => number): void {
    this.priority = priority
    for (let i = 0; i < this.ids.length; i++) this.prio[i] = priority(this.ids[i]!)
    for (let i = (this.ids.length >> 1) - 1; i >= 0; i--) this.down(i)
  }
  private down(i: number): void {
    for (;;) {
      const l = 2 * i + 1
      const r = 2 * i + 2
      let best = i
      if (l < this.ids.length && this.higher(l, best)) best = l
      if (r < this.ids.length && this.higher(r, best)) best = r
      if (best === i) return
      this.swap(i, best)
      i = best
    }
  }
  /** True if slot i outranks slot j (higher priority, or equal priority + earlier seq). */
  private higher(i: number, j: number): boolean {
    const pi = this.prio[i]!
    const pj = this.prio[j]!
    return pi !== pj ? pi > pj : this.seq[i]! < this.seq[j]!
  }
  private swap(i: number, j: number): void {
    const ti = this.ids[i]!
    this.ids[i] = this.ids[j]!
    this.ids[j] = ti
    const si = this.seq[i]!
    this.seq[i] = this.seq[j]!
    this.seq[j] = si
    const pi = this.prio[i]!
    this.prio[i] = this.prio[j]!
    this.prio[j] = pi
  }
  /**
   * `seq` defaults to a fresh monotonic counter. A parked-then-repushed
   * task passes its ORIGINAL seq back in, which makes FIFO-among-equals a
   * property of the heap rather than of the tick loop's shape.
   *
   * It is NOT the difference between correct and incorrect order today,
   * and the comment here used to claim it was ("a fresh seq would demote
   * it behind later arrivals"). It would not: `parked` is a subsequence
   * of the tick's pop order, so it is already in ranking order, and every
   * push that follows takes a later seq — so fresh seqs handed out in
   * parked order reproduce the same ranking. Measured over 800 randomized
   * scenarios (random DAGs, costs, budgets, concurrency, failures, all
   * three continue modes): zero order differences, item 493. Kept because
   * it holds without that argument.
   */
  push(id: string, seq: number = this.next++): void {
    if (this.counts?.(id) === true) this.counted++
    this.ids.push(id)
    this.seq.push(seq)
    this.prio.push(this.priority(id))
    let i = this.ids.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (!this.higher(i, parent)) break
      this.swap(i, parent)
      i = parent
    }
  }
  /** The head's enqueue seq (capture before `pop` for a possible repush). */
  peekSeq(): number {
    return this.seq[0] ?? -1
  }
  pop(): string | undefined {
    const n = this.ids.length
    if (n === 0) return undefined
    const top = this.ids[0]!
    if (this.counts?.(top) === true) this.counted--
    const lastId = this.ids.pop()!
    const lastSeq = this.seq.pop()!
    const lastPrio = this.prio.pop()!
    if (n > 1) {
      this.ids[0] = lastId
      this.seq[0] = lastSeq
      this.prio[0] = lastPrio
      this.down(0)
    }
    return top
  }
}
