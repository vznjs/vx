// What one machine did in a distributed run, from its tasks' results: the
// final summary's per-agent block.

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
}

export class Usage {
  done = 0
  failed = 0
  /** Messages and bytes the run sent it, and those it sent the run. */
  messagesIn = 0
  bytesIn = 0
  messagesOut = 0
  bytesOut = 0
  /** When it left, if before the run ended. */
  to: number | undefined
  private readonly spans: Span[] = []

  constructor(readonly from: number = performance.now()) {}

  /** A task it finished, as it ends: its CPU time spread over its duration. */
  record(r: {
    readonly exitCode: number
    readonly durationMs: number
    readonly cpuMs?: number | undefined
    readonly peakRssBytes?: number | undefined
  }): void {
    if (r.exitCode === 0) this.done++
    else this.failed++
    const end = performance.now()
    const ms = Math.max(1, r.durationMs)
    this.spans.push({
      start: end - ms,
      end,
      cores: (r.cpuMs ?? 0) / ms,
      memory: r.peakRssBytes ?? 0,
    })
  }

  stats(cores: number, until: number): UsageStats {
    const onlineMs = Math.max(1, (this.to ?? until) - this.from)
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
    }
  }
}
