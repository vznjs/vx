// `vx why [pkg#task | task]` — answer "why did this task re-run?" from the
// terminal. The runs table names the run-over-run hash change, and
// `entry_inputs` (the input-fingerprint moat) names the exact cache-key
// components that differ. Read-only over cache.db plus a stat of each
// moved input file, no re-hash. Configs are evaluated only when a moved
// upstream is a group: it records no run, so the graph names what it gathers.

import { indexDb, indexError, Cache } from '../cache/index.js'
import { anchoredSpecError, flagHint, formatValue, seeHelp } from './help.js'
import { buildTaskGraph, isDefaultBuild, isGroupTask, splitTaskId } from '../graph/index.js'
import {
  cacheKeyDiff,
  diffsOlderRun,
  explainCacheKey,
  inputWriters,
  latestRunId,
  LocalHistoryProvider,
  recordedTasks,
  rootCauses,
  upstreamTask,
  whyDidThisRerun,
} from '../history/index.js'
import { resolveRunId } from '../orchestrator/index.js'
import { MASKED, nearMatches, printable, refusal, UserError } from '../util/index.js'
import * as ui from '../ui/index.js'
import type { InputWriter, RootCause } from '../history/index.js'
import type { Style } from '../ui/index.js'
import { runRules } from '../settings.js'
import { buildPackageGraph, findWorkspaceRoot } from '../workspace/index.js'
import { findCwdProject } from './select.js'
import {
  cliCacheDir,
  loadCliProjects,
  parseCacheDirFlag,
  rootSpelled,
  verbWorkspace,
  type VerbWorkspace,
} from './workspace-config.js'

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
  file: 'an edit re-runs by design; a file the task does not read belongs out of inputs.files',
  linked:
    'what the symlink points to changed (the file, or a file under the directory); an edit there re-runs by design',
  env: "the variable's value moved; one the task does not read belongs out of inputs.env",
  runtime: 'the command printed something else; drop timestamps and paths from its output',
  'ws-runtime':
    'the workspace command printed something else; drop timestamps and paths from its output',
  forward: 'the arguments after -- differ; the same arguments share one entry',
  config:
    "the task's evaluated config changed (its vx.config or a file it imports); `vx show <that task>` prints it as it is now",
  upstream: "a dependency's key moved; `vx why <that task>` says why",
  plugin: "a key plugin's material changed; that plugin decides what goes into the key",
  platform: 'it ran on another platform; each of its `exec.platforms` keeps its own entry',
  format:
    'another vx version keys tasks differently; every cached task misses once, nothing to fix',
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
      // A run id is hex: one opening with `-` is the next flag, swallowed.
      const flag = a === '--run' && rv?.startsWith('-') === true ? `got flag ${rv}; ` : ''
      if (rv === undefined || rv === '' || flag !== '')
        return {
          ...out,
          error: `--run requires a run id (${flag}\`vx last --list\` shows them)${seeHelp('why')}`,
        }
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
      if ('error' in cd) return { ...out, error: `${cd.error}${seeHelp('why')}` }
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
  if (out.target !== undefined) {
    const error = anchoredSpecError(
      out.target,
      (task) => `vx why ${task} finds the project that ran it`,
    )
    if (error !== undefined) return { ...out, error }
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
  if (ids.length > 0) return '; `vx last --stats` lists the tasks that ran'
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
  declared: () => Promise<Declared>,
  declaresId: (id: string) => Promise<Declared>,
): Promise<string> {
  const db = indexDb(cache)
  if (target.includes('#')) {
    // An exact id needs one row, and its newest is where a scan from the
    // top of the table finds it first — the full DISTINCT walk below is for
    // the error's suggestions and the bare-name form only.
    const [project, task] = splitTaskId(target)
    const hit = db
      .query('SELECT 1 FROM main.runs WHERE project = ? AND task = ? ORDER BY id DESC LIMIT 1')
      .get(project, task)
    if (hit !== null) return target
    if ((await declaresId(target)) === 'group') throw groupRefusal(target)
  } else {
    // A bare name reads only its own task's rows: the DISTINCT over every
    // pair sorted the whole history (24 of 26 ms at 58k rows), and its list
    // serves only the miss's suggestions below.
    const matches = (
      db
        .query('SELECT DISTINCT project FROM main.runs WHERE task = ? ORDER BY project')
        .all(target) as {
        project: string
      }[]
    ).map((r) => `${r.project}#${target}`)
    // Asked even when no project ran it: the cwd project's own that never
    // ran read as a name nobody declares.
    const here = await cwdProject()
    if (here !== null) {
      const own = `${here}#${target}`
      if (matches.includes(own)) return own
      // `vx run build` here runs this project's own: another project's
      // runs were explained in its place, unsaid.
      const kind = await declaresId(own)
      if (kind === 'group') throw groupRefusal(own)
      if (kind !== false) {
        throw refusal(
          { tone: 'info', headline: `no runs of ${own} yet`, fix: `vx run ${target}` },
          { code: 'VX_E_NO_HISTORY', message: `vx why: no recorded runs for "${own}"` },
        )
      }
    }
    if (matches.length === 1) return matches[0]!
    if (matches.length > 1) {
      throw new UserError(
        `vx why: "${target}" ran in ${matches.length} projects — pick one:\n` +
          matches.map((m) => `  ${m}`).join('\n'),
        'VX_E_AMBIGUOUS',
      )
    }
  }
  const ids = new LocalHistoryProvider(db).recentTaskIds()
  const invoked = ids.length === 0 && db.query('SELECT 1 FROM invocations LIMIT 1').get() !== null
  if (ids.length === 0 && !invoked) {
    // `vx run` of a task no project declares is refused: its advice was that.
    const known = await declared()
    // Where the cwd's project does not declare it (a monorepo root), a bare
    // `vx run build` is refused too: that advice sent the user in a circle.
    const here = known && !target.includes('#') ? await cwdProject() : null
    const all = here !== null && (await declaresId(`${here}#${target}`)) === false ? ' --all' : ''
    throw refusal(
      known
        ? { tone: 'info', headline: `no runs of ${target} yet`, fix: `vx run ${target}${all}` }
        : {
            tone: 'info',
            headline: `no project declares ${target}`,
            fix: 'vx show lists the tasks',
          },
      {
        code: 'VX_E_NO_HISTORY',
        message: known
          ? `vx why: no recorded runs for "${target}"${suggest(target, ids, invoked)}`
          : `vx why: no project declares "${target}" (vx show lists the tasks)`,
      },
    )
  }
  if (target.includes('#')) {
    throw new UserError(
      `vx why: no recorded runs for "${target}"${suggest(target, ids, invoked)}`,
      'VX_E_NO_HISTORY',
    )
  }
  throw new UserError(
    `vx why: no recorded runs for task "${target}"${suggest(target, ids, invoked)}`,
    'VX_E_NO_HISTORY',
  )
}

const fmtWhen = (ms: number): string => new Date(ms).toISOString()

/** ` · up-to-date` or ` · restored` on a hit, as the run's summary said it; nothing otherwise. */
function restoredWord(r: { restored: boolean | null }): string {
  return r.restored === null ? '' : r.restored ? ' · restored' : ' · up-to-date'
}

/**
 * One run of the task, the same for `this run` and `previous`. A hit's
 * status (`cache-hit`, `cache-hit-remote`) already names it and its tier,
 * and `up-to-date` / `restored` says what it did to the disk; only an
 * executed run needs the word. A skipped task never ran and has no key: it
 * read `skipped · executed · key ` (item 898).
 */
function runFacts(r: {
  startedAt: number
  status: string
  cacheHit: boolean | null
  restored: boolean | null
  hash: string
}): string {
  const ran = r.cacheHit === false && r.status !== 'skipped'
  return (
    `${fmtWhen(r.startedAt)} · ${r.status}${restoredWord(r)}${ran ? ' · executed' : ''}` +
    (r.hash === '' ? ' · no key' : ` · key ${r.hash}`)
  )
}

export async function whyCmd(args: readonly string[]): Promise<number> {
  const parsed = parseWhyArgs(args)
  if (parsed.error !== undefined) throw new UserError(`vx why: ${parsed.error}`, 'VX_E_USAGE')
  if (parsed.target === undefined) {
    throw new UserError(
      `vx why: <task> required (e.g. vx why app#build, or vx why build)${seeHelp('why')}`,
      'VX_E_USAGE',
    )
  }

  const root = await findWorkspaceRoot(process.cwd())
  const at = verbWorkspace(root)
  const cache = Cache.inspect(await cliCacheDir(at, parsed.cacheDir))
  try {
    const db = indexDb(cache)
    const target = await rootSpelled(at, parsed.target)
    const taskId = await resolveTarget(
      cache,
      target,
      () => findCwdProject(process.cwd(), at),
      () => declares(at, target),
      // The cwd project's own: a bare `vx run` there skips its default build.
      (id) => declares(at, id, true),
    )
    let runId: string | null
    if (parsed.runId !== undefined) {
      runId = resolveRunId(db, parsed.runId, 'vx why')
      // An unknown id read as a known run missing the task (X-18).
      if (runId === null) {
        throw new UserError(
          `vx why: no recorded run ${parsed.runId} (vx last --list shows recent runs)`,
          'VX_E_NO_HISTORY',
        )
      }
    } else runId = latestRunId(db, taskId)

    if (runId === null) {
      // Runs exist (resolveTarget passed) but predate run ids — fall back to
      // the persisted entry metadata so the verb still says something useful.
      const explanation = explainCacheKey(db, taskId)
      if (parsed.format === 'json') {
        ui.data('out', `${JSON.stringify({ taskId, why: null, diff: null, explanation })}\n`)
      } else {
        ui.print(
          'out',
          ui.section(
            'Why',
            taskId,
            ui.text('recorded runs carry no run id: the latest cache entry instead'),
            ui.fields(
              explanation.latestEntry !== null
                ? [
                    ['key', explanation.latestEntry.hash],
                    ['command', ui.cmd(explanation.latestEntry.command)],
                  ]
                : [['key', 'no cache entry either']],
            ),
          ),
        )
      }
      return 0
    }

    const why = whyDidThisRerun(db, runId, taskId)
    if (!why.found) {
      throw new UserError(
        `vx why: run ${runId} has no row for ${taskId}; \`vx last --list\` shows the recorded runs, \`vx last RUNID\` what one ran`,
        'VX_E_NO_HISTORY',
      )
    }
    const diff = cacheKeyDiff(db, runId, taskId)
    // An upstream change is never the cause, only its carrier: follow
    // each moved dependency in this run down to the tasks whose own
    // inputs moved, so one `vx why` names the file, not the next task.
    // A group records no run: the graph names what it gathers.
    const recorded = recordedTasks(db, runId)
    const unrecorded = diff.entries.filter(
      (e) => e.kind === 'upstream' && e.change === 'changed' && !recorded.has(upstreamTask(e.name)),
    )
    const groups = unrecorded.length > 0 ? await groupMembers(at, taskId) : new Map()
    const roots = rootCauses(db, runId, taskId, diff.entries, groups)
    const writers = inputWriters(db, runId, root, taskId, diff.entries, roots)

    if (parsed.format === 'json') {
      await ui.dataPieces('out', jsonPieces({ taskId, runId, why, diff }, roots, writers))
      return 0
    }

    const t = why.thisRun!
    const head: ui.FieldRow[] = [
      ['run', runId],
      ['this run', runFacts(t)],
    ]
    if (why.previousRun == null && t.hash === '') {
      // Only keyed runs are compared: a persistent task's tenth run read
      // as its first, and the note saying why went unprinted.
      head.push(['previous', 'none with a cache key'], ['verdict', why.note])
    } else if (why.previousRun == null) {
      head.push(['previous', 'none: first recorded run of this task'])
    } else {
      // The key moved and the diff says by what: the verdict names it, so
      // an env-only change reads as one line, not "inputs differ" above a
      // table to scan.
      // The config component is kind and name `config`: it read "config config".
      const moved = diff.entries.map((e) =>
        e.name === e.kind ? e.kind : `${e.kind} ${printable(e.name)}`,
      )
      head.push(
        ['previous', runFacts(why.previousRun)],
        [
          'verdict',
          why.hashChanged === true && moved.length > 0
            ? ui.tone(
                'warn',
                `cache key changed: ${moved.slice(0, 3).join(', ')}${moved.length > 3 ? ` and ${moved.length - 3} more` : ''}`,
              )
            : why.note,
        ],
      )
    }
    // The rows below may be against an older run than `previous`: the
    // last that saved an entry. The note names it.
    if ((diff.entries.length === 0 && why.hashChanged === true) || diffsOlderRun(diff))
      head.push(['detail', diff.note])
    const blocks: ui.Block[] = [ui.section('Why', taskId, ui.fields(head))]

    if (diff.entries.length > 0) {
      blocks.push(
        ui.section(
          'What changed',
          `${diff.entries.length} of ${diff.entries.length + diff.unchangedCount}`,
          ui.table(
            ['change', 'kind', 'name', 'before → after'],
            diff.entries.map((e) => [
              ui.tone(CHANGE_HUE[e.change] ?? 'warn', e.change),
              e.kind,
              ui.strong(printable(e.name)),
              // A secret-named env input shows its name and its change, no hash.
              e.before === MASKED || e.after === MASKED
                ? ''
                : e.change === 'added'
                  ? `+ ${e.after}`
                  : e.change === 'removed'
                    ? `- ${e.before}`
                    : `${e.before} → ${e.after}`,
            ]),
          ),
        ),
      )
      if (roots.length > 0) {
        const lines: ui.Inline[] = roots.slice(0, ROOTS_SHOWN).map((r) => {
          const what = r.entries.map((e) =>
            e.name === e.kind ? e.kind : `${e.kind} ${printable(e.name)}`,
          )
          // A 20,000-task chain printed whole is one 389 KB line.
          const chain = r.chain
          const ids =
            chain.length > CHAIN_SHOWN
              ? [
                  ...chain.slice(0, 2).map((id) => ui.id(id)),
                  ui.dim(`${chain.length - 5} more`),
                  ...chain.slice(-3).map((id) => ui.id(id)),
                ]
              : chain.map((id) => ui.id(id))
          return [
            ...ids.flatMap((id, i) => [...(i > 0 ? [ui.dim(' \u2190 ')] : []), id]),
            ui.dim(' \u2190 '),
            ui.strong(
              `${what.slice(0, 3).join(', ')}${what.length > 3 ? ` and ${what.length - 3} more` : ''}`,
            ),
          ]
        })
        if (roots.length > ROOTS_SHOWN) lines.push(`and ${roots.length - ROOTS_SHOWN} more`)
        blocks.push(ui.section('Root cause', ui.text(...lines)))
      }
      if (writers.length > 0) {
        blocks.push(
          ui.section(
            'Changed during a run',
            ui.table(
              ['file', 'written while'],
              writers.map((w) => [ui.path(printable(w.file)), w.writers.join(', ')]),
            ),
          ),
        )
      }
      const rootKinds = roots.flatMap((r) => r.entries.map((e) => e.kind))
      // An upstream row names the task to ask next: the command, not a
      // placeholder to fill in from the row above. A group records no run,
      // so `vx why` on one refuses: its members are asked instead.
      const upstream = upstreamTodo(
        diff.entries.filter((e) => e.kind === 'upstream'),
        unrecorded,
      )
      const kinds = [...new Set([...diff.entries.map((e) => e.kind), ...rootKinds])].filter(
        (k) =>
          k in WHAT_TO_DO && !(k === 'upstream' && (roots.length > 0 || upstream.length === 0)),
      )
      if (kinds.length > 0) {
        // The task whose config moved: this one, or a root cause's, never
        // the asked task for an upstream's change.
        const configOf = [
          ...new Set([
            ...(diff.entries.some((e) => e.kind === 'config') ? [taskId] : []),
            ...roots.filter((r) => r.entries.some((e) => e.kind === 'config')).map((r) => r.task),
          ]),
        ]
        const todo: ui.FieldRow[] = []
        for (const k of kinds) {
          if (k === 'upstream') {
            todo.push([k, ...upstream])
            continue
          }
          todo.push([
            k,
            k === 'config'
              ? WHAT_TO_DO[k]!.replace(
                  '`vx show <that task>`',
                  `${configOf
                    .slice(0, 3)
                    .map((id) => `\`vx show ${id}\``)
                    .join(', ')}${configOf.length > 3 ? ` (and ${configOf.length - 3} more)` : ''}`,
                )
              : WHAT_TO_DO[k]!,
          ])
        }
        // A task re-writing a file a key reads moves that key every run:
        // the miss is right, and only moving the write ends it.
        if (writers.length > 0) todo.push(['written', WRITTEN_TODO])
        blocks.push(ui.section('What to do', ui.fields(todo)))
      }
    }
    ui.print('out', ...blocks)
    return 0
  } catch (err) {
    throw indexError(cache, err)
  } finally {
    cache.close()
  }
}

const ROOTS_SHOWN = 5

/** Longer root-cause chains print their two ends around a count. */
const CHAIN_SHOWN = 6

/** Bytes of roots per piece written. */
const PIECE_BYTES = 1 << 20

/**
 * `{ ...head, roots, writers }` as one `JSON.stringify` of it gives, in
 * pieces: every root carries its whole chain, so a 20,000-task chain's
 * roots hold 2×10⁸ ids, more than one string holds.
 */
function* jsonPieces(
  head: object,
  roots: readonly RootCause[],
  writers: readonly InputWriter[],
): Generator<string> {
  let piece = `${JSON.stringify(head).slice(0, -1)},"roots":[`
  for (let i = 0; i < roots.length; i++) {
    piece += `${i > 0 ? ',' : ''}${JSON.stringify(roots[i])}`
    if (piece.length >= PIECE_BYTES) {
      yield piece
      piece = ''
    }
  }
  yield `${piece}],"writers":${JSON.stringify(writers)}}\n`
}

const CHANGE_HUE: Record<string, Style> = { added: 'ok', removed: 'error', changed: 'warn' }

type DiffEntry = ReturnType<typeof cacheKeyDiff>['entries'][number]

/**
 * The upstream advice: a moved key names the task to ask next, a group
 * (no run of its own) the verb that names what it gathers, and an edge
 * added or removed says the graph changed, since no key moved.
 */
function upstreamTodo(upstream: readonly DiffEntry[], unrecorded: readonly DiffEntry[]): string[] {
  const out: string[] = []
  const groups = new Set(unrecorded.map((e) => e.name))
  const moved = [
    ...new Set(
      upstream
        .filter((e) => e.change === 'changed' && !groups.has(e.name))
        .map((e) => upstreamTask(e.name)),
    ),
  ]
  if (moved.length > 0)
    out.push(
      WHAT_TO_DO['upstream']!.replace(
        '`vx why <that task>`',
        moved.map((n) => `\`vx why ${n}\``).join(', '),
      ),
    )
  for (const g of groups)
    out.push(
      `${g} is a group and records no run; \`vx show ${g}\` names what it gathers, \`vx why\` on the one whose key moved says why`,
    )
  const edges = upstream.filter((e) => e.change !== 'changed')
  if (edges.length > 0)
    out.push(
      `a dependency joined or left the graph (${edges.map((e) => `${e.name} ${e.change}`).join(', ')}): its \`dependsOn\` or a project edge changed, which re-keys the task by design`,
    )
  return out
}

/** A declared group (no `exec`) records no run: `group` when every declaration is one. */
type Declared = false | 'task' | 'group'

/** Whether a project declares `target` (`pkg#task`, or a bare task); `task` when no config loads. */
async function declares(at: VerbWorkspace, target: string, own = false): Promise<Declared> {
  try {
    const projects = await loadCliProjects(at.root, await at.projects(), 'all')
    const [project, task] = target.includes('#') ? splitTaskId(target) : [undefined, target]
    const found = [...projects.values()].flatMap((p) => {
      const t = p.config.tasks?.[task]
      return (project === undefined || p.name === project) &&
        Object.hasOwn(p.config.tasks ?? {}, task) &&
        !(own && isDefaultBuild(t))
        ? [t]
        : []
    })
    if (found.length === 0) return false
    // The default build is a group too, but no one declared it.
    return found.every((t) => t?.exec === undefined && !isDefaultBuild(t)) ? 'group' : 'task'
  } catch {
    // quiet: with no lock or a broken config, the run says why itself
    return 'task'
  }
}

function groupRefusal(id: string): UserError {
  return refusal(
    { tone: 'info', headline: `${id} is a group, which records no run`, fix: `vx show ${id}` },
    {
      code: 'VX_E_NO_HISTORY',
      message: `vx why: ${id} is a group, which records no run (vx show ${id} names what it gathers)`,
    },
  )
}

/**
 * Each group in `taskId`'s graph with the tasks it gathers. Empty when a
 * config no longer loads: the advice then names the group to `vx show`.
 */
async function groupMembers(at: VerbWorkspace, taskId: string): Promise<Map<string, string[]>> {
  try {
    const { root } = at
    const metas = await at.projects()
    const projects = await loadCliProjects(root, metas, 'all', { closure: true })
    const [project, task] = splitTaskId(taskId)
    const nodes = buildTaskGraph({
      projects,
      packageGraph: buildPackageGraph(metas),
      requested: [{ project, task }],
      workspaceRoot: root,
      rules: runRules((await at.workspace()).workspaceConfig),
    })
    return new Map([...nodes.values()].filter(isGroupTask).map((n) => [n.id, n.deps]))
  } catch {
    return new Map()
  }
}

const WRITTEN_TODO =
  'a task that writes a file a key reads re-keys it every run; give that write its own task with the file as an output, or keep the file out of inputs.files'
