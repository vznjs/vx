// One model for a distributed run (docs/design/dte-planner-2026-11.md). Pure:
// the caller tells it what happened (a task ready, started, ended; a worker
// asked, joined, lost) and asks what to do now; it reads no clock.
//
// The machine: a worker's tasks share its cores; past its cores each runs at
// cores / Σ cores. The forecast: each task's time is history's mean, scaled
// by how this run's finished tasks compared to history, with its spread; a
// running task's rest is the lognormal residual of what it has run. One
// backward pass (Clark's moments of a maximum) gives each task's tail to the
// run's end and the end's mean and variance.
//
// The objective, compared in order: the run's expected end, then the
// core-time workers are held (warm-ups included), then fewer workers. The
// plan (`plan3`) inserts each task, least slack first, where it adds least
// expected lateness, then least held time: a joined worker's free room, a
// wait for room, or a new worker asked one warm-up before it is needed. A
// filler placed before a task whose ready time has spread pays the lateness
// its overrun adds. When every open time is a fact, restarts draw each
// start within its slack and keep the best plan. Past `BIG` open tasks one
// forward pass (`plan4`, list scheduling with backfill) plans instead, so a
// million tasks plan in about a second and a half. Every constant here bounds
// the solver's own work; none is a guess about the world.

/** A kind of worker the run may ask for. */
export interface EngineSize {
  readonly cores: number
  /** How many may run at once. */
  readonly max: number
  /** Its platform, as tasks name theirs. */
  readonly platform: string
  /** Its warm-up as history knew it (ms); this run's joins replace it. */
  readonly warmUpMs: number
  /** How much later each next worker of it joined than the one before, as history knew it (ms). */
  readonly spreadMs?: number
}

/** The run's graph and what history knew of each task. */
export interface EngineGraph {
  readonly deps: readonly (readonly number[])[]
  readonly platform: readonly string[]
  /** History's mean time (ms); null: never measured. */
  readonly ms: readonly (number | null)[]
  /** History's spread of it (ms); null: one sample or none. */
  readonly sd: readonly (number | null)[]
  /** The cores it keeps busy, as history measured. */
  readonly cores: readonly number[]
}

export interface EngineOptions {
  /** Tasks start only once handed over (`ready`), as a live run's core hands each over when it misses. */
  readonly gated?: boolean
  /** What a task history never measured keeps busy (`dte({ unmeasured })`); absent, history's mean. */
  readonly unmeasuredCores?: number
}

/** What may run where: a pin to or away from a worker, its memory. */
export interface Fits {
  /** Task `i` may run on worker `w`: now (`now`), or once room frees there. */
  on?(i: number, w: number, now: boolean): boolean
  /** Task `i` may run on a new worker of size `z`. */
  size?(i: number, z: number): boolean
  /** Idle worker `w` stays: it holds what a task to come reads (files no cache has). */
  stay?(w: number): boolean
  /** Cores worker `w` uses now, as measured. */
  load?(w: number): number
  /** Task `i` starts on worker `w` now, after those this decision started before it; false: it waits. */
  admit?(i: number, w: number): boolean
}

export interface Decision {
  /** Tasks to start now, on workers already joined. */
  readonly start: readonly (readonly [task: number, worker: number])[]
  /** Workers to ask now: each a new worker index and its size. */
  readonly ask: readonly (readonly [worker: number, size: number])[]
  /** Idle workers no forecast task needs: let go. */
  readonly leave: readonly number[]
  /** When to decide again with nothing else happening (ms), or Infinity. */
  readonly due: number
}

const phi = (z: number): number => Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI)
/** The standard normal's distribution function (Abramowitz and Stegun 26.2.17). */
const Phi = (z: number): number => {
  const x = Math.abs(z)
  const k = 1 / (1 + 0.2316419 * x)
  const p =
    1 -
    phi(x) *
      k *
      (0.31938153 + k * (-0.356563782 + k * (1.781477937 + k * (-1.821255978 + k * 1.330274429))))
  return z >= 0 ? p : 1 - p
}
/** E[max(X, Y)] for independent normals X ~ N(a, va), Y ~ N(b, vb) (Clark 1961). */
// the last k with T[k] <= x (0 when none): T is sorted
const at = (T: readonly number[], x: number): number => {
  let lo = 0
  let hi = T.length - 1
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1
    if (T[m]! <= x) lo = m
    else hi = m - 1
  }
  return lo
}
const clarkMean = (a: number, va: number, b: number, vb: number): number => {
  const th = Math.sqrt(va + vb)
  if (th === 0) return Math.max(a, b)
  const al = (a - b) / th
  return a * Phi(al) + b * Phi(-al) + th * phi(al)
}

/** Past this many open tasks a decide plans forward once (plan4): the insertion plan (plan3) checks each task
 * against every worker's room over time, and at ten thousand a decide takes about half a second. */
const BIG = 10_000
/** Restarts a decide draws, and their budget in tasks planned: the solver's time per decide, with the best order
 * found carried to the next decide. */
const RESTARTS = 16
const RESTART_BUDGET = 1_600

const BLOCKED = 0
const READY = 1
const RUNNING = 2 // or waiting for the worker asked for it
const DONE = 3

interface Worker {
  readonly ix: number
  readonly size: number
  readonly cores: number
  readonly askedAt: number
  joinedAt?: number
  leftAt?: number
  readonly run: Set<number>
  /** Tasks it was asked for: ready again when it joins. */
  reserved: number[]
  /** The task the plan asked it for: room kept for it until it starts. */
  for?: number
}

const push = (h: [number, number][], x: [number, number]): void => {
  h.push(x)
  let k = h.length - 1
  while (k > 0) {
    const q = (k - 1) >> 1
    if (h[q]![0] <= h[k]![0]) break
    ;[h[q], h[k]] = [h[k]!, h[q]!]
    k = q
  }
}
const pop = <T extends [number, unknown]>(h: T[]): T => {
  const top = h[0]!
  const last = h.pop()!
  if (h.length > 0) {
    h[0] = last
    let k = 0
    for (;;) {
      const l = 2 * k + 1
      const r = l + 1
      let m = k
      if (l < h.length && h[l]![0] < h[m]![0]) m = l
      if (r < h.length && h[r]![0] < h[m]![0]) m = r
      if (m === k) break
      ;[h[m], h[k]] = [h[k]!, h[m]!]
      k = m
    }
  }
  return top
}

/** A min-heap of task numbers by a key each has. */
class KeyHeap {
  readonly h: number[] = []
  constructor(private readonly key: Float64Array) {}
  get size(): number {
    return this.h.length
  }
  top(): number {
    return this.h[0]!
  }
  push(i: number): void {
    const { h, key } = this
    const v = key[i]!
    let k = h.push(i) - 1
    while (k > 0) {
      const q = (k - 1) >> 1
      if (key[h[q]!]! <= v) break
      h[k] = h[q]!
      k = q
    }
    h[k] = i
  }
  pop(): number {
    const { h, key } = this
    const top = h[0]!
    const last = h.pop()!
    if (h.length > 0) {
      const v = key[last]!
      const m = h.length
      let k = 0
      for (;;) {
        const l = 2 * k + 1
        if (l >= m) break
        const r = l + 1
        const c = r < m && key[h[r]!]! < key[h[l]!]! ? r : l
        if (key[h[c]!]! >= v) break
        h[k] = h[c]!
        k = c
      }
      h[k] = last
    }
    return top
  }
}

/** A plan of the rest of the run: what starts now, the workers it asks and when, its end and the core-time held. */
interface Plan {
  readonly asks: [size: number, at: number][]
  readonly start: [task: number, worker: number][]
  /** When each live worker is next given work. */
  readonly next: Map<Worker, number>
  readonly end: number
  readonly held: number
  /** Per task, the worker it is planned on (see Slot.tag), NaN when none. */
  readonly tags?: Float64Array
  /** When each extra worker asked now is first given work. */
  readonly firstX?: number[]
  /** Per ask, the task it is asked for. */
  readonly askFor?: number[]
  /** When the plan next starts a task with nothing else happening. */
  readonly nextStart?: number
}

export class Engine {
  private readonly n: number
  private readonly dOff: Int32Array
  private readonly dArr: Int32Array
  private readonly kOff: Int32Array
  private readonly kArr: Int32Array
  private readonly order: Int32Array
  private readonly plat: Int32Array
  private readonly sizePlat: Int32Array
  private readonly platforms: number
  private readonly platIx: ReadonlyMap<string, number>
  /** What history knew of each task, as `learn` last said. */
  private readonly kms: (number | null)[]
  private readonly ksd: (number | null)[]
  private readonly kcores: Float64Array
  private readonly cEst: Float64Array
  private meanKnown = 0
  /** The order a fact-only run's restarts chose last, while it still beats the plain order: tried first next decide. */
  private kept: Float64Array | undefined
  /** Known tasks' cores and their share: what an unmeasured task's cores may be. */
  private coresHist: [number, number][] = []
  private cvPool = 0
  /** How many tasks history measured, and the sum of their squared means: the unmeasured's prior. */
  private knownN = 0
  private knownSq = 0
  /** A task's cores while history knows none of it: the run's own prior, else history's mean. */
  private readonly unmeasured: number | undefined
  /** Tasks wait for `ready` (the caller hands each over), not only for their upstreams. */
  private readonly gated: boolean

  private readonly state: Uint8Array
  private readonly left: Int32Array
  private readonly progress: Float64Array
  private readonly startedAt: Float64Array
  /** Handed over to run at least once (gated). */
  private readonly handed: Uint8Array
  private readonly doneAt: Float64Array
  private readonly ranMs: Float64Array
  private readonly onWorker: Int32Array
  /** The worker the last plan had each task on (-1: none). */
  private readonly planned: Int32Array
  readonly workers: Worker[] = []
  private readonly joins: number[][]
  /** Each size's warm-up and join spread, cleared when one of it joins. */
  private readonly warms: Float64Array
  private readonly spreads: Float64Array
  private readonly firstRun: Float64Array
  private t = 0
  // this run against history: Σ known, Σ ran, and the ratio's moments
  private finishedKnown = 0
  private finishedKnownRan = 0
  private ratioN = 0
  private ratioSum = 0
  private ratioSq = 0
  private finishedSum = 0
  private finishedSq = 0
  private finishedN = 0
  /** What each unmeasured task running has run, longest first, and their censored mean (NaN: not yet). */
  private runningRan: number[] = []
  private uMean = NaN

  // the forecast, per task
  private readonly E: Float64Array
  private readonly S2: Float64Array
  private readonly tail: Float64Array
  private readonly tv: Float64Array
  private readonly efs: Float64Array
  /** The variance of `efs`, carried along each task's latest upstream. */
  private readonly efsV: Float64Array
  private readonly avail: Float64Array

  constructor(
    private readonly g: EngineGraph,
    private readonly sizes: readonly EngineSize[],
    opts: EngineOptions = {},
  ) {
    const n = (this.n = g.deps.length)
    this.gated = opts.gated === true
    this.unmeasured = opts.unmeasuredCores
    const names: string[] = []
    const ix = (p: string): number => {
      let k = names.indexOf(p)
      if (k < 0) k = names.push(p) - 1
      return k
    }
    this.sizePlat = Int32Array.from(sizes, (s) => ix(s.platform))
    this.plat = Int32Array.from(g.platform, ix)
    this.platforms = names.length
    this.platIx = new Map(names.map((p, k) => [p, k]))
    // adjacency as flat arrays: a million tasks stay in cache
    const dOff = (this.dOff = new Int32Array(n + 1))
    const kOff = (this.kOff = new Int32Array(n + 1))
    for (let i = 0; i < n; i++) {
      const ds = g.deps[i]!
      dOff[i + 1] = dOff[i]! + ds.length
      for (const d of ds) kOff[d + 1]!++
    }
    for (let i = 0; i < n; i++) kOff[i + 1]! += kOff[i]!
    const dArr = (this.dArr = new Int32Array(dOff[n]!))
    const kArr = (this.kArr = new Int32Array(dOff[n]!))
    const fill = kOff.slice(0, n)
    for (let i = 0; i < n; i++)
      g.deps[i]!.forEach((d, x) => {
        dArr[dOff[i]! + x] = d
        kArr[fill[d]!++] = i
      })
    this.left = new Int32Array(n)
    for (let i = 0; i < n; i++) this.left[i] = dOff[i + 1]! - dOff[i]!
    this.order = new Int32Array(n)
    {
      const ind = this.left.slice()
      const q = new Int32Array(n)
      // first in, first out: the graph's own order among tasks free together
      let qn = 0
      let qh = 0
      for (let i = 0; i < n; i++) if (ind[i] === 0) q[qn++] = i
      while (qh < qn) {
        const i = q[qh]!
        this.order[qh++] = i
        for (let x = kOff[i]!; x < kOff[i + 1]!; x++) {
          const k = kArr[x]!
          ind[k] = ind[k]! - 1
          if (ind[k] === 0) q[qn++] = k
        }
      }
    }
    this.kms = Array.from(g.ms)
    this.ksd = Array.from(g.sd)
    this.kcores = Float64Array.from(g.cores)
    this.cEst = new Float64Array(n)
    this.pool()
    this.state = new Uint8Array(n)
    if (!this.gated) for (let i = 0; i < n; i++) if (this.left[i] === 0) this.state[i] = READY
    this.progress = new Float64Array(n)
    this.startedAt = new Float64Array(n)
    this.handed = new Uint8Array(n)
    this.doneAt = new Float64Array(n)
    this.ranMs = new Float64Array(n)
    this.onWorker = new Int32Array(n).fill(-1)
    this.planned = new Int32Array(n).fill(-1)
    this.joins = sizes.map(() => [])
    this.warms = new Float64Array(sizes.length).fill(NaN)
    this.spreads = new Float64Array(sizes.length).fill(NaN)
    this.firstRun = new Float64Array(this.platforms)

    this.E = new Float64Array(n)
    this.S2 = new Float64Array(n)
    this.tail = new Float64Array(n)
    this.tv = new Float64Array(n)
    this.efs = new Float64Array(n)
    this.efsV = new Float64Array(n)
    this.avail = new Float64Array(this.platforms)
  }

  /** History's pooled facts, for the tasks it does not know. */
  private pool(): void {
    const { n, kms, ksd, kcores } = this
    let kc = 0
    let kn = 0
    let km = 0
    let cv = 0
    let cvn = 0
    for (let i = 0; i < n; i++) {
      const k = kms[i]
      if (k === null || k === undefined) continue
      kc += kcores[i]!
      kn++
      km += k
      const sd = ksd[i]
      if (sd !== null && sd !== undefined && k > 0) {
        cv += sd / k
        cvn++
      }
    }
    const meanCores = this.unmeasured ?? (kn > 0 ? kc / kn : 1)
    const hist = new Map<number, number>()
    for (let i = 0; i < n; i++)
      if (kms[i] != null) hist.set(kcores[i]!, (hist.get(kcores[i]!) ?? 0) + 1)
    this.coresHist = [...hist].map(([c, k]) => [c, k / kn] as [number, number])
    this.meanKnown = kn > 0 ? km / kn : 0
    this.cvPool = cvn > 0 ? cv / cvn : 0
    let sq = 0
    for (let i = 0; i < n; i++) {
      const k = kms[i]
      if (k !== null && k !== undefined) sq += k * k
    }
    this.knownN = kn
    this.knownSq = sq
    this.uMean = NaN
    for (let i = 0; i < n; i++) this.cEst[i] = kms[i] === null ? meanCores : kcores[i]!
  }

  /** History landed (or changed): what it knows of each task. */
  learn(
    ms: readonly (number | null)[],
    sd: readonly (number | null)[],
    cores: readonly number[],
  ): void {
    for (let i = 0; i < this.n; i++) {
      this.kms[i] = ms[i] ?? null
      this.ksd[i] = sd[i] ?? null
      this.kcores[i] = cores[i]!
    }
    this.pool()
  }

  /** Task `i` will not run (a cache hit): done at `t`, having taken nothing. */
  drop(i: number, t: number): void {
    if (this.state[i] === DONE) return
    this.advance(t)
    this.unplace(i)
    this.done(i, t)
  }

  /** Not expected to run (a likely hit): done at the start until it is handed over. */
  assume(i: number): void {
    if (this.state[i] === DONE) return
    this.done(i, 0)
  }

  /** Task `i` is handed over to run (gated): it may start. */
  ready(i: number): void {
    if (this.state[i] === RUNNING) return
    this.state[i] = READY
    if (!this.gated || this.handed[i] === 1) return
    this.handed[i] = 1
    // its upstreams never handed over were not run: hits
    const stack = [i]
    while (stack.length > 0) {
      const k = stack.pop()!
      for (let q = this.dOff[k]!; q < this.dOff[k + 1]!; q++) {
        const d = this.dArr[q]!
        if (this.handed[d] === 1 || this.state[d] === DONE) continue
        this.assume(d)
        stack.push(d)
      }
    }
  }

  /** Task `i` is not to be placed until `ready` again (it waits on something outside the plan). */
  hold(i: number): void {
    if (this.state[i] !== READY) return
    this.state[i] = BLOCKED
  }

  /** Task `i` started on worker `w` without the engine (it lets the caller place by hand). */
  private unplace(i: number): void {
    const w = this.workers[this.onWorker[i]!]
    if (w !== undefined) {
      w.run.delete(i)
      const r = w.reserved.indexOf(i)
      if (r >= 0) w.reserved.splice(r, 1)
    }
    this.onWorker[i] = -1
  }

  private done(i: number, t: number): void {
    this.state[i] = DONE
    this.doneAt[i] = t
    this.ranMs[i] = 0
    for (let x = this.kOff[i]!; x < this.kOff[i + 1]!; x++) {
      const k2 = this.kArr[x]!
      if (--this.left[k2]! === 0 && !this.gated && this.state[k2] === BLOCKED)
        this.state[k2] = READY
    }
  }

  /** A worker of size `z` the engine did not ask for (started before the run, or joining on its own), from `t`. */
  adopt(z: number, t: number, cores = this.sizes[z]!.cores): number {
    this.advance(t)
    return this.ask(z, cores)
  }

  /**
   * Task `i` runs again (its worker failed it, or a dependant needs its
   * files made again), on `platform` when given: a dependant on another
   * platform has it made on a worker of its own.
   */
  again(i: number, platform?: string): void {
    const q = platform === undefined ? undefined : this.platIx.get(platform)
    if (q !== undefined) this.plat[i] = q
    this.unplace(i)
    this.progress[i] = 0
    this.state[i] = READY
  }

  /** How long `i` has run, at the rate the engine believes, through `t`. */
  advance(t: number): void {
    const dt = t - this.t
    if (dt > 0)
      for (const w of this.workers) {
        if (w.leftAt !== undefined || w.run.size === 0) continue
        const s = Math.max(1, this.loadEst(w) / w.cores)
        for (const j of w.run) this.progress[j]! += dt / s
      }
    this.t = Math.max(this.t, t)
  }

  /** Task `i` ended at `t` after `ms` of its command alone; absent, as long as the engine believes it ran. */
  finished(i: number, t: number, ms?: number): void {
    this.advance(t)
    if (this.state[i] === DONE) return
    const took = ms ?? this.progress[i]!
    this.unplace(i)
    this.done(i, t)
    this.ranMs[i] = took
    // only an unmeasured task's time is a draw of what an unmeasured task takes
    if (this.kms[i] == null) {
      this.finishedSum += took
      this.finishedSq += took * took
      this.finishedN++
    }
    this.uMean = NaN
    const k = this.kms[i]
    if (k !== null && k !== undefined) {
      this.finishedKnown += k
      this.finishedKnownRan += took
      if (k > 0) {
        const r = took / k
        this.ratioN++
        this.ratioSum += r
        this.ratioSq += r * r
      }
    }
  }

  /** Worker `w` joined at `t`: what it was asked for is ready to place again. */
  joined(w: number, t: number): void {
    this.advance(t)
    const x = this.workers[w]!
    x.joinedAt = t
    this.joins[x.size]!.push(t - x.askedAt)
    this.warms[x.size] = NaN
    this.spreads[x.size] = NaN
    for (const i of x.reserved) this.state[i] = READY
    x.reserved = []
  }

  /** Worker `w` is gone at `t`: what ran there runs again. */
  lost(w: number, t: number): void {
    this.advance(t)
    const x = this.workers[w]!
    if (x.leftAt !== undefined) return
    x.leftAt = t
    for (const i of [...x.run, ...x.reserved]) {
      this.state[i] = READY
      this.progress[i] = 0
      this.onWorker[i] = -1
    }
    x.run.clear()
    x.reserved = []
  }

  /** Worker `w` left or was lost. */
  gone(w: number): boolean {
    return this.workers[w]!.leftAt !== undefined
  }

  isDone(): boolean {
    for (let i = 0; i < this.n; i++) if (this.state[i] !== DONE) return false
    return true
  }

  /** How this run's tasks took against history. */
  private speed(): number {
    return this.finishedKnown > 0 ? this.finishedKnownRan / this.finishedKnown : 1
  }
  /** A task's spread relative to its mean when history knows none: history's pooled, else this run's. */
  private cv(): number {
    if (this.cvPool > 0 || this.ratioN < 2) return this.cvPool
    const m = this.ratioSum / this.ratioN
    const v = (this.ratioSq - this.ratioN * m * m) / (this.ratioN - 1)
    return m > 0 && v > 0 ? Math.sqrt(v) / m : 0
  }
  private est(i: number): number {
    const k = this.kms[i]
    if (k !== null && k !== undefined) return k * this.speed()
    return this.unmeasuredMean()
  }
  /**
   * An unmeasured task's mean, censored: one still running past it counts as ended at what it has run, the
   * least it takes, so the first to end, the short ones, do not alone say what all take. The fixed point
   * `m = (s1 + Σ ran > m) / (n + #(ran > m))`, over the runs sorted longest first.
   */
  private unmeasuredMean(): number {
    const c = this.uMean
    if (c === c) return c
    const [n, s1] = this.unmeasuredMoments()
    const ran = this.runningRan
    let s = s1
    let k = n
    let m = n > 0 ? s / k : 0
    for (const r of ran) {
      if (r <= m) break
      s += r
      k++
      m = s / k
    }
    return (this.uMean = m)
  }
  /**
   * What an unmeasured task takes, as one sample: the measured tasks' times at this run's speed, and the
   * unmeasured tasks that finished. The run's finished tasks alone are the short ones: the first to end.
   */
  private unmeasuredMoments(): [n: number, sum: number, sumSq: number] {
    const sp = this.speed()
    return [
      this.knownN + this.finishedN,
      this.knownN * this.meanKnown * sp + this.finishedSum,
      this.knownSq * sp * sp + this.finishedSq,
    ]
  }
  private sdOf(i: number): number {
    const k = this.kms[i]
    const sd = this.ksd[i]
    if (k !== null && k !== undefined)
      return (sd !== null && sd !== undefined ? sd : this.cv() * k) * this.speed()
    const [n, s1, s2] = this.unmeasuredMoments()
    return n > 1 ? Math.sqrt(Math.max(0, (s2 - (s1 * s1) / n) / (n - 1))) : 0
  }
  /** A size's warm-up: the mean of this run's joins, else history's. */
  private warm(z: number): number {
    const c = this.warms[z]!
    if (c === c) return c
    const j = this.joins[z]!
    return (this.warms[z] =
      j.length > 0 ? j.reduce((a, b) => a + b, 0) / j.length : this.sizes[z]!.warmUpMs)
  }
  /** How long before a worker is needed to ask for it: the slowest join this run has seen, else history's warm-up. */
  private lead(z: number): number {
    const j = this.joins[z]!
    // none joined yet: the slowest join history's spread allows a full fleet of it
    if (j.length === 0)
      return this.warm(z) + (this.sizes[z]!.spreadMs ?? 0) * Math.max(0, this.sizes[z]!.max - 1)
    return Math.max(this.warm(z), ...j)
  }
  /**
   * How much later each next worker of a size asked at once joins than the one before: this run's, from the
   * workers asked together, else history's.
   */
  private spread(z: number): number {
    const c = this.spreads[z]!
    if (c === c) return c
    const by = new Map<number, number[]>()
    for (const w of this.workers)
      if (w.size === z && w.joinedAt !== undefined) {
        const g = by.get(w.askedAt)
        if (g === undefined) by.set(w.askedAt, [w.joinedAt])
        else g.push(w.joinedAt)
      }
    let sum = 0
    let gaps = 0
    for (const g of by.values())
      if (g.length > 1) {
        sum += Math.max(...g) - Math.min(...g)
        gaps += g.length - 1
      }
    return (this.spreads[z] = gaps > 0 ? sum / gaps : (this.sizes[z]!.spreadMs ?? 0))
  }
  /**
   * When each worker asked and not joined is due: its warm-up from its ask, and a spread after the one of its
   * size before it, as a CI queue lets them in one after another.
   */
  private dues(): Float64Array {
    const due = new Float64Array(this.workers.length)
    const last = new Float64Array(this.sizes.length).fill(-Infinity)
    for (const w of this.workers) {
      if (w.joinedAt !== undefined || w.leftAt !== undefined) continue
      const z = w.size
      due[w.ix] = Math.max(w.askedAt + this.warm(z), last[z]! + this.spread(z))
      last[z] = due[w.ix]!
    }
    return due
  }
  /**
   * When a worker of size `z` asked at `ask` joins (`at`), and the same counting it asked (`join`): its
   * warm-up, and a spread after the last of its size asked no later, waiting before it.
   */
  private queue(due: Float64Array): {
    at(z: number, ask: number): number
    join(z: number, ask: number): number
  } {
    const asks: [ask: number, join: number][][] = this.sizes.map(() => [])
    for (const w of this.workers)
      if (w.joinedAt === undefined && w.leftAt === undefined)
        asks[w.size]!.push([w.askedAt, due[w.ix]!])
    const at = (z: number, ask: number): number => {
      let m = -Infinity
      for (const [a, j] of asks[z]!) if (a <= ask + 1e-9 && j > m) m = j
      return Math.max(ask + this.warm(z), m + this.spread(z))
    }
    return {
      at,
      join: (z, ask) => {
        const j = at(z, ask)
        asks[z]!.push([ask, j])
        return j
      },
    }
  }
  /** Worker `w`, asked, is past when it was due to join at `t`: the CI queues it. */
  overdue(w: number, t: number): boolean {
    const x = this.workers[w]!
    return x.joinedAt === undefined && x.leftAt === undefined && t > this.dues()[w]! + 1e-6
  }
  private loadEst(w: Worker, extra = 0): number {
    let s = extra
    for (const j of w.run) s += this.cEst[j]!
    for (const j of w.reserved) s += this.cEst[j]!
    return s
  }
  /** Its expected rest: the lognormal with its mean and spread, given it ran this long. */
  private rem(j: number): number {
    // it holds its cores until it ends: no sooner than the clock's next tick
    return Math.max(1, this.rest(j))
  }
  private rest(j: number): number {
    const e = this.est(j)
    const a = this.progress[j]!
    const sd = this.sdOf(j)
    if (sd > 0 && a > 0 && e > 0) {
      const s2 = Math.log(1 + (sd / e) ** 2)
      const sg = Math.sqrt(s2)
      const mu = Math.log(e) - s2 / 2
      const surv = Phi((mu - Math.log(a)) / sg)
      if (surv > 0) return Math.max(0, (e * Phi((mu + s2 - Math.log(a)) / sg)) / surv - a)
    }
    // past its mean with no spread known: as long again (the most uncertain guess)
    return e - a > 0 ? e - a : e
  }
  private live(): Worker[] {
    return this.workers.filter((w) => w.leftAt === undefined)
  }
  private ask(z: number, cores = this.sizes[z]!.cores): number {
    this.workers.push({
      ix: this.workers.length,
      size: z,
      cores,
      askedAt: this.t,
      run: new Set(),
      reserved: [],
    })
    return this.workers.length - 1
  }

  /**
   * The forecast: each task's expected chain after it (`tail`), and the end
   * the facts allow with no decision's delay in it (`D`): every task as soon
   * as its upstreams, from the first moment a worker of its platform could
   * run, done tasks at what they took.
   */
  private forecast(): { D: number; Dv: number } {
    const { n, order, dOff, dArr, kOff, kArr, E, S2, tail, tv, efs, state } = this
    const t = this.t
    const ran: number[] = []
    for (let i = 0; i < n; i++)
      if (state[i] === RUNNING && this.kms[i] == null) ran.push(this.progress[i]!)
    this.runningRan = ran.sort((a, b) => b - a)
    this.uMean = NaN
    for (let i = 0; i < n; i++)
      if (state[i] !== DONE) {
        // a task holds its cores while it runs: it ends no sooner than the clock's next tick (with nothing
        // measured yet, its estimate is 0)
        E[i] = Math.max(1, this.est(i))
        S2[i] = this.sdOf(i) ** 2
      }
    for (let x = n - 1; x >= 0; x--) {
      const i = order[x]!
      if (state[i] === DONE) continue
      let m = 0
      let v = 0
      for (let q = kOff[i]!; q < kOff[i + 1]!; q++) {
        const k = kArr[q]!
        // the longest chain after it carries its spread
        if (tail[k]! > m) {
          m = tail[k]!
          v = tv[k]!
        }
      }
      tail[i] = E[i]! + m
      tv[i] = S2[i]! + v
    }
    const { avail, firstRun, sizePlat } = this
    const due = this.dues()
    avail.fill(Infinity)
    for (let z = 0; z < this.sizes.length; z++)
      if (this.sizes[z]!.max > 0)
        avail[sizePlat[z]!] = Math.min(avail[sizePlat[z]!]!, t + this.warm(z))
    for (const w of this.live())
      avail[sizePlat[w.size]!] = Math.min(
        avail[sizePlat[w.size]!]!,
        w.joinedAt ?? Math.max(t, due[w.ix]!),
      )
    for (let q = 0; q < this.platforms; q++) {
      // a fact replaces the forecast: the first join once it happened, else no sooner than now
      let j = Infinity
      for (const w of this.workers)
        if (sizePlat[w.size] === q && w.joinedAt !== undefined) j = Math.min(j, w.joinedAt)
      firstRun[q] = j < Infinity ? j : Math.max(firstRun[q] || avail[q]!, t)
    }
    let D = 0
    let Dv = 0
    for (let x = 0; x < n; x++) {
      const i = order[x]!
      let m = firstRun[this.plat[i]!]!
      let mv = 0
      for (let q = dOff[i]!; q < dOff[i + 1]!; q++)
        if (efs[dArr[q]!]! > m) {
          m = efs[dArr[q]!]!
          mv = this.efsV[dArr[q]!]!
        }
      const took =
        state[i] === DONE
          ? this.ranMs[i]!
          : state[i] === RUNNING && this.progress[i]! > 0
            ? this.progress[i]! + this.rem(i)
            : E[i]!
      efs[i] = m + took
      this.efsV[i] = state[i] === DONE ? mv : mv + S2[i]!
      if (efs[i]! > D) {
        D = efs[i]!
        Dv = this.efsV[i]!
      }
    }
    return { D, Dv }
  }

  /**
   * Each task's cores as planned, with what a worker measures: a worker using
   * more than its tasks' estimates says spreads the excess over its unmeasured tasks, else over all.
   */
  private measured(fits: Fits): Float64Array {
    let cEst = this.cEst
    if (fits.load === undefined) return cEst
    for (const w of this.live()) {
      if (w.joinedAt === undefined) continue
      const m = fits.load(w.ix)
      let S = 0
      let u = 0
      for (const j of w.run) {
        S += cEst[j]!
        if (this.kms[j] == null) u++
      }
      if (m > S + 1e-9 && w.run.size > 0) {
        if (cEst === this.cEst) cEst = Float64Array.from(cEst)
        // none unmeasured: history was wrong of them all, each by its share
        if (u > 0) {
          for (const j of w.run) if (this.kms[j] == null) cEst[j] = cEst[j]! + (m - S) / u
        } else for (const j of w.run) cEst[j] = (cEst[j]! * m) / S
      }
    }
    return cEst
  }
  /** A restart's order: each task's start drawn `u` of the way into its slack, never before an upstream's. */
  private drawKeys(u: Float64Array, D: number): Float64Array {
    const { n, state, tail, E, dOff, dArr, order } = this
    const key = new Float64Array(n)
    for (let x = 0; x < n; x++) {
      const i = order[x]!
      if (state[i] === DONE) continue
      const es = this.efs[i]! - E[i]!
      let k = es + u[i]! * Math.max(0, D - tail[i]! - es)
      for (let q = dOff[i]!; q < dOff[i + 1]!; q++) k = Math.max(k, key[dArr[q]!]!)
      key[i] = k
    }
    return key
  }
  private plan3(
    t: number,
    D: number,
    fits: Fits,
    extra: readonly number[] = [],
    eager = false,
    soon = false,
    Dv = 0,
    key?: Float64Array,
  ): Plan {
    const { n, state, tail, E, dOff, dArr, plat, order } = this
    const cEst = this.measured(fits)
    interface Slot {
      readonly plat: number
      readonly size: number
      readonly cores: number
      readonly joinAt: number
      /** Held from (ms): now for a live one, its ask for a new one. */
      readonly from: number
      /** Its room over time: load on [T[k], T[k+1]). */
      readonly T: number[]
      readonly L: number[]
      /** Per load threshold, where the load reaches it, as sorted disjoint runs [starts, ends): a task too wide
       * for that load skips a run in one step. Made on first use, kept as tasks are taken. */
      runs?: Map<number, [number[], number[]]>
      first: number
      /** Its place in byPlat, which runs from the latest profile end to the soonest. */
      o?: number
      readonly w?: Worker
      /** Which worker it is: a live one's index; -1 - k the k-th asked now; -1e6 - k the k-th asked by the plan. */
      tag?: number
      /** Its running tasks whose ends are uncertain: what a task after them may wait for. */
      unc?: { F: number; sd: number; c: number; i: number }[]
      /** Tasks placed on it whose ready time has spread: what a task before them risks delaying. */
      res?: {
        K: number
        m: number
        sd: number
        c: number
        Fk: number
        tk: number
        ek: number
        vk: number
      }[]
    }
    const slots: Slot[] = []
    const byPlat: Slot[][] = Array.from({ length: this.platforms }, () => [])
    const count = Array.from({ length: this.sizes.length }, () => 0)
    // keep byPlat from the latest profile end to the soonest (stable)
    const lift = (s: Slot): void => {
      const o = byPlat[s.plat]!
      // an idle worker's profile ends now, however long ago it joined: a tie keeps the order joined
      const e = Math.max(t, s.T[s.T.length - 1]!)
      let k = s.o!
      while (k > 0 && Math.max(t, o[k - 1]!.T[o[k - 1]!.T.length - 1]!) < e) {
        o[k] = o[k - 1]!
        o[k]!.o = k
        k--
      }
      o[k] = s
      s.o = k
    }
    const add = (s: Slot): Slot => {
      s.runs = new Map()
      slots.push(s)
      const o = byPlat[s.plat]!
      s.o = o.length
      o.push(s)
      lift(s)
      count[s.size]!++
      return s
    }
    const slotOf = new Map<Worker, Slot>()
    const due = this.dues()
    const q = this.queue(due)
    for (const w of this.live()) {
      const joinAt = w.joinedAt ?? Math.max(due[w.ix]!, t + 1)
      slotOf.set(
        w,
        add({
          plat: this.sizePlat[w.size]!,
          size: w.size,
          cores: w.cores,
          joinAt,
          from: t,
          T: [joinAt],
          L: [0],
          first: Infinity,
          w,
          tag: w.ix,
        }),
      )
    }
    let xk = 0
    for (let z = 0; z < extra.length; z++)
      for (let k = 0; k < extra[z]!; k++) {
        const joinAt = q.join(z, t)
        add({
          plat: this.sizePlat[z]!,
          size: z,
          cores: this.sizes[z]!.cores,
          joinAt,
          from: t,
          T: [joinAt],
          L: [0],
          first: Infinity,
          tag: -1 - xk++,
        })
      }
    const fits1 = (s: Slot, load: number, c: number): boolean =>
      load < s.cores - 1e-9 && load + Math.min(c, s.cores) < s.cores + 1 - 1e-9
    // the soonest start from r with room for c cores for d ms (stretched by what overfills)
    // what no task left fits in: the shortest task's time (set once the tasks are known)
    let gapMin = 0
    // the load at which a task of c cores no longer fits (fits1)
    const thr = (s: Slot, c: number): number =>
      Math.min(s.cores, s.cores + 1 - Math.min(c, s.cores)) - 1e-9
    const runsOf = (s: Slot, h: number): [number[], number[]] | undefined => {
      if (s.runs === undefined) return undefined
      let x = s.runs.get(h)
      if (x === undefined) {
        const Rs: number[] = []
        const Re: number[] = []
        const { T, L } = s
        for (let k = 0; k < T.length - 1; k++)
          if (L[k]! >= h) {
            if (Re.length > 0 && Re[Re.length - 1]! >= T[k]! - gapMin) Re[Re.length - 1] = T[k + 1]!
            else {
              Rs.push(T[k]!)
              Re.push(T[k + 1]!)
            }
          }
        x = [Rs, Re]
        s.runs.set(h, x)
      }
      return x
    }
    // a task wider than the worker, ready now: on the whole cores free now, as many times as long as it is
    // short of its cores, when that ends sooner than the worker whole later (a gap planned later moves as tasks end)
    const soonest = (s: Slot, r: number, c: number, e: number, pad = 0): [number, number] => {
      const a = soonest1(s, r, c, e, pad)
      const S = Math.max(r, s.joinAt)
      if (c <= s.cores || S > t + 1e-6) return a
      const { T, L } = s
      const k = at(T, S)
      const f = Math.floor(s.cores - L[k]! + 1e-9)
      if (f < 1) return a
      const d = e * (c / f)
      if (S + d >= a[0] + a[1]) return a
      for (let j = k + 1; j < T.length && T[j]! < S + d + pad; j++)
        if (L[j]! > s.cores - f + 1e-9) return a
      return [S, d]
    }
    const soonest1 = (s: Slot, r: number, c: number, e: number, pad: number): [number, number] => {
      const { T, L } = s
      let S = Math.max(r, s.joinAt)
      const R = runsOf(s, thr(s, c))
      if (R !== undefined) {
        const [Fs, Fe] = R
        // it fits wherever the slot is not full: only a full run can push it later
        let q = Fe.length === 0 ? 0 : at(Fe, S)
        if (q < Fe.length && Fe[q]! <= S) q++
        for (;;) {
          if (q < Fs.length && Fs[q]! <= S) {
            S = Fe[q++]!
            continue
          }
          const d = e * Math.max(1, (L[at(T, S)]! + c) / s.cores)
          if (q < Fs.length && Fs[q]! < S + d + pad) {
            S = Fe[q++]!
            continue
          }
          return [S, d]
        }
      }
      let k = at(T, S)
      for (;;) {
        const d = e * Math.max(1, (L[k]! + c) / s.cores)
        let ok = true
        for (let j = k; j < T.length && (j === k || T[j]! < S + d + pad); j++)
          if (!fits1(s, L[j]!, c)) {
            if (j + 1 >= T.length) return [Infinity, 0]
            S = T[j + 1]!
            k = j + 1
            ok = false
            break
          }
        if (ok) return [S, d]
      }
    }
    // c more cores on [S, F)
    const bump = (T: number[], L: number[], S: number, F: number, c: number): [number, number] => {
      const cut = (x: number): number => {
        const k = at(T, x)
        if (T[k] === x) return k
        T.splice(k + 1, 0, x)
        L.splice(k + 1, 0, L[k]!)
        return k + 1
      }
      const a = cut(S)
      const b = cut(F)
      for (let k = a; k < b; k++) L[k]! += c
      return [a, b]
    }
    const take = (s: Slot, S: number, F: number, c: number): void => {
      const { T, L } = s
      const [a, b] = bump(T, L, S, F, c)
      if (s.o !== undefined) lift(s)
      if (s.runs === undefined) return
      for (const [h, [Fs, Fe]] of s.runs)
        for (let k = a; k < b; k++) {
          if (L[k]! < h) continue
          let x = T[k]!
          let y = T[k + 1]!
          while (k + 1 < b && L[k + 1]! >= h) y = T[++k + 1]!
          // merge with the runs it touches
          // a gap no task fits (shorter than the shortest left) is no gap
          let q = Fe.length === 0 ? 0 : at(Fe, x - gapMin)
          if (Fe.length > 0 && Fe[q]! < x - gapMin) q++
          let u = q
          while (u < Fs.length && Fs[u]! <= y + gapMin) {
            x = Math.min(x, Fs[u]!)
            y = Math.max(y, Fe[u]!)
            u++
          }
          Fs.splice(q, u - q, x)
          Fe.splice(q, u - q, y)
        }
    }
    // core-ms slot s is held: from its ask (or now) to its last end, an idle gap longer than a warm-up costing a warm-up
    const holdOf = (s: Slot, T: readonly number[], L: readonly number[]): number => {
      // one the plan may ask later is asked a warm-up before its first work: nothing held before
      const later = s.tag !== undefined && s.tag < 0 && s.tag > -1e5
      if (T.length === 1)
        return later
          ? 0
          : s.w === undefined || s.w.joinedAt === undefined
            ? (s.joinAt - s.from) * s.cores
            : 0
      let h = s.joinAt > s.from ? s.joinAt - s.from : 0
      let idleFrom = Math.max(s.from, s.joinAt)
      if (later) {
        let k = 0
        while (k < T.length - 1 && L[k]! <= 1e-9) k++
        h = this.warm(s.size)
        idleFrom = T[k]!
      }
      for (let k = 0; k < T.length - 1; k++)
        if (L[k]! > 1e-9) {
          if (idleFrom < T[k]!) h += Math.min(T[k]! - idleFrom, this.warm(s.size))
          h += T[k + 1]! - T[k]!
          idleFrom = T[k + 1]!
        }
      return h * s.cores
    }
    // what a task on [S, F) adds to it
    const addedHold = (s: Slot, S: number, F: number, c: number): number => {
      const { T, L } = s
      const last = T.length - 1
      // the profile before the last busy stretch ending by S, and after the first starting at F, holds the same
      let k0 = at(T, S) - 1
      while (k0 >= 0 && L[k0]! <= 1e-9) k0--
      const later = s.tag !== undefined && s.tag < 0 && s.tag > -1e5
      if (last === 0 || (k0 < 0 && later)) {
        const T2 = T.slice()
        const L2 = L.slice()
        bump(T2, L2, S, F, c)
        return holdOf(s, T2, L2) - holdOf(s, T, L)
      }
      const ks = k0 + 1
      const from = k0 < 0 ? Math.max(s.from, s.joinAt) : T[ks]!
      let k1 = at(T, F)
      if (T[k1]! < F) k1++
      while (k1 < last && L[k1]! <= 1e-9) k1++
      const e1 = Math.min(k1 + 1, last)
      const part = (T: readonly number[], L: readonly number[]): number => {
        let h = 0
        let idleFrom = from
        for (let k = 0; k < T.length - 1; k++)
          if (L[k]! > 1e-9) {
            if (idleFrom < T[k]!) h += Math.min(T[k]! - idleFrom, this.warm(s.size))
            h += T[k + 1]! - T[k]!
            idleFrom = T[k + 1]!
          }
        return h
      }
      const Tw = T.slice(ks, e1 + 1)
      const Lw = L.slice(ks, e1 + 1)
      const before = part(Tw, Lw)
      bump(Tw, Lw, S, F, c)
      return (part(Tw, Lw) - before) * s.cores
    }
    const fin = new Float64Array(n)
    const st = new Float64Array(n).fill(-1)
    const on: (Slot | undefined)[] = Array.from({ length: n })
    let end = t
    let open = 0
    const todo: number[] = []
    for (let x = 0; x < n; x++) {
      const i = order[x]!
      if (state[i] === DONE) {
        fin[i] = this.doneAt[i]!
        continue
      }
      open++
      if (state[i] === RUNNING && this.onWorker[i]! >= 0) {
        const w = this.workers[this.onWorker[i]!]!
        const f = t + this.rem(i) * Math.max(1, this.loadEst(w) / w.cores)
        fin[i] = f
        const s = slotOf.get(w)
        if (s !== undefined) take(s, t, f, cEst[i]!)
        if (s !== undefined) {
          const sd = this.sdOf(i)
          if (sd > 0) (s.unc ??= []).push({ F: f, sd, c: cEst[i]!, i })
        }
        if (f > end) end = f
        open--
        continue
      }
      todo.push(i)
    }
    // the latest start first; upstreams before (a longer tail), the graph's order on ties
    const pos = new Int32Array(n)
    for (let x = 0; x < n; x++) pos[order[x]!] = x
    // one the run has not handed over though nothing it waits for is open (a probe or a save still out), and
    // what waits on it: placed after the rest, so a guess at when it comes keeps no handed task from its room
    const wait = new Uint8Array(n)
    if (this.gated)
      for (let x = 0; x < n; x++) {
        const i = order[x]!
        if (state[i] !== BLOCKED || this.handed[i] === 1) continue
        let open = false
        let w = false
        for (let q = dOff[i]!; q < dOff[i + 1]!; q++) {
          const d = dArr[q]!
          if (wait[d] === 1) w = true
          else if (state[d] !== DONE) open = true
        }
        if (w || !open) wait[i] = 1
      }
    if (key === undefined)
      todo.sort((a, b) => wait[a]! - wait[b]! || tail[b]! - tail[a]! || pos[a]! - pos[b]!)
    else
      todo.sort(
        (a, b) =>
          wait[a]! - wait[b]! || key[a]! - key[b]! || tail[b]! - tail[a]! || pos[a]! - pos[b]!,
      )
    const asks: [number, number][] = []
    for (const i of todo) if (E[i]! < gapMin) gapMin = E[i]!
    // the run's lateness a filler on s ending at F adds by delaying a task placed after it whose ready time is uncertain
    const risk = (s: Slot, F: number, c: number, sj = 0): number => {
      if (s.res === undefined) return 0
      let p = 0
      for (const q of s.res) {
        if (q.K < F - 1e-6 || c + q.c <= s.cores + 1e-9) continue
        const sd = Math.sqrt(q.sd * q.sd + sj * sj)
        if (sd <= 0) continue
        const z = (F - q.m) / sd
        const d = (F - q.m) * Phi(z) + sd * phi(z)
        if (d <= 1e-6) continue
        const l0 = Math.max(0, clarkMean(q.Fk + q.tk - q.ek, q.vk, D, Dv) - D)
        p += Math.max(0, clarkMean(q.Fk + d + q.tk - q.ek, q.vk, D, Dv) - D) - l0
      }
      return p
    }
    // a start at S on s, expected: past the running tasks it waits for, whose ends are uncertain, and its upstream's
    const expStart = (
      s: Slot,
      S: number,
      c: number,
      r: number,
      rsd: number,
      rd: number,
    ): number => {
      let m = S
      let v = 0
      let late = false
      if (s.unc !== undefined)
        for (const q of s.unc) {
          // its upstream's end is its ready time's spread, counted once, below
          if (q.i === rd || q.F > S + 1e-6 || q.F < S - 4 * q.sd || c + q.c <= s.cores + 1e-9)
            continue
          const m2 = clarkMean(m, v, q.F, q.sd * q.sd)
          late = true
          v = Math.max(v, q.sd * q.sd)
          m = m2
        }
      if (!late) return S
      if (rsd > 0 && r >= S - 4 * rsd) m = clarkMean(m, v, r, rsd * rsd)
      return Math.max(S, m)
    }
    for (const i of todo) {
      let r = t
      let rd = -1
      for (let x = dOff[i]!; x < dOff[i + 1]!; x++) {
        const d = dArr[x]!
        if (fin[d]! > r) {
          r = fin[d]!
          rd = d
        }
      }
      const c = cEst[i]!
      const e = E[i]!
      // the spread of when its upstream still running ends
      const rsd = rd >= 0 && state[rd] === RUNNING ? this.sdOf(rd) : 0
      const p = plat[i]!
      let bs: Slot | undefined
      let bS = Infinity
      let bK = Infinity
      let bF = Infinity
      let bX = Infinity
      let bL = Infinity
      // how much ending at F is expected to end the run late: E[max(its path, the run's end)] − E[the run's end]
      const sdi = this.sdOf(i)
      const pathV = sdi * sdi + Math.max(0, this.tv[i]! - sdi * sdi)
      const lf = D - tail[i]! + e
      const lateBy = (F: number): number =>
        pathV > 0 || Dv > 0
          ? Math.max(0, clarkMean(F + tail[i]! - e, pathV, D, Dv) - D)
          : Math.max(0, F - lf)
      // a joined or asked worker it may run on, or one the plan would ask of a size it may ask for
      const allowed = (s: Slot): boolean =>
        s.w !== undefined
          ? fits.on === undefined || fits.on(i, s.w.ix, false)
          : fits.size === undefined || fits.size(i, s.size)
      const consider = (s: Slot): void => {
        if (!allowed(s)) return
        const [K, d] = soonest(s, r, c, e)
        if (K === Infinity) return
        const S = K
        // its expected start there: past the uncertain ends it waits for
        const xs = expStart(s, S, c, r, rsd, rd) - S
        const F = K + d + xs
        // in time: the one it adds least held time to, then the soonest end; late: the soonest end
        const lt = lateBy(F) + risk(s, F, c, sdi)
        const X = !soon ? (lt <= 1e-6 ? addedHold(s, S, F, c) : Infinity) : 0
        const bOn = bL <= 1e-6
        const on = lt <= 1e-6
        // on a tie, the worker the last plan had it on: a plan followed is not remade
        const kept = s.w !== undefined && this.planned[i] === s.w.ix
        if (
          bs === undefined ||
          (on && !bOn) ||
          (on &&
            bOn &&
            (X < bX - 1e-6 || (X <= bX + 1e-6 && (F < bF - 1e-6 || (F <= bF + 1e-6 && kept))))) ||
          (!on &&
            !bOn &&
            (lt < bL - 1e-6 ||
              (lt <= bL + 1e-6 &&
                (F < bF - 1e-6 ||
                  (F <= bF + 1e-6 && s.T[s.T.length - 1]! > bs.T[bs.T.length - 1]!)))))
        ) {
          bs = s
          bS = S
          bK = K
          bF = F
          bX = X
          bL = lt
        }
      }
      // a slot that runs it from r unstretched (and, in time, adds nothing held): nothing ends it sooner
      const l0 = lateBy(r + e)
      const ext0 = !soon && l0 <= 1e-6
      const now = (s: Slot): boolean => {
        if (s.joinAt > r) return false
        const { T, L } = s
        let k = at(T, r)
        if (L[k]! + c > s.cores + 1e-9) return false
        const end = r + e
        const R = runsOf(s, thr(s, c))
        if (R !== undefined) {
          const [Fs, Fe] = R
          let q = Fe.length === 0 ? 0 : at(Fe, r)
          if (q < Fe.length && Fe[q]! <= r) q++
          if (q < Fs.length && Fs[q]! < end) return false
        } else
          for (; k < T.length && (T[k]! < end || T[k]! <= r); k++)
            if (!fits1(s, L[k]!, c)) return false
        if (!allowed(s)) return false
        if (ext0 && addedHold(s, r, end, c) > 1e-6) return false
        if (risk(s, end, c, sdi) > 1e-6) return false
        if (expStart(s, r, c, r, rsd, rd) > r + 1e-6) return false
        return true
      }
      {
        // the slot the last plan had it on first: a plan followed is not remade
        const ks = this.planned[i]!
        const kw = ks >= 0 ? this.workers[ks] : undefined
        let kslot = kw === undefined ? undefined : slotOf.get(kw)
        if (kslot !== undefined && (kslot.plat !== p || !now(kslot))) kslot = undefined
        // else the first such from the latest profile end: the busiest, which a tie prefers
        if (kslot === undefined)
          for (const s of byPlat[p]!)
            if (now(s)) {
              kslot = s
              break
            }
        if (kslot !== undefined) {
          bs = kslot
          bS = r
          bK = r
          bF = r + e
          bX = 0
          bL = l0
        } else for (const s of byPlat[p]!) consider(s)
      }
      if (bL > 1e-6 || (eager && bF > r + e + 1e-6)) {
        // a new worker: asked the slowest warm-up seen before it is needed, no sooner than now
        let bz = -1
        let zF = Infinity
        let zC = Infinity
        for (let z = 0; z < this.sizes.length; z++) {
          if (this.sizePlat[z] !== p || count[z]! >= this.sizes[z]!.max) continue
          if (fits.size !== undefined && !fits.size(i, z)) continue
          const ez = e * Math.max(1, c / this.sizes[z]!.cores)
          const need = eager || pathV > 0 ? r : Math.max(r, lf - ez)
          const a = Math.max(t, need - this.lead(z))
          const F = Math.max(r, q.at(z, a)) + ez
          const cc = this.sizes[z]!.cores * (this.warm(z) + ez)
          if (F < zF - 1e-6 || (F <= zF + 1e-6 && cc < zC)) {
            bz = z
            zF = F
            zC = cc
          }
        }
        if (
          bz >= 0 &&
          (lateBy(zF) < bL - 1e-6 || (lateBy(zF) <= bL + 1e-6 && zF < bF - 1e-6 && eager))
        ) {
          const ez = e * Math.max(1, c / this.sizes[bz]!.cores)
          const ask = Math.max(t, (eager || pathV > 0 ? r : Math.max(r, lf - ez)) - this.lead(bz))
          const joinAt = q.join(bz, ask)
          const s = add({
            plat: p,
            size: bz,
            cores: this.sizes[bz]!.cores,
            joinAt,
            from: ask,
            T: [joinAt],
            L: [0],
            first: Infinity,
            tag: -1e6 - asks.length,
          })
          asks.push([bz, ask])
          bs = s
          bS = Math.max(r, joinAt)
          bK = Infinity
          bF = bS + ez
        }
      }
      if (bs === undefined) continue
      {
        // a task whose ready time has spread, placed as soon as ready: a task before it risks delaying it
        const sd =
          rd >= 0 && bS <= r + 1e-6
            ? Math.sqrt(state[rd] === RUNNING ? this.sdOf(rd) ** 2 : this.efsV[rd]!)
            : 0
        const sp = Math.sqrt(sd * sd + pathV + Dv)
        if (sp > 0 && clarkMean(bF + 3 * sp + tail[i]! - e, pathV, D, Dv) - D > 1e-6)
          (bs.res ??= []).push({ K: bS, m: bS, sd, c, Fk: bF, tk: tail[i]!, ek: e, vk: pathV })
      }
      take(bs, bK < Infinity ? bK : bS, bF, c)
      if (bS < bs.first) bs.first = bS
      fin[i] = bF
      st[i] = bS
      on[i] = bs
      open--
      if (bF > end) end = bF
    }
    const start: [number, number][] = []
    for (const i of todo)
      if (state[i] === READY && st[i]! >= 0 && st[i]! <= t + 1e-6) {
        const s = on[i]!
        if (
          s.w !== undefined &&
          s.w.joinedAt !== undefined &&
          (fits.on === undefined || fits.on(i, s.w.ix, true))
        )
          start.push([i, s.w.ix])
      }
    let held = 0
    for (const s of slots) held += holdOf(s, s.T, s.L)
    const next = new Map<Worker, number>()
    for (const s of slots) if (s.w !== undefined) next.set(s.w, s.first)
    const tags = new Float64Array(n).fill(NaN)
    for (const i of todo) if (on[i] !== undefined) tags[i] = on[i]!.tag!
    const firstX: number[] = []
    for (const s of slots)
      if (s.tag !== undefined && s.tag < 0 && s.tag > -1e5) firstX[-1 - s.tag] = s.first
    return { asks, start, next, end: open > 0 ? Infinity : end, held, tags, firstX }
  }

  /**
   * The rest of the run played forward in time, as a list schedule: each moment, the waiting tasks in order
   * of their latest start take the busiest worker with room; only the first that cannot start holds room
   * back (its reservation: the soonest a worker frees enough for it), and any other starts in a gap when it
   * ends before that reservation or leaves it room (EASY backfilling). A first waiting task that would end
   * the run late asks for a new worker, the slowest join seen before it is needed.
   */
  private plan4(t: number, D: number, fits: Fits, Dv = 0): Plan {
    const { n, state, tail, E, dOff, dArr, kOff, kArr, plat, order } = this
    const cEst = this.measured(fits)
    // when a slot's last running task ends: the one busy longest takes work first, the rest may leave
    const untilOf = (s: { run: number[] }): number => {
      let u = -Infinity
      for (let k = 0; k < s.run.length; k++) if (fin[s.run[k]!]! > u) u = fin[s.run[k]!]!
      return u
    }
    interface Slot {
      readonly plat: number
      readonly size: number
      readonly cores: number
      readonly joinAt: number
      readonly from: number
      readonly w?: Worker
      readonly tag: number
      load: number
      /** Tasks on it. */
      readonly run: number[]
      first: number
      /** Its place in the platform's open list (joined, not full), else -1. */
      oi: number
      busyFrom: number
      idleFrom: number
      held: number
      worked: boolean
      /** The task it was asked for, while that waits: others start on it only if they leave it room. */
      resv: number
      /** Cores freed in a reservation's walk. */
      fr: number
      /** The first task the plan gives it. */
    }
    const P = this.platforms
    const slots: Slot[] = []
    const openL: Slot[][] = Array.from({ length: P }, () => [])
    const pend: Slot[][] = Array.from({ length: P }, () => [])
    const count = Array.from({ length: this.sizes.length }, () => 0)
    const joinsH: [number, number][] = []
    // a class per whole core a task asks, up to the widest worker of its platform
    const K = new Int32Array(P)
    for (let z = 0; z < this.sizes.length; z++)
      K[this.sizePlat[z]!] = Math.max(K[this.sizePlat[z]!]!, Math.ceil(this.sizes[z]!.cores))
    for (const w of this.workers)
      K[this.sizePlat[w.size]!] = Math.max(K[this.sizePlat[w.size]!]!, Math.ceil(w.cores))
    const classOf = (i: number): number =>
      Math.max(0, Math.min(K[plat[i]!]!, Math.ceil(cEst[i]! - 1e-9)) - 1)
    // per platform, whether the plan may still ask for one of its sizes (kept as workers are added)
    const canAsk = new Uint8Array(P)
    const recount = (p: number): void => {
      canAsk[p] = 0
      for (let z = 0; z < this.sizes.length; z++)
        if (this.sizePlat[z] === p && count[z]! < this.sizes[z]!.max) canAsk[p] = 1
    }
    const add = (s: Slot): Slot => {
      slots.push(s)
      count[s.size]!++
      recount(s.plat)
      if (s.joinAt > t) {
        push(joinsH, [s.joinAt, slots.length - 1])
        pend[s.plat]!.push(s)
      }
      return s
    }
    const mk = (
      pl: number,
      size: number,
      cores: number,
      joinAt: number,
      from: number,
      tag: number,
      w?: Worker,
    ): Slot =>
      add({
        plat: pl,
        size,
        cores,
        joinAt,
        from,
        ...(w === undefined ? {} : { w }),
        tag,
        load: 0,
        run: [],
        first: Infinity,
        oi: -1,
        busyFrom: 0,
        idleFrom: Math.max(from, joinAt),
        held: 0,
        worked: false,
        resv:
          w?.for !== undefined && (state[w.for] === READY || state[w.for] === BLOCKED) ? w.for : -1,
        fr: 0,
      })
    const slotOf = new Map<Worker, Slot>()
    const dueAt = this.dues()
    const q = this.queue(dueAt)
    for (const w of this.live()) {
      const joinAt = w.joinedAt ?? Math.max(dueAt[w.ix]!, t + 1)
      slotOf.set(w, mk(this.sizePlat[w.size]!, w.size, w.cores, joinAt, t, w.ix, w))
    }
    const isFull = (s: Slot): boolean => s.load >= s.cores - 1e-9
    const fitsOn = (s: Slot, load: number, c: number): boolean =>
      load < s.cores - 1e-9 && load + Math.min(c, s.cores) < s.cores + 1 - 1e-9
    const openAdd = (s: Slot): void => {
      if (s.oi >= 0) return
      const o = openL[s.plat]!
      s.oi = o.length
      o.push(s)
    }
    const openDel = (s: Slot): void => {
      if (s.oi < 0) return
      const o = openL[s.plat]!
      const last = o.pop()!
      if (last !== s) {
        o[s.oi] = last
        last.oi = s.oi
      }
      s.oi = -1
    }
    // the plan's own order: latest start first, the graph's order on ties
    const pos = new Int32Array(n)
    for (let x = 0; x < n; x++) pos[order[x]!] = x
    // one key: the longest tail first, then the graph's order (below a microsecond)
    const prio = new Float64Array(n)
    for (let i = 0; i < n; i++) prio[i] = -tail[i]! + (pos[i]! * 1e-3) / (n + 1)
    const before = (a: number, b: number): boolean => prio[a]! < prio[b]!
    const ready: KeyHeap[][] = Array.from({ length: P }, (_, p) =>
      Array.from({ length: Math.max(1, K[p]!) }, () => new KeyHeap(prio)),
    )
    const triedBuf = new Uint8Array(Math.max(1, ...K))
    // each waiting task's latest start: one still waiting then takes a new worker if that ends it sooner
    const dlT = new Float64Array(n)
    const dlH = new KeyHeap(dlT)
    // per class, the shortest waiting: what a gap before a reservation takes when the first in order is too long
    // (made the first time a class needs it)
    const short: (KeyHeap | undefined)[][] = Array.from({ length: P }, (_, p) =>
      Array.from({ length: Math.max(1, K[p]!) }),
    )
    const shortOf = (p: number, k: number): KeyHeap => {
      let h = short[p]![k]
      if (h === undefined) {
        h = short[p]![k] = new KeyHeap(E)
        for (const i of ready[p]![k]!.h) if (st[i]! < 0) h.push(i)
      }
      return h
    }
    // a size of each platform the plan may still ask for: only then is a latest start worth an event
    for (let p = 0; p < P; p++) recount(p)
    const askable = (p: number): boolean => canAsk[p] === 1
    const enqueue = (i: number, x: number): void => {
      const p = plat[i]!
      const k = classOf(i)
      ready[p]![k]!.push(i)
      short[p]![k]?.push(i)
      if (askable(p)) {
        dlT[i] = Math.max(x, D - tail[i]!)
        dlH.push(i)
      }
    }
    // the first in order among the classes a free room of `room` cores may take
    const headOf = (p: number, room = Infinity): number => {
      const rs = ready[p]!
      let b = -1
      for (let k = 0; k < rs.length && k < room + 1 - 1e-9; k++) {
        const h = rs[k]!
        while (h.h.length > 0 && st[h.top()]! >= 0) h.pop()
        if (h.h.length > 0 && (b < 0 || before(h.top(), b))) b = h.top()
      }
      return b
    }
    const fin = new Float64Array(n)
    const st = new Float64Array(n).fill(-1)
    const rdy = new Float64Array(n)
    const on: (Slot | undefined)[] = Array.from({ length: n })
    const deps = new Int32Array(n)
    // ends: a min-heap of tasks by fin
    const endsH: number[] = []
    const epush = (i: number): void => {
      let k = endsH.push(i) - 1
      const f = fin[i]!
      while (k > 0) {
        const q = (k - 1) >> 1
        if (fin[endsH[q]!]! <= f) break
        endsH[k] = endsH[q]!
        k = q
      }
      endsH[k] = i
    }
    const epop = (): number => {
      const top = endsH[0]!
      const last = endsH.pop()!
      if (endsH.length > 0) {
        let k = 0
        const m = endsH.length
        const f = fin[last]!
        for (;;) {
          const l = 2 * k + 1
          if (l >= m) break
          const r = l + 1
          const c = r < m && fin[endsH[r]!]! < fin[endsH[l]!]! ? r : l
          if (fin[endsH[c]!]! >= f) break
          endsH[k] = endsH[c]!
          k = c
        }
        endsH[k] = last
      }
      return top
    }
    const runIx = new Int32Array(n)
    const busy = (s: Slot, x: number): void => {
      if (s.load > 1e-9) return
      // an idle gap costs at most a warm-up: past that the worker leaves and is asked again
      s.held += Math.min(Math.max(0, x - s.idleFrom), this.warm(s.size))
      s.worked = true
      s.busyFrom = x
    }
    const take = (i: number, s: Slot, x: number, d: number): void => {
      busy(s, x)
      if (s.resv === i) s.resv = -1
      s.load += cEst[i]!
      runIx[i] = s.run.push(i) - 1
      fin[i] = x + d
      on[i] = s
      st[i] = x
      if (x < s.first) s.first = x
      if (isFull(s)) openDel(s)
      epush(i)
    }
    let end = t
    let open = 0
    for (let i = 0; i < n; i++) {
      if (state[i] === DONE) {
        fin[i] = this.doneAt[i]!
        continue
      }
      open++
      for (let x = dOff[i]!; x < dOff[i + 1]!; x++) if (state[dArr[x]!] !== DONE) deps[i]!++
    }
    for (let i = 0; i < n; i++) {
      if (state[i] === DONE) continue
      if (state[i] === RUNNING && this.onWorker[i]! >= 0) {
        const w = this.workers[this.onWorker[i]!]!
        const s = slotOf.get(w)
        fin[i] = t + this.rem(i) * Math.max(1, this.loadEst(w) / w.cores)
        if (s !== undefined) {
          if (s.load <= 1e-9) {
            s.worked = true
            s.busyFrom = t
          }
          s.load += cEst[i]!
          runIx[i] = s.run.push(i) - 1
          on[i] = s
        }
        epush(i)
        continue
      }
      if (deps[i] === 0) {
        rdy[i] = t
        enqueue(i, t)
      }
    }
    const asks: [number, number][] = []
    const askFor: number[] = []
    const okOn = (i: number, s: Slot): boolean =>
      s.w === undefined || fits.on === undefined || fits.on(i, s.w.ix, false)
    // the soonest a slot has room for i from x on, walking the run's ends in time order: [slot, time, load then]
    const aux: number[] = []
    const touched: Slot[] = []
    const auxFin = (k: number): number => fin[endsH[aux[k]!]!]!
    const shadow = (i: number, x: number, from = x): [Slot | undefined, number, number] => {
      const p = plat[i]!
      const c = cEst[i]!
      let b: Slot | undefined
      let bS = Infinity
      let bL = 0
      if (from > x) {
        // room now that lasts: an open one fits it at its ready time too (nothing starts there unless it leaves room)
        const o = openL[p]!
        for (let k = 0; k < o.length; k++) {
          const s = o[k]!
          if (okOn(i, s) && fitsOn(s, s.load, c) && (b === undefined || s.load > bL)) {
            b = s
            bS = from
            bL = s.load
          }
        }
      }
      const pd = pend[p]!
      for (let k = 0; k < pd.length; k++) {
        const s = pd[k]!
        if (Math.max(s.joinAt, from) < bS && okOn(i, s) && fitsOn(s, s.load, c)) {
          b = s
          bS = Math.max(s.joinAt, from)
          bL = s.load
        }
      }
      aux.length = 0
      if (endsH.length > 0) aux.push(0)
      while (aux.length > 0) {
        // the next end in time order: a heap of the ends heap's places
        const q = aux[0]!
        const lastA = aux.pop()!
        if (aux.length > 0) {
          let k = 0
          const m = aux.length
          const f = fin[endsH[lastA]!]!
          for (;;) {
            const l = 2 * k + 1
            if (l >= m) break
            const r = l + 1
            const cc = r < m && auxFin(r) < auxFin(l) ? r : l
            if (auxFin(cc) >= f) break
            aux[k] = aux[cc]!
            k = cc
          }
          aux[k] = lastA
        }
        const j = endsH[q]!
        const at = fin[j]!
        if (at >= bS && at >= from) break
        for (let ch = 2 * q + 1; ch <= 2 * q + 2 && ch < endsH.length; ch++) {
          let k = aux.push(ch) - 1
          const f = fin[endsH[ch]!]!
          while (k > 0) {
            const u = (k - 1) >> 1
            if (auxFin(u) <= f) break
            aux[k] = aux[u]!
            k = u
          }
          aux[k] = ch
        }
        const s = on[j]
        if (s === undefined || s.plat !== p) continue
        if (s.fr === 0) touched.push(s)
        s.fr += cEst[j]!
        const L = s.load - s.fr
        if (at >= s.joinAt && fitsOn(s, L, c) && okOn(i, s)) {
          if (Math.max(at, from) < bS) {
            b = s
            bS = Math.max(at, from)
            bL = L
          }
          if (at >= from) break
        }
      }
      for (let k = 0; k < touched.length; k++) touched[k]!.fr = 0
      touched.length = 0
      return [b, bS, bL]
    }
    const lateOf = (i: number, F: number): number => {
      const e = E[i]!
      const sdi = this.sdOf(i)
      const pathV = sdi * sdi + Math.max(0, this.tv[i]! - sdi * sdi)
      return pathV > 0 || Dv > 0
        ? Math.max(0, clarkMean(F + tail[i]! - e, pathV, D, Dv) - D)
        : Math.max(0, F - (D - tail[i]! + e))
    }
    const hist = this.coresHist
    // its expected slowdown there: an unmeasured task's cores drawn from the known ones'
    const stretch = (i: number, s: Slot, c: number): number => {
      if (this.kms[i] != null || hist.length === 0 || this.unmeasured !== undefined)
        return Math.max(1, (s.load + c) / s.cores)
      let v = 0
      for (let k = 0; k < hist.length; k++)
        v += hist[k]![1] * Math.max(1, (s.load + hist[k]![0]) / s.cores)
      return v
    }
    // the busiest open slot with room for i now; on the waiting task's reservation only in its gap
    const bestOpen = (
      i: number,
      p: number,
      c: number,
      x: number,
      hs?: Slot,
      hS = Infinity,
      hLoad = 0,
      hc = 0,
    ): Slot | undefined => {
      let b: Slot | undefined
      const kept = this.planned[i]!
      let bLate = Infinity
      const o = openL[p]!
      for (let k = 0; k < o.length; k++) {
        const s = o[k]!
        if (!fitsOn(s, s.load, c) || !okOn(i, s)) continue
        // one history never measured: the slot it is expected to end least late on
        if (this.kms[i] == null) {
          const L = lateOf(i, x + E[i]! * stretch(i, s, c))
          if (b === undefined || L < bLate - 1e-6) {
            b = s
            bLate = L
            continue
          }
          if (L > bLate + 1e-6) continue
        }
        // the one busy longest, then the busiest, then the one the last plan had it on
        if (b !== undefined) {
          const us = untilOf(s)
          const ub = untilOf(b)
          if (
            !(
              us > ub + 1e-9 ||
              (us >= ub - 1e-9 &&
                (s.load > b.load + 1e-9 ||
                  (s.load >= b.load - 1e-9 && s.tag === kept && b.tag !== kept)))
            )
          )
            continue
        }
        if (s.resv >= 0 && s.resv !== i && !fitsOn(s, s.load + c, cEst[s.resv]!)) {
          // the task it was asked for: in a gap only if it ends before that can start
          const v = s.resv
          let r = 0
          for (let q = dOff[v]!; q < dOff[v + 1]!; q++) {
            const u = dArr[q]!
            r = Math.max(
              r,
              state[u] === DONE || st[u]! >= 0 || (state[u] === RUNNING && this.onWorker[u]! >= 0)
                ? fin[u]!
                : this.efs[u]!,
            )
          }
          if (x + E[i]! * Math.max(1, (s.load + c) / s.cores) > r + 1e-6) continue
        }
        if (
          s === hs &&
          x + E[i]! * Math.max(1, (s.load + c) / s.cores) > hS + 1e-6 &&
          !fitsOn(s, hLoad + c, hc)
        )
          continue
        b = s
      }
      return b
    }
    // the first waiting task of each platform and its reservation [slot, start, load then], weighed once
    const wHead = new Int32Array(P).fill(-1)
    const wSlot: (Slot | undefined)[] = Array.from({ length: P })
    const wS = new Float64Array(P)
    const wL = new Float64Array(P)
    // a task at its latest start with no room: a new worker, asked the slowest warm-up seen before it is needed
    // (one still waiting after a dispatch has no room now: what fits started in order of latest start)
    const due = (i: number, x: number): boolean => {
      const p = plat[i]!
      const c = cEst[i]!
      const e = E[i]!
      if (!askable(p)) return false
      const [hs, hS, hL] = shadow(i, x)
      const F = hs === undefined ? Infinity : hS + e * Math.max(1, (hL + c) / hs.cores)
      const lt = lateOf(i, F)
      const r = rdy[i]!
      if (!(lt > 1e-6)) return false
      const sdi = this.sdOf(i)
      const varl = sdi * sdi + Math.max(0, this.tv[i]! - sdi * sdi) > 0
      const lf = D - tail[i]! + e
      let bz = -1
      let zF = Infinity
      let zC = Infinity
      let zA = 0
      for (let z = 0; z < this.sizes.length; z++) {
        if (this.sizePlat[z] !== p || count[z]! >= this.sizes[z]!.max) continue
        if (fits.size !== undefined && !fits.size(i, z)) continue
        const ez = e * Math.max(1, c / this.sizes[z]!.cores)
        const need = varl ? r : Math.max(r, lf - ez)
        const a = Math.max(t, need - this.lead(z))
        const Fz = Math.max(x, q.at(z, a)) + ez
        const cc = this.sizes[z]!.cores * (this.warm(z) + ez)
        if (Fz < zF - 1e-6 || (Fz <= zF + 1e-6 && cc < zC)) {
          bz = z
          zF = Fz
          zC = cc
          zA = a
        }
      }
      const lz = lateOf(i, zF)
      if (bz < 0 || !(lz < lt - 1e-6)) return false
      const zJ = q.join(bz, zA)
      const s2 = mk(p, bz, this.sizes[bz]!.cores, zJ, zA, -1e6 - asks.length)
      asks.push([bz, zA])
      askFor.push(i)
      if (s2.joinAt <= x + 1e-9) {
        const pd = pend[p]!
        const k = pd.indexOf(s2)
        if (k >= 0) pd.splice(k, 1)
        openAdd(s2)
        take(i, s2, x, e * Math.max(1, c / s2.cores))
        if (wHead[p] === i) wHead[p] = -1
      } else {
        s2.resv = i
        if (wHead[p] === i) wHead[p] = -1
      }
      return true
    }
    const dispatch = (p: number, x: number): void => {
      const rs = ready[p]!
      for (;;) {
        const i = headOf(p)
        if (i < 0) return
        const c = cEst[i]!
        const s = bestOpen(i, p, c, x)
        if (s !== undefined) {
          rs[classOf(i)]!.pop()
          take(i, s, x, E[i]! * Math.max(1, (s.load + c) / s.cores))
          if (wHead[p] === i) wHead[p] = -1
          continue
        }
        if (wHead[p] !== i) {
          wHead[p] = i
          const [hs, hS, hL] = shadow(i, x)
          wSlot[p] = hs
          wS[p] = hS
          wL[p] = hL
        }
        // the rest start in gaps that leave the first waiting task its reservation
        const o = openL[p]!
        if (o.length === 0) return
        const hk = classOf(i)
        rs[hk]!.pop()
        const hs = wSlot[p]
        const hS = wS[p]!
        const tried = triedBuf
        tried.fill(0, 0, rs.length)
        for (;;) {
          let room = 0
          for (let k = 0; k < o.length; k++)
            if (o[k]!.cores - o[k]!.load > room) room = o[k]!.cores - o[k]!.load
          let j = -1
          let kj = -1
          for (let k = 0; k < rs.length && k < room + 1 - 1e-9; k++) {
            if (tried[k] === 1) continue
            const h = rs[k]!
            while (h.h.length > 0 && st[h.top()]! >= 0) h.pop()
            if (h.h.length > 0 && (j < 0 || before(h.top(), j))) {
              j = h.top()
              kj = k
            }
          }
          if (j < 0) break
          const cj = cEst[j]!
          let sj = bestOpen(j, p, cj, x, hs, hS, wL[p]!, c)
          if (sj === undefined) {
            // too long for the gap: the shortest of its class, else none of it fits now
            const q = shortOf(p, kj)
            while (q.h.length > 0 && st[q.top()]! >= 0) q.pop()
            const m = q.h.length > 0 ? q.top() : -1
            if (m >= 0 && m !== j) sj = bestOpen(m, p, cEst[m]!, x, hs, hS, wL[p]!, c)
            if (sj === undefined) {
              tried[kj] = 1
              continue
            }
            j = m
          }
          const cm = cEst[j]!
          const d = E[j]! * Math.max(1, (sj.load + cm) / sj.cores)
          if (sj === hs && x + d > hS + 1e-6) wL[p]! += cm
          take(j, sj, x, d)
          if (o.length === 0) break
        }
        rs[hk]!.push(i)
        return
      }
    }
    for (const s of slots) if (s.joinAt <= t && !isFull(s)) openAdd(s)
    for (let p = 0; p < P; p++) dispatch(p, t)
    const dirty = new Uint8Array(P)
    while (dlH.h.length > 0 && dlT[dlH.top()]! <= t) {
      const i = dlH.pop()
      if (st[i]! < 0 && due(i, t)) dirty[plat[i]!] = 1
    }
    for (;;) {
      const te = endsH.length > 0 ? fin[endsH[0]!]! : Infinity
      const tj = joinsH.length > 0 ? joinsH[0]![0] : Infinity
      const td = dlH.h.length > 0 ? dlT[dlH.top()]! : Infinity
      const x = Math.min(te, tj, td)
      if (x === Infinity) break
      while (endsH.length > 0 && fin[endsH[0]!]! <= x) {
        const i = epop()
        if (fin[i]! > end) end = fin[i]!
        open--
        const s = on[i]
        if (s !== undefined) {
          const k = runIx[i]!
          const last = s.run.pop()!
          if (last !== i) {
            s.run[k] = last
            runIx[last] = k
          }
          s.load -= cEst[i]!
          if (s.load <= 1e-9) {
            s.load = 0
            s.held += x - s.busyFrom
            s.idleFrom = x
          }
          if (x >= s.joinAt && !isFull(s)) openAdd(s)
          dirty[s.plat] = 1
        }
        for (let q = kOff[i]!; q < kOff[i + 1]!; q++) {
          const k = kArr[q]!
          deps[k] = deps[k]! - 1
          if (deps[k] === 0 && state[k] !== DONE) {
            rdy[k] = x
            enqueue(k, x)
            dirty[plat[k]!] = 1
          }
        }
      }
      while (joinsH.length > 0 && joinsH[0]![0] <= x) {
        const s = slots[pop(joinsH)[1]]!
        const pd = pend[s.plat]!
        const k = pd.indexOf(s)
        if (k >= 0) pd.splice(k, 1)
        if (!isFull(s)) openAdd(s)
        dirty[s.plat] = 1
        // a worker joining may run the first waiting task sooner than its reservation
        wHead[s.plat] = -1
      }
      for (let p = 0; p < P; p++)
        if (dirty[p] === 1) {
          dirty[p] = 0
          dispatch(p, x)
        }
      while (dlH.h.length > 0 && dlT[dlH.top()]! <= x) {
        const i = dlH.pop()
        if (st[i]! < 0 && due(i, x)) dirty[plat[i]!] = 1
      }
      for (let p = 0; p < P; p++)
        if (dirty[p] === 1) {
          dirty[p] = 0
          dispatch(p, x)
        }
    }
    let unplaced = 0
    for (let p = 0; p < P; p++)
      for (const h of ready[p]!) for (const i of h.h) if (st[i]! < 0) unplaced++
    const start: [number, number][] = []
    for (let i = 0; i < n; i++)
      if (state[i] === READY && st[i]! >= 0 && st[i]! <= t + 1e-6) {
        const s = on[i]!
        if (
          s.w !== undefined &&
          s.w.joinedAt !== undefined &&
          (fits.on === undefined || fits.on(i, s.w.ix, true))
        )
          start.push([i, s.w.ix])
      }
    let held = 0
    for (const s of slots) {
      if (!s.worked) {
        held += s.w === undefined || s.w.joinedAt === undefined ? (s.joinAt - s.from) * s.cores : 0
        continue
      }
      held += (s.held + (s.joinAt > s.from ? s.joinAt - s.from : 0)) * s.cores
    }
    const next = new Map<Worker, number>()
    for (const s of slots) if (s.w !== undefined) next.set(s.w, s.first)
    const tags = new Float64Array(n).fill(NaN)
    let nextStart = Infinity
    for (let i = 0; i < n; i++) {
      const s = on[i]
      if (s === undefined || state[i] === DONE || (state[i] === RUNNING && this.onWorker[i]! >= 0))
        continue
      tags[i] = s.tag
      if (st[i]! > t + 1e-6 && st[i]! < nextStart && s.w?.joinedAt !== undefined) nextStart = st[i]!
    }
    return {
      asks,
      askFor,
      start,
      next,
      end: unplaced > 0 || open > 0 ? Infinity : end,
      held,
      tags,
      nextStart,
    }
  }

  /** What to do now, at `t`: it takes effect in the engine as it returns. */
  decide(t: number, fits: Fits = {}): Decision {
    this.advance(t)
    // what waits for a worker not yet joined is decided again: another may take it sooner
    for (const w of this.workers)
      if (w.joinedAt === undefined && w.leftAt === undefined && w.reserved.length > 0) {
        for (const i of w.reserved) {
          this.state[i] = READY
          this.onWorker[i] = -1
        }
        w.reserved = []
      }
    const { D, Dv } = this.forecast()
    const { n, state, S2, sizePlat, plat } = this
    const start: [number, number][] = []
    const asked: [number, number][] = []
    const leave: number[] = []
    let nextAsk = Infinity
    let keepUntil = Infinity
    let open = 0
    for (let i = 0; i < n; i++) if (state[i] !== DONE) open++
    // a large graph is planned forward, once a decide: an insertion plan checks each task against every
    // worker's room over time, which past BIG open tasks passes half a second
    const big = open > BIG
    let soon = false
    const P = (extra: readonly number[] = [], eager = false): Plan =>
      big ? this.plan4(t, D, fits, Dv) : this.plan3(t, D, fits, extra, eager, soon, Dv)
    const better = (o: Plan, b: Plan): boolean =>
      o.end < b.end - 1e-6 || (o.end <= b.end + 1e-6 && o.held < b.held - 1e-6)
    const best = (): { p: Plan; extra: number[] } => {
      let p = P()
      const extra = Array.from({ length: this.sizes.length }, () => 0)
      if (big) return { p, extra }
      // one more worker asked now while that ends the run sooner, or as soon and holds less
      const cnt = Array.from({ length: this.sizes.length }, () => 0)
      for (const w of this.live()) cnt[w.size]!++
      for (;;) {
        let bz = -1
        let bp: Plan | undefined
        for (let z = 0; z < this.sizes.length; z++) {
          if (cnt[z]! + extra[z]! >= this.sizes[z]!.max) continue
          extra[z]!++
          const r = P(extra)
          extra[z]!--
          if (better(r, bp ?? p)) {
            bz = z
            bp = r
          }
        }
        if (bz < 0) break
        extra[bz]!++
        p = bp!
      }
      if (p.end > D + 1e-6 && extra.every((x) => x === 0)) {
        // late even so: a worker asked as soon as a task waits for room, if that ends the run sooner
        const e = P([], true)
        if (e.end < p.end - 1e-6) p = e
      }
      return { p, extra }
    }
    let r = best()
    // with restarts, an idle worker's leaving is judged plain against plain: a restart's plan is the least of
    // many draws, so a plan without the worker would never pass it
    let plain: Plan | undefined
    // restarts judge a draw by its mean outcome: sound only while every duration left is a fact
    let certain = !big
    for (let i = 0; i < n && certain; i++)
      if (state[i] !== DONE && (S2[i]! > 0 || this.kms[i] == null)) certain = false
    if (certain) {
      plain = r.p
      // the order kept from the decide before, then the draws: the best order found carries across decides
      if (this.kept !== undefined) {
        const o = this.plan3(t, D, fits, r.extra, false, soon, Dv, this.kept)
        if (better(o, r.p)) r = { p: o, extra: r.extra }
        else this.kept = undefined
      }
      // each task's start drawn a way into its slack; the draw that ends soonest, then holds least, is kept
      const tries = Math.min(RESTARTS, Math.floor(RESTART_BUDGET / Math.max(1, open)))
      // the same draws each decide: a plan moves with the run, not with a generator's state
      let seed = 1
      const rnd = (): number => (seed = (seed * 48271) % 2147483647) / 2147483647
      const u = new Float64Array(n)
      for (let k = 0; k < tries; k++) {
        for (let i = 0; i < n; i++) u[i] = rnd()
        const key = this.drawKeys(u, D)
        const o = this.plan3(t, D, fits, r.extra, false, soon, Dv, key)
        if (better(o, r.p)) {
          r = { p: o, extra: r.extra }
          this.kept = key
        }
      }
    } else this.kept = undefined
    if (!big) {
      // the same with each task at its soonest end: whichever holds less
      soon = true
      const r2 = best()
      if (better(r2.p, r.p)) r = r2
      else soon = false
    }
    // idle workers: one leaves when the run without it ends no later and holds no more, unless it holds what a
    // task to come reads, or the run cannot ask for its size while its platform has work left
    const openOn = new Int32Array(this.platforms)
    for (let i = 0; i < n; i++) if (state[i] !== DONE) openOn[plat[i]!]!++
    const busy = new Set(r.p.start.map((x) => x[1]))
    let gone = false
    // no task's time known yet, measured or ended: the forecast has nothing to let a worker go by
    const blind = this.knownN + this.finishedN === 0
    // every task done: the run ends and stops its joined workers itself
    const ended = openOn.every((x) => x === 0)
    for (const w of this.live())
      if (
        !(ended && w.joinedAt !== undefined) &&
        w.run.size === 0 &&
        w.reserved.length === 0 &&
        !busy.has(w.ix) &&
        fits.stay?.(w.ix) !== true &&
        !(this.sizes[w.size]!.max <= 0 && openOn[sizePlat[w.size]!]! > 0)
      ) {
        const nx = r.p.next.get(w) ?? Infinity
        // one asked and not joined goes once its platform has no task left: before, only estimates say it is
        // not needed, and a sim of CI-shaped runs ended 11 s later cancelling on them; a joined one, not blind
        const left = openOn[sizePlat[w.size]!]!
        if (w.joinedAt === undefined ? left > 0 : blind && left > 0) continue
        w.leftAt = t
        if (nx === Infinity) {
          leave.push(w.ix)
          gone = true
          continue
        }
        const r2 = best()
        const ref = plain ?? r.p
        if (r2.p.end <= ref.end + 1e-6 && r2.p.held <= ref.held + 1e-6) {
          leave.push(w.ix)
          r = r2
          plain = r2.p
        } else {
          delete w.leftAt
          keepUntil = Math.min(keepUntil, nx)
        }
      }
    if (gone) r = best()
    const p = r.p
    const tagIx = new Map<number, number>()
    let xk = 0
    for (let z = 0; z < r.extra.length; z++)
      for (let k = 0; k < r.extra[z]!; k++) {
        const f = p.firstX?.[xk] ?? t
        // one the plan first gives work later than a warm-up from now is asked then
        if (f > t + this.lead(z) + 1e-6) {
          if (f < Infinity) nextAsk = Math.min(nextAsk, f - this.lead(z))
          xk++
          continue
        }
        tagIx.set(-1 - xk++, this.ask(z))
        asked.push([this.workers.length - 1, z])
      }
    for (const [i, w] of p.start) {
      if (fits.admit !== undefined && !fits.admit(i, w)) continue
      const x = this.workers[w]!
      state[i] = RUNNING
      this.onWorker[i] = w
      this.progress[i] = 0
      this.startedAt[i] = t
      x.run.add(i)
      start.push([i, w])
    }
    p.asks.forEach(([z, at], k) => {
      if (at <= t + 1e-6) {
        const wi = this.ask(z)
        // a worker the forward plan asks for a task keeps room for it until it starts
        const f = p.askFor?.[k]
        if (f !== undefined) this.workers[wi]!.for = f
        tagIx.set(-1e6 - k, wi)
        asked.push([wi, z])
      } else nextAsk = Math.min(nextAsk, at)
    })
    // a task the forward plan starts later, with nothing else happening by then, starts at its time
    if (big) nextAsk = Math.min(nextAsk, p.nextStart ?? Infinity)
    const tags = p.tags
    if (tags !== undefined)
      for (let i = 0; i < n; i++) {
        const g = tags[i]!
        this.planned[i] = Number.isNaN(g) ? -1 : g >= 0 ? g : (tagIx.get(g) ?? -1)
      }
    const due = Math.min(
      nextAsk > t + 1e-6 ? nextAsk : Infinity,
      keepUntil > t + 1e-6 ? keepUntil : Infinity,
    )
    return { start, ask: asked, leave, due }
  }
}
