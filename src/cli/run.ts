import readline from 'node:readline/promises'
import path from 'node:path'
import { applyFilters, parseFilter } from '../workspace/filter.js'
import {
  run as runOrchestrator,
  planRun,
  type RunOptions,
  type RunSummary,
} from '../orchestrator.js'
import { formatGraphDot, formatPlanJson, formatPlanText } from '../orchestrator/plan-format.js'
import { buildPackageGraph } from '../workspace/package-graph.js'
import { loadProjectConfig } from '../workspace/project-loader.js'
import {
  findWorkspaceRoot,
  listProjects,
  loadWorkspace,
  type ProjectMeta,
} from '../workspace/workspace.js'
import type { TaskOutcome } from '../graph/scheduler.js'

export interface RunArgs {
  task: string | undefined
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
  forwardArgs: string[]
  verbosity: number
  dry: 'text' | 'json' | undefined
  graph: string | undefined
  summarize: string | undefined
  profile: string | undefined
  error?: string
}

export function parseRunArgs(args: readonly string[]): RunArgs {
  const out: RunArgs = {
    task: undefined,
    filters: [],
    all: false,
    excludeDependencies: [],
    concurrency: undefined,
    noCache: false,
    forwardArgs: [],
    verbosity: 0,
    dry: undefined,
    graph: undefined,
    summarize: undefined,
    profile: undefined,
  }

  const sepIdx = args.indexOf('--')
  const before = sepIdx === -1 ? args : args.slice(0, sepIdx)
  out.forwardArgs = sepIdx === -1 ? [] : args.slice(sepIdx + 1).map(String)

  for (let i = 0; i < before.length; i++) {
    const a = before[i]
    if (a === '--filter' || a === '-F') {
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
    } else if (a === '--no-cache' || a === '--force') {
      out.noCache = true
    } else if (a === '--cache') {
      // No-op: parity with vite-task. Caching is governed by the task's `cache`
      // block in config; this flag is symmetric with --no-cache.
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
    } else if (a !== undefined && a.startsWith('-')) {
      return { ...out, error: `unknown flag: ${a}` }
    } else if (a !== undefined) {
      if (out.task !== undefined) {
        return { ...out, error: `unexpected positional: ${a}` }
      }
      out.task = a
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

export async function runCmd(args: readonly string[]): Promise<number> {
  const parsed = parseRunArgs(args)
  if (parsed.error) {
    process.stderr.write(`vx run: ${parsed.error}\n`)
    return 1
  }

  let taskName: string | undefined
  let pkgAnchor: string | undefined

  if (parsed.task !== undefined) {
    const hashIdx = parsed.task.indexOf('#')
    if (hashIdx >= 0) {
      pkgAnchor = parsed.task.slice(0, hashIdx)
      taskName = parsed.task.slice(hashIdx + 1)
      if (!pkgAnchor || !taskName) {
        process.stderr.write(`vx run: invalid pkg#task: ${parsed.task}\n`)
        return 1
      }
    } else {
      taskName = parsed.task
    }
  }

  const cwd = process.cwd()

  if (!taskName) {
    if (!process.stdin.isTTY) {
      process.stderr.write(`vx run: missing task name (stdin is not a TTY)\n`)
      return 1
    }
    const picked = await pickTask(cwd)
    if (!picked) return 1
    pkgAnchor = picked.project
    taskName = picked.task
  }

  let projects: string[] | undefined
  if (pkgAnchor) {
    projects = [pkgAnchor]
  } else if (parsed.filters.length > 0) {
    const resolved = await resolveFilters(cwd, parsed.filters)
    if (resolved.error) {
      process.stderr.write(`vx run: ${resolved.error}\n`)
      return 1
    }
    projects = resolved.names
  } else if (parsed.all) {
    projects = undefined
  } else {
    const cwdProject = await findCwdProject(cwd)
    if (!cwdProject) {
      process.stderr.write(
        `vx run: not inside a project. Pass --all for every project, -F <pattern> to filter, or run from within a project directory.\n`,
      )
      return 1
    }
    projects = [cwdProject]
  }

  const opts: RunOptions = {
    cwd,
    task: taskName,
    noCache: parsed.noCache,
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

  // Planning paths short-circuit execution. Both build the full task
  // graph + probe the cache; the difference is just the formatter.
  if (parsed.dry !== undefined || parsed.graph !== undefined) {
    const plan = await planRun(opts)
    if (plan.tasks.length === 0) {
      process.stderr.write(`vx run: no projects declare task "${taskName}".\n`)
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
  const selected = applyFilters({ filters: parsed, projects, graph })
  if (selected.size === 0) {
    return { error: `no projects matched filter(s): ${raw.join(', ')}` }
  }
  return { names: [...selected].sort() }
}

interface PickedTask {
  project: string
  task: string
}

async function pickTask(cwd: string): Promise<PickedTask | null> {
  const projects = await loadWorkspaceProjects(cwd)
  const entries: PickedTask[] = []
  for (const meta of projects) {
    if (!meta.configPath) continue
    const config = await loadProjectConfig(meta.configPath)
    const taskNames = Object.keys(config.tasks ?? {}).sort()
    for (const t of taskNames) entries.push({ project: meta.name, task: t })
  }
  if (entries.length === 0) {
    process.stderr.write(`vx run: no tasks declared in any project\n`)
    return null
  }
  const width = String(entries.length).length
  process.stdout.write('Tasks:\n')
  entries.forEach((e, i) => {
    const n = String(i + 1).padStart(width, ' ')
    process.stdout.write(`  ${n}. ${e.project}#${e.task}\n`)
  })
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
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
