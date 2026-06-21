import type { Context, MiddlewareHandler } from 'hono'
import type { AuthContext, Env, Variables } from './env.js'

const TOKEN_CACHE_TTL = 60

export const bearerAuth =
  (): MiddlewareHandler<{ Bindings: Env; Variables: Variables }> => async (c, next) => {
    const token = extractBearer(c.req.header('authorization'))
    if (!token) {
      if (isLoopback(c)) return next()
      return c.json({ error: 'unauthorized' }, 401)
    }

    const auth = await resolveAuth(c.env, token)
    if (!auth) return c.json({ error: 'unauthorized' }, 401)

    c.set('auth', auth)
    return next()
  }

function extractBearer(header: string | undefined): string | null {
  if (!header) return null
  const [scheme, value] = header.split(' ')
  if (scheme?.toLowerCase() !== 'bearer' || !value) return null
  return value.trim()
}

function isLoopback(c: Context<{ Bindings: Env }>): boolean {
  const host = c.req.header('host') ?? ''
  return host.startsWith('127.0.0.1') || host.startsWith('localhost')
}

async function resolveAuth(env: Env, token: string): Promise<AuthContext | null> {
  const tokenHash = await hashToken(token)
  const cached = await env.TOKEN_CACHE.get(`token:${tokenHash}`, 'json')
  if (cached) return cached as AuthContext

  const row = await env.DB.prepare(
    'SELECT id, org_id, role, expires_at FROM api_tokens WHERE token_hash = ?1 LIMIT 1',
  )
    .bind(tokenHash)
    .first<{ id: string; org_id: string; role: AuthContext['role']; expires_at: number | null }>()

  if (!row) return null
  if (row.expires_at && row.expires_at < Date.now()) return null

  const auth: AuthContext = { orgId: row.org_id, tokenId: row.id, role: row.role }
  await env.TOKEN_CACHE.put(`token:${tokenHash}`, JSON.stringify(auth), {
    expirationTtl: TOKEN_CACHE_TTL,
  })
  return auth
}

async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
