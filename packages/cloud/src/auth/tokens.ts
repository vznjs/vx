// API tokens (docs/design/cloud-platform-2026-07.md §5.3, §6.4): minted by an
// org admin, shown ONCE, sha256 at rest. Lookup is an index probe on a
// preimage-resistant digest — no comparison oracle. The trust tier is
// IMMUTABLE after creation (change = revoke + mint): a mutable tier would
// create a window where artifacts written under one tier are readable under
// another — the cache-trust-scopes invariant carried into the account model.

import { createHash, randomBytes } from 'node:crypto'
import type { SQL } from 'bun'

export const TOKEN_PREFIX = 'vxc_'

export type TrustTier = 'trusted' | 'untrusted'
export type TokenKind = 'ci' | 'admin'

/** `last_used_at` is written at most once per minute per token (§5.3). */
export const TOKEN_LAST_USED_THROTTLE_MS = 60_000

/**
 * Short-TTL memo of resolved token principals, keyed by the token-hash digest.
 * The cache wire (`/v1/cache/*`) is the highest-QPS surface, and it does a
 * token lookup — one Postgres round-trip — before any S3 work on EVERY request;
 * a distributed build issues thousands. Token principals are IMMUTABLE except
 * revocation, so the only bounded staleness is on revoke (≤ TTL across
 * replicas; instantly cleared in-process, see `revokeToken`). Each entry's
 * expiry is capped at the token's OWN `expires_at`, so a token expiring within
 * the window is never served past its expiry.
 */
const TOKEN_CACHE_TTL_MS = 5_000
const TOKEN_CACHE_MAX = 10_000
const tokenCache = new Map<string, { principal: TokenPrincipal | null; expiresAt: number }>()

/** Drop the whole token memo — called on revoke (rare), and by tests. */
export function resetTokenCache(): void {
  tokenCache.clear()
}

export function generateTokenSecret(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
}

export function tokenHash(secret: string): Buffer {
  return createHash('sha256').update(secret).digest()
}

export interface CreateTokenArgs {
  orgId: string
  /** Narrow the token to one workspace; omitted = org-wide. */
  workspaceId?: string
  name: string
  kind: TokenKind
  tier: TrustTier
  createdBy?: string
  expiresAt?: number
}

export interface TokenPrincipal {
  kind: 'token'
  tokenId: string
  orgId: string
  workspaceId?: string
  tier: TrustTier
  tokenKind: TokenKind
}

/** Mint a token; the returned secret is the only time it exists in plaintext. */
export async function createApiToken(
  sql: SQL,
  args: CreateTokenArgs,
  now: number = Date.now(),
): Promise<{ token: string; id: string }> {
  const id = Bun.randomUUIDv7()
  const token = generateTokenSecret()
  // Admin tokens unlock org mutations, so they are trusted by definition (§6.4).
  const tier = args.kind === 'admin' ? 'trusted' : args.tier
  await sql`INSERT INTO api_tokens
      (id, org_id, workspace_id, name, token_hash, kind, trust_tier, created_by, created_at, expires_at)
    VALUES (${id}, ${args.orgId}, ${args.workspaceId ?? null}, ${args.name}, ${tokenHash(token)},
            ${args.kind}, ${tier}, ${args.createdBy ?? null}, ${now}, ${args.expiresAt ?? null})`
  return { token, id }
}

/** Resolve a presented bearer to its principal; null = unknown/revoked/expired. */
export async function lookupToken(
  sql: SQL,
  presented: string,
  now: number = Date.now(),
): Promise<TokenPrincipal | null> {
  if (!presented.startsWith(TOKEN_PREFIX)) return null
  const cacheKey = tokenHash(presented).toString('hex')
  const cached = tokenCache.get(cacheKey)
  if (cached !== undefined && cached.expiresAt > now) return cached.principal
  const rows = await sql<
    {
      id: string
      org_id: string
      workspace_id: string | null
      kind: TokenKind
      trust_tier: TrustTier
      last_used_at: string | null
      expires_at: string | null
      revoked_at: string | null
    }[]
  >`SELECT id, org_id, workspace_id, kind, trust_tier, last_used_at, expires_at, revoked_at
    FROM api_tokens WHERE token_hash = ${tokenHash(presented)}`
  const row = rows[0]
  // A null result (unknown / revoked / already-expired) is cached for the full
  // TTL — the same secret can never be re-minted, so it stays null.
  const cacheNull = (): null => {
    remember(cacheKey, null, now + TOKEN_CACHE_TTL_MS)
    return null
  }
  if (row === undefined) return cacheNull()
  if (row.revoked_at !== null) return cacheNull()
  if (row.expires_at !== null && Number(row.expires_at) <= now) return cacheNull()
  const lastUsed = row.last_used_at !== null ? Number(row.last_used_at) : 0
  if (now - lastUsed >= TOKEN_LAST_USED_THROTTLE_MS) {
    await sql`UPDATE api_tokens SET last_used_at = ${now} WHERE id = ${row.id}`
  }
  const principal: TokenPrincipal = {
    kind: 'token',
    tokenId: row.id,
    orgId: row.org_id,
    ...(row.workspace_id !== null ? { workspaceId: row.workspace_id } : {}),
    tier: row.trust_tier,
    tokenKind: row.kind,
  }
  // Cap the memo at the token's OWN expiry so it's never served past it.
  const cap = row.expires_at !== null ? Number(row.expires_at) : Infinity
  remember(cacheKey, principal, Math.min(now + TOKEN_CACHE_TTL_MS, cap))
  return principal
}

/** Store a token-cache entry, bounding the map so it can't grow unbounded. */
function remember(key: string, principal: TokenPrincipal | null, expiresAt: number): void {
  if (tokenCache.size >= TOKEN_CACHE_MAX) tokenCache.clear()
  tokenCache.set(key, { principal, expiresAt })
}

export interface TokenRow {
  id: string
  name: string
  kind: TokenKind
  tier: TrustTier
  workspaceId: string | null
  createdAt: number
  lastUsedAt: number | null
  expiresAt: number | null
  revokedAt: number | null
}

/** Token metadata for the admin list — never the hash, never a secret. */
export async function listTokens(sql: SQL, orgId: string): Promise<TokenRow[]> {
  const rows = await sql<
    {
      id: string
      name: string
      kind: TokenKind
      trust_tier: TrustTier
      workspace_id: string | null
      created_at: string
      last_used_at: string | null
      expires_at: string | null
      revoked_at: string | null
    }[]
  >`SELECT id, name, kind, trust_tier, workspace_id, created_at, last_used_at, expires_at, revoked_at
    FROM api_tokens WHERE org_id = ${orgId} ORDER BY created_at DESC`
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    tier: r.trust_tier,
    workspaceId: r.workspace_id,
    createdAt: Number(r.created_at),
    lastUsedAt: r.last_used_at !== null ? Number(r.last_used_at) : null,
    expiresAt: r.expires_at !== null ? Number(r.expires_at) : null,
    revokedAt: r.revoked_at !== null ? Number(r.revoked_at) : null,
  }))
}

/** Revoke (idempotent). Returns whether a live token was revoked. */
export async function revokeToken(
  sql: SQL,
  orgId: string,
  tokenId: string,
  now: number = Date.now(),
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE api_tokens SET revoked_at = ${now}
    WHERE id = ${tokenId} AND org_id = ${orgId} AND revoked_at IS NULL
    RETURNING id`
  // The memo is keyed by token-hash, not id, so clear it wholesale — revokes
  // are admin-rare, and this makes an in-process revoke take effect at once
  // (a revoked bearer must stop authenticating immediately).
  resetTokenCache()
  return rows.length > 0
}
