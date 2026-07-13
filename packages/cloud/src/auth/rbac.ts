// Principal resolution + role checks (docs/design/cloud-platform-2026-07.md
// §6.3, §6.5). ONE middleware turns a request into a Principal (session
// cookie or bearer token); route handlers declare their requirement through
// the helpers here — there is exactly one place that maps principals to org
// capabilities.

import type { SQL } from 'bun'
import { readCookie, resolveSession, SESSION_COOKIE } from './sessions.js'
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
  const session = await resolveSession(sql, secret, cookie, now)
  if (session === null) return null
  return await sessionPrincipalFor(sql, session.userId)
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
