// `/v1/auth/*` + `/v1/admin/*` — accounts, sessions, invites, org/member/
// token/workspace administration (docs/design/cloud-platform-2026-07.md §6).
// All validation happens here at the boundary; handlers speak plain JSON.
// These routes deliberately send NO CORS headers (§6.1): cookies are
// same-origin credentials and the SPA is served by the platform itself.

import { createHash, randomBytes } from 'node:crypto'
import type { SQL } from 'bun'
import { dummyPasswordHash, hashPassword, verifyPassword } from './passwords.js'
import {
  createSession,
  destroySession,
  readCookie,
  SESSION_COOKIE,
  sessionClearCookie,
  sessionSetCookie,
} from './sessions.js'
import {
  createApiToken,
  listTokens,
  resetTokenCache,
  revokeToken,
  type TokenKind,
  type TrustTier,
} from './tokens.js'
import {
  csrfOk,
  forgetSessionPrincipal,
  hasOrgRole,
  orgRoleOf,
  resetSessionPrincipalCache,
  resolvePrincipal,
  type AuthPrincipal,
  type OrgRole,
} from './rbac.js'

/** Serializes the first-user bootstrap so two concurrent registers on a
 *  fresh instance can't both become instance admin. MUST stay distinct from
 *  every other advisory key (MIGRATION_LOCK_KEY, INDEX_LOCK_KEY) — a shared key
 *  cross-couples subsystems and deadlocks (see db/indexes.ts). Exported only so
 *  a test can pin the distinctness. */
export const BOOTSTRAP_LOCK_KEY = 0x76786302

const INVITE_PREFIX = 'vxi_'
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

const SLUG_RE = /^[a-z0-9-]{1,64}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const ORG_ROLES: readonly OrgRole[] = ['owner', 'admin', 'member', 'viewer']

function sha256(s: string): Buffer {
  return createHash('sha256').update(s).digest()
}

function json(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return Response.json(body, { status, ...(headers !== undefined ? { headers } : {}) })
}

/**
 * Per-IP+email login throttle with exponential backoff (§6.1). In-memory and
 * single-node by design; a reverse proxy adds real rate limiting (§9).
 */
/** Thrown inside the invite-accept transaction to roll the atomic claim back
 *  (a non-org invite, or an already-a-member dup) so the invite is not burned;
 *  translated to an HTTP response by the handler. */
class InviteRollback extends Error {
  constructor(
    readonly status: number,
    readonly publicMessage: string,
  ) {
    super(publicMessage)
  }
}

export interface LoginThrottle {
  /** ms until the next attempt is allowed; 0 = allowed now. */
  retryAfterMs(key: string): number
  fail(key: string): void
  succeed(key: string): void
}

/** Backoff caps: doubling from 1s, ceiling 5min. An entry is dead once its
 *  backoff window has fully elapsed (and then some) — safe to evict. */
const THROTTLE_MAX_DELAY_MS = 5 * 60 * 1000
/** Hard cap on tracked keys — the endpoint is pre-auth, so an attacker
 *  spraying distinct keys must never grow the map without bound. */
const THROTTLE_MAX_KEYS = 50_000

export function createLoginThrottle(
  now: () => number = Date.now,
  maxKeys: number = THROTTLE_MAX_KEYS,
): LoginThrottle & { size(): number } {
  const fails = new Map<string, { count: number; lastAt: number }>()
  // An entry is expired once now is past its last attempt + the max backoff:
  // it can no longer be throttling anything, so it is pure memory.
  const expired = (f: { lastAt: number }): boolean => now() - f.lastAt > THROTTLE_MAX_DELAY_MS
  return {
    retryAfterMs(key) {
      const f = fails.get(key)
      if (f === undefined) return 0
      const delay = Math.min(1000 * 2 ** (f.count - 1), THROTTLE_MAX_DELAY_MS)
      return Math.max(0, f.lastAt + delay - now())
    },
    fail(key) {
      const f = fails.get(key)
      fails.set(key, { count: (f?.count ?? 0) + 1, lastAt: now() })
      if (fails.size > maxKeys) {
        // Sweep expired entries first; if still over cap, drop the oldest
        // (Map preserves insertion order — the head is the least-recent write).
        for (const [k, v] of fails) {
          if (expired(v)) fails.delete(k)
        }
        while (fails.size > maxKeys) {
          const oldest = fails.keys().next().value
          if (oldest === undefined) break
          fails.delete(oldest)
        }
      }
    },
    succeed(key) {
      fails.delete(key)
    },
    size: () => fails.size,
  }
}

export interface AuthRoutesContext {
  sql: SQL
  /** VX_CLOUD_SECRET — session-cookie HMAC key. */
  secret: string
  /** Secure cookie attribute (the base URL is https). */
  secureCookies: boolean
  /** Public origin; invite URLs are minted against it. */
  baseUrl: string
  openSignup: boolean
  openOrgCreate: boolean
  throttle: LoginThrottle
  now?: () => number
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = (await req.json()) as unknown
    return body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function str(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key]
  return typeof v === 'string' && v !== '' ? v : undefined
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string }
  return e?.code === '23505' || /duplicate key|unique constraint/i.test(e?.message ?? '')
}

interface OrgRow {
  id: string
  slug: string
  name: string
}

async function orgById(sql: SQL, orgId: string): Promise<OrgRow | null> {
  if (!UUID_RE.test(orgId)) return null
  const rows = await sql<OrgRow[]>`SELECT id, slug, name FROM organizations WHERE id = ${orgId}`
  return rows[0] ?? null
}

/**
 * Gate an org-scoped admin surface: 404 for an unknown org OR a principal
 * with no standing in it (existence is not leaked cross-org), 403 for a
 * member whose role is insufficient, null = pass.
 */
function orgGate(p: AuthPrincipal, org: OrgRow | null, min: OrgRole): Response | null {
  if (org === null) return json({ error: 'not found' }, 404)
  const role = orgRoleOf(p, org.id)
  if (role === null) return json({ error: 'not found' }, 404)
  if (!hasOrgRole(p, org.id, min)) return json({ error: `requires org ${min}` }, 403)
  return null
}

function principalResponse(p: AuthPrincipal): unknown {
  if (p.kind === 'token') {
    return {
      kind: 'token',
      orgId: p.orgId,
      ...(p.workspaceId !== undefined ? { workspaceId: p.workspaceId } : {}),
      tier: p.tier,
      tokenKind: p.tokenKind,
    }
  }
  return {
    kind: 'session',
    userId: p.userId,
    email: p.email,
    displayName: p.displayName,
    instanceAdmin: p.instanceAdmin,
    orgs: [...p.orgs.entries()].map(([orgId, role]) => ({ orgId, role })),
  }
}

/**
 * Handle `/v1/auth/*` and `/v1/admin/*`. Returns null when the path belongs
 * to neither prefix (the caller falls through to other surfaces).
 */
export async function handleAuthRoutes(
  req: Request,
  url: URL,
  ctx: AuthRoutesContext,
): Promise<Response | null> {
  const p = url.pathname
  if (p.startsWith('/v1/auth/')) return await authRoute(req, url, ctx)
  if (p.startsWith('/v1/admin/')) return await adminRoute(req, url, ctx)
  return null
}

async function authRoute(req: Request, url: URL, ctx: AuthRoutesContext): Promise<Response> {
  const now = ctx.now?.() ?? Date.now()
  const { sql } = ctx

  if (url.pathname === '/v1/auth/register' && req.method === 'POST') {
    const body = await readBody(req)
    if (body === null) return json({ error: 'invalid JSON body' }, 400)
    const email = str(body, 'email')?.toLowerCase()
    const password = str(body, 'password')
    const displayName = str(body, 'displayName') ?? email ?? ''
    const invite = str(body, 'invite')
    if (email === undefined || !EMAIL_RE.test(email)) return json({ error: 'invalid email' }, 400)
    if (password === undefined || password.length < 8) {
      return json({ error: 'password must be at least 8 characters' }, 400)
    }
    const passwordHash = await hashPassword(password)
    let outcome: { userId: string; error?: never } | { error: Response }
    try {
      outcome = await sql.begin(async (tx) => {
        // The bootstrap window is a race (§6.2): serialize so exactly one
        // first registration becomes instance admin.
        await tx`SELECT pg_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY})`
        const counts = await tx<{ c: number }[]>`SELECT count(*)::int AS c FROM users`
        const bootstrap = counts[0]!.c === 0
        let inviteRow: { id: string; org_id: string | null; role: OrgRole | null } | undefined
        if (!bootstrap && !ctx.openSignup) {
          if (invite === undefined) {
            return {
              error: json(
                { error: 'registration is closed — ask an org admin for an invite' },
                403,
              ),
            }
          }
          const invites = await tx<{ id: string; org_id: string | null; role: OrgRole | null }[]>`
            SELECT id, org_id, role FROM invites
            WHERE token_hash = ${sha256(invite)} AND used_by IS NULL AND expires_at > ${now}`
          inviteRow = invites[0]
          if (inviteRow === undefined) {
            return { error: json({ error: 'invalid or expired invite' }, 403) }
          }
        }
        const userId = Bun.randomUUIDv7()
        await tx`INSERT INTO users (id, email, display_name, password_hash, instance_admin, created_at)
                 VALUES (${userId}, ${email}, ${displayName}, ${passwordHash}, ${bootstrap}, ${now})`
        if (bootstrap) {
          const orgId = Bun.randomUUIDv7()
          await tx`INSERT INTO organizations (id, slug, name, created_at)
                   VALUES (${orgId}, ${'default'}, ${'Default'}, ${now})`
          await tx`INSERT INTO org_memberships (org_id, user_id, role, created_at)
                   VALUES (${orgId}, ${userId}, ${'owner'}, ${now})`
        } else if (inviteRow !== undefined) {
          await tx`UPDATE invites SET used_by = ${userId} WHERE id = ${inviteRow.id}`
          if (inviteRow.org_id !== null) {
            await tx`INSERT INTO org_memberships (org_id, user_id, role, created_at)
                     VALUES (${inviteRow.org_id}, ${userId}, ${inviteRow.role ?? 'member'}, ${now})`
          }
        }
        return { userId }
      })
    } catch (err) {
      if (isUniqueViolation(err)) return json({ error: 'email already registered' }, 409)
      throw err
    }
    if ('error' in outcome) return outcome.error
    const session = await createSession(sql, ctx.secret, outcome.userId, {}, now)
    return json({ ok: true, userId: outcome.userId }, 201, {
      'Set-Cookie': sessionSetCookie(session.cookieValue, ctx.secureCookies),
    })
  }

  if (url.pathname === '/v1/auth/login' && req.method === 'POST') {
    const body = await readBody(req)
    if (body === null) return json({ error: 'invalid JSON body' }, 400)
    const email = str(body, 'email')?.toLowerCase()
    const password = str(body, 'password')
    if (email === undefined || password === undefined) {
      return json({ error: 'email and password required' }, 400)
    }
    // TWO throttle keys: per-email (bounds targeted brute force regardless of
    // source IP — the client cannot avoid the victim's email) and per-IP+email
    // (bounds spray behind a trusted proxy). The IP is the leftmost XFF hop and
    // is client-spoofable without a trusted proxy — so it is a best-effort
    // second axis, NOT the primary defense; the email key is what actually
    // holds when an attacker rotates IPs (the review's bypass).
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? ''
    const throttleKeys = [`email|${email}`, `ip|${ip}|${email}`]
    const wait = Math.max(...throttleKeys.map((k) => ctx.throttle.retryAfterMs(k)))
    if (wait > 0) {
      return json({ error: 'too many attempts' }, 429, {
        'Retry-After': String(Math.ceil(wait / 1000)),
      })
    }
    const users = await sql<{ id: string; password_hash: string; disabled_at: string | null }[]>`
      SELECT id, password_hash, disabled_at FROM users WHERE email = ${email}`
    const user = users[0]
    // Always run one argon2 verify — against the real hash, or a fixed dummy
    // for an unknown email — so login time does not reveal whether the email is
    // registered (the throttle can be IP-rotated, so it can't own enumeration
    // resistance alone). The dummy result is discarded.
    let ok = false
    if (user !== undefined) {
      ok = await verifyPassword(password, user.password_hash)
    } else {
      // Unknown email: still pay one argon2 verify (discarded) to equalize time.
      await verifyPassword(password, await dummyPasswordHash())
    }
    if (!ok || user === undefined) {
      for (const k of throttleKeys) ctx.throttle.fail(k)
      return json({ error: 'invalid credentials' }, 401)
    }
    if (user.disabled_at !== null) return json({ error: 'account disabled' }, 403)
    for (const k of throttleKeys) ctx.throttle.succeed(k)
    const session = await createSession(sql, ctx.secret, user.id, {}, now)
    return json({ ok: true, userId: user.id }, 200, {
      'Set-Cookie': sessionSetCookie(session.cookieValue, ctx.secureCookies),
    })
  }

  if (url.pathname === '/v1/auth/logout' && req.method === 'POST') {
    const cookie = readCookie(req, SESSION_COOKIE)
    if (cookie !== null) {
      if (req.headers.get('x-vx-csrf') === null) return json({ error: 'missing x-vx-csrf' }, 403)
      await destroySession(sql, ctx.secret, cookie)
      // Revocation must beat the principal memo's TTL in-process.
      forgetSessionPrincipal(ctx.secret, cookie)
    }
    return json({ ok: true }, 200, { 'Set-Cookie': sessionClearCookie(ctx.secureCookies) })
  }

  if (url.pathname === '/v1/auth/me' && req.method === 'GET') {
    const principal = await resolvePrincipal(sql, ctx.secret, req, now)
    if (principal === null) return json({ error: 'unauthorized' }, 401)
    return json(principalResponse(principal))
  }

  // Rename yourself — the only self-service profile field (email is the login
  // identity and immutable in v1). Session + CSRF only; a token has no profile.
  if (url.pathname === '/v1/auth/me' && req.method === 'PATCH') {
    const principal = await resolvePrincipal(sql, ctx.secret, req, now)
    if (principal === null) return json({ error: 'unauthorized' }, 401)
    if (principal.kind !== 'session') return json({ error: 'session required' }, 403)
    if (!csrfOk(principal, req)) return json({ error: 'missing x-vx-csrf' }, 403)
    const body = await readBody(req)
    const displayName = body !== null ? str(body, 'displayName')?.trim() : undefined
    if (displayName === undefined || displayName === '') {
      return json({ error: 'displayName required' }, 400)
    }
    if (displayName.length > 200) return json({ error: 'displayName too long (max 200)' }, 400)
    await sql`UPDATE users SET display_name = ${displayName} WHERE id = ${principal.userId}`
    // displayName rides the memoized principal, and the user may hold other
    // sessions (tabs/devices) — clear the whole memo (rare action).
    resetSessionPrincipalCache()
    return json({ ok: true, displayName })
  }

  // Change your password: verify the current one, then re-hash. Session + CSRF
  // only. Runs argon2 twice (verify + hash) — acceptable for a rare action.
  if (url.pathname === '/v1/auth/password' && req.method === 'POST') {
    const principal = await resolvePrincipal(sql, ctx.secret, req, now)
    if (principal === null) return json({ error: 'unauthorized' }, 401)
    if (principal.kind !== 'session') return json({ error: 'session required' }, 403)
    if (!csrfOk(principal, req)) return json({ error: 'missing x-vx-csrf' }, 403)
    const body = await readBody(req)
    const currentPassword = body !== null ? str(body, 'currentPassword') : undefined
    const newPassword = body !== null ? str(body, 'newPassword') : undefined
    if (currentPassword === undefined || newPassword === undefined) {
      return json({ error: 'currentPassword and newPassword required' }, 400)
    }
    if (newPassword.length < 8) {
      return json({ error: 'new password must be at least 8 characters' }, 400)
    }
    const users = await sql<{ password_hash: string }[]>`
      SELECT password_hash FROM users WHERE id = ${principal.userId}`
    const user = users[0]
    if (user === undefined) return json({ error: 'unauthorized' }, 401)
    if (!(await verifyPassword(currentPassword, user.password_hash))) {
      return json({ error: 'current password is incorrect' }, 403)
    }
    await sql`UPDATE users SET password_hash = ${await hashPassword(newPassword)}
             WHERE id = ${principal.userId}`
    return json({ ok: true })
  }

  if (url.pathname === '/v1/auth/invites/accept' && req.method === 'POST') {
    const principal = await resolvePrincipal(sql, ctx.secret, req, now)
    if (principal === null) return json({ error: 'unauthorized' }, 401)
    if (principal.kind !== 'session') return json({ error: 'session required' }, 403)
    if (!csrfOk(principal, req)) return json({ error: 'missing x-vx-csrf' }, 403)
    const body = await readBody(req)
    const invite = body !== null ? str(body, 'invite') : undefined
    if (invite === undefined) return json({ error: 'invite required' }, 400)
    // Atomic single-use claim: the conditional UPDATE row-locks the invite and
    // the `used_by IS NULL` guard makes a concurrent second accept a no-op
    // (RETURNING yields nothing) — closing the TOCTOU where N racers all read
    // an unused invite and all onboard. The membership INSERT rides the same
    // transaction, and the not-an-org / already-a-member cases THROW to roll
    // the claim back so a legitimate retry isn't burned.
    const userId = principal.userId
    let outcome: { status: number; body: unknown }
    try {
      outcome = await sql.begin(async (tx) => {
        const claimed = await tx<{ org_id: string | null; role: OrgRole | null }[]>`
          UPDATE invites SET used_by = ${userId}
          WHERE token_hash = ${sha256(invite)} AND used_by IS NULL AND expires_at > ${now}
          RETURNING org_id, role`
        const inv = claimed[0]
        if (inv === undefined) return { status: 403, body: { error: 'invalid or expired invite' } }
        if (inv.org_id === null) throw new InviteRollback(400, 'not an org invite')
        try {
          await tx`INSERT INTO org_memberships (org_id, user_id, role, created_at)
                   VALUES (${inv.org_id}, ${userId}, ${inv.role ?? 'member'}, ${now})`
        } catch (err) {
          if (isUniqueViolation(err)) throw new InviteRollback(409, 'already a member')
          throw err
        }
        return { status: 200, body: { ok: true, orgId: inv.org_id } }
      })
    } catch (err) {
      if (err instanceof InviteRollback) return json({ error: err.publicMessage }, err.status)
      throw err
    }
    // A new membership landed: drop every memoized session principal so the
    // accepting user's next request sees the org at once.
    if (outcome.status === 200) resetSessionPrincipalCache()
    return json(outcome.body, outcome.status)
  }

  return json({ error: 'not found' }, 404)
}

async function adminRoute(req: Request, url: URL, ctx: AuthRoutesContext): Promise<Response> {
  const now = ctx.now?.() ?? Date.now()
  const { sql } = ctx
  const principal = await resolvePrincipal(sql, ctx.secret, req, now)
  if (principal === null) return json({ error: 'unauthorized' }, 401)
  if (req.method !== 'GET' && !csrfOk(principal, req)) {
    return json({ error: 'missing x-vx-csrf' }, 403)
  }

  if (url.pathname === '/v1/admin/orgs' && req.method === 'GET') {
    if (principal.kind === 'token') {
      const org = await orgById(sql, principal.orgId)
      return json({ orgs: org !== null ? [{ ...org, role: orgRoleOf(principal, org.id) }] : [] })
    }
    if (principal.instanceAdmin) {
      const orgs = await sql<OrgRow[]>`SELECT id, slug, name FROM organizations ORDER BY slug`
      return json({ orgs: orgs.map((o) => ({ ...o, role: 'owner' })) })
    }
    if (principal.orgs.size === 0) return json({ orgs: [] })
    const ids = [...principal.orgs.keys()]
    const orgs = await sql<OrgRow[]>`
      SELECT id, slug, name FROM organizations WHERE id IN ${sql(ids)} ORDER BY slug`
    return json({ orgs: orgs.map((o) => ({ ...o, role: principal.orgs.get(o.id) })) })
  }

  if (url.pathname === '/v1/admin/orgs' && req.method === 'POST') {
    if (principal.kind !== 'session') return json({ error: 'session required' }, 403)
    if (!principal.instanceAdmin && !ctx.openOrgCreate) {
      return json({ error: 'only an instance admin creates organizations' }, 403)
    }
    const body = await readBody(req)
    if (body === null) return json({ error: 'invalid JSON body' }, 400)
    const slug = str(body, 'slug')
    const name = str(body, 'name') ?? slug
    if (slug === undefined || !SLUG_RE.test(slug)) {
      return json({ error: 'slug must match [a-z0-9-]{1,64}' }, 400)
    }
    const orgId = Bun.randomUUIDv7()
    try {
      await sql`INSERT INTO organizations (id, slug, name, created_at)
                VALUES (${orgId}, ${slug}, ${name!}, ${now})`
    } catch (err) {
      if (isUniqueViolation(err)) return json({ error: 'slug already taken' }, 409)
      throw err
    }
    await sql`INSERT INTO org_memberships (org_id, user_id, role, created_at)
              VALUES (${orgId}, ${principal.userId}, ${'owner'}, ${now})`
    // The creator gained a membership — drop the memoized principals.
    resetSessionPrincipalCache()
    return json({ ok: true, orgId }, 201)
  }

  const m = /^\/v1\/admin\/orgs\/([^/]+)(?:\/([a-z]+)(?:\/([^/]+))?)?$/.exec(url.pathname)
  if (m === null) return json({ error: 'not found' }, 404)
  const [, orgIdRaw, section, itemId] = m
  const org = await orgById(sql, orgIdRaw!)

  if (section === undefined) {
    if (req.method === 'PATCH') {
      const gate = orgGate(principal, org, 'admin')
      if (gate !== null) return gate
      const body = await readBody(req)
      if (body === null) return json({ error: 'invalid JSON body' }, 400)
      const name = str(body, 'name')
      const slug = str(body, 'slug')
      if (slug !== undefined && !SLUG_RE.test(slug)) {
        return json({ error: 'slug must match [a-z0-9-]{1,64}' }, 400)
      }
      if (name === undefined && slug === undefined) return json({ error: 'nothing to update' }, 400)
      try {
        await sql`UPDATE organizations
                  SET name = COALESCE(${name ?? null}, name), slug = COALESCE(${slug ?? null}, slug)
                  WHERE id = ${org!.id}`
      } catch (err) {
        if (isUniqueViolation(err)) return json({ error: 'slug already taken' }, 409)
        throw err
      }
      return json({ ok: true })
    }
    if (req.method === 'GET') {
      const gate = orgGate(principal, org, 'viewer')
      if (gate !== null) return gate
      return json({ ...org, role: orgRoleOf(principal, org!.id) })
    }
    return json({ error: 'not found' }, 404)
  }

  if (section === 'members') {
    if (req.method === 'GET' && itemId === undefined) {
      const gate = orgGate(principal, org, 'viewer')
      if (gate !== null) return gate
      const members = await sql<
        { user_id: string; email: string; display_name: string; role: OrgRole }[]
      >`SELECT m.user_id, u.email, u.display_name, m.role
         FROM org_memberships m JOIN users u ON u.id = m.user_id
         WHERE m.org_id = ${org!.id} ORDER BY u.email`
      return json({
        members: members.map((r) => ({
          userId: r.user_id,
          email: r.email,
          displayName: r.display_name,
          role: r.role,
        })),
      })
    }
    if ((req.method === 'PATCH' || req.method === 'DELETE') && itemId !== undefined) {
      const gate = orgGate(principal, org, 'admin')
      if (gate !== null) return gate
      if (!UUID_RE.test(itemId)) return json({ error: 'not found' }, 404)
      // Read the body ONCE up front — a Request body is single-read.
      const body = req.method === 'PATCH' ? await readBody(req) : null
      const newRole = body !== null ? str(body, 'role') : undefined
      if (
        req.method === 'PATCH' &&
        (newRole === undefined || !ORG_ROLES.includes(newRole as OrgRole))
      ) {
        return json({ error: `role must be one of ${ORG_ROLES.join(', ')}` }, 400)
      }
      const targets = await sql<{ role: OrgRole }[]>`
        SELECT role FROM org_memberships WHERE org_id = ${org!.id} AND user_id = ${itemId}`
      const target = targets[0]
      if (target === undefined) return json({ error: 'not found' }, 404)
      const actorIsOwner = hasOrgRole(principal, org!.id, 'owner')
      if ((target.role === 'owner' || newRole === 'owner') && !actorIsOwner) {
        return json({ error: 'managing owners requires org owner' }, 403)
      }
      if (target.role === 'owner' && newRole !== 'owner') {
        const owners = await sql<{ c: number }[]>`
          SELECT count(*)::int AS c FROM org_memberships
          WHERE org_id = ${org!.id} AND role = 'owner'`
        if (owners[0]!.c <= 1) return json({ error: 'cannot remove the last owner' }, 400)
      }
      if (req.method === 'DELETE') {
        await sql`DELETE FROM org_memberships WHERE org_id = ${org!.id} AND user_id = ${itemId}`
        // A role/membership change must reach the target's next request —
        // no TTL-long stale-role window in-process.
        resetSessionPrincipalCache()
        return json({ ok: true })
      }
      await sql`UPDATE org_memberships SET role = ${newRole!}
                WHERE org_id = ${org!.id} AND user_id = ${itemId}`
      resetSessionPrincipalCache()
      return json({ ok: true })
    }
    return json({ error: 'not found' }, 404)
  }

  if (section === 'invites' && req.method === 'POST' && itemId === undefined) {
    const gate = orgGate(principal, org, 'admin')
    if (gate !== null) return gate
    const body = await readBody(req)
    const role = (body !== null ? str(body, 'role') : undefined) ?? 'member'
    if (!ORG_ROLES.includes(role as OrgRole)) {
      return json({ error: `role must be one of ${ORG_ROLES.join(', ')}` }, 400)
    }
    if (role === 'owner' && !hasOrgRole(principal, org!.id, 'owner')) {
      return json({ error: 'inviting an owner requires org owner' }, 403)
    }
    const token = `${INVITE_PREFIX}${randomBytes(32).toString('base64url')}`
    const expiresAt = now + INVITE_TTL_MS
    await sql`INSERT INTO invites (id, org_id, role, token_hash, created_by, created_at, expires_at)
              VALUES (${Bun.randomUUIDv7()}, ${org!.id}, ${role},
                      ${sha256(token)},
                      ${principal.kind === 'session' ? principal.userId : null}, ${now}, ${expiresAt})`
    return json(
      { ok: true, invite: token, url: `${ctx.baseUrl}/register?invite=${token}`, expiresAt },
      201,
    )
  }

  if (section === 'tokens') {
    if (req.method === 'GET' && itemId === undefined) {
      const gate = orgGate(principal, org, 'admin')
      if (gate !== null) return gate
      return json({ tokens: await listTokens(sql, org!.id) })
    }
    if (req.method === 'POST' && itemId === undefined) {
      const gate = orgGate(principal, org, 'admin')
      if (gate !== null) return gate
      const body = await readBody(req)
      if (body === null) return json({ error: 'invalid JSON body' }, 400)
      const name = str(body, 'name')
      const tier = str(body, 'tier')
      const kind = str(body, 'kind') ?? 'ci'
      const workspaceId = str(body, 'workspaceId')
      if (name === undefined) return json({ error: 'name required' }, 400)
      if (tier !== 'trusted' && tier !== 'untrusted') {
        return json({ error: 'tier must be trusted or untrusted' }, 400)
      }
      if (kind !== 'ci' && kind !== 'admin') {
        return json({ error: 'kind must be ci or admin' }, 400)
      }
      if (workspaceId !== undefined) {
        if (!UUID_RE.test(workspaceId)) return json({ error: 'invalid workspaceId' }, 400)
        const ws = await sql<{ id: string }[]>`
          SELECT id FROM workspaces WHERE id = ${workspaceId} AND org_id = ${org!.id}`
        if (ws.length === 0) return json({ error: 'unknown workspace in this org' }, 400)
      }
      const expiresRaw = body['expiresAt']
      const expiresAt = typeof expiresRaw === 'number' && expiresRaw > now ? expiresRaw : undefined
      const minted = await createApiToken(
        sql,
        {
          orgId: org!.id,
          name,
          kind: kind as TokenKind,
          tier: tier as TrustTier,
          ...(workspaceId !== undefined ? { workspaceId } : {}),
          ...(principal.kind === 'session' ? { createdBy: principal.userId } : {}),
          ...(expiresAt !== undefined ? { expiresAt } : {}),
        },
        now,
      )
      // The secret exists in plaintext exactly once: this response.
      return json({ ok: true, id: minted.id, token: minted.token }, 201)
    }
    if (req.method === 'DELETE' && itemId !== undefined) {
      const gate = orgGate(principal, org, 'admin')
      if (gate !== null) return gate
      if (!UUID_RE.test(itemId)) return json({ error: 'not found' }, 404)
      const revoked = await revokeToken(sql, org!.id, itemId, now)
      if (!revoked) return json({ error: 'not found' }, 404)
      return json({ ok: true })
    }
    return json({ error: 'not found' }, 404)
  }

  if (section === 'workspaces') {
    if (req.method === 'GET' && itemId === undefined) {
      const gate = orgGate(principal, org, 'viewer')
      if (gate !== null) return gate
      const rows = await sql<{ id: string; slug: string; name: string; created_at: string }[]>`
        SELECT id, slug, name, created_at FROM workspaces WHERE org_id = ${org!.id} ORDER BY slug`
      return json({
        workspaces: rows.map((r) => ({
          id: r.id,
          slug: r.slug,
          name: r.name,
          createdAt: Number(r.created_at),
        })),
      })
    }
    if (req.method === 'POST' && itemId === undefined) {
      const gate = orgGate(principal, org, 'admin')
      if (gate !== null) return gate
      const body = await readBody(req)
      if (body === null) return json({ error: 'invalid JSON body' }, 400)
      const slug = str(body, 'slug')
      const name = str(body, 'name') ?? slug
      if (slug === undefined || !SLUG_RE.test(slug)) {
        return json({ error: 'slug must match [a-z0-9-]{1,64}' }, 400)
      }
      const id = Bun.randomUUIDv7()
      try {
        await sql`INSERT INTO workspaces (id, org_id, slug, name, created_at)
                  VALUES (${id}, ${org!.id}, ${slug}, ${name!}, ${now})`
      } catch (err) {
        if (isUniqueViolation(err)) return json({ error: 'slug already taken' }, 409)
        throw err
      }
      return json({ ok: true, workspaceId: id }, 201)
    }
    // Rename. Most workspaces are auto-provisioned on the first CI push and
    // take their name from the pushing client, so one can be born wrong — and
    // the rename sticks, because `routeWorkspace` sets `name` only on that
    // first INSERT (later pushes touch `repos.last_seen_at` alone).
    if (req.method === 'PATCH' && itemId !== undefined) {
      const gate = orgGate(principal, org, 'admin')
      if (gate !== null) return gate
      if (!UUID_RE.test(itemId)) return json({ error: 'not found' }, 404)
      const body = await readBody(req)
      if (body === null) return json({ error: 'invalid JSON body' }, 400)
      const name = str(body, 'name')
      const slug = str(body, 'slug')
      if (slug !== undefined && !SLUG_RE.test(slug)) {
        return json({ error: 'slug must match [a-z0-9-]{1,64}' }, 400)
      }
      if (name === undefined && slug === undefined) return json({ error: 'nothing to update' }, 400)
      let updated: { id: string }[]
      try {
        updated = await sql<{ id: string }[]>`
          UPDATE workspaces
             SET name = COALESCE(${name ?? null}, name), slug = COALESCE(${slug ?? null}, slug)
           WHERE id = ${itemId} AND org_id = ${org!.id}
          RETURNING id`
      } catch (err) {
        if (isUniqueViolation(err)) return json({ error: 'slug already taken' }, 409)
        throw err
      }
      if (updated.length === 0) return json({ error: 'not found' }, 404)
      return json({ ok: true })
    }
    // Delete — the workspace is the root of every analytics row it ever
    // recorded, so this is real data loss. The caller must echo the slug (or
    // name) back as `confirm`; a mismatch is a 400 naming what it wanted.
    if (req.method === 'DELETE' && itemId !== undefined) {
      const gate = orgGate(principal, org, 'admin')
      if (gate !== null) return gate
      if (!UUID_RE.test(itemId)) return json({ error: 'not found' }, 404)
      const rows = await sql<{ slug: string; name: string }[]>`
        SELECT slug, name FROM workspaces WHERE id = ${itemId} AND org_id = ${org!.id}`
      const ws = rows[0]
      if (ws === undefined) return json({ error: 'not found' }, 404)
      const body = await readBody(req)
      const confirm = body !== null ? str(body, 'confirm') : undefined
      if (confirm !== ws.slug && confirm !== ws.name) {
        return json({ error: `confirm must be the workspace slug (${ws.slug})` }, 400)
      }
      await sql.begin(async (tx) => {
        // The analytics tables carry `workspace_id` but NO foreign key — they
        // are RANGE-partitioned, and an FK from them would have to be
        // validated across every partition. So the cascade does not reach
        // them: delete them here, or the history is orphaned, not gone.
        await tx`DELETE FROM task_logs WHERE workspace_id = ${itemId}`
        await tx`DELETE FROM task_runs WHERE workspace_id = ${itemId}`
        await tx`DELETE FROM invocations WHERE workspace_id = ${itemId}`
        await tx`DELETE FROM output_fingerprints WHERE workspace_id = ${itemId}`
        // repos, projects (→ project_tasks) and workspace-scoped api_tokens
        // DO cascade from this row.
        await tx`DELETE FROM workspaces WHERE id = ${itemId} AND org_id = ${org!.id}`
      })
      // A workspace-scoped token just died with the workspace — its bearer
      // must stop authenticating now, not when the memo's TTL lapses.
      resetTokenCache()
      return json({ ok: true })
    }
    return json({ error: 'not found' }, 404)
  }

  return json({ error: 'not found' }, 404)
}
