import { expect, it } from 'bun:test'
import { failure, parseArm, roundOrder, summarize } from '../ab.js'

it('parses an arm, the workspace after the last @', () => {
  expect(parseArm('main=/tmp/vx@next/bin@/tmp/w')).toEqual({
    label: 'main',
    vx: '/tmp/vx@next/bin',
    workspace: '/tmp/w',
  })
})

it('refuses an arm missing its label, vx or workspace', () => {
  for (const bad of ['/tmp/vx@/tmp/w', '=/tmp/vx@/tmp/w', 'a=@/tmp/w', 'a=/tmp/vx@', 'a=/tmp/vx']) {
    expect(() => parseArm(bad)).toThrow(`arm "${bad}" is not <label>=<vx>@<workspace>`)
  }
})

it('rotates the order each round, so every arm leads once per cycle', () => {
  expect([0, 1, 2, 3].map((r) => roundOrder(r, 3))).toEqual([
    [0, 1, 2],
    [1, 2, 0],
    [2, 0, 1],
    [0, 1, 2],
  ])
})

it('summarizes min and median, odd and even counts', () => {
  expect(summarize([30, 10, 20])).toEqual({ min: 10, median: 20 })
  expect(summarize([40, 10, 30, 20])).toEqual({ min: 10, median: 25 })
})

it("a failed run's error carries vx's stdout, where the failed task is reported", () => {
  const out = `${'x\n'.repeat(50)}◼︎ astro#build — failed (exit 1)\n`
  const msg = failure('main', 1, out, '')
  expect(msg.split('\n')[0]).toBe('main exited 1')
  expect(msg.split('\n').at(-1)).toBe('◼︎ astro#build — failed (exit 1)')
  expect(msg.split('\n').length).toBe(41)
  expect(failure('aa', 2, '', 'boom')).toBe('aa exited 2\nboom')
})
