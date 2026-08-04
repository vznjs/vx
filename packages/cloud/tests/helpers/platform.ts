// Boot a REAL platform server (ephemeral Postgres + fake S3) and provision an
// admin session + a trusted ci token + an untrusted fork-pr token — the shared
// setup the machine-surface e2e suites drive the cache wire / dist / MCP
// against.
//
// The provisioning happens ONCE per test process, against a seeded template
// database, and every later boot CLONES it. That matters because the
// provisioning is the expensive part and it is byte-identical every time:
// measured, a from-scratch boot was ~700ms of which `register` alone was
// 300-440ms (argon2id, deliberately slow) plus ~70ms re-running migrations that
// the template already had. Cloning pays ~70ms instead. Suites stay fully
// isolated — each still gets its OWN database, server and bucket; what they
// stop doing is re-deriving the same admin account from scratch.
//
// Side benefit worth naming: a cloned platform boots against a database that
// already has schema AND rows, which is the production shape (a restart), where
// the old path only ever exercised boot-against-virgin-DB.

import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolveServerConfig, startServer, type PlatformServer } from '../../src/cli/server.js'
import { resetTokenCache } from '../../src/auth/tokens.js'
import { resetSessionPrincipalCache } from '../../src/auth/rbac.js'
import { ephemeralPg } from './ephemeral-pg.js'
import { startFakeS3, type FakeS3 } from './fake-s3.js'

/**
 * Pinned across the seed boot and every clone: the session cookie is
 * `<id>.<hmac(secret, id)>`, so a cloned session row only verifies under the
 * secret it was minted with.
 */
const SECRET = 'x'.repeat(32)
const BASE_URL = 'http://vx.example.dev'

/** What provisioning captures — identical in every cloned platform. */
interface Provisioned {
  orgId: string
  cookie: string
  ciToken: string
  untrustedToken: string
}

export interface TestPlatform {
  server: PlatformServer
  origin: string
  /** The platform's own database — for assertions the HTTP surface can't make
   *  (e.g. that a delete really removed rows, not just hid them). */
  dbUrl: string
  orgId: string
  cookie: string
  ciToken: string
  untrustedToken: string
  s3: FakeS3
  stop(): Promise<void>
}

interface StartedServer {
  server: PlatformServer
  s3: FakeS3
  dataDir: string
}

async function startAgainst(
  dbUrl: string,
  opts: { bucket: string; uiHtmlPath?: string },
): Promise<StartedServer> {
  const s3 = startFakeS3({ bucket: opts.bucket })
  const dataDir = await mkdtemp(path.join(tmpdir(), 'vx-platform-test-'))
  const res = resolveServerConfig({
    DATABASE_URL: dbUrl,
    VX_CLOUD_SECRET: SECRET,
    VX_CLOUD_BASE_URL: BASE_URL,
    VX_CLOUD_S3_ENDPOINT: s3.origin,
    VX_CLOUD_S3_BUCKET: opts.bucket,
    VX_CLOUD_S3_ACCESS_KEY_ID: 'ak',
    VX_CLOUD_S3_SECRET_ACCESS_KEY: 'sk',
    VX_CLOUD_PORT: '0',
    VX_CLOUD_DATA_DIR: dataDir,
  })
  if (!res.ok) throw new Error(`config: ${res.errors.join('; ')}`)
  const server = await startServer({
    config: res.config,
    log: () => {},
    // Serve the SPA only when a caller asks (browser e2e / the perf guard) —
    // API-surface suites leave it off so `startServer` doesn't touch the dist.
    ...(opts.uiHtmlPath !== undefined ? { uiHtmlPath: opts.uiHtmlPath } : {}),
  })
  return { server, s3, dataDir }
}

async function stopServer(s: StartedServer): Promise<void> {
  // `server.stop()` force-closes the HTTP listener but then awaits
  // `db.close()`, which waits on whatever the pool is still doing — and boot
  // fires `ensureIndexes` (CREATE INDEX CONCURRENTLY per partition) in the
  // BACKGROUND. On the shared ephemeral cluster, by the time the late suites
  // run that build is slow enough to stall teardown past the hook timeout,
  // which strands the shared browser and fails every browser suite after it.
  // The connections die with the process; a test does not need to wait for an
  // index it never queries. (Connections a raced close leaves behind cannot
  // block a later clone either — `seededTemplate` evicts by datname.)
  await Promise.race([s.server.stop(), Bun.sleep(5_000)])
  s.s3.stop()
  await rm(s.dataDir, { recursive: true, force: true })
}

/** Register the admin and mint both tokens through the REAL HTTP surface. */
async function provision(dbUrl: string): Promise<Provisioned> {
  const started = await startAgainst(dbUrl, { bucket: 'vx-artifacts' })
  try {
    const origin = started.server.origin
    const reg = await fetch(`${origin}/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'password1' }),
    })
    const cookie = /vx_session=([^;]*)/.exec(reg.headers.get('set-cookie') ?? '')![1]!
    const me = await fetch(`${origin}/v1/auth/me`, { headers: { cookie: `vx_session=${cookie}` } })
    const orgId = ((await me.json()) as { orgs: { orgId: string }[] }).orgs[0]!.orgId

    const mint = async (name: string, tier: 'trusted' | 'untrusted'): Promise<string> => {
      const r = await fetch(`${origin}/v1/admin/orgs/${orgId}/tokens`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `vx_session=${cookie}`,
          'x-vx-csrf': '1',
        },
        body: JSON.stringify({ name, tier }),
      })
      return ((await r.json()) as { token: string }).token
    }
    return {
      orgId,
      cookie,
      ciToken: await mint('ci', 'trusted'),
      untrustedToken: await mint('fork-pr', 'untrusted'),
    }
  } finally {
    await stopServer(started)
  }
}

export async function bootPlatform(
  opts: { bucket?: string; uiHtmlPath?: string } = {},
): Promise<TestPlatform> {
  const bucket = opts.bucket ?? 'vx-artifacts'
  const pg = await ephemeralPg()
  const template = await pg.seededTemplate('vx_platform', provision)
  const dbUrl = await template.clone()
  // The auth memos are keyed by credential digest, and cloned platforms present
  // the SAME credentials — resolving to identical principals, so a carried-over
  // entry is indistinguishable from a fresh lookup. Cleared anyway so a suite
  // that revokes or demotes cannot reach across into the next platform.
  resetTokenCache()
  resetSessionPrincipalCache()
  const started = await startAgainst(dbUrl, {
    bucket,
    ...(opts.uiHtmlPath !== undefined ? { uiHtmlPath: opts.uiHtmlPath } : {}),
  })

  return {
    server: started.server,
    origin: started.server.origin,
    dbUrl,
    ...template.value,
    s3: started.s3,
    stop: () => stopServer(started),
  }
}
