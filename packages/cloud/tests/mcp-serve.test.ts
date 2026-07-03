// The serve's MCP endpoint (POST /mcp): JSON-RPC 2.0 over streamable HTTP,
// behind the same bearer gate as /v1/*, tools adapting the existing metrics
// queries over the ingest store. Driven end-to-end against a started serve.

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { RunSummaryRecord } from '@vzn/vx'
import { startServe, type ServeServer } from '../src/cli/serve.js'
import { serveInfoPath } from '../src/serve-info.js'

// Isolate the per-user serve advertisement at a temp path so test serves
// never clobber (or get discovered through) the real machine-level file.
const prevServeInfo = process.env['VX_CLOUD_SERVE_INFO']
beforeAll(() => {
  process.env['VX_CLOUD_SERVE_INFO'] = path.join(tmpdir(), `vx-serveinfo-mcp-${process.pid}.json`)
})
afterAll(async () => {
  await rm(serveInfoPath(), { force: true })
  if (prevServeInfo === undefined) delete process.env['VX_CLOUD_SERVE_INFO']
  else process.env['VX_CLOUD_SERVE_INFO'] = prevServeInfo
})

function mkSummary(runId: string, over: { task?: string; at?: number } = {}): RunSummaryRecord {
  const task = over.task ?? 'hello'
  const at = over.at ?? Date.now()
  return {
    v: 2,
    run: {
      runId,
      vxVersion: '0.0.0',
      workspaceId: 'ws-mcp',
      workspaceName: 'mcp-fixture',
      command: `vx run ${task}`,
      requestedTasks: [task],
      cachePolicy: 'lR,lW,rR,rW',
      concurrency: 1,
      flow: 'focused',
      commitSha: 'c0ffee',
      branch: 'main',
      dirty: false,
      ci: false,
      ciProvider: null,
      host: 'box',
      os: 'linux',
      arch: 'x64',
      tags: {},
    },
    startedAt: at,
    endedAt: at + 200,
    totalDurationMs: 200,
    taskCount: 1,
    failedCount: 0,
    hitCount: 0,
    hitLocalCount: 0,
    hitRemoteCount: 0,
    exitOk: true,
    tasks: [
      {
        taskId: `demo#${task}`,
        project: 'demo',
        task,
        status: 'success',
        cacheSource: 'miss',
        exitCode: 0,
        durationMs: 120,
        hash: `h-${runId}`,
      },
    ],
  }
}

async function push(origin: string, summary: RunSummaryRecord): Promise<void> {
  const res = await fetch(`${origin}/v1/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(summary),
  })
  if (!res.ok) throw new Error(`ingest failed: ${res.status}`)
}

interface RpcResponse {
  jsonrpc: string
  id: number | string | null
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}

async function rpc(
  origin: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${origin}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

async function call(
  origin: string,
  method: string,
  params?: unknown,
  id: number = 1,
): Promise<RpcResponse> {
  const res = await rpc(origin, { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('json')
  return (await res.json()) as RpcResponse
}

/** tools/call → the parsed JSON the single text-content block carries. */
async function callTool(
  origin: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const res = await call(origin, 'tools/call', { name, arguments: args })
  expect(res.error).toBeUndefined()
  const content = res.result!['content'] as { type: string; text: string }[]
  expect(content[0]!.type).toBe('text')
  return JSON.parse(content[0]!.text) as Record<string, unknown>
}

describe('vx serve — POST /mcp', () => {
  let server: ServeServer
  let ingestDir: string

  beforeAll(async () => {
    ingestDir = await mkdtemp(path.join(tmpdir(), 'vx-mcp-ingest-'))
    server = await startServe({ root: ingestDir, ingestDir })
    await push(server.origin, mkSummary('run-old', { at: Date.now() - 5000 }))
    await push(server.origin, mkSummary('run-new', { at: Date.now() - 1000 }))
  })

  afterAll(async () => {
    await server.stop()
    await rm(ingestDir, { recursive: true, force: true })
  })

  it('answers the initialize handshake', async () => {
    const res = await call(server.origin, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    })
    expect(res.jsonrpc).toBe('2.0')
    expect(res.id).toBe(1)
    const result = res.result!
    expect(result['protocolVersion']).toBe('2025-03-26')
    expect(result['capabilities']).toEqual({ tools: {} })
    expect((result['serverInfo'] as { name: string }).name).toBe('vx-cloud')
    expect(typeof (result['serverInfo'] as { version: string }).version).toBe('string')
  })

  it('accepts notifications/initialized with a 202 empty response', async () => {
    const res = await rpc(server.origin, { jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(res.status).toBe(202)
    expect(await res.text()).toBe('')
  })

  it('lists all seven tools with JSON-Schema inputs', async () => {
    const res = await call(server.origin, 'tools/list')
    const tools = res.result!['tools'] as { name: string; inputSchema: { type: string } }[]
    expect(tools.map((t) => t.name).sort()).toEqual([
      'cache_stats',
      'compare_runs',
      'get_run',
      'list_runs',
      'list_workspaces',
      'run_trends',
      'why_did_rerun',
    ])
    for (const t of tools) expect(t.inputSchema.type).toBe('object')
  })

  it('tools/call list_runs returns the ingested invocations', async () => {
    const out = await callTool(server.origin, 'list_runs', { limit: 10 })
    expect(out['workspace']).toBe('ws-mcp')
    const runs = out['runs'] as { runId: string; command: string }[]
    expect(runs.map((r) => r.runId).sort()).toEqual(['run-new', 'run-old'])
    expect(runs[0]!.command).toContain('vx run')
  })

  it('tools/call list_workspaces names the ingested workspace', async () => {
    const out = await callTool(server.origin, 'list_workspaces')
    const wss = out['workspaces'] as { id: string; name: string; runCount: number }[]
    expect(wss.length).toBe(1)
    expect(wss[0]!.id).toBe('ws-mcp')
    expect(wss[0]!.name).toBe('mcp-fixture')
    expect(wss[0]!.runCount).toBe(2)
  })

  it('tools/call get_run returns the invocation summary + per-task outcomes', async () => {
    const out = await callTool(server.origin, 'get_run', { runId: 'run-new' })
    expect(out['found']).toBe(true)
    expect((out['invocation'] as { runId: string }).runId).toBe('run-new')
    const tasks = out['tasks'] as { project: string; task: string }[]
    expect(tasks.length).toBe(1)
    expect(tasks[0]!.project).toBe('demo')
    expect(tasks[0]!.task).toBe('hello')
  })

  it('tools/call get_run degrades to found:false for an unknown run', async () => {
    const out = await callTool(server.origin, 'get_run', { runId: 'nope' })
    expect(out['found']).toBe(false)
  })

  it('tools/call cache_stats + run_trends return shapes over the ingest store', async () => {
    const stats = await callTool(server.origin, 'cache_stats')
    expect((stats['stats'] as { runCountLast24h: number }).runCountLast24h).toBeGreaterThanOrEqual(
      2,
    )
    expect((stats['hitSplit'] as { total: number }).total).toBeGreaterThanOrEqual(2)

    const trends = await callTool(server.origin, 'run_trends', { bucket: 'hour', limit: 5 })
    expect(trends['bucket']).toBe('hour')
    expect(Array.isArray(trends['points'])).toBe(true)
    expect((trends['points'] as unknown[]).length).toBeLessThanOrEqual(5)
  })

  it('tools/call why_did_rerun reports the hash change + an honest diff note', async () => {
    const out = await callTool(server.origin, 'why_did_rerun', {
      runId: 'run-new',
      taskId: 'demo#hello',
    })
    const why = out['why'] as { found: boolean; hashChanged: boolean }
    expect(why.found).toBe(true)
    expect(why.hashChanged).toBe(true)
    // The ingest store holds no input fingerprints (they live in the
    // producing machine's local cache.db) — the diff says so instead of
    // pretending an empty diff means "nothing changed".
    const diff = out['inputDiff'] as { found: boolean; entries: unknown[]; note: string }
    expect(diff.found).toBe(true)
    expect(diff.entries).toEqual([])
    expect(diff.note).toContain('fingerprints are unavailable')
  })

  it('tools/call compare_runs diffs against the previous invocation', async () => {
    const out = await callTool(server.origin, 'compare_runs', { runId: 'run-new' })
    expect(out['found']).toBe(true)
    expect(out['previousRunId']).toBe('run-old')
    const tasks = out['tasks'] as { taskId: string }[]
    expect(tasks.some((t) => t.taskId === 'demo#hello')).toBe(true)
  })

  it('a tool error (unknown workspace) comes back as an isError result, not a crash', async () => {
    const res = await call(server.origin, 'tools/call', {
      name: 'list_runs',
      arguments: { workspace: 'no-such-ws' },
    })
    expect(res.error).toBeUndefined()
    const result = res.result as { isError?: boolean; content: { text: string }[] }
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('unknown workspace')
  })

  it('rejects an unknown method with -32601 and an unknown tool with -32602', async () => {
    const unknownMethod = await call(server.origin, 'resources/list')
    expect(unknownMethod.error!.code).toBe(-32601)

    const unknownTool = await call(server.origin, 'tools/call', { name: 'no_such_tool' })
    expect(unknownTool.error!.code).toBe(-32602)
    expect(unknownTool.error!.message).toContain('no_such_tool')
  })

  it('rejects a non-JSON body with -32700 and a GET with 405', async () => {
    const bad = await fetch(`${server.origin}/mcp`, { method: 'POST', body: 'not json {' })
    const parsed = (await bad.json()) as RpcResponse
    expect(parsed.error!.code).toBe(-32700)

    const get = await fetch(`${server.origin}/mcp`)
    expect(get.status).toBe(405)
  })

  it('handles a JSON-RPC batch, answering only the requests', async () => {
    const res = await rpc(server.origin, [
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ])
    expect(res.status).toBe(200)
    const body = (await res.json()) as RpcResponse[]
    expect(body.length).toBe(2)
    expect(body.map((r) => r.id)).toEqual([1, 2])
  })
})

describe('vx serve — /mcp auth', () => {
  it('is behind the same bearer gate as /v1/*', async () => {
    const ingestDir = await mkdtemp(path.join(tmpdir(), 'vx-mcp-auth-'))
    const server = await startServe({ root: ingestDir, ingestDir, token: 'sekret' })
    try {
      const init = { jsonrpc: '2.0', id: 1, method: 'initialize' }
      const noToken = await rpc(server.origin, init)
      expect(noToken.status).toBe(401)

      const wrong = await rpc(server.origin, init, { authorization: 'Bearer wrong' })
      expect(wrong.status).toBe(401)

      const ok = await rpc(server.origin, init, { authorization: 'Bearer sekret' })
      expect(ok.status).toBe(200)
      const body = (await ok.json()) as RpcResponse
      expect((body.result as { serverInfo: { name: string } }).serverInfo.name).toBe('vx-cloud')
    } finally {
      await server.stop()
      await rm(ingestDir, { recursive: true, force: true })
    }
  })
})
