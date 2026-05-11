// Shared error types used across modules to distinguish user-input
// failures (clean message only) from internal bugs (full stack trace).
//
// `bin.ts` consults `instanceof UserError` to decide what to print.

export class UserError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UserError'
  }
}
