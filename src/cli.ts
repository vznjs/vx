import readline from 'node:readline/promises'
import path from 'node:path'
import { VERSION } from './index.js'
import { Cache, type CacheStats } from './cache.js'
import { applyFilters, parseFilter } from './filter.js'
import { run as runOrchestrator, type RunOptions, type RunSummary } from './orchestrator.js'
import { buildPackageGraph } from './package-graph.js'
import { loadProjectConfig } from './project-loader.js'
import { findWorkspaceRoot, listProjects, loadWorkspace, type ProjectMeta } from './workspace.js'
import type { TaskOutcome } from './scheduler.js'

export async function run(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv

  switch (command) {
    case undefined:
    case '--help':
    case '-h':
    case 'help':
      printHelp()
      return 0
    case '--version':
    case '-V':
    case 'version':
      process.stdout.write(`vzn ${VERSION}\n`)
      return 0
    case 'run':
      return await runCmd(rest)
    case 'stats':
      return await statsCmd()
    default:
      process.stderr.write(`vzn: unknown command: ${command}\n`)
      printHelp()
      return 1
  }
}

async function runCmd(args: readonly string[]): Promise<number> {
  const parsed = parseRunArgs(args)
  if (parsed.error) {
    process.stderr.write(`vzn run: ${parsed.error}\n`)
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
        process.stderr.write(`vzn run: invalid pkg#task: ${parsed.task}\n`)
        return 1
      }
    } else {
      taskName = parsed.task
    }
  }

  const cwd = process.cwd()

  if (!taskName) {
    if (!process.stdin.isTTY) {
      process.stderr.write(`vzn run: missing task name (stdin is not a TTY)\n`)
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
      process.stderr.write(`vzn run: ${resolved.error}\n`)
      return 1
    }
    projects = resolved.names
  } else if (parsed.recursive) {
    projects = undefined
  } else {
    const cwdProject = await findCwdProject(cwd)
    if (!cwdProject) {
      process.stderr.write(
        `vzn run: not inside a project. Pass -r for all packages, -F <pattern> to filter, or run from within a project directory.\n`,
      )
      return 1
    }
    projects = [cwdProject]
  }

  const opts: RunOptions = {
    cwd,
    task: taskName,
    noCache: parsed.noCache,
    ignoreDependsOn: parsed.ignoreDependsOn,
    forwardArgs: parsed.forwardArgs,
  }
  if (projects !== undefined) opts.projects = projects
  if (parsed.concurrency !== undefined) opts.concurrency = parsed.concurrency

  const summary = await runOrchestrator(opts)
  if (parsed.verbose) printSummary(summary)
  return summary.ok ? 0 : 1
}

export interface RunArgs {
  task: string | undefined
  filters: string[]
  recursive: boolean
  ignoreDependsOn: boolean
  concurrency: number | undefined
  noCache: boolean
  forwardArgs: string[]
  verbose: boolean
  error?: string
}

export function parseRunArgs(args: readonly string[]): RunArgs {
  const out: RunArgs = {
    task: undefined,
    filters: [],
    recursive: false,
    ignoreDependsOn: false,
    concurrency: undefined,
    noCache: false,
    forwardArgs: [],
    verbose: false,
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
    } else if (a === '--concurrency' || a === '-c') {
      const v = before[++i]
      if (v === undefined) return { ...out, error: `${a} requires a value` }
      const n = Number(v)
      if (!Number.isFinite(n) || n < 1) return { ...out, error: `invalid concurrency: ${v}` }
      out.concurrency = Math.floor(n)
    } else if (a === '--recursive' || a === '-r') {
      out.recursive = true
    } else if (a === '--ignore-depends-on') {
      out.ignoreDependsOn = true
    } else if (a === '--no-cache') {
      out.noCache = true
    } else if (a === '--cache') {
      // No-op: parity with vite-task. Caching is governed by the task's `cache`
      // block in config; this flag is symmetric with --no-cache.
    } else if (a === '--verbose' || a === '-v') {
      out.verbose = true
    } else if (a !== undefined && a.startsWith('-')) {
      return { ...out, error: `unknown flag: ${a}` }
    } else if (a !== undefined) {
      if (out.task !== undefined) {
        return { ...out, error: `unexpected positional: ${a}` }
      }
      out.task = a
    }
  }
  return out
}

async function loadWorkspaceProjects(cwd: string): Promise<ProjectMeta[]> {
  const root = findWorkspaceRoot(cwd)
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
  const root = findWorkspaceRoot(cwd)
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
    const taskNames = Object.keys(config.run?.tasks ?? {}).sort()
    for (const t of taskNames) entries.push({ project: meta.name, task: t })
  }
  if (entries.length === 0) {
    process.stderr.write(`vzn run: no tasks declared in any project\n`)
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
      process.stderr.write(`vzn run: invalid selection: ${answer}\n`)
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

async function statsCmd(): Promise<number> {
  const cwd = process.cwd()
  let root: string
  try {
    root = findWorkspaceRoot(cwd)
  } catch (err) {
    process.stderr.write(`vzn stats: ${(err as Error).message}\n`)
    return 1
  }
  const cache = new Cache(path.join(root, '.vzn', 'cache'))
  try {
    process.stdout.write(formatStats(cache.stats()))
  } finally {
    cache.close()
  }
  return 0
}

export function formatStats(s: CacheStats): string {
  const hitRate =
    s.runCountLast24h > 0 ? `${((s.hitCountLast24h / s.runCountLast24h) * 100).toFixed(1)}%` : 'n/a'
  return [
    'Cache statistics',
    '----------------',
    `Entries:           ${s.entryCount}`,
    `Total size:        ${formatBytes(s.totalBytes)}`,
    `Runs (24h):        ${s.runCountLast24h}`,
    `Hits  (24h):       ${s.hitCountLast24h}  (${hitRate})`,
    '',
  ].join('\n')
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  for (const u of units) {
    if (v < 1024) return `${v.toFixed(v < 10 ? 1 : 0)} ${u}`
    v /= 1024
  }
  return `${v.toFixed(0)} PB`
}

function printHelp(): void {
  process.stdout.write(
    [
      'vzn — open, extensible monorepo task runner',
      '',
      'Usage:',
      '  vzn run [OPTIONS] [TASK | PKG#TASK] [-- forwarded-args...]',
      '  vzn stats',
      '  vzn help',
      '  vzn version',
      '',
      'Selection (for run):',
      '  (default)                Run task in the project containing cwd.',
      '  -r, --recursive          Run task in every project that declares it.',
      '  -F, --filter <pattern>   pnpm-style filter (repeatable). Examples:',
      '                             foo, @scope/*, ./packages/foo, foo..., ...foo,',
      '                             foo^..., !foo',
      "  pkg#task                 Run a specific project's task directly.",
      '',
      'Behavior (for run):',
      '  -c, --concurrency <n>    Max parallel tasks (default: CPU count).',
      '      --ignore-depends-on  Skip dependsOn expansion; run only the requested task(s).',
      '      --no-cache           Skip cache reads AND writes.',
      '      --cache              No-op (parity with vite-task).',
      '  -v, --verbose            Print a detailed summary after the run.',
      '',
      'Argument forwarding (for run):',
      "  Anything after `--` is forwarded (shell-quoted) to the task's exec",
      '  command. The forwarded args are folded into the cache key, so',
      '  different args produce different cache entries.',
      '',
      'Stats:',
      '  vzn stats                Print cache size + last-24h run/hit summary.',
      '',
    ].join('\n'),
  )
}
