// Boot a REAL platform server (ephemeral Postgres + fake S3) and provision an
// admin session + a trusted ci token + an untrusted fork-pr token — the shared
// setup the machine-surface e2e suites drive the cache wire / dist / MCP
// against. Mirrors the inline setup in server.test.ts.

import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolveServerConfig, startServer, type PlatformServer } from '../../src/cli/server.js'
import { ephemeralPg } from './ephemeral-pg.js'
import { startFakeS3, type FakeS3 } from './fake-s3.js'

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

export async function bootPlatform(
  opts: { bucket?: string; uiHtmlPath?: string } = {},
): Promise<TestPlatform> {
  const bucket = opts.bucket ?? 'vx-artifacts'
  const pg = await ephemeralPg()
  const s3 = startFakeS3({ bucket })
  const dataDir = await mkdtemp(path.join(tmpdir(), 'vx-platform-test-'))
  const dbUrl = await pg.createDatabase({ empty: true })
  const res = resolveServerConfig({
    DATABASE_URL: dbUrl,
    VX_CLOUD_SECRET: 'x'.repeat(32),
    VX_CLOUD_BASE_URL: 'http://vx.example.dev',
    VX_CLOUD_S3_ENDPOINT: s3.origin,
    VX_CLOUD_S3_BUCKET: bucket,
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
  const origin = server.origin

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
  const ciToken = await mint('ci', 'trusted')
  const untrustedToken = await mint('fork-pr', 'untrusted')

  return {
    server,
    origin,
    dbUrl,
    orgId,
    cookie,
    ciToken,
    untrustedToken,
    s3,
    stop: async () => {
      // `server.stop()` force-closes the HTTP listener but then awaits
      // `db.close()`, which waits on whatever the pool is still doing — and
      // boot fires `ensureIndexes` (CREATE INDEX CONCURRENTLY per partition)
      // in the BACKGROUND. On the shared ephemeral cluster, by the time the
      // late suites run that build is slow enough to stall teardown past the
      // hook timeout, which strands the shared browser and fails every browser
      // suite after it. The connections die with the process; a test does not
      // need to wait for an index it never queries.
      await Promise.race([server.stop(), Bun.sleep(5_000)])
      s3.stop()
      await rm(dataDir, { recursive: true, force: true })
    },
  }
}
