/**
 * A request's deadline, named. The runtime's abort says "The operation
 * timed out." and nothing else; core's degrade line already names the
 * request, the artifact and the server, so the cause names the deadline
 * that was spent. Shared by `turboCache()` and `nxCache()`.
 */
export function deadlineNamed(err: unknown, timeoutMs: number): unknown {
  return (err as { name?: unknown } | null)?.name === 'TimeoutError'
    ? new Error(`no answer within ${timeoutMs} ms`)
    : err
}
