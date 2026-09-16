// `isUserError` is how bin.ts and the scheduler decide between "print the
// message" and "print a stack / call it an internal error". A compiled vx
// carries core inside it while a workspace plugin imports @vzn/vx from
// node_modules, so a plugin's UserError is a DIFFERENT class object and
// `instanceof` is false across the copy boundary — reproduced through the
// real binary on 2026-09-03 (a plugin verb's refusal printed with a stack).
// The name is the contract that survives.

import { describe, expect, it } from 'bun:test'
import {
  fsRefusalHint,
  isDiskFull,
  isFsRefusal,
  isPermissionError,
  isUserError,
  UserError,
} from '../src/util/index.js'

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

describe('isPermissionError', () => {
  const errno = (code: string): NodeJS.ErrnoException =>
    Object.assign(new Error(`${code}: nope`), { code })

  it('is the file system refusing a write: EACCES, EPERM, EROFS', () => {
    for (const code of ['EACCES', 'EPERM', 'EROFS'])
      expect(isPermissionError(errno(code))).toBe(true)
  })

  it('CONTROL: a missing path, a plain Error, a UserError and a non-error are not', () => {
    expect(isPermissionError(errno('ENOENT'))).toBe(false)
    expect(isPermissionError(new Error('EACCES: in the text only'))).toBe(false)
    expect(isPermissionError(new UserError('x'))).toBe(false)
    expect(isPermissionError({ code: 'EACCES' })).toBe(false)
  })
})

describe('isDiskFull and the refusal hint', () => {
  const errno = (code: string): NodeJS.ErrnoException =>
    Object.assign(new Error(`${code}: nope`), { code })

  it('is the file system out of room: ENOSPC, EDQUOT — and a refusal either way', () => {
    for (const code of ['ENOSPC', 'EDQUOT']) {
      expect(isDiskFull(errno(code))).toBe(true)
      expect(isFsRefusal(errno(code))).toBe(true)
      expect(fsRefusalHint(errno(code))).toBe('the disk that path is on is full')
    }
    expect(fsRefusalHint(errno('EACCES'))).toBe('a path vx must write is not writable by this user')
  })

  it('CONTROL: a permission code is not a full disk; EIO is neither', () => {
    expect(isDiskFull(errno('EACCES'))).toBe(false)
    expect(isPermissionError(errno('ENOSPC'))).toBe(false)
    expect(isFsRefusal(errno('EIO'))).toBe(false)
    expect(isDiskFull(new Error('ENOSPC in the text only'))).toBe(false)
  })
})
