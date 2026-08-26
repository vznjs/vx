// `vx last [runId]` — replay a recorded run's summary from the terminal,
// without re-executing anything. Comparison gap #12: with the dashboard's
// run-detail page gone (the 2026-08-23 cloud removal), the local run
// history in cache.db is the only replay surface, and this verb reads it.
// Read-only — no config evaluation, no re-hash, no cache probe.

import { Cache } from '../cache/index.js'
import { getInvocation, getRun, listInvocations } from '../orchestrator/index.js'
import { UserError } from '../util/index.js'
import { findWorkspaceRoot, loadWorkspaceConfig, resolveCacheDir } from '../workspace/index.js'

interface LastArgs {
  runId?: string
  list?: number
  format: 'pretty' | 'json'
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
    if (a.startsWith('-')) return { ...out, error: `unknown flag: ${a}` }
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

export async function lastCmd(args: readonly string[]): Promise<number> {
  const parsed = parseLastArgs(args)
  if (parsed.error !== undefined) throw new UserError(`vx last: ${parsed.error}`)

  const root = await findWorkspaceRoot(process.cwd())
  const cacheDir = resolveCacheDir(root, await loadWorkspaceConfig(root))
  const cache = new Cache(cacheDir)
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
    const tasks = detail?.tasks ?? []
    if (tasks.length > 0) {
      lines.push('')
      const failedFirst = [
        ...tasks.filter((t) => t.status === 'failed'),
        ...tasks.filter((t) => t.status !== 'failed'),
      ]
      const idW = Math.max(...tasks.map((t) => `${t.project}#${t.task}`.length), 4)
      for (const t of failedFirst) {
        const id = `${t.project}#${t.task}`
        lines.push(
          `  ${t.status.padEnd(17)} ${id.padEnd(idW)}  ${fmtMs(t.durationMs).padStart(8)}` +
            `${t.hash !== '' ? `  ${t.hash}` : ''}`,
        )
      }
    }
    process.stdout.write(`${lines.join('\n')}\n`)
    return 0
  } finally {
    cache.close()
  }
}
