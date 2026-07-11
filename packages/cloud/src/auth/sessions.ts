// Dashboard sessions (docs/design/cloud-platform-2026-07.md §5.3, §6.1).
// Opaque 256-bit ids, sha256 at rest; the cookie value is
// `<id>.<hmac-sha256(secret, id)>` so a tampered cookie is rejected before
// any DB read — the DB row stays the source of truth (revocable).

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { SQL } from 'bun'

export const SESSION_COOKIE = 'vx_session'

/** 30-day sliding expiry (§6.1). */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

function hmacOf(secret: string, id: string): string {
  return createHmac('sha256', secret).update(id).digest('base64url')
}

function idHash(id: string): Buffer {
  return createHash('sha256').update(id).digest()
}

/**
 * Verify a cookie value's HMAC and return the session id, or null. Constant
 * time on the tag compare; no DB access.
 */
export function verifySessionCookieValue(secret: string, value: string): string | null {
  const dot = value.lastIndexOf('.')
  if (dot <= 0) return null
  const id = value.slice(0, dot)
  const tag = value.slice(dot + 1)
  const expected = Buffer.from(hmacOf(secret, id))
  const presented = Buffer.from(tag)
  if (presented.length !== expected.length) return null
  return timingSafeEqual(presented, expected) ? id : null
}

export interface SessionMeta {
  ip?: string
  userAgent?: string
}

/** Mint a session row + the signed cookie value. */
export async function createSession(
  sql: SQL,
  secret: string,
  userId: string,
  meta: SessionMeta = {},
  now: number = Date.now(),
): Promise<{ cookieValue: string; expiresAt: number }> {
  const id = randomBytes(32).toString('base64url')
  const expiresAt = now + SESSION_TTL_MS
  await sql`INSERT INTO sessions (id_hash, user_id, created_at, expires_at, ip, user_agent)
            VALUES (${idHash(id)}, ${userId}, ${now}, ${expiresAt},
                    ${meta.ip ?? null}, ${meta.userAgent ?? null})`
  return { cookieValue: `${id}.${hmacOf(secret, id)}`, expiresAt }
}

/**
 * Resolve a cookie value to its live session (HMAC gate first, then the DB
 * row). Sliding renewal: a session past half its TTL gets extended.
 */
export async function resolveSession(
  sql: SQL,
  secret: string,
  cookieValue: string,
  now: number = Date.now(),
): Promise<{ userId: string } | null> {
  const id = verifySessionCookieValue(secret, cookieValue)
  if (id === null) return null
  const rows = await sql<{ user_id: string; expires_at: string }[]>`
    SELECT user_id, expires_at FROM sessions WHERE id_hash = ${idHash(id)}`
  const row = rows[0]
  if (row === undefined) return null
  const expiresAt = Number(row.expires_at)
  if (expiresAt <= now) return null
  if (expiresAt - now < SESSION_TTL_MS / 2) {
    await sql`UPDATE sessions SET expires_at = ${now + SESSION_TTL_MS}
              WHERE id_hash = ${idHash(id)}`
  }
  return { userId: row.user_id }
}

/** Revoke the cookie's session row (logout). Tampered cookies are a no-op. */
export async function destroySession(sql: SQL, secret: string, cookieValue: string): Promise<void> {
  const id = verifySessionCookieValue(secret, cookieValue)
  if (id === null) return
  await sql`DELETE FROM sessions WHERE id_hash = ${idHash(id)}`
}

/** `Set-Cookie` header value for a freshly minted session. */
export function sessionSetCookie(cookieValue: string, secure: boolean): string {
  const attrs = [
    `${SESSION_COOKIE}=${cookieValue}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ]
  if (secure) attrs.push('Secure')
  return attrs.join('; ')
}

/** `Set-Cookie` header value clearing the session cookie (logout). */
export function sessionClearCookie(secure: boolean): string {
  const attrs = [`${SESSION_COOKIE}=`, 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0']
  if (secure) attrs.push('Secure')
  return attrs.join('; ')
}

/** Read one cookie from a request's `Cookie` header. */
export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie')
  if (header === null) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return null
}
