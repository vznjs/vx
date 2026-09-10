import { appendFile } from 'node:fs/promises'
import path from 'node:path'
import { documentedFlags, seeHelp } from './help.js'
import { defaultAffectedBase, findWorkspaceRoot } from '../workspace/index.js'
import {
  planRun,
  formatRunReportMarkdown,
  outcomeLabel,
  projectOutcome,
  run as runOrchestrator,
  type OutcomeView,
  type RunOptions,
  type RunResult,
} from '../orchestrator/index.js'
import type { ContinueMode } from '../graph/index.js'
import { type CachePolicy, FULL_CACHE_POLICY, parseCachePolicy } from '../cache/index.js'
import { findCwdProject, pickTask, resolveFilters } from './select.js'
import { MAX_TIMEOUT_MS, parseDecimalInt, parseSize, nearest } from '../util/index.js'
import { formatGraphDot, formatPlanJson, formatPlanText } from './plan-format.js'

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
  concurrency: number | undefined
  /**
   * Resolved 4-axis cache policy after applying `--cache` / `--no-cache`
   * / `--force` in precedence order. Defaults to all-on.
   */
  cache: CachePolicy
  /** `--cache` named a remote axis (`remote:r`, `:w`, `:rw`): the run says so when no plugin serves one. */
  remoteRequested?: boolean
  /** `--cache-dir <path>`: override the cache directory (cwd-relative). */
  cacheDir: string | undefined
  frozen: boolean
  /**
   * `--retry <n>` / `--retry=<n>`: run-level retry default for tasks
   * without their own `exec.retries`. Undefined when not passed.
   */
  retries: number | undefined
  /**
   * `--timeout <ms>` / `--timeout=<ms>`: run-level default task timeout for
   * tasks without their own `exec.timeout`. Sits above the `VX_TASK_TIMEOUT`
   * env and workspace `timeout` defaults. Undefined when not passed.
   */
  timeout: number | undefined
  /**
   * `--memory <size>` / `--memory=<size>`: memory budget (resolved to
   * bytes) for `exec.resources.memory` reservations. Defaults to
   * os.totalmem() when not passed — pass it in cgroup-limited containers.
   */
  memory: number | undefined
  outputLogs?: 'full' | 'errors-only' | 'none' | 'hash-only'
  download?: 'all' | 'toplevel' | 'none'
  forwardArgs: string[]
  verbosity: number
  dry: 'text' | 'json' | undefined
  graph: string | undefined
  summarize: string | undefined
  profile: string | undefined
  /**
   * `--affected[=<base>]`. When undefined the flag wasn't passed.
   * Empty string means "use the default base" (resolved later via
   * `defaultAffectedBase`). Any other string is an explicit git ref.
   */
  affected: string | undefined
  /** `--tag k=v` pairs (repeatable). Empty key is a parse error. */
  tags: Record<string, string>
  /** `--report[=markdown]`. Undefined when the flag wasn't passed. */
  report: 'markdown' | undefined
  /**
   * `--report-file=<path>`. Undefined when the flag wasn't passed. Writes
   * the same markdown as `--report`, but to a file — because redirecting
   * vx's stdout captures the whole run log, not just the report.
   */
  reportFile: string | undefined
  error?: string
}

// The camelCase spelling the flag shipped with (retired 2026-09-10): two
// edits past the suggester's reach, so it is named outright. A regex, not a
// quoted literal, so the doc-drift test does not count it as an accepted flag.
const RETIRED_EXCLUDE_DEPENDENCIES = /^--excludeDependencies(=|$)/

/**
 * `--concurrency <n>` is a positive decimal integer, or `<n>%` of the
 * CPU count (`50%` on eight cores is 4, never below 1; over 100% is
 * allowed for I/O-bound work). The percent form resolves here, at parse
 * time, so the run sees one number and the summary says what it ran with.
 */
export function parseConcurrency(v: string, cpus = navigator.hardwareConcurrency): number | null {
  const pct = /^(\d+)%$/.exec(v)
  if (pct) {
    const n = parseDecimalInt(pct[1]!)
    if (n === null || n < 1) return null
    return Math.max(1, Math.round((Math.max(1, cpus) * n) / 100))
  }
  const n = parseDecimalInt(v)
  return n === null || n < 1 ? null : n
}

export function parseRunArgs(args: readonly string[]): RunArgs {
  const out: RunArgs = {
    tasks: [],
    filters: [],
    all: false,
    excludeDependencies: [],
    concurrency: undefined,
    cache: { ...FULL_CACHE_POLICY },
    cacheDir: undefined,
    frozen: false,
    retries: undefined,
    timeout: undefined,
    memory: undefined,
    forwardArgs: [],
    verbosity: 0,
    dry: undefined,
    graph: undefined,
    summarize: undefined,
    profile: undefined,
    affected: undefined,
    tags: {},
    report: undefined,
    reportFile: undefined,
  }

  const sepIdx = args.indexOf('--')
  const before = sepIdx === -1 ? args : args.slice(0, sepIdx)
  out.forwardArgs = sepIdx === -1 ? [] : args.slice(sepIdx + 1)

  // Cache policy is resolved AFTER the loop in precedence order:
  // start all-true → apply each `--cache` spec → `--no-cache` forces
  // all false → `--force` forces both reads false. So `--no-cache`
  // beats `--force`, and `--cache` is the base both may override.
  let cachePolicy: CachePolicy = { ...FULL_CACHE_POLICY }
  let cacheSpecError: string | undefined
  let noCacheFlag = false
  let forceFlag = false

  for (let i = 0; i < before.length; i++) {
    const a = before[i]
    if (a === '--filter' || a?.startsWith('--filter=')) {
      const v = a === '--filter' ? before[++i] : a.slice('--filter='.length)
      if (v === undefined || v === '') return { ...out, error: `--filter requires a value` }
      out.filters.push(v)
    } else if (a === '--concurrency' || a?.startsWith('--concurrency=')) {
      const v = a === '--concurrency' ? before[++i] : a.slice('--concurrency='.length)
      if (v === undefined) return { ...out, error: `--concurrency requires a value` }
      const n = parseConcurrency(v)
      if (n === null) return { ...out, error: `invalid concurrency: ${v}` }
      out.concurrency = n
    } else if (a === '--all') {
      out.all = true
    } else if (RETIRED_EXCLUDE_DEPENDENCIES.test(a ?? '')) {
      return {
        ...out,
        error: `unknown flag: ${a} (the flag is --exclude-dependencies)${seeHelp('run')}`,
      }
    } else if (a === '--exclude-dependencies') {
      out.excludeDependencies = 'all'
    } else if (a?.startsWith('--exclude-dependencies=')) {
      const raw = a.slice('--exclude-dependencies='.length)
      // An empty value is genuinely ambiguous — "drop every edge" (the
      // bare flag) and "drop none" (an empty list) are equally defensible
      // readings, and silently picking either does the opposite of what
      // half the callers mean. Reject and name both explicit forms; the
      // sibling value flags (--retry=, --timeout=, --memory=, --cache-dir=)
      // reject an empty `=` value the same way.
      if (raw === '') {
        return {
          ...out,
          error: `--exclude-dependencies= needs a value — pass bare --exclude-dependencies to drop every dependsOn edge, or omit the flag to keep them`,
        }
      }
      out.excludeDependencies = raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    } else if (a === '--frozen') {
      out.frozen = true
    } else if (a === '--retry' || a?.startsWith('--retry=')) {
      const v = a === '--retry' ? before[++i] : a.slice('--retry='.length)
      if (v === undefined) return { ...out, error: `--retry requires a value` }
      const n = parseDecimalInt(v)
      if (n === null) {
        return { ...out, error: `--retry must be a non-negative integer, got: ${v}` }
      }
      out.retries = n
    } else if (a === '--timeout' || a?.startsWith('--timeout=')) {
      const v = a === '--timeout' ? before[++i] : a.slice('--timeout='.length)
      if (v === undefined) return { ...out, error: `--timeout requires a value` }
      const n = parseDecimalInt(v)
      if (n !== null && n > MAX_TIMEOUT_MS) {
        // Not "effectively no limit" — setTimeout reduces a delay past 2^31-1
        // to 1 ms, so this would kill every task the moment it spawned.
        return {
          ...out,
          error:
            `--timeout ${n} exceeds the maximum timer delay (${MAX_TIMEOUT_MS} ms, ~24.8 days); ` +
            `larger values are silently reduced to 1 ms. Omit --timeout for no limit.`,
        }
      }
      if (n === null || n <= 0) {
        return { ...out, error: `--timeout must be a positive integer (ms), got: ${v}` }
      }
      out.timeout = n
    } else if (a === '--memory' || a?.startsWith('--memory=')) {
      const v = a === '--memory' ? before[++i] : a.slice('--memory='.length)
      if (v === undefined || v === '') return { ...out, error: `--memory requires a value` }
      const bytes = parseSize(v)
      if (bytes === null || bytes <= 0) {
        return { ...out, error: `--memory must be a size like 8GB or 512MB, got: ${v}` }
      }
      out.memory = bytes
    } else if (a === '--output-logs' || a?.startsWith('--output-logs=')) {
      const v = a === '--output-logs' ? before[++i] : a.slice('--output-logs='.length)
      if (v !== 'full' && v !== 'errors-only' && v !== 'none' && v !== 'hash-only') {
        return { ...out, error: `--output-logs must be full, errors-only, hash-only, or none` }
      }
      out.outputLogs = v
    } else if (a === '--download' || a?.startsWith('--download=')) {
      const v = a === '--download' ? before[++i] : a.slice('--download='.length)
      if (v !== 'all' && v !== 'toplevel' && v !== 'none') {
        return { ...out, error: `--download must be all, toplevel, or none` }
      }
      out.download = v
    } else if (a === '--cache-dir' || a?.startsWith('--cache-dir=')) {
      const v = a === '--cache-dir' ? before[++i] : a.slice('--cache-dir='.length)
      if (v === undefined || v === '') return { ...out, error: `--cache-dir requires a value` }
      // Unlike every other value flag, a cache dir is an arbitrary
      // string — nothing about its shape rejects a swallowed flag. An
      // unquoted empty shell var (`--cache-dir $EMPTY --force`) would
      // otherwise create a directory literally named `--force` and drop
      // the flag. A path starting with `-` needs the `=` form.
      if (a === '--cache-dir' && v.startsWith('-')) {
        return { ...out, error: `--cache-dir requires a path, got flag: ${v}` }
      }
      out.cacheDir = v
    } else if (a === '--cache' || a?.startsWith('--cache=')) {
      const v = a === '--cache' ? before[++i] : a.slice('--cache='.length)
      if (v === undefined) return { ...out, error: `--cache requires a value` }
      // A spec with no segment at all applies NOTHING, so `--cache=`
      // (an empty shell var, or someone reaching for "no cache") left
      // all four axes ON — the opposite of the intent. Reject it; an
      // empty flag list for a NAMED layer (`local:`) stays valid and
      // means that layer off.
      if (!v.split(',').some((seg) => seg.trim().length > 0)) {
        return {
          ...out,
          error: `--cache needs a spec like local:r, local:rw, remote:, or local:,remote:rw — pass --no-cache to disable every axis`,
        }
      }
      try {
        cachePolicy = parseCachePolicy(v, cachePolicy)
        if (/remote:[rw]/.test(v)) out.remoteRequested = true
      } catch (err) {
        cacheSpecError = err instanceof Error ? err.message : String(err)
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
      if (v !== 'never' && v !== 'deps-ok' && v !== 'always') {
        return { ...out, error: `--continue must be never, deps-ok, or always` }
      }
      out.continueMode = v
    } else if (a === '--verbosity' || a?.startsWith('--verbosity=')) {
      const v = a === '--verbosity' ? before[++i] : a.slice('--verbosity='.length)
      if (v === undefined) return { ...out, error: `--verbosity requires a value` }
      const n = parseDecimalInt(v)
      if (n === null) return { ...out, error: `invalid verbosity: ${v}` }
      out.verbosity = n
    } else if (a === '--dry') {
      out.dry = 'text'
    } else if (a?.startsWith('--dry=')) {
      const fmt = a.slice('--dry='.length)
      if (fmt !== 'text' && fmt !== 'json') {
        return { ...out, error: `invalid --dry value: ${fmt}` }
      }
      out.dry = fmt
    } else if (a === '--graph') {
      out.graph = ''
    } else if (a?.startsWith('--graph=')) {
      out.graph = a.slice('--graph='.length)
    } else if (a === '--summarize') {
      out.summarize = ''
    } else if (a?.startsWith('--summarize=')) {
      out.summarize = a.slice('--summarize='.length)
    } else if (a === '--profile') {
      out.profile = 'profile.json'
    } else if (a?.startsWith('--profile=')) {
      // An optional-value flag: an empty `=` means "no value given", so it
      // takes the same documented default as the bare form. Resolving ''
      // against cwd would name the cwd DIRECTORY and die with EISDIR after
      // the whole run — and `--summarize=` already degrades to its default.
      out.profile = a.slice('--profile='.length) || 'profile.json'
    } else if (a === '--affected') {
      out.affected = ''
    } else if (a?.startsWith('--affected=')) {
      out.affected = a.slice('--affected='.length)
    } else if (a === '--tag' || a?.startsWith('--tag=')) {
      const raw = a === '--tag' ? before[++i] : a.slice('--tag='.length)
      if (raw === undefined) return { ...out, error: `${a} requires a value` }
      // Split on the FIRST `=` so values may contain `=` (e.g. a URL).
      const eq = raw.indexOf('=')
      if (eq <= 0) return { ...out, error: `invalid --tag (expected k=v): ${raw}` }
      out.tags[raw.slice(0, eq)] = raw.slice(eq + 1)
    } else if (a === '--report-file' || a?.startsWith('--report-file=')) {
      const v = a === '--report-file' ? before[++i] : a.slice('--report-file='.length)
      if (v === undefined || v === '') return { ...out, error: `--report-file requires a path` }
      // Same reasoning as --cache-dir: a path is an arbitrary string, so
      // nothing about its shape rejects a swallowed flag. A path starting
      // with `-` needs the `=` form.
      if (a === '--report-file' && v.startsWith('-')) {
        return { ...out, error: `--report-file requires a path, got flag: ${v}` }
      }
      out.reportFile = v
    } else if (a === '--report') {
      out.report = 'markdown'
    } else if (a?.startsWith('--report=')) {
      const fmt = a.slice('--report='.length)
      if (fmt !== 'markdown') {
        return { ...out, error: `invalid --report value: ${fmt} (only markdown)` }
      }
      out.report = fmt
    } else if (a !== undefined && a.startsWith('-')) {
      return { ...out, error: `unknown flag: ${a}${didYouMeanFlag(a)}${seeHelp('run')}` }
    } else if (a !== undefined) {
      out.tasks.push(a)
    }
  }

  if (cacheSpecError !== undefined) {
    return { ...out, error: cacheSpecError }
  }
  // Precedence: --no-cache (all off) beats --force (reads off, writes
  // kept), both layered on top of any --cache spec.
  if (noCacheFlag) {
    cachePolicy = { localRead: false, localWrite: false, remoteRead: false, remoteWrite: false }
  }
  if (forceFlag) {
    cachePolicy = { ...cachePolicy, localRead: false, remoteRead: false }
  }
  out.cache = cachePolicy

  if (out.dry !== undefined && out.graph !== undefined) {
    return { ...out, error: '--dry and --graph are mutually exclusive' }
  }
  if (out.dry !== undefined && (out.summarize !== undefined || out.profile !== undefined)) {
    return { ...out, error: '--dry skips execution; --summarize / --profile need a real run' }
  }
  if (out.graph !== undefined && (out.summarize !== undefined || out.profile !== undefined)) {
    return { ...out, error: '--graph skips execution; --summarize / --profile need a real run' }
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
): Promise<RunOptions | { error: string } | { nothingSelected: string }> {
  for (const t of tasks) {
    const idx = t.indexOf('#')
    if (idx >= 0) {
      const project = t.slice(0, idx)
      const task = t.slice(idx + 1)
      if (!project || !task) {
        return { error: `invalid pkg#task: ${t}` }
      }
    }
  }

  // `--affected[=<base>]` is sugar for `--filter '[<base>]'`. Merging
  // it into the filter list means the same code path handles plain
  // filter use, --affected alone, and the combo.
  const filterStrings = [...parsed.filters]
  if (parsed.affected !== undefined) {
    const root = await findWorkspaceRoot(cwd)
    const base = parsed.affected === '' ? await defaultAffectedBase(root) : parsed.affected
    filterStrings.push(`[${base}]`)
  }

  // Project scope applies to bare task names only. Anchored entries
  // (pkg#task) resolve directly to their own project regardless.
  const bareTasks = tasks.filter((t) => !t.includes('#'))
  const anchoredTasks = tasks.filter((t) => t.includes('#'))
  let projects: string[] | undefined
  if (bareTasks.length === 0) {
    projects = undefined
  } else if (filterStrings.length > 0) {
    const resolved = await resolveFilters(cwd, filterStrings, {
      ...(parsed.cacheDir !== undefined ? { cacheDir: parsed.cacheDir } : {}),
      ...(parsed.frozen ? { frozen: true } : {}),
    })
    if ('error' in resolved) return { error: resolved.error }
    if ('empty' in resolved) {
      // "Nothing changed" is a clean exit for the BARE tasks the filter
      // scopes — but it must never cancel an explicitly anchored
      // `pkg#task`, which resolves to its own project regardless of
      // scope. An empty project list keeps the bare tasks unselected
      // while the anchored ones still run.
      if (anchoredTasks.length === 0) return { nothingSelected: resolved.empty }
      process.stderr.write(`vx: ${resolved.empty} — running ${anchoredTasks.join(', ')} only\n`)
      projects = []
    } else {
      projects = resolved.names
    }
  } else if (parsed.all) {
    projects = undefined
  } else {
    const cwdProject = await findCwdProject(cwd)
    if (!cwdProject) {
      return {
        error:
          'not inside a project. Pass --all for every project, --filter <pattern> to filter, or run from within a project directory.',
      }
    }
    projects = [cwdProject]
  }

  const opts: RunOptions = {
    cwd,
    tasks: [...tasks],
    cache: parsed.cache,
    ...(parsed.remoteRequested ? { remoteRequested: true } : {}),
    flow: detectFlow(parsed),
    ...(parsed.frozen ? { frozen: true } : {}),
    ...(parsed.outputLogs !== undefined ? { outputLogs: parsed.outputLogs } : {}),
    ...(parsed.download !== undefined ? { download: parsed.download } : {}),
    ...(parsed.continueMode !== undefined ? { continueMode: parsed.continueMode } : {}),
    forwardArgs: parsed.forwardArgs,
  }
  if (parsed.excludeDependencies === 'all') {
    opts.excludeDependencies = 'all'
  } else if (parsed.excludeDependencies.length > 0) {
    opts.excludeDependencies = parsed.excludeDependencies
  }
  if (projects !== undefined) opts.projects = projects
  if (parsed.retries !== undefined) opts.retries = parsed.retries
  if (parsed.timeout !== undefined) opts.timeout = parsed.timeout
  if (parsed.memory !== undefined) opts.memory = parsed.memory
  if (parsed.cacheDir !== undefined) opts.cacheDir = parsed.cacheDir
  if (parsed.concurrency !== undefined) opts.concurrency = parsed.concurrency
  if (parsed.summarize !== undefined) opts.summarize = parsed.summarize
  if (parsed.profile !== undefined) opts.profile = parsed.profile
  if (Object.keys(parsed.tags).length > 0) opts.tags = parsed.tags

  return opts
}

export async function runCmd(args: readonly string[]): Promise<number> {
  const parsed = parseRunArgs(args)
  if (parsed.error) {
    process.stderr.write(`vx run: ${parsed.error}\n`)
    return 1
  }

  const cwd = process.cwd()
  let tasks = [...parsed.tasks]

  // No positionals → interactive picker (TTY only). Yields a single
  // anchored pkg#task; the rest of the pipeline treats it like any
  // explicit anchored positional.
  if (tasks.length === 0) {
    if (!process.stdin.isTTY) {
      process.stderr.write(`vx run: missing task name (stdin is not a TTY)\n`)
      return 1
    }
    const picked = await pickTask(
      cwd,
      {},
      {
        ...(parsed.cacheDir !== undefined ? { cacheDir: parsed.cacheDir } : {}),
        ...(parsed.frozen ? { frozen: true } : {}),
      },
    )
    if (!picked) return 1
    tasks = [`${picked.project}#${picked.task}`]
  }

  const resolved = await resolveRunOptions(parsed, cwd, tasks)
  if ('error' in resolved) {
    process.stderr.write(`vx run: ${resolved.error}\n`)
    return 1
  }
  if ('nothingSelected' in resolved) {
    process.stderr.write(`vx run: ${resolved.nothingSelected}\n`)
    return 0
  }
  const opts = resolved
  // The raw invocation, recorded on the `invocations` row so dashboards
  // show what was actually run. `args` is everything after `run`.
  opts.command = ['vx', 'run', ...args].join(' ')

  // Planning paths short-circuit execution. Both build the full task
  // graph + probe the cache; the difference is just the formatter.
  if (parsed.dry !== undefined || parsed.graph !== undefined) {
    const plan = await planRun(opts)
    if (plan.unresolvedTasks !== undefined && plan.unresolvedTasks.length > 0) {
      process.stderr.write(
        `vx run: no projects declare task(s): ${plan.unresolvedTasks.join(', ')}.\n`,
      )
      return 1
    }
    if (plan.tasks.length === 0) {
      process.stderr.write(`vx run: no projects declare task(s): ${tasks.join(', ')}.\n`)
      return 1
    }
    if (parsed.graph !== undefined) {
      const out = formatGraphDot(plan)
      if (parsed.graph === '') {
        process.stdout.write(out)
      } else {
        await Bun.write(parsed.graph, out)
      }
    } else if (parsed.dry === 'json') {
      process.stdout.write(formatPlanJson(plan))
    } else {
      process.stdout.write(formatPlanText(plan))
    }
    return 0
  }

  // A run executes in THIS process, always. Where an individual task's
  // command runs is the `executor` capability's business (per task, with
  // the scheduler, cache, retries and telemetry unchanged above it); there
  // is no whole-run delegation seam to consult.
  const summary = await runOrchestrator(opts)
  const result: RunResult = { ok: summary.ok, outcomes: summary.outcomes.map(projectOutcome) }
  if (parsed.verbosity > 0) printSummary(result)
  // Report generation is post-run, gated on the flags — zero cost when
  // both are absent. Rendered once, however many sinks asked for it.
  if (parsed.report === 'markdown' || parsed.reportFile !== undefined) {
    const md = formatRunReportMarkdown(result)
    // `--report` writes stdout. The report ITSELF is machine-clean, but
    // stdout is not vx's alone — the status logger writes there too, so
    // `--report=markdown >> "$GITHUB_STEP_SUMMARY"` captures every frame,
    // meter bar and `::group::` command above the table. `--report-file`
    // is the redirect-free form.
    if (parsed.report === 'markdown') process.stdout.write(md)
    if (parsed.reportFile !== undefined) {
      const target = path.resolve(cwd, parsed.reportFile)
      try {
        // APPEND, not overwrite: the flag exists for `$GITHUB_STEP_SUMMARY`,
        // which GitHub documents as append-only and which other steps in the
        // same job also write to. Truncating it would silently destroy their
        // content, and would make replacing the documented `>>` recipe a
        // behaviour change rather than a drop-in.
        await appendFile(target, md)
      } catch (err) {
        // Same contract as --summarize / --profile: the run already
        // happened, so a write failure is reported, not fatal.
        const message = err instanceof Error ? err.message : String(err)
        process.stderr.write(`vx: failed to write report to ${target}: ${message}\n`)
      }
    }
  }
  return result.ok ? 0 : 1
}

function printSummary(summary: RunResult): void {
  const rows = summary.outcomes.map((o) => formatRow(o))
  if (rows.length === 0) return
  const widths = {
    task: Math.max(4, ...rows.map((r) => r.task.length)),
    status: Math.max(6, ...rows.map((r) => r.status.length)),
    duration: Math.max(8, ...rows.map((r) => r.duration.length)),
  }
  const header =
    'TASK'.padEnd(widths.task) +
    '  ' +
    'STATUS'.padEnd(widths.status) +
    '  ' +
    'DURATION'.padStart(widths.duration)
  process.stdout.write(`\n${header}\n`)
  process.stdout.write('-'.repeat(header.length) + '\n')
  for (const r of rows) {
    process.stdout.write(
      r.task.padEnd(widths.task) +
        '  ' +
        r.status.padEnd(widths.status) +
        '  ' +
        r.duration.padStart(widths.duration) +
        '\n',
    )
  }
}

function formatRow(o: OutcomeView): { task: string; status: string; duration: string } {
  return { task: o.taskId, status: outcomeLabel(o), duration: `${o.durationMs}ms` }
}

/** `(did you mean --concurrency?)` for a flag within two edits of a documented one. */
function didYouMeanFlag(flag: string): string {
  const name = flag.replace(/=.*$/, '')
  const flags = documentedFlags('run')
  // The usual two edits; a third only between flags that share their
  // first five characters, so `--retries` reaches `--retry` (the i/y)
  // while `--zzz` does not reach `--all` — a plain three-edit budget did.
  const best =
    nearest(name, flags) ??
    nearest(
      name,
      flags.filter((f) => f.slice(0, 5) === name.slice(0, 5)),
      3,
    )
  return best === undefined ? '' : ` (did you mean ${best}?)`
}
