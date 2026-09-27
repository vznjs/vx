/**
 * One request with Turbo's retry rule (`turborepo-api-client/src/retry.rs`):
 * a 429 or a 5xx other than 501, or a request that never connected, is
 * sent again after a backoff — 2 s, or a 429's `Retry-After` capped at
 * 10 s. Without it one 503 from a gateway read as a miss and the task ran
 * again. A spent deadline is not retried, unlike Turbo's reads: it has
 * already cost its wait, and a hung server would cost it twice. Every
 * request both wires make is idempotent (content-addressed, and Nx's
 * second write is a 409 the caller takes as done), so a resend applies
 * nothing twice. Shared by `turboCache()` and `nxCache()`.
 */
export async function withRetry(
  send: () => Promise<Response>,
  retries: number,
  wait: (ms: number) => Promise<void> = Bun.sleep,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response
    try {
      res = await send()
    } catch (err) {
      if (attempt >= retries || !neverConnected(err)) throw err
      await wait(BACKOFF_MS)
      continue
    }
    if (attempt >= retries || !retryable(res.status)) return res
    const delay = res.status === 429 ? (retryAfterMs(res) ?? BACKOFF_MS) : BACKOFF_MS
    await res.body?.cancel()
    await wait(delay)
  }
}

const BACKOFF_MS = 2_000
const MAX_RETRY_AFTER_MS = 10_000

function retryable(status: number): boolean {
  return status === 429 || (status >= 500 && status !== 501)
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
