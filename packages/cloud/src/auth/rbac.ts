// Principal resolution + role checks (docs/design/cloud-platform-2026-07.md
// §6.3, §6.5). ONE middleware turns a request into a Principal (session
// cookie or bearer token); route handlers declare their requirement through
// the helpers here — there is exactly one place that maps principals to org
// capabilities.

import type { SQL } from 'bun'
import { readCookie, resolveSession, sessionCacheKey, SESSION_COOKIE } from './sessions.js'
import { lookupToken, type TokenPrincipal } from './tokens.js'

export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer'

export interface SessionPrincipal {
  kind: 'session'
  userId: string
  email: string
  displayName: string
  instanceAdmin: boolean
  /** org id → role, from org_memberships. */
  orgs: Map<string, OrgRole>
}

export type AuthPrincipal = SessionPrincipal | TokenPrincipal

const ROLE_RANK: Record<OrgRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 }

export function roleAtLeast(role: OrgRole, min: OrgRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min]
}

/**
 * The role a principal exercises within an org, or null when it has none.
 * Token mapping (§6.4/§6.5): an `admin` token acts as org admin; a `ci`
 * token acts as member (read + push, never admin mutations). An instance
 * admin acts as owner everywhere.
 */
export function orgRoleOf(p: AuthPrincipal, orgId: string): OrgRole | null {
  if (p.kind === 'token') {
    if (p.orgId !== orgId) return null
    return p.tokenKind === 'admin' ? 'admin' : 'member'
  }
  if (p.instanceAdmin) return 'owner'
  return p.orgs.get(orgId) ?? null
}

export function hasOrgRole(p: AuthPrincipal, orgId: string, min: OrgRole): boolean {
  const role = orgRoleOf(p, orgId)
  return role !== null && roleAtLeast(role, min)
}

/**
 * Short-TTL memo of resolved session principals — the session analog of the
 * token memo in tokens.ts (same TTL, bound, and clear-on-revoke pattern).
 * The dashboard polls several /v1 reads every 5-30s per open tab, and each
 * session request did four Postgres round-trips (session SELECT, sliding
 * renewal UPDATE, user SELECT, memberships SELECT). Keyed by the sha256
 * session id-hash — never the raw cookie value. Unlike a token, a session
 * principal's CONTENTS can change (role grants, memberships, rename), so
 * every route that mutates them clears the memo in-process (see routes.ts);
 * cross-replica staleness is bounded by the TTL, the token memo's accepted
 * property. A memo hit also skips the sliding-renewal write — harmless:
 * renewal is a 30-day window and the memo is 5s. Each entry's expiry is
 * capped at the session row's OWN `expiresAt` (the token memo's expires_at
 * cap); today the cap can't bind — renewal guarantees ≥15d remaining — but
 * it keeps the memo correct if the renewal policy ever changes. A null
 * (unknown/expired session) is cached for the full TTL: ids are 256-bit
 * server-minted randoms, so a presented unknown id never becomes valid.
 */
const SESSION_CACHE_TTL_MS = 5_000
const SESSION_CACHE_MAX = 10_000
const sessionCache = new Map<string, { principal: SessionPrincipal | null; expiresAt: number }>()

/** Drop the whole session memo — membership/role/profile mutations (rare
 *  admin actions; a full clear is obviously correct vs tracking
 *  user→sessions), and tests. */
export function resetSessionPrincipalCache(): void {
  sessionCache.clear()
}

/** Drop ONE session's memoized principal — logout, where the cookie in hand
 *  identifies exactly the entry to kill (revocation must beat the TTL). */
export function forgetSessionPrincipal(secret: string, cookieValue: string): void {
  const key = sessionCacheKey(secret, cookieValue)
  if (key !== null) sessionCache.delete(key)
}

/** Store a session-cache entry, bounding the map so it can't grow unbounded. */
function rememberSession(key: string, principal: SessionPrincipal | null, expiresAt: number): void {
  if (sessionCache.size >= SESSION_CACHE_MAX) sessionCache.clear()
  sessionCache.set(key, { principal, expiresAt })
}

/**
 * Resolve the request's principal: `Authorization: Bearer vxc_…` (API token)
 * first, else the session cookie. null = unauthenticated. A disabled user's
 * session resolves to null even while the row lives.
 */
export async function resolvePrincipal(
  sql: SQL,
  secret: string,
  req: Request,
  now: number = Date.now(),
): Promise<AuthPrincipal | null> {
  const header = req.headers.get('authorization')
  if (header !== null && header.startsWith('Bearer ')) {
    return await lookupToken(sql, header.slice(7), now)
  }
  const cookie = readCookie(req, SESSION_COOKIE)
  if (cookie === null) return null
  // Tampered cookies fail the HMAC gate here — never memoized, no DB read
  // (the same pre-DB rejection resolveSession applies).
  const key = sessionCacheKey(secret, cookie)
  if (key === null) return null
  const cached = sessionCache.get(key)
  if (cached !== undefined && cached.expiresAt > now) return cached.principal
  const session = await resolveSession(sql, secret, cookie, now)
  if (session === null) {
    rememberSession(key, null, now + SESSION_CACHE_TTL_MS)
    return null
  }
  const principal = await sessionPrincipalFor(sql, session.userId)
  rememberSession(key, principal, Math.min(now + SESSION_CACHE_TTL_MS, session.expiresAt))
  return principal
}

/** Load a user's principal (memberships + flags); null for disabled/missing. */
export async function sessionPrincipalFor(
  sql: SQL,
  userId: string,
): Promise<SessionPrincipal | null> {
  const users = await sql<
    { email: string; display_name: string; instance_admin: boolean; disabled_at: string | null }[]
  >`
    SELECT email, display_name, instance_admin, disabled_at FROM users WHERE id = ${userId}`
  const user = users[0]
  if (user === undefined || user.disabled_at !== null) return null
  const memberships = await sql<{ org_id: string; role: OrgRole }[]>`
    SELECT org_id, role FROM org_memberships WHERE user_id = ${userId}`
  return {
    kind: 'session',
    userId,
    email: user.email,
    displayName: user.display_name,
    instanceAdmin: user.instance_admin,
    orgs: new Map(memberships.map((m) => [m.org_id, m.role])),
  }
}

/**
 * CSRF gate (§6.1): a state-changing SESSION-authenticated request must carry
 * the SPA's `x-vx-csrf: 1` custom header (forces a CORS preflight a
 * cross-site form can't produce). Token principals skip it — a bearer is not
 * an ambient credential.
 */
export function csrfOk(p: AuthPrincipal, req: Request): boolean {
  if (p.kind === 'token') return true
  return req.headers.get('x-vx-csrf') !== null
}
