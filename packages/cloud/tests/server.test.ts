// `vx-cloud server` — the platform entrypoint (cloud-platform-2026-07 §7.4,
// §12 P1): config-required boot against real Postgres + fake S3, the §6.5
// gate in front of the transitional serve surfaces, and the serve verb's
// removal.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { RunSummaryRecord } from '@vzn/vx'
import { resolveServerConfig, startServer, type PlatformServer } from '../src/cli/server.js'
import { ephemeralPg } from './helpers/ephemeral-pg.js'
import { startFakeS3, type FakeS3 } from './helpers/fake-s3.js'

const BASE_ENV = {
  DATABASE_URL: 'postgres://vx@localhost/vx',
  VX_CLOUD_SECRET: 'x'.repeat(32),
  VX_CLOUD_BASE_URL: 'https://vx.example.dev',
  VX_CLOUD_S3_ENDPOINT: 'http://localhost:9000',
  VX_CLOUD_S3_BUCKET: 'vx-artifacts',
  VX_CLOUD_S3_ACCESS_KEY_ID: 'ak',
  VX_CLOUD_S3_SECRET_ACCESS_KEY: 'sk',
}

describe('resolveServerConfig', () => {
  it('an empty env lists EVERY missing required var at once', () => {
    const res = resolveServerConfig({})
    expect(res.ok).toBe(false)
    const errors = (res as { errors: string[] }).errors
    for (const name of [
      'DATABASE_URL',
      'VX_CLOUD_SECRET',
      'VX_CLOUD_BASE_URL',
      'VX_CLOUD_S3_ENDPOINT',
      'VX_CLOUD_S3_BUCKET',
      'VX_CLOUD_S3_ACCESS_KEY_ID',
      'VX_CLOUD_S3_SECRET_ACCESS_KEY',
    ]) {
      expect(errors.some((e) => e.includes(name))).toBe(true)
    }
    expect(errors).toHaveLength(7)
  })

  it('each missing var is named individually', () => {
    for (const name of Object.keys(BASE_ENV)) {
      const env = { ...BASE_ENV } as Record<string, string>
      delete env[name]
      const res = resolveServerConfig(env)
      expect(res.ok).toBe(false)
      const errors = (res as { errors: string[] }).errors
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain(name)
    }
  })

  it('validates values: short secret, bad base URL, bad numbers', () => {
    const short = resolveServerConfig({ ...BASE_ENV, VX_CLOUD_SECRET: 'short' })
    expect((short as { errors: string[] }).errors[0]).toContain('at least 32')
    const badUrl = resolveServerConfig({ ...BASE_ENV, VX_CLOUD_BASE_URL: 'not a url' })
    expect((badUrl as { errors: string[] }).errors[0]).toContain('VX_CLOUD_BASE_URL')
    const badPort = resolveServerConfig({ ...BASE_ENV, VX_CLOUD_PORT: 'abc' })
    expect((badPort as { errors: string[] }).errors[0]).toContain('VX_CLOUD_PORT')
    const badRet = resolveServerConfig({ ...BASE_ENV, VX_CLOUD_RETENTION_DAYS: '-1' })
    expect((badRet as { errors: string[] }).errors[0]).toContain('VX_CLOUD_RETENTION_DAYS')
    const badDb = resolveServerConfig({ ...BASE_ENV, DATABASE_URL: 'mysql://nope' })
    expect((badDb as { errors: string[] }).errors[0]).toContain('postgres://')
  })

  it('resolves defaults and optional overrides', () => {
    const res = resolveServerConfig({
      ...BASE_ENV,
      VX_CLOUD_PORT: '0',
      VX_CLOUD_OPEN_SIGNUP: '1',
      VX_CLOUD_S3_REGION: 'us-east-1',
      VX_CLOUD_DATA_DIR: '/data',
    })
    expect(res.ok).toBe(true)
    const config = (res as Extract<ReturnType<typeof resolveServerConfig>, { ok: true }>).config
    expect(config.port).toBe(0)
    expect(config.retentionDays).toBe(180)
    expect(config.openSignup).toBe(true)
    expect(config.openOrgCreate).toBe(false)
    expect(config.s3.region).toBe('us-east-1')
    expect(config.s3.presignTtlSeconds).toBe(300)
    expect(config.dataDir).toBe('/data')
  })
})

describe('boot refusals', () => {
  it('fails loud when Postgres is unreachable', async () => {
    const res = resolveServerConfig({
      ...BASE_ENV,
      DATABASE_URL: 'postgres://vx@127.0.0.1:1/nope',
      VX_CLOUD_PORT: '0',
    })
    if (!res.ok) throw new Error('config expected ok')
    await expect(startServer({ config: res.config, log: () => {} })).rejects.toThrow(
      'cannot reach Postgres',
    )
  })

  it('fails loud when the S3 probe fails — never a silent local fallback', async () => {
    const pg = await ephemeralPg()
    const res = resolveServerConfig({
      ...BASE_ENV,
      DATABASE_URL: await pg.createDatabase({ empty: true }),
      VX_CLOUD_S3_ENDPOINT: 'http://127.0.0.1:1',
      VX_CLOUD_PORT: '0',
    })
    if (!res.ok) throw new Error('config expected ok')
    await expect(startServer({ config: res.config, log: () => {} })).rejects.toThrow(
      'S3 probe failed',
    )
  })
})

describe('serve verb removal', () => {
  it('`vx-cloud serve` errors pointing at `server`; help names `server`', async () => {
    const bin = path.join(import.meta.dir, '..', 'src', 'cli', 'bin.ts')
    const proc = Bun.spawnSync({ cmd: ['bun', bin, 'serve'], stdout: 'pipe', stderr: 'pipe' })
    expect(proc.exitCode).toBe(1)
    const err = proc.stderr.toString()
    expect(err).toContain('`serve` was removed')
    expect(err).toContain('vx-cloud server')
    const help = Bun.spawnSync({ cmd: ['bun', bin, 'help'], stdout: 'pipe', stderr: 'pipe' })
    expect(help.stdout.toString()).toContain('vx-cloud server')
    expect(help.stdout.toString()).not.toContain('vx-cloud serve [')
  })
})

function summary(runId: string, workspaceId: string, taskHash = 'h-a'): RunSummaryRecord {
  return {
    v: 2,
    run: {
      runId,
      vxVersion: '0.0.0',
      workspaceId,
      workspaceName: 'fixture-ws',
      command: 'vx run build',
      requestedTasks: ['build'],
      cachePolicy: 'lR,lW,rR,rW',
      concurrency: 2,
      flow: 'broad',
      commitSha: 'c0ffee',
      branch: 'main',
      dirty: false,
      ci: true,
      ciProvider: 'github',
      host: 'box',
      os: 'linux',
      arch: 'x64',
      tags: {},
    },
    startedAt: 1000,
    endedAt: 1200,
    totalDurationMs: 200,
    taskCount: 1,
    failedCount: 0,
    hitCount: 0,
    hitLocalCount: 0,
    hitRemoteCount: 0,
    exitOk: true,
    tasks: [
      {
        taskId: 'a#build',
        project: 'a',
        task: 'build',
        status: 'success',
        cacheSource: 'miss',
        exitCode: 0,
        durationMs: 120,
        hash: taskHash,
      },
    ],
  } as RunSummaryRecord
}

describe('platform e2e (real pg + fake S3)', () => {
  let s3: FakeS3
  let server: PlatformServer
  let dataDir: string
  let origin = ''
  let cookie = ''
  let orgId = ''
  let ciToken = ''
  let untrustedToken = ''

  const call = async (
    method: string,
    p: string,
    opts: {
      body?: unknown
      rawBody?: Uint8Array
      cookie?: string
      bearer?: string
      csrf?: boolean
      redirect?: 'manual' | 'follow' | 'error'
    } = {},
  ): Promise<Response> => {
    const headers: Record<string, string> = {}
    if (opts.body !== undefined) headers['content-type'] = 'application/json'
    if (opts.cookie !== undefined) headers['cookie'] = `vx_session=${opts.cookie}`
    if (opts.bearer !== undefined) headers['authorization'] = `Bearer ${opts.bearer}`
    if (opts.csrf === true) headers['x-vx-csrf'] = '1'
    return await fetch(`${origin}${p}`, {
      method,
      headers,
      ...(opts.body !== undefined
        ? { body: JSON.stringify(opts.body) }
        : opts.rawBody !== undefined
          ? { body: opts.rawBody }
          : {}),
      ...(opts.redirect !== undefined ? { redirect: opts.redirect } : {}),
    })
  }

  beforeAll(async () => {
    const pg = await ephemeralPg()
    s3 = startFakeS3({ bucket: 'vx-artifacts' })
    dataDir = await mkdtemp(path.join(tmpdir(), 'vx-server-test-'))
    // An EMPTY database: boot itself must run the migrations.
    const res = resolveServerConfig({
      ...BASE_ENV,
      DATABASE_URL: await pg.createDatabase({ empty: true }),
      VX_CLOUD_BASE_URL: 'http://vx.example.dev',
      VX_CLOUD_S3_ENDPOINT: s3.origin,
      VX_CLOUD_PORT: '0',
      VX_CLOUD_DATA_DIR: dataDir,
    })
    if (!res.ok) {
      throw new Error(`config: ${(res as unknown as { errors: string[] }).errors.join('; ')}`)
    }
    server = await startServer({ config: res.config, log: () => {} })
    origin = server.origin
  })

  afterAll(async () => {
    await server.stop()
    s3.stop()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('health is open; /v1/meta advertises account auth without tenant data', async () => {
    expect((await call('GET', '/health')).status).toBe(200)
    const meta = await call('GET', '/v1/meta')
    expect(meta.status).toBe(200)
    const body = (await meta.json()) as Record<string, unknown>
    expect(body['auth']).toBe('account')
    expect(body['cacheWire']).toBe(1)
    expect('workspaces' in body).toBe(false)
  })

  it('register → login → mint tokens over real HTTP', async () => {
    const reg = await call('POST', '/v1/auth/register', {
      body: { email: 'admin@example.com', password: 'password1' },
    })
    expect(reg.status).toBe(201)
    cookie = /vx_session=([^;]*)/.exec(reg.headers.get('set-cookie') ?? '')![1]!
    const me = await call('GET', '/v1/auth/me', { cookie })
    const meBody = (await me.json()) as { orgs: { orgId: string }[] }
    orgId = meBody.orgs[0]!.orgId
    const mint = await call('POST', `/v1/admin/orgs/${orgId}/tokens`, {
      cookie,
      csrf: true,
      body: { name: 'ci', tier: 'trusted' },
    })
    expect(mint.status).toBe(201)
    ciToken = ((await mint.json()) as { token: string }).token
    const mintPr = await call('POST', `/v1/admin/orgs/${orgId}/tokens`, {
      cookie,
      csrf: true,
      body: { name: 'fork-pr', tier: 'untrusted' },
    })
    untrustedToken = ((await mintPr.json()) as { token: string }).token
  })

  it('ingest requires a ci token; analytics read back under the session', async () => {
    expect((await call('GET', '/v1/runs')).status).toBe(401)
    const asSession = await call('POST', '/v1/ingest', {
      cookie,
      body: summary('r-nope', 'ws-e2e'),
    })
    expect(asSession.status).toBe(403)
    const pushed = await call('POST', '/v1/ingest', {
      bearer: ciToken,
      body: summary('r-1', 'ws-e2e'),
    })
    expect(pushed.status).toBe(200)
    expect(((await pushed.json()) as { stored: boolean }).stored).toBe(true)
    const runs = await call('GET', '/v1/runs', { cookie })
    expect(runs.status).toBe(200)
    const { runs: rows } = (await runs.json()) as { runs: { runId: string }[] }
    expect(rows.some((r) => r.runId === 'r-1')).toBe(true)
    // The token reads the same org-scoped store.
    const viaToken = await call('GET', '/v1/runs', { bearer: ciToken })
    expect(viaToken.status).toBe(200)
  })

  it('the Postgres analytics surfaces reflect the ingested run', async () => {
    // The push auto-provisioned a workspace + project.
    const ws = await call('GET', '/v1/workspaces', { cookie })
    const { workspaces } = (await ws.json()) as { workspaces: { name: string; runCount: number }[] }
    expect(workspaces).toHaveLength(1)
    expect(workspaces[0]!.name).toBe('fixture-ws')
    expect(workspaces[0]!.runCount).toBe(1)

    const projects = await call('GET', '/v1/projects', { cookie })
    const { projects: rows } = (await projects.json()) as { projects: { project: string }[] }
    expect(rows.some((r) => r.project === 'a')).toBe(true)

    const detail = await call('GET', '/v1/tasks/a%23build', { cookie })
    expect(detail.status).toBe(200)
    const td = (await detail.json()) as { aggregate: { runs: number } | null }
    expect(td.aggregate!.runs).toBe(1)

    // A ?ws= foreign to the org is a 404 (the tenant clamp).
    const foreign = await call('GET', `/v1/runs?ws=${orgId}`, { cookie })
    expect(foreign.status).toBe(404)
  })

  it('cache wire: tier rides the token — untrusted writes its own scope, trusted never reads it', async () => {
    const hash = 'ab'.repeat(10)
    const body = Bun.zstdCompressSync(new TextEncoder().encode('artifact-bytes'))
    const put = await call('PUT', `/v1/cache/${hash}`, {
      bearer: untrustedToken,
      rawBody: body,
    })
    expect(put.status).toBe(200)
    // The blob landed tenant-partitioned (org-wide token → shared _org
    // segment) under the UNTRUSTED scope: org/<orgId>/ws/_org/untrusted/…
    const keys = [...s3.objects.keys()]
    expect(
      keys.some((k) => k.includes(`org/${orgId}/ws/_org/untrusted/`) && k.includes(hash)),
    ).toBe(true)
    // The writer reads it back (307 to a presigned URL — offloaded storage).
    const back = await call('GET', `/v1/cache/${hash}`, {
      bearer: untrustedToken,
      redirect: 'manual',
    })
    expect(back.status).toBe(307)
    // A trusted principal NEVER consumes an untrusted artifact.
    const trustedGet = await call('GET', `/v1/cache/${hash}`, {
      bearer: ciToken,
      redirect: 'manual',
    })
    expect(trustedGet.status).toBe(404)
    // No bearer → 401; a session is not a cache principal → 403.
    expect((await call('GET', `/v1/cache/${hash}`)).status).toBe(401)
    expect((await call('GET', `/v1/cache/${hash}`, { cookie })).status).toBe(403)
  })

  it('cache wire: a workspace-scoped token stores under its own workspace segment', async () => {
    // The ingest test auto-provisioned a workspace; mint a token bound to it.
    const wsRes = await call('GET', '/v1/workspaces', { cookie })
    const { workspaces } = (await wsRes.json()) as { workspaces: { id: string }[] }
    const wsId = workspaces[0]!.id
    const mint = await call('POST', `/v1/admin/orgs/${orgId}/tokens`, {
      cookie,
      csrf: true,
      body: { name: 'ws-scoped', tier: 'trusted', workspaceId: wsId },
    })
    expect(mint.status).toBe(201)
    const wsToken = ((await mint.json()) as { token: string }).token
    const hash = 'cd'.repeat(10)
    const body = Bun.zstdCompressSync(new TextEncoder().encode('ws-scoped-bytes'))
    expect(
      (await call('PUT', `/v1/cache/${hash}`, { bearer: wsToken, rawBody: body })).status,
    ).toBe(200)
    // Landed under the token's own workspace segment, not the shared _org one.
    const keys = [...s3.objects.keys()]
    expect(
      keys.some((k) => k.includes(`org/${orgId}/ws/${wsId}/trusted/`) && k.includes(hash)),
    ).toBe(true)
    // The org-wide trusted ci token does NOT see the workspace-scoped cache.
    expect(
      (await call('GET', `/v1/cache/${hash}`, { bearer: ciToken, redirect: 'manual' })).status,
    ).toBe(404)
  })

  it('/v1/artifacts joins producing-task provenance from Postgres task_runs', async () => {
    const wsRes = await call('GET', '/v1/workspaces', { cookie })
    const { workspaces } = (await wsRes.json()) as { workspaces: { id: string }[] }
    const wsId = workspaces[0]!.id
    // A ws-scoped token so the list scope + the provenance workspace both = wsId.
    const mint = await call('POST', `/v1/admin/orgs/${orgId}/tokens`, {
      cookie,
      csrf: true,
      body: { name: 'prov', tier: 'trusted', workspaceId: wsId },
    })
    const wsToken = ((await mint.json()) as { token: string }).token
    // Ingest a run whose task produced a hex-named artifact hash, then upload it.
    const hash = 'feedfeedfeedfeed'
    const pushed = await call('POST', '/v1/ingest', {
      bearer: ciToken,
      body: summary('r-prov', 'ws-e2e', hash),
    })
    expect(pushed.status).toBe(200)
    const artBody = Bun.zstdCompressSync(new TextEncoder().encode('prov-bytes'))
    expect(
      (await call('PUT', `/v1/cache/${hash}`, { bearer: wsToken, rawBody: artBody })).status,
    ).toBe(200)
    // The list carries the producing task/run joined from task_runs.
    const listed = await call('GET', '/v1/artifacts', { bearer: wsToken })
    expect(listed.status).toBe(200)
    const { artifacts } = (await listed.json()) as {
      artifacts: Array<{ hash: string; task?: { project: string; task: string; runId?: string } }>
    }
    const entry = artifacts.find((a) => a.hash === hash)
    expect(entry).toBeDefined()
    expect(entry!.task).toEqual({ project: 'a', task: 'build', runId: 'r-prov' })
  })

  it('the serve-era /version handshake is gone', async () => {
    expect((await call('GET', '/version', { cookie })).status).toBe(404)
    expect((await call('GET', '/version', { bearer: ciToken })).status).toBe(404)
  })
})
