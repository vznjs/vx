// `vx last [runId]` — replay a recorded run's summary from the terminal,
// without re-executing anything. Comparison gap #12: with the dashboard's
// run-detail page gone (the 2026-08-23 cloud removal), the local run
// history in cache.db is the only replay surface, and this verb reads it.
// Read-only — no config evaluation, no re-hash, no cache probe.

import { Cache, noteSchemaReset } from '../cache/index.js'
import { formatBytes } from './format.js'
import { seeHelp } from './help.js'
import {
  exitSignal,
  getInvocation,
  getRun,
  listInvocations,
  type RunSummaryRow,
} from '../orchestrator/index.js'
import { UserError } from '../util/index.js'
import { findWorkspaceRoot } from '../workspace/index.js'
import { cliCacheDir, parseCacheDirFlag, warnToStderr } from './workspace-config.js'

interface LastArgs {
  runId?: string
  list?: number
  format: 'pretty' | 'json'
  /** `--cache-dir`: read the history a run with the same flag wrote. */
  cacheDir?: string
  error?: string
}

export function parseLastArgs(args: readonly string[]): LastArgs {
  const out: LastArgs = { format: 'pretty' }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--list' || a.startsWith('--list=')) {
      const lv = a === '--list' ? '10' : a.slice(7)
      const n = Number(lv)
      if (!Number.isInteger(n) || n < 1 || n > 500) {
        return { ...out, error: `invalid --list: ${lv} (expected 1..500)` }
      }
      out.list = n
      continue
    }
    if (a === '--format' || a.startsWith('--format=')) {
      const fv = a === '--format' ? args[++i] : a.slice(9)
      if (fv !== 'pretty' && fv !== 'json') {
        return { ...out, error: `invalid --format: ${fv ?? ''} (expected pretty | json)` }
      }
      out.format = fv
      continue
    }
    const cd = parseCacheDirFlag(args, i)
    if (cd !== null) {
      if ('error' in cd) return { ...out, error: cd.error }
      out.cacheDir = cd.cacheDir
      i = cd.next
      continue
    }
    if (a.startsWith('-')) return { ...out, error: `unknown flag: ${a}${seeHelp('last')}` }
    if (out.runId !== undefined) return { ...out, error: `unexpected argument: ${a}` }
    out.runId = a
  }
  return out
}

const fmtWhen = (ms: number): string => new Date(ms).toISOString()

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`
  const m = Math.floor(ms / 60_000)
  return `${m}m ${Math.round((ms - m * 60_000) / 1000)}s`
}

/**
 * What an executed task used — its peak RSS and its CPU parallelism (CPU
 * time over wall time) — as the runner recorded them. This is the number
 * `@vzn/vx-schedule-history` reserves from, so the replay shows it where
 * a developer can read it; a hit spent nothing and shows nothing.
 */
function fmtUsage(t: {
  cpuMs: number | null
  peakRssBytes: number | null
  durationMs: number
}): string {
  const parts: string[] = []
  if (t.peakRssBytes !== null) parts.push(formatBytes(t.peakRssBytes))
  if (t.cpuMs !== null && t.durationMs > 0)
    parts.push(`${(t.cpuMs / t.durationMs).toFixed(1)}× cpu`)
  return parts.length > 0 ? `  ${parts.join(' · ')}` : ''
}

/**
 * Why a row failed or was skipped, as the run's own footer said it (the
 * v27 columns): a timeout or a never-ready server instead of the signal
 * their exit stands for, the sandbox's violation count, a skip's blocker.
 * Older rows carry none and read as before.
 */
function reasonParts(t: RunSummaryRow): string {
  const parts: string[] = []
  if (t.status === 'failed') {
    if (t.notReady !== null) {
      parts.push(
        `never ready: ${t.notReady === 'timeout' ? 'timed out' : t.notReady === 'exited' ? 'exited' : 'spawn failed'}`,
      )
    } else if (t.timedOut === true) {
      parts.push('timed out')
    } else {
      const signal = exitSignal(t.exitCode)
      if (signal !== undefined) parts.push(`128 + ${signal}`)
    }
    if (t.sandboxViolations !== null && t.sandboxViolations > 0) {
      parts.push(`${t.sandboxViolations} sandbox violation${t.sandboxViolations === 1 ? '' : 's'}`)
    }
  } else if (t.status === 'skipped' && t.blockedBy !== null) {
    parts.push(`after ${t.blockedBy} failed`)
  }
  return parts.map((p) => `  ${p}`).join('')
}

/** Hit rows shown before the rest fold — the slowest restores. */
const HITS_SHOWN = 16

/**
 * The per-task rows: failures first, then what executed or was skipped,
 * then cache hits. Hits are the noise of a warm run — 996 of a thousand
 * rows on a red run put the failure a screen's height above the prompt
 * (item 280) — so past `HITS_SHOWN` they fold into one line with their
 * count; the ones shown are the slowest restores, the one thing a hit's
 * row tells. `--format json` lists every row.
 */
export function formatTaskRows(tasks: readonly RunSummaryRow[]): string[] {
  if (tasks.length === 0) return []
  const failed = tasks.filter((t) => t.status === 'failed')
  const hits = tasks.filter((t) => t.status !== 'failed' && t.cacheHit === true)
  const rest = tasks.filter((t) => t.status !== 'failed' && t.cacheHit !== true)
  const folded = hits.length > HITS_SHOWN
  const shownHits = folded
    ? [...hits].sort((a, b) => b.durationMs - a.durationMs).slice(0, HITS_SHOWN)
    : hits
  const ordered = [...failed, ...rest, ...shownHits]
  const idW = Math.max(...ordered.map((t) => `${t.project}#${t.task}`.length), 4)
  const lines = ['']
  for (const t of ordered) {
    const id = `${t.project}#${t.task}`
    // The terminal summary's own word for a task that runs every time
    // by design; a reader must not take its row for a miss.
    // A failure's row reads as the frame did — `failed (exit 137)` —
    // and above 128 names the signal the number stands for (260).
    const status = t.status === 'failed' ? `failed (exit ${t.exitCode})` : t.status
    lines.push(
      `  ${status.padEnd(17)} ${id.padEnd(idW)}  ${fmtMs(t.durationMs).padStart(8)}` +
        `${t.hash !== '' ? `  ${t.hash}` : ''}${t.cached === false ? '  no-cache' : ''}${fmtUsage(t)}` +
        reasonParts(t),
    )
  }
  if (folded) {
    lines.push(
      `  … +${hits.length - HITS_SHOWN} more cache hits (the ${HITS_SHOWN} slowest restores shown) — vx last --format json lists every row`,
    )
  }
  return lines
}

export async function lastCmd(args: readonly string[]): Promise<number> {
  const parsed = parseLastArgs(args)
  if (parsed.error !== undefined) throw new UserError(`vx last: ${parsed.error}`)

  const root = await findWorkspaceRoot(process.cwd())
  const cache = Cache.inspect(await cliCacheDir(root, parsed.cacheDir))
  noteSchemaReset(cache, warnToStderr)
  try {
    const db = cache.dbHandle()

    if (parsed.list !== undefined) {
      const invocations = listInvocations(db, { limit: parsed.list })
      if (parsed.format === 'json') {
        process.stdout.write(`${JSON.stringify(invocations)}\n`)
        return 0
      }
      if (invocations.length === 0) {
        process.stdout.write('no recorded runs\n')
        return 0
      }
      for (const inv of invocations) {
        const verdict = inv.exitOk ? 'ok    ' : 'FAILED'
        process.stdout.write(
          `${verdict} ${fmtWhen(inv.startedAt)}  ${inv.runId}  ` +
            `${inv.taskCount} task${inv.taskCount === 1 ? '' : 's'} · ${inv.hitCount} hit${inv.hitCount === 1 ? '' : 's'}` +
            `${inv.failedCount > 0 ? ` · ${inv.failedCount} failed` : ''} · ${fmtMs(inv.totalDurationMs)}  $ ${inv.command}\n`,
        )
      }
      return 0
    }

    const inv =
      parsed.runId !== undefined
        ? getInvocation(db, parsed.runId)
        : (listInvocations(db, { limit: 1 })[0] ?? null)
    if (inv === null || inv === undefined) {
      throw new UserError(
        parsed.runId !== undefined
          ? `vx last: no recorded run ${parsed.runId} (vx last --list shows recent runs)`
          : 'vx last: no recorded runs yet — run something first',
      )
    }
    const detail = getRun(db, inv.runId)

    if (parsed.format === 'json') {
      process.stdout.write(`${JSON.stringify({ invocation: inv, tasks: detail?.tasks ?? [] })}\n`)
      return 0
    }

    const lines: string[] = []
    lines.push(`run ${inv.runId} — ${inv.exitOk ? 'ok' : 'FAILED'}`)
    lines.push(`  $ ${inv.command}`)
    lines.push(
      `  ${fmtWhen(inv.startedAt)} · ${fmtMs(inv.totalDurationMs)}` +
        `${inv.branch !== null ? ` · ${inv.branch}` : ''}` +
        `${inv.commitSha !== null ? ` @ ${inv.commitSha.slice(0, 8)}${inv.dirty === true ? '+dirty' : ''}` : ''}` +
        `${inv.ci ? ` · CI${inv.ciProvider !== null ? ` (${inv.ciProvider})` : ''}` : ''}`,
    )
    lines.push(
      `  ${inv.taskCount} task${inv.taskCount === 1 ? '' : 's'} · ${inv.hitCount} hit${inv.hitCount === 1 ? '' : 's'}` +
        ` (${inv.hitLocalCount} local, ${inv.hitRemoteCount} remote)` +
        `${inv.failedCount > 0 ? ` · ${inv.failedCount} failed` : ''}`,
    )
    lines.push(...formatTaskRows(detail?.tasks ?? []))
    process.stdout.write(`${lines.join('\n')}\n`)
    return 0
  } finally {
    cache.close()
  }
}
