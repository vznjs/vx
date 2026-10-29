// What one machine did in a distributed run, from its tasks' results: the
// final summary's per-worker block.

interface Span {
  readonly start: number
  readonly end: number
  readonly cores: number
  readonly memory: number
}

export interface UsageStats {
  readonly onlineMs: number
  /** Time with at least one task running. */
  readonly busyMs: number
  /** Cores and bytes in use at once, at the most and on average over its time online. */
  readonly cpuPeak: number
  readonly cpuAvg: number
  readonly memoryPeak: number
  readonly memoryAvg: number
  /** Core-time its tasks used over the core-time it had. */
  readonly utilization: number
  readonly cpuMs: number
  /** Cores the run held for its tasks, on average over its time online: what packing gave it. */
  readonly bookedAvg: number
  /**
   * Cores busy on its machine, any process's, on average since its worker
   * started, as its last frame said: what `cpuAvg` leaves out (a Mac's
   * indexer, a task's orphans). Undefined when it said none.
   */
  readonly machineAvg?: number | undefined
}

export class Usage {
  done = 0
  failed = 0
  /** Killed by the run's stop, as core counts a task `aborted`. */
  aborted = 0
  /** Messages and bytes the run sent it, and those it sent the run. */
  messagesIn = 0
  bytesIn = 0
  messagesOut = 0
  bytesOut = 0
  /** When it left, if before the run ended. */
  to: number | undefined
  private readonly spans: Span[] = []
  private booked = 0
  private bookedMs = 0
  private bookedAt = 0
  /** Its machine's busy cores on average, as its last frame said. */
  machineAvg: number | undefined

  constructor(readonly from: number = performance.now()) {}

  /**
   * A task it finished, as it ends: on it `from` its send (else its
   * command's duration), its CPU time spread over that. Its command alone
   * left the restore of its dependencies and its save idle: a worker
   * busy all along read 10 s idle (2026-10-24).
   */
  record(
    r: {
      readonly exitCode: number
      readonly signal?: string | number | undefined
      readonly timedOut?: boolean | undefined
      readonly durationMs: number
      readonly cpuMs?: number | undefined
      readonly peakRssBytes?: number | undefined
    },
    from?: number,
  ): void {
    if (r.exitCode === 0) this.done++
    else if ((r.signal === 'SIGINT' || r.signal === 'SIGTERM') && r.timedOut !== true)
      this.aborted++
    else this.failed++
    const end = performance.now()
    const ms = Math.max(1, from === undefined ? r.durationMs : end - from)
    this.spans.push({
      start: end - ms,
      end,
      cores: (r.cpuMs ?? 0) / ms,
      memory: r.peakRssBytes ?? 0,
    })
  }

  /** The run now holds `cores` more of it for its tasks (fewer when negative). */
  book(cores: number, at: number = performance.now()): void {
    this.bookedMs += this.booked * (at - this.bookedAt)
    this.bookedAt = at
    this.booked += cores
  }

  stats(cores: number, until: number): UsageStats {
    // Never before it joined: a time from before would read it online 1 ms.
    const end = Math.max(this.from, this.to ?? until)
    const onlineMs = Math.max(1, end - this.from)
    // Ends before starts at one instant: back to back is not at once.
    const events = this.spans
      .flatMap((s) => [[s.start, 1, s] as const, [s.end, -1, s] as const])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    let running = 0
    let cpu = 0
    let memory = 0
    let cpuPeak = 0
    let memoryPeak = 0
    let busyMs = 0
    let last = 0
    for (const [at, d, s] of events) {
      if (running > 0) busyMs += at - last
      last = at
      running += d
      cpu += d * s.cores
      memory += d * s.memory
      cpuPeak = Math.max(cpuPeak, cpu)
      memoryPeak = Math.max(memoryPeak, memory)
    }
    let cpuMs = 0
    let memoryMs = 0
    for (const s of this.spans) {
      cpuMs += s.cores * (s.end - s.start)
      memoryMs += s.memory * (s.end - s.start)
    }
    return {
      onlineMs,
      busyMs,
      cpuPeak,
      cpuAvg: cpuMs / onlineMs,
      memoryPeak,
      memoryAvg: memoryMs / onlineMs,
      utilization: cpuMs / (cores * onlineMs),
      cpuMs,
      bookedAvg: (this.bookedMs + this.booked * Math.max(0, end - this.bookedAt)) / onlineMs,
      machineAvg: this.machineAvg,
    }
  }
}
