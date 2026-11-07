// A server's CPU, learned per dependant from looks that name exactly who ran.
import { expect, it } from 'bun:test'
import { serverFit } from '../src/server-fit.js'

const truth = { base: 0.5, a: 1.5, b: 0.1 }
const used = (users: string[]) => truth.base + users.reduce((s, u) => s + truth[u as 'a' | 'b'], 0)

it('learns the base and each dependant’s own cost from mixed looks', () => {
  const fit = serverFit()
  const mixes = [['a'], ['b'], ['a', 'b'], []]
  for (let i = 0; i < 400; i++) {
    const users = mixes[i % mixes.length]!
    fit.sample('db', users, used(users), 1000, false)
  }
  const m = fit.model('db')!
  expect(m.base).toBeCloseTo(truth.base, 1)
  expect(m.cost.get('a')).toBeCloseTo(truth.a, 1)
  expect(m.cost.get('b')).toBeCloseTo(truth.b, 1)
})

it('charges each look’s cores to who ran: the base evenly, the rest by cost', () => {
  const fit = serverFit()
  const mixes = [['a'], ['b'], ['a', 'b'], []]
  for (let i = 0; i < 400; i++) {
    const users = mixes[i % mixes.length]!
    fit.sample('db', users, used(users), 1000, false)
  }
  fit.take('a')
  fit.take('b')
  fit.sample('db', ['a', 'b'], 2.1, 1000, false)
  const a = fit.take('a')
  const b = fit.take('b')
  // All 2100 core-ms are charged, none twice.
  expect(a + b).toBeCloseTo(2100, 6)
  expect(a / 2100).toBeCloseTo((0.25 + 1.5) / 2.1, 1)
  expect(b / 2100).toBeCloseTo((0.25 + 0.1) / 2.1, 1)
  // Taken: nothing is charged twice.
  expect(fit.take('a')).toBe(0)
})

it('reads a look on a full machine as a floor: it raises the model, never lowers it', () => {
  const fit = serverFit()
  for (let i = 0; i < 100; i++) fit.sample('db', ['a'], 3, 1000, false)
  const before = fit.model('db')!.cost.get('a')!
  // The machine was full: the server got 1 core, it asked for more.
  for (let i = 0; i < 100; i++) fit.sample('db', ['a'], 1, 1000, true)
  expect(fit.model('db')!.cost.get('a')).toBe(before)
  for (let i = 0; i < 100; i++) fit.sample('db', ['a'], 4, 1000, true)
  expect(fit.model('db')!.cost.get('a')!).toBeGreaterThan(before)
})

it('charges a look with no user to no one', () => {
  const fit = serverFit()
  fit.sample('db', [], 1, 1000, false)
  expect(fit.take('a')).toBe(0)
})
