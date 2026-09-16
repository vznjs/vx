// Shared error types used across modules to distinguish user-input
// failures (clean message only) from internal bugs (full stack trace).
//
// `bin.ts` and the scheduler consult `isUserError` to decide what to print.

import os from 'node:os'

export class UserError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UserError'
  }
}

/**
 * `instanceof UserError`, plus the same class arriving from ANOTHER COPY of
 * core. A compiled `vx` binary carries core inside it while a plugin in the
 * workspace imports `@vzn/vx` from node_modules, so a plugin's `UserError`
 * is a different class object and `instanceof` is false — a plugin verb's
 * "bad flag --x" printed as `UserError: bad flag --x` with a stack, and a
 * REAPI refusal would have read as an "internal error" (reproduced through
 * the real binary, 2026-09-03). The name is the contract that survives the
 * copy boundary.
 */
export function isUserError(err: unknown): err is UserError {
  return err instanceof UserError || (err instanceof Error && err.name === 'UserError')
}

/**
 * An `EACCES`, `EPERM` or `EROFS` from the file system: a path vx must
 * write is not this user's to write (a root-owned `.vx`, a read-only
 * checkout). The environment's failure, reported like a UserError — one
 * line naming the path — never as an internal error with a stack.
 */
export function isPermissionError(err: unknown): err is NodeJS.ErrnoException {
  if (!(err instanceof Error)) return false
  const code = (err as NodeJS.ErrnoException).code
  return code === 'EACCES' || code === 'EPERM' || code === 'EROFS'
}

/** What follows the path in a permission error's one line. */
export const PERMISSION_HINT = 'a path vx must write is not writable by this user'

/** `ENOSPC` or `EDQUOT`: the disk a path is on is full. */
export function isDiskFull(err: unknown): err is NodeJS.ErrnoException {
  if (!(err instanceof Error)) return false
  const code = (err as NodeJS.ErrnoException).code
  return code === 'ENOSPC' || code === 'EDQUOT'
}

/** A file system refusing a write for a reason no code path caused: permission or space. */
export function isFsRefusal(err: unknown): err is NodeJS.ErrnoException {
  return isPermissionError(err) || isDiskFull(err)
}

export const DISK_FULL_HINT = 'the disk that path is on is full'

/** The one-line hint after a refusal's path. */
export function fsRefusalHint(err: NodeJS.ErrnoException): string {
  return isDiskFull(err) ? DISK_FULL_HINT : PERMISSION_HINT
}

/**
 * A spawn that could not run at all — Bun throws `ENOENT` ("Executable not
 * found in $PATH") synchronously from `Bun.spawn` and `Bun.spawnSync` alike.
 * Every git call site tells it from a git that ran and failed, because the
 * remedy differs: install git, not "git init".
 */
export function isExecutableMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT'
}

/**
 * The one refusal for a git that is not on PATH, wherever vx needed it — a
 * `--affected` base, the input enumeration, a watch judgement. A minimal
 * image without git met a stack from `defaultAffectedBase` before
 * (2026-09-16); the enumeration had this line and the others did not.
 */
export function gitSpawnRefusal(cwd: string): UserError {
  return new UserError(
    `vx requires git: failed to spawn 'git' (working dir: ${cwd}). Install git and re-run.`,
  )
}

export const TMPDIR_HINT = 'point TMPDIR at a writable directory'

/**
 * A temp-directory refusal: the path is under `os.tmpdir()` and the error
 * says it is missing, a file, or not writable. The knob is TMPDIR, and a
 * line that names the path should name the knob — a minimal image's
 * sandboxed task said "EACCES … mkdtemp '/tmp/…/srt-obs-…'" and nothing
 * else (2026-09-16). Only for a site whose path IS the temp directory by
 * construction: a workspace under /tmp would pass the path test too.
 */
export function isTmpdirRefusal(err: unknown): err is NodeJS.ErrnoException {
  if (!(err instanceof Error)) return false
  const code = (err as NodeJS.ErrnoException).code
  if (code !== 'ENOENT' && code !== 'ENOTDIR' && !isPermissionError(err)) return false
  const p = (err as NodeJS.ErrnoException).path
  return (typeof p === 'string' ? p : err.message).includes(os.tmpdir())
}
