// MCP on the platform — the networked counterpart of core's stdio `vx mcp`
// (dev-flows design §10.3). A hand-rolled, dependency-free Model Context
// Protocol server over streamable HTTP: POST /mcp accepts JSON-RPC 2.0
// (single messages or batches) and answers with plain application/json —
// the spec permits non-streaming servers to skip SSE entirely, and every
// tool here is a fast Postgres read.
//
// The tools are thin adapters over the SAME analytics queries the /v1/*
// routes call, org/workspace-clamped by the gate (a ci token's org + its
// bound workspace, or a session's org). Auth is the platform gate
// (server.ts routes /mcp through the gate before this module runs).

import { VERSION } from '@vzn/vx'
import type { Analytics } from '../db/analytics.js'

export const MCP_PROTOCOL_VERSION = '2025-03-26'

/** The tenant clamp the gate resolved for an MCP request. */
export interface McpContext {
  analytics: Analytics
  /** The principal's org — every read is clamped to a workspace within it. */
  orgId: string
  /** Set when a workspace-scoped token drove the request: pins the workspace. */
  tokenWorkspaceId?: string | undefined
}

interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

const WORKSPACE_PROP = {
  workspace: {
    type: 'string',
    description:
      'Workspace id (see list_workspaces). Defaults to the org’s most-recently-seen workspace. ' +
      'Ignored for a workspace-scoped token (pinned to its own workspace).',
  },
} as const

export const MCP_TOOLS: readonly McpTool[] = [
  {
    name: 'list_workspaces',
    description: 'Every workspace in this org: id, display name, slug, last-seen time, run count.',
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
      'input diff when fingerprints are available.',
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

const NIL_UUID = '00000000-0000-0000-0000-000000000000'

/**
 * Resolve a tool's optional `workspace` arg to the clamped server workspace.
 * A workspace-scoped token is pinned to its own workspace (the arg is ignored);
 * otherwise the arg (or the org's most-recent workspace) resolves within the
 * org. An explicitly-named unknown workspace throws (surfaced as an isError
 * result); no arg + an org with no workspaces yields the nil workspace (empty
 * reads), mirroring the analytics gate.
 */
async function resolveWorkspace(ctx: McpContext, args: Record<string, unknown>): Promise<string> {
  if (ctx.tokenWorkspaceId !== undefined) return ctx.tokenWorkspaceId
  const requested = args['workspace']
  const arg = typeof requested === 'string' && requested !== '' ? requested : null
  const resolved = await ctx.analytics.resolveReadWorkspace(ctx.orgId, arg)
  if (resolved === null) {
    if (arg !== null) throw new Error(`unknown workspace: ${arg}`)
    return NIL_UUID
  }
  return resolved
}

function requireString(args: Record<string, unknown>, field: string, tool: string): string {
  const v = args[field]
  if (typeof v !== 'string' || v === '') throw new Error(`${tool}: ${field} must be a string`)
  return v
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  ctx: McpContext,
): Promise<unknown> {
  const a = ctx.analytics
  switch (name) {
    case 'list_workspaces':
      return { workspaces: await a.workspacesForOrg(ctx.orgId) }
    case 'list_runs': {
      const workspace = await resolveWorkspace(ctx, args)
      const limit = typeof args['limit'] === 'number' ? args['limit'] : 50
      return { workspace, runs: await a.listInvocations(workspace, { limit }) }
    }
    case 'get_run': {
      const runId = requireString(args, 'runId', 'get_run')
      const workspace = await resolveWorkspace(ctx, args)
      const invocation = await a.getInvocation(workspace, runId)
      const detail = await a.getRun(workspace, runId)
      if (invocation === null && detail === null) {
        return { workspace, runId, found: false, note: 'no run with that id in this workspace' }
      }
      return { workspace, runId, found: true, invocation, tasks: detail?.tasks ?? [] }
    }
    case 'run_trends': {
      const workspace = await resolveWorkspace(ctx, args)
      const bucket = args['bucket'] === 'day' ? 'day' : 'hour'
      const points = await a.getRunTrends(workspace, { bucket })
      const limit = typeof args['limit'] === 'number' ? args['limit'] : undefined
      return {
        workspace,
        bucket,
        points: limit !== undefined ? points.slice(-limit) : points,
      }
    }
    case 'cache_stats': {
      const workspace = await resolveWorkspace(ctx, args)
      return {
        workspace,
        stats: await a.getCacheStatsSql(workspace),
        hitSplit: await a.getHitRateSplit(workspace),
      }
    }
    case 'why_did_rerun': {
      const runId = requireString(args, 'runId', 'why_did_rerun')
      const taskId = requireString(args, 'taskId', 'why_did_rerun')
      const workspace = await resolveWorkspace(ctx, args)
      return {
        workspace,
        why: await a.whyDidThisRerun(workspace, runId, taskId),
        inputDiff: await a.cacheKeyDiff(workspace, runId, taskId),
      }
    }
    case 'compare_runs': {
      const runId = requireString(args, 'runId', 'compare_runs')
      const workspace = await resolveWorkspace(ctx, args)
      return { workspace, ...(await a.compareRuns(workspace, runId)) }
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

async function handleMessage(
  raw: unknown,
  ctx: McpContext,
): Promise<Record<string, unknown> | undefined> {
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
        const result = await callTool(params.name, args, ctx)
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
export async function handleMcpHttp(req: Request, ctx: McpContext): Promise<Response> {
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
    const r = await handleMessage(m, ctx)
    if (r !== undefined) responses.push(r)
  }
  if (responses.length === 0) return new Response(null, { status: 202 })
  return Response.json(batch ? responses : responses[0])
}
