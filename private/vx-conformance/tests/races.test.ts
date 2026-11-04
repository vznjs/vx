import { expect, test } from 'bun:test'
import { everyPlay } from '../src/harness.ts'

test('a raced case fails on the first losing play and plays no more', async () => {
  const seen: number[] = []
  const results = ['pass', 'fail', 'pass'] as const
  const out = await everyPlay(3, async (i) => {
    seen.push(i)
    return { status: results[i]! }
  })
  expect(out).toEqual({ status: 'fail', detail: 'play 2 of 3' })
  expect(seen).toEqual([0, 1])
})

test('a raced case passes only when every play passes', async () => {
  expect(await everyPlay(3, async () => ({ status: 'pass' }))).toEqual({ status: 'pass' })
})
