// One model for a distributed run (docs/design/dte-planner-2026-11.md): what is
// learned, one forecast, one objective, one rule for every choice. Pure: the
// caller tells it what happened (a task ready, started, ended; a worker joined)
// and asks it what to do now; it reads no clock.
//
// The machine: a worker's tasks share its cores; past its cores each runs at
// cores / Σ cores. The forecast: each task's time is history's mean, scaled by
// how this run's finished tasks compared to history, with history's spread;
// a running task's rest is the lognormal residual of what it has run. The
// objective, in M's order (2026-11-18): the run's end, then the core-time
// workers are held (warm-ups included), then fewer workers, then each task
// sooner. Each ready task takes the choice (run on a worker with an idle core,
// wait for a worker's room, or a new worker) that leaves the run's expected
// lateness least past the end facts allow, then its own, then holds the
// fewest core-ms; a new worker's warm-up is wall it must save. Nothing here
// is a tuned number.

/** A kind of worker the run may ask for. */
export interface EngineSize {
  readonly cores: number
  /** How many may run at once. */
  readonly max: number
  /** Its platform, as tasks name theirs. */
  readonly platform: string
  /** Its warm-up as history knew it (ms); this run's joins replace it. */
  readonly warmUpMs: number
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
const clarkMean = (a: number, va: number, b: number, vb: number): number => {
  const th = Math.sqrt(va + vb)
  if (th === 0) return Math.max(a, b)
  const al = (a - b) / th
  return a * Phi(al) + b * Phi(-al) + th * phi(al)
}

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
}

/** A worker's room over time as a list schedule: tasks that chose to wait start in that order. */
interface Room {
  at: number
  free: number
  /** Min-heap of [end, cores]. */
  readonly ends: [number, number][]
  until: number
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
  private cvPool = 0
  private knownSpread = 0
  /** A task's cores while history knows none of it: the run's own prior, else history's mean. */
  private readonly unmeasured: number | undefined
  /** Tasks wait for `ready` (the caller hands each over), not only for their upstreams. */
  private readonly gated: boolean

  private readonly state: Uint8Array
  private readonly left: Int32Array
  private readonly progress: Float64Array
  private readonly startedAt: Float64Array
  private readonly doneAt: Float64Array
  private readonly ranMs: Float64Array
  private readonly onWorker: Int32Array
  readonly workers: Worker[] = []
  private readonly joins: number[][]
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

  // the forecast, per task
  private readonly E: Float64Array
  private readonly S2: Float64Array
  private readonly tail: Float64Array
  private readonly tv: Float64Array
  private readonly tail0: Float64Array
  private readonly ef: Float64Array
  private readonly ev: Float64Array
  private readonly ef0: Float64Array
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
      let qn = 0
      let on = 0
      for (let i = 0; i < n; i++) if (ind[i] === 0) q[qn++] = i
      while (qn > 0) {
        const i = q[--qn]!
        this.order[on++] = i
        for (let x = kOff[i]!; x < kOff[i + 1]!; x++) if (--ind[kArr[x]!]! === 0) q[qn++] = kArr[x]!
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
    this.doneAt = new Float64Array(n)
    this.ranMs = new Float64Array(n)
    this.onWorker = new Int32Array(n).fill(-1)
    this.joins = sizes.map(() => [])
    this.firstRun = new Float64Array(this.platforms)

    this.E = new Float64Array(n)
    this.S2 = new Float64Array(n)
    this.tail = new Float64Array(n)
    this.tv = new Float64Array(n)
    this.tail0 = new Float64Array(n)
    this.ef = new Float64Array(n)
    this.ev = new Float64Array(n)
    this.ef0 = new Float64Array(n)
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
    this.meanKnown = kn > 0 ? km / kn : 0
    this.cvPool = cvn > 0 ? cv / cvn : 0
    let ss = 0
    for (let i = 0; i < n; i++) {
      const k = kms[i]
      if (k !== null && k !== undefined) ss += (k - this.meanKnown) ** 2
    }
    this.knownSpread = kn > 1 ? Math.sqrt(ss / (kn - 1)) : 0
    for (let i = 0; i < n; i++) this.cEst[i] = kms[i] === null ? meanCores : kcores[i]!
  }

  /** History landed (or changed): what it knows of each task. */
  learn(ms: readonly (number | null)[], sd: readonly (number | null)[], cores: readonly number[]): void {
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
      if (--this.left[k2]! === 0 && !this.gated && this.state[k2] === BLOCKED) this.state[k2] = READY
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
    this.finishedSum += took
    this.finishedSq += took * took
    this.finishedN++
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
    return this.finishedN > 0 ? this.finishedSum / this.finishedN : this.meanKnown * this.speed()
  }
  private sdOf(i: number): number {
    const k = this.kms[i]
    const sd = this.ksd[i]
    if (k !== null && k !== undefined)
      return (sd !== null && sd !== undefined ? sd : this.cv() * k) * this.speed()
    if (this.finishedN > 1)
      return Math.sqrt(
        Math.max(
          0,
          (this.finishedSq - (this.finishedSum * this.finishedSum) / this.finishedN) /
            (this.finishedN - 1),
        ),
      )
    return this.knownSpread * this.speed()
  }
  /** A size's warm-up: the mean of this run's joins, else history's. */
  private warm(z: number): number {
    const j = this.joins[z]!
    return j.length > 0 ? j.reduce((a, b) => a + b, 0) / j.length : this.sizes[z]!.warmUpMs
  }
  /** The wall a new worker of size `z` must save to be asked: its warm-up (M, 2026-11-18 18:51). */
  private price(z: number): number {
    return this.warm(z)
  }
  /** When a worker joins: when it did, else when its size's warm-up says. */
  private joinAt(w: Worker): number {
    return w.joinedAt ?? Math.max(this.t, w.askedAt + this.warm(w.size))
  }
  private loadEst(w: Worker, extra = 0): number {
    let s = extra
    for (const j of w.run) s += this.cEst[j]!
    for (const j of w.reserved) s += this.cEst[j]!
    return s
  }
  /** Its expected rest: the lognormal with its mean and spread, given it ran this long. */
  private rem(j: number): number {
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
  private forecast(): { D: number; D0: number; Dv: number } {
    const { n, order, dOff, dArr, kOff, kArr, E, S2, tail, tv, tail0, ef, ev, ef0, efs, state } =
      this
    const t = this.t
    for (let i = 0; i < n; i++)
      if (state[i] !== DONE) {
        E[i] = this.est(i)
        S2[i] = this.sdOf(i) ** 2
      }
    for (let x = n - 1; x >= 0; x--) {
      const i = order[x]!
      if (state[i] === DONE) continue
      let m = 0
      let v = 0
      let m0 = 0
      for (let q = kOff[i]!; q < kOff[i + 1]!; q++) {
        const k = kArr[q]!
        // the longest chain after it carries its spread
        if (tail[k]! > m) {
          m = tail[k]!
          v = tv[k]!
        }
        if (tail0[k]! > m0) m0 = tail0[k]!
      }
      tail[i] = E[i]! + m
      tv[i] = S2[i]! + v
      tail0[i] = E[i]! + m0
    }
    const { avail, firstRun, sizePlat } = this
    avail.fill(Infinity)
    for (let z = 0; z < this.sizes.length; z++)
      if (this.sizes[z]!.max > 0) avail[sizePlat[z]!] = Math.min(avail[sizePlat[z]!]!, t + this.warm(z))
    for (const w of this.live())
      avail[sizePlat[w.size]!] = Math.min(avail[sizePlat[w.size]!]!, this.joinAt(w))
    let first = Infinity
    for (let q = 0; q < this.platforms; q++) {
      // a fact replaces the forecast: the first join once it happened, else no sooner than now
      let j = Infinity
      for (const w of this.workers)
        if (sizePlat[w.size] === q && w.joinedAt !== undefined) j = Math.min(j, w.joinedAt)
      firstRun[q] = j < Infinity ? j : Math.max(firstRun[q] || avail[q]!, t)
      first = Math.min(first, avail[q]!)
    }
    let D0 = first
    let D = 0
    let Dv = 0
    for (const i of order) {
      if (state[i] === DONE) {
        ef[i] = ef0[i] = this.doneAt[i]!
        ev[i] = 0
      } else if (state[i] === RUNNING && this.progress[i]! > 0) {
        const w = this.workers[this.onWorker[i]!]!
        const st = Math.max(1, this.loadEst(w) / w.cores)
        ef[i] = ef0[i] = t + this.rem(i) * st
        ev[i] = S2[i]! * st * st
      } else {
        const base = avail[this.plat[i]!]!
        let m = base
        let v = 0
        let m0 = base
        for (let q = dOff[i]!; q < dOff[i + 1]!; q++) {
          const d = dArr[q]!
          if (ef[d]! > m) {
            m = ef[d]!
            v = ev[d]!
          }
          if (ef0[d]! > m0) m0 = ef0[d]!
        }
        ef[i] = m + E[i]!
        ev[i] = v + S2[i]!
        ef0[i] = m0 + E[i]!
      }
      if (ef0[i]! > D0) D0 = ef0[i]!
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
    return { D, D0, Dv }
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
    const { D, D0, Dv } = this.forecast()
    const { n, state, tail, tv, E, S2, cEst, sizePlat, plat } = this
    const start: [number, number][] = []
    const asked: [number, number][] = []
    const leave: number[] = []
    // how far a finish (mean, variance) is expected to push the run's end past D
    const lateOf = (i: number, f: number, v: number): number => {
      const sd = this.sdOf(i)
      // how much it moves the run's expected end: E[max(its path, the run's end)] − E[the run's end]
      return clarkMean(f + tail[i]! - this.est(i), v + Math.max(0, tv[i]! - sd * sd), D, Dv) - D
    }
    const ready: number[] = []
    for (let i = 0; i < n; i++) if (state[i] === READY) ready.push(i)
    // most at risk of ending the run late first, then the longest chain
    const key = new Float64Array(n)
    for (const i of ready) key[i] = lateOf(i, t + E[i]!, S2[i]!)
    ready.sort((a, b) => key[b]! - key[a]! || tail[b]! - tail[a]!)

    const rooms = new Map<Worker, Room>()
    const roomOf = (w: Worker): Room => {
      let p = rooms.get(w)
      if (p === undefined) {
        const s0 = Math.max(1, this.loadEst(w) / w.cores)
        const at = Math.max(t, this.joinAt(w))
        p = { at, free: w.cores - this.loadEst(w), ends: [], until: at }
        for (const j of w.run) push(p.ends, [t + this.rem(j) * s0, cEst[j]!])
        for (const j of w.reserved) push(p.ends, [this.joinAt(w) + this.est(j), cEst[j]!])
        for (const q of p.ends) p.until = Math.max(p.until, q[0])
        rooms.set(w, p)
      }
      return p
    }
    // when a task of c cores would start there, and (commit) take that room
    const fit = (w: Worker, c: number, e: number, commit: boolean): number => {
      const p = roomOf(w)
      const need = Math.min(c, w.cores)
      const taken: [number, number][] = []
      let free = p.free
      let at = p.at
      while (free < need - 1e-9 && p.ends.length > 0) {
        const q = pop(p.ends)
        taken.push(q)
        free += q[1]
        at = Math.max(at, q[0])
      }
      if (free < need - 1e-9) {
        for (const q of taken) push(p.ends, q)
        return Infinity
      }
      if (commit) {
        p.at = at
        p.free = free - c
        push(p.ends, [at + e, c])
        p.until = Math.max(p.until, at + e)
      } else for (const q of taken) push(p.ends, q)
      return at
    }
    const busyUntil = (w: Worker): number => {
      const p = roomOf(w)
      return Math.max(p.until, p.at)
    }
    // the expected lateness of what runs on a worker, at a stretch
    const lateAt = (w: Worker, s: number): number => {
      let late = 0
      for (const j of w.run) late = Math.max(late, lateOf(j, t + this.rem(j) * s, (this.sdOf(j) * s) ** 2))
      return late
    }
    const lateNow = new Map<Worker, number>()
    const lateNowOf = (w: Worker): number => {
      let l = lateNow.get(w)
      if (l === undefined) lateNow.set(w, (l = lateAt(w, Math.max(1, this.loadEst(w) / w.cores))))
      return l
    }
    const liveNow = this.live()
    const joined = (w: Worker): boolean => w.joinedAt !== undefined
    // workers by the soonest moment any room frees on them
    const keyOf = (w: Worker): number => {
      const p = roomOf(w)
      return p.free > 1e-9 ? p.at : p.ends.length > 0 ? Math.max(p.at, p.ends[0]![0]) : Infinity
    }
    const wq: [number, Worker][] = []
    const pushW = (x: [number, Worker]): void => {
      wq.push(x)
      let k = wq.length - 1
      while (k > 0) {
        const q = (k - 1) >> 1
        if (wq[q]![0] <= wq[k]![0]) break
        ;[wq[q], wq[k]] = [wq[k]!, wq[q]!]
        k = q
      }
    }
    for (const w of liveNow) pushW([keyOf(w), w])
    interface Option {
      kind: 'on' | 'wait' | 'new'
      w?: Worker
      z?: number
      late: number
      own: number
      cost: number
      fin: number
    }
    const tol = 1e-6
    const better = (o: Option, b: Option | undefined): boolean => {
      if (b === undefined) return true
      if (o.late < b.late - tol) return true
      if (o.late > b.late + tol) return false
      if (o.own < b.own - tol) return true
      if (o.own > b.own + tol) return false
      if (o.cost < b.cost - tol) return true
      if (o.cost > b.cost + tol) return false
      const on = o.kind === 'new' ? 1 : 0
      const bn = b.kind === 'new' ? 1 : 0
      if (on !== bn) return on < bn
      return o.fin < b.fin
    }
    for (const i of ready) {
      const e = this.est(i)
      const sdi = this.sdOf(i)
      // the run's lateness no choice for this task changes: what already runs late somewhere
      let base = 0
      for (const w of liveNow) if (joined(w)) base = Math.max(base, lateNowOf(w))
      let best: Option | undefined
      for (const w of liveNow) {
        // a full worker takes nothing more: sharing fills its idle cores, never queues on busy ones
        if (sizePlat[w.size] !== plat[i] || !joined(w) || this.loadEst(w) >= w.cores - 1e-9) continue
        if (fits.on !== undefined && !fits.on(i, w.ix, true)) continue
        const s = Math.max(1, this.loadEst(w, cEst[i]!) / w.cores)
        const s0 = Math.max(1, this.loadEst(w) / w.cores)
        const fin = t + e * s
        const own = lateOf(i, fin, (sdi * s) ** 2)
        const stretched = s === s0 ? 0 : lateAt(w, s)
        // stretching what runs there holds the worker longer too
        let until = fin
        if (s > s0) for (const j of w.run) until = Math.max(until, t + this.rem(j) * s)
        const o: Option = {
          kind: 'on',
          w,
          late: Math.max(base, own, stretched),
          own: own + Math.max(0, stretched - lateNowOf(w)),
          cost: w.cores * Math.max(0, until - busyUntil(w)),
          fin,
        }
        if (better(o, best)) best = o
      }
      // waiting: workers in the order room frees on them; the first that fits then is the soonest
      {
        let bestX = Infinity
        const stash: [number, Worker][] = []
        while (wq.length > 0 && wq[0]![0] < bestX) {
          const [k, w] = pop(wq)
          if (k !== keyOf(w)) continue // stale
          stash.push([k, w])
          if (sizePlat[w.size] !== plat[i]) continue
          if (fits.on !== undefined && !fits.on(i, w.ix, false)) continue
          const x = fit(w, cEst[i]!, e, false)
          if (x === Infinity || (joined(w) && x <= t)) continue
          const own = lateOf(i, x + e, sdi * sdi)
          const o: Option = {
            kind: 'wait',
            w,
            late: Math.max(base, own),
            own,
            cost: w.cores * Math.max(0, x + e - busyUntil(w)),
            fin: x + e,
          }
          if (better(o, best)) best = o
          if (x < bestX) bestX = x
        }
        for (const q of stash) pushW(q)
      }
      for (let z = 0; z < this.sizes.length; z++) {
        if (sizePlat[z] !== plat[i] || (fits.size !== undefined && !fits.size(i, z))) continue
        let count = 0
        for (const w of liveNow) if (w.size === z) count++
        if (count >= this.sizes[z]!.max) continue
        // a new worker's warm-up is compute spent idle: priced as the wall time it must save
        const W = this.warm(z)
        const cz = this.sizes[z]!.cores
        const ez = e * Math.max(1, cEst[i]! / cz)
        const own = lateOf(i, t + W + ez, sdi * sdi) + this.price(z)
        const o: Option = { kind: 'new', z, late: Math.max(base, own), own, cost: cz * (W + ez), fin: t + W + ez }
        if (better(o, best)) best = o
      }
      if (best === undefined) continue
      if (best.kind === 'wait') {
        fit(best.w!, cEst[i]!, e, true)
        pushW([keyOf(best.w!), best.w!])
      } else if (best.kind === 'on') {
        const w = best.w!
        state[i] = RUNNING
        this.onWorker[i] = w.ix
        this.progress[i] = 0
        this.startedAt[i] = t
        w.run.add(i)
        lateNow.delete(w)
        const p = roomOf(w)
        p.free -= cEst[i]!
        push(p.ends, [best.fin, cEst[i]!])
        p.until = Math.max(p.until, best.fin)
        pushW([keyOf(w), w])
        start.push([i, this.onWorker[i]!])
      } else {
        const wi = this.ask(best.z!)
        const w = this.workers[wi]!
        w.reserved.push(i)
        state[i] = RUNNING
        this.onWorker[i] = wi
        liveNow.push(w)
        pushW([keyOf(w), w])
        asked.push([wi, best.z!])
      }
    }

    // soon tasks: ask a worker the latest moment a new one still ends them in time
    let nextAsk = Infinity
    const warmMin = new Float64Array(this.platforms).fill(Infinity)
    for (let z = 0; z < this.sizes.length; z++)
      if (this.sizes[z]!.max > 0) warmMin[sizePlat[z]!] = Math.min(warmMin[sizePlat[z]!]!, this.warm(z))
    const soon: number[] = []
    for (let i = 0; i < n; i++) {
      if (state[i] !== BLOCKED) continue
      let ok = true
      for (let x = this.dOff[i]!; x < this.dOff[i + 1]!; x++)
        if (state[this.dArr[x]!]! === BLOCKED) {
          ok = false
          break
        }
      if (ok) soon.push(i)
    }
    soon.sort((a, b) => tail[b]! - tail[a]!)
    const promised = new Map<Worker, number>()
    const demandOn = new Map<Worker, number>()
    for (const i of soon) {
      let r = t
      for (let x = this.dOff[i]!; x < this.dOff[i + 1]!; x++) r = Math.max(r, this.ef[this.dArr[x]!]!)
      const e = this.est(i)
      const lf = D0 - (this.tail0[i]! - e)
      let room = false
      for (const w of this.live()) {
        if (sizePlat[w.size] !== plat[i]) continue
        const s = Math.max(1, this.loadEst(w) / w.cores)
        let free = w.cores - (promised.get(w) ?? 0)
        for (const j of w.run) if (t + this.rem(j) * s > r) free -= cEst[j]!
        for (const j of w.reserved) free -= cEst[j]!
        // in time, or no later than a worker asked now
        if (
          free >= cEst[i]! - 1e-9 &&
          Math.max(r, this.joinAt(w)) + e <= Math.max(lf, r + e, t + warmMin[plat[i]!]! + e) + 1e-6
        ) {
          promised.set(w, (promised.get(w) ?? 0) + cEst[i]!)
          demandOn.set(w, Math.min(demandOn.get(w) ?? Infinity, r))
          room = true
          break
        }
      }
      if (room) continue
      // the size to ask: the one that ends it least late, then holds the fewest core-ms
      let bz = -1
      let bl = Infinity
      let bc = Infinity
      for (let z = 0; z < this.sizes.length; z++) {
        if (sizePlat[z] !== plat[i] || (fits.size !== undefined && !fits.size(i, z))) continue
        let count = 0
        for (const w of this.live()) if (w.size === z) count++
        if (count >= this.sizes[z]!.max) continue
        const ez = e * Math.max(1, cEst[i]! / this.sizes[z]!.cores)
        const l = Math.max(0, t + this.warm(z) + ez - Math.max(lf, r + ez))
        const c = this.sizes[z]!.cores * (this.warm(z) + ez)
        if (l < bl - 1e-6 || (Math.abs(l - bl) <= 1e-6 && c < bc)) {
          bz = z
          bl = l
          bc = c
        }
      }
      if (bz < 0) continue
      const latestAsk = lf - e * Math.max(1, cEst[i]! / this.sizes[bz]!.cores) - this.warm(bz)
      if (latestAsk <= t + 1e-6) {
        const wi = this.ask(bz)
        promised.set(this.workers[wi]!, cEst[i]!)
        asked.push([wi, bz])
      } else nextAsk = Math.min(nextAsk, latestAsk)
    }
    // idle workers: one no forecast task needs leaves; one a task needs stays while that comes within a
    // warm-up, and one the run cannot ask for again while its platform has work left; at the run's end none
    const left = new Int32Array(this.platforms)
    for (let i = 0; i < n; i++) if (state[i] !== DONE) left[plat[i]!]!++
    let keepUntil = Infinity
    for (const w of this.live())
      if (
        joined(w) &&
        w.run.size === 0 &&
        w.reserved.length === 0 &&
        fits.stay?.(w.ix) !== true &&
        left.some((x) => x > 0) &&
        !(this.sizes[w.size]!.max <= 0 && left[sizePlat[w.size]!]! > 0)
      ) {
        const r = demandOn.get(w) ?? Infinity
        if (r - t >= this.warm(w.size)) {
          w.leftAt = t
          leave.push(w.ix)
        } else keepUntil = Math.min(keepUntil, r)
      }
    const due = Math.min(nextAsk > t + 1e-6 ? nextAsk : Infinity, keepUntil > t + 1e-6 ? keepUntil : Infinity)
    return { start, ask: asked, leave, due }
  }
}
