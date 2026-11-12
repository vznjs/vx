import { describe, expect, it } from 'bun:test'

import { type Bin, dispatch, type Need, Queue } from '../src/plan/dispatch.js'
import type { Strategy } from '../src/plan/strategy.js'

// The live run's waiting tasks kept across its passes (`Queue`): each pass
// places exactly as `dispatch` placed over the whole list, read in order.

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type B = Bin & { used: { cores: number; memory: number } }

const bin = (id: string, cores: number, memory: number, platform?: string): B => ({
  id,
  cores,
  memory,
  used: { cores: 0, memory: 0 },
  running: 0,
  has: new Set(),
  platform,
})

describe('Queue', () => {
  for (const order of ['critical-path', 'fifo', 'graphene'] as const)
    for (const seed of [1, 2, 3, 4, 5, 6])
      it(`places as dispatch over the whole list (${order}, seed ${seed})`, () => {
        const r = rng(seed * 7919)
        const how: Strategy = {
          order,
          place: (['best-fit', 'worst-fit', 'first-fit', 'tetris'] as const)[seed % 4]!,
          book: 'measured',
          scale: 'plan',
        }
        const platforms = seed % 2 === 0 ? ['linux', 'darwin'] : [undefined]
        const needs = new Map<string, Need>()
        const tails = new Map<string, number>()
        const gates = new Map<string, 'wait' | 'done' | { only?: string }>()
        // Booked cores shrink as the run learns, the same for every need.
        let scale = 1
        const book = (n: Need): Need =>
          n.ask !== undefined || n.cores === Infinity ? n : { ...n, cores: n.cores * scale }
        const need = (id: string): Need => needs.get(id)!
        const tail = (id: string): number => tails.get(id)!
        const bins: B[] = []
        for (let i = 0; i < 6; i++)
          bins.push(
            bin(
              `w${i}`,
              [2, 4, 8, 16][Math.floor(r() * 4)]!,
              16e9,
              platforms[i % platforms.length],
            ),
          )
        const q = new Queue(how, tail, need)
        let list: string[] = []
        let n = 0
        for (let step = 0; step < 400; step++) {
          const front = r() < 0.15
          const added: string[] = []
          for (let k = Math.floor(r() * 6); k > 0; k--) {
            const id = `t${n++}`
            const x = r()
            needs.set(id, {
              cores: x < 0.1 ? Infinity : Math.round(r() * 160) / 10 + 0.1,
              memory: Math.floor(r() * 16) * 1e9,
              platform: platforms[Math.floor(r() * platforms.length)],
              ...(x > 0.9 ? { above: { cores: 4, memory: 8e9 } } : {}),
              ...(x > 0.8 && x <= 0.9 ? { ask: { cores: 1, memory: 1e9 } } : {}),
            })
            tails.set(id, Math.floor(r() * 5) * 1000)
            if (r() < 0.1) gates.set(id, r() < 0.5 ? 'wait' : 'done')
            else if (r() < 0.05) gates.set(id, { only: `w${Math.floor(r() * 6)}` })
            added.push(id)
          }
          if (front) list.unshift(...added)
          else list.push(...added)
          q.add(added, front)
          if (list.length > 0 && r() < 0.1) {
            const gone = list[Math.floor(r() * list.length)]!
            list = list.filter((id) => id !== gone)
            expect(q.delete(gone)).toBe(true)
          }
          if (r() < 0.05) gates.clear()
          if (r() < 0.05) scale = 0.4 + r() * 0.6
          // Tasks end: their workers free up.
          for (const b of bins)
            if (r() < 0.4) {
              b.used.cores = 0
              b.used.memory = 0
              b.running = 0
            }
          const o = {
            book,
            deps: () => [],
            gate: (id: string) => gates.get(id) ?? {},
            waits: () => r() < 0.5,
          }
          const copy = (): B[] => bins.map((b) => ({ ...b, used: { ...b.used } }))
          const wr = rng(step)
          const was = dispatch(list, copy(), {
            how,
            tail,
            need,
            ...o,
            waits: () => wr() < 0.5,
          })
          const into = copy()
          const qr = rng(step)
          const to = q.pass(into, { ...o, waits: () => qr() < 0.5 })
          expect([...to].map(([id, b]) => `${id}>${b.id}`).sort()).toEqual(
            [...was.to].map(([id, b]) => `${id}>${b.id}`).sort(),
          )
          list = was.left
          expect(q.size).toBe(list.length)
          expect([...q.ids()].sort()).toEqual([...list].sort())
          for (let i = 0; i < bins.length; i++) {
            bins[i]!.used.cores = into[i]!.used.cores
            bins[i]!.used.memory = into[i]!.used.memory
            bins[i]!.running = into[i]!.running
          }
        }
      })

  // 2026-11-06: each pass read every waiting task, where a class of them
  // no worker had room for could be passed whole.
  it('reads none of a class no worker has room for', () => {
    const needs = new Map<string, Need>()
    const ids: string[] = []
    for (let i = 0; i < 1000; i++) {
      ids.push(`t${i}`)
      needs.set(`t${i}`, { cores: 2 + (i % 10) / 10, memory: 1e9, platform: 'linux' })
    }
    const q = new Queue(
      { order: 'critical-path', place: 'best-fit', book: 'measured', scale: 'plan' },
      () => 0,
      (id) => needs.get(id)!,
    )
    q.add(ids)
    const full = { ...bin('l', 4, 16e9, 'linux'), used: { cores: 3, memory: 0 }, running: 1 }
    let read = 0
    const to = q.pass([full], {
      deps: () => [],
      gate: () => {
        read++
        return {}
      },
    })
    expect([to.size, read, q.size]).toEqual([0, 0, 1000])
    // Room again: the first takes it.
    full.used.cores = 0
    full.running = 0
    expect([...q.pass([full], { deps: () => [] }).keys()]).toEqual(['t0', 't10'])
  })
})

// A ready task no worker fits keeps the room it frees: unheld, a smaller
// task of lower rank took each core as it freed and the critical path
// waited 6 s (main 2163fff, 2026-11-10).
describe('a ready task that fits nowhere', () => {
  const how: Strategy = {
    order: 'critical-path',
    place: 'best-fit',
    book: 'measured',
    scale: 'plan',
  }
  const needs = new Map<string, Need>([
    ['crit', { cores: 1.5, memory: 1e8 }],
    ['fill', { cores: 0.7, memory: 1e8 }],
    ['blind', { cores: 0.7, memory: 1e8 }],
  ])
  const tails = new Map([
    ['crit', 60_000],
    ['fill', 40_000],
    ['blind', 30_000],
  ])
  const ms = (id: string): number | undefined => (id === 'blind' ? undefined : tails.get(id))
  // 2.8 of 4 cores used: 0.3 frees in 50 ms, then 1.5 fits.
  const busy = (): B => ({
    ...bin('w0', 4, 16e9),
    used: { cores: 2.8, memory: 4e8 },
    running: 4,
    ends: [
      [60_000, 1, 1e8],
      [60_000, 1, 1e8],
      [2_000, 0.5, 1e8],
      [50, 0.3, 1e8],
    ],
  })
  const o = {
    how,
    tail: (id: string) => tails.get(id)!,
    need: (id: string) => needs.get(id)!,
    deps: () => [],
    ms,
    soon: [],
  }
  it('is not passed by one of lower rank', () => {
    expect([...dispatch(['crit', 'fill'], [busy()], o).to.keys()]).toEqual([])
    const q = new Queue(how, o.tail, o.need)
    q.add(['crit', 'fill'])
    expect([...q.pass([busy()], o).keys()]).toEqual([])
  })
  it('is passed by one of no history', () => {
    expect([...dispatch(['crit', 'blind'], [busy()], o).to.keys()]).toEqual(['blind'])
  })
})
