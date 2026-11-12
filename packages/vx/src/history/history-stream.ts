// A run's hits written to the history while the graph still runs, on a
// thread of their own (history-writer.ts). A warm run's rows were the
// main thread's last ~65 ms at 8,002 hits, after the graph; here they land
// while it runs. What does not land (no thread, a refused batch) is
// handed back and goes in the run's own bundle, as before.

import type { RunRecord } from './run-history.js'
import type { HistoryWriterIn, HistoryWriterOut } from './history-writer.js'

/** Rows per batch: one transaction on the thread. */
const BATCH = 512

/**
 * The hits a run writes before a thread pays for its start: a run with
 * fewer writes them all in its bundle. A warm 1,000-project run took
 * median 170 ms with a thread, 150 without; at 2,500 and 3,000 the two
 * tie or the thread wins by ~10 ms (2026-11-07, compiled binary).
 */
const THREAD_FROM = 2048

/** A record of `T` whose row the stream holds. */
export interface Streamed<T> {
  item: T
  record: RunRecord
}

export class HistoryStream<T> {
  private worker: Worker | undefined
  private buffer: Streamed<T>[] = []
  private readonly sent = new Map<number, Streamed<T>[]>()
  private readonly landed: Streamed<T>[] = []
  private seq = 0
  /** A batch was refused or the thread died: nothing more is sent. */
  private dead = false
  /** The thread died: no batch answers any more. */
  private gone = false
  private readonly refused = new Set<number>()
  private settle: (() => void) | undefined
  private ended: (() => void) | undefined
  private added = 0

  /**
   * `expected` is the hits the run knows of before its graph runs (its
   * confirmed local hits): from {@link THREAD_FROM} the first batch starts
   * the thread; under it, only the hit that reaches it does.
   */
  constructor(
    private readonly files: { index: string; store?: string },
    private readonly expected: number,
  ) {}

  add(item: T, record: RunRecord): void {
    this.buffer.push({ item, record })
    this.added++
    if (this.buffer.length < BATCH || this.dead) return
    if (this.worker === undefined && this.expected < THREAD_FROM && this.added < THREAD_FROM) return
    this.send()
  }

  /**
   * Waits for every batch sent, closes the thread, and returns what landed
   * and what did not (the run's bundle writes those).
   */
  async finish(): Promise<{ landed: Streamed<T>[]; unlanded: Streamed<T>[] }> {
    const w = this.worker
    if (w !== undefined && !this.gone) {
      // Unreferenced, its answers alone left the loop with nothing to
      // wait on: the run ended "awaited can never settle".
      w.ref()
      await new Promise<void>((resolve) => {
        this.settle = resolve
        this.settled()
      })
      if (!this.gone) {
        await new Promise<void>((resolve) => {
          this.ended = resolve
          w.postMessage({ end: true } satisfies HistoryWriterIn)
        })
      }
    }
    w?.terminate()
    const unlanded = [...this.sent.values()].flat().concat(this.buffer)
    this.sent.clear()
    this.buffer = []
    return { landed: this.landed, unlanded }
  }

  private send(): void {
    const w = (this.worker ??= this.start())
    const batch = this.buffer
    this.buffer = []
    const seq = this.seq++
    this.sent.set(seq, batch)
    // A record's spans are bigint, which JSON cannot carry: as numbers, exact
    // below 2^53 ns (104 days into a run). A replacer function cost 20 ms
    // of 8,002 rows, the copies 4.
    const hits = JSON.stringify(
      batch.map(({ record: r }) => ({
        ...r,
        wallclockStartNs: r.wallclockStartNs === undefined ? undefined : Number(r.wallclockStartNs),
        wallclockEndNs: r.wallclockEndNs === undefined ? undefined : Number(r.wallclockEndNs),
      })),
    )
    w.postMessage({ seq, hits } satisfies HistoryWriterIn)
  }

  private start(): Worker {
    const w = new Worker(new URL('./history-writer.ts', import.meta.url).href)
    // A run that throws before `finish` must still exit; a batch cut off
    // mid-write rolls back whole.
    w.unref()
    w.onmessage = (e: MessageEvent<HistoryWriterOut>) => {
      const m = e.data
      if ('ended' in m) {
        this.ended?.()
        return
      }
      const batch = this.sent.get(m.seq)
      if (batch === undefined) return
      if (m.error === undefined) {
        this.sent.delete(m.seq)
        for (const b of batch) this.landed.push(b)
      } else {
        // Kept in `sent`, so the bundle writes it; no later batch is sent.
        this.refused.add(m.seq)
        this.dead = true
      }
      this.settled()
    }
    // A thread that cannot start or dies: what it did not answer for is
    // the bundle's.
    w.onerror = (e) => {
      e.preventDefault()
      this.dead = true
      this.gone = true
      this.settled()
      this.ended?.()
    }
    w.postMessage({ open: this.files } satisfies HistoryWriterIn)
    return w
  }

  /** Resolves `finish`'s wait once every batch sent has answered, or the thread is gone. */
  private settled(): void {
    if (this.settle === undefined) return
    if (!this.gone && [...this.sent.keys()].some((seq) => !this.refused.has(seq))) return
    const s = this.settle
    this.settle = undefined
    s()
  }
}
