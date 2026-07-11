// `vx-cloud server` — the self-hosted platform entrypoint
// (docs/design/cloud-platform-2026-07.md §7.4). Hard-requires configuration:
// Postgres (identity/RBAC system of record), a ≥32-char secret, the public
// base URL, and S3-compatible artifact storage — boot validates the FULL set
// and refuses listing every missing/invalid var at once. There is no
// tokenless mode, no loopback exemption, and no `serve` verb.
//
// TRANSITIONAL (§12 P1, named deliberately): the analytics/ingest surfaces
// are still backed by the SQLite `IngestStore`, mounted under the new
// account/token auth and namespaced per ORG on the data dir
// (`<dataDir>/orgs/<orgId>`), until P2 swaps that storage onto the Postgres
// analytics tables. Identity, RBAC, and the artifact store are on
// Postgres + S3 from this phase.

import path from 'node:path'
import { VERSION } from '@vzn/vx'
import { openDb, type DbClient } from '../db/client.js'
import { runMigrations } from '../db/migrate.js'
import { createLoginThrottle, handleAuthRoutes, type AuthRoutesContext } from '../auth/routes.js'
import { hasOrgRole, resolvePrincipal } from '../auth/rbac.js'
import { lookupToken } from '../auth/tokens.js'
import { DEFAULT_PRINCIPAL, type Principal } from '../artifact-store.js'
import { S3Backend } from '../blob/s3.js'
import { IngestStore } from '../ingest-store.js'
import { loadUiHtmlPath, startServe, type ResolvedS3Config } from './serve.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ServerConfig {
  databaseUrl: string
  secret: string
  baseUrl: string
  s3: ResolvedS3Config
  port: number
  retentionDays: number
  openSignup: boolean
  openOrgCreate: boolean
  /** Volume for the transitional per-org SQLite ingest stores (§12 P1). */
  dataDir: string
}

function boolEnv(v: string | undefined): boolean {
  return v === '1' || v === 'true'
}

/**
 * Resolve + validate the full `vx-cloud server` configuration from env.
 * Collects EVERY error — an operator fixes one env-file pass, not five boot
 * loops.
 */
export function resolveServerConfig(
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; config: ServerConfig } | { ok: false; errors: string[] } {
  const errors: string[] = []
  const read = (k: string): string | undefined => {
    const v = env[k]
    return v !== undefined && v !== '' ? v : undefined
  }

  const databaseUrl = read('DATABASE_URL')
  if (databaseUrl === undefined) {
    errors.push('DATABASE_URL is required (postgres://user:pass@host:5432/db)')
  } else if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    errors.push('DATABASE_URL must be a postgres:// URL')
  }

  const secret = read('VX_CLOUD_SECRET')
  if (secret === undefined) {
    errors.push('VX_CLOUD_SECRET is required (>= 32 chars; try `openssl rand -hex 32`)')
  } else if (secret.length < 32) {
    errors.push(`VX_CLOUD_SECRET must be at least 32 characters (got ${secret.length})`)
  }

  const baseUrl = read('VX_CLOUD_BASE_URL')
  if (baseUrl === undefined) {
    errors.push('VX_CLOUD_BASE_URL is required (the public origin, e.g. https://vx.acme.dev)')
  } else {
    try {
      const u = new URL(baseUrl)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol')
    } catch {
      errors.push(`VX_CLOUD_BASE_URL is not a valid http(s) URL: ${baseUrl}`)
    }
  }

  // S3 is MANDATORY (§7.4) — there is no env combination that stores
  // artifact bytes on the controller.
  const endpoint = read('VX_CLOUD_S3_ENDPOINT')
  const bucket = read('VX_CLOUD_S3_BUCKET')
  const accessKeyId = read('VX_CLOUD_S3_ACCESS_KEY_ID')
  const secretAccessKey = read('VX_CLOUD_S3_SECRET_ACCESS_KEY')
  for (const [k, v] of [
    ['VX_CLOUD_S3_ENDPOINT', endpoint],
    ['VX_CLOUD_S3_BUCKET', bucket],
    ['VX_CLOUD_S3_ACCESS_KEY_ID', accessKeyId],
    ['VX_CLOUD_S3_SECRET_ACCESS_KEY', secretAccessKey],
  ] as const) {
    if (v === undefined)
      errors.push(`${k} is required (S3-compatible artifact storage is mandatory)`)
  }
  let presignTtlSeconds = 300
  const ttlRaw = read('VX_CLOUD_S3_PRESIGN_TTL')
  if (ttlRaw !== undefined) {
    const n = Number(ttlRaw)
    if (!Number.isInteger(n) || n <= 0) errors.push(`invalid VX_CLOUD_S3_PRESIGN_TTL: ${ttlRaw}`)
    else presignTtlSeconds = n
  }

  let port = 4321
  const portRaw = read('VX_CLOUD_PORT')
  if (portRaw !== undefined) {
    const n = Number(portRaw)
    if (!Number.isInteger(n) || n < 0 || n > 65535) errors.push(`invalid VX_CLOUD_PORT: ${portRaw}`)
    else port = n
  }

  let retentionDays = 180
  const retRaw = read('VX_CLOUD_RETENTION_DAYS')
  if (retRaw !== undefined) {
    const n = Number(retRaw)
    if (!Number.isInteger(n) || n <= 0) errors.push(`invalid VX_CLOUD_RETENTION_DAYS: ${retRaw}`)
    else retentionDays = n
  }

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    config: {
      databaseUrl: databaseUrl!,
      secret: secret!,
      baseUrl: baseUrl!.replace(/\/+$/, ''),
      s3: {
        endpoint: endpoint!,
        bucket: bucket!,
        region: read('VX_CLOUD_S3_REGION') ?? 'auto',
        accessKeyId: accessKeyId!,
        secretAccessKey: secretAccessKey!,
        prefix: read('VX_CLOUD_S3_PREFIX') ?? '',
        presignTtlSeconds,
      },
      port,
      retentionDays,
      openSignup: boolEnv(env['VX_CLOUD_OPEN_SIGNUP']),
      openOrgCreate: boolEnv(env['VX_CLOUD_OPEN_ORG_CREATE']),
      dataDir: read('VX_CLOUD_DATA_DIR') ?? path.join(process.cwd(), '.vx-cloud-data'),
    },
  }
}

export interface PlatformServer {
  origin: string
  stop(): Promise<void>
}

const CORS = { 'Access-Control-Allow-Origin': '*' }

function refuse(error: string, status: number, headers?: Record<string, string>): Response {
  return Response.json({ error }, { status, headers: { ...CORS, ...headers } })
}

/**
 * Boot the platform: reach Postgres, migrate (advisory-locked), probe S3
 * (fail loud — never a silent local fallback), then serve everything on one
 * port behind the account/token gate.
 */
export async function startServer(opts: {
  config: ServerConfig
  uiHtmlPath?: string
  log?: (message: string) => void
}): Promise<PlatformServer> {
  const log = opts.log ?? ((m: string): void => void process.stderr.write(`[vx-cloud] ${m}\n`))
  const { config } = opts

  const db: DbClient = openDb(config.databaseUrl)
  try {
    await db.sql`SELECT 1`
  } catch (err) {
    await db.close().catch(() => undefined)
    throw new Error(
      `cannot reach Postgres (DATABASE_URL): ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const applied = await runMigrations(db)
  if (applied > 0) log(`migrations: applied ${applied}`)

  try {
    await new S3Backend(config.s3).list('vx-boot-probe')
  } catch (err) {
    await db.close().catch(() => undefined)
    throw new Error(
      `S3 probe failed (${config.s3.endpoint}/${config.s3.bucket}): ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const users = await db.sql<{ c: number }[]>`SELECT count(*)::int AS c FROM users`
  if (users[0]!.c === 0) {
    log(`no accounts yet — the first registration at ${config.baseUrl} becomes the instance admin`)
  }

  const authCtx: AuthRoutesContext = {
    sql: db.sql,
    secret: config.secret,
    secureCookies: config.baseUrl.startsWith('https:'),
    baseUrl: config.baseUrl,
    openSignup: config.openSignup,
    openOrgCreate: config.openOrgCreate,
    throttle: createLoginThrottle(),
  }

  // TRANSITIONAL per-org analytics namespacing (§12 P1): one SQLite
  // IngestStore per org under the data dir. P2 replaces these with the
  // partitioned Postgres analytics tables and deletes the store wholesale.
  const orgStores = new Map<string, IngestStore>()
  const storeFor = (orgId: string): IngestStore => {
    let s = orgStores.get(orgId)
    if (s === undefined) {
      s = new IngestStore(path.join(config.dataDir, 'orgs', orgId), log)
      orgStores.set(orgId, s)
    }
    return s
  }

  const startedAt = Date.now()
  const serverName = new URL(config.baseUrl).hostname

  // The §6.5 surface → principal map, as the serve's platform gate.
  const gate = async (
    req: Request,
    url: URL,
  ): Promise<Response | { principal: Principal; ingest?: IngestStore }> => {
    const authRes = await handleAuthRoutes(req, url, authCtx)
    if (authRes !== null) return authRes
    if (url.pathname === '/v1/meta') {
      // Identity + capability flags ONLY — workspace counts and any other
      // tenant data are a multi-tenant leak on a pre-auth endpoint (§6.5).
      return Response.json(
        {
          v: 1,
          name: serverName,
          vx: VERSION,
          auth: 'account',
          startedAt,
          artifacts: true,
          cacheWire: 1,
          trustTiers: true,
        },
        { headers: CORS },
      )
    }
    // The serve-era `/version` handshake leaked the workspace path; it was
    // removed with the verb (§7.4).
    if (url.pathname === '/version') return refuse('not found', 404)

    const p = url.pathname
    const isUpgrade = req.headers.get('upgrade')?.toLowerCase() === 'websocket'
    const isStream = p === '/events' || p === '/v1/events' || p === '/stream'
    // Machine surfaces: writes routed + clamped to the token's org; the cache
    // tier comes from the TOKEN (the static VX_CLOUD_PR_TOKEN model is dead).
    const tokenOnly =
      isUpgrade ||
      p === '/v1/agents' ||
      p === '/v1/ingest' ||
      p === '/v1/ingest/logs' ||
      /^\/v1\/cache\/[0-9a-f]{16,64}$/.test(p)
    const gated = tokenOnly || isStream || p === '/mcp' || p.startsWith('/v1/')
    // Everything else is the SPA catch-all — static code; every data call it
    // makes lands on a gated surface.
    if (!gated) return { principal: DEFAULT_PRINCIPAL }

    let principal = await resolvePrincipal(db.sql, config.secret, req)
    if (principal === null && (isUpgrade || isStream)) {
      // Browser EventSource/WebSocket can't set headers; ?token= only there.
      const qt = url.searchParams.get('token')
      if (qt !== null) principal = await lookupToken(db.sql, qt)
    }
    if (principal === null) {
      return refuse('unauthorized', 401, { 'WWW-Authenticate': 'Bearer' })
    }
    if (principal.kind === 'token') {
      // The org id becomes the artifact-store bucket, so cache scopes are
      // org-partitioned from P1 (`<orgId>/<tier>[/<sub>]/<hash>`).
      return {
        principal: { tier: principal.tier, bucket: principal.orgId },
        ingest: storeFor(principal.orgId),
      }
    }
    if (tokenOnly) return refuse('ci token required', 403)
    // Session analytics read: clamp to ONE org — ?org= when given, else the
    // sole membership.
    const orgParam = url.searchParams.get('org')
    let orgId: string
    if (orgParam !== null) {
      if (!UUID_RE.test(orgParam)) return refuse('invalid org', 400)
      orgId = orgParam
    } else if (principal.orgs.size === 1) {
      orgId = [...principal.orgs.keys()][0]!
    } else {
      return refuse('org query param required (principal spans several orgs)', 400)
    }
    if (!hasOrgRole(principal, orgId, 'viewer')) return refuse('not found', 404)
    if (!principal.orgs.has(orgId)) {
      // Instance admin reading an org it isn't a member of: verify existence
      // so a garbage id can't materialize an empty org store.
      const rows = await db.sql<{ id: string }[]>`
        SELECT id FROM organizations WHERE id = ${orgId}`
      if (rows.length === 0) return refuse('not found', 404)
    }
    return { principal: { tier: 'trusted', bucket: orgId }, ingest: storeFor(orgId) }
  }

  const serve = await startServe({
    root: config.dataDir,
    ingestDir: path.join(config.dataDir, 'ingest'),
    port: config.port,
    host: '0.0.0.0',
    name: serverName,
    s3: config.s3,
    gate,
    ...(opts.uiHtmlPath !== undefined ? { uiHtmlPath: opts.uiHtmlPath } : {}),
  })

  return {
    origin: serve.origin,
    stop: async () => {
      await serve.stop()
      for (const s of orgStores.values()) {
        try {
          s.close()
        } catch {
          // already closed
        }
      }
      await db.close()
    },
  }
}

export async function serverCmd(args: readonly string[]): Promise<number> {
  if (args.length > 0) {
    process.stderr.write(
      `vx-cloud server: unknown argument: ${args[0]} — configuration is environment-driven (vx-cloud help)\n`,
    )
    return 1
  }
  const resolved = resolveServerConfig(process.env)
  if (!resolved.ok) {
    process.stderr.write(
      'vx-cloud server: refusing to start — configuration incomplete:\n' +
        resolved.errors.map((e) => `  - ${e}\n`).join(''),
    )
    return 1
  }
  const uiHtmlPath = await loadUiHtmlPath()
  let server: PlatformServer
  try {
    server = await startServer({
      config: resolved.config,
      ...(uiHtmlPath !== null ? { uiHtmlPath } : {}),
    })
  } catch (err) {
    process.stderr.write(`vx-cloud server: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
  process.stdout.write(
    `vx-cloud server: listening on ${server.origin} (public: ${resolved.config.baseUrl})\n` +
      `vx-cloud server: dashboard ${uiHtmlPath !== null ? 'embedded' : 'not built (API only)'}\n` +
      `(press Ctrl-C to stop)\n`,
  )
  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => resolve())
    process.once('SIGTERM', () => resolve())
  })
  await server.stop()
  process.stdout.write('\nvx-cloud server: stopped\n')
  return 0
}
