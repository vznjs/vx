// `vx-cloud server` — the self-hosted platform entrypoint
// (docs/design/cloud-platform-2026-07.md §7.4). Hard-requires configuration:
// Postgres (identity/RBAC system of record), a ≥32-char secret, the public
// base URL, and S3-compatible artifact storage — boot validates the FULL set
// and refuses listing every missing/invalid var at once. There is no
// tokenless mode, no loopback exemption, and no `serve` verb.
//
// The analytics/ingest surfaces are served against Postgres (`db/analytics.ts`),
// org/workspace-clamped by the gate. Everything the gate doesn't recognize as an
// analytics surface (the native cache wire, agents, dist, streaming, SPA) is
// served by the platform HTTP host (`cli/dispatch.ts`) — no SQLite anywhere: the
// artifact store is S3, dist duration hints + `/v1/artifacts` provenance + the
// `/mcp` tools all read Postgres. (P4 absorbed the transitional `cli/serve.ts`.)

import path from 'node:path'
import { VERSION } from '@vzn/vx'
import { openDb, type DbClient } from '../db/client.js'
import { ensureIndexes } from '../db/indexes.js'
import { runMigrations } from '../db/migrate.js'
import { maintainPartitions } from '../db/partitions.js'
import { Analytics } from '../db/analytics.js'
import { handleAnalyticsRequest, type AnalyticsRouteCtx } from '../db/analytics-routes.js'
import { createLoginThrottle, handleAuthRoutes, type AuthRoutesContext } from '../auth/routes.js'
import { hasOrgRole, resolvePrincipal } from '../auth/rbac.js'
import { lookupToken } from '../auth/tokens.js'
import { DEFAULT_PRINCIPAL, type Principal } from '../artifact-store.js'
import { S3Backend } from '../blob/s3.js'
import { loadUiHtmlPath, startPlatformHttp, type Grant, type ResolvedS3Config } from './dispatch.js'

const NIL_UUID = '00000000-0000-0000-0000-000000000000'

/** Daily partition maintenance interval (create ahead, drop past retention). */
const PARTITION_TICK_MS = 24 * 60 * 60 * 1000

/**
 * Routes served by the Postgres analytics layer (`db/analytics-routes.ts`).
 * Everything NOT matched here falls through to the serve's machine surfaces
 * (native cache wire, agents, dist, streaming, SPA). The `/v1/workspace/*`
 * catalog + `/v1/artifacts` (provenance resolved in the gate) are NOT analytics
 * — they stay on the serve side. (Run delegation, its `/v1/runs/queue`, and the
 * colocated `/v1/graph` were removed with delegation, platform §12 P3.)
 */
function isAnalyticsSurface(pathname: string, method: string): boolean {
  if (
    pathname === '/v1/ingest' ||
    pathname === '/v1/ingest/task' ||
    pathname === '/v1/ingest/logs' ||
    pathname === '/v1/catalog'
  ) {
    return method === 'POST'
  }
  if (
    pathname === '/v1/artifacts' ||
    pathname === '/v1/cache/batch' ||
    pathname.startsWith('/v1/workspace/') ||
    /^\/v1\/cache\/[0-9a-f]{16,64}$/.test(pathname)
  ) {
    return false
  }
  const EXACT = new Set([
    '/v1/workspaces',
    '/v1/hermeticity',
    '/v1/runs',
    '/v1/invocations',
    '/v1/cache/stats',
    '/v1/cache/hit-split',
    '/v1/cache/breakdown',
    '/v1/cache/savings',
    '/v1/cache/entries',
    '/v1/cache/prunable',
    '/v1/top-tasks',
    '/v1/failures',
    '/v1/notifications',
    '/v1/projects',
    '/v1/trends/runs',
    '/v1/trends/tasks',
    '/v1/trends/heatmap',
    '/v1/trends/storage',
    '/v1/trends/parallelism',
    '/v1/flakiness',
    '/v1/flake-trend',
    '/v1/regressions',
    '/v1/analysis',
    '/v1/branch-failures',
    '/v1/bottlenecks',
    '/v1/history',
  ])
  if (EXACT.has(pathname)) return true
  return (
    /^\/v1\/runs\/[^/]+$/.test(pathname) ||
    /^\/v1\/runs\/[^/]+\/logs\/.+$/.test(pathname) ||
    /^\/v1\/invocations\/[^/]+$/.test(pathname) ||
    /^\/v1\/compare\/[^/]+$/.test(pathname) ||
    /^\/v1\/tasks\/.+$/.test(pathname) ||
    /^\/v1\/explain\/.+$/.test(pathname) ||
    /^\/v1\/why\/[^/]+$/.test(pathname) ||
    /^\/v1\/why\/[^/]+\/.+$/.test(pathname) ||
    /^\/v1\/triage\/[^/]+$/.test(pathname) ||
    /^\/v1\/diff\/[^/]+\/.+$/.test(pathname)
  )
}

/** Machine surfaces that require a ci token; a session hitting them → 403. */
function isMachineTokenOnly(pathname: string, isUpgrade: boolean): boolean {
  return (
    isUpgrade ||
    pathname === '/v1/agents' ||
    pathname === '/v1/cache/batch' ||
    /^\/v1\/cache\/[0-9a-f]{16,64}$/.test(pathname)
  )
}

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
  /**
   * Vestigial: the platform stores no bytes on the controller (Postgres +
   * S3). Kept only so an existing `VX_CLOUD_DATA_DIR` env doesn't error; the
   * server never writes here.
   */
  dataDir: string
  /**
   * Extra browser origins allowed to open the WS/SSE handshakes (a dashboard
   * hosted on a different origin than this server). No Origin (CLI/agent) and
   * same-origin are always allowed; every OTHER cross-origin browser handshake
   * is refused (CSWSH defense). From `VX_CLOUD_ALLOW_ORIGIN` (comma-separated).
   */
  allowedOrigins: readonly string[]
  /**
   * In-process TLS. When both `VX_CLOUD_TLS_CERT` and `VX_CLOUD_TLS_KEY` (PEM
   * file paths) are set, the server terminates TLS itself and serves stable
   * HTTPS/1.1; when unset, TLS lives at an edge proxy. Setting exactly one is a
   * boot error. HTTP/2 multiplexing comes from the edge proxy (Bun has no
   * single-port h1+h2 server today — see PlatformHttpOptions.tls); in-process
   * TLS alone adds keep-alive reuse, not multiplexing.
   */
  tls?: { certPath: string; keyPath: string }
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

  // In-process TLS: both PEM paths, or neither. A partial config is a boot
  // error (never a silent no-TLS fallback). Existence/readability is checked
  // loudly at boot.
  const tlsCert = read('VX_CLOUD_TLS_CERT')
  const tlsKey = read('VX_CLOUD_TLS_KEY')
  let tls: { certPath: string; keyPath: string } | undefined
  if ((tlsCert === undefined) !== (tlsKey === undefined)) {
    errors.push(
      'VX_CLOUD_TLS_CERT and VX_CLOUD_TLS_KEY must both be set (PEM file paths) to enable in-process TLS, or both be unset',
    )
  } else if (tlsCert !== undefined && tlsKey !== undefined) {
    tls = { certPath: tlsCert, keyPath: tlsKey }
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
      allowedOrigins: (read('VX_CLOUD_ALLOW_ORIGIN') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
      ...(tls !== undefined ? { tls } : {}),
    },
  }
}

export interface PlatformServer {
  origin: string
  stop(): Promise<void>
  /** Live count of open SSE/NDJSON stream subscribers (ops + test hook). */
  subscriberCount(): number
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

  // In-process TLS: read the PEM bytes up front so a missing/unreadable cert
  // fails boot with a clear message (never a silent no-TLS start). Serves
  // stable HTTPS/1.1; HTTP/2 multiplexing lives at an edge proxy.
  let tls: Bun.TLSOptions | undefined
  if (config.tls !== undefined) {
    const readPem = async (label: string, p: string): Promise<string> => {
      try {
        return await Bun.file(p).text()
      } catch (err) {
        throw new Error(
          `cannot read ${label} (${p}): ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    try {
      const cert = await readPem('VX_CLOUD_TLS_CERT', config.tls.certPath)
      const key = await readPem('VX_CLOUD_TLS_KEY', config.tls.keyPath)
      tls = { cert, key }
    } catch (err) {
      await db.close().catch(() => undefined)
      throw err
    }
  }
  // Create the current + upcoming analytics partitions and drop those past
  // retention (boot + a daily tick). maintainPartitions is best-effort by
  // construction (never throws; a poisoned partition degrades to rows in
  // DEFAULT), so boot can never die on it — a wedged partition must not take
  // the whole platform offline on the next deploy.
  const bootMaint = await maintainPartitions(db, {
    retentionDays: config.retentionDays,
    warn: (m) => log(`partition maintenance: ${m}`),
  })
  if (bootMaint.created > 0) log(`partitions: created ${bootMaint.created}`)
  // Concurrent-index convergence (db/indexes.ts): CREATE INDEX CONCURRENTLY
  // can't ride the migration transaction, so the desired indexes converge in
  // the BACKGROUND after the server binds — a multi-minute build on a grown
  // deployment must never sit on the boot path (the planner just keeps
  // today's plan until the build lands). Never throws; a crash mid-build
  // leaves catalog state the next boot/tick recovers.
  const indexMaintenance = (): Promise<unknown> =>
    ensureIndexes(db, { log, warn: (m) => log(`index maintenance: ${m}`) })
  const partitionTick = setInterval(() => {
    void maintainPartitions(db, {
      retentionDays: config.retentionDays,
      warn: (m) => log(`partition maintenance: ${m}`),
    }).then(indexMaintenance)
  }, PARTITION_TICK_MS)
  partitionTick.unref()

  const analytics = new Analytics(db.sql)

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

  const startedAt = Date.now()
  const serverName = new URL(config.baseUrl).hostname

  /**
   * Run one analytics/ingest/log/catalog request against Postgres, resolving
   * the read-workspace clamp. A workspace-scoped token is pinned to its own
   * workspace; a `?ws=` foreign to the org 404s; a write ignores the read
   * clamp (routing resolves the workspace, §5.5).
   */
  const dispatchAnalytics = async (
    req: Request,
    url: URL,
    base: {
      orgId: string
      tokenWorkspaceId?: string | undefined
      tokenId?: string | undefined
      isToken: boolean
    },
  ): Promise<Response> => {
    let workspaceId: string
    if (base.tokenWorkspaceId !== undefined) {
      workspaceId = base.tokenWorkspaceId
    } else {
      const wsParam = url.searchParams.get('ws')
      const resolved = await analytics.resolveReadWorkspace(base.orgId, wsParam)
      if (resolved === null) {
        if (wsParam !== null) return refuse('unknown workspace', 404)
        workspaceId = NIL_UUID
      } else {
        workspaceId = resolved
      }
    }
    const ctx: AnalyticsRouteCtx = {
      analytics,
      orgId: base.orgId,
      workspaceId,
      isToken: base.isToken,
    }
    if (base.tokenWorkspaceId !== undefined) ctx.tokenWorkspaceId = base.tokenWorkspaceId
    if (base.tokenId !== undefined) ctx.tokenId = base.tokenId
    const res = await handleAnalyticsRequest(ctx, req, url)
    return res ?? refuse('not found', 404)
  }

  // The §6.5 surface → principal map, as the platform gate. Analytics surfaces
  // resolve to a Postgres-served Response here; the machine surfaces (native
  // cache wire, agents, dist, streaming, SPA) fall through to the platform HTTP
  // host with just the resolved principal.

  // `/v1/artifacts` provenance joins Postgres `task_runs`, workspace-clamped.
  // The list itself is scoped by the principal's cache prefix (org-partitioned),
  // so the provenance resolver never leaks across the tenant boundary; a foreign
  // / absent workspace resolves to null → no provenance (never a cross-org leak).
  const artifactsGrant = async (principal: Principal, wsId: string | null): Promise<Grant> =>
    wsId !== null
      ? { principal, provenance: (hashes) => analytics.provenanceForHashes(wsId, hashes) }
      : { principal }

  // CSWSH defense: a cross-origin browser page must not open the WS/SSE
  // channels. Browsers ALWAYS send `Origin` on a WS/EventSource handshake; a
  // CLI client (an agent, a `vx run` submitter) sends none. Allow: no Origin
  // (CLI), same-origin, or an operator-configured origin (a hosted dashboard).
  const allowedOriginSet = new Set(config.allowedOrigins)
  const originAllowed = (req: Request, url: URL): boolean => {
    const origin = req.headers.get('origin')
    if (origin === null) return true
    if (allowedOriginSet.has(origin)) return true
    try {
      return new URL(origin).host === url.host
    } catch {
      return false
    }
  }

  const gate = async (req: Request, url: URL): Promise<Response | Grant> => {
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
          // 2 → the batch existence probe (`POST /v1/cache/batch`) is hosted.
          cacheWire: 2,
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
    // CSWSH: refuse a cross-origin browser WS/SSE handshake before touching
    // auth (the token, when present, is a second gate; the Origin check blocks
    // a drive-by page from opening the channels at all).
    if ((isUpgrade || isStream) && !originAllowed(req, url)) {
      return refuse('origin not allowed', 403)
    }
    const gated = isUpgrade || isStream || p === '/mcp' || p.startsWith('/v1/')
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
      if (isAnalyticsSurface(p, req.method)) {
        return dispatchAnalytics(req, url, {
          orgId: principal.orgId,
          tokenWorkspaceId: principal.workspaceId,
          tokenId: principal.tokenId,
          isToken: true,
        })
      }
      // Cache scopes are tenant-partitioned (§8.1): the token's org + its
      // bound workspace (org-wide → the shared `_org` segment) + its immutable
      // tier — all server-derived, `org/<orgId>/ws/<wsId>/<tier>[/<sub>]`.
      const tokenPrincipal: Principal = {
        orgId: principal.orgId,
        ...(principal.workspaceId !== undefined ? { workspaceId: principal.workspaceId } : {}),
        tier: principal.tier,
      }
      if (p === '/v1/artifacts') {
        const wsId =
          principal.workspaceId ??
          (await analytics.resolveReadWorkspace(principal.orgId, url.searchParams.get('ws')))
        return artifactsGrant(tokenPrincipal, wsId)
      }
      return { principal: tokenPrincipal }
    }

    // Session. The token-only machine surfaces (cache wire, agents, WS) are
    // never a session principal — refuse before resolving an org.
    if (isMachineTokenOnly(p, isUpgrade)) return refuse('ci token required', 403)
    // Clamp to ONE org — ?org= when given, else the sole membership.
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
      // Instance admin reading an org it isn't a member of: verify existence.
      const rows = await db.sql<{ id: string }[]>`
        SELECT id FROM organizations WHERE id = ${orgId}`
      if (rows.length === 0) return refuse('not found', 404)
    }
    if (isAnalyticsSurface(p, req.method)) {
      return dispatchAnalytics(req, url, { orgId, isToken: false })
    }
    // A session reading `/v1/artifacts`: scope the list to the requested (or
    // most-recent) workspace so the entries + their provenance align.
    if (p === '/v1/artifacts') {
      const wsId = await analytics.resolveReadWorkspace(orgId, url.searchParams.get('ws'))
      const principalForList: Principal = {
        orgId,
        ...(wsId !== null ? { workspaceId: wsId } : {}),
        tier: 'trusted',
      }
      return artifactsGrant(principalForList, wsId)
    }
    // A session hitting another non-analytics gated surface (mcp, streaming,
    // run WS): an org-wide trusted principal (no workspace binding — a session
    // reads via `?ws=`, not a token scope).
    return { principal: { orgId, tier: 'trusted' } }
  }

  const serve = await startPlatformHttp({
    port: config.port,
    host: '0.0.0.0',
    name: serverName,
    s3: config.s3,
    analytics,
    gate,
    log,
    ...(opts.uiHtmlPath !== undefined ? { uiHtmlPath: opts.uiHtmlPath } : {}),
    ...(tls !== undefined ? { tls } : {}),
  })
  if (tls !== undefined) {
    log('transport: in-process TLS (HTTPS/1.1); use an edge proxy for HTTP/2')
  }
  void indexMaintenance()

  return {
    origin: serve.origin,
    subscriberCount: () => serve.subscriberCount(),
    stop: async () => {
      clearInterval(partitionTick)
      await serve.stop()
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
