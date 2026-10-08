import { expect, it } from 'bun:test'
import { regressions } from '../regress.js'

it('reports each timing that grew past the tolerance, and nothing else', () => {
  const prior = [
    { runner: 'vx', version: 'a', fresh: 1000, warmNoRestore: 100, warmRestore: 200 },
    { runner: 'turbo', version: 'b', fresh: 1000, warmNoRestore: 100, warmRestore: 200 },
  ]
  const next = [
    { runner: 'vx', version: 'c', fresh: 1100, warmNoRestore: 111, warmRestore: 150 },
    { runner: 'nx', version: 'd', fresh: 9000, warmNoRestore: 900, warmRestore: 900 },
  ]
  expect(regressions(prior, next)).toEqual(['vx warmNoRestore: 100 → 111 ms (+11%)'])
  expect(regressions(prior, next, 0.05)).toEqual([
    'vx fresh: 1000 → 1100 ms (+10%)',
    'vx warmNoRestore: 100 → 111 ms (+11%)',
  ])
})

it('skips a timing either side lacks or measured as NaN', () => {
  const prior = [{ runner: 'vx', fresh: NaN, warmRestore: 100 }]
  const next = [{ runner: 'vx', fresh: 500, warmRestore: NaN, topEdited: 900 }]
  expect(regressions(prior, next)).toEqual([])
})
