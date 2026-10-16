/**
 * When a remote's rate limit ends, shared by every request to that remote:
 * Turbo's `RateLimit` (`turborepo-api-client/src/retry.rs`; tests
 * `waits_for_known_cooldown_before_initial_send`,
 * `scopes_artifact_cooldowns_to_client_team_and_token`). A request that
 * starts inside it waits it out before its first send instead of spending
 * a try on a 429. One per wire instance: a client, its server and token.
 */
export class Cooldown {
  until = 0
  constructor(private readonly now: () => number = Date.now) {}

  /** Ms left of the limit, 0 when there is none. */
  left(): number {
    return Math.max(0, this.until - this.now())
  }

  extend(ms: number): void {
    this.until = Math.max(this.until, this.now() + ms)
  }
}

/**
 * One request with Turbo's retry rule (`turborepo-api-client/src/retry.rs`):
 * a 5xx other than 501, or a request that never connected, is sent again
 * after 2 s, `retries` times. A 429 opens the remote's `cooldown` for its
 * `Retry-After` (capped at 10 s a wait, 2 s without one), and the request
 * is resent once it ends, as often as fits in 20 s from its first 429: a
 * limit longer than one capped wait lost every hit before (Growth's
 * parity run, 2026-10-16). A spent deadline is not retried, unlike
 * Turbo's reads: it has already cost its wait, and a hung server would
 * cost it twice. Every request both wires make is idempotent
 * (content-addressed, and Nx's second write is a 409 the caller takes as
 * done), so a resend applies nothing twice. Shared by `turboCache()` and
 * `nxCache()`.
 */
export async function withRetry(
  send: () => Promise<Response>,
  retries: number,
  wait: (ms: number) => Promise<void> = Bun.sleep,
  cooldown: Cooldown = new Cooldown(),
  now: () => number = Date.now,
): Promise<Response> {
  let firstLimit: number | undefined
  for (let attempt = 0; ;) {
    const held = cooldown.left()
    if (held > 0) await wait(held)
    let res: Response
    try {
      res = await send()
    } catch (err) {
      if (attempt >= retries || !neverConnected(err)) throw err
      attempt++
      await wait(BACKOFF_MS)
      continue
    }
    if (res.status === 429) {
      firstLimit ??= now()
      const delay = retryAfterMs(res) ?? BACKOFF_MS
      if (retries === 0 || now() + delay - firstLimit > RATE_LIMIT_BUDGET_MS) return res
      cooldown.extend(delay)
      await res.body?.cancel()
      continue
    }
    if (attempt >= retries || !retryable(res.status)) return res
    attempt++
    await res.body?.cancel()
    await wait(BACKOFF_MS)
  }
}

const BACKOFF_MS = 2_000
const MAX_RETRY_AFTER_MS = 10_000
const RATE_LIMIT_BUDGET_MS = 20_000

function retryable(status: number): boolean {
  return status >= 500 && status !== 501
}

/** A refused port or an unresolved host, as Bun's `fetch` codes them (measured on 1.4.2). */
function neverConnected(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return code === 'ConnectionRefused' || code === 'ENOTFOUND'
}

/** `Retry-After` as seconds or an HTTP date, capped as Turbo caps it. */
function retryAfterMs(res: Response): number | undefined {
  const v = res.headers.get('retry-after')
  if (v === null) return undefined
  const ms = /^\d+$/.test(v.trim()) ? Number(v) * 1000 : Date.parse(v) - Date.now()
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS) : undefined
}
