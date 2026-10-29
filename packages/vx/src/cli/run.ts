import { statSync } from 'node:fs'
import path from 'node:path'
import { isatty } from 'node:tty'
import { findWorkspaceRoot } from '../workspace/index.js'
import { flagHint, refuse, seeHelp } from './help.js'
import {
  planRun,
  run as runOrchestrator,
  shellQuote,
  type RunOptions,
} from '../orchestrator/index.js'
import type { ContinueMode } from '../graph/index.js'
import {
  applyCacheFlags,
  type CacheFlags,
  type CachePolicy,
  FULL_CACHE_POLICY,
  gitRefusal,
  parseCachePolicy,
} from '../cache/index.js'
import { affectedFilterFor, findCwdSelection, pickTask, resolveFilters } from './select.js'
import { nxTargetHint, taskNamesHere } from './task-verb.js'
import {
  detectColors,
  envFlagOn,
  hasControl,
  parseDecimalInt,
  sayNotice,
  sayLine,
} from '../util/index.js'
import { kindHint, parseSettingValue, type Setting, SETTINGS, settingRefusal } from '../settings.js'
import { formatPlanJson, formatPlanText } from './plan-format.js'

export interface RunArgs {
  /** Failure propagation (`--continue[=never|deps-ok|always]`). */
  continueMode?: ContinueMode
  /**
   * Positional task names. Each entry is either a bare task (`'build'`)
   * — applied across the resolved project scope — or anchored as
   * `'pkg#task'` to target a specific project directly. Multiple
   * entries run in one orchestrator invocation with a shared graph.
   */
  tasks: string[]
  filters: string[]
  all: boolean
  /**
   * `'all'`  → skip every `dependsOn` edge (run just the requested task).
   * `[]`     → no exclusion (default).
   * `[...names]` → drop only these specific dep names.
   */
  excludeDependencies: 'all' | string[]
  /**
   * The settings a flag set, by path (`run.timeout` → ms): each flag
   * src/settings.ts names for the verb, parsed by its kind.
   */
  settings: Record<string, unknown>
  /**
   * Resolved 4-axis cache policy after applying `--cache-policy` / `--no-cache`
   * / `--force` in precedence order. Defaults to all-on.
   */
  cache: CachePolicy
  /**
   * Neither `--cache-policy` nor `VX_CACHE_POLICY` named a spec: the run starts from the
   * workspace's `cache.policy` and applies these on top.
   */
  cacheFlags?: CacheFlags
  /** Which setting named a remote axis (`remote:r`, `:w`, `:rw`): the run says so when no plugin serves one. */
  remoteRequested?: '--cache-policy' | 'VX_CACHE_POLICY'
  /** `--cache-dir <path>`: override the cache directory (cwd-relative). */
  cacheDir: string | undefined
  /** `vx watch --poll` (`watch.poll`). */
  poll?: true
  forwardArgs: string[]
  verbosity: number
  dry: 'text' | 'json' | undefined
  profile: string | undefined
  /**
   * `--affected[=<base>]`. When undefined the flag wasn't passed.
   * Empty string means "use the default base" (resolved later via
   * `defaultAffectedBase`). Any other string is an explicit git ref.
   */
  affected: string | undefined
  error?: string
}

// The camelCase spelling the flag shipped with (retired 2026-09-10): two
// edits past the suggester's reach, so it is named outright. A regex, not a
// quoted literal, so the doc-drift test does not count it as an accepted flag.
const RETIRED_EXCLUDE_DEPENDENCIES = /^--excludeDependencies(=|$)/

/** `name` when `a` is it, bare or with `=`. */
function flagOf(a: string | undefined, name: string): string | undefined {
  return a === name || a?.startsWith(`${name}=`) ? name : undefined
}

// The settings parsed by their kind alone; the cache flags, `--continue`
// and `--cache-dir` keep their own branches above.
const GENERIC_FLAGS = SETTINGS.filter(
  (s) => s.flag?.verb === 'run' && !['run.continue', 'cache.dir', 'cache.policy'].includes(s.path),
)

/** The setting a flag names. */
function settingFlagOf(a: string): { s: Setting; name: string } | undefined {
  for (const s of GENERIC_FLAGS) {
    const name = s.flag!.name
    if (flagOf(a, name) !== undefined) return { s, name }
  }
  return undefined
}

/** Each setting a flag sets, and the RunOptions field it lands in. */
const SETTING_OPTIONS = [
  ['run.concurrency', 'concurrency'],
  ['run.schedule', 'schedule'],
  ['run.branch', 'branch'],
  ['run.timeout', 'timeout'],
  ['run.retries', 'retries'],
  ['run.outputLogs', 'outputLogs'],
  ['cache.download', 'download'],
  ['cache.concurrency.download', 'downloadConcurrency'],
  ['cache.concurrency.upload', 'uploadConcurrency'],
  ['cache.concurrency.restore', 'restoreConcurrency'],
] as const satisfies readonly (readonly [string, keyof RunOptions])[]

/** `verb` is the one being parsed for: `vx watch` reads `vx run`'s flags, and
 * its flag hints named `vx run` (M-58). The caller appends the help pointer. */
export function parseRunArgs(args: readonly string[], verb: 'run' | 'watch' = 'run'): RunArgs {
  const out: RunArgs = {
    tasks: [],
    filters: [],
    all: false,
    excludeDependencies: [],
    settings: {},
    cache: { ...FULL_CACHE_POLICY },
    cacheDir: undefined,
    forwardArgs: [],
    verbosity: 0,
    dry: undefined,
    profile: undefined,
    affected: undefined,
  }

  const sepIdx = args.indexOf('--')
  const before = sepIdx === -1 ? args : args.slice(0, sepIdx)
  out.forwardArgs = sepIdx === -1 ? [] : args.slice(sepIdx + 1)

  // Cache policy is resolved AFTER the loop in precedence order:
  // start all-true → apply each `--cache-policy` spec → `--no-cache` forces
  // all false → `--force` forces both reads false. So `--no-cache`
  // beats `--force`, and `--cache-policy` is the base both may override.
  let cachePolicy: CachePolicy = { ...FULL_CACHE_POLICY }
  let cacheSpecError: string | undefined
  let cacheFlag = false
  let noCacheFlag = false
  let forceFlag = false

  for (let i = 0; i < before.length; i++) {
    const a = before[i]
    if (a === '--filter' || a?.startsWith('--filter=')) {
      const v = a === '--filter' ? before[++i] : a.slice('--filter='.length)
      // `--filter --dry` took `--dry` as the pattern (X-13); no filter opens with `--`.
      if (v === undefined || v === '' || (a === '--filter' && v.startsWith('--')))
        return {
          ...out,
          error: `--filter requires a value (a project name, glob or path, e.g. --filter app)`,
        }
      out.filters.push(v)
    } else if (a === '--all') {
      out.all = true
    } else if (RETIRED_EXCLUDE_DEPENDENCIES.test(a ?? '')) {
      return {
        ...out,
        error: `unknown flag: ${a} (the flag is --exclude-dependencies)`,
      }
    } else if (a === '--exclude-dependencies') {
      out.excludeDependencies = 'all'
    } else if (a?.startsWith('--exclude-dependencies=')) {
      const raw = a.slice('--exclude-dependencies='.length)
      // An empty value is genuinely ambiguous — "drop every edge" (the
      // bare flag) and "drop none" (an empty list) are equally defensible
      // readings, and silently picking either does the opposite of what
      // half the callers mean. Reject and name both explicit forms; the
      // sibling value flags (--retries=, --timeout=, --cache-dir=)
      // reject an empty `=` value the same way.
      const names = raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
      // `=,` named nothing and ran every edge, as `=` would have.
      if (names.length === 0) {
        return {
          ...out,
          error: `--exclude-dependencies= needs a value — pass bare --exclude-dependencies to drop every dependsOn edge, or omit the flag to keep them`,
        }
      }
      // Repeated, the last list replaced the earlier ones, so their
      // edges ran; `--filter` adds up the same way.
      if (out.excludeDependencies !== 'all')
        out.excludeDependencies = [...new Set([...out.excludeDependencies, ...names])]
    } else if (a === '--cache-dir' || a?.startsWith('--cache-dir=')) {
      const v = a === '--cache-dir' ? before[++i] : a.slice('--cache-dir='.length)
      if (v === undefined || v === '') return { ...out, error: `--cache-dir requires a path` }
      // Unlike every other value flag, a cache dir is an arbitrary
      // string — nothing about its shape rejects a swallowed flag. An
      // unquoted empty shell var (`--cache-dir $EMPTY --force`) would
      // otherwise create a directory literally named `--force` and drop
      // the flag. A path starting with `-` needs the `=` form.
      if (a === '--cache-dir' && v.startsWith('-')) {
        return {
          ...out,
          error: `--cache-dir requires a path (got flag ${v}; a path that starts with - needs --cache-dir=${v})`,
        }
      }
      out.cacheDir = v
    } else if (flagOf(a, '--cache-policy')) {
      cacheFlag = true
      const name = flagOf(a, '--cache-policy')!
      const v = a === name ? before[++i] : a!.slice(name.length + 1)
      if (v === undefined)
        return {
          ...out,
          error: `${name} requires a value (a spec like local:r, local:rw, remote:, or local:,remote:rw)`,
        }
      // A spec with no segment at all applies NOTHING, so `--cache-policy=`
      // (an empty shell var, or someone reaching for "no cache") left
      // all four axes ON — the opposite of the intent. Reject it; an
      // empty flag list for a NAMED layer (`local:`) stays valid and
      // means that layer off.
      if (!v.split(',').some((seg) => seg.trim().length > 0)) {
        return {
          ...out,
          error: `${name} needs a spec like local:r, local:rw, remote:, or local:,remote:rw — pass --no-cache to disable every axis`,
        }
      }
      try {
        cachePolicy = parseCachePolicy(v, cachePolicy)
        if (/remote:[rw]/.test(v)) out.remoteRequested = '--cache-policy'
      } catch (err) {
        cacheSpecError = `--cache-policy: ${err instanceof Error ? err.message : String(err)}`
      }
    } else if (a === '--no-cache') {
      noCacheFlag = true
    } else if (a === '--force') {
      forceFlag = true
    } else if (a === '--continue') {
      // Bare --continue = 'always' (the Turbo convention). Its mode comes
      // with '=' only: `--continue never` would read `never` as a TASK, and
      // the run would then say "No projects declare task(s): never" — true,
      // and no help at all.
      const next = before[i + 1]
      if (next === 'never' || next === 'deps-ok' || next === 'always') {
        return { ...out, error: `--continue takes its mode with '=': --continue=${next}` }
      }
      out.continueMode = 'always'
    } else if (a?.startsWith('--continue=')) {
      const v = a.slice('--continue='.length)
      if (v === '') {
        return { ...out, error: `--continue= requires a mode (never, deps-ok, or always)` }
      }
      if (v !== 'never' && v !== 'deps-ok' && v !== 'always') {
        return { ...out, error: `--continue must be never, deps-ok, or always (got ${v})` }
      }
      out.continueMode = v
    } else if (a === '--verbosity' || a?.startsWith('--verbosity=')) {
      const v = a === '--verbosity' ? before[++i] : a.slice('--verbosity='.length)
      if (v === undefined || v === '')
        return { ...out, error: `--verbosity requires a value (a non-negative integer)` }
      const n = parseDecimalInt(v)
      if (n === null)
        return { ...out, error: `--verbosity must be a non-negative integer (got ${v})` }
      out.verbosity = n
    } else if (a === '--dry') {
      out.dry = 'text'
    } else if (a?.startsWith('--dry=')) {
      const fmt = a.slice('--dry='.length)
      if (fmt === '') {
        return { ...out, error: `--dry= requires a format (text or json); bare --dry prints text` }
      }
      if (fmt !== 'text' && fmt !== 'json') {
        return { ...out, error: `--dry must be text or json (got ${fmt})` }
      }
      out.dry = fmt
    } else if (a === '--profile') {
      out.profile = 'profile.json'
    } else if (a?.startsWith('--profile=')) {
      // An optional-value flag: an empty `=` means "no value given", so it
      // takes the same documented default as the bare form. Resolving ''
      // against cwd would name the cwd DIRECTORY and die with EISDIR after
      // the whole run.
      out.profile = a.slice('--profile='.length) || 'profile.json'
    } else if (a === '--affected') {
      out.affected = ''
    } else if (a?.startsWith('--affected=')) {
      out.affected = a.slice('--affected='.length)
    } else if (verb === 'watch' && a === '--poll') {
      out.poll = true
    } else if (a !== undefined && settingFlagOf(a) !== undefined) {
      const { s: set, name } = settingFlagOf(a)!
      const v = a === name ? before[++i] : a.slice(name.length + 1)
      if (v === undefined || v === '')
        return { ...out, error: `${name} requires a value (${kindHint(set.kind)})` }
      const value = parseSettingValue(set.kind, v)
      if (value === null) return { ...out, error: settingRefusal(set.path, name, v) }
      out.settings[set.path] = value
    } else if (a !== undefined && a.startsWith('-')) {
      return { ...out, error: `unknown flag: ${a}${flagHint(verb, a)}` }
    } else if (a !== undefined) {
      // A config may not declare such a name (`taskNameProblem`); a pasted
      // newline was refused as an unknown task, printed raw.
      if (hasControl(a))
        return {
          ...out,
          error: `task ${JSON.stringify(a)} holds a control character, which no task name may hold — retype it`,
        }
      out.tasks.push(a)
    }
  }

  if (cacheSpecError !== undefined) {
    return { ...out, error: cacheSpecError }
  }
  // `VX_CACHE_POLICY` is the spec a run takes when no flag names one.
  const envSpec = process.env['VX_CACHE_POLICY'] || undefined
  if (!cacheFlag && envSpec !== undefined) {
    if (!envSpec.split(',').some((seg) => seg.trim().length > 0))
      return {
        ...out,
        error: `VX_CACHE_POLICY needs a spec like local:r, local:rw, remote:, or local:,remote:rw`,
      }
    try {
      cachePolicy = parseCachePolicy(envSpec, cachePolicy)
    } catch (err) {
      return {
        ...out,
        error: `VX_CACHE_POLICY: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
    if (/remote:[rw]/.test(envSpec)) out.remoteRequested = 'VX_CACHE_POLICY'
  }
  // --no-cache (all off) beats --force (reads off, writes kept), both
  // layered on top of the spec; with none named, on the workspace's.
  const flags: CacheFlags = {
    ...(noCacheFlag ? { noCache: true } : {}),
    ...(forceFlag ? { force: true } : {}),
  }
  out.cache = applyCacheFlags(cachePolicy, flags)
  if (!cacheFlag && envSpec === undefined) out.cacheFlags = flags

  // A profile is about a run: the planning branch returns before it is
  // written (item 992).
  if (out.dry !== undefined && out.profile !== undefined) {
    return { ...out, error: '--dry skips execution; --profile needs a real run' }
  }
  return out
}

/**
 * Classify the run's intent from its selection flags. BROAD iff the
 * invocation used `--all` / `--filter` / `--affected` — the user asked
 * about a swath of the workspace and wants news, not output. Everything
 * else is FOCUSED — the user is running "their" task and wants to see
 * it. Owner decision: cwd and task count are irrelevant ("when just run
 * no --all etc then single. cwd does not matter").
 */
export function detectFlow(
  parsed: Pick<RunArgs, 'all' | 'filters' | 'affected'>,
): 'focused' | 'broad' {
  return parsed.all || parsed.filters.length > 0 || parsed.affected !== undefined
    ? 'broad'
    : 'focused'
}

/** `CI=0` / `CI=false` are not CI, as the output flow reads them. */

/** The filters a run's scope comes from: `--filter`s, with `--affected` as its `...[<base>]`. */
async function scopeFilters(
  parsed: RunArgs,
  cwd: string,
): Promise<
  { filterStrings: string[]; affectedFilter?: string } | { error: string; code?: string }
> {
  // `--affected[=<base>]` is sugar for `--filter '...[<base>]'`: the
  // changed projects AND their dependents — what a CI gate must run, what
  // the flag's name says, what the guides promised while the sugar was the
  // changed-only `[<base>]` (item 287). `--filter '[<base>]'` stays the
  // "only what I touched" form. Merging it into the filter list means the
  // same code path handles plain filter use, --affected alone, and the combo.
  // Its place does not change the selection: `applyFilters` takes every
  // include before any exclude (item 979), so `--affected --filter '!app'`
  // drops app from either side (item 955 had put it first for that). First
  // it stays, so a message naming the filters names it first.
  const filterStrings = [...parsed.filters]
  let affectedFilter: string | undefined
  if (parsed.affected !== undefined) {
    const f = await affectedFilterFor(cwd, parsed.affected)
    if (typeof f === 'object') return f
    affectedFilter = f
    filterStrings.unshift(affectedFilter)
  }
  return { filterStrings, ...(affectedFilter !== undefined ? { affectedFilter } : {}) }
}

/**
 * Resolve parsed `vx run` argv into the `RunOptions` the orchestrator
 * consumes. Shared between `runCmd` and `watchCmd` so both subcommands
 * honor the same selection semantics (cwd / `--all` / `--filter` /
 * `--affected` / anchored positionals).
 *
 * Returns the resolved options, an error message, or `nothingSelected` —
 * the selection legitimately resolved to zero projects (nothing changed
 * since the `--affected` base), which is a clean exit, not a failure. The
 * caller prefixes messages with its subcommand name (`vx run: <msg>` /
 * `vx watch: <msg>`).
 *
 * Assumes the caller has already populated `parsed.tasks` (e.g. via
 * the interactive picker for `vx run`).
 */
export async function resolveRunOptions(
  parsed: RunArgs,
  cwd: string,
  tasks: readonly string[],
  verb: 'run' | 'watch' = 'run',
  /** Given, it learns the ref `--affected` diffed from (`--dry=json` states it). */
  scopeOut?: { affectedBase?: string },
): Promise<RunOptions | { error: string; code?: string } | { nothingSelected: string }> {
  for (const t of tasks) {
    const idx = t.indexOf('#')
    if (idx >= 0) {
      const project = t.slice(0, idx)
      const task = t.slice(idx + 1)
      if (!project) {
        return {
          // A bare name runs in the cwd project: `--all` is every project.
          error: `missing project name before '#' in "${t}" (vx ${verb} ${task} --all runs it in every project)`,
        }
      }
      if (!task) {
        return {
          error: `missing task name after '#' in "${t}" (vx show ${project} lists the tasks)`,
        }
      }
    }
  }

  const scope = await scopeFilters(parsed, cwd)
  if ('error' in scope) return scope
  const { filterStrings, affectedFilter } = scope
  // `...[<base>]`: the base alone.
  if (scopeOut !== undefined && affectedFilter !== undefined)
    scopeOut.affectedBase = affectedFilter.slice(4, -1)

  // Project scope applies to bare task names only. Anchored entries
  // (pkg#task) resolve directly to their own project regardless.
  const bareTasks = tasks.filter((t) => !t.includes('#'))
  const anchoredTasks = tasks.filter((t) => t.includes('#'))
  let projects: string[] | undefined
  let staged: RunOptions['staged']
  let discovered: RunOptions['discovered']
  let selectedByDiff = false
  let affected: RunOptions['affected']
  let outright: string[] | undefined
  // Resolved even when every task is anchored and the scope goes unused:
  // a filter or ref the user typed is judged, as it is beside a bare task.
  const resolved =
    filterStrings.length > 0
      ? await resolveFilters(
          cwd,
          filterStrings,
          parsed.cacheDir !== undefined ? { cacheDir: parsed.cacheDir } : {},
          affectedFilter,
          verb,
        )
      : undefined
  if (resolved !== undefined && 'error' in resolved) return resolved
  if (bareTasks.length === 0) {
    projects = undefined
  } else if (resolved !== undefined) {
    if ('empty' in resolved) {
      // "Nothing changed" is a clean exit for the BARE tasks the filter
      // scopes — but it must never cancel an explicitly anchored
      // `pkg#task`, which resolves to its own project regardless of
      // scope. An empty project list keeps the bare tasks unselected
      // while the anchored ones still run.
      if (anchoredTasks.length === 0) return { nothingSelected: resolved.empty }
      sayNotice('info', 'vx run', `${resolved.empty} — running ${anchoredTasks.join(', ')} only`)
      projects = []
    } else {
      projects = resolved.names
      selectedByDiff = resolved.byDiff
      // The graph walk staged every config; the run reuses those entries
      // instead of evaluating and staging them a second time.
      staged = resolved.staged
      discovered = resolved.discovered
      affected = resolved.affected
      outright = resolved.outright
    }
  } else if (parsed.all) {
    projects = undefined
  } else {
    const cwdProject = await findCwdSelection(
      cwd,
      parsed.cacheDir !== undefined ? { cacheDir: parsed.cacheDir } : {},
    )
    if (!cwdProject) {
      const nx = await nxTargetHint(tasks, cwd)
      if (nx !== null) return { error: nx }
      return {
        error: `not inside a project: run from a project directory, or pass --all or --filter <pattern>${seeHelp(verb)}`,
      }
    }
    projects = [cwdProject.name]
    discovered = cwdProject.discovered
  }

  const opts: RunOptions = {
    cwd,
    tasks: [...tasks],
    ...(parsed.cacheFlags !== undefined
      ? { cacheFlags: parsed.cacheFlags }
      : { cache: parsed.cache }),
    ...(parsed.remoteRequested ? { remoteRequested: parsed.remoteRequested } : {}),
    // A laptop reads the shared cache and never writes it (owner,
    // 2026-10-03); naming the remote in `--cache-policy` is asking to.
    ...(!parsed.remoteRequested && !onCI(process.env['CI'])
      ? { remoteReadOnlyByDefault: true }
      : {}),
    flow: detectFlow(parsed),
    ...(parsed.verbosity > 0 ? { summaryTable: true } : {}),
    ...(parsed.continueMode !== undefined ? { continueMode: parsed.continueMode } : {}),
    forwardArgs: parsed.forwardArgs,
    // isatty, not process.stdin: touching the stream opens it, and a config
    // that throws then reports an extra native stack frame.
    ...(isatty(0) ? { tty: true } : {}),
  }
  if (parsed.excludeDependencies === 'all') {
    opts.excludeDependencies = 'all'
  } else if (parsed.excludeDependencies.length > 0) {
    opts.excludeDependencies = parsed.excludeDependencies
  }
  if (projects !== undefined) opts.projects = projects
  if (selectedByDiff) opts.selectedByDiff = true
  if (affected !== undefined) opts.affected = affected
  if (outright !== undefined) opts.selectedOutright = outright
  if (staged !== undefined) opts.staged = staged
  if (discovered !== undefined) opts.discovered = discovered
  if (parsed.cacheDir !== undefined) opts.cacheDir = parsed.cacheDir
  for (const [path, field] of SETTING_OPTIONS) {
    if (parsed.settings[path] !== undefined) Object.assign(opts, { [field]: parsed.settings[path] })
  }
  if (parsed.profile !== undefined) opts.profile = parsed.profile
  // `--affected`'s base is the branch's for the cache scope too.

  return opts
}

/** How many task names a run with no task names before `and N more`. */
const TASKS_SHOWN = 12

export async function runCmd(args: readonly string[]): Promise<number> {
  const parsed = parseRunArgs(args)
  if (parsed.error) {
    return refuse('run', args, `${parsed.error}${seeHelp('run')}`, 'VX_E_USAGE')
  }

  const cwd = process.cwd()
  if (parsed.profile !== undefined) {
    const problem = profileProblem(cwd, parsed.profile)
    if (problem !== undefined) return refuse('run', args, problem, 'VX_E_USAGE')
  }
  let tasks = [...parsed.tasks]
  let picked: string | undefined

  // No positionals → interactive picker (TTY only). Yields a single
  // anchored pkg#task; the rest of the pipeline treats it like any
  // explicit anchored positional.
  if (tasks.length === 0) {
    // A JSON answer is for a program, which cannot pick from a menu: an
    // agent on a pty waited at the picker forever.
    const forProgram = parsed.dry === 'json'
    if (!process.stdin.isTTY || forProgram) {
      const names = await taskNamesHere(cwd)
      const shown = (names ?? []).slice(0, TASKS_SHOWN)
      const more = (names?.length ?? 0) - shown.length
      const tasksHere =
        shown.length === 0
          ? 'vx run <task>, e.g. vx run build'
          : `tasks here: ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`
      return refuse(
        'run',
        args,
        `missing task name (${forProgram ? 'a JSON answer opens' : 'stdin is not a TTY, so'} no picker; ${tasksHere})${seeHelp('run')}`,
        'VX_E_USAGE',
      )
    }
    // Every run needs git: refused here, not after the user has chosen.
    const refusal = gitRefusal(await findWorkspaceRoot(cwd))
    if (refusal !== undefined) {
      sayLine('error', refusal.message, 'vx run')
      return 1
    }
    const load = parsed.cacheDir !== undefined ? { cacheDir: parsed.cacheDir } : {}
    // `--filter` / `--affected` scope the menu, as they scope a bare task:
    // the menu listed every project and the anchored pick ran outside it.
    const scope = await scopeFilters(parsed, cwd)
    if ('error' in scope) return refuse('run', args, scope.error, scope.code ?? 'VX_E_USAGE')
    let only: ReadonlySet<string> | undefined
    if (scope.filterStrings.length > 0) {
      const selected = await resolveFilters(cwd, scope.filterStrings, load, scope.affectedFilter)
      if ('error' in selected)
        return refuse('run', args, selected.error, selected.code ?? 'VX_E_USAGE')
      if ('empty' in selected) {
        sayNotice('info', 'vx run', selected.empty)
        return 0
      }
      only = new Set(selected.names)
    }
    const chosen = await pickTask(cwd, {}, load, only)
    if (chosen === 'interrupted') return 130
    if (!chosen) return 1
    picked = `${chosen.project}#${chosen.task}`
    tasks = [picked]
  }

  const scopeOut: { affectedBase?: string } = {}
  const resolved = await resolveRunOptions(parsed, cwd, tasks, 'run', scopeOut)
  if ('error' in resolved) return refuse('run', args, resolved.error, resolved.code ?? 'VX_E_USAGE')
  // `--dry=json` prints a plan even when there is nothing to run: a script
  // reading stdout broke exactly then (Growth, 2026-10-16).
  const nothingToRun = (): 0 => {
    if (parsed.dry === 'json')
      process.stdout.write(formatPlanJson({ tasks: [] }, scopeOut.affectedBase))
    return 0
  }
  if ('nothingSelected' in resolved) {
    sayNotice('info', 'vx run', resolved.nothingSelected)
    return nothingToRun()
  }
  const opts = resolved
  // The raw invocation, recorded on the `invocations` row so dashboards
  // show what was actually run. `args` is everything after `run`, quoted
  // so `vx last` replays one paste-able line; a picked task is named in
  // it, or the line would open the picker again.
  opts.command = [
    'vx',
    'run',
    ...(picked !== undefined ? [shellQuote(picked)] : []),
    ...args.map(shellQuote),
  ].join(' ')

  // Planning short-circuits execution: the full task graph + a cache probe.
  if (parsed.dry !== undefined) {
    const plan = await planRun(opts)
    // Refused as a run refuses: `--dry=json` gets the error document.
    if (plan.unresolvedTasks !== undefined && plan.unresolvedTasks.length > 0) {
      return refuse(
        'run',
        args,
        `no projects declare task(s): ${plan.unresolvedTasks.join(', ')}.${plan.unresolvedHint ?? ''}`,
        'VX_E_UNKNOWN_TASK',
      )
    }
    if (plan.tasks.length === 0) {
      // The run's own line: a dry run that guessed from the scope alone
      // said no affected project declared a task one did (X-141).
      if (plan.noneAffected !== undefined) {
        sayLine('info', plan.noneAffected, 'vx run')
        return nothingToRun()
      }
      if (opts.selectedByDiff === true) {
        sayNotice('info', 'vx run', `no affected project declares task(s): ${tasks.join(', ')}`)
        return nothingToRun()
      }
      return refuse(
        'run',
        args,
        `no projects declare task(s): ${tasks.join(', ')}`,
        'VX_E_UNKNOWN_TASK',
      )
    }
    if (parsed.dry === 'json') {
      process.stdout.write(formatPlanJson(plan, scopeOut.affectedBase))
    } else {
      process.stdout.write(formatPlanText(plan, detectColors(process.stdout)))
    }
    return 0
  }

  // A run executes in THIS process, always. Where an individual task's
  // command runs is the `executor` capability's business (per task, with
  // the scheduler, cache, retries and telemetry unchanged above it); there
  // is no whole-run delegation seam to consult.
  const summary = await runOrchestrator(opts)
  if (summary.refused !== undefined) {
    const unknown = summary.refused.startsWith('no projects declare')
    return refuse('run', args, summary.refused, unknown ? 'VX_E_UNKNOWN_TASK' : 'VX_E_REFUSED')
  }
  return summary.ok ? 0 : 1
}

/**
 * Why `--profile` cannot write `target`, or undefined. Asked before the
 * run: a directory named as the file died with EISDIR only after it. A
 * missing parent is no fault: the write makes it (item 993).
 */
function profileProblem(cwd: string, target: string): string | undefined {
  if (statSync(path.resolve(cwd, target), { throwIfNoEntry: false })?.isDirectory() === true)
    return `--profile: ${target} is a directory — name a file, e.g. --profile=${path.join(target, 'profile.json')}`
  return undefined
}

/** Whether `CI` names a CI run, as detectCi reads it. */
export function onCI(v: string | undefined): boolean {
  return envFlagOn(v)
}
