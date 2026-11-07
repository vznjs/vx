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

it('charges each dependant its own cost’s part, never the server’s base', () => {
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
  expect(a).toBeCloseTo(1500, -2)
  expect(b).toBeCloseTo(100, -2)
  // Taken: nothing is charged twice.
  expect(fit.take('a')).toBe(0)
  // The base is the server's: reported for the worker to book once.
  expect(fit.bases().db).toBeCloseTo(0.5, 1)
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

it('with no look free of dependants, charges them all and learns no base', () => {
  const fit = serverFit()
  for (let i = 0; i < 50; i++) fit.sample('db', ['a'], 1, 1000, false)
  expect(fit.model('db')!.base).toBe(0)
  // Once the model has it: every core-ms to the one who made it.
  fit.take('a')
  fit.sample('db', ['a'], 1, 1000, false)
  expect(fit.take('a')).toBeCloseTo(1000, 0)
})
