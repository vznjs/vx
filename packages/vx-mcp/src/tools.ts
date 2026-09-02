// The four tools, as pure handlers over one workspace's cache.db. Every
// handler opens the Cache for the call and closes it — the server is a
// short-lived adapter — and validates its arguments at the boundary rather
// than coercing them: an agent that sends the wrong shape must be told,
// not answered with data for a question it did not ask.

import {
  Cache,
  clampInt,
  LocalHistoryProvider,
  splitTaskId,
  UserError,
  whyDidThisRerunQuery,
} from '@vzn/vx'

export interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface ToolContext {
  /** The workspace's cache directory (`.vx/cache`), from the command context. */
  readonly cacheDir: string
  readonly workspaceRoot: string
}

const TOOLS: readonly ToolDef[] = [
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
      'The latest cache entry recorded for a task (hash, command, exit code, duration, size).',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string', description: 'project#task' } },
      required: ['taskId'],
    },
  },
  {
    name: 'whyDidThisRerun',
    description:
      'Compare a run’s cache key for a task against the previous run and say whether it changed.',
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

export function listTools(): readonly ToolDef[] {
  return TOOLS
}

/** Dispatch a tool call by name. Returns a JSON-serializable result. */
export async function handleToolCall(
  name: string,
  argsRaw: unknown,
  ctx: ToolContext,
): Promise<Record<string, unknown>> {
  const args = (argsRaw ?? {}) as Record<string, unknown>
  switch (name) {
    case 'getCacheStats':
      return getCacheStats(args, ctx)
    case 'getRunHistory':
      return getRunHistory(args, ctx)
    case 'explainCacheKey':
      return explainCacheKey(args, ctx)
    case 'whyDidThisRerun':
      return whyDidThisRerun(args, ctx)
    default:
      throw new UserError(`vx mcp: unknown tool: ${name}`)
  }
}

/**
 * `'all'` | `{ project }` off the wire. Boundary validation: an AI agent must
 * not be able to send a scope the response then echoes back as honored while
 * the numbers are workspace-wide.
 */
function parseCacheScope(raw: unknown): 'all' | { project: string } {
  if (raw === undefined || raw === 'all') return 'all'
  if (typeof raw === 'object' && raw !== null) {
    const project = (raw as { project?: unknown }).project
    if (typeof project === 'string' && project.length > 0) return { project }
  }
  throw new UserError('getCacheStats: scope must be "all" or { "project": "<name>" }')
}

async function getCacheStats(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<Record<string, unknown>> {
  const scope = parseCacheScope(args['scope'])
  const cache = new Cache(ctx.cacheDir)
  try {
    const stats = scope === 'all' ? cache.stats() : cache.stats({ project: scope.project })
    const hitRate24h = stats.runCountLast24h > 0 ? stats.hitCountLast24h / stats.runCountLast24h : 0
    return {
      scope,
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

/**
 * The MCP boundary is an external API, so arguments are validated rather than
 * coerced. `clampInt` floors — the schema's `type: integer` is not enforced
 * by clients, and a fractional LIMIT is a SQLite datatype mismatch rather
 * than a clamp — but it also collapses a NON-FINITE value to the MINIMUM, so
 * `limit: Infinity` (the natural way to ask for everything) would return ONE
 * row. Out-of-range clamps, because the schema publishes the 1..500 bounds;
 * the wrong SHAPE is an error, because nothing published says it would be
 * silently replaced by the default.
 */
function parseLimit(raw: unknown): number {
  if (raw === undefined) return 50
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new UserError(
      `getRunHistory: limit must be a finite number between 1 and 500 (got ${JSON.stringify(raw)})`,
    )
  }
  return clampInt(raw, 1, 500)
}

/** A non-string filter is refused rather than dropped, so an ignored filter cannot look honoured. */
function parseFilter(raw: unknown, name: string): string | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new UserError(
      `getRunHistory: ${name} must be a non-empty string (got ${JSON.stringify(raw)})`,
    )
  }
  return raw
}

async function getRunHistory(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<Record<string, unknown>> {
  const limit = parseLimit(args['limit'])
  const projectFilter = parseFilter(args['project'], 'project')
  const taskFilter = parseFilter(args['task'], 'task')

  const cache = new Cache(ctx.cacheDir)
  try {
    const db = cache.dbHandle()
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
    // Distinct (project, task) pairs from the most recent runs.
    const pairs = db
      .query(`SELECT DISTINCT project, task FROM runs ${clause} ORDER BY started_at DESC LIMIT ?`)
      .all(...params, limit) as { project: string; task: string }[]
    if (pairs.length === 0) return { runs: [], history: [] }
    const ids = pairs.map((p) => `${p.project}#${p.task}`)
    const table = await new LocalHistoryProvider(db).loadFor(ids)
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

async function explainCacheKey(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<Record<string, unknown>> {
  const taskId = args['taskId']
  if (typeof taskId !== 'string' || !taskId.includes('#')) {
    throw new UserError('explainCacheKey: taskId must be a "project#task" string')
  }
  const [project, task] = splitTaskId(taskId)
  const cache = new Cache(ctx.cacheDir)
  try {
    const entry = cache
      .dbHandle()
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
      note: 'the persisted entry metadata; the per-component input breakdown is `vx why <task>`',
    }
  } finally {
    cache.close()
  }
}

async function whyDidThisRerun(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<Record<string, unknown>> {
  const runId = args['runId']
  const taskId = args['taskId']
  if (typeof runId !== 'string' || typeof taskId !== 'string') {
    throw new UserError('whyDidThisRerun: runId and taskId must be strings')
  }
  if (!taskId.includes('#')) {
    throw new UserError('whyDidThisRerun: taskId must be a "project#task" string')
  }
  const cache = new Cache(ctx.cacheDir)
  try {
    // The canonical query, not a copy: two implementations of this once
    // answered differently about rows that recorded no cache key.
    return { ...whyDidThisRerunQuery(cache.dbHandle(), runId, taskId) }
  } finally {
    cache.close()
  }
}
