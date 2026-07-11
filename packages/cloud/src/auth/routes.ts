// `/v1/auth/*` + `/v1/admin/*` — accounts, sessions, invites, org/member/
// token/workspace administration (docs/design/cloud-platform-2026-07.md §6).
// All validation happens here at the boundary; handlers speak plain JSON.
// These routes deliberately send NO CORS headers (§6.1): cookies are
// same-origin credentials and the SPA is served by the platform itself.

import { createHash, randomBytes } from 'node:crypto'
import type { SQL } from 'bun'
import { hashPassword, verifyPassword } from './passwords.js'
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
  revokeToken,
  type TokenKind,
  type TrustTier,
} from './tokens.js'
import {
  csrfOk,
  hasOrgRole,
  orgRoleOf,
  resolvePrincipal,
  type AuthPrincipal,
  type OrgRole,
} from './rbac.js'

/** Serializes the first-user bootstrap so two concurrent registers on a
 *  fresh instance can't both become instance admin. */
const BOOTSTRAP_LOCK_KEY = 0x76786302

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
export interface LoginThrottle {
  /** ms until the next attempt is allowed; 0 = allowed now. */
  retryAfterMs(key: string): number
  fail(key: string): void
  succeed(key: string): void
}

export function createLoginThrottle(now: () => number = Date.now): LoginThrottle {
  const fails = new Map<string, { count: number; lastAt: number }>()
  return {
    retryAfterMs(key) {
      const f = fails.get(key)
      if (f === undefined) return 0
      const delay = Math.min(1000 * 2 ** (f.count - 1), 5 * 60 * 1000)
      return Math.max(0, f.lastAt + delay - now())
    },
    fail(key) {
      const f = fails.get(key)
      fails.set(key, { count: (f?.count ?? 0) + 1, lastAt: now() })
    },
    succeed(key) {
      fails.delete(key)
    },
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
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? ''
    const throttleKey = `${ip}|${email}`
    const wait = ctx.throttle.retryAfterMs(throttleKey)
    if (wait > 0) {
      return json({ error: 'too many attempts' }, 429, {
        'Retry-After': String(Math.ceil(wait / 1000)),
      })
    }
    const users = await sql<{ id: string; password_hash: string; disabled_at: string | null }[]>`
      SELECT id, password_hash, disabled_at FROM users WHERE email = ${email}`
    const user = users[0]
    // Hash-verify even for unknown emails would cost a dummy argon2 pass; the
    // throttle owns enumeration resistance instead (P1 pragmatism).
    if (user === undefined || !(await verifyPassword(password, user.password_hash))) {
      ctx.throttle.fail(throttleKey)
      return json({ error: 'invalid credentials' }, 401)
    }
    if (user.disabled_at !== null) return json({ error: 'account disabled' }, 403)
    ctx.throttle.succeed(throttleKey)
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
    }
    return json({ ok: true }, 200, { 'Set-Cookie': sessionClearCookie(ctx.secureCookies) })
  }

  if (url.pathname === '/v1/auth/me' && req.method === 'GET') {
    const principal = await resolvePrincipal(sql, ctx.secret, req, now)
    if (principal === null) return json({ error: 'unauthorized' }, 401)
    return json(principalResponse(principal))
  }

  if (url.pathname === '/v1/auth/invites/accept' && req.method === 'POST') {
    const principal = await resolvePrincipal(sql, ctx.secret, req, now)
    if (principal === null) return json({ error: 'unauthorized' }, 401)
    if (principal.kind !== 'session') return json({ error: 'session required' }, 403)
    if (!csrfOk(principal, req)) return json({ error: 'missing x-vx-csrf' }, 403)
    const body = await readBody(req)
    const invite = body !== null ? str(body, 'invite') : undefined
    if (invite === undefined) return json({ error: 'invite required' }, 400)
    const invites = await sql<{ id: string; org_id: string | null; role: OrgRole | null }[]>`
      SELECT id, org_id, role FROM invites
      WHERE token_hash = ${sha256(invite)} AND used_by IS NULL AND expires_at > ${now}`
    const row = invites[0]
    if (row === undefined) return json({ error: 'invalid or expired invite' }, 403)
    if (row.org_id === null) return json({ error: 'not an org invite' }, 400)
    try {
      await sql`INSERT INTO org_memberships (org_id, user_id, role, created_at)
                VALUES (${row.org_id}, ${principal.userId}, ${row.role ?? 'member'}, ${now})`
    } catch (err) {
      if (isUniqueViolation(err)) return json({ error: 'already a member' }, 409)
      throw err
    }
    await sql`UPDATE invites SET used_by = ${principal.userId} WHERE id = ${row.id}`
    return json({ ok: true, orgId: row.org_id })
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
        return json({ ok: true })
      }
      await sql`UPDATE org_memberships SET role = ${newRole!}
                WHERE org_id = ${org!.id} AND user_id = ${itemId}`
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
    return json({ error: 'not found' }, 404)
  }

  return json({ error: 'not found' }, 404)
}
