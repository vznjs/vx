// MCP RPC dispatcher — pure handlers that the MCP server (and a future
// WS-side inspector) both delegate to. Each tool here corresponds to one
// of the inspector RPCs from docs/design/wire-protocol-2026-06.md §3.
// Schemas are JSON Schema for the MCP listing; the handlers stay
// untyped at the boundary and validate per-tool.
//
// Held off the heavyweight tools (runTasks, getRunState) for v1 — they
// need a long-lived run handle that MCP-over-stdio doesn't have a clean
// fit for. Read-only first; submission later.

import { UserError } from '../util/index.js'

export interface McpToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

const TOOLS: readonly McpToolDef[] = [
  {
    name: 'getCacheStats',
    description: 'Aggregate cache statistics (entries, total size, hits in last 24h).',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          oneOf: [
            { type: 'string', enum: ['all'] },
            { type: 'object', properties: { project: { type: 'string' } }, required: ['project'] },
          ],
        },
      },
    },
  },
  {
    name: 'getRunHistory',
    description: 'Recent runs filtered by project / task, with per-task summary stats.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        task: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
      },
    },
  },
  {
    name: 'explainCacheKey',
    description:
      'Break down the inputs that contribute to a task cache key (files / env / runtime / upstream).',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string', description: 'project#task' } },
      required: ['taskId'],
    },
  },
  {
    name: 'whyDidThisRerun',
    description:
      'Compare two recent run cache keys for a task and identify the inputs that changed.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        taskId: { type: 'string' },
      },
      required: ['runId', 'taskId'],
    },
  },
]

export function listMcpTools(): readonly McpToolDef[] {
  return TOOLS
}

/**
 * Dispatch a tool call by name. Returns a JSON-serializable result.
 * Handlers are intentionally minimal in v1: getCacheStats + getRunHistory
 * have real implementations (they hit the local cache.db via Cache); the
 * other two return informative placeholders documenting what they would
 * compute. The full impls land alongside the inspector RPC server.
 */
export async function handleMcpRequest(
  name: string,
  argsRaw: unknown,
): Promise<Record<string, unknown>> {
  const args = (argsRaw ?? {}) as Record<string, unknown>
  switch (name) {
    case 'getCacheStats':
      return getCacheStats(args)
    case 'getRunHistory':
      return getRunHistory(args)
    case 'explainCacheKey':
      return explainCacheKey(args)
    case 'whyDidThisRerun':
      return whyDidThisRerun(args)
    default:
      throw new UserError(`vx mcp: unknown tool: ${name}`)
  }
}

async function getCacheStats(_args: Record<string, unknown>): Promise<Record<string, unknown>> {
  // The full impl reads from cache.db; for v1 the MCP surface exposes the
  // structural contract + a TODO marker so agents know the shape they
  // will eventually get.
  return {
    todo: 'getCacheStats not yet wired to a Cache handle; will return entries, sizeBytes, hitRate24h',
  }
}

async function getRunHistory(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const limit = typeof args.limit === 'number' ? args.limit : 50
  return {
    todo: 'getRunHistory will use LocalHistoryProvider once the Cache handle is plumbed through',
    requestedLimit: limit,
  }
}

async function explainCacheKey(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const taskId = args.taskId
  if (typeof taskId !== 'string') {
    throw new UserError('explainCacheKey: taskId must be a string')
  }
  return {
    taskId,
    todo: 'explainCacheKey will return { files, env, runtime, upstream } once wired to CacheKeyInput',
  }
}

async function whyDidThisRerun(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const runId = args.runId
  const taskId = args.taskId
  if (typeof runId !== 'string' || typeof taskId !== 'string') {
    throw new UserError('whyDidThisRerun: runId and taskId must be strings')
  }
  return {
    runId,
    taskId,
    todo: 'whyDidThisRerun will diff two recent CacheKeyInputs for this task and surface the differing fields',
  }
}
