import { beforeAll, describe, expect, it } from 'bun:test'
import { openDb, type DbClient } from '../src/db/client.js'
import {
  createLoginThrottle,
  handleAuthRoutes,
  type AuthRoutesContext,
} from '../src/auth/routes.js'
import { createSession, resolveSession, verifySessionCookieValue } from '../src/auth/sessions.js'
import { createApiToken, lookupToken, resetTokenCache } from '../src/auth/tokens.js'
import { resetSessionPrincipalCache } from '../src/auth/rbac.js'
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

describe('profile + password (self-service)', () => {
  let db: DbClient
  let ctx: AuthRoutesContext
  let cookie: string
  beforeAll(async () => {
    db = openDb(await (await ephemeralPg()).createDatabase())
    ctx = makeCtx(db)
    const reg = await call(ctx, 'POST', '/v1/auth/register', {
      body: { email: 'me@example.com', password: 'password1', displayName: 'Ada' },
    })
    cookie = cookieOf(reg)
  })

  it('/v1/auth/me carries email + displayName', async () => {
    const body = (await (await call(ctx, 'GET', '/v1/auth/me', { cookie })).json()) as {
      email: string
      displayName: string
      instanceAdmin: boolean
    }
    expect(body.email).toBe('me@example.com')
    expect(body.displayName).toBe('Ada')
    expect(body.instanceAdmin).toBe(true)
  })

  it('PATCH /v1/auth/me renames — CSRF-gated, non-empty, reflected in /me', async () => {
    // Missing CSRF header → 403 (no rename).
    const noCsrf = await call(ctx, 'PATCH', '/v1/auth/me', {
      cookie,
      body: { displayName: 'Ada Lovelace' },
    })
    expect(noCsrf.status).toBe(403)
    // Empty name → 400.
    const empty = await call(ctx, 'PATCH', '/v1/auth/me', {
      cookie,
      csrf: true,
      body: { displayName: '   ' },
    })
    expect(empty.status).toBe(400)
    // Valid rename → 200, and /me reflects it.
    const ok = await call(ctx, 'PATCH', '/v1/auth/me', {
      cookie,
      csrf: true,
      body: { displayName: 'Ada Lovelace' },
    })
    expect(ok.status).toBe(200)
    const me = (await (await call(ctx, 'GET', '/v1/auth/me', { cookie })).json()) as {
      displayName: string
    }
    expect(me.displayName).toBe('Ada Lovelace')
  })

  it('POST /v1/auth/password verifies the current password before changing it', async () => {
    // Wrong current → 403.
    const wrong = await call(ctx, 'POST', '/v1/auth/password', {
      cookie,
      csrf: true,
      body: { currentPassword: 'nope-nope', newPassword: 'newpassword1' },
    })
    expect(wrong.status).toBe(403)
    // Too-short new → 400.
    const short = await call(ctx, 'POST', '/v1/auth/password', {
      cookie,
      csrf: true,
      body: { currentPassword: 'password1', newPassword: 'short' },
    })
    expect(short.status).toBe(400)
    // Correct current + valid new → 200; the new password logs in, the old fails.
    const ok = await call(ctx, 'POST', '/v1/auth/password', {
      cookie,
      csrf: true,
      body: { currentPassword: 'password1', newPassword: 'newpassword1' },
    })
    expect(ok.status).toBe(200)
    const withNew = await call(ctx, 'POST', '/v1/auth/login', {
      body: { email: 'me@example.com', password: 'newpassword1' },
    })
    expect(withNew.status).toBe(200)
    const withOld = await call(ctx, 'POST', '/v1/auth/login', {
      body: { email: 'me@example.com', password: 'password1' },
    })
    expect(withOld.status).toBe(401)
  })

  it('a bearer token cannot use the profile endpoints (session required)', async () => {
    const meBody = (await (await call(ctx, 'GET', '/v1/auth/me', { cookie })).json()) as {
      orgs: { orgId: string }[]
    }
    const orgId = meBody.orgs[0]!.orgId
    const mint = await call(ctx, 'POST', `/v1/admin/orgs/${orgId}/tokens`, {
      cookie,
      csrf: true,
      body: { name: 'ci', tier: 'trusted' },
    })
    const token = ((await mint.json()) as { token: string }).token
    const patch = await call(ctx, 'PATCH', '/v1/auth/me', {
      bearer: token,
      body: { displayName: 'nope' },
    })
    expect(patch.status).toBe(403)
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

describe('security-review regressions', () => {
  it('invite accept is atomically single-use under a concurrent-accept race', async () => {
    const db = openDb(await (await ephemeralPg()).createDatabase())
    const ctx = makeCtx(db)
    // Owner (instance admin) + a second org the racers are NOT members of.
    const ownerCookie = cookieOf(
      await call(ctx, 'POST', '/v1/auth/register', {
        body: { email: 'race-owner@example.com', password: 'password1' },
      }),
    )
    const org2Id = (
      (await (
        await call(ctx, 'POST', '/v1/admin/orgs', {
          cookie: ownerCookie,
          csrf: true,
          body: { slug: 'org-two', name: 'Org Two' },
        })
      ).json()) as { orgId: string }
    ).orgId

    // Five already-registered users (each joined org1 via their own invite),
    // none a member of org2.
    const racerCookies: string[] = []
    for (let i = 0; i < 5; i++) {
      const org1Id = (
        (await (await call(ctx, 'GET', '/v1/auth/me', { cookie: ownerCookie })).json()) as {
          orgs: { orgId: string }[]
        }
      ).orgs[0]!.orgId
      const { invite } = (await (
        await call(ctx, 'POST', `/v1/admin/orgs/${org1Id}/invites`, {
          cookie: ownerCookie,
          csrf: true,
          body: { role: 'member' },
        })
      ).json()) as { invite: string }
      racerCookies.push(
        cookieOf(
          await call(ctx, 'POST', '/v1/auth/register', {
            body: { email: `racer${i}@example.com`, password: 'password1', invite },
          }),
        ),
      )
    }

    // ONE org2 invite; all five accept it concurrently.
    const { invite: org2Invite } = (await (
      await call(ctx, 'POST', `/v1/admin/orgs/${org2Id}/invites`, {
        cookie: ownerCookie,
        csrf: true,
        body: { role: 'member' },
      })
    ).json()) as { invite: string }
    const results = await Promise.all(
      racerCookies.map((cookie) =>
        call(ctx, 'POST', '/v1/auth/invites/accept', {
          cookie,
          csrf: true,
          body: { invite: org2Invite },
        }).then((r) => r.status),
      ),
    )
    // Exactly ONE racer claimed it; the rest lost the race cleanly (403).
    expect(results.filter((s) => s === 200)).toHaveLength(1)
    const members = await db.sql<{ c: number }[]>`
      SELECT count(*)::int AS c FROM org_memberships WHERE org_id = ${org2Id}`
    expect(Number(members[0]!.c)).toBe(2) // the owner + exactly one racer
    await db.close()
  })

  it('login throttle: rotating the source IP does not defeat the per-email backoff', async () => {
    const db = openDb(await (await ephemeralPg()).createDatabase())
    let clock = Date.now()
    const ctx = makeCtx(db, () => clock)
    await call(ctx, 'POST', '/v1/auth/register', {
      body: { email: 'victim@example.com', password: 'password1' },
    })
    // Five wrong-password attempts, each from a DIFFERENT client IP.
    for (let i = 0; i < 5; i++) {
      await call(ctx, 'POST', '/v1/auth/login', {
        headers: { 'x-forwarded-for': `10.0.0.${i}` },
        body: { email: 'victim@example.com', password: 'nope' },
      })
    }
    // A sixth attempt from a BRAND-NEW IP is still throttled — the email key held.
    const next = await call(ctx, 'POST', '/v1/auth/login', {
      headers: { 'x-forwarded-for': '203.0.113.99' },
      body: { email: 'victim@example.com', password: 'password1' },
    })
    expect(next.status).toBe(429)
    clock += 5 * 60 * 1000 + 1000
    expect(
      (
        await call(ctx, 'POST', '/v1/auth/login', {
          headers: { 'x-forwarded-for': '203.0.113.99' },
          body: { email: 'victim@example.com', password: 'password1' },
        })
      ).status,
    ).toBe(200)
    await db.close()
  })

  it('login throttle map is bounded — distinct-key spray cannot grow it without limit', () => {
    let clock = 1_000_000
    const throttle = createLoginThrottle(() => clock, 10)
    for (let i = 0; i < 1000; i++) throttle.fail(`ip|10.0.0.${i}|e${i}@x`)
    expect(throttle.size()).toBeLessThanOrEqual(10)
  })

  it('login timing does not reveal whether an email is registered (dummy argon2)', async () => {
    const db = openDb(await (await ephemeralPg()).createDatabase())
    const ctx = makeCtx(db)
    await call(ctx, 'POST', '/v1/auth/register', {
      body: { email: 'known@example.com', password: 'password1' },
    })
    // Warm the memoized dummy hash so the first unknown attempt isn't skewed.
    await call(ctx, 'POST', '/v1/auth/login', {
      body: { email: 'nobody-warmup@example.com', password: 'x' },
    })
    const time = async (email: string): Promise<number> => {
      const t = Bun.nanoseconds()
      await call(ctx, 'POST', '/v1/auth/login', { body: { email, password: 'wrong-password' } })
      return Bun.nanoseconds() - t
    }
    const known = await time('known@example.com')
    const unknown = await time('does-not-exist@example.com')
    // Both run one argon2 verify, so they are the same order of magnitude —
    // pre-fix the unknown path was ~300× faster (a clean enumeration oracle).
    expect(unknown).toBeGreaterThan(known * 0.3)
    await db.close()
  })
})

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

  // A workspace is usually auto-provisioned on the first CI push and named by
  // the pushing client, so it can be born wrong — and one created by mistake
  // must be removable.
  it('workspaces: admin renames; the new name is what the list reports', async () => {
    const admin = cookies.get('admin@example.com')!
    const created = await call(ctx, 'POST', `/v1/admin/orgs/${orgId}/workspaces`, {
      cookie: admin,
      csrf: true,
      body: { slug: 'rename-me', name: 'Ugly Autoprovisioned Name' },
    })
    const { workspaceId } = (await created.json()) as { workspaceId: string }

    const patched = await call(ctx, 'PATCH', `/v1/admin/orgs/${orgId}/workspaces/${workspaceId}`, {
      cookie: admin,
      csrf: true,
      body: { name: 'Acme Web', slug: 'acme-web' },
    })
    expect(patched.status).toBe(200)
    const list = await call(ctx, 'GET', `/v1/admin/orgs/${orgId}/workspaces`, { cookie: admin })
    const { workspaces } = (await list.json()) as { workspaces: { slug: string; name: string }[] }
    const row = workspaces.find((w) => w.slug === 'acme-web')
    expect(row?.name).toBe('Acme Web')
    expect(workspaces.some((w) => w.slug === 'rename-me')).toBe(false)
  })

  it('workspaces: rename validates the slug and 409s on a collision', async () => {
    const admin = cookies.get('admin@example.com')!
    const rows = await db.sql<{ id: string }[]>`
      SELECT id FROM workspaces WHERE org_id = ${orgId} AND slug = 'acme-web'`
    const wsId = rows[0]!.id
    const bad = await call(ctx, 'PATCH', `/v1/admin/orgs/${orgId}/workspaces/${wsId}`, {
      cookie: admin,
      csrf: true,
      body: { slug: 'Not A Slug' },
    })
    expect(bad.status).toBe(400)
    const empty = await call(ctx, 'PATCH', `/v1/admin/orgs/${orgId}/workspaces/${wsId}`, {
      cookie: admin,
      csrf: true,
      body: {},
    })
    expect(empty.status).toBe(400)
    // 'web' is taken by the workspace the previous test created.
    const collide = await call(ctx, 'PATCH', `/v1/admin/orgs/${orgId}/workspaces/${wsId}`, {
      cookie: admin,
      csrf: true,
      body: { slug: 'web' },
    })
    expect(collide.status).toBe(409)
    // The failed rename left the row alone.
    const after = await db.sql<{ slug: string }[]>`SELECT slug FROM workspaces WHERE id = ${wsId}`
    expect(after[0]!.slug).toBe('acme-web')
  })

  it('workspaces: a viewer/member cannot rename or delete', async () => {
    const rows = await db.sql<{ id: string }[]>`
      SELECT id FROM workspaces WHERE org_id = ${orgId} AND slug = 'acme-web'`
    const wsId = rows[0]!.id
    for (const who of ['viewer@example.com', 'member@example.com']) {
      const patch = await call(ctx, 'PATCH', `/v1/admin/orgs/${orgId}/workspaces/${wsId}`, {
        cookie: cookies.get(who)!,
        csrf: true,
        body: { name: 'Hijacked' },
      })
      expect(patch.status).toBe(403)
      const del = await call(ctx, 'DELETE', `/v1/admin/orgs/${orgId}/workspaces/${wsId}`, {
        cookie: cookies.get(who)!,
        csrf: true,
        body: { confirm: 'acme-web' },
      })
      expect(del.status).toBe(403)
    }
    const after = await db.sql<{ name: string }[]>`SELECT name FROM workspaces WHERE id = ${wsId}`
    expect(after[0]!.name).toBe('Acme Web')
  })

  it('workspaces: a cross-org rename/delete is a 404 that does NOT act', async () => {
    // A second org the admin@ user never joined, holding its own workspace.
    const created = await call(ctx, 'POST', '/v1/admin/orgs', {
      cookie: ownerCookie,
      csrf: true,
      body: { slug: 'foreign', name: 'Foreign' },
    })
    const { orgId: foreignOrg } = (await created.json()) as { orgId: string }
    const ws = await call(ctx, 'POST', `/v1/admin/orgs/${foreignOrg}/workspaces`, {
      cookie: ownerCookie,
      csrf: true,
      body: { slug: 'secret', name: 'Secret' },
    })
    const { workspaceId: foreignWs } = (await ws.json()) as { workspaceId: string }

    const admin = cookies.get('admin@example.com')!
    // Reached through the foreign org: no standing there at all.
    expect(
      (
        await call(ctx, 'PATCH', `/v1/admin/orgs/${foreignOrg}/workspaces/${foreignWs}`, {
          cookie: admin,
          csrf: true,
          body: { name: 'Pwned' },
        })
      ).status,
    ).toBe(404)
    // And smuggled through the admin's OWN org, where the id does not belong:
    // the `org_id` clamp must refuse it rather than reaching across.
    expect(
      (
        await call(ctx, 'PATCH', `/v1/admin/orgs/${orgId}/workspaces/${foreignWs}`, {
          cookie: admin,
          csrf: true,
          body: { name: 'Pwned' },
        })
      ).status,
    ).toBe(404)
    expect(
      (
        await call(ctx, 'DELETE', `/v1/admin/orgs/${orgId}/workspaces/${foreignWs}`, {
          cookie: admin,
          csrf: true,
          body: { confirm: 'secret' },
        })
      ).status,
    ).toBe(404)
    const survived = await db.sql<{ name: string }[]>`
      SELECT name FROM workspaces WHERE id = ${foreignWs}`
    expect(survived[0]!.name).toBe('Secret')
  })

  it('workspaces: delete demands the slug echoed back, then removes the row', async () => {
    const admin = cookies.get('admin@example.com')!
    const created = await call(ctx, 'POST', `/v1/admin/orgs/${orgId}/workspaces`, {
      cookie: admin,
      csrf: true,
      body: { slug: 'doomed', name: 'Doomed' },
    })
    const { workspaceId } = (await created.json()) as { workspaceId: string }
    const path = `/v1/admin/orgs/${orgId}/workspaces/${workspaceId}`

    const noConfirm = await call(ctx, 'DELETE', path, { cookie: admin, csrf: true })
    expect(noConfirm.status).toBe(400)
    expect(((await noConfirm.json()) as { error: string }).error).toContain('doomed')
    const wrong = await call(ctx, 'DELETE', path, {
      cookie: admin,
      csrf: true,
      body: { confirm: 'dooomed' },
    })
    expect(wrong.status).toBe(400)
    expect(
      (await db.sql<{ id: string }[]>`SELECT id FROM workspaces WHERE id = ${workspaceId}`).length,
    ).toBe(1)

    // The name is accepted too — it is what the dashboard shows.
    const ok = await call(ctx, 'DELETE', path, {
      cookie: admin,
      csrf: true,
      body: { confirm: 'Doomed' },
    })
    expect(ok.status).toBe(200)
    expect(
      (await db.sql<{ id: string }[]>`SELECT id FROM workspaces WHERE id = ${workspaceId}`).length,
    ).toBe(0)
    // Gone means gone: a second delete is a 404, not a silent success.
    expect((await call(ctx, 'DELETE', path, { cookie: admin, csrf: true })).status).toBe(404)
  })

  // The reaper sweeps the workspace's cached artifacts out of object storage
  // AFTER the rows are gone. It is cleanup, not correctness: the rows are what
  // make the artifacts unreachable, so a bucket that is down (or a reaper that
  // throws outright) must never turn a completed delete into a failure.
  it('workspaces: delete hands the reaper the scope, and survives it throwing', async () => {
    const admin = cookies.get('admin@example.com')!
    const reaped: [string, string][] = []
    const reapingCtx: AuthRoutesContext = {
      ...ctx,
      reapArtifacts: (org, ws) => {
        reaped.push([org, ws])
        throw new Error('bucket down')
      },
    }
    const created = await call(reapingCtx, 'POST', `/v1/admin/orgs/${orgId}/workspaces`, {
      cookie: admin,
      csrf: true,
      body: { slug: 'reapable', name: 'Reapable' },
    })
    const { workspaceId } = (await created.json()) as { workspaceId: string }

    const ok = await call(
      reapingCtx,
      'DELETE',
      `/v1/admin/orgs/${orgId}/workspaces/${workspaceId}`,
      { cookie: admin, csrf: true, body: { confirm: 'reapable' } },
    )
    expect(ok.status).toBe(200)
    expect(reaped).toEqual([[orgId, workspaceId]])
    expect(
      (await db.sql<{ id: string }[]>`SELECT id FROM workspaces WHERE id = ${workspaceId}`).length,
    ).toBe(0)
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

  it('lookupToken memoizes the principal (a second lookup skips the DB)', async () => {
    resetTokenCache()
    const t = await createApiToken(db.sql, { orgId, name: 'memo', kind: 'ci', tier: 'trusted' })
    expect(await lookupToken(db.sql, t.token)).not.toBeNull()
    // Delete the row OUT OF BAND (not via revokeToken, so the memo isn't
    // cleared): a re-lookup within the TTL still returns the cached principal,
    // proving the DB was NOT hit again.
    await db.sql`DELETE FROM api_tokens WHERE id = ${t.id}`
    expect(await lookupToken(db.sql, t.token)).not.toBeNull()
    // Clearing the memo forces a re-read → the deleted row is gone → null.
    resetTokenCache()
    expect(await lookupToken(db.sql, t.token)).toBeNull()
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

describe('session principal memo', () => {
  const DAY = 24 * 60 * 60 * 1000
  let db: DbClient
  let ctx: AuthRoutesContext
  let clockNow = 0
  let ownerCookie = ''
  let orgId = ''

  async function me(cookie: string): Promise<Response> {
    return await call(ctx, 'GET', '/v1/auth/me', { cookie })
  }

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
    return cookieOf(reg)
  }

  beforeAll(async () => {
    resetSessionPrincipalCache()
    db = openDb(await (await ephemeralPg()).createDatabase())
    clockNow = Date.now()
    ctx = makeCtx(db, () => clockNow)
    const reg = await call(ctx, 'POST', '/v1/auth/register', {
      body: { email: 'boss@example.com', password: 'password1' },
    })
    ownerCookie = cookieOf(reg)
    const meBody = (await (await me(ownerCookie)).json()) as { orgs: { orgId: string }[] }
    orgId = meBody.orgs[0]!.orgId
  })

  it('logout invalidates the memoized principal immediately (revocation beats the TTL)', async () => {
    const cookie = await join('bye@example.com', 'member')
    expect((await me(cookie)).status).toBe(200)
    expect((await call(ctx, 'POST', '/v1/auth/logout', { cookie, csrf: true })).status).toBe(200)
    // Same tick — well inside the 5s TTL of the entry memoized above.
    expect((await me(cookie)).status).toBe(401)
  })

  it('a memoized session skips Postgres inside the TTL; the TTL bounds the staleness', async () => {
    const cookie = await join('memo@example.com', 'member')
    expect((await me(cookie)).status).toBe(200)
    // Delete the session row OUT OF BAND (not via logout, so the memo is not
    // cleared): a re-resolve inside the TTL still answers 200 from the memo,
    // proving Postgres was NOT consulted again — the same behavioral pin the
    // token-memo test uses.
    const uid = await memberId(db, 'memo@example.com')
    await db.sql`DELETE FROM sessions WHERE user_id = ${uid}`
    expect((await me(cookie)).status).toBe(200)
    // Past the TTL the entry lapses; the row is gone → refused. This is the
    // exact staleness bound: out-of-band revocation lands within 5s.
    clockNow += 6000
    expect((await me(cookie)).status).toBe(401)
  })

  it('a role change reaches the changed user on the next request (no stale-escalation window)', async () => {
    const cookie = await join('demote@example.com', 'admin')
    // An admin-gated read memoizes the admin-role principal.
    expect((await call(ctx, 'GET', `/v1/admin/orgs/${orgId}/tokens`, { cookie })).status).toBe(200)
    const uid = await memberId(db, 'demote@example.com')
    const patch = await call(ctx, 'PATCH', `/v1/admin/orgs/${orgId}/members/${uid}`, {
      cookie: ownerCookie,
      csrf: true,
      body: { role: 'viewer' },
    })
    expect(patch.status).toBe(200)
    // Immediately after — inside what would be the memoized entry's TTL — the
    // demotion is already effective.
    expect((await call(ctx, 'GET', `/v1/admin/orgs/${orgId}/tokens`, { cookie })).status).toBe(403)
  })

  it('an invite accept makes the new org visible on the next request', async () => {
    const cookie = await join('joiner@example.com', 'member')
    const created = await call(ctx, 'POST', '/v1/admin/orgs', {
      cookie: ownerCookie,
      csrf: true,
      body: { slug: 'memo-second', name: 'Second' },
    })
    const { orgId: org2Id } = (await created.json()) as { orgId: string }
    const { invite } = (await (
      await call(ctx, 'POST', `/v1/admin/orgs/${org2Id}/invites`, {
        cookie: ownerCookie,
        csrf: true,
        body: { role: 'member' },
      })
    ).json()) as { invite: string }
    // The accept request itself memoizes the PRE-accept principal (resolution
    // precedes the membership insert), so without the accept-side clear the
    // next read would serve a stale org list.
    const accept = await call(ctx, 'POST', '/v1/auth/invites/accept', {
      cookie,
      csrf: true,
      body: { invite },
    })
    expect(accept.status).toBe(200)
    const meBody = (await (await me(cookie)).json()) as { orgs: { orgId: string }[] }
    expect(meBody.orgs.map((o) => o.orgId)).toContain(org2Id)
  })

  it('sliding renewal still fires on a memo miss (a hit only skips it within the TTL)', async () => {
    const cookie = await join('renew@example.com', 'member')
    const uid = await memberId(db, 'renew@example.com')
    const t0 = clockNow
    expect((await me(cookie)).status).toBe(200)
    const readExpiry = async (): Promise<number> => {
      const rows = await db.sql<{ expires_at: string }[]>`
        SELECT expires_at FROM sessions WHERE user_id = ${uid}`
      return Number(rows[0]!.expires_at)
    }
    // Full 30 days remaining → the memoizing resolve did not renew.
    expect(await readExpiry()).toBe(t0 + 30 * DAY)
    // 20 days later the memo entry is long expired: the miss re-resolves and
    // the sliding renewal fires (10 days remaining < half the TTL).
    clockNow += 20 * DAY
    const renewedAt = clockNow
    expect((await me(cookie)).status).toBe(200)
    expect(await readExpiry()).toBe(renewedAt + 30 * DAY)
    // Past the ORIGINAL expiry the session still authenticates end-to-end.
    clockNow = t0 + 35 * DAY
    expect((await me(cookie)).status).toBe(200)
  })

  it('an expired session is refused even though it was recently memoized', async () => {
    // Fresh session for an existing user at the current (advanced) clock.
    const login = await call(ctx, 'POST', '/v1/auth/login', {
      body: { email: 'memo@example.com', password: 'password1' },
    })
    const cookie = cookieOf(login)
    expect((await me(cookie)).status).toBe(200)
    // Untouched for 31 days → no renewal ran; both the memo entry (5s) and
    // the row (30d) are past expiry — refused, never served from the memo.
    clockNow += 31 * DAY
    expect((await me(cookie)).status).toBe(401)
  })
})
