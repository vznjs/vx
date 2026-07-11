// Password hashing (docs/design/cloud-platform-2026-07.md §6.1): Bun's
// built-in argon2id — memory-hard, zero deps. The hash string embeds its own
// algorithm + parameters, so future parameter bumps verify old hashes fine.

export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: 'argon2id' })
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(password, hash)
  } catch {
    // A malformed stored hash must read as "wrong password", not a 500.
    return false
  }
}

let dummyHashPromise: Promise<string> | undefined
/**
 * A real argon2id hash (live params) used to equalize login timing for an
 * unknown email: verifying a supplied password against it costs a full argon2
 * pass, so login latency does not reveal whether the email is registered.
 * Memoized — computed once, then reused.
 */
export function dummyPasswordHash(): Promise<string> {
  dummyHashPromise ??= hashPassword('vx-cloud-timing-equalizer-not-a-secret')
  return dummyHashPromise
}
