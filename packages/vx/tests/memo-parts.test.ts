// One way to declare what a memo's answer depends on (util/memo-parts.ts):
// every field of the input is declared, so a field added to it is a type
// error at the memo until the declaration says how it moves the answer.

import { expect, it } from 'bun:test'
import { memoParts, onlyAbsent, unread } from '../src/util/index.js'

interface Input {
  a: string
  b?: number | undefined
  c: readonly string[]
  skip?: true
  note: string
}

const PARTS = memoParts<Input, string>({
  a: (a) => a,
  b: (b, _of, ctx) => `${ctx}${b ?? '-'}`,
  c: (c) => (c.includes('?') ? undefined : c.join(',')),
  skip: onlyAbsent('a skipped input is never remembered'),
  note: unread('display only'),
})

it('pushes each declared part in declaration order, and no unread one', () => {
  const out: string[] = []
  expect(PARTS.push({ a: 'x', b: 2, c: ['p', 'q'], note: 'n' }, '#', out)).toBe(true)
  expect(out).toEqual(['x', '#2', 'p,q'])
})

it('moves the token with each part and not with an unread field', () => {
  const base: Input = { a: 'x', c: [], note: 'n' }
  const t = PARTS.token('v1', base, '')
  expect(t).toBe(PARTS.token('v1', { ...base, note: 'other' }, ''))
  for (const moved of [
    PARTS.token('v2', base, ''),
    PARTS.token('v1', { ...base, a: 'y' }, ''),
    PARTS.token('v1', { ...base, b: 1 }, ''),
    PARTS.token('v1', { ...base, c: ['z'] }, ''),
    PARTS.token('v1', base, 'ctx'),
  ])
    expect(moved).not.toBe(t)
})

it('answers nothing for a set only-absent field or a part that cannot vouch', () => {
  expect(PARTS.token('v1', { a: 'x', c: [], note: '', skip: true }, '')).toBeUndefined()
  expect(PARTS.token('v1', { a: 'x', c: ['?'], note: '' }, '')).toBeUndefined()
  expect(PARTS.push({ a: 'x', c: ['?'], note: '' }, '', [])).toBe(false)
})

it('drops the parts another token names, keeping the only-absent checks', () => {
  const rest = PARTS.without(['a', 'c', 'skip'])
  const out: string[] = []
  expect(rest.push({ a: 'x', c: ['?'], note: '' }, '', out)).toBe(true)
  expect(out).toEqual(['-'])
  expect(rest.push({ a: 'x', c: [], note: '', skip: true }, '', [])).toBe(false)
})

it('refuses a declaration that leaves a field out (checked by the type check)', () => {
  // @ts-expect-error `note` is not declared
  memoParts<Input, string>({ a: (a) => a, b: () => '', c: () => '', skip: onlyAbsent('') })
})
