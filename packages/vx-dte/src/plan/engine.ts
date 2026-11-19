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

/** What one decide shares between its plans: the tasks planned exactly, and the list schedule of the rest. */
interface Prep {
  near: Uint8Array
  classify?: boolean
  far?: { end: number; asks: [number, number][]; st?: Float64Array }
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
  /** The releases of the restart a plan chose (absolute ms), kept across decides. */
  private rel?: Float64Array
  private rstMode = 0
  private u3: Float64Array | undefined
  private prioU?: Float64Array
  /** Known tasks' cores and their share: what an unmeasured task's cores may be. */
  private coresHist: [number, number][] = []
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
  /** The worker the last plan had each task on (-1: none). */
  private readonly planned: Int32Array
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
    this.planned = new Int32Array(n).fill(-1)
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
    const hist = new Map<number, number>()
    for (let i = 0; i < n; i++) if (kms[i] != null) hist.set(kcores[i]!, (hist.get(kcores[i]!) ?? 0) + 1)
    this.coresHist = [...hist].map(([c, k]) => [c, k / kn] as [number, number])
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
  /** How long before a worker is needed to ask for it: the slowest join this run has seen, else history's warm-up. */
  private lead(z: number): number {
    const j = this.joins[z]!
    if (!process.env.LEAD) return this.warm(z)
    // none joined yet: the slowest join history's spread allows a full fleet of it
    if (j.length === 0) return process.env.LEADS ? this.warm(z) + (this.sizes[z]!.spreadMs ?? 0) * Math.max(0, this.sizes[z]!.max - 1) : this.warm(z)
    return Math.max(this.warm(z), ...j)
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

  /**
   * The rest of the run played forward on the forecast's means: each task
   * as soon as its upstreams end and a worker of its platform has an idle
   * core, the longest chain first; `extra` new workers of each size joining
   * after a warm-up from now. Its end, when each extra is first given work,
   * and when each live worker is next given work.
   */
  private play(t: number, extra: readonly number[]): { end: number; stuck: number; first: number[]; next: Map<Worker, number> } {
    const { n, state, tail, E, cEst, kOff, kArr, dOff, dArr, plat } = this
    interface Slot {
      readonly plat: number
      readonly cores: number
      load: number
      readonly joinAt: number
      first: number
      /** Its place in byPlat, which runs from the latest profile end to the soonest. */
      o?: number
      readonly w?: Worker
    }
    const slots: Slot[] = []
    const byPlat: Slot[][] = Array.from({ length: this.platforms }, () => [])
    const add = (s: Slot): void => {
      slots.push(s)
      byPlat[s.plat]!.push(s)
    }
    const ev: [number, number][] = [] // [time, task (>= 0) | -1 - slot join]
    for (const w of this.live()) {
      const s: Slot = { plat: this.sizePlat[w.size]!, cores: w.cores, load: 0, joinAt: this.joinAt(w), first: Infinity, w }
      add(s)
      if (w.joinedAt === undefined) push(ev, [s.joinAt, -1 - (slots.length - 1)])
    }
    for (let z = 0; z < extra.length; z++)
      for (let k = 0; k < extra[z]!; k++) {
        add({ plat: this.sizePlat[z]!, cores: this.sizes[z]!.cores, load: 0, joinAt: t + this.warm(z), first: Infinity })
        push(ev, [t + this.warm(z), -1 - (slots.length - 1)])
      }
    const where = new Int32Array(n).fill(-1)
    const left = new Int32Array(n)
    const ready: [number, number][][] = Array.from({ length: this.platforms }, () => [])
    let open = 0
    for (let i = 0; i < n; i++) {
      if (state[i] === DONE) continue
      open++
      if (state[i] === RUNNING && this.onWorker[i]! >= 0) {
        const w = this.workers[this.onWorker[i]!]!
        const si = slots.findIndex((s) => s.w === w)
        if (si >= 0) {
          slots[si]!.load += cEst[i]!
          where[i] = si
        }
        push(ev, [t + this.rem(i) * Math.max(1, this.loadEst(w) / w.cores), i])
        continue
      }
      let l = 0
      for (let x = dOff[i]!; x < dOff[i + 1]!; x++) if (state[dArr[x]!] !== DONE) l++
      left[i] = l
      if (l === 0) push(ready[plat[i]!]!, [-tail[i]!, i])
    }
    let end = t
    let now = t
    const place = (): void => {
      for (let p = 0; p < this.platforms; p++) {
        const q = ready[p]!
        while (q.length > 0) {
          let best: Slot | undefined
          let bi = -1
          const i = q[0]![1]
          const c = cEst[i]!
          for (let k = 0; k < byPlat[p]!.length; k++) {
            const s = byPlat[p]![k]!
            if (s.joinAt > now || s.load >= s.cores - 1e-9) continue
            const free = s.cores - s.load
            // the fullest that fits whole, else the emptiest
            const b = best === undefined ? -Infinity : best.cores - best.load
            const fitsS = free >= Math.min(c, s.cores) - 1e-9
            const fitsB = best !== undefined && b >= Math.min(c, best.cores) - 1e-9
            if (best === undefined || (fitsS && (!fitsB || free < b)) || (!fitsS && !fitsB && free > b)) {
              best = s
              bi = k
            }
          }
          if (best === undefined) break
          pop(q)
          best.load += c
          if (best.first === Infinity) best.first = now
          const fin = now + E[i]! * Math.max(1, best.load / best.cores)
          where[i] = slots.indexOf(byPlat[p]![bi]!)
          push(ev, [fin, i])
        }
      }
    }
    place()
    while (ev.length > 0) {
      now = ev[0]![0]
      while (ev.length > 0 && ev[0]![0] <= now) {
        const [, x] = pop(ev)
        if (x < 0) continue
        open--
        if (now > end) end = now
        if (where[x]! >= 0) slots[where[x]!]!.load -= cEst[x]!
        for (let q = kOff[x]!; q < kOff[x + 1]!; q++) {
          const k2 = kArr[q]!
          if (state[k2] !== DONE && --left[k2]! === 0) push(ready[plat[k2]!]!, [-tail[k2]!, k2])
        }
      }
      place()
    }
    const first: number[] = []
    const next = new Map<Worker, number>()
    for (const s of slots) if (s.w === undefined) first.push(s.first)
      else next.set(s.w, s.first)
    return { end: open > 0 ? Infinity : end, stuck: open, first, next }
  }

  /**
   * The rest of the run played forward against the end the facts allow
   * (`D`): each task on a worker with an idle core as soon as its upstreams
   * end, the latest start first; a task at its latest start with no room
   * has a new worker asked (a warm-up before it is needed, no sooner than
   * now) when that saves it more than the warm-up over waiting for room.
   * The workers it asks (size, when), and when each live one is next given work.
   */
  private plan2(
    t: number,
    D: number,
    price: boolean,
    fits: Fits,
    extra: readonly number[] = [],
    eager = false,
  ): { asks: [number, number][]; start: [number, number][]; next: Map<Worker, number>; end: number; held: number } {
    const { n, state, tail, E, cEst, kOff, kArr, dOff, dArr, plat } = this
    interface Slot {
      readonly plat: number
      readonly size: number
      readonly cores: number
      load: number
      joinAt: number
      first: number
      readonly ends: [number, number][]
      readonly w?: Worker
      /** Room promised from this moment to a task past its latest start: others take it only if they end by then. */
      resv: number
      /** Its time held from now (ms): warm-up, busy, and idle gaps (one longer than a warm-up costs a warm-up: it leaves and is asked again). */
      hold: number
      idleSince: number
      busySince: number
    }
    const slots: Slot[] = []
    const byPlat: Slot[][] = Array.from({ length: this.platforms }, () => [])
    const count = new Array<number>(this.sizes.length).fill(0)
    const start: [number, number][] = []
    const add = (s: Slot): number => {
      slots.push(s)
      byPlat[s.plat]!.push(s)
      count[s.size]!++
      return slots.length - 1
    }
    const ev: [number, number][] = [] // [time, task | -1 wake]
    for (const w of this.live()) {
      // one not joined yet joins no sooner than a moment from now
      const joinAt = w.joinedAt ?? Math.max(this.joinAt(w), t + 1)
      const si = add({ plat: this.sizePlat[w.size]!, size: w.size, cores: w.cores, load: 0, joinAt, first: Infinity, ends: [], w, resv: Infinity, hold: joinAt > t ? joinAt - t : 0, idleSince: Math.max(t, joinAt), busySince: 0 })
      if (w.joinedAt === undefined) push(ev, [joinAt, -1])
    }
    for (let z = 0; z < extra.length; z++)
      for (let k = 0; k < extra[z]!; k++) {
        const joinAt = t + this.warm(z)
        add({ plat: this.sizePlat[z]!, size: z, cores: this.sizes[z]!.cores, load: 0, joinAt, first: Infinity, ends: [], resv: Infinity, hold: joinAt - t, idleSince: joinAt, busySince: 0 })
        push(ev, [joinAt, -1])
      }
    const where = new Int32Array(n).fill(-1)
    const left = new Int32Array(n)
    const ready: [number, number][][] = Array.from({ length: this.platforms }, () => [])
    let open = 0
    let end = t
    const startAt = new Float64Array(n).fill(-1)
    const readyAt = new Float64Array(n).fill(-1)
    const run = (i: number, si: number, at: number, ms: number): void => {
      startAt[i] = at
      const s = slots[si]!
      if (s.load <= 1e-9) {
        s.hold += Math.min(at - s.idleSince, this.warm(s.size))
        s.busySince = at
      }
      s.load += cEst[i]!
      where[i] = si
      push(s.ends, [at + ms, cEst[i]!])
      push(ev, [at + ms, i])
    }
    for (let i = 0; i < n; i++) {
      if (state[i] === DONE) continue
      open++
      if (state[i] === RUNNING && this.onWorker[i]! >= 0) {
        const w = this.workers[this.onWorker[i]!]!
        const si = slots.findIndex((s) => s.w === w)
        const ms = this.rem(i) * Math.max(1, this.loadEst(w) / w.cores)
        if (si >= 0) run(i, si, t, ms)
        else push(ev, [t + ms, i])
        continue
      }
      let l = 0
      for (let x = dOff[i]!; x < dOff[i + 1]!; x++) if (state[dArr[x]!] !== DONE) l++
      left[i] = l
      if (l === 0) push(ready[plat[i]!]!, [-tail[i]!, i])
    }
    const asks: [number, number][] = []
    const woke = new Uint8Array(n)
    const resvBy: number[] = slots.map(() => -1)
    // when room for c cores frees on slot s, from `now`
    const roomAt = (s: Slot, c: number, now: number): number => {
      const need = Math.min(c, s.cores)
      let free = s.cores - s.load
      if (free >= need - 1e-9) return Math.max(now, s.joinAt)
      const e = s.ends.slice().sort((a, b) => a[0] - b[0])
      for (const [at, k] of e) {
        free += k
        if (free >= need - 1e-9) return Math.max(at, s.joinAt)
      }
      return Infinity
    }
    let now = t
    const place = (): void => {
      for (let p = 0; p < this.platforms; p++) {
        const q = ready[p]!
        const later: [number, number][] = []
        while (q.length > 0) {
          const top = pop(q)
          const i = top[1]
          const c = cEst[i]!
          let best = -1
          let bf = 0
          let bx = Infinity
          const e = E[i]!
          for (const s of byPlat[p]!) {
            if (s.joinAt > now || s.load >= s.cores - 1e-9) continue
            // a task short of room by a core or more waits; one short by less fills the worker (M 2026-11-18 16:10)
            if (s.cores - s.load <= Math.min(c, s.cores) - 1 + 1e-9) continue
            if (process.env.LF && now + e * Math.max(1, (s.load + c) / s.cores) > D - tail[i]! + e + 1e-6 && now + e <= D - tail[i]! + e + 1e-6) continue
            if (s.resv < Infinity && resvBy[slots.indexOf(s)] !== i && now + e * Math.max(1, (s.load + c) / s.cores) > s.resv + 1e-6) continue
            if (s.w !== undefined && fits.on !== undefined && !fits.on(i, s.w.ix, now <= t)) continue
            const free = s.cores - s.load
            const whole = free >= Math.min(c, s.cores) - 1e-9
            const bs = best < 0 ? undefined : slots[best]!
            const bWhole = bs !== undefined && bf >= Math.min(c, bs.cores) - 1e-9
            if (process.env.PACKT) {
              let until = now
              for (const q of s.ends) if (q[0] > until) until = q[0]
              const ext = Math.max(0, now + e - until)
              if (bs === undefined || (whole && !bWhole) || (whole === bWhole && (ext < bx - 1e-6 || (Math.abs(ext - bx) <= 1e-6 && (whole ? free < bf : free > bf))))) {
                best = slots.indexOf(s)
                bf = free
                bx = ext
              }
              continue
            }
            if (bs === undefined || (whole && (!bWhole || free < bf)) || (!whole && !bWhole && free > bf)) {
              best = slots.indexOf(s)
              bf = free
            }
          }
          if (best >= 0) {
            const s = slots[best]!
            if (s.first === Infinity) s.first = now
            for (let k = 0; k < resvBy.length; k++)
              if (resvBy[k] === i) {
                slots[k]!.resv = Infinity
                resvBy[k] = -1
              }
            if (now <= t && s.w !== undefined) start.push([i, s.w.ix])
            run(i, best, now, e * Math.max(1, (s.load + c) / s.cores))
            continue
          }
          const ls = D - tail[i]!
          if (!eager && now < ls - 1e-6) {
            // room may free before it must start
            later.push(top)
            if (woke[i] === 0) {
              woke[i] = 1
              push(ev, [ls, -1])
            }
            continue
          }
          // at its latest start with no room: wait for room, or a new worker
          let x = Infinity
          let xs = -1
          for (const s of byPlat[p]!) {
            if (s.resv < Infinity && resvBy[slots.indexOf(s)] !== i) continue
            if (s.w !== undefined && fits.on !== undefined && !fits.on(i, s.w.ix, false)) continue
            const r = roomAt(s, c, now)
            if (r < x) {
              x = r
              xs = slots.indexOf(s)
            }
          }
          let bz = -1
          let bl = Infinity
          let bc = Infinity
          for (let z = 0; z < this.sizes.length; z++) {
            if (this.sizePlat[z] !== p || count[z]! >= this.sizes[z]!.max) continue
            if (fits.size !== undefined && !fits.size(i, z)) continue
            const ez = e * Math.max(1, c / this.sizes[z]!.cores)
            const l = Math.max(now, t + this.warm(z)) + ez
            const cc = this.sizes[z]!.cores * (this.warm(z) + ez)
            if (l < bl - 1e-6 || (Math.abs(l - bl) <= 1e-6 && cc < bc)) {
              bz = z
              bl = l
              bc = cc
            }
          }
          const join = bz < 0 ? Infinity : Math.max(now, t + this.lead(bz))
          if (bz >= 0 && x - join > (price ? this.warm(bz) : 1e-6)) {
            const si = add({ plat: p, size: bz, cores: this.sizes[bz]!.cores, load: 0, joinAt: join, first: join, ends: [], resv: Infinity, hold: this.warm(bz), idleSince: join, busySince: 0 })
            resvBy.push(-1)
            asks.push([bz, join - this.lead(bz)])
            for (let k = 0; k < resvBy.length; k++)
              if (resvBy[k] === i) {
                slots[k]!.resv = Infinity
                resvBy[k] = -1
              }
            run(i, si, join, e * Math.max(1, c / this.sizes[bz]!.cores))
            continue
          }
          later.push(top)
          if (xs >= 0 && resvBy[xs] !== i) {
            for (let k = 0; k < resvBy.length; k++)
              if (resvBy[k] === i) {
                slots[k]!.resv = Infinity
                resvBy[k] = -1
              }
            slots[xs]!.resv = x
            resvBy[xs] = i
          } else if (xs >= 0) slots[xs]!.resv = x
          if (x < Infinity && x > now + 1e-9) push(ev, [x, -1])
        }
        for (const x of later) push(q, x)
      }
    }
    place()
    while (ev.length > 0) {
      now = ev[0]![0]
      while (ev.length > 0 && ev[0]![0] <= now) {
        const [, x] = pop(ev)
        if (x < 0) continue
        open--
        if (now > end) end = now
        if (where[x]! >= 0) {
          const s = slots[where[x]!]!
          s.load -= cEst[x]!
          if (s.load <= 1e-9) {
            s.hold += now - s.busySince
            s.idleSince = now
          }
          const k = s.ends.findIndex((q) => q[0] === now && q[1] === cEst[x]!)
          if (k >= 0) {
            s.ends[k] = s.ends[s.ends.length - 1]!
            s.ends.pop()
            // keep the heap a heap
            s.ends.sort((a, b) => a[0] - b[0])
          }
        }
        for (let q = kOff[x]!; q < kOff[x + 1]!; q++) {
          const k2 = kArr[q]!
          if (state[k2] !== DONE && --left[k2]! === 0) {
            readyAt[k2] = now
            push(ready[plat[k2]!]!, [-tail[k2]!, k2])
          }
        }
      }
      place()
    }
    const next = new Map<Worker, number>()
    for (const s of slots) if (s.w !== undefined) next.set(s.w, s.first)
    if (process.env.DBG2 && Math.abs(t - Number(process.env.DBG2)) < 600) {
      for (let i = 0; i < n; i++) if (startAt[i]! >= 0) console.log('  task', i, 'ready', (readyAt[i]! / 1000).toFixed(1), 'start', (startAt[i]! / 1000).toFixed(1), 'ms', (E[i]! / 1000).toFixed(1), 'c', cEst[i], 'tail', (tail[i]! / 1000).toFixed(1), 'slot', where[i])
    }
    let held = 0
    for (const s of slots) held += s.hold * s.cores
    return { asks, start, next, end: open > 0 ? Infinity : end, held }
  }

  /**
   * The rest of the run as a schedule: tasks the latest start first (each
   * after its upstreams), each at the soonest finish a worker's room allows
   * (room kept for those placed before it, so a later task may fill only a
   * gap it ends in); one that would end past its latest finish takes a new
   * worker, asked the slowest warm-up seen before it is needed, when that
   * ends it sooner (`eager`: whenever that ends it sooner).
   */
  /**
   * Each task's cores as planned, with what a worker measures: a worker using
   * more than its tasks' estimates says spreads the excess over its unmeasured tasks.
   */
  private measured(fits: Fits): Float64Array {
    let cEst = this.cEst
    if (!process.env.MLOAD || fits.load === undefined) return cEst
    for (const w of this.live()) {
      if (w.joinedAt === undefined) continue
      const m = fits.load(w.ix)
      let S = 0
      let u = 0
      for (const j of w.run) {
        S += cEst[j]!
        if (this.kms[j] == null) u++
      }
      if (m > S + 1e-9 && u > 0) {
        if (cEst === this.cEst) cEst = Float64Array.from(cEst)
        for (const j of w.run) if (this.kms[j] == null) cEst[j] = cEst[j]! + (m - S) / u
      }
    }
    return cEst
  }
  private plan3(
    t: number,
    D: number,
    fits: Fits,
    extra: readonly number[] = [],
    eager = false,
    soon = false,
    Dv = 0,
    prep?: Prep,
    u?: Float64Array,
  ): {
    asks: [number, number][]
    start: [number, number][]
    next: Map<Worker, number>
    end: number
    held: number
    waits?: boolean
    tags?: Float64Array
    firstX?: number[]
    nextStart?: number
  } {
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
      /** Asked by the list schedule past the horizon: not held in any plan's sum. */
      far?: boolean
    }
    const slots: Slot[] = []
    const byPlat: Slot[][] = Array.from({ length: this.platforms }, () => [])
    const count = new Array<number>(this.sizes.length).fill(0)
    // keep byPlat from the latest profile end to the soonest (stable)
    const lift = (s: Slot): void => {
      const o = byPlat[s.plat]!
      const e = s.T[s.T.length - 1]!
      let k = s.o!
      while (k > 0 && o[k - 1]!.T[o[k - 1]!.T.length - 1]! < e) {
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
    for (const w of this.live()) {
      const joinAt = w.joinedAt ?? Math.max(this.joinAt(w), t + 1)
      slotOf.set(w, add({ plat: this.sizePlat[w.size]!, size: w.size, cores: w.cores, joinAt, from: t, T: [joinAt], L: [0], first: Infinity, w, tag: w.ix }))
    }
    let xk = 0
    for (let z = 0; z < extra.length; z++)
      for (let k = 0; k < extra[z]!; k++)
        add({ plat: this.sizePlat[z]!, size: z, cores: this.sizes[z]!.cores, joinAt: t + this.warm(z), from: t, T: [t + this.warm(z)], L: [0], first: Infinity, tag: -1 - xk++ })
    const fits1 = (s: Slot, load: number, c: number): boolean =>
      load < s.cores - 1e-9 && load + Math.min(c, s.cores) < s.cores + 1 - 1e-9
    // the soonest start from r with room for c cores for d ms (stretched by what overfills)
    // what no task left fits in: the shortest task's time (set once the tasks are known)
    let gapMin = 0
    // the load at which a task of c cores no longer fits (fits1)
    const thr = (s: Slot, c: number): number => Math.min(s.cores, s.cores + 1 - Math.min(c, s.cores)) - 1e-9
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
    const soonest = (s: Slot, r: number, c: number, e: number, pad = 0): [number, number] => {
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
      const later = process.env.FLEX !== undefined && s.tag !== undefined && s.tag < 0 && s.tag > -1e5
      if (T.length === 1) return later ? 0 : s.w === undefined || s.w.joinedAt === undefined ? (s.joinAt - s.from) * s.cores : 0
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
      const later = process.env.FLEX !== undefined && s.tag !== undefined && s.tag < 0 && s.tag > -1e5
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
    let lead = 0
    for (let z = 0; z < this.sizes.length; z++) if (this.sizes[z]!.max > 0) lead = Math.max(lead, this.lead(z))
    const horizon = process.env.HOR ? t + Number(process.env.HOR) * lead : Infinity
    const fin = new Float64Array(n)
    const st = new Float64Array(n).fill(-1)
    const on: (Slot | undefined)[] = new Array(n)
    let end = t
    let open = 0
    const todo: number[] = []
    const far: number[] = []
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
        if (f > end) end = f
        open--
        continue
      }
      // the plan looks two warm-ups ahead (M 2026-11-05): what may start later is planned when it nears
      if (prep !== undefined ? prep.near[i] === 0 : horizon < Infinity && !process.env.MIX && this.ef[i]! - E[i]! > horizon) {
        far.push(i)
        continue
      }
      todo.push(i)
    }
    // the latest start first; upstreams before (a longer tail), the graph's order on ties
    // tasks with something history never measured on or after them
    const unk = new Uint8Array(n)
    for (let x = n - 1; x >= 0; x--) {
      const i = order[x]!
      if (state[i] === DONE) continue
      if (this.kms[i] === null || this.kms[i] === undefined) unk[i] = 1
      else if (process.env.UNK === '2')
        for (let q = this.kOff[i]!; q < this.kOff[i + 1]!; q++)
          if (unk[this.kArr[q]!] === 1) {
            unk[i] = 1
            break
          }
    }
    const pos = new Int32Array(n)
    for (let x = 0; x < n; x++) pos[order[x]!] = x
    if (u === undefined) todo.sort((a, b) => tail[b]! - tail[a]! || pos[a]! - pos[b]!)
    else {
      // a restart's order: each task's start drawn a way into its slack, never before an upstream's
      const key = new Float64Array(n)
      for (const i of order) {
        if (state[i] === DONE) continue
        const es = this.efs[i]! - E[i]!
        let k = es + u[i]! * Math.max(0, D - tail[i]! - es)
        for (let q = dOff[i]!; q < dOff[i + 1]!; q++) k = Math.max(k, key[dArr[q]!]!)
        key[i] = k
      }
      todo.sort((a, b) => key[a]! - key[b]! || tail[b]! - tail[a]! || pos[a]! - pos[b]!)
    }
    const asks: [number, number][] = []
    for (const i of todo) if (E[i]! < gapMin) gapMin = E[i]!
    // past the horizon a task goes after what its worker already runs (a list schedule): each worker's cores
    // free from its profile's tail, and a task takes the latest freed by its ready time (the busiest that can
    // run it, as the near plan packs), else the soonest. Only what starts within the horizon is fitted in gaps.
    const MIX2 = horizon < Infinity && process.env.MIX2 !== undefined
    const MIX = horizon < Infinity && (process.env.MIX !== undefined || MIX2)
    const lanes = new Map<Slot, Float64Array>()
    const ord: Slot[][] = byPlat.map(() => [])
    const key = (s: Slot): number => lanes.get(s)![0]!
    const place = (s: Slot): void => {
      const o = ord[s.plat]!
      const x = key(s)
      let lo = 0
      let hi = o.length
      while (lo < hi) {
        const m = (lo + hi) >> 1
        if (key(o[m]!) <= x) lo = m + 1
        else hi = m
      }
      o.splice(lo, 0, s)
    }
    const relane = (s: Slot): void => {
      const old = lanes.get(s)
      if (old !== undefined) {
        const o = ord[s.plat]!
        let lo = 0
        let hi = o.length
        const x = old[0]!
        while (lo < hi) {
          const m = (lo + hi) >> 1
          if (key(o[m]!) < x) lo = m + 1
          else hi = m
        }
        while (o[lo] !== s) lo++
        o.splice(lo, 1)
      }
      const C = Math.max(1, Math.round(s.cores))
      const a = old ?? new Float64Array(C)
      const { T, L } = s
      let k = T.length - 1
      // core j is free once the load stays at or under j: later as j falls
      for (let j = 0; j < C; j++) {
        while (k > 0 && L[k - 1]! <= j + 1e-9) k--
        a[C - 1 - j] = Math.max(s.joinAt, T[k]!)
      }
      lanes.set(s, a)
      place(s)
    }
    // the slot a list schedule gives a task ready at r, and when it starts there
    const listed = (p: number, r: number, c: number): [Slot | undefined, number] => {
      const o = ord[p]!
      if (o.length === 0) return [undefined, Infinity]
      let lo = 0
      let hi = o.length
      while (lo < hi) {
        const m = (lo + hi) >> 1
        if (key(o[m]!) <= r) lo = m + 1
        else hi = m
      }
      const s = o[lo > 0 ? lo - 1 : 0]!
      const a = lanes.get(s)!
      return [s, Math.max(r, a[Math.min(a.length, Math.max(1, Math.ceil(c - 1e-9))) - 1]!)]
    }
    if (MIX) for (const s of slots) relane(s)
    const RDYU = !!process.env.RDYU
    for (const i of todo) {
      let r = t
      for (let x = dOff[i]!; x < dOff[i + 1]!; x++) r = Math.max(r, fin[dArr[x]!]!)
      const c = cEst[i]!
      const e = E[i]!
      // an upstream history never measured may end as soon as it starts: room is kept from then
      let wait = 0
      if (RDYU) {
        let r0 = t
        for (let x = dOff[i]!; x < dOff[i + 1]!; x++) {
          const d = dArr[x]!
          r0 = Math.max(r0, this.kms[d] == null && state[d] !== DONE ? Math.max(t, st[d]! >= 0 ? st[d]! : t) : fin[d]!)
        }
        if (r0 < r - 1e-6) wait = r - r0
      }
      const p = plat[i]!
      let bs: Slot | undefined
      let listS = Infinity
      if (MIX && !MIX2) {
        const [ls, S0] = listed(p, r, c)
        if (ls !== undefined && S0 > horizon) {
          bs = ls
          listS = S0
        }
      }
      let bS = Infinity
      let bK = Infinity
      let bF = Infinity
      let bX = Infinity
      let bL = Infinity
      const pad = process.env.OCC ? this.sdOf(i) : 0
      // how much ending at F is expected to end the run late: E[max(its path, the run's end)] − E[the run's end]
      const sdi = this.sdOf(i)
      const pathV = sdi * sdi + Math.max(0, this.tv[i]! - sdi * sdi)
      const lateBy = (F: number): number =>
        process.env.VARL && (pathV > 0 || Dv > 0)
          ? Math.max(0, clarkMean(F + tail[i]! - e, pathV, D, Dv) - D)
          : Math.max(0, F - lf)
      // a task history never measured is not put off: nothing says how long it may take
      const lf = process.env.UNK && unk[i] === 1 ? Math.min(D - tail[i]! + e, r + e) : D - tail[i]! + e
      const consider = (s: Slot): void => {
        if (s.w !== undefined && fits.on !== undefined && !fits.on(i, s.w.ix, false)) return
        const [K, d] = soonest(s, r - wait, c, e + wait, pad)
        if (K === Infinity) return
        const S = K + wait
        const F = K + d
        // in time: the one it adds least held time to, then the soonest end; late: the soonest end
        const lt = lateBy(F)
        const X = process.env.EXT && !soon ? (lt <= 1e-6 ? addedHold(s, S, F, c) : Infinity) : 0
        const bOn = bL <= 1e-6
        const on = lt <= 1e-6
        // on a tie, the worker the last plan had it on: a plan followed is not remade
        const kept = process.env.KEEP !== undefined && s.w !== undefined && this.planned[i] === s.w.ix
        if (
          bs === undefined ||
          (on && !bOn) ||
          (on && bOn && (X < bX - 1e-6 || (X <= bX + 1e-6 && (F < bF - 1e-6 || (F <= bF + 1e-6 && kept))))) ||
          (!on && !bOn && (lt < bL - 1e-6 || (lt <= bL + 1e-6 && (F < bF - 1e-6 || (F <= bF + 1e-6 && s.T[s.T.length - 1]! > bs.T[bs.T.length - 1]!)))))
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
      const rk = r - wait
      const ext0 = process.env.EXT !== undefined && !soon && l0 <= 1e-6
      const now = (s: Slot): boolean => {
        const r = rk
        if (s.joinAt > r) return false
        const { T, L } = s
        let k = at(T, r)
        if (L[k]! + c > s.cores + 1e-9) return false
        const end = r + e + wait + pad
        const R = runsOf(s, thr(s, c))
        if (R !== undefined) {
          const [Fs, Fe] = R
          let q = Fe.length === 0 ? 0 : at(Fe, r)
          if (q < Fe.length && Fe[q]! <= r) q++
          if (q < Fs.length && Fs[q]! < end) return false
        } else for (; k < T.length && (T[k]! < end || T[k]! <= r); k++) if (!fits1(s, L[k]!, c)) return false
        if (s.w !== undefined && fits.on !== undefined && !fits.on(i, s.w.ix, false)) return false
        if (ext0 && addedHold(s, r, r + e + wait, c) > 1e-6) return false
        return true
      }
      if (listS < Infinity) {
        bS = listS
        bF = listS + e * Math.max(1, c / bs!.cores)
        bL = lateBy(bF)
        bX = 0
      } else {
        // the slot the last plan had it on first: a plan followed is not remade
        const ks = process.env.KEEP !== undefined ? this.planned[i]! : -1
        const kw = ks >= 0 ? this.workers[ks] : undefined
        let kslot = kw === undefined ? undefined : slotOf.get(kw)
        if (kslot !== undefined && (kslot.plat !== p || !now(kslot))) kslot = undefined
        // else the first such from the latest profile end: the busiest, which a tie prefers
        if (kslot === undefined) for (const s of byPlat[p]!) if (now(s)) { kslot = s; break }
        if (kslot !== undefined) {
          bs = kslot
          bS = r
          bK = rk
          bF = r + e
          bX = 0
          bL = l0
        } else {
          // none runs it now and a list schedule starts it past the horizon: it waits for the list schedule
          if (MIX2) {
            const [ls, S0] = listed(p, r, c)
            if (ls !== undefined && S0 > horizon) {
              far.push(i)
              continue
            }
          }
          for (const s of byPlat[p]!) consider(s)
        }
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
          const need = eager || (process.env.VARL && pathV > 0) ? r : Math.max(r, lf - ez)
          const a = Math.max(t, need - this.lead(z))
          const F = Math.max(r, a + this.warm(z)) + ez
          const cc = this.sizes[z]!.cores * (this.warm(z) + ez)
          if (F < zF - 1e-6 || (F <= zF + 1e-6 && cc < zC)) {
            bz = z
            zF = F
            zC = cc
          }
        }
        if (bz >= 0 && (process.env.VARL ? lateBy(zF) < bL - 1e-6 || (lateBy(zF) <= bL + 1e-6 && zF < bF - 1e-6 && eager) : zF < bF - 1e-6)) {
          const ez = e * Math.max(1, c / this.sizes[bz]!.cores)
          const ask = Math.max(t, (eager || (process.env.VARL && pathV > 0) ? r : Math.max(r, lf - ez)) - this.lead(bz))
          const joinAt = ask + this.warm(bz)
          const s = add({ plat: p, size: bz, cores: this.sizes[bz]!.cores, joinAt, from: ask, T: [joinAt], L: [0], first: Infinity, tag: -1e6 - asks.length })
          asks.push([bz, ask])
          bs = s
          bS = Math.max(r, joinAt)
          bK = Infinity
          bF = bS + ez
        }
      }
      if (bs === undefined) continue
      take(bs, bK < Infinity ? bK : bS, bF + pad, c)
      if (MIX) relane(bs)
      if (bS < bs.first) bs.first = bS
      fin[i] = bF
      st[i] = bS
      on[i] = bs
      open--
      if (bF > end) end = bF
    }
    if (far.length > 0 && prep?.far !== undefined && !process.env.NOCACHE) {
      // the list schedule past the horizon is made once a decide
      open -= far.length
      if (prep.far.end > end) end = prep.far.end
      for (const a of prep.far.asks) asks.push(a)
    } else if (far.length > 0) {
      const asks0 = asks.length
      let end0 = -Infinity
      // past the horizon, a list schedule: each worker's cores free from its profile's tail; a task takes the
      // latest freed by its ready time (the busiest that can run it, as the near plan packs), else the soonest
      far.sort((a, b) => tail[b]! - tail[a]! || pos[a]! - pos[b]!)
      for (const s of slots) relane(s)
      for (const i of far) {
        let r = t
        for (let x = dOff[i]!; x < dOff[i + 1]!; x++) r = Math.max(r, fin[dArr[x]!]!)
        const c = cEst[i]!
        const e = E[i]!
        const p = plat[i]!
        const sdi = this.sdOf(i)
        const pathV = sdi * sdi + Math.max(0, this.tv[i]! - sdi * sdi)
        const lateBy = (F: number): number =>
          process.env.VARL && (pathV > 0 || Dv > 0) ? Math.max(0, clarkMean(F + tail[i]! - e, pathV, D, Dv) - D) : Math.max(0, F - (D - tail[i]! + e))
        let [s, S] = listed(p, r, c)
        let F = s === undefined ? Infinity : S + e * Math.max(1, c / s.cores)
        const lt = s === undefined ? Infinity : lateBy(F)
        if (lt > 1e-6) {
          // a new worker, asked the slowest warm-up seen before it is needed, when that ends it less late
          let bz = -1
          let zF = Infinity
          for (let z = 0; z < this.sizes.length; z++) {
            if (this.sizePlat[z] !== p || count[z]! >= this.sizes[z]!.max) continue
            const F2 = Math.max(r, Math.max(t, r - this.lead(z)) + this.warm(z)) + e * Math.max(1, c / this.sizes[z]!.cores)
            if (F2 < zF - 1e-6) {
              bz = z
              zF = F2
            }
          }
          if (bz >= 0 && lateBy(zF) < lt - 1e-6) {
            const ask = Math.max(t, r - this.lead(bz))
            const joinAt = ask + this.warm(bz)
            s = add({ plat: p, size: bz, cores: this.sizes[bz]!.cores, joinAt, from: ask, T: [joinAt], L: [0], first: Infinity, tag: -1e6 - asks.length, far: !process.env.FARP })
            asks.push([bz, ask])
            S = Math.max(r, joinAt)
            F = S + e * Math.max(1, c / s.cores)
          }
        }
        if (s === undefined) continue
        if (process.env.FARP) {
          take(s, S, F, c)
          relane(s)
        } else {
        const a = lanes.get(s)
        if (a === undefined) relane(s)
        const ln = lanes.get(s)!
        const k = Math.min(ln.length, Math.max(1, Math.ceil(c - 1e-9)))
        // its cores, freed at F; the list keeps no profile, only when each core frees
        const o = ord[s.plat]!
        o.splice(o.indexOf(s), 1)
        for (let j = 0; j < k; j++) ln[j] = F
        ln.sort()
        place(s)
        }
        if (S < s.first) s.first = S
        fin[i] = F
        st[i] = S
        on[i] = s
        open--
        if (F > end) end = F
        if (F > end0) end0 = F
      }
      if (prep !== undefined) prep.far = prep.classify ? { end: end0, asks: asks.slice(asks0), st } : { end: end0, asks: asks.slice(asks0) }
    }
    if (process.env.DBG4 && Math.abs(t - Number(process.env.DBG4)) < 25000 && extra.every((x) => x === 0))
      for (const i of todo)
        console.log('   p3', (t / 1000).toFixed(0), 'task', i, 'r', ((st[i]! - 0) / 1000).toFixed(1), 'fin', (fin[i]! / 1000).toFixed(1), 'lf', ((D - tail[i]! + E[i]!) / 1000).toFixed(1), 'c', cEst[i], 'slot', on[i] === undefined ? '-' : on[i]!.w !== undefined ? 'w' + on[i]!.w!.ix + (on[i]!.w!.joinedAt === undefined ? 'p' : '') : 'new@' + (on[i]!.from / 1000).toFixed(0))
    const start: [number, number][] = []
    for (const i of todo)
      if (state[i] === READY && st[i]! >= 0 && st[i]! <= t + 1e-6) {
        const s = on[i]!
        if (s.w !== undefined && s.w.joinedAt !== undefined && (fits.on === undefined || fits.on(i, s.w.ix, true))) start.push([i, s.w.ix])
      }
    let held = 0
    for (const s of slots) if (s.far !== true) held += holdOf(s, s.T, s.L)
    const next = new Map<Worker, number>()
    for (const s of slots) if (s.w !== undefined) next.set(s.w, s.first)
    let waits = false
    for (const s of slots) if (s.w === undefined && s.from === t && s.first > s.joinAt + 1e-6) waits = true
    const tags = new Float64Array(n).fill(NaN)
    for (const i of todo) if (on[i] !== undefined) tags[i] = on[i]!.tag!
    let nextStart = Infinity
    for (const i of todo) if (st[i]! > t + 1e-6 && st[i]! < nextStart && on[i]?.w?.joinedAt !== undefined) nextStart = st[i]!
    const firstX: number[] = []
    for (const s of slots) if (s.tag !== undefined && s.tag < 0 && s.tag > -1e5) firstX[-1 - s.tag] = s.first
    return { asks, start, next, end: open > 0 ? Infinity : end, held, waits, tags, firstX, nextStart }
  }

  /**
   * The rest of the run played forward in time, as a list schedule: each moment, the waiting tasks in order
   * of their latest start take the busiest worker with room; only the first that cannot start holds room
   * back (its reservation: the soonest a worker frees enough for it), and any other starts in a gap when it
   * ends before that reservation or leaves it room (EASY backfilling). A first waiting task that would end
   * the run late asks for a new worker, the slowest join seen before it is needed.
   */
  private plan4(
    t: number,
    D: number,
    fits: Fits,
    extra: readonly number[] = [],
    eager = false,
    Dv = 0,
    u?: Float64Array,
  ): {
    asks: [number, number][]
    askFor?: number[]
    start: [number, number][]
    next: Map<Worker, number>
    end: number
    held: number
    waits?: boolean
    tags?: Float64Array
    firstX?: number[]
    firstTaskX?: number[]
    nextStart?: number
    nextTask?: Map<Worker, number>
    rel?: Float64Array
  } {
    const { n, state, tail, E, dOff, dArr, kOff, kArr, plat, order } = this
    const cEst = this.measured(fits)
    const T0 = performance.now()
    const KEEPE = process.env.KEEP !== undefined
    const LONGEST = !!process.env.LONGEST
    // when a slot's last running task ends: the one busy longest takes work first, the rest may leave
    const untilOf = (s: { run: number[] }): number => {
      let u = -Infinity
      for (let k = 0; k < s.run.length; k++) if (fin[s.run[k]!]! > u) u = fin[s.run[k]!]!
      return u
    }
    const VARLE = process.env.VARL !== undefined
    const C = { ev: 0, disp: 0, best: 0, bestIt: 0, shadow: 0, aux: 0, bf: 0, due: 0, dueShadow: 0, head: 0 }
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
      firstTask: number
    }
    const P = this.platforms
    const slots: Slot[] = []
    const openL: Slot[][] = Array.from({ length: P }, () => [])
    const pend: Slot[][] = Array.from({ length: P }, () => [])
    const count = new Array<number>(this.sizes.length).fill(0)
    const joinsH: [number, number][] = []
    // a class per whole core a task asks, up to the widest worker of its platform
    const K = new Int32Array(P)
    for (let z = 0; z < this.sizes.length; z++) K[this.sizePlat[z]!] = Math.max(K[this.sizePlat[z]!]!, Math.ceil(this.sizes[z]!.cores))
    for (const w of this.workers) K[this.sizePlat[w.size]!] = Math.max(K[this.sizePlat[w.size]!]!, Math.ceil(w.cores))
    const classOf = (i: number): number => Math.max(0, Math.min(K[plat[i]!]!, Math.ceil(cEst[i]! - 1e-9)) - 1)
    const add = (s: Slot): Slot => {
      slots.push(s)
      count[s.size]!++
      if (s.joinAt > t) {
        push(joinsH, [s.joinAt, slots.length - 1])
        pend[s.plat]!.push(s)
      }
      return s
    }
    const mk = (pl: number, size: number, cores: number, joinAt: number, from: number, tag: number, w?: Worker): Slot =>
      add({
        plat: pl,
        size,
        cores,
        joinAt,
        from,
        w,
        tag,
        load: 0,
        run: [],
        first: Infinity,
        oi: -1,
        busyFrom: 0,
        idleFrom: Math.max(from, joinAt),
        held: 0,
        worked: false,
        resv: w?.for !== undefined && (state[w.for] === READY || state[w.for] === BLOCKED) ? w.for : -1,
        fr: 0,
        firstTask: -1,
      })
    const slotOf = new Map<Worker, Slot>()
    for (const w of this.live()) {
      const joinAt = w.joinedAt ?? Math.max(this.joinAt(w), t + 1)
      slotOf.set(w, mk(this.sizePlat[w.size]!, w.size, w.cores, joinAt, t, w.ix, w))
    }
    let xk = 0
    for (let z = 0; z < extra.length; z++)
      for (let k = 0; k < extra[z]!; k++) mk(this.sizePlat[z]!, z, this.sizes[z]!.cores, t + this.warm(z), t, -1 - xk++)
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
    const PRIO = u !== undefined && this.rstMode === 1
    if (PRIO) {
      // a restart's order: each task's start drawn a way into its slack, no release
      for (let i = 0; i < n; i++) {
        const es = this.efs[i]! - E[i]!
        prio[i] = es + (u[i]! > 1 ? 0 : u[i]!) * (D - tail[i]! - es) + (pos[i]! * 1e-3) / (n + 1)
      }
      u = undefined
    }
    const before = (a: number, b: number): boolean => prio[a]! < prio[b]!
    const ready: KeyHeap[][] = Array.from({ length: P }, (_, p) => Array.from({ length: Math.max(1, K[p]!) }, () => new KeyHeap(prio)))
    // each waiting task's latest start: one still waiting then takes a new worker if that ends it sooner
    const dlT = new Float64Array(n)
    const dlH = new KeyHeap(dlT)
    // per class, the shortest waiting: what a gap before a reservation takes when the first in order is too long
    // (made the first time a class needs it)
    const short: (KeyHeap | undefined)[][] = Array.from({ length: P }, (_, p) => new Array(Math.max(1, K[p]!)))
    const shortOf = (p: number, k: number): KeyHeap => {
      let h = short[p]![k]
      if (h === undefined) {
        h = short[p]![k] = new KeyHeap(E)
        for (const i of ready[p]![k]!.h) if (st[i]! < 0) h.push(i)
      }
      return h
    }
    // a size of each platform the plan may still ask for: only then is a latest start worth an event
    const askable = (p: number): boolean => {
      for (let z = 0; z < this.sizes.length; z++) if (this.sizePlat[z] === p && count[z]! < this.sizes[z]!.max) return true
      return false
    }
    // a restart's release: each task a drawn way into its slack (latest start less earliest)
    const relT = new Float64Array(u === undefined ? 0 : n)
    const relOut = new Float64Array(u === undefined ? 0 : n)
    const relH = new KeyHeap(relT)
    const enqueue = (i: number, x: number): void => {
      if (u !== undefined && u[i]! >= 0) {
        const es = this.efs[i]! - E[i]!
        const r = u[i]! > 1 ? u[i]! : es + u[i]! * (D - tail[i]! - es)
        u[i] = -1
        relOut[i] = r
        if (r > x + 1e-6) {
          relT[i] = r
          relH.push(i)
          return
        }
      }
      const p = plat[i]!
      const k = classOf(i)
      ready[p]![k]!.push(i)
      short[p]![k]?.push(i)
      if (askable(p)) {
        dlT[i] = eager ? x : Math.max(x, D - tail[i]!)
        dlH.push(i)
      }
    }
    // the first in order among the classes a free room of `room` cores may take
    const headOf = (p: number, room = Infinity): number => {
      const rs = ready[p]!
      let b = -1
      for (let k = 0; k < rs.length && k < room + 1 - 1e-9; k++) {
        const h = rs[k]!
        while (h.size > 0 && st[h.top()]! >= 0) h.pop()
        if (h.size > 0 && (b < 0 || before(h.top(), b))) b = h.top()
      }
      return b
    }
    const fin = new Float64Array(n)
    const st = new Float64Array(n).fill(-1)
    const rdy = new Float64Array(n)
    const on: (Slot | undefined)[] = new Array(n)
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
    // tasks whose upstreams all started: their ready time is known (LOOK: the most urgent keeps its room)
    const LOOK = !!process.env.LOOK
    const placed = new Int32Array(LOOK ? n : 0)
    const soonR = new Float64Array(LOOK ? n : 0)
    const soon: KeyHeap[] = Array.from({ length: LOOK ? P : 0 }, () => new KeyHeap(prio))
    const placedNow = (i: number): void => {
      for (let q = kOff[i]!; q < kOff[i + 1]!; q++) {
        const k = kArr[q]!
        if (++placed[k]! === dOff[k + 1]! - dOff[k]! && state[k] !== DONE) {
          let r = t
          for (let u = dOff[k]!; u < dOff[k + 1]!; u++) r = Math.max(r, fin[dArr[u]!]!)
          soonR[k] = r
          soon[plat[k]!]!.push(k)
        }
      }
    }
    const FLEX = process.env.FLEX !== undefined
    const IDLEW = !!process.env.IDLEW
    const busy = (s: Slot, x: number): void => {
      if (s.load > 1e-9) return
      if (s.worked || s.tag >= 0 || s.tag <= -1e5 || !FLEX) s.held += Math.min(Math.max(0, x - s.idleFrom), this.warm(s.size))
      else s.held += this.warm(s.size)
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
      if (x < s.first) {
        s.first = x
        s.firstTask = i
      }
      if (LOOK) placedNow(i)
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
    const okOn = (i: number, s: Slot): boolean => s.w === undefined || fits.on === undefined || fits.on(i, s.w.ix, false)
    // the soonest a slot has room for i from x on, walking the run's ends in time order: [slot, time, load then]
    const aux: number[] = []
    const touched: Slot[] = []
    const auxFin = (k: number): number => fin[endsH[aux[k]!]!]!
    const shadow = (i: number, x: number, from = x): [Slot | undefined, number, number] => {
      C.shadow++
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
        C.aux++
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
      return VARLE && (pathV > 0 || Dv > 0)
        ? Math.max(0, clarkMean(F + tail[i]! - e, pathV, D, Dv) - D)
        : Math.max(0, F - (D - tail[i]! + e))
    }
    const LATEP = !!process.env.LATEP
    const FITT = false
    const hist = this.coresHist
    // its expected slowdown there: an unmeasured task's cores drawn from the known ones'
    const stretch = (i: number, s: Slot, c: number): number => {
      if (this.kms[i] != null || hist.length === 0 || this.unmeasured !== undefined) return Math.max(1, (s.load + c) / s.cores)
      let v = 0
      for (let k = 0; k < hist.length; k++) v += hist[k]![1] * Math.max(1, (s.load + hist[k]![0]) / s.cores)
      return v
    }
    // the busiest open slot with room for i now; on the waiting task's reservation only in its gap
    const bestOpen = (i: number, p: number, c: number, x: number, hs?: Slot, hS = Infinity, hLoad = 0, hc = 0): Slot | undefined => {
      C.best++
      C.bestIt += openL[p]!.length
      let b: Slot | undefined
      const kept = KEEPE ? this.planned[i]! : -1
      let bLate = Infinity
      let bExt = Infinity
      const o = openL[p]!
      for (let k = 0; k < o.length; k++) {
        const s = o[k]!
        if (!fitsOn(s, s.load, c) || !okOn(i, s)) continue
        if (LATEP && (process.env.LATEP !== "u" || this.kms[i] == null)) {
          const L = lateOf(i, x + E[i]! * stretch(i, s, c))
          if (b === undefined || L < bLate - 1e-6) {
            b = s
            bLate = L
            continue
          }
          if (L > bLate + 1e-6) continue
        }
        if (FITT) {
          const u = Math.max(untilOf(s), s.joinAt)
          const ext = Math.max(0, x + E[i]! * Math.max(1, (s.load + c) / s.cores) - u)
          if (b !== undefined && (ext > bExt + 1e-6 || (ext >= bExt - 1e-6 && !(s.load > b.load + 1e-9)))) continue
          if (s.resv >= 0 && s.resv !== i && !fitsOn(s, s.load + c, cEst[s.resv]!)) {
            const v = s.resv
            let r = 0
            for (let q = dOff[v]!; q < dOff[v + 1]!; q++) {
              const u2 = dArr[q]!
              r = Math.max(r, state[u2] === DONE || st[u2]! >= 0 || (state[u2] === RUNNING && this.onWorker[u2]! >= 0) ? fin[u2]! : this.efs[u2]!)
            }
            if (x + E[i]! * Math.max(1, (s.load + c) / s.cores) > r + 1e-6) continue
          }
          if (s === hs && x + E[i]! * Math.max(1, (s.load + c) / s.cores) > hS + 1e-6 && !fitsOn(s, hLoad + c, hc)) continue
          b = s
          bExt = ext
          continue
        }
        if (b !== undefined && (LONGEST ? !(untilOf(s) > untilOf(b) + 1e-9 || (untilOf(s) >= untilOf(b) - 1e-9 && (s.load > b.load + 1e-9 || (s.load >= b.load - 1e-9 && s.tag === kept && b.tag !== kept)))) : !(s.load > b.load + 1e-9 || (s.load >= b.load - 1e-9 && s.tag === kept && b.tag !== kept)))) continue
        if (s.resv >= 0 && s.resv !== i && !fitsOn(s, s.load + c, cEst[s.resv]!)) {
          // the task it was asked for: in a gap only if it ends before that can start
          const v = s.resv
          let r = 0
          for (let q = dOff[v]!; q < dOff[v + 1]!; q++) {
            const u = dArr[q]!
            r = Math.max(r, state[u] === DONE || st[u]! >= 0 || (state[u] === RUNNING && this.onWorker[u]! >= 0) ? fin[u]! : this.efs[u]!)
          }
          if (x + E[i]! * Math.max(1, (s.load + c) / s.cores) > r + 1e-6) continue
        }
        if (s === hs && x + E[i]! * Math.max(1, (s.load + c) / s.cores) > hS + 1e-6 && !fitsOn(s, hLoad + c, hc)) continue
        b = s
      }
      // an idle one only if waiting for room on a busy one would end it late: idle, it may leave
      if (IDLEW && b !== undefined && b.load <= 1e-9 && b.resv !== i) {
        const [q, S, L] = shadow(i, x)
        if (q !== undefined && q.load > 1e-9 && lateOf(i, S + E[i]! * Math.max(1, (L + c) / q.cores)) <= 1e-6) return undefined
      }
      return b
    }
    // the first waiting task of each platform and its reservation [slot, start, load then], weighed once
    const wHead = new Int32Array(P).fill(-1)
    const wSlot: (Slot | undefined)[] = new Array(P)
    const wS = new Float64Array(P)
    const wL = new Float64Array(P)
    // a task at its latest start with no room: a new worker, asked the slowest warm-up seen before it is needed
    // (one still waiting after a dispatch has no room now: what fits started in order of latest start)
    const due = (i: number, x: number): boolean => {
      C.due++
      const p = plat[i]!
      const c = cEst[i]!
      const e = E[i]!
      if (!askable(p)) return false
      const [hs, hS, hL] = shadow(i, x)
      const F = hs === undefined ? Infinity : hS + e * Math.max(1, (hL + c) / hs.cores)
      const lt = lateOf(i, F)
      const r = rdy[i]!
      if (!(lt > 1e-6 || (eager && F > r + e + 1e-6))) return false
      const sdi = this.sdOf(i)
      const varl = VARLE && sdi * sdi + Math.max(0, this.tv[i]! - sdi * sdi) > 0
      const lf = D - tail[i]! + e
      let bz = -1
      let zF = Infinity
      let zC = Infinity
      let zA = 0
      for (let z = 0; z < this.sizes.length; z++) {
        if (this.sizePlat[z] !== p || count[z]! >= this.sizes[z]!.max) continue
        if (fits.size !== undefined && !fits.size(i, z)) continue
        const ez = e * Math.max(1, c / this.sizes[z]!.cores)
        const need = eager || varl ? r : Math.max(r, lf - ez)
        const a = Math.max(t, need - this.lead(z))
        const Fz = Math.max(x, a + this.warm(z)) + ez
        const cc = this.sizes[z]!.cores * (this.warm(z) + ez)
        if (Fz < zF - 1e-6 || (Fz <= zF + 1e-6 && cc < zC)) {
          bz = z
          zF = Fz
          zC = cc
          zA = a
        }
      }
      const lz = lateOf(i, zF)
      if (process.env.DBGA && t === 0 && extra.every((q) => q === 0)) console.log('ask?', i, 'x', x / 1000, 'r', r / 1000, 'F', F / 1000, 'lf', lf / 1000, 'lt', lt / 1000, 'zF', zF / 1000, 'lz', lz / 1000, 'zA', zA / 1000, 'c', c)
      if (bz < 0 || !(VARLE ? lz < lt - 1e-6 || (lz <= lt + 1e-6 && zF < F - 1e-6 && eager) : zF < F - 1e-6)) return false
      const s2 = mk(p, bz, this.sizes[bz]!.cores, zA + this.warm(bz), zA, -1e6 - asks.length)
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
      C.disp++
      const rs = ready[p]!
      for (;;) {
        let i = headOf(p)
        let blocked = false
        if (LOOK) {
          const sh = soon[p]!
          while (sh.size > 0 && (st[sh.top()]! >= 0 || deps[sh.top()] === 0)) sh.pop()
          const X = sh.size > 0 ? sh.top() : -1
          if (X >= 0 && soonR[X]! > x && (i < 0 || before(X, i))) {
            if (wHead[p] !== X) {
              wHead[p] = X
              const [hs, hS, hL] = shadow(X, x, soonR[X]!)
              wSlot[p] = hs
              wS[p] = hS
              wL[p] = hL
            }
            if (i < 0) return
            i = X
            blocked = true
          }
        }
        if (i < 0) return
        const c = cEst[i]!
        const s = blocked ? undefined : bestOpen(i, p, c, x)
        if (s !== undefined) {
          rs[classOf(i)]!.pop()
          take(i, s, x, E[i]! * Math.max(1, (s.load + c) / s.cores))
          if (wHead[p] === i) wHead[p] = -1
          continue
        }
        if (wHead[p] !== i) {
          C.head++
          wHead[p] = i
          const [hs, hS, hL] = shadow(i, x)
          wSlot[p] = hs
          wS[p] = hS
          wL[p] = hL
        }
        // the rest start in gaps that leave the first waiting task its reservation
        const o = openL[p]!
        if (o.length === 0) return
        const hk = blocked ? -1 : classOf(i)
        if (!blocked) rs[hk]!.pop()
        const hs = wSlot[p]
        const hS = wS[p]!
        const tried = new Uint8Array(rs.length)
        for (;;) {
          let room = 0
          for (let k = 0; k < o.length; k++) if (o[k]!.cores - o[k]!.load > room) room = o[k]!.cores - o[k]!.load
          let j = -1
          let kj = -1
          for (let k = 0; k < rs.length && k < room + 1 - 1e-9; k++) {
            if (tried[k] === 1) continue
            const h = rs[k]!
            while (h.size > 0 && st[h.top()]! >= 0) h.pop()
            if (h.size > 0 && (j < 0 || before(h.top(), j))) {
              j = h.top()
              kj = k
            }
          }
          if (j < 0) break
          C.bf++
          const cj = cEst[j]!
          let sj = bestOpen(j, p, cj, x, hs, hS, wL[p]!, c)
          if (sj === undefined) {
            // too long for the gap: the shortest of its class, else none of it fits now
            const q = shortOf(p, kj)
            while (q.size > 0 && st[q.top()]! >= 0) q.pop()
            const m = q.size > 0 ? q.top() : -1
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
        if (!blocked) rs[hk]!.push(i)
        return
      }
    }
    const T1 = performance.now()
    if (LOOK) {
      for (let i = 0; i < n; i++)
        if (state[i] === DONE || (state[i] === RUNNING && this.onWorker[i]! >= 0))
          for (let q = kOff[i]!; q < kOff[i + 1]!; q++) placed[kArr[q]!]!++
      for (let i = 0; i < n; i++)
        if (state[i] !== DONE && deps[i]! > 0 && !(state[i] === RUNNING && this.onWorker[i]! >= 0) && placed[i] === dOff[i + 1]! - dOff[i]!) {
          let r = t
          for (let u = dOff[i]!; u < dOff[i + 1]!; u++) r = Math.max(r, fin[dArr[u]!]!)
          soonR[i] = r
          soon[plat[i]!]!.push(i)
        }
    }
    for (const s of slots) if (s.joinAt <= t && !isFull(s)) openAdd(s)
    for (let p = 0; p < P; p++) dispatch(p, t)
    const dirty = new Uint8Array(P)
    let tEnds = 0
    let tDisp = 0
    while (dlH.size > 0 && dlT[dlH.top()]! <= t) {
      const i = dlH.pop()
      if (st[i]! < 0 && due(i, t)) dirty[plat[i]!] = 1
    }
    for (;;) {
      const te = endsH.length > 0 ? fin[endsH[0]!]! : Infinity
      const tj = joinsH.length > 0 ? joinsH[0]![0] : Infinity
      const td = dlH.size > 0 ? dlT[dlH.top()]! : Infinity
      const tr = relH.size > 0 ? relT[relH.top()]! : Infinity
      const x = Math.min(te, tj, td, tr)
      if (x === Infinity) break
      C.ev++
      const q0 = performance.now()
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
          if (--deps[k] === 0 && state[k] !== DONE) {
            rdy[k] = x
            enqueue(k, x)
            dirty[plat[k]!] = 1
          }
        }
      }
      const q1 = performance.now()
      tEnds += q1 - q0
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
      while (relH.size > 0 && relT[relH.top()]! <= x) {
        const i = relH.pop()
        enqueue(i, x)
        dirty[plat[i]!] = 1
      }
      const q2 = performance.now()
      for (let p = 0; p < P; p++)
        if (dirty[p] === 1) {
          dirty[p] = 0
          dispatch(p, x)
        }
      tDisp += performance.now() - q2
      while (dlH.size > 0 && dlT[dlH.top()]! <= x) {
        const i = dlH.pop()
        if (st[i]! < 0 && due(i, x)) dirty[plat[i]!] = 1
      }
      for (let p = 0; p < P; p++)
        if (dirty[p] === 1) {
          dirty[p] = 0
          dispatch(p, x)
        }
    }
    const T2 = performance.now()
    let unplaced = 0
    for (let p = 0; p < P; p++) for (const h of ready[p]!) for (const i of h.h) if (st[i]! < 0) unplaced++
    if (process.env.DBGP && extra.every((x) => x === 0)) {
      const late = [...Array(n).keys()].filter((i) => st[i]! >= 0 && fin[i]! > D - tail[i]! + E[i]! + 1e-6).sort((a, b) => st[a]! - st[b]!)
      console.log('  p4', (t / 1000).toFixed(1), 'late', late.slice(0, 4).map((i) => `${i} r${(rdy[i]! / 1000).toFixed(1)} s${(st[i]! / 1000).toFixed(1)} lf${((D - tail[i]!) / 1000).toFixed(1)} c${cEst[i]} on${on[i]!.tag}`).join(' | '))
    }
    const start: [number, number][] = []
    for (let i = 0; i < n; i++)
      if (state[i] === READY && st[i]! >= 0 && st[i]! <= t + 1e-6) {
        const s = on[i]!
        if (s.w !== undefined && s.w.joinedAt !== undefined && (fits.on === undefined || fits.on(i, s.w.ix, true))) start.push([i, s.w.ix])
      }
    let held = 0
    for (const s of slots) {
      const later = FLEX && s.tag < 0 && s.tag > -1e5
      if (!s.worked) {
        held += later ? 0 : s.w === undefined || s.w.joinedAt === undefined ? (s.joinAt - s.from) * s.cores : 0
        continue
      }
      held += (s.held + (s.joinAt > s.from && !later ? s.joinAt - s.from : 0)) * s.cores
    }
    const next = new Map<Worker, number>()
    for (const s of slots) if (s.w !== undefined) next.set(s.w, s.first)
    let waits = false
    for (const s of slots) if (s.w === undefined && s.from === t && s.first > s.joinAt + 1e-6) waits = true
    const tags = new Float64Array(n).fill(NaN)
    let nextStart = Infinity
    for (let i = 0; i < n; i++) {
      const s = on[i]
      if (s === undefined || state[i] === DONE || (state[i] === RUNNING && this.onWorker[i]! >= 0)) continue
      tags[i] = s.tag
      if (st[i]! > t + 1e-6 && st[i]! < nextStart && s.w?.joinedAt !== undefined) nextStart = st[i]!
    }
    // each live worker's next task as planned: room kept for it on the next plan (a plan followed is not remade)
    const nextTask = new Map<Worker, number>()
    const nextAt = new Map<Worker, number>()
    for (let i = 0; i < n; i++) {
      const s = on[i]
      if (s?.w === undefined || state[i] === DONE || state[i] === RUNNING || st[i]! <= t + 1e-6) continue
      if (st[i]! < (nextAt.get(s.w) ?? Infinity)) {
        nextAt.set(s.w, st[i]!)
        nextTask.set(s.w, i)
      }
    }
    const firstX: number[] = []
    const firstTaskX: number[] = []
    for (const s of slots)
      if (s.tag < 0 && s.tag > -1e5) {
        firstX[-1 - s.tag] = s.first
        firstTaskX[-1 - s.tag] = s.firstTask
      }
    if (process.env.DBGTIME) console.log(JSON.stringify(C), 'ends', Math.round(tEnds), 'disp', Math.round(tDisp))
    if (process.env.DBGTIME) console.log('plan4 setup', Math.round(T1 - T0), 'loop', Math.round(T2 - T1), 'out', Math.round(performance.now() - T2))
    // the plan's expected end with the spread: each open task's path at its planned finish against the forecast
    let risk = 0
    if (process.env.RISK)
      for (let i = 0; i < n; i++) {
        if (state[i] === DONE || !(fin[i]! > 0)) continue
        const a = fin[i]! + tail[i]! - E[i]!
        const r = this.tv[i]! > 0 || Dv > 0 ? clarkMean(a, this.tv[i]!, D, Dv) : Math.max(a, D)
        if (r > risk) risk = r
      }
    return { asks, askFor, start, next, end: unplaced > 0 || open > 0 ? Infinity : end, held, waits, tags, firstX, firstTaskX, nextStart, nextTask, rel: u === undefined ? undefined : relOut, risk }
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
    const ROLL2 = process.env.ROLL === '2'
    const ROLL = process.env.ROLL === '1' || ROLL2
    let nextAsk = Infinity
    let pl: ReturnType<Engine['play']> | undefined
    let keepUntil = Infinity
    if (ROLL2) {
      const price = process.env.PRICE0 !== '1'
      let soonP = false
      let prep: Prep | undefined
      if (process.env.HOR && process.env.P3 && process.env.PREP) {
        // the tasks a list schedule starts within the horizon are planned exactly; the rest once, as listed
        let lead = 0
        for (let z = 0; z < this.sizes.length; z++) if (this.sizes[z]!.max > 0) lead = Math.max(lead, this.lead(z))
        const h = t + Number(process.env.HOR) * lead
        prep = { near: new Uint8Array(n), classify: true }
        this.plan3(t, D, fits, [], false, false, Dv, prep)
        const st = prep.far?.st
        if (st !== undefined) for (let i = 0; i < n; i++) prep.near[i] = st[i]! <= h ? 1 : 0
        prep = { near: prep.near }
      }
      const pick = <A extends { end: number; held: number }>(a: A, b: A): A => (b.end < a.end - 1e-6 || (b.end <= a.end + 1e-6 && b.held < a.held - 1e-6) ? b : a)
      const P = (extra: readonly number[] = [], eager = false) =>
        process.env.BOTH ? pick(this.plan3(t, D, fits, extra, eager, soonP, Dv, prep) as ReturnType<Engine['plan4']>, this.plan4(t, D, fits, extra, eager, Dv)) :
        process.env.P4 ? this.plan4(t, D, fits, extra, eager, Dv, uX === undefined ? undefined : Float64Array.from(uX)) : process.env.P3 ? this.plan3(t, D, fits, extra, eager, soonP, Dv, prep) : this.plan2(t, D, price, fits, extra, eager)
      let uX: Float64Array | undefined
      let noX = !!process.env.XAFTER
      const best = (): { p2: ReturnType<Engine['plan2']>; extra: number[] } => {
        let p2 = P()
        // one more worker asked now while that ends the run sooner, or as soon and holds less
        const extra = new Array<number>(this.sizes.length).fill(0)
        const cnt = new Array<number>(this.sizes.length).fill(0)
        for (const w of this.live()) cnt[w.size]!++
        if (process.env.SCAN) {
          // per size: how many asked now, of those the play would ask, ends the run soonest, then holds least
          for (let z = 0; z < this.sizes.length; z++) {
            const lazy = p2.asks.filter((a) => a[0] === z).length
            let bestK = 0
            for (let k = 1; k <= lazy && cnt[z]! + k <= this.sizes[z]!.max; k++) {
              extra[z] = k
              const r = P(extra)
              if (r.end < p2.end - 1e-6 || (r.end <= p2.end + 1e-6 && r.held < p2.held - 1e-6)) {
                p2 = r
                bestK = k
              }
            }
            extra[z] = bestK
          }
        }
        for (; !process.env.NOEXTRA && !noX && !process.env.SCAN; ) {
          let bz = -1
          let bp: typeof p2 | undefined
          for (let z = 0; z < this.sizes.length; z++) {
            if (cnt[z]! + extra[z]! >= this.sizes[z]!.max) continue
            extra[z]!++
            const r = P(extra)
            if (process.env.DBG3 && t < 1) console.log('  extra', extra.join(','), 'end', r.end / 1000, 'held', Math.round(r.held / 1000), 'base', (bp ?? p2).end / 1000, Math.round((bp ?? p2).held / 1000), 'asks', r.asks.map((a) => Math.round(a[1] / 1000)).join(','))
            extra[z]!--
            const ref = bp ?? p2
            // a worker asked now is one given work as it joins
            if (process.env.XUSE && (r as { waits?: boolean }).waits) continue
            if (r.end < ref.end - 1e-6 || (!process.env.XWALL && r.end <= ref.end + 1e-6 && r.held < ref.held - 1e-6)) {
              bz = z
              bp = r
            }
          }
          if (bz < 0) break
          extra[bz]!++
          p2 = bp!
        }
        if (process.env.EAGER2 && extra.every((x) => x === 0)) {
          const e2 = P([], true)
          if (e2.end < p2.end - 1e-6 || (e2.end <= p2.end + 1e-6 && e2.held < p2.held - 1e-6)) p2 = e2
        } else if (process.env.EAGER && p2.end > D + 1e-6 && extra.every((x) => x === 0)) {
          // late even so: a worker asked as soon as a task waits for room, if that ends the run sooner
          const e2 = P([], true)
          if (e2.end < p2.end - 1e-6) p2 = e2
        }
        return { p2, extra }
      }
      let r = best()
      const RST = Number(process.env.RST ?? 0)
      let plainP: typeof r.p2 | undefined
      if (RST > 0 && process.env.P3 && !process.env.P4) {
        plainP = r.p2
        let open = 0
        for (let i = 0; i < n; i++) if (state[i] !== DONE) open++
        const tries = Math.min(RST, Math.floor(Number(process.env.RSTB ?? 6400) / Math.max(1, open)))
        let seed = 1
        const rnd = (): number => (seed = (seed * 48271) % 2147483647) / 2147483647
        const u = new Float64Array(n)
        const base3 = r.p2
        const busyNow = (o: { start: [number, number][] }): number => {
          let c = 0
          for (const [i] of o.start) c += cEst[i]!
          return c
        }
        let chosen: Float64Array | undefined
        if (this.u3 !== undefined && process.env.KEEP3) {
          // the order a plan chose before, kept while it does no worse than the plain one
          const o = this.plan3(t, D, fits, r.extra, false, soonP, Dv, prep, this.u3) as typeof r.p2
          if (o.end <= r.p2.end + 1e-6 && o.held <= r.p2.held + 1e-6) {
            r = { p2: o, extra: r.extra }
            chosen = this.u3
          }
        }
        for (let k = 0; k < (chosen !== undefined && process.env.KEEP3 === '2' ? 0 : tries); k++) {
          for (let i = 0; i < n; i++) u[i] = rnd()
          const o = this.plan3(t, D, fits, r.extra, false, soonP, Dv, prep, u) as typeof r.p2
          // never a worker left emptier now than the plain plan leaves it (M 11-18: fill every core)
          if (process.env.FILL3 && busyNow(o) < busyNow(base3) - 1e-6) continue
          if (o.end < r.p2.end - 1e-6 || (o.end <= r.p2.end + 1e-6 && o.held < r.p2.held - 1e-6)) {
            r = { p2: o, extra: r.extra }
            chosen = Float64Array.from(u)
          }
        }
        if (process.env.DBGR3) console.log('r3', (t / 1000).toFixed(0), 'base', Math.round(base3.end / 1000), Math.round(base3.held / 4000), 'best', Math.round(r.p2.end / 1000), Math.round(r.p2.held / 4000), 'D', Math.round(D / 1000), 'tries', tries)
        this.u3 = chosen
      }
      if (RST > 0 && process.env.P4) {
        let open = 0
        for (let i = 0; i < n; i++) if (state[i] !== DONE) open++
        const tries = Math.min(RST, Math.floor(Number(process.env.RSTB ?? 6400) / Math.max(1, open)))
        let seed = 1
        const rnd = (): number => (seed = (seed * 48271) % 2147483647) / 2147483647
        const u = new Float64Array(n)
        let keep = false
        if (this.rel !== undefined) {
          // the releases a plan chose before: kept while that plan holds no more
          for (let i = 0; i < n; i++) u[i] = this.rel[i]! > t + 1e-6 ? this.rel[i]! : 0
          const o = this.plan4(t, D, fits, r.extra, false, Dv, u)
          if ((process.env.RISK ? Math.max(o.end, o.risk) <= Math.max(r.p2.end, r.p2.risk ?? 0) + 1e-6 : o.end <= r.p2.end + 1e-6) && o.held <= r.p2.held + 1e-6) {
            r = { p2: o, extra: r.extra }
            keep = true
          }
        }
        let chosenU: Float64Array | undefined
        if (!keep && this.prioU !== undefined && process.env.PKEEP) {
          this.rstMode = 1
          const o = this.plan4(t, D, fits, r.extra, false, Dv, Float64Array.from(this.prioU))
          this.rstMode = 0
          if (o.end <= r.p2.end + 1e-6 && o.held <= r.p2.held + 1e-6) {
            r = { p2: o, extra: r.extra }
            keep = true
            chosenU = this.prioU
          }
        }
        const base = r.p2
        const nowAsks = (o: { asks: [number, number][] }): number => o.asks.filter((a) => a[1] <= t + 1e-6).length
        const sc = (o: { end: number; risk?: number }): number => (process.env.RISK ? Math.max(o.end, o.risk ?? 0) : o.end)
        let chosen: Float64Array | undefined = keep && chosenU === undefined ? this.rel : undefined
        for (let k = 0; k < (keep && process.env.KEEPR ? 0 : tries); k++) {
          for (let i = 0; i < n; i++) u[i] = rnd() * (1 - 1e-9)
          this.rstMode = process.env.RSTP === '1' ? 1 : process.env.RSTP === '2' ? k % 2 : 0
          const o = this.plan4(t, D, fits, r.extra, false, Dv, u)
          const pm = this.rstMode === 1
          if (pm) o.rel = undefined
          this.rstMode = 0
          const oe = sc(o)
          const re = sc(r.p2)
          if (process.env.RSTNOASK && nowAsks(o) > nowAsks(base)) continue
          if (oe < re - 1e-6 || (oe <= re + 1e-6 && o.held < r.p2.held - 1e-6)) {
            r = { p2: o, extra: r.extra }
            chosen = o.rel
            chosenU = pm ? Float64Array.from(u) : undefined
          }
        }
        if (process.env.DBGR) console.log("rst", "nowB", nowAsks(base), "nowC", nowAsks(r.p2), (t / 1000).toFixed(0), 'keep', keep, 'end', Math.round(r.p2.end / 1000), 'held', Math.round(r.p2.held / 4000), 'chosen', chosen !== undefined)
        this.rel = chosen === undefined ? undefined : Float64Array.from(chosen)
        this.prioU = chosenU
        if (process.env.XAFTER) {
          // the extra workers judged against the chosen restart, not the bare plan
          noX = false
          uX = this.rel
          const rx = best()
          if (rx.extra.some((x) => x > 0)) r = rx
          uX = undefined
        }
      }
      if (process.env.TWO) {
        // the same with each task at its soonest end: whichever holds less
        soonP = true
        const r2 = best()
        if (r2.p2.end < r.p2.end - 1e-6 || (r2.p2.end <= r.p2.end + 1e-6 && r2.p2.held < r.p2.held - 1e-6)) r = r2
        else soonP = false
      }
      // idle workers: one the play gives no work within a warm-up leaves (asked again when needed), unless it
      // holds what a task to come reads, or the run cannot ask for its size while its platform has work left
      const openOn = new Int32Array(this.platforms)
      for (let i = 0; i < n; i++) if (state[i] !== DONE) openOn[plat[i]!]!++
      const busy = new Set(r.p2.start.map((x) => x[1]))
      let gone = false
      for (const w of this.live())
        if (
          w.joinedAt !== undefined &&
          w.run.size === 0 &&
          w.reserved.length === 0 &&
          !busy.has(w.ix) &&
          fits.stay?.(w.ix) !== true &&
          !(this.sizes[w.size]!.max <= 0 && openOn[sizePlat[w.size]!]! > 0)
        ) {
          const nx = r.p2.next.get(w) ?? Infinity
          if (process.env.DBGL) console.log('  idle', (t / 1000).toFixed(1), 'w', w.ix, 'next', (nx / 1000).toFixed(1))
          if (process.env.LEAVECMP) {
            // it leaves when the run without it ends no later and holds no more
            if (nx === Infinity) {
              w.leftAt = t
              leave.push(w.ix)
              gone = true
              continue
            }
            w.leftAt = t
            const r2 = best()
            // judged plain against plain: a restart's plan is the least of many draws
            const ref = plainP ?? r.p2
            if (r2.p2.end <= ref.end + 1e-6 && r2.p2.held <= ref.held + 1e-6) {
              leave.push(w.ix)
              r = r2
              plainP = r2.p2
            } else {
              w.leftAt = undefined
              keepUntil = Math.min(keepUntil, nx)
            }
            continue
          }
          if (nx - t >= this.warm(w.size)) {
            w.leftAt = t
            leave.push(w.ix)
            gone = true
          } else keepUntil = Math.min(keepUntil, nx)
        }
      if (gone) r = best()
      const p2 = r.p2
      if (process.env.DBG) console.log('decide', (t / 1000).toFixed(1), 'D', (D / 1000).toFixed(1), 'end', (p2.end / 1000).toFixed(1), 'asks', p2.asks.map((a) => (a[1] / 1000).toFixed(1)).join(','), 'start', p2.start.map(([i, w]) => i + 'c' + cEst[i] + '@' + w).join(','), 'extra', r.extra.join(','), 'leave', leave.join(','))
      const tagIx = new Map<number, number>()
      let xk = 0
      const firstX = (r.p2 as { firstX?: number[] }).firstX ?? []
      for (let z = 0; z < r.extra.length; z++)
        for (let k = 0; k < r.extra[z]!; k++) {
          const f = firstX[xk] ?? t
          // one the plan first gives work later than a warm-up from now is asked then
          if (process.env.FLEX && f > t + this.lead(z) + 1e-6) {
            if (f < Infinity) nextAsk = Math.min(nextAsk, f - this.lead(z))
            xk++
            continue
          }
          const wi = this.ask(z)
          const ft = (r.p2 as { firstTaskX?: number[] }).firstTaskX?.[xk]
          if (ft !== undefined && ft >= 0 && process.env.RESVX) this.workers[wi]!.for = ft
          tagIx.set(-1 - xk++, wi)
          asked.push([wi, z])
        }
      const nt = (p2 as { nextTask?: Map<Worker, number> }).nextTask
      if (process.env.RESVN && nt !== undefined)
        for (const w of this.live()) {
          if (w.for !== undefined && (state[w.for] === READY || state[w.for] === BLOCKED) && w.joinedAt === undefined) continue
          w.for = nt.get(w)
        }
      for (const [i, w] of p2.start) {
        const x = this.workers[w]!
        state[i] = RUNNING
        this.onWorker[i] = w
        this.progress[i] = 0
        this.startedAt[i] = t
        x.run.add(i)
        start.push([i, w])
      }
      p2.asks.forEach(([z, at], k) => {
        if (at <= t + 1e-6) {
          const wi = this.ask(z)
          const f = (p2 as { askFor?: number[] }).askFor?.[k]
          if (f !== undefined && process.env.RESV4) this.workers[wi]!.for = f
          tagIx.set(-1e6 - k, wi)
          asked.push([wi, z])
        } else nextAsk = Math.min(nextAsk, at)
      })
      // a task the plan starts later, with nothing else happening by then, starts at its time
      if (process.env.NEXTST) nextAsk = Math.min(nextAsk, (p2 as { nextStart?: number }).nextStart ?? Infinity)
      const tags = (p2 as { tags?: Float64Array }).tags
      if (process.env.DBG5 && Math.abs(t - Number(process.env.DBG5)) < 25000 && tags)
        console.log('  chosen', (t / 1000).toFixed(0), 'extra', r.extra.join(','), 'held', Math.round(p2.held / 1000), [...tags].map((g, i) => [i, g] as const).filter(([, g]) => g < 0 && g > -1e5).map(([i, g]) => i + '@' + g).join(' '))
      if (tags !== undefined)
        for (let i = 0; i < n; i++) {
          const g = tags[i]!
          this.planned[i] = Number.isNaN(g) ? -1 : g >= 0 ? g : (tagIx.get(g) ?? -1)
        }
      pl = { end: p2.end, stuck: 0, first: [], next: p2.next }
    } else if (ROLL) {
      // workers: one more of a size while the run, played forward, ends sooner by more than its warm-up
      const extra = new Array<number>(this.sizes.length).fill(0)
      const count = new Array<number>(this.sizes.length).fill(0)
      for (const w of this.live()) count[w.size]!++
      const open = new Uint8Array(this.platforms)
      for (let i = 0; i < n; i++) if (state[i] !== DONE) open[plat[i]!] = 1
      pl = this.play(t, extra)
      for (;;) {
        let bz = -1
        let bg = 0
        let bp: typeof pl | undefined
        for (let z = 0; z < this.sizes.length; z++) {
          if (open[sizePlat[z]!] === 0 || count[z]! + extra[z]! >= this.sizes[z]!.max) continue
          extra[z]!++
          const r = this.play(t, extra)
          extra[z]!--
          const gain = r.stuck < pl.stuck ? Infinity : pl.end - r.end
          const need = process.env.PRICE0 === '1' ? 1e-6 : this.price(z)
          if (gain > need && (gain > bg || (gain === bg && bz >= 0 && this.sizes[z]!.cores < this.sizes[bz]!.cores))) {
            bz = z
            bg = gain
            bp = r
          }
        }
        if (bz < 0) break
        extra[bz]!++
        pl = bp!
      }
      // ask now those given work as they join; the rest when their warm-up nears
      let k = 0
      for (let z = 0; z < extra.length; z++)
        for (let x = 0; x < extra[z]!; x++, k++) {
          const f = pl.first[k]!
          if (f <= t + this.warm(z) + 1e-6) asked.push([this.ask(z), z])
          else if (f < Infinity) nextAsk = Math.min(nextAsk, f - this.warm(z))
        }
    }
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
    for (const i of ROLL2 ? [] : ready) {
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
        if (ROLL) break
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
    for (const i of ROLL ? [] : soon) {
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
    for (const w of this.live())
      if (
        !ROLL2 &&
        joined(w) &&
        w.run.size === 0 &&
        w.reserved.length === 0 &&
        fits.stay?.(w.ix) !== true &&
        left.some((x) => x > 0) &&
        !(this.sizes[w.size]!.max <= 0 && left[sizePlat[w.size]!]! > 0)
      ) {
        const r = ROLL ? (pl!.next.get(w) ?? Infinity) : (demandOn.get(w) ?? Infinity)
        if (r - t >= this.warm(w.size)) {
          w.leftAt = t
          leave.push(w.ix)
        } else keepUntil = Math.min(keepUntil, r)
      }
    const due = Math.min(nextAsk > t + 1e-6 ? nextAsk : Infinity, keepUntil > t + 1e-6 ? keepUntil : Infinity)
    return { start, ask: asked, leave, due }
  }
}
