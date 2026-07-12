// `vx-cloud server` — the platform entrypoint (cloud-platform-2026-07 §7.4,
// §12 P1): config-required boot against real Postgres + fake S3, the §6.5
// gate in front of the transitional serve surfaces, and the serve verb's
// removal.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import path from 'node:path'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { RunSummaryRecord } from '@vzn/vx'
import { resolveServerConfig, startServer, type PlatformServer } from '../src/cli/server.js'
import { ephemeralPg } from './helpers/ephemeral-pg.js'
import { startFakeS3, type FakeS3 } from './helpers/fake-s3.js'
import { bootPlatform } from './helpers/platform.js'

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
    expect(config.tls).toBeUndefined()
  })

  it('TLS: both cert+key resolve to a tls config; h3 stays off by default', () => {
    const res = resolveServerConfig({
      ...BASE_ENV,
      VX_CLOUD_TLS_CERT: '/etc/vx/cert.pem',
      VX_CLOUD_TLS_KEY: '/etc/vx/key.pem',
    })
    expect(res.ok).toBe(true)
    const config = (res as Extract<ReturnType<typeof resolveServerConfig>, { ok: true }>).config
    expect(config.tls).toEqual({ certPath: '/etc/vx/cert.pem', keyPath: '/etc/vx/key.pem' })
    // HTTP/3 is experimental and opt-in — TLS alone is stable HTTPS/1.1.
    expect(config.http3).toBe(false)
  })

  it('TLS: a partial config (one of cert/key) is a boot error', () => {
    const certOnly = resolveServerConfig({ ...BASE_ENV, VX_CLOUD_TLS_CERT: '/etc/vx/cert.pem' })
    expect(certOnly.ok).toBe(false)
    expect((certOnly as { errors: string[] }).errors[0]).toContain('VX_CLOUD_TLS_KEY')
    const keyOnly = resolveServerConfig({ ...BASE_ENV, VX_CLOUD_TLS_KEY: '/etc/vx/key.pem' })
    expect(keyOnly.ok).toBe(false)
    expect((keyOnly as { errors: string[] }).errors[0]).toContain('VX_CLOUD_TLS_CERT')
  })

  it('HTTP/3: opt-in on top of TLS resolves http3=true', () => {
    const res = resolveServerConfig({
      ...BASE_ENV,
      VX_CLOUD_TLS_CERT: '/etc/vx/cert.pem',
      VX_CLOUD_TLS_KEY: '/etc/vx/key.pem',
      VX_CLOUD_HTTP3: '1',
    })
    expect(res.ok).toBe(true)
    const config = (res as Extract<ReturnType<typeof resolveServerConfig>, { ok: true }>).config
    expect(config.http3).toBe(true)
  })

  it('HTTP/3: opt-in without in-process TLS is a boot error', () => {
    const res = resolveServerConfig({ ...BASE_ENV, VX_CLOUD_HTTP3: '1' })
    expect(res.ok).toBe(false)
    expect((res as { errors: string[] }).errors[0]).toContain('VX_CLOUD_HTTP3')
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
    expect(body['cacheWire']).toBe(2)
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

  it('cache wire: batch existence probe is machine-token gated and trust-scoped', async () => {
    const presentHash = 'ba'.repeat(10)
    const absentHash = 'ef'.repeat(10)
    const body = Bun.zstdCompressSync(new TextEncoder().encode('batch-bytes'))
    expect(
      (await call('PUT', `/v1/cache/${presentHash}`, { bearer: ciToken, rawBody: body })).status,
    ).toBe(200)

    // A ci token gets the present subset in ONE round-trip.
    const res = await call('POST', '/v1/cache/batch', {
      bearer: ciToken,
      body: { hashes: [presentHash, absentHash] },
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { present: string[] }).present).toEqual([presentHash])

    // No bearer → 401; a session is NOT a cache principal → 403 (machine-token-only).
    expect(
      (await call('POST', '/v1/cache/batch', { body: { hashes: [presentHash] } })).status,
    ).toBe(401)
    expect(
      (await call('POST', '/v1/cache/batch', { cookie, body: { hashes: [presentHash] } })).status,
    ).toBe(403)

    // Trust scope rides the token: an untrusted token sees the trusted hash
    // (untrusted reads untrusted ∪ trusted), same as a GET would.
    const uRes = await call('POST', '/v1/cache/batch', {
      bearer: untrustedToken,
      body: { hashes: [presentHash] },
    })
    expect(((await uRes.json()) as { present: string[] }).present).toEqual([presentHash])
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

  it('/mcp answers JSON-RPC over Postgres, behind the gate', async () => {
    const rpc = async (body: unknown, bearer?: string): Promise<Response> =>
      call('POST', '/mcp', bearer !== undefined ? { body, bearer } : { body })
    // No bearer → 401 (gated like every machine surface).
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize' })).status).toBe(401)
    // A GET is 405.
    expect((await call('GET', '/mcp', { bearer: ciToken })).status).toBe(405)
    // initialize handshake.
    const init = (await (
      await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize' }, ciToken)
    ).json()) as { result: { serverInfo: { name: string }; protocolVersion: string } }
    expect(init.result.serverInfo.name).toBe('vx-cloud')
    expect(init.result.protocolVersion).toBe('2025-03-26')
    // tools/list — the seven Postgres-backed tools.
    const list = (await (
      await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, ciToken)
    ).json()) as { result: { tools: { name: string }[] } }
    expect(list.result.tools.map((t) => t.name).sort()).toEqual([
      'cache_stats',
      'compare_runs',
      'get_run',
      'list_runs',
      'list_workspaces',
      'run_trends',
      'why_did_rerun',
    ])
    // tools/call list_runs → the ingested invocation, over Postgres.
    const callToolRpc = async (name: string, args: Record<string, unknown> = {}) => {
      const res = (await (
        await rpc(
          { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } },
          ciToken,
        )
      ).json()) as { result: { content: { text: string }[]; isError?: boolean } }
      return res.result
    }
    const runs = callToolRpc('list_runs', { limit: 10 })
    const runsOut = JSON.parse((await runs).content[0]!.text) as {
      runs: { runId: string }[]
    }
    expect(runsOut.runs.some((r) => r.runId === 'r-1')).toBe(true)
    // list_workspaces names the org's auto-provisioned workspace.
    const wss = JSON.parse((await callToolRpc('list_workspaces')).content[0]!.text) as {
      workspaces: { name: string }[]
    }
    expect(wss.workspaces.some((w) => w.name === 'fixture-ws')).toBe(true)
    // A tool error (unknown workspace) is an isError RESULT, not a crash.
    const bad = await callToolRpc('list_runs', { workspace: 'no-such-ws' })
    expect(bad.isError).toBe(true)
    expect(bad.content[0]!.text).toContain('unknown workspace')
    // Unknown method / unknown tool.
    const um = (await (
      await rpc({ jsonrpc: '2.0', id: 9, method: 'resources/list' }, ciToken)
    ).json()) as { error: { code: number } }
    expect(um.error.code).toBe(-32601)
  })

  it('caps an oversized MCP/ingest body with 413 (streaming, before parsing)', async () => {
    // A body past the cap is aborted by the streaming reader — it never
    // buffers up to the 512 MiB server-wide artifact limit. MCP's cap is 4 MiB.
    const huge = `{"jsonrpc":"2.0","id":1,"method":"initialize","x":"${'a'.repeat(4 * 1024 * 1024 + 64)}"}`
    const res = await call('POST', '/mcp', {
      bearer: ciToken,
      rawBody: new TextEncoder().encode(huge),
    })
    expect(res.status).toBe(413)
    // The ingest route shares the same bounded reader; a modest body still works.
    const ok = await call('POST', '/mcp', {
      bearer: ciToken,
      body: { jsonrpc: '2.0', id: 1, method: 'initialize' },
    })
    expect(ok.status).toBe(200)
  })

  it('analytics route wiring: /v1/analysis, /v1/regressions, /v1/hermeticity are served', async () => {
    const analysis = await call('GET', '/v1/analysis', { cookie })
    expect(analysis.status).toBe(200)
    expect('current' in ((await analysis.json()) as Record<string, unknown>)).toBe(true)
    const regressions = await call('GET', '/v1/regressions', { cookie })
    expect(regressions.status).toBe(200)
    expect(Array.isArray(((await regressions.json()) as { tasks: unknown[] }).tasks)).toBe(true)
    const herm = await call('GET', '/v1/hermeticity', { cookie })
    expect(herm.status).toBe(200)
    // The named /v1/cache/* analytics routes are never shadowed by the hex-only
    // artifact wire — `stats` reaches the analytics handler, not a cache 404.
    const stats = await call('GET', '/v1/cache/stats', { cookie })
    expect(stats.status).toBe(200)
    expect('entryCount' in ((await stats.json()) as Record<string, unknown>)).toBe(true)
  })

  it('a malformed percent-encoding in a read path is a 400, not a 500', async () => {
    // `decodeURIComponent('%')` throws URIError — the guard maps it to a clean
    // 400 instead of letting it fall through to a bare 500.
    const bad = await call('GET', '/v1/tasks/%', { cookie })
    expect(bad.status).toBe(400)
    const badRun = await call('GET', '/v1/runs/%c3', { cookie })
    expect(badRun.status).toBe(400)
  })

  it('task-log ingest (ci token) + read back over the analytics route', async () => {
    const bundle = {
      v: 1,
      runId: 'r-1',
      workspaceId: 'ws-e2e',
      tasks: [
        {
          taskId: 'a#build',
          status: 'success',
          content: 'build output tail',
          charsFull: 17,
          truncatedHeadChars: 0,
        },
      ],
    }
    const ingest = await call('POST', '/v1/ingest/logs', { bearer: ciToken, body: bundle })
    expect(ingest.status).toBe(200)
    expect(((await ingest.json()) as { stored: number }).stored).toBe(1)
    const read = await call('GET', '/v1/runs/r-1/logs/a%23build', { cookie })
    expect(read.status).toBe(200)
    const body = (await read.json()) as { content: string; source: string }
    expect(body.content).toBe('build output tail')
    expect(body.source).toBe('executed')
  })

  it('the serve-era /version handshake is gone', async () => {
    expect((await call('GET', '/version', { cookie })).status).toBe(404)
    expect((await call('GET', '/version', { bearer: ciToken })).status).toBe(404)
  })

  it('a removed colocated route (/v1/graph) falls through to the SPA catch-all, not a crash', async () => {
    // /v1/graph + /v1/workspace/* died with the SQLite catalog. An authenticated
    // GET is no analytics/machine surface, so it lands on the SPA catch-all
    // (200, no build here → the plain sentinel), never a 500.
    const res = await call('GET', '/v1/graph', { cookie })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('vx-cloud')
    const ws = await call('GET', '/v1/workspace/projects', { cookie })
    expect(ws.status).toBe(200)
  })

  it('the platform writes NO SQLite (or any) database file to the data dir', async () => {
    // Postgres + S3 only — the controller stores nothing at rest. After a full
    // run of ingest + cache + logs above, the data dir holds no db/sqlite file.
    const files = (await readdir(dataDir, { recursive: true }).catch(() => [] as string[])).map(
      String,
    )
    expect(files.some((f) => /\.(db|sqlite|sqlite3)$/.test(f))).toBe(false)
  })
})

// Regression pins for the P4-server hostile-review findings (2026-07-12):
// (1) the live SSE/NDJSON broadcast must be org-scoped — a HIGH cross-tenant
// leak where any authenticated principal on `/stream` saw every tenant's run
// events; (2) the CSWSH Origin gate the fold dropped must be restored.
describe('P4-server review: live-stream tenant isolation + CSWSH origin gate', () => {
  const collect = (
    origin: string,
    token: string,
  ): { stop: () => Promise<void>; text: () => string } => {
    const ac = new AbortController()
    let text = ''
    const done = fetch(`${origin}/stream?token=${token}`, { signal: ac.signal })
      .then(async (res) => {
        const reader = res.body!.getReader()
        const dec = new TextDecoder()
        for (;;) {
          const { done: d, value } = await reader.read()
          if (d) break
          if (value !== undefined) text += dec.decode(value)
        }
      })
      .catch(() => {})
    return { stop: () => (ac.abort(), done), text: () => text }
  }

  it('scopes /stream events to the subscriber org (no cross-tenant leak)', async () => {
    const p = await bootPlatform()
    try {
      // A second, distinct tenant (org B) + its own ci token.
      const admin = {
        cookie: `vx_session=${p.cookie}`,
        'content-type': 'application/json',
        'x-vx-csrf': '1',
      }
      const mkB = await fetch(`${p.origin}/v1/admin/orgs`, {
        method: 'POST',
        headers: admin,
        body: JSON.stringify({ slug: 'orgb', name: 'Org B' }),
      })
      const orgB = ((await mkB.json()) as { orgId: string }).orgId
      const tokB = await fetch(`${p.origin}/v1/admin/orgs/${orgB}/tokens`, {
        method: 'POST',
        headers: admin,
        body: JSON.stringify({ name: 'ci', tier: 'trusted' }),
      })
      const tokenB = ((await tokB.json()) as { token: string }).token

      const a = collect(p.origin, p.ciToken) // org A subscriber
      const b = collect(p.origin, tokenB) // org B subscriber (the attacker tenant)
      await Bun.sleep(200) // let both streams register on the subscriber set

      // Emit an event on an org-A run WS: a {t:'run'} rejection flows through
      // send() → broadcast(), exactly the path a real dist run's stdout takes.
      const ws = new WebSocket(`${p.origin.replace('http', 'ws')}/?token=${p.ciToken}`)
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener('open', () => resolve())
        ws.addEventListener('error', () => reject(new Error('run WS failed to open')))
      })
      ws.send(JSON.stringify({ t: 'run' }))
      await Bun.sleep(400) // propagate
      ws.close()
      await a.stop()
      await b.stop()

      expect(a.text()).toContain('run delegation was removed') // org A got its OWN event
      expect(b.text()).toBe('') // org B (a different tenant) got NOTHING
    } finally {
      await p.stop()
    }
  })

  it('removes a stream subscriber when the client disconnects (no leak)', async () => {
    const p = await bootPlatform()
    try {
      const s = collect(p.origin, p.ciToken)
      // Wait for the subscriber to register on the broadcast set.
      for (let i = 0; i < 100 && p.server.subscriberCount() === 0; i++) await Bun.sleep(20)
      expect(p.server.subscriberCount()).toBe(1)
      // Client disconnect → the ReadableStream cancel() (Bun's primary signal
      // for a dropped streaming body) removes the subscriber. Without the
      // cancel() fallback it would leak here.
      await s.stop()
      for (let i = 0; i < 100 && p.server.subscriberCount() > 0; i++) await Bun.sleep(20)
      expect(p.server.subscriberCount()).toBe(0)
    } finally {
      await p.stop()
    }
  })

  it('refuses a cross-origin SSE/stream handshake (CSWSH)', async () => {
    const p = await bootPlatform()
    try {
      for (const streamPath of ['/v1/events', '/events', '/stream']) {
        const evil = await fetch(`${p.origin}${streamPath}?token=${p.ciToken}`, {
          headers: { origin: 'https://evil.example.com' },
        })
        expect(evil.status).toBe(403)
        await evil.body?.cancel().catch(() => {})
      }
      // No-Origin streams (a CLI/agent) are allowed and functional — exercised
      // by the tenant-isolation test above, which opens `/stream` with no Origin.
    } finally {
      await p.stop()
    }
  })
})

// A long-lived (100-year) self-signed cert for localhost, so the test never
// expires. In-process TLS enables native HTTP/3 on Bun >= 1.3.14.
const TEST_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDI88/+bPfnZ6rz
teUfSQgliMfADbMJ/fcrbChiMme6f6yvfD92L4sIBHcDksvv8ObmotNkbEdCR6rS
OhihcfuPIO6akvIeREvT+D7SHRS9p0lIki5S0cmhYgFfDTeT5rkttzx3veEnIBFm
wGehd6WnZ3aP5oBOINtTEO6f6uL1POP1b+X38jivfOH0pngouDfiZvX1sr+pmVg9
gp9LiJufvtEJoUmE+zVe6m7QCANpKZWAZBoS5V09F+aCSblXaB3kTsZowdp4yShd
djwutv9PZcpkIjSNXFmllmZngPUbBa4V06ZEmmEuzpAvR1cMqu3iKGtYPn0R4uIT
6ZMUbmUFAgMBAAECggEALRXUp9zrZtHxvzGjeRgx2Xf9dver4HVIMAgZbGSqNKPi
CtI5y8qhaxhTWmwkUM5QA9Vqz7hiaXq6VuXdclVoLwXgurH22/cPOzzSXWJUbbOb
Y8qWVZMHZaufKqQEwOxuRhU7HhNuMVDGzrKi3Y2CT1ONfH4m8cB57MJbA2qX5pTP
U+sdGVxAtmHUX9e0IyK+yxOdcOScNpp88H+s6o2npE2kAmhWb6M4vqG6uLWJfTAF
yUMkKceuop4k/evOepCCa9sMj7jN7WgX9GJwBXbTnN8jpH7d/p+vvQ3RB1X6g/gE
KrBi1hNhCm/XqRqfY72C9fjJUbRhBQUzFcEaM+otsQKBgQD34FugDEihOo9aFc0S
vx2BTMWzQa5s3KKNlaqjxowYBqUktzw6IruWgQB9tVxbDD7yUpe+cVGEikcYCUgG
TCEf6R2Hg8ZmMjuCnL0hpeDuCIXwKTTwVFEW3oImFKOdlh0zntAEcuMJ9r/pk7SV
mxX3dE+IMvIx41SeIc1qe03TkQKBgQDPicUYF5eANhsIdRDbk4E78YmOSnS7jlkR
pbRcrwKCMn2krYPx2gNE39jLhTE8iSFgZnUuLZHNXiOYlOSiXxHs0jZ99rZ9D1TD
7hRQjoX8h1zrtCJmNDfWqst02B/oxHOd2AdwsjHtGcYOUZvByjh4VWp7afhrPr5i
4pJ7M7wYNQKBgDoF9czAM1wyZg4TXl7OB+0VeI3eiSMIfrCf4ULXHkIdhBjVH68I
JFs1tVS32HejpTR6KvU0d32MFNpGieqXdYWPvw7SxOV1SsLnR8qRltaBfkDalH7R
be3phhO97xLbadiEi3MPJaBWd1QI9FO06u5y9o8ORe1xpoQhq4EKfgxRAoGBALbQ
w19/mKMGBjYi+SCTBOpK0EMZb06wC+Gxt/lU6L7Lv0XK20m2I98N2CkfQMn0egQy
/NIari7b2DtWHTiyylV0ry+ynfn4AVE+bYKwqXJTwxSV7x9crDta5DIfF6yxMK9A
Vv182uHjLEX8uVmxyqCljVD9fijqckclEqeYYP5pAoGAJNmiBLsxNhLFP0HnamhS
1QB+AtEHPBv6Q49Pz6LxJtYeRMzWgjHYZLIF77/QBSeglMJgwu5+dAaskakZOcCn
4eOCfyTDZz59a4PuMD8pLTRPZ35BWvg+2kFcJlS6d21Uly0B9IgaeUOB7JYslElz
Bl3Fs40qynp1qdC9ijt5U+Y=
-----END PRIVATE KEY-----
`

const TEST_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDCzCCAfOgAwIBAgIUMtzHeRpJwKbuzgoECX2gh7mFB4swDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDcxMjE4Mjk1M1oYDzIxMjYw
NjE4MTgyOTUzWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQDI88/+bPfnZ6rzteUfSQgliMfADbMJ/fcrbChiMme6
f6yvfD92L4sIBHcDksvv8ObmotNkbEdCR6rSOhihcfuPIO6akvIeREvT+D7SHRS9
p0lIki5S0cmhYgFfDTeT5rkttzx3veEnIBFmwGehd6WnZ3aP5oBOINtTEO6f6uL1
POP1b+X38jivfOH0pngouDfiZvX1sr+pmVg9gp9LiJufvtEJoUmE+zVe6m7QCANp
KZWAZBoS5V09F+aCSblXaB3kTsZowdp4yShddjwutv9PZcpkIjSNXFmllmZngPUb
Ba4V06ZEmmEuzpAvR1cMqu3iKGtYPn0R4uIT6ZMUbmUFAgMBAAGjUzBRMB0GA1Ud
DgQWBBRAPYQiTTBYF3W7tXqN6Aznlp+vgzAfBgNVHSMEGDAWgBRAPYQiTTBYF3W7
tXqN6Aznlp+vgzAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQA9
sVKAGFW3IwX7xDyB5rFR45Q6ws4xGogelxff/zOXHpGPHBCjwHP26EQPuZhdtztg
rCHCoT+aysKYiL7vHzLAnElWsosP3CrTo3n4APlqLEVsjmvOWrZ9P+M42FUm/F48
DaQFUnRNHd3Vi5oWUXFydnQ84sY9oaVs7oxict7ggO5p4xOiB48I1HfAEmxyBOeL
/SwcFbNOC83znOGv4NCl3m7wyYFRi8UD9xcO0PuyVVhBDXQpX1Y81UmmjrKHgco3
kEDkZZ7FvfrI2VL0EG11XUDlhCiyPPX602uXqYq/XxzDWYzLs6SJ1war/fayGwV2
bf8By88uFDueTR0Dp5aR
-----END CERTIFICATE-----
`

// Experimental native HTTP/3 requires Bun >= 1.3.14 (the Bun.serve http3
// option). On older Bun it is ignored (HTTPS still works, no H3), so the
// Alt-Svc assertions are version-gated; CI runs `bun-version: latest` so it
// always exercises the path.
const supportsH3 = Bun.semver.satisfies(Bun.version, '>=1.3.14')

describe.skipIf(!supportsH3)('in-process TLS + experimental HTTP/3 opt-in', () => {
  let s3: FakeS3
  let dataDir: string

  const bootTls = async (extra: Record<string, string>): Promise<PlatformServer> => {
    const pg = await ephemeralPg()
    const res = resolveServerConfig({
      ...BASE_ENV,
      DATABASE_URL: await pg.createDatabase({ empty: true }),
      VX_CLOUD_BASE_URL: 'https://vx.example.dev',
      VX_CLOUD_S3_ENDPOINT: s3.origin,
      VX_CLOUD_PORT: '0',
      VX_CLOUD_DATA_DIR: dataDir,
      VX_CLOUD_TLS_CERT: path.join(dataDir, 'cert.pem'),
      VX_CLOUD_TLS_KEY: path.join(dataDir, 'key.pem'),
      ...extra,
    })
    if (!res.ok) {
      throw new Error(`config: ${(res as unknown as { errors: string[] }).errors.join('; ')}`)
    }
    return await startServer({ config: res.config, log: () => {} })
  }

  beforeAll(async () => {
    s3 = startFakeS3({ bucket: 'vx-artifacts' })
    dataDir = await mkdtemp(path.join(tmpdir(), 'vx-h3-test-'))
    await Bun.write(path.join(dataDir, 'cert.pem'), TEST_TLS_CERT)
    await Bun.write(path.join(dataDir, 'key.pem'), TEST_TLS_KEY)
  })

  afterAll(async () => {
    s3.stop()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('TLS alone serves stable HTTPS/1.1 — no Alt-Svc, /v1/meta h3=false', async () => {
    const server = await bootTls({})
    try {
      expect(server.origin.startsWith('https://')).toBe(true)
      const meta = await fetch(`${server.origin}/v1/meta`, { tls: { rejectUnauthorized: false } })
      expect(meta.status).toBe(200)
      // No opt-in → no experimental HTTP/3, so no auto-upgrade advertisement.
      expect(meta.headers.get('alt-svc')).toBeNull()
      const body = (await meta.json()) as Record<string, unknown>
      expect(body['h3']).toBe(false)
      expect(body['cacheWire']).toBe(2)
    } finally {
      await server.stop()
    }
  })

  it('VX_CLOUD_HTTP3 opt-in advertises HTTP/3 via Alt-Svc + /v1/meta', async () => {
    const server = await bootTls({ VX_CLOUD_HTTP3: '1' })
    try {
      const meta = await fetch(`${server.origin}/v1/meta`, { tls: { rejectUnauthorized: false } })
      expect(meta.status).toBe(200)
      // Bun sets Alt-Svc on HTTP/1.1 responses when http3 is enabled, so clients
      // auto-upgrade to QUIC on the same port.
      expect(meta.headers.get('alt-svc')).toMatch(/h3=/)
      const body = (await meta.json()) as Record<string, unknown>
      expect(body['h3']).toBe(true)
    } finally {
      await server.stop()
    }
  })

  it('a boot with an unreadable cert path fails loud (no silent no-TLS start)', async () => {
    const pg = await ephemeralPg()
    const res = resolveServerConfig({
      ...BASE_ENV,
      DATABASE_URL: await pg.createDatabase({ empty: true }),
      VX_CLOUD_S3_ENDPOINT: s3.origin,
      VX_CLOUD_PORT: '0',
      VX_CLOUD_DATA_DIR: dataDir,
      VX_CLOUD_TLS_CERT: path.join(dataDir, 'does-not-exist.pem'),
      VX_CLOUD_TLS_KEY: path.join(dataDir, 'key.pem'),
    })
    if (!res.ok) throw new Error('config unexpectedly invalid')
    await expect(startServer({ config: res.config, log: () => {} })).rejects.toThrow(
      /VX_CLOUD_TLS_CERT/,
    )
  })
})
