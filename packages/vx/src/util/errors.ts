// Shared error types used across modules to distinguish user-input
// failures (clean message only) from internal bugs (full stack trace).
//
// `bin.ts` and the scheduler consult `isUserError` to decide what to print.

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
