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
  setTimeout(
    () => controller.abort(new Error(`no answer within ${timeoutMs} ms`)),
    timeoutMs,
  ).unref()
  return controller.signal
}
