// `vx why [pkg#task | task]` — answer "why did this task re-run?" from the
// terminal. The same persisted data the MCP `whyDidThisRerun` tool reads:
// the runs table names the
// run-over-run hash change, and `entry_inputs` (the input-fingerprint moat)
// names the exact cache-key components that differ. Read-only over cache.db —
// no config evaluation, no re-hash.

import path from 'node:path'
import { Cache } from '../cache/index.js'
import { flagHint, formatValue, seeHelp } from './help.js'
import { splitTaskId } from '../graph/index.js'
import {
  cacheKeyDiff,
  explainCacheKeyQuery as explainCacheKey,
  latestRunId,
  whyDidThisRerunQuery as whyDidThisRerun,
  resolveRunId,
} from '../orchestrator/index.js'
import { MASKED, nearMatches, printable, UserError } from '../util/index.js'
import { findWorkspaceRoot } from '../workspace/index.js'
import { findCwdProject } from './select.js'
import { cliCacheDir, parseCacheDirFlag } from './workspace-config.js'

interface WhyArgs {
  target?: string
  runId?: string
  format: 'pretty' | 'json'
  /** `--cache-dir`: read the history a run with the same flag wrote. */
  cacheDir?: string
  error?: string
}

/**
 * What to do about a changed key component, by the kind `cache/key-fold.ts`
 * captures. Held to that file's kinds in both directions by
 * `tests/why.test.ts`.
 */
export const WHAT_TO_DO: Readonly<Record<string, string>> = {
  file: 'an edit re-runs by design; a file the task does not read belongs out of cache.inputs.files',
  env: "the variable's value moved; one the task does not read belongs out of cache.inputs.env",
  runtime: 'the command printed something else; drop timestamps and paths from its output',
  'ws-runtime':
    'the workspace command printed something else; drop timestamps and paths from its output',
  forward: 'the arguments after -- differ; the same arguments share one entry',
  package: "the project's package.json changed (a dependency, version or script)",
  workspace:
    'a lockfile or root manifest changed, which re-keys every task; a lockfile plugin keys each project on its own dependencies',
  config:
    "the task's evaluated config changed (its vx.config or a file it imports); `vx show <that task>` prints it as it is now",
  upstream: "a dependency's key moved; `vx why <that task>` says why",
  plugin: "a key plugin's material changed; that plugin decides what it folds",
}

export function parseWhyArgs(args: readonly string[]): WhyArgs {
  const out: WhyArgs = { format: 'pretty' }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    // Match on the flag NAME first. Reading the value into the same
    // `undefined` that means "not this flag" conflated the two: a trailing
    // `--run` (value omitted) consumed a non-existent argv slot, fell through,
    // and was reported as `unknown flag: --run` — false, since `--run` is very
    // much known, and silent about the real mistake. The `=` spelling of the
    // same mistake already said `invalid --run: empty`, so one omitted value
    // got two different diagnoses depending on how it was typed.
    if (a === '--run' || a.startsWith('--run=')) {
      const rv = a === '--run' ? args[++i] : a.slice(6)
      if (rv === undefined || rv === '')
        return { ...out, error: '--run requires a run id (`vx last --list` shows them)' }
      out.runId = rv
      continue
    }
    if (a === '--format' || a.startsWith('--format=')) {
      const fv = formatValue(a === '--format' ? args[++i] : a.slice(9), 'why')
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
      return { ...out, error: `unknown flag: ${a}${flagHint('why', a)}${seeHelp('why')}` }
    if (out.target !== undefined)
      return { ...out, error: `unexpected argument: ${a}${seeHelp('why')}` }
    // Empty is no task: read as a query it matched every recorded one.
    if (a !== '') out.target = a
  }
  return out
}

/**
 * A bare query is a TASK name, so it is matched against the task half of
 * every recorded id (the same rule `vx run` hints with) and the hint is
 * the runnable `project#task`; an anchored query is matched whole.
 */
function suggest(query: string, ids: readonly string[], invoked: boolean): string {
  let hits: string[]
  if (query.includes('#')) {
    hits = nearMatches(query, ids)
  } else {
    const byTask = new Map<string, string[]>()
    for (const id of ids) {
      const task = splitTaskId(id)[1]
      byTask.set(task, [...(byTask.get(task) ?? []), id])
    }
    hits = nearMatches(query, byTask.keys()).flatMap((t) => byTask.get(t) ?? [])
  }
  if (hits.length > 0) return ` — did you mean ${hits.slice(0, 3).join(', ')}?`
  // No near name: say where to look, or that there is nothing yet.
  // A run of only group tasks records no task row: "nothing has run" was
  // false there, and its advice re-ran the group to the same answer.
  if (ids.length > 0) return '; `vx last --list` shows what has run'
  return invoked
    ? '; no recorded run executed a task (a group records none: ask about a task it depends on)'
    : `; nothing has run here yet (vx run ${query}, then vx why)`
}

/**
 * Resolve a positional target to a full `project#task` id against the runs
 * table. A `pkg#task` form is used as-is; a bare task name matches every
 * project that ran it — unique → resolved, several → the project the cwd
 * sits in, as `vx run build` there picks (X-18), else an error listing them.
 */
async function resolveTarget(
  cache: Cache,
  target: string,
  cwdProject: () => Promise<string | null>,
): Promise<string> {
  const db = cache.dbHandle()
  if (target.includes('#')) {
    // An exact id needs one row, and its newest is where a scan from the
    // top of the table finds it first — the full DISTINCT walk below is for
    // the error's suggestions and the bare-name form only.
    const [project, task] = splitTaskId(target)
    const hit = db
      .query('SELECT 1 FROM runs WHERE project = ? AND task = ? ORDER BY id DESC LIMIT 1')
      .get(project, task)
    if (hit !== null) return target
  }
  const pairs = db
    .query('SELECT DISTINCT project, task FROM runs ORDER BY project, task')
    .all() as Array<{ project: string; task: string }>
  const ids = pairs.map((p) => `${p.project}#${p.task}`)
  const invoked = ids.length === 0 && db.query('SELECT 1 FROM invocations LIMIT 1').get() !== null
  if (target.includes('#')) {
    throw new UserError(`vx why: no recorded runs for "${target}"${suggest(target, ids, invoked)}`)
  }
  const matches = ids.filter((id) => id.endsWith(`#${target}`))
  if (matches.length === 1) return matches[0]!
  if (matches.length > 1) {
    const here = await cwdProject()
    if (here !== null && matches.includes(`${here}#${target}`)) return `${here}#${target}`
    throw new UserError(
      `vx why: "${target}" ran in ${matches.length} projects — pick one:\n` +
        matches.map((m) => `  ${m}`).join('\n'),
    )
  }
  throw new UserError(
    `vx why: no recorded runs for task "${target}"${suggest(target, ids, invoked)}`,
  )
}

const fmtWhen = (ms: number): string => new Date(ms).toISOString()

/** `//#task`, Turbo's root package, as the root project's id: its package.json name (D-39). */
async function rootSpelled(root: string, target: string): Promise<string> {
  if (!target.startsWith('//#')) return target
  const name = await Bun.file(path.join(root, 'package.json'))
    .json()
    .then((j: { name?: unknown }) => j.name)
    .catch(() => undefined)
  return typeof name === 'string' && name !== '' ? `${name}#${target.slice(3)}` : target
}

/** ` · up-to-date` or ` · restored` on a hit, as the run's summary said it; nothing otherwise. */
function restoredWord(r: { restored: boolean | null }): string {
  return r.restored === null ? '' : r.restored ? ' · restored' : ' · up-to-date'
}

export async function whyCmd(args: readonly string[]): Promise<number> {
  const parsed = parseWhyArgs(args)
  if (parsed.error !== undefined) throw new UserError(`vx why: ${parsed.error}`)
  if (parsed.target === undefined) {
    throw new UserError('vx why: <task> required (e.g. vx why app#build, or vx why build)')
  }

  const root = await findWorkspaceRoot(process.cwd())
  const cache = Cache.inspect(await cliCacheDir(root, parsed.cacheDir))
  try {
    const db = cache.dbHandle()
    const taskId = await resolveTarget(cache, await rootSpelled(root, parsed.target), () =>
      findCwdProject(process.cwd()),
    )
    let runId: string | null
    if (parsed.runId !== undefined) {
      runId = resolveRunId(db, parsed.runId, 'vx why')
      // An unknown id read as a known run missing the task (X-18).
      if (runId === null) {
        throw new UserError(
          `vx why: no recorded run ${parsed.runId} (vx last --list shows recent runs)`,
        )
      }
    } else runId = latestRunId(db, taskId)

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
      throw new UserError(
        `vx why: run ${runId} has no row for ${taskId}; \`vx last --list\` shows the recorded runs, \`vx last RUNID\` what one ran`,
      )
    }
    const diff = cacheKeyDiff(db, runId, taskId)

    if (parsed.format === 'json') {
      process.stdout.write(`${JSON.stringify({ taskId, runId, why, diff })}\n`)
      return 0
    }

    const lines: string[] = []
    const t = why.thisRun!
    lines.push(`${taskId} — run ${runId}`)
    // A hit's status (`cache-hit`, `cache-hit-remote`) already names it and
    // its tier, and `up-to-date` / `restored` says what it did to the disk;
    // only an executed run needs the word. A skipped task never ran and has
    // no key: it read `skipped · executed · key ` (item 898).
    const ran = t.cacheHit === false && t.status !== 'skipped'
    lines.push(
      `  this run   ${fmtWhen(t.startedAt)} · ${t.status}${restoredWord(t)}` +
        `${ran ? ' · executed' : ''}${t.hash === '' ? ' · no key' : ` · key ${t.hash}`}`,
    )
    if (why.previousRun == null) {
      lines.push('  previous   (none — first recorded run of this task)')
    } else {
      const p = why.previousRun
      lines.push(
        `  previous   ${fmtWhen(p.startedAt)} · ${p.status}${restoredWord(p)} · key ${p.hash}`,
      )
      // The key moved and the diff says by what: the verdict names it, so
      // an env-only change reads as one line, not "inputs differ" above a
      // table to scan.
      // The config component is kind and name `config`: it read "config config".
      const moved = diff.entries.map((e) =>
        e.name === e.kind ? e.kind : `${e.kind} ${printable(e.name)}`,
      )
      lines.push(
        `  verdict    ${
          why.hashChanged === true && moved.length > 0
            ? `cache key changed: ${moved.slice(0, 3).join(', ')}${moved.length > 3 ? ` and ${moved.length - 3} more` : ''}`
            : why.note
        }`,
      )
    }

    if (diff.entries.length > 0) {
      lines.push('')
      lines.push(
        `  what changed (${diff.entries.length} component${diff.entries.length === 1 ? '' : 's'}, ${diff.unchangedCount} unchanged):`,
      )
      const kindW = Math.max(...diff.entries.map((e) => e.kind.length), 4)
      for (const e of diff.entries) {
        // A secret-named env input shows its name and its change, no hash.
        const beforeAfter =
          e.before === MASKED || e.after === MASKED
            ? ''
            : e.change === 'added'
              ? `+ ${e.after}`
              : e.change === 'removed'
                ? `- ${e.before}`
                : `${e.before} → ${e.after}`
        lines.push(
          `    ${e.change.padEnd(7)} ${e.kind.padEnd(kindW)}  ${printable(e.name)}  ${beforeAfter}`.trimEnd(),
        )
      }
      const kinds = [...new Set(diff.entries.map((e) => e.kind))].filter((k) => k in WHAT_TO_DO)
      if (kinds.length > 0) {
        lines.push('', '  what to do:')
        // An upstream row names the task to ask next: the command, not a
        // placeholder to fill in from the row above.
        const upstream = diff.entries.filter((e) => e.kind === 'upstream').map((e) => e.name)
        for (const k of kinds) {
          const todo =
            k === 'upstream'
              ? WHAT_TO_DO[k]!.replace(
                  '`vx why <that task>`',
                  upstream.map((n) => `\`vx why ${n}\``).join(', '),
                )
              : k === 'config'
                ? WHAT_TO_DO[k]!.replace('`vx show <that task>`', `\`vx show ${taskId}\``)
                : WHAT_TO_DO[k]
          lines.push(`    ${k.padEnd(kindW)}  ${todo}`)
        }
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
