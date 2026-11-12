// The planner on graph families, not on vx's own runs: a run should end
// at its longest chain after one warm-up, the critical path never
// waiting for a worker, on the least worker time that allows. Exact history; seeded, so each number is fixed.
import { expect, it } from 'bun:test'
import { layered, random, run, trap, type Task } from './families.js'

// Over ten graphs a family, each ends by its chain and one warm-up, not a
// second later, and its worker time on its floor (all its work on
// cores, one warm-up) is at most `cost`. Wall time first, then worker time.
const families: [name: string, cores: number, make: (r: () => number) => Task[], cost: number][] = [
  ['random', 4, (r) => random(r, 40, 0.05, 4), 1.4],
  ['dense', 4, (r) => random(r, 80, 0.15, 4), 1.67],
  ['layered', 4, (r) => layered(r, 6, 12, 4), 1.55],
  ['wide', 8, (r) => layered(r, 3, 40, 8), 1.55],
  ['trap', 4, (r) => trap(r, 10, 30, 4), 1.35],
]

for (const [name, cores, make, cost] of families)
  it(`${name} graphs end at their chain on little worker time`, () => {
    let spent = 0
    let floor = 0
    for (let seed = 1; seed <= 10; seed++) {
      const r = run(cores, make, seed)
      expect({ seed, lateMs: Math.max(0, r.lateMs) }).toEqual({ seed, lateMs: 0 })
      spent += r.spent
      floor += r.floor
    }
    expect(spent / floor).toBeLessThanOrEqual(cost)
  })

// A third of the tasks of no history, each guessed at 30 s: a chain
// through one has no slack the plan can prove, so it starts as it gets
// ready. Waiting on the guess, the plan before ended 3.5 to 13% late on
// average. A guessed task books what it guesses and slows
// what shares its worker, so one graph moves a family's average: wide
// seed 9 went from 12% to 18% with ready holds, while 30 more seeds
// went from 9.9% to 9.5%. A big worker's last work moved to a small one
// and the plan's own placing followed: 2.4 to 5.7%.
for (const [name, cores, make] of families)
  it(`${name} graphs a third unmeasured end within 6% of their chain`, () => {
    let late = 0
    for (let seed = 1; seed <= 10; seed++) late += run(cores, make, seed, 0.3).late / 10
    expect(late).toBeLessThanOrEqual(0.06)
  })

// Each task 30% off its history either way: placed at its latest start, a
// task that ran slow ended the run late, 5.2, 6.8, 5.3, 7 and 11% past
// the chain. Its room sought with a margin on its chain, on 0-3% more
// worker time.
const hedged: Record<string, number> = { random: 4, dense: 6, layered: 2, wide: 6, trap: 8 }
for (const [name, cores, make] of families)
  it(`${name} graphs 30% off their history end within ${hedged[name]}% of their chain`, () => {
    let late = 0
    let chain = 0
    for (let seed = 1; seed <= 10; seed++) {
      const r = run(cores, make, seed, 0, 0.3)
      late += Math.max(0, r.lateMs)
      chain += r.chain
    }
    expect((100 * late) / chain).toBeLessThanOrEqual(hedged[name]!)
  })
