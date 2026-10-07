// `vx last [RUNID]` — replay a recorded run's summary from the terminal,
// without re-executing anything. Comparison gap #12: with the dashboard's
// run-detail page gone (the 2026-08-23 cloud removal), the local run
// history in cache.db is the only replay surface, and this verb reads it.
// Read-only — no config evaluation, no re-hash, no cache probe.

import type { Database } from 'bun:sqlite'
import { Cache } from '../cache/index.js'
import { formatBytes } from './format.js'
import { flagHint, formatValue, seeHelp } from './help.js'
import {
  exitSignal,
  getInvocation,
  getRun,
  type InvocationDetail,
  listInvocations,
  outcomeWord,
  type RunSummaryRow,
  resolveRunId,
  shortRunId,
} from '../orchestrator/index.js'
import { formatElapsed, UserError } from '../util/index.js'
import { findWorkspaceRoot } from '../workspace/index.js'
import { cliCacheDir, parseCacheDirFlag } from './workspace-config.js'

interface LastArgs {
  runId?: string
  list?: number
  /** Only runs that failed: the latest one replayed, or the list narrowed. */
  failed?: boolean
  format: 'pretty' | 'json'
  /** `--cache-dir`: read the history a run with the same flag wrote. */
  cacheDir?: string
  error?: string
}

/**
 * A run id as typed beside `--list`: a UUIDv7's first group (8 hex digits)
 * at least, whole or cut as `--list` prints it.
 */
const RUN_ID_SHAPE = /^[0-9a-f]{8}(?:-|$)/i

export function parseLastArgs(args: readonly string[]): LastArgs {
  const out: LastArgs = { format: 'pretty' }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--list' || a.startsWith('--list=')) {
      // `--list 5` is the count, like every other value flag's space form:
      // it read as a run id, which `--list` then ignored, and ten runs came
      // back (item 899). The next argument is the count unless it is a flag
      // or has a run id's shape: `1.5`, `-3` and `abc` read as run ids and
      // were told a run id does not combine with --list (X-29).
      const next = args[i + 1]
      const spaced =
        a === '--list' &&
        next !== undefined &&
        (/^\d+$/.test(next) ||
          (!RUN_ID_SHAPE.test(next) && (!next.startsWith('-') || /^-\d/.test(next))))
      const lv = a === '--list' ? (spaced ? next : '10') : a.slice(7)
      if (spaced) i++
      const n = Number(lv)
      if (!Number.isInteger(n) || n < 1 || n > 500) {
        return { ...out, error: `invalid --list: ${lv} (expected 1..500)` }
      }
      out.list = n
      continue
    }
    if (a === '--failed') {
      out.failed = true
      continue
    }
    if (a === '--format' || a.startsWith('--format=')) {
      const fv = formatValue(a === '--format' ? args[++i] : a.slice(9), 'last')
      if (typeof fv === 'object') return { ...out, ...fv }
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
    if (a.startsWith('-'))
      return { ...out, error: `unknown flag: ${a}${flagHint('last', a)}${seeHelp('last')}` }
    if (out.runId !== undefined)
      return { ...out, error: `unexpected argument: ${a}${seeHelp('last')}` }
    out.runId = a
  }
  // One run's replay or a list of runs, not both: the id was dropped.
  // Beside --list, a word no run id could be is just an extra one.
  if (out.runId !== undefined && out.list !== undefined && !RUN_ID_SHAPE.test(out.runId)) {
    return { ...out, error: `unexpected argument: ${out.runId}${seeHelp('last')}` }
  }
  if (out.runId !== undefined && out.list !== undefined) {
    return {
      ...out,
      error: `a run id and --list do not combine: replay ${out.runId}, or list runs`,
    }
  }
  if (out.runId !== undefined && out.failed === true) {
    return { ...out, error: `a run id and --failed do not combine: replay ${out.runId}` }
  }
  return out
}

/** The `limit` most recent runs that failed, newest first. */
function failedInvocations(db: Database, limit: number): InvocationDetail[] {
  const ids = db
    .query('SELECT run_id FROM invocations WHERE exit_ok = 0 ORDER BY rowid DESC LIMIT ?')
    .all(limit) as Array<{ run_id: string }>
  return ids.map((r) => getInvocation(db, r.run_id)).filter((i) => i !== null)
}

const fmtWhen = (ms: number): string => new Date(ms).toISOString()

const fmtMs = (ms: number): string => formatElapsed(ms, true)

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
    // A hit reads as the run's own summary said it: up-to-date (nothing
    // restored) or restored-local / restored-remote.
    const status =
      t.status === 'failed'
        ? `failed (exit ${t.exitCode})`
        : t.cacheHit === true && t.restored !== null
          ? outcomeWord({ status: t.status as 'cache-hit', restored: t.restored })
          : t.status
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

/**
 * A run's hits by what they did to the disk, as its summary counted them:
 * `5 hits (3 up-to-date, 2 restored: 1 local, 1 remote)`; the layers only
 * when something was restored.
 */
function hitsLine(
  inv: Pick<
    InvocationDetail,
    'hitCount' | 'upToDateCount' | 'restoredLocalCount' | 'restoredRemoteCount'
  >,
): string {
  const hits = `${inv.hitCount} hit${inv.hitCount === 1 ? '' : 's'}`
  if (inv.hitCount === 0) return hits
  const restored = inv.restoredLocalCount + inv.restoredRemoteCount
  const layers =
    restored > 0 ? `: ${inv.restoredLocalCount} local, ${inv.restoredRemoteCount} remote` : ''
  return `${hits} (${inv.upToDateCount} up-to-date, ${restored} restored${layers})`
}

export async function lastCmd(args: readonly string[]): Promise<number> {
  const parsed = parseLastArgs(args)
  if (parsed.error !== undefined) throw new UserError(`vx last: ${parsed.error}`)

  const root = await findWorkspaceRoot(process.cwd())
  const cache = Cache.inspect(await cliCacheDir(root, parsed.cacheDir))
  try {
    const db = cache.dbHandle()
    // Nothing recorded at all is its own answer: `--failed` said "no
    // recorded run failed" and a run id pointed at a `--list` that lists
    // nothing, while `--list --failed` past green runs said there were none.
    const noRuns = (): boolean => listInvocations(db, { limit: 1 }).length === 0

    if (parsed.list !== undefined) {
      const invocations =
        parsed.failed === true
          ? failedInvocations(db, parsed.list)
          : listInvocations(db, { limit: parsed.list })
      if (parsed.format === 'json') {
        process.stdout.write(`${JSON.stringify(invocations)}\n`)
        return 0
      }
      if (invocations.length === 0) {
        process.stdout.write(
          parsed.failed === true && !noRuns() ? 'no recorded run failed\n' : 'no recorded runs\n',
        )
        return 0
      }
      for (const inv of invocations) {
        const verdict = inv.exitOk ? 'ok    ' : 'FAILED'
        process.stdout.write(
          `${verdict} ${fmtWhen(inv.startedAt)}  ${shortRunId(db, inv.runId)}  ` +
            `${inv.taskCount} task${inv.taskCount === 1 ? '' : 's'} · ${hitsLine(inv)}` +
            `${inv.failedCount > 0 ? ` · ${inv.failedCount} failed` : ''} · ${fmtMs(inv.totalDurationMs)}  $ ${inv.command}\n`,
        )
      }
      return 0
    }

    const inv =
      parsed.runId !== undefined
        ? getInvocation(db, resolveRunId(db, parsed.runId, 'vx last') ?? parsed.runId)
        : parsed.failed === true
          ? (failedInvocations(db, 1)[0] ?? null)
          : (listInvocations(db, { limit: 1 })[0] ?? null)
    if (inv === null || inv === undefined) {
      throw new UserError(
        noRuns()
          ? 'vx last: no recorded runs yet — run something first'
          : parsed.runId !== undefined
            ? `vx last: no recorded run ${parsed.runId} (vx last --list shows recent runs)`
            : parsed.failed === true
              ? 'vx last: no recorded run failed'
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
      `  ${inv.taskCount} task${inv.taskCount === 1 ? '' : 's'} · ${hitsLine(inv)}` +
        `${inv.failedCount > 0 ? ` · ${inv.failedCount} failed` : ''}`,
    )
    lines.push(...formatTaskRows(detail?.tasks ?? []))
    // The next command after reading a failed run, with the arguments the
    // run forwarded (a failure under `-- --shard 2` is that shard's).
    const failed = (detail?.tasks ?? []).filter((t) => t.status === 'failed')
    if (failed.length > 0) {
      const at = inv.command.indexOf(' -- ')
      const forwarded = at === -1 ? '' : inv.command.slice(at)
      const ids = failed.map((t) => `${t.project}#${t.task}`).join(' ')
      lines.push('', `  re-run what failed: vx run ${ids}${forwarded}`)
    }
    process.stdout.write(`${lines.join('\n')}\n`)
    return 0
  } finally {
    cache.close()
  }
}
