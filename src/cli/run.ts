import readline from 'node:readline/promises'
import path from 'node:path'
import {
  affectedProjects,
  applyFilters,
  buildPackageGraph,
  defaultAffectedBase,
  findWorkspaceRoot,
  listProjects,
  loadProjectConfig,
  loadWorkspace,
  parseFilter,
  type ProjectMeta,
} from '../workspace/index.js'
import {
  run as runOrchestrator,
  planRun,
  type RunOptions,
  type RunSummary,
} from '../orchestrator/index.js'
import { formatGraphDot, formatPlanJson, formatPlanText } from './plan-format.js'
import type { TaskOutcome } from '../graph/index.js'

export interface RunArgs {
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
  noCache: boolean
  frozen: boolean
  outputLogs?: 'full' | 'errors-only' | 'none'
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
  error?: string
}

export function parseRunArgs(args: readonly string[]): RunArgs {
  const out: RunArgs = {
    tasks: [],
    filters: [],
    all: false,
    excludeDependencies: [],
    concurrency: undefined,
    noCache: false,
    frozen: false,
    forwardArgs: [],
    verbosity: 0,
    dry: undefined,
    graph: undefined,
    summarize: undefined,
    profile: undefined,
    affected: undefined,
  }

  const sepIdx = args.indexOf('--')
  const before = sepIdx === -1 ? args : args.slice(0, sepIdx)
  out.forwardArgs = sepIdx === -1 ? [] : args.slice(sepIdx + 1)

  for (let i = 0; i < before.length; i++) {
    const a = before[i]
    if (a === '--filter') {
      const v = before[++i]
      if (v === undefined) return { ...out, error: `${a} requires a value` }
      out.filters.push(v)
    } else if (a === '--concurrency') {
      const v = before[++i]
      if (v === undefined) return { ...out, error: `${a} requires a value` }
      const n = Number(v)
      if (!Number.isFinite(n) || n < 1) return { ...out, error: `invalid concurrency: ${v}` }
      out.concurrency = Math.floor(n)
    } else if (a === '--all') {
      out.all = true
    } else if (a === '--excludeDependencies') {
      out.excludeDependencies = 'all'
    } else if (a?.startsWith('--excludeDependencies=')) {
      const raw = a.slice('--excludeDependencies='.length)
      out.excludeDependencies = raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    } else if (a === '--frozen') {
      out.frozen = true
    } else if (a === '--output-logs') {
      const v = before[++i]
      if (v !== 'full' && v !== 'errors-only' && v !== 'none') {
        return { ...out, error: `--output-logs must be full, errors-only, or none` }
      }
      out.outputLogs = v
    } else if (a === '--no-cache' || a === '--force') {
      out.noCache = true
    } else if (a === '--verbosity') {
      const v = before[++i]
      if (v === undefined) return { ...out, error: `${a} requires a value` }
      const n = Number(v)
      if (!Number.isInteger(n) || n < 0) return { ...out, error: `invalid verbosity: ${v}` }
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
      out.profile = a.slice('--profile='.length)
    } else if (a === '--affected') {
      out.affected = ''
    } else if (a?.startsWith('--affected=')) {
      out.affected = a.slice('--affected='.length)
    } else if (a !== undefined && a.startsWith('-')) {
      return { ...out, error: `unknown flag: ${a}` }
    } else if (a !== undefined) {
      out.tasks.push(a)
    }
  }

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
 * Resolve parsed `vx run` argv into the `RunOptions` the orchestrator
 * consumes. Shared between `runCmd` and `watchCmd` so both subcommands
 * honor the same selection semantics (cwd / `--all` / `--filter` /
 * `--affected` / anchored positionals).
 *
 * Returns either the resolved options or an error message string. The
 * caller is responsible for prefixing the message with its subcommand
 * name (`vx run: <msg>` / `vx watch: <msg>`) and exiting non-zero.
 *
 * Assumes the caller has already populated `parsed.tasks` (e.g. via
 * the interactive picker for `vx run`).
 */
export async function resolveRunOptions(
  parsed: RunArgs,
  cwd: string,
  tasks: readonly string[],
): Promise<RunOptions | { error: string }> {
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
  let projects: string[] | undefined
  if (bareTasks.length === 0) {
    projects = undefined
  } else if (filterStrings.length > 0) {
    const resolved = await resolveFilters(cwd, filterStrings)
    if (resolved.error) return { error: resolved.error }
    projects = resolved.names
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
    noCache: parsed.noCache,
    ...(parsed.frozen ? { frozen: true } : {}),
    ...(parsed.outputLogs !== undefined ? { outputLogs: parsed.outputLogs } : {}),
    forwardArgs: parsed.forwardArgs,
  }
  if (parsed.excludeDependencies === 'all') {
    opts.excludeDependencies = 'all'
  } else if (parsed.excludeDependencies.length > 0) {
    opts.excludeDependencies = parsed.excludeDependencies
  }
  if (projects !== undefined) opts.projects = projects
  if (parsed.concurrency !== undefined) opts.concurrency = parsed.concurrency
  if (parsed.summarize !== undefined) opts.summarize = parsed.summarize
  if (parsed.profile !== undefined) opts.profile = parsed.profile

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
    const picked = await pickTask(cwd)
    if (!picked) return 1
    tasks = [`${picked.project}#${picked.task}`]
  }

  const resolved = await resolveRunOptions(parsed, cwd, tasks)
  if ('error' in resolved) {
    process.stderr.write(`vx run: ${resolved.error}\n`)
    return 1
  }
  const opts = resolved

  // Planning paths short-circuit execution. Both build the full task
  // graph + probe the cache; the difference is just the formatter.
  if (parsed.dry !== undefined || parsed.graph !== undefined) {
    const plan = await planRun(opts)
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

  const summary = await runOrchestrator(opts)
  if (parsed.verbosity > 0) printSummary(summary)
  return summary.ok ? 0 : 1
}

async function loadWorkspaceProjects(cwd: string): Promise<ProjectMeta[]> {
  const root = await findWorkspaceRoot(cwd)
  const ws = await loadWorkspace(root)
  return await listProjects(ws)
}

async function findCwdProject(cwd: string): Promise<string | null> {
  const projects = await loadWorkspaceProjects(cwd)
  const abs = path.resolve(cwd)
  let best: ProjectMeta | null = null
  for (const p of projects) {
    if (abs === p.dir || abs.startsWith(p.dir + path.sep)) {
      if (!best || p.dir.length > best.dir.length) best = p
    }
  }
  return best?.name ?? null
}

async function resolveFilters(
  cwd: string,
  raw: string[],
): Promise<{ names?: string[]; error?: string }> {
  const root = await findWorkspaceRoot(cwd)
  const projects = await loadWorkspaceProjects(cwd)
  const graph = buildPackageGraph(projects)
  const parsed = raw.map((r) => parseFilter(r, root))

  // Resolve every `[<since>]` filter against git before the pure
  // applyFilters pass runs. One spawn per distinct ref — usually
  // there's only one anyway.
  const affectedByFilter = new Map<(typeof parsed)[number], Set<string>>()
  for (const f of parsed) {
    if (f.gitSince === undefined) continue
    try {
      const names = await affectedProjects({ workspaceRoot: root, since: f.gitSince, projects })
      affectedByFilter.set(f, names)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { error: msg }
    }
  }

  const selected = applyFilters({ filters: parsed, projects, graph, affectedByFilter })
  if (selected.size === 0) {
    return { error: `no projects matched filter(s): ${raw.join(', ')}` }
  }
  return { names: [...selected].sort() }
}

interface PickedTask {
  project: string
  task: string
  description?: string
}

export async function pickTask(
  cwd: string,
  io: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {},
): Promise<PickedTask | null> {
  const projects = await loadWorkspaceProjects(cwd)
  const entries: PickedTask[] = []
  for (const meta of projects) {
    if (!meta.configPath) continue
    const config = await loadProjectConfig(meta.configPath)
    const taskNames = Object.keys(config.tasks ?? {}).sort()
    for (const t of taskNames) {
      const desc = config.tasks?.[t]?.description
      entries.push({ project: meta.name, task: t, ...(desc ? { description: desc } : {}) })
    }
  }
  if (entries.length === 0) {
    process.stderr.write(`vx run: no tasks declared in any project\n`)
    return null
  }
  const out = io.output ?? process.stdout
  const numW = String(entries.length).length
  const idW = Math.max(...entries.map((e) => `${e.project}#${e.task}`.length))
  out.write('Tasks:\n')
  entries.forEach((e, i) => {
    const n = String(i + 1).padStart(numW, ' ')
    const id = `${e.project}#${e.task}`.padEnd(idW)
    const desc = e.description ? `  ${e.description}` : ''
    out.write(`  ${n}. ${id}${desc}\n`)
  })
  const rl = readline.createInterface({
    input: io.input ?? process.stdin,
    output: io.output ?? process.stdout,
  })
  try {
    const answer = (await rl.question(`Pick a task [1-${entries.length}]: `)).trim()
    const n = Number(answer)
    if (!Number.isInteger(n) || n < 1 || n > entries.length) {
      process.stderr.write(`vx run: invalid selection: ${answer}\n`)
      return null
    }
    return entries[n - 1] ?? null
  } finally {
    rl.close()
  }
}

function printSummary(summary: RunSummary): void {
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

function formatRow(o: TaskOutcome): { task: string; status: string; duration: string } {
  const status =
    o.status === 'cache-hit'
      ? 'cache'
      : o.status === 'cache-hit-remote'
        ? 'remote'
        : o.status === 'success'
          ? 'ok'
          : o.status === 'failed'
            ? `fail(${o.exitCode})`
            : o.status
  return {
    task: o.node.id,
    status,
    duration: `${o.durationMs}ms`,
  }
}
