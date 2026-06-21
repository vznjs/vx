// MCP RPC dispatcher — pure handlers that the MCP server (and a future
// WS-side inspector) both delegate to. Each tool here corresponds to one
// of the inspector RPCs from docs/design/wire-protocol-2026-06.md §3.
// Schemas are JSON Schema for the MCP listing; the handlers stay
// untyped at the boundary and validate per-tool.
//
// Handlers open the local cache.db on demand. The MCP server is a
// short-lived adapter — long-lived embedders should keep the Cache
// open across calls via `setMcpContext`.

import { Cache } from '../cache/index.js'
import { LocalHistoryProvider } from '../orchestrator/index.js'
import { findWorkspaceRoot, loadWorkspaceConfig, resolveCacheDir } from '../workspace/index.js'
import { UserError } from '../util/index.js'

export interface McpToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/**
 * Where the handlers reach for state. Overridable so an embedder
 * (a future inspector WS server) can inject a long-lived Cache + a
 * specific workspace root instead of opening one per RPC.
 */
export interface McpContext {
  /** Workspace root. Defaults to discovery from process.cwd(). */
  workspaceRoot?: string
}

let mcpContext: McpContext = {}

export function setMcpContext(ctx: McpContext): void {
  mcpContext = ctx
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

/** Discover + open a Cache against the current workspace. Caller closes. */
async function openCache(): Promise<{ cache: Cache; workspaceRoot: string }> {
  const workspaceRoot = mcpContext.workspaceRoot ?? (await findWorkspaceRoot(process.cwd()))
  const config = await loadWorkspaceConfig(workspaceRoot)
  const cacheDir = resolveCacheDir(workspaceRoot, config)
  return { cache: new Cache(cacheDir), workspaceRoot }
}

async function getCacheStats(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { cache } = await openCache()
  try {
    const stats = cache.stats()
    const hitRate24h = stats.runCountLast24h > 0 ? stats.hitCountLast24h / stats.runCountLast24h : 0
    return {
      scope: args.scope ?? 'all',
      entryCount: stats.entryCount,
      totalBytes: stats.totalBytes,
      runCountLast24h: stats.runCountLast24h,
      hitCountLast24h: stats.hitCountLast24h,
      hitRate24h,
    }
  } finally {
    cache.close()
  }
}

async function getRunHistory(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const limit = typeof args.limit === 'number' ? Math.min(500, Math.max(1, args.limit)) : 50
  const projectFilter = typeof args.project === 'string' ? args.project : undefined
  const taskFilter = typeof args.task === 'string' ? args.task : undefined

  const { cache } = await openCache()
  try {
    const db = cache.dbHandle()
    // Distinct (project, task) pairs from the most recent runs.
    const where: string[] = []
    const params: (string | number)[] = []
    if (projectFilter) {
      where.push('project = ?')
      params.push(projectFilter)
    }
    if (taskFilter) {
      where.push('task = ?')
      params.push(taskFilter)
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const pairs = db
      .query(`SELECT DISTINCT project, task FROM runs ${clause} ORDER BY started_at DESC LIMIT ?`)
      .all(...params, limit) as { project: string; task: string }[]
    if (pairs.length === 0) {
      return { runs: [], history: [] }
    }
    const ids = pairs.map((p) => `${p.project}#${p.task}`)
    const provider = new LocalHistoryProvider(db)
    const table = await provider.loadFor(ids)
    const history = ids
      .map((id) => {
        const h = table.get(id)
        return h ? { id, ...h } : null
      })
      .filter((x) => x !== null)
    // Most-recent N rows for the timeline view.
    const recent = db
      .query(
        `SELECT run_id AS runId, project, task, status, duration_ms AS durationMs,
                started_at AS startedAt, ended_at AS endedAt, cache_hit AS cacheHit
         FROM runs ${clause} ORDER BY started_at DESC LIMIT ?`,
      )
      .all(...params, limit) as Array<{
      runId: string | null
      project: string
      task: string
      status: string
      durationMs: number
      startedAt: number
      endedAt: number
      cacheHit: number | null
    }>
    return { runs: recent, history }
  } finally {
    cache.close()
  }
}

async function explainCacheKey(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const taskId = args.taskId
  if (typeof taskId !== 'string' || !taskId.includes('#')) {
    throw new UserError('explainCacheKey: taskId must be a "project#task" string')
  }
  const [project, task] = taskId.split('#', 2) as [string, string]
  const { cache } = await openCache()
  try {
    const db = cache.dbHandle()
    // The cache stores the resolved task hash on the latest entry; we
    // surface what we know from the entries + runs tables. The deeper
    // input-component breakdown (env / runtime / upstream) requires
    // re-deriving the key from a live config; that's the next layer
    // (a "prepareRun-lite" tool). For now we return what's persisted.
    const entry = db
      .query(
        `SELECT hash, command, exit_code AS exitCode, duration_ms AS durationMs,
                size_bytes AS sizeBytes, created_at AS createdAt
         FROM entries WHERE project = ? AND task = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(project, task) as
      | {
          hash: string
          command: string
          exitCode: number
          durationMs: number
          sizeBytes: number
          createdAt: number
        }
      | undefined
    return {
      taskId,
      project,
      task,
      latestEntry: entry ?? null,
      note: 'cache key components (files / env / runtime / upstream hashes) require live config evaluation; this surface returns the persisted entry metadata',
    }
  } finally {
    cache.close()
  }
}

async function whyDidThisRerun(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const runId = args.runId
  const taskId = args.taskId
  if (typeof runId !== 'string' || typeof taskId !== 'string') {
    throw new UserError('whyDidThisRerun: runId and taskId must be strings')
  }
  if (!taskId.includes('#')) {
    throw new UserError('whyDidThisRerun: taskId must be a "project#task" string')
  }
  const [project, task] = taskId.split('#', 2) as [string, string]
  const { cache } = await openCache()
  try {
    const db = cache.dbHandle()
    const this_ = db
      .query(
        `SELECT hash, status, cache_hit AS cacheHit, started_at AS startedAt
         FROM runs WHERE run_id = ? AND project = ? AND task = ?`,
      )
      .get(runId, project, task) as
      | { hash: string; status: string; cacheHit: number | null; startedAt: number }
      | undefined
    if (!this_) {
      return { runId, taskId, found: false, note: 'no row matching that runId + taskId' }
    }
    const prev = db
      .query(
        `SELECT hash, status, cache_hit AS cacheHit, started_at AS startedAt
         FROM runs WHERE project = ? AND task = ? AND started_at < ?
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get(project, task, this_.startedAt) as
      | { hash: string; status: string; cacheHit: number | null; startedAt: number }
      | undefined
    return {
      runId,
      taskId,
      thisRun: this_,
      previousRun: prev ?? null,
      hashChanged: prev ? prev.hash !== this_.hash : null,
      note:
        prev && prev.hash !== this_.hash
          ? 'cache key changed between the previous run and this one (inputs differ)'
          : prev
            ? 'cache key unchanged — re-run with the same key (likely --no-cache or unrelated)'
            : 'no prior run for this (project, task)',
    }
  } finally {
    cache.close()
  }
}
