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
