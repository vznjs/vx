// MCP on the serve — the networked counterpart of core's stdio `vx mcp`
// (dev-flows design §10.3). A hand-rolled, dependency-free Model Context
// Protocol server over streamable HTTP: POST /mcp accepts JSON-RPC 2.0
// (single messages or batches) and answers with plain application/json —
// the spec permits non-streaming servers to skip SSE entirely, and every
// tool here is a fast local SQLite read.
//
// The tools are thin adapters over the SAME metrics queries the /v1/*
// endpoints call, against the serve's own IngestStore — no SQL of their
// own, so the two surfaces can't drift. Auth is the serve's bearer gate
// (serve.ts routes /mcp through `authorized()` before this module runs;
// MCP clients send the token via a custom Authorization header).

import {
  VERSION,
  cacheKeyDiff,
  compareRuns,
  getCacheStatsSql,
  getHitRateSplit,
  getInvocation,
  getRun,
  getRunTrends,
  listInvocations,
  whyDidThisRerunQuery,
} from '@vzn/vx'
import type { Database } from 'bun:sqlite'
import type { IngestStore } from '../ingest-store.js'

export const MCP_PROTOCOL_VERSION = '2025-03-26'

interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

const WORKSPACE_PROP = {
  workspace: {
    type: 'string',
    description:
      'Workspace id (see list_workspaces). Defaults to the sole known workspace, else "default".',
  },
} as const

export const MCP_TOOLS: readonly McpTool[] = [
  {
    name: 'list_workspaces',
    description:
      'Every workspace this serve has ingested runs for: id, display name, last-seen time, run count.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_runs',
    description:
      'Recent `vx run` invocations (newest first): command, branch/commit, CI, task/failed/hit counts, duration.',
    inputSchema: {
      type: 'object',
      properties: {
        ...WORKSPACE_PROP,
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
      },
    },
  },
  {
    name: 'get_run',
    description:
      'One run in full: the invocation summary (command, context, counts) plus every per-task outcome.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        ...WORKSPACE_PROP,
      },
      required: ['runId'],
    },
  },
  {
    name: 'run_trends',
    description: 'Run activity over time: bucketed run counts, failure counts, and durations.',
    inputSchema: {
      type: 'object',
      properties: {
        ...WORKSPACE_PROP,
        bucket: { type: 'string', enum: ['hour', 'day'], default: 'hour' },
        limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'Most recent N points.' },
      },
    },
  },
  {
    name: 'cache_stats',
    description:
      'Cache effectiveness: entry count/bytes, runs + hits in the last 24h, and the local-vs-remote hit split.',
    inputSchema: { type: 'object', properties: { ...WORKSPACE_PROP } },
  },
  {
    name: 'why_did_rerun',
    description:
      'Why a task re-executed in a run: hash change vs the previous run, plus the per-component ' +
      'input diff when fingerprints are available (they live in the producing machine’s local ' +
      'cache.db, so a hosted serve may only know the hash changed).',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        taskId: { type: 'string', description: 'project#task' },
        ...WORKSPACE_PROP,
      },
      required: ['runId', 'taskId'],
    },
  },
  {
    name: 'compare_runs',
    description:
      'Diff a run against the immediately-previous invocation: per-task duration/status/hash deltas + totals.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        ...WORKSPACE_PROP,
      },
      required: ['runId'],
    },
  },
]

type JsonRpcId = number | string | null

interface JsonRpcMessage {
  jsonrpc?: unknown
  id?: JsonRpcId
  method?: unknown
  params?: unknown
}

function resultResponse(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result }
}

function errorResponse(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

/** Resolve a tool's optional `workspace` arg to that workspace's store. */
function resolveDb(
  ingest: IngestStore,
  args: Record<string, unknown>,
): { workspace: string; db: Database } {
  const requested = args['workspace']
  const workspace =
    typeof requested === 'string' && requested !== '' ? requested : ingest.defaultWorkspaceId()
  const db = ingest.db(workspace)
  if (db === undefined) throw new Error(`unknown workspace: ${workspace}`)
  return { workspace, db }
}

function requireString(args: Record<string, unknown>, field: string, tool: string): string {
  const v = args[field]
  if (typeof v !== 'string' || v === '') throw new Error(`${tool}: ${field} must be a string`)
  return v
}

function callTool(name: string, args: Record<string, unknown>, ingest: IngestStore): unknown {
  switch (name) {
    case 'list_workspaces':
      return { workspaces: ingest.workspaces() }
    case 'list_runs': {
      const { workspace, db } = resolveDb(ingest, args)
      const limit = typeof args['limit'] === 'number' ? args['limit'] : 50
      return { workspace, runs: listInvocations(db, { limit }) }
    }
    case 'get_run': {
      const runId = requireString(args, 'runId', 'get_run')
      const { workspace, db } = resolveDb(ingest, args)
      const invocation = getInvocation(db, runId)
      const detail = getRun(db, runId)
      if (invocation === null && detail === null) {
        return { workspace, runId, found: false, note: 'no run with that id in this workspace' }
      }
      return { workspace, runId, found: true, invocation, tasks: detail?.tasks ?? [] }
    }
    case 'run_trends': {
      const { workspace, db } = resolveDb(ingest, args)
      const bucket = args['bucket'] === 'day' ? 'day' : 'hour'
      const points = getRunTrends(db, { bucket })
      const limit = typeof args['limit'] === 'number' ? args['limit'] : undefined
      return {
        workspace,
        bucket,
        points: limit !== undefined ? points.slice(-limit) : points,
      }
    }
    case 'cache_stats': {
      const { workspace, db } = resolveDb(ingest, args)
      return { workspace, stats: getCacheStatsSql(db), hitSplit: getHitRateSplit(db) }
    }
    case 'why_did_rerun': {
      const runId = requireString(args, 'runId', 'why_did_rerun')
      const taskId = requireString(args, 'taskId', 'why_did_rerun')
      const { workspace, db } = resolveDb(ingest, args)
      // Both surfaces degrade honestly on an ingest store (same rule as the
      // dashboard): the hash comparison always works; the component diff
      // notes when fingerprints are unavailable.
      return {
        workspace,
        why: whyDidThisRerunQuery(db, runId, taskId),
        inputDiff: cacheKeyDiff(db, runId, taskId),
      }
    }
    case 'compare_runs': {
      const runId = requireString(args, 'runId', 'compare_runs')
      const { workspace, db } = resolveDb(ingest, args)
      return { workspace, ...compareRuns(db, runId) }
    }
    default:
      throw new UnknownToolError(name)
  }
}

class UnknownToolError extends Error {
  constructor(tool: string) {
    super(`unknown tool: ${tool}`)
  }
}

function handleMessage(raw: unknown, ingest: IngestStore): Record<string, unknown> | undefined {
  const msg = (typeof raw === 'object' && raw !== null ? raw : {}) as JsonRpcMessage
  const id = msg.id ?? null
  // A notification (no id) never gets a response — JSON-RPC 2.0. The only
  // notifications MCP clients send (notifications/initialized, cancelled)
  // require no server action.
  const isNotification = msg.id === undefined
  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return isNotification ? undefined : errorResponse(id, -32600, 'not a JSON-RPC 2.0 request')
  }
  if (isNotification) return undefined
  switch (msg.method) {
    case 'initialize':
      return resultResponse(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'vx-cloud', version: VERSION },
      })
    case 'ping':
      return resultResponse(id, {})
    case 'tools/list':
      return resultResponse(id, { tools: MCP_TOOLS })
    case 'tools/call': {
      const params = (msg.params ?? {}) as { name?: unknown; arguments?: unknown }
      if (typeof params.name !== 'string') {
        return errorResponse(id, -32602, 'tools/call requires params.name')
      }
      const args = (params.arguments ?? {}) as Record<string, unknown>
      try {
        const result = callTool(params.name, args, ingest)
        return resultResponse(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        })
      } catch (err) {
        if (err instanceof UnknownToolError) return errorResponse(id, -32602, err.message)
        // Tool execution errors are RESULTS with isError (MCP spec) so the
        // model sees them and can self-correct.
        const message = err instanceof Error ? err.message : String(err)
        return resultResponse(id, {
          content: [{ type: 'text', text: message }],
          isError: true,
        })
      }
    }
    default:
      return errorResponse(id, -32601, `method not found: ${msg.method}`)
  }
}

/**
 * The POST /mcp handler. Accepts a single JSON-RPC message or a batch;
 * answers requests with application/json and pure-notification posts with
 * 202 (the streamable-HTTP contract for servers that don't stream).
 */
export async function handleMcpHttp(req: Request, ingest: IngestStore): Promise<Response> {
  if (req.method !== 'POST') {
    return Response.json(
      { error: 'MCP endpoint accepts POST only' },
      { status: 405, headers: { Allow: 'POST' } },
    )
  }
  let parsed: unknown
  try {
    parsed = await req.json()
  } catch {
    return Response.json(errorResponse(null, -32700, 'parse error: body is not JSON'))
  }
  const batch = Array.isArray(parsed)
  const messages: unknown[] = batch ? (parsed as unknown[]) : [parsed]
  if (messages.length === 0) {
    return Response.json(errorResponse(null, -32600, 'empty batch'))
  }
  const responses: Record<string, unknown>[] = []
  for (const m of messages) {
    const r = handleMessage(m, ingest)
    if (r !== undefined) responses.push(r)
  }
  if (responses.length === 0) return new Response(null, { status: 202 })
  return Response.json(batch ? responses : responses[0])
}
