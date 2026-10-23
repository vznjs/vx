import { expect, it } from 'bun:test'
import { Trace } from '../src/trace.js'

interface Ev {
  ph: string
  name: string
  cat?: string
  pid: number
  tid: number
  ts?: number
  dur?: number
  args?: Record<string, unknown>
}

const events = (t: Trace, end: number): Ev[] => t.events(end) as unknown as Ev[]

it('a task takes the first row free over its time; idle is what tasks leave of a worker’s time online', () => {
  const t = new Trace()
  t.joined('w', 0)
  t.slice({ track: 'w', name: 'a', cat: 'task', from: 10, to: 30 })
  t.slice({ track: 'w', name: 'b', cat: 'task', from: 20, to: 40 })
  t.slice({ track: 'w', name: 'c', cat: 'task', from: 30, to: 35 })
  t.left('w', 'left', 50)
  const ev = events(t, 60)
  const rows = Object.fromEntries(
    ev.filter((e) => e.ph === 'X' && e.cat === 'task').map((e) => [e.name, e.tid]),
  )
  expect(rows).toEqual({ a: 1, b: 2, c: 1 })
  expect(ev.filter((e) => e.name === 'idle').map((e) => [e.tid, e.ts, e.dur])).toEqual([
    [0, 0, 10_000],
    [0, 40_000, 10_000],
  ])
  expect(ev.find((e) => e.ph === 'i')).toMatchObject({ name: 'left', pid: 2, ts: 50_000 })
})

it('a worker’s warm-up splits at the wall-clock time its vx booted', () => {
  const t = new Trace()
  const now = performance.now()
  t.joined('w', now, now - 10_000, Date.now() - 2_000)
  const ev = events(t, now)
  const warm = ev.filter((e) => e.ph === 'X' && e.cat === 'worker')
  expect(warm.map((e) => e.name)).toEqual(['warm-up', 'machine start', 'vx boot + join'])
  expect(Math.round(warm[1]!.dur! / 1e6)).toBe(8)
  expect(Math.round(warm[2]!.dur! / 1e6)).toBe(2)
})

it('a worker’s cores counter sums what its tasks booked and used at once', () => {
  const t = new Trace()
  t.use({ track: 'w', from: 0, to: 10, booked: 2, used: 0 })
  t.use({ track: 'w', from: 5, to: 15, booked: 1.5, used: 0 })
  t.use({ track: 'w', from: 5, to: 10, booked: 0, used: 0.7 })
  const counters = events(t, 20)
    .filter((e) => e.ph === 'C')
    .map((e) => [e.ts, e.args])
  expect(counters.at(-1)).toEqual([15_000, { booked: 0, used: 0 }])
  expect(counters.filter(([ts]) => ts === 5_000).at(-1)).toEqual([
    5_000,
    { booked: 3.5, used: 0.7 },
  ])
})
