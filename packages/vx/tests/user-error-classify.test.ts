// `isUserError` is how bin.ts and the scheduler decide between "print the
// message" and "print a stack / call it an internal error". A compiled vx
// carries core inside it while a workspace plugin imports @vzn/vx from
// node_modules, so a plugin's UserError is a DIFFERENT class object and
// `instanceof` is false across the copy boundary — reproduced through the
// real binary on 2026-09-03 (a plugin verb's refusal printed with a stack).
// The name is the contract that survives.

import { describe, expect, it } from 'bun:test'
import { isUserError, UserError } from '../src/util/index.js'

/** What a UserError from ANOTHER copy of core looks like: same shape, foreign class. */
class ForeignUserError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UserError'
  }
}

describe('isUserError', () => {
  it('accepts this copy and a foreign copy alike, by name', () => {
    expect(isUserError(new UserError('x'))).toBe(true)
    expect(isUserError(new ForeignUserError('x'))).toBe(true)
    expect(new ForeignUserError('x') instanceof UserError).toBe(false) // the reason this helper exists
  })
  it('CONTROL: a plain Error, a renamed one, and a non-error are not user errors', () => {
    expect(isUserError(new Error('x'))).toBe(false)
    expect(isUserError(new TypeError('x'))).toBe(false)
    expect(isUserError(Object.assign(new Error('x'), { name: 'UserErrorish' }))).toBe(false)
    expect(isUserError({ name: 'UserError', message: 'x' })).toBe(false)
    expect(isUserError('UserError')).toBe(false)
  })
})
