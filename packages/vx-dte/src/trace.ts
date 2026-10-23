// A distributed run in time, for chrome://tracing or https://ui.perfetto.dev
// (owner, 2026-10-23: "a Chrome profile with all workers and tasks they
// executed in time"): the Trace Event Format, one process per machine.
// A worker's first row is its life (warm-up, idle, leave); each task gets
// the first row free over its time there. The orchestrator's rows hold
// what it asked and when, the tasks it held waiting for room, and its
// restores. Times are this machine's, so a worker's are when it heard.

/** One slice: a span of a row, in `performance.now()` ms. */
interface Slice {
  readonly track: string
  readonly name: string
  readonly cat: string
  readonly from: number
  readonly to: number
  readonly args?: Record<string, unknown>
  /** Slices inside it, on its row. */
  readonly parts?: readonly { name: string; from: number; to: number }[]
  /** Its first row, not one of its own: a worker's life. */
  readonly life?: true
}

interface Mark {
  readonly track: string
  readonly name: string
  readonly at: number
  readonly args?: Record<string, unknown>
}

/** A task's cores on its worker over its time: the counters. */
interface Use {
  readonly track: string
  readonly from: number
  readonly to: number
  readonly booked: number
  readonly used: number
}

type Event = Record<string, unknown>

export const ORCHESTRATOR = 'orchestrator'

export class Trace {
  private readonly slices: Slice[] = []
  private readonly marks: Mark[] = []
  private readonly uses: Use[] = []
  /** Each worker's time online: idle is what its tasks leave of it. */
  private readonly online = new Map<string, { from: number; to?: number }>()
  /** `performance.now()` here when `Date.now()` was `wall`: a worker's own clock to ours. */
  private readonly wall = Date.now() - performance.now()

  constructor(private readonly origin: number = performance.now()) {}

  slice(s: Slice): void {
    if (s.to >= s.from) this.slices.push(s)
  }

  mark(track: string, name: string, args?: Record<string, unknown>, at = performance.now()): void {
    this.marks.push({ track, name, at, ...(args === undefined ? {} : { args }) })
  }

  use(u: Use): void {
    if (u.to > u.from) this.uses.push(u)
  }

  /**
   * Worker `track` joined at `at`, asked for at `askedAt` when this run
   * started it; `booted` is the wall-clock time its `vx` started, which
   * splits its warm-up into its machine's start (a CI queue, a checkout,
   * an install) and vx's own boot.
   */
  joined(track: string, at: number, askedAt?: number, booted?: number): void {
    this.online.set(track, { from: at })
    if (askedAt === undefined) return
    const boot = booted === undefined ? undefined : booted - this.wall
    const split = boot !== undefined && boot > askedAt && boot < at
    this.slice({
      track,
      name: 'warm-up',
      cat: 'worker',
      from: askedAt,
      to: at,
      life: true,
      ...(split
        ? {
            parts: [
              { name: 'machine start', from: askedAt, to: boot },
              { name: 'vx boot + join', from: boot, to: at },
            ],
          }
        : {}),
    })
  }

  /** Worker `track` left (`how`: left, lost, stopped) at `at`. */
  left(track: string, how: string, at = performance.now()): void {
    const o = this.online.get(track)
    if (o === undefined || o.to !== undefined) return
    o.to = at
    this.mark(track, how, undefined, at)
  }

  /** A worker asked for that never joined, from its ask to `at`. */
  unstarted(track: string, askedAt: number, why: string, at = performance.now()): void {
    this.slice({
      track,
      name: 'warm-up',
      cat: 'worker',
      from: askedAt,
      to: at,
      life: true,
      args: { failed: why },
    })
  }

  /** The Trace Event Format JSON of the run, ended at `end`. */
  json(end: number, meta: Record<string, unknown> = {}): string {
    const us = (ms: number): number => Math.round((ms - this.origin) * 1000)
    const tracks = [
      ORCHESTRATOR,
      ...new Set(
        [...this.slices.map((s) => s.track), ...this.marks.map((m) => m.track)]
          .filter((t) => t !== ORCHESTRATOR)
          .sort((a, b) => a.localeCompare(b, 'en', { numeric: true })),
      ),
    ]
    const pid = new Map(tracks.map((t, i) => [t, i + 1]))
    const events: Event[] = []
    for (const [t, p] of pid) {
      events.push({ ph: 'M', name: 'process_name', pid: p, tid: 0, args: { name: t } })
      events.push({ ph: 'M', name: 'process_sort_index', pid: p, tid: 0, args: { sort_index: p } })
      events.push({
        ph: 'M',
        name: 'thread_name',
        pid: p,
        tid: 0,
        args: { name: t === ORCHESTRATOR ? 'run' : 'worker' },
      })
    }
    // Idle: a worker's time online that no task of its covers.
    const idle: Slice[] = []
    for (const [track, o] of this.online) {
      const busy = this.slices
        .filter((s) => s.track === track && s.life !== true)
        .map((s) => [s.from, s.to] as const)
        .sort((a, b) => a[0] - b[0])
      let at = o.from
      const until = o.to ?? end
      for (const [from, to] of busy) {
        if (from > at)
          idle.push({
            track,
            name: 'idle',
            cat: 'idle',
            from: at,
            to: Math.min(from, until),
            life: true,
          })
        at = Math.max(at, to)
      }
      if (until > at)
        idle.push({ track, name: 'idle', cat: 'idle', from: at, to: until, life: true })
    }
    // Rows by first free, one set per kind (a worker's tasks, the run's
    // waits, its restores): a slice takes the lowest of its kind whose last ended.
    const rows = new Map<string, { tid: number; end: number }[]>()
    const tids = new Map<string, number>()
    for (const s of [...this.slices, ...idle].sort((a, b) => a.from - b.from)) {
      const p = pid.get(s.track)!
      let tid = 0
      if (s.life !== true) {
        const kind = `${s.track}\0${s.cat}`
        const free = rows.get(kind) ?? []
        rows.set(kind, free)
        let row = free.find((r) => r.end <= s.from)
        if (row === undefined) {
          tid = (tids.get(s.track) ?? 0) + 1
          tids.set(s.track, tid)
          row = { tid, end: 0 }
          free.push(row)
          events.push({
            ph: 'M',
            name: 'thread_name',
            pid: p,
            tid,
            args: { name: `${s.cat} ${free.length}` },
          })
        }
        row.end = s.to
        tid = row.tid
      }
      events.push({
        ph: 'X',
        name: s.name,
        cat: s.cat,
        pid: p,
        tid,
        ts: us(s.from),
        dur: Math.max(0, us(s.to) - us(s.from)),
        ...(s.args === undefined ? {} : { args: s.args }),
      })
      for (const part of s.parts ?? [])
        if (part.to > part.from)
          events.push({
            ph: 'X',
            name: part.name,
            cat: s.cat,
            pid: p,
            tid,
            ts: us(part.from),
            dur: us(part.to) - us(part.from),
          })
    }
    for (const m of this.marks)
      events.push({
        ph: 'i',
        s: 'p',
        name: m.name,
        cat: 'mark',
        pid: pid.get(m.track)!,
        tid: 0,
        ts: us(m.at),
        ...(m.args === undefined ? {} : { args: m.args }),
      })
    // Each worker's cores: booked by the run and used by its tasks, as they change.
    for (const track of new Set(this.uses.map((u) => u.track))) {
      const steps = this.uses
        .filter((u) => u.track === track)
        .flatMap((u) => [
          [u.from, u.booked, u.used],
          [u.to, -u.booked, -u.used],
        ])
        .sort((a, b) => a[0]! - b[0]!)
      let booked = 0
      let used = 0
      for (const [at, b, u] of steps) {
        booked += b!
        used += u!
        events.push({
          ph: 'C',
          name: 'cores',
          pid: pid.get(track)!,
          tid: 0,
          ts: us(at!),
          args: { booked: round(booked), used: round(used) },
        })
      }
    }
    return `${JSON.stringify({ traceEvents: events, displayTimeUnit: 'ms', otherData: meta })}\n`
  }
}

/** Two decimals, and no `-0` or float dust from adding and taking away. */
const round = (n: number): number => Math.max(0, Math.round(n * 100) / 100)
