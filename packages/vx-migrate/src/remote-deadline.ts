/**
 * A request's deadline, named. The runtime's abort says "The operation
 * timed out." and nothing else; core's degrade line already names the
 * request, the artifact and the server, so the cause names the deadline
 * that was spent. The name rides the signal's reason, not a catch around
 * `fetch`: the deadline covers the body too, and a body read past it
 * (core's ingest, the signed download's temp) rejects with the reason
 * (measured on Bun 1.4.2), where a catch around `fetch` never saw it.
 * Unref'd, as `AbortSignal.timeout`'s timer is. Shared by `turboCache()`
 * and `nxCache()`.
 */
export function deadline(timeoutMs: number): AbortSignal {
  const controller = new AbortController()
  // A timer past 2^31-1 ms fires after 1 ms: a 30-day
  // TURBO_REMOTE_CACHE_TIMEOUT aborted every request as it started.
  setTimeout(
    () => controller.abort(new Error(`no answer within ${timeoutMs} ms`)),
    Math.min(timeoutMs, MAX_TIMER_MS),
  ).unref()
  return controller.signal
}

const MAX_TIMER_MS = 2 ** 31 - 1
