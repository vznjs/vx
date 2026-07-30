// `vx why [pkg#task | task]` — answer "why did this task re-run?" from the
// terminal. The same persisted data the dashboard's "Why did this re-run?"
// card and the MCP `whyDidThisRerun` tool read: the runs table names the
// run-over-run hash change, and `entry_inputs` (the input-fingerprint moat)
// names the exact cache-key components that differ. Read-only over cache.db —
// no config evaluation, no re-hash.

import { Cache } from '../cache/index.js'
import { splitTaskId } from '../graph/index.js'
import {
  cacheKeyDiff,
  explainCacheKeyQuery as explainCacheKey,
  whyDidThisRerunQuery as whyDidThisRerun,
} from '../orchestrator/index.js'
import { UserError } from '../util/index.js'
import { findWorkspaceRoot, loadWorkspaceConfig, resolveCacheDir } from '../workspace/index.js'

interface WhyArgs {
  target?: string
  runId?: string
  format: 'pretty' | 'json'
  error?: string
}

export function parseWhyArgs(args: readonly string[]): WhyArgs {
  const out: WhyArgs = { format: 'pretty' }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    const rv = a === '--run' ? args[++i] : a.startsWith('--run=') ? a.slice(6) : undefined
    if (rv !== undefined) {
      if (rv === '') return { ...out, error: 'invalid --run: empty' }
      out.runId = rv
      continue
    }
    const fv = a === '--format' ? args[++i] : a.startsWith('--format=') ? a.slice(9) : undefined
    if (fv !== undefined) {
      if (fv !== 'pretty' && fv !== 'json') {
        return { ...out, error: `invalid --format: ${fv} (expected pretty | json)` }
      }
      out.format = fv
      continue
    }
    if (a.startsWith('-')) return { ...out, error: `unknown flag: ${a}` }
    if (out.target !== undefined) return { ...out, error: `unexpected argument: ${a}` }
    out.target = a
  }
  return out
}

/** Simple includes-match in both directions, case-insensitive. */
function suggest(query: string, candidates: readonly string[]): string {
  const q = query.toLowerCase()
  const hits = candidates.filter((c) => {
    const n = c.toLowerCase()
    return n.includes(q) || q.includes(n)
  })
  return hits.length > 0 ? ` — did you mean ${hits.slice(0, 3).join(', ')}?` : ''
}

/**
 * Resolve a positional target to a full `project#task` id against the runs
 * table. A `pkg#task` form is used as-is; a bare task name matches every
 * project that ran it — unique → resolved, several → error listing them.
 */
function resolveTarget(cache: Cache, target: string): string {
  const db = cache.dbHandle()
  const pairs = db
    .query('SELECT DISTINCT project, task FROM runs ORDER BY project, task')
    .all() as Array<{ project: string; task: string }>
  const ids = pairs.map((p) => `${p.project}#${p.task}`)
  if (target.includes('#')) {
    if (ids.includes(target)) return target
    throw new UserError(`vx why: no recorded runs for "${target}"${suggest(target, ids)}`)
  }
  const matches = ids.filter((id) => id.endsWith(`#${target}`))
  if (matches.length === 1) return matches[0]!
  if (matches.length > 1) {
    throw new UserError(
      `vx why: "${target}" ran in ${matches.length} projects — pick one:\n` +
        matches.map((m) => `  ${m}`).join('\n'),
    )
  }
  throw new UserError(`vx why: no recorded runs for task "${target}"${suggest(target, ids)}`)
}

/** The latest recorded run of a task (run_id may be NULL on very old rows). */
function latestRunId(cache: Cache, taskId: string): string | null {
  const [project, task] = splitTaskId(taskId)
  const row = cache
    .dbHandle()
    .query(
      `SELECT run_id AS runId FROM runs WHERE project = ? AND task = ?
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(project, task) as { runId: string | null } | undefined
  return row?.runId ?? null
}

const fmtWhen = (ms: number): string => new Date(ms).toISOString()

export async function whyCmd(args: readonly string[]): Promise<number> {
  const parsed = parseWhyArgs(args)
  if (parsed.error !== undefined) throw new UserError(`vx why: ${parsed.error}`)
  if (parsed.target === undefined) {
    throw new UserError('vx why: <task> required (e.g. vx why app#build, or vx why build)')
  }

  const root = await findWorkspaceRoot(process.cwd())
  const cacheDir = resolveCacheDir(root, await loadWorkspaceConfig(root))
  const cache = new Cache(cacheDir)
  try {
    const db = cache.dbHandle()
    const taskId = resolveTarget(cache, parsed.target)
    const runId = parsed.runId ?? latestRunId(cache, taskId)

    if (runId === null) {
      // Runs exist (resolveTarget passed) but predate run ids — fall back to
      // the persisted entry metadata so the verb still says something useful.
      const explanation = explainCacheKey(db, taskId)
      if (parsed.format === 'json') {
        process.stdout.write(`${JSON.stringify({ taskId, why: null, diff: null, explanation })}\n`)
      } else {
        process.stdout.write(
          `${taskId}: recorded runs carry no run id — showing the latest cache entry instead\n` +
            (explanation.latestEntry !== null
              ? `  hash ${explanation.latestEntry.hash} · $ ${explanation.latestEntry.command}\n`
              : '  (no cache entry either)\n'),
        )
      }
      return 0
    }

    const why = whyDidThisRerun(db, runId, taskId)
    if (!why.found) {
      throw new UserError(`vx why: run ${runId} has no row for ${taskId}`)
    }
    const diff = cacheKeyDiff(db, runId, taskId)

    if (parsed.format === 'json') {
      process.stdout.write(`${JSON.stringify({ taskId, runId, why, diff })}\n`)
      return 0
    }

    const lines: string[] = []
    const t = why.thisRun!
    lines.push(`${taskId} — run ${runId}`)
    lines.push(
      `  this run   ${fmtWhen(t.startedAt)} · ${t.status}` +
        `${t.cacheHit === true ? ' · cache hit' : t.cacheHit === false ? ' · executed' : ''} · key ${t.hash}`,
    )
    if (why.previousRun == null) {
      lines.push('  previous   (none — first recorded run of this task)')
    } else {
      const p = why.previousRun
      lines.push(`  previous   ${fmtWhen(p.startedAt)} · ${p.status} · key ${p.hash}`)
      lines.push(`  verdict    ${why.note}`)
    }

    if (diff.entries.length > 0) {
      lines.push('')
      lines.push(
        `  what changed (${diff.entries.length} component${diff.entries.length === 1 ? '' : 's'}, ${diff.unchangedCount} unchanged):`,
      )
      const kindW = Math.max(...diff.entries.map((e) => e.kind.length), 4)
      for (const e of diff.entries) {
        const beforeAfter =
          e.change === 'added'
            ? `+ ${e.after}`
            : e.change === 'removed'
              ? `- ${e.before}`
              : `${e.before} → ${e.after}`
        lines.push(`    ${e.change.padEnd(7)} ${e.kind.padEnd(kindW)}  ${e.name}  ${beforeAfter}`)
      }
    } else if (why.hashChanged === true) {
      lines.push(`  detail     ${diff.note}`)
    }
    process.stdout.write(`${lines.join('\n')}\n`)
    return 0
  } finally {
    cache.close()
  }
}
