import type { RemoteKey } from '@vzn/vx'

/**
 * The bucket a request means (owner, 2026-10-18): `trusted` for a task's
 * own key, else the branch scope its key was derived in. It only states
 * intent; a server checks it against the caller's identity (a CI ID
 * token). A request without it (a plugin entry naming no bucket, or an
 * older client) leaves the layering to the server. Shared by
 * `turboCache()` and `nxCache()`.
 */
export function scopeHeader(at: RemoteKey | undefined): Record<string, string> {
  if (at?.scope === null) return {}
  return { 'x-vx-cache-scope': at?.scope ?? 'trusted' }
}
