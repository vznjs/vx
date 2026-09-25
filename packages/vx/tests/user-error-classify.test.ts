// `isUserError` is how bin.ts and the scheduler decide between "print the
// message" and "print a stack / call it an internal error". A compiled vx
// carries core inside it while a workspace plugin imports @vzn/vx from
// node_modules, so a plugin's UserError is a DIFFERENT class object and
// `instanceof` is false across the copy boundary — reproduced through the
// real binary on 2026-09-03 (a plugin verb's refusal printed with a stack).
// The name is the contract that survives.

import { afterAll, describe, expect, it } from 'bun:test'
import {
  fsRefusalHint,
  gitSpawnRefusal,
  isDiskFull,
  isExecutableMissing,
  isFsRefusal,
  isPermissionError,
  isTmpdirRefusal,
  isUserError,
  UserError,
} from '../src/util/index.js'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

  it('a permission code is a refusal too', () => {
    for (const code of ['EACCES', 'EPERM', 'EROFS']) expect(isFsRefusal(errno(code))).toBe(true)
  })

  it('CONTROL: a permission code is not a full disk; EIO is neither', () => {
    expect(isDiskFull(errno('EACCES'))).toBe(false)
    expect(isPermissionError(errno('ENOSPC'))).toBe(false)
    expect(isFsRefusal(errno('EIO'))).toBe(false)
    expect(isDiskFull(new Error('ENOSPC in the text only'))).toBe(false)
  })
})

describe('a git that could not be spawned', () => {
  // Every git call site tells "git is not installed" from "git ran and
  // failed" by this predicate; read as always-true, a git that exits
  // non-zero would say "install git".
  it('is ENOENT from the spawn, and nothing else', () => {
    expect(isExecutableMissing(Object.assign(new Error('not found'), { code: 'ENOENT' }))).toBe(
      true,
    )
    expect(isExecutableMissing(Object.assign(new Error('nope'), { code: 'EACCES' }))).toBe(false)
    expect(isExecutableMissing(new Error('ENOENT in the text only'))).toBe(false)
    expect(isExecutableMissing(undefined)).toBe(false)
    expect(isExecutableMissing(null)).toBe(false)
  })

  it('is one UserError naming the directory it ran in', () => {
    const err = gitSpawnRefusal('/work/repo')
    expect(err).toBeInstanceOf(UserError)
    expect(err.message).toBe(
      "vx requires git: failed to spawn 'git' (working dir: /work/repo). Install git and re-run.",
    )
  })
})

describe('isTmpdirRefusal', () => {
  // `os.tmpdir()` reads TMPDIR on every call, so each row points it at a
  // directory of its own and puts it back. The root is canonical: the
  // symlinked one is built on purpose where it is the subject.
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'vx-tmpdir-classify-')))
  const real = path.join(root, 'real')
  const link = path.join(root, 'link')
  mkdirSync(real)
  symlinkSync(real, link)
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  const errno = (code: string, at: string | undefined, message = `${code}: nope`) =>
    Object.assign(new Error(message), at === undefined ? { code } : { code, path: at })
  const withTmpdir = <T>(dir: string, body: () => T): T => {
    const saved = process.env.TMPDIR
    process.env.TMPDIR = dir
    try {
      return body()
    } finally {
      if (saved === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = saved
    }
  }

  it('is a missing, not-a-directory or unwritable path under the temp directory', () => {
    withTmpdir(real, () => {
      for (const code of ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EROFS'])
        expect(isTmpdirRefusal(errno(code, path.join(real, 'srt-obs-1')))).toBe(true)
    })
  })

  it('CONTROL: another code, a path elsewhere, and a non-error are not', () => {
    withTmpdir(real, () => {
      expect(isTmpdirRefusal(errno('EIO', path.join(real, 'x')))).toBe(false)
      expect(isTmpdirRefusal(errno('ENOSPC', path.join(real, 'x')))).toBe(false)
      expect(isTmpdirRefusal(errno('ENOENT', path.join(root, 'elsewhere')))).toBe(false)
      expect(isTmpdirRefusal({ code: 'ENOENT', path: path.join(real, 'x') })).toBe(false)
    })
  })

  it('reads the path when the error carries one, the message only when it does not', () => {
    withTmpdir(real, () => {
      const inTmp = path.join(real, 'x')
      expect(isTmpdirRefusal(errno('ENOENT', undefined, `ENOENT: mkdtemp '${inTmp}'`))).toBe(true)
      expect(
        isTmpdirRefusal(errno('ENOENT', path.join(root, 'elsewhere'), `ENOENT: see '${inTmp}'`)),
      ).toBe(false)
    })
  })

  it('a TMPDIR reached through a symlink matches the name as given AND the resolved one', () => {
    // macOS: /tmp is /private/tmp, and an error may name either side.
    withTmpdir(link, () => {
      expect(isTmpdirRefusal(errno('ENOENT', path.join(link, 'x')))).toBe(true)
      expect(isTmpdirRefusal(errno('ENOENT', path.join(real, 'x')))).toBe(true)
      expect(isTmpdirRefusal(errno('ENOENT', path.join(root, 'elsewhere')))).toBe(false)
    })
  })

  it('a TMPDIR that does not exist still matches the name as given', () => {
    const gone = path.join(root, 'gone')
    withTmpdir(gone, () => {
      expect(isTmpdirRefusal(errno('ENOENT', path.join(gone, 'x')))).toBe(true)
    })
  })
})
