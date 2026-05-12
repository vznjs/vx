import readline from 'node:readline/promises'
import path from 'node:path'
import { applyFilters, parseFilter } from '../workspace/filter.js'
import { run as runOrchestrator, type RunOptions, type RunSummary } from '../orchestrator.js'
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
  } else if (parsed.recursive) {
    projects = undefined
  } else {
    const cwdProject = await findCwdProject(cwd)
    if (!cwdProject) {
      process.stderr.write(
        `vx run: not inside a project. Pass -r for all packages, -F <pattern> to filter, or run from within a project directory.\n`,
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
