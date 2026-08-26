import { describe, expect, it } from 'bun:test'
import { UserError } from '../src/util/errors.js'

describe('UserError', () => {
  it('is an Error instance with the supplied message', () => {
    const e = new UserError('bad config')
    expect(e instanceof Error).toBe(true)
    expect(e.message).toBe('bad config')
    expect(e.name).toBe('UserError')
  })

  it('is distinguishable from a plain Error (so bin.ts can branch on it)', () => {
    expect(new UserError('x') instanceof UserError).toBe(true)
    expect(new Error('x') instanceof UserError).toBe(false)
  })
})
