import { expect, it } from 'bun:test'
import { assign, ordered, type Bin } from '../src/dispatch.ts'
import { plan, simulate, type PlanTask, type PlanWorker, type Size } from '../src/planner.ts'
import { STRATEGIES, type Strategy } from '../src/strategy.ts'

const UNKNOWN_MS = 30_000

// The play-out as its rule reads, with none of the pruning that keeps it
// fast: every ready task ordered and asked each step, no kinds, no bounds.
function reference(tasks: readonly PlanTask[], workers: readonly PlanWorker[], how: Strategy) {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const running = new Set(workers.flatMap((w) => w.running.flatMap((r) => r.id ?? [])))
  const dependants = new Map<string, string[]>()
  const waits = new Map<string, number>()
  for (const t of tasks) {
    let n = 0
    for (const d of t.deps)
      if (byId.has(d) || running.has(d)) {
        n++
        dependants.set(d, [...(dependants.get(d) ?? []), t.id])
      }
    waits.set(t.id, n)
  }
  const tails = new Map<string, number>()
  const tail = (id: string): number => {
    let t = tails.get(id)
    if (t === undefined) {
      t = Math.max(0, ...(dependants.get(id) ?? []).map(tail)) + (byId.get(id)!.ms ?? UNKNOWN_MS)
      tails.set(id, t)
    }
    return t
  }
  type Slot = Bin & { at: number; platform: string | undefined }
  const slots: Slot[] = workers.map((w) => ({
    id: w.id,
    cores: w.cores,
    memory: w.memory,
    platform: w.platform,
    at: w.at,
    used: { cores: 0, memory: 0 },
    running: 0,
  }))
  const ends: [number, Slot, number, number, string | undefined][] = []
  workers.forEach((w, i) => {
    for (const r of w.running) {
      slots[i]!.used.cores += r.cores
      slots[i]!.used.memory += r.memory
      slots[i]!.running++
      ends.push([Math.max(0, r.endsIn), slots[i]!, r.cores, r.memory, r.id])
    }
  })
  const widest = Math.max(1, ...workers.map((w) => w.cores))
  let ready: string[] = []
  let joining = tasks.filter((t) => waits.get(t.id) === 0).map((t) => t.id)
  let left = tasks.length
  let now = 0
  let last = Math.max(0, ...ends.map((e) => e[0]))
  for (;;) {
    ready = ordered([...ready, ...joining], how.order, tail, (id) => byId.get(id)!, widest)
    joining = []
    const later = (above: { cores: number; memory: number }, platform?: string): boolean =>
      slots.some(
        (s) =>
          s.at > now &&
          (platform === undefined || s.platform === platform) &&
          (s.cores > above.cores || s.memory > above.memory),
      )
    const asks = ready.map((id) => ({ id, need: byId.get(id)! }))
    const joined = slots.filter((s) => s.at <= now)
    const to = assign(asks, joined, later, how.place)
    for (const [id, best] of to) {
      const t = byId.get(id)!
      const end = now + (t.ms ?? UNKNOWN_MS)
      ends.push([end, best, Math.min(t.cores, best.cores), Math.min(t.memory, best.memory), id])
      last = Math.max(last, end)
    }
    ready = ready.filter((id) => !to.has(id))
    if (left === 0 && ready.length === 0) return last
    let next = Infinity
    for (const e of ends) next = Math.min(next, e[0])
    for (const s of slots) if (s.at > now) next = Math.min(next, s.at)
    if (next === Infinity) return left === 0 ? last : Infinity
    now = next
    for (let i = 0; i < ends.length;) {
      const [at, s, cores, memory, id] = ends[i]!
      if (at > now) {
        i++
        continue
      }
      ends.splice(i, 1)
      s.used.cores -= cores
      s.used.memory -= memory
      s.running--
      if (id === undefined) continue
      if (byId.has(id)) left--
      for (const d of dependants.get(id) ?? []) {
        waits.set(d, waits.get(d)! - 1)
        if (waits.get(d) === 0) joining.push(d)
      }
    }
  }
}

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32
  }
}

const GB = 2 ** 30

function scenario(seed: number): { tasks: PlanTask[]; workers: PlanWorker[]; how: Strategy } {
  const r = rng(seed)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!
  const platforms = [undefined, undefined, 'linux-x64', 'darwin-arm64']
  // Few kinds or as many as tasks: both ways `Ready` reads its asks.
  const exact = r() < 0.5
  const n = 1 + Math.floor(r() * (exact ? 80 : 30))
  const tasks: PlanTask[] = []
  for (let i = 0; i < n; i++) {
    const deps: string[] = []
    for (let j = 0; j < i; j++) if (r() < 3 / (i + 1)) deps.push(`t${j}`)
    if (r() < 0.1) deps.push(`r${Math.floor(r() * 3)}`)
    tasks.push({
      id: `t${i}`,
      cores: r() < 0.05 ? Infinity : exact ? 0.1 + r() * 6 : pick([0.25, 1, 2, 4, 8]),
      memory: r() < 0.05 ? Infinity : exact ? r() * 8 * GB : pick([0.5, 2, 4, 16]) * GB,
      ms: r() < 0.15 ? undefined : pick([1, 1_000, 5_000, 20_000, 60_000]) * (exact ? 1 + r() : 1),
      deps,
      ...(r() < 0.1 ? { above: { cores: pick([2, 4]), memory: pick([4, 8]) * GB } } : {}),
      ...(r() < 0.15 ? { platform: pick(platforms) } : {}),
    })
  }
  const workers: PlanWorker[] = []
  const w = 1 + Math.floor(r() * 5)
  for (let i = 0; i < w; i++) {
    const running = Array.from({ length: Math.floor(r() * 3) }, (_, k) => ({
      ...(r() < 0.5 ? { id: `r${(i + k) % 3}` } : {}),
      cores: pick([0.5, 1, 2]),
      memory: GB,
      endsIn: Math.floor(r() * 30_000),
    }))
    workers.push({
      id: `w${i}`,
      cores: pick([2, 4, 8]),
      memory: pick([4, 8, 16]) * GB,
      at: r() < 0.5 ? 0 : Math.floor(r() * 40_000),
      running,
      idle: running.length === 0,
      ...(r() < 0.3 ? { platform: pick(platforms) } : {}),
    })
  }
  const how: Strategy = {
    order: pick(STRATEGIES.order),
    place: pick(STRATEGIES.place),
    book: 'measured',
    scale: 'plan',
  }
  return { tasks, workers, how }
}

it('plays random runs out as its rule does, unpruned', () => {
  for (let seed = 1; seed <= Number(process.env['SEEDS'] ?? 3000); seed++) {
    const { tasks, workers, how } = scenario(seed)
    const want = reference(tasks, workers, how)
    const got = simulate(tasks, workers, how)
    if (got !== want) throw new Error(`seed ${seed} (${JSON.stringify(how)}): ${got} ≠ ${want}`)
  }
  expect(true).toBe(true)
})

// A worker it lets go between two of its size's tasks is one the run can
// start again: the arm worker of a max-1 size was let go with its size's
// starts spent, and the next arm task found none (2026-10-25).
it('ends random runs by the deadline it gives, letting go only idle or starting workers', () => {
  // Each plan plays the run out a few dozen times: fewer seeds, as long.
  for (let seed = 1; seed <= Number(process.env['SEEDS'] ?? 500); seed++) {
    const { tasks, how } = scenario(seed)
    const r = rng(seed)
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!
    const sizes: Size[] = [
      { name: 'linux', max: Math.floor(r() * 3), cpu: 4, memory: 16 * GB, platform: 'linux-x64' },
      { name: 'mac', max: Math.floor(r() * 3), cpu: 4, memory: 8 * GB, platform: 'darwin-arm64' },
      { name: 'any', max: Math.floor(r() * 3), cpu: 2, memory: 8 * GB },
    ]
    const workers = Array.from({ length: Math.floor(r() * 4) }, (_, i): PlanWorker => {
      const size = pick(sizes)
      const starting = r() < 0.3
      const running =
        starting || r() < 0.5 ? [] : [{ cores: 1, memory: GB, endsIn: Math.floor(r() * 20_000) }]
      return {
        id: `w${i}`,
        cores: size.cpu,
        memory: size.memory,
        platform: size.platform,
        size: size.name,
        at: starting ? Math.floor(r() * 20_000) : 0,
        running,
        idle: !starting && running.length === 0,
        ...(starting ? { starting: true } : {}),
      }
    })
    const next = sizes.flatMap((s) => Array.from({ length: s.max }, () => s))
    const limit = r() < 0.3 ? Math.floor(r() * 100_000) : Infinity
    const p = plan(tasks, workers, next, 20_000, r() < 0.8, limit, how)
    const why = `seed ${seed} (${JSON.stringify(how)})`
    const free = new Set(workers.filter((w) => w.idle || w.starting).map((w) => w.id))
    for (const id of p.release) if (!free.has(id)) throw new Error(`${why}: let ${id} go busy`)
    if (p.endsInMs > p.boundMs) throw new Error(`${why}: ends ${p.endsInMs} > ${p.boundMs}`)
  }
  expect(true).toBe(true)
})
