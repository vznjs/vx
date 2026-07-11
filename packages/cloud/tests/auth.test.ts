import { beforeAll, describe, expect, it } from 'bun:test'
import { openDb, type DbClient } from '../src/db/client.js'
import {
  createLoginThrottle,
  handleAuthRoutes,
  type AuthRoutesContext,
} from '../src/auth/routes.js'
import { createSession, resolveSession, verifySessionCookieValue } from '../src/auth/sessions.js'
import { createApiToken, lookupToken } from '../src/auth/tokens.js'
import { ephemeralPg } from './helpers/ephemeral-pg.js'

const SECRET = 's'.repeat(48)
const BASE = 'http://vx.test'

interface CallOpts {
  body?: unknown
  cookie?: string
  bearer?: string
  csrf?: boolean
  headers?: Record<string, string>
}

function makeCtx(db: DbClient, now?: () => number): AuthRoutesContext {
  const clock = now ?? Date.now
  return {
    sql: db.sql,
    secret: SECRET,
    secureCookies: false,
    baseUrl: BASE,
    openSignup: false,
    openOrgCreate: false,
    throttle: createLoginThrottle(clock),
    now: clock,
  }
}

async function call(
  ctx: AuthRoutesContext,
  method: string,
  path: string,
  opts: CallOpts = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...opts.headers }
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
  if (opts.cookie !== undefined) headers['cookie'] = `vx_session=${opts.cookie}`
  if (opts.bearer !== undefined) headers['authorization'] = `Bearer ${opts.bearer}`
  if (opts.csrf === true) headers['x-vx-csrf'] = '1'
  const url = new URL(path, BASE)
  const req = new Request(url.toString(), {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  })
  const res = await handleAuthRoutes(req, url, ctx)
  if (res === null) throw new Error(`route not matched: ${method} ${path}`)
  return res
}

function cookieOf(res: Response): string {
  const raw = res.headers.get('set-cookie')
  if (raw === null) throw new Error('no Set-Cookie')
  const m = /vx_session=([^;]*)/.exec(raw)
  if (m === null) throw new Error(`unexpected Set-Cookie: ${raw}`)
  return m[1]!
}

describe('register + bootstrap', () => {
  let db: DbClient
  let ctx: AuthRoutesContext
  beforeAll(async () => {
    db = openDb(await (await ephemeralPg()).createDatabase())
    ctx = makeCtx(db)
  })

  it('rejects malformed input at the boundary', async () => {
    expect(
      (
        await call(ctx, 'POST', '/v1/auth/register', {
          body: { email: 'nope', password: 'longenough' },
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await call(ctx, 'POST', '/v1/auth/register', {
          body: { email: 'a@b.co', password: 'short' },
        })
      ).status,
    ).toBe(400)
  })

  it('first user becomes instance admin with a default org; signup then closes', async () => {
    const res = await call(ctx, 'POST', '/v1/auth/register', {
      body: { email: 'First@Example.com', password: 'password1', displayName: 'First' },
    })
    expect(res.status).toBe(201)
    const cookie = cookieOf(res)
    const me = await call(ctx, 'GET', '/v1/auth/me', { cookie })
    expect(me.status).toBe(200)
    const body = (await me.json()) as {
      instanceAdmin: boolean
      orgs: { orgId: string; role: string }[]
    }
    expect(body.instanceAdmin).toBe(true)
    expect(body.orgs).toHaveLength(1)
    expect(body.orgs[0]!.role).toBe('owner')

    const second = await call(ctx, 'POST', '/v1/auth/register', {
      body: { email: 'second@example.com', password: 'password2' },
    })
    expect(second.status).toBe(403)
  })

  it('email is stored lowercased and duplicates 409', async () => {
    const ctx2 = { ...ctx, openSignup: true }
    const dup = await call(ctx2, 'POST', '/v1/auth/register', {
      body: { email: 'first@example.com', password: 'password1' },
    })
    expect(dup.status).toBe(409)
  })

  it('an invite admits a second user at the invited role; single-use', async () => {
    const login = await call(ctx, 'POST', '/v1/auth/login', {
      body: { email: 'first@example.com', password: 'password1' },
    })
    const cookie = cookieOf(login)
    const meBody = (await (await call(ctx, 'GET', '/v1/auth/me', { cookie })).json()) as {
      orgs: { orgId: string }[]
    }
    const orgId = meBody.orgs[0]!.orgId
    const inviteRes = await call(ctx, 'POST', `/v1/admin/orgs/${orgId}/invites`, {
      cookie,
      csrf: true,
      body: { role: 'viewer' },
    })
    expect(inviteRes.status).toBe(201)
    const { invite, url } = (await inviteRes.json()) as { invite: string; url: string }
    expect(invite.startsWith('vxi_')).toBe(true)
    expect(url).toContain(invite)

    const reg = await call(ctx, 'POST', '/v1/auth/register', {
      body: { email: 'invited@example.com', password: 'password3', invite },
    })
    expect(reg.status).toBe(201)
    const invitedMe = (await (
      await call(ctx, 'GET', '/v1/auth/me', { cookie: cookieOf(reg) })
    ).json()) as { instanceAdmin: boolean; orgs: { orgId: string; role: string }[] }
    expect(invitedMe.instanceAdmin).toBe(false)
    expect(invitedMe.orgs).toEqual([{ orgId, role: 'viewer' }])

    const reuse = await call(ctx, 'POST', '/v1/auth/register', {
      body: { email: 'again@example.com', password: 'password4', invite },
    })
    expect(reuse.status).toBe(403)
  })
})

describe('login / logout / sessions', () => {
  let db: DbClient
  let ctx: AuthRoutesContext
  let clockNow = 0
  beforeAll(async () => {
    db = openDb(await (await ephemeralPg()).createDatabase())
    clockNow = Date.now()
    ctx = makeCtx(db, () => clockNow)
    await call(ctx, 'POST', '/v1/auth/register', {
      body: { email: 'user@example.com', password: 'password1' },
    })
  })

  it('wrong password 401s; throttle 429s an immediate retry; backoff expires', async () => {
    const bad = await call(ctx, 'POST', '/v1/auth/login', {
      body: { email: 'user@example.com', password: 'wrong-password' },
    })
    expect(bad.status).toBe(401)
    const throttled = await call(ctx, 'POST', '/v1/auth/login', {
      body: { email: 'user@example.com', password: 'password1' },
    })
    expect(throttled.status).toBe(429)
    expect(throttled.headers.get('retry-after')).not.toBeNull()
    clockNow += 2000
    const ok = await call(ctx, 'POST', '/v1/auth/login', {
      body: { email: 'user@example.com', password: 'password1' },
    })
    expect(ok.status).toBe(200)
  })

  it('session cookie round-trips; tampering is rejected before the DB', async () => {
    const login = await call(ctx, 'POST', '/v1/auth/login', {
      body: { email: 'user@example.com', password: 'password1' },
    })
    const cookie = cookieOf(login)
    expect((await call(ctx, 'GET', '/v1/auth/me', { cookie })).status).toBe(200)
    const [id, tag] = cookie.split('.')
    expect((await call(ctx, 'GET', '/v1/auth/me', { cookie: `${id}x.${tag}` })).status).toBe(401)
    expect(verifySessionCookieValue(SECRET, `${id}.${'0'.repeat(tag!.length)}`)).toBeNull()
  })

  it('logout requires the CSRF header and revokes the row', async () => {
    const login = await call(ctx, 'POST', '/v1/auth/login', {
      body: { email: 'user@example.com', password: 'password1' },
    })
    const cookie = cookieOf(login)
    expect((await call(ctx, 'POST', '/v1/auth/logout', { cookie })).status).toBe(403)
    const out = await call(ctx, 'POST', '/v1/auth/logout', { cookie, csrf: true })
    expect(out.status).toBe(200)
    expect((await call(ctx, 'GET', '/v1/auth/me', { cookie })).status).toBe(401)
  })

  it('sliding renewal extends a session past half its TTL', async () => {
    const { cookieValue } = await createSession(db.sql, SECRET, await userId(db), {}, clockNow)
    const later = clockNow + 20 * 24 * 60 * 60 * 1000
    expect(await resolveSession(db.sql, SECRET, cookieValue, later)).not.toBeNull()
    // Renewed: still valid at what would have been past the original expiry.
    const pastOriginal = clockNow + 35 * 24 * 60 * 60 * 1000
    expect(await resolveSession(db.sql, SECRET, cookieValue, pastOriginal)).not.toBeNull()
  })
})

async function userId(db: DbClient): Promise<string> {
  const rows = await db.sql<{ id: string }[]>`SELECT id FROM users LIMIT 1`
  return rows[0]!.id
}

describe('tokens + RBAC matrix', () => {
  let db: DbClient
  let ctx: AuthRoutesContext
  let ownerCookie = ''
  let orgId = ''
  const cookies = new Map<string, string>()

  async function join(email: string, role: string): Promise<string> {
    const inviteRes = await call(ctx, 'POST', `/v1/admin/orgs/${orgId}/invites`, {
      cookie: ownerCookie,
      csrf: true,
      body: { role },
    })
    const { invite } = (await inviteRes.json()) as { invite: string }
    const reg = await call(ctx, 'POST', '/v1/auth/register', {
      body: { email, password: 'password1', invite },
    })
    const cookie = cookieOf(reg)
    cookies.set(email, cookie)
    return cookie
  }

  beforeAll(async () => {
    db = openDb(await (await ephemeralPg()).createDatabase())
    ctx = makeCtx(db)
    const reg = await call(ctx, 'POST', '/v1/auth/register', {
      body: { email: 'owner@example.com', password: 'password1' },
    })
    ownerCookie = cookieOf(reg)
    const me = (await (await call(ctx, 'GET', '/v1/auth/me', { cookie: ownerCookie })).json()) as {
      orgs: { orgId: string }[]
    }
    orgId = me.orgs[0]!.orgId
    await join('viewer@example.com', 'viewer')
    await join('member@example.com', 'member')
    await join('admin@example.com', 'admin')
  })

  it('admin mints a ci token; the bearer authenticates with the token principal', async () => {
    const res = await call(ctx, 'POST', `/v1/admin/orgs/${orgId}/tokens`, {
      cookie: cookies.get('admin@example.com')!,
      csrf: true,
      body: { name: 'ci-main', tier: 'trusted' },
    })
    expect(res.status).toBe(201)
    const { token } = (await res.json()) as { token: string }
    expect(token.startsWith('vxc_')).toBe(true)
    const me = await call(ctx, 'GET', '/v1/auth/me', { bearer: token })
    expect(me.status).toBe(200)
    expect(await me.json()).toEqual({
      kind: 'token',
      orgId,
      tier: 'trusted',
      tokenKind: 'ci',
    })
  })

  it('viewer cannot mint tokens; member cannot change roles', async () => {
    const mint = await call(ctx, 'POST', `/v1/admin/orgs/${orgId}/tokens`, {
      cookie: cookies.get('viewer@example.com')!,
      csrf: true,
      body: { name: 'nope', tier: 'trusted' },
    })
    expect(mint.status).toBe(403)
    const target = await memberId(db, 'viewer@example.com')
    const patch = await call(ctx, 'PATCH', `/v1/admin/orgs/${orgId}/members/${target}`, {
      cookie: cookies.get('member@example.com')!,
      csrf: true,
      body: { role: 'member' },
    })
    expect(patch.status).toBe(403)
  })

  it('admin manages non-owner roles but not owners; owner demotion guards the last owner', async () => {
    const adminCookie = cookies.get('admin@example.com')!
    const viewerId = await memberId(db, 'viewer@example.com')
    const promote = await call(ctx, 'PATCH', `/v1/admin/orgs/${orgId}/members/${viewerId}`, {
      cookie: adminCookie,
      csrf: true,
      body: { role: 'member' },
    })
    expect(promote.status).toBe(200)
    const grantOwner = await call(ctx, 'PATCH', `/v1/admin/orgs/${orgId}/members/${viewerId}`, {
      cookie: adminCookie,
      csrf: true,
      body: { role: 'owner' },
    })
    expect(grantOwner.status).toBe(403)
    const ownerId = await memberId(db, 'owner@example.com')
    const demoteOwner = await call(ctx, 'PATCH', `/v1/admin/orgs/${orgId}/members/${ownerId}`, {
      cookie: adminCookie,
      csrf: true,
      body: { role: 'member' },
    })
    expect(demoteOwner.status).toBe(403)
    const selfDemote = await call(ctx, 'PATCH', `/v1/admin/orgs/${orgId}/members/${ownerId}`, {
      cookie: ownerCookie,
      csrf: true,
      body: { role: 'member' },
    })
    expect(selfDemote.status).toBe(400)
    expect(((await selfDemote.json()) as { error: string }).error).toContain('last owner')
  })

  it('cross-org access reads as 404, not 403', async () => {
    // The instance admin (owner@) creates a second org the others never joined.
    const created = await call(ctx, 'POST', '/v1/admin/orgs', {
      cookie: ownerCookie,
      csrf: true,
      body: { slug: 'other', name: 'Other' },
    })
    expect(created.status).toBe(201)
    const { orgId: otherId } = (await created.json()) as { orgId: string }
    const res = await call(ctx, 'GET', `/v1/admin/orgs/${otherId}/members`, {
      cookie: cookies.get('admin@example.com')!,
    })
    expect(res.status).toBe(404)
  })

  it('token list exposes metadata only; revocation kills the bearer', async () => {
    const adminCookie = cookies.get('admin@example.com')!
    const minted = await call(ctx, 'POST', `/v1/admin/orgs/${orgId}/tokens`, {
      cookie: adminCookie,
      csrf: true,
      body: { name: 'to-revoke', tier: 'untrusted' },
    })
    const { id, token } = (await minted.json()) as { id: string; token: string }
    const list = await call(ctx, 'GET', `/v1/admin/orgs/${orgId}/tokens`, { cookie: adminCookie })
    const { tokens } = (await list.json()) as { tokens: Record<string, unknown>[] }
    const row = tokens.find((t) => t['id'] === id)!
    expect(row['name']).toBe('to-revoke')
    expect(row['tier']).toBe('untrusted')
    expect(JSON.stringify(row)).not.toContain(token)
    expect((await call(ctx, 'GET', '/v1/auth/me', { bearer: token })).status).toBe(200)
    const del = await call(ctx, 'DELETE', `/v1/admin/orgs/${orgId}/tokens/${id}`, {
      cookie: adminCookie,
      csrf: true,
    })
    expect(del.status).toBe(200)
    expect((await call(ctx, 'GET', '/v1/auth/me', { bearer: token })).status).toBe(401)
  })

  it('workspaces: admin creates, viewer reads, member cannot create', async () => {
    const created = await call(ctx, 'POST', `/v1/admin/orgs/${orgId}/workspaces`, {
      cookie: cookies.get('admin@example.com')!,
      csrf: true,
      body: { slug: 'web', name: 'Web' },
    })
    expect(created.status).toBe(201)
    const denied = await call(ctx, 'POST', `/v1/admin/orgs/${orgId}/workspaces`, {
      cookie: cookies.get('member@example.com')!,
      csrf: true,
      body: { slug: 'nope' },
    })
    expect(denied.status).toBe(403)
    const list = await call(ctx, 'GET', `/v1/admin/orgs/${orgId}/workspaces`, {
      cookie: cookies.get('viewer@example.com')!,
    })
    expect(list.status).toBe(200)
    const { workspaces } = (await list.json()) as { workspaces: { slug: string }[] }
    expect(workspaces.map((w) => w.slug)).toContain('web')
  })

  it('a workspace-scoped token carries its workspaceId; expired tokens are dead', async () => {
    const wsRows = await db.sql<{ id: string }[]>`
      SELECT id FROM workspaces WHERE org_id = ${orgId} AND slug = 'web'`
    const wsId = wsRows[0]!.id
    const minted = await call(ctx, 'POST', `/v1/admin/orgs/${orgId}/tokens`, {
      cookie: ownerCookie,
      csrf: true,
      body: { name: 'ws-scoped', tier: 'untrusted', workspaceId: wsId },
    })
    const { token } = (await minted.json()) as { token: string }
    const principal = await lookupToken(db.sql, token)
    expect(principal).toMatchObject({ orgId, workspaceId: wsId, tier: 'untrusted' })

    const now = Date.now()
    const expired = await createApiToken(
      db.sql,
      { orgId, name: 'expired', kind: 'ci', tier: 'trusted', expiresAt: now + 1000 },
      now,
    )
    expect(await lookupToken(db.sql, expired.token, now + 999)).not.toBeNull()
    expect(await lookupToken(db.sql, expired.token, now + 1001)).toBeNull()
  })

  it('state-changing admin routes without the CSRF header are refused for sessions', async () => {
    const res = await call(ctx, 'POST', `/v1/admin/orgs/${orgId}/tokens`, {
      cookie: ownerCookie,
      body: { name: 'x', tier: 'trusted' },
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toContain('csrf')
  })

  it('an admin kind token acts as org admin over the API and is forced trusted', async () => {
    const minted = await call(ctx, 'POST', `/v1/admin/orgs/${orgId}/tokens`, {
      cookie: ownerCookie,
      csrf: true,
      body: { name: 'iac', kind: 'admin', tier: 'untrusted' },
    })
    const { token } = (await minted.json()) as { token: string }
    const principal = await lookupToken(db.sql, token)
    expect(principal?.tier).toBe('trusted')
    const list = await call(ctx, 'GET', `/v1/admin/orgs/${orgId}/tokens`, { bearer: token })
    expect(list.status).toBe(200)
    // A plain ci token cannot administer.
    const ci = await call(ctx, 'POST', `/v1/admin/orgs/${orgId}/tokens`, {
      cookie: ownerCookie,
      csrf: true,
      body: { name: 'plain-ci', tier: 'trusted' },
    })
    const ciToken = ((await ci.json()) as { token: string }).token
    expect(
      (await call(ctx, 'GET', `/v1/admin/orgs/${orgId}/tokens`, { bearer: ciToken })).status,
    ).toBe(403)
  })
})

async function memberId(db: DbClient, email: string): Promise<string> {
  const rows = await db.sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${email}`
  return rows[0]!.id
}
