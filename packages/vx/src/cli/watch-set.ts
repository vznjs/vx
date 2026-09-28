// What `vx watch` watches: the projects a cycle can run, what their configs
// declare (outputs to ignore, inputs, workspace-wide globs) and the member
// directories a package glob can grow. Read at start and again whenever an
// edit reshapes the set; the loop in watch.ts decides when.

import fs from 'node:fs'
import path from 'node:path'
import type { ProjectConfig } from '../config.js'
import {
  buildPackageGraph,
  configImports,
  loadProjectConfig,
  WORKSPACE_CONFIG_FILENAMES,
  type ProjectEntry,
  type ProjectMeta,
} from '../workspace/index.js'
import { taskEdges, taskEdgesFrom } from './select.js'
import { type CliLoadOptions, loadCliProjects } from './workspace-config.js'

/**
 * The projects a cycle can run, so both watcher arms cover the same dirs:
 * the scope plus its transitive dependencies through the package graph
 * and the cross-project `dependsOn` edges the task graph adds
 * (`e2e` → `app` from `dependsOn: ['app#build']`). Before this, the
 * per-project arm watched the filter's answer only, so
 * `vx watch build --filter app` never re-ran on a `lib` edit that
 * `vx run build --filter app` would have rebuilt. A whole-workspace
 * scope is every project already and walks nothing. A config the loader
 * rejects contributes no edges here; the run that just happened said so.
 */
export async function watchedProjects(
  workspaceRoot: string,
  allProjects: readonly ProjectMeta[],
  scope: readonly ProjectMeta[],
  load: CliLoadOptions = {},
  staged: ReadonlyMap<string, ProjectEntry> | null = null,
): Promise<ProjectMeta[]> {
  if (scope.length === allProjects.length) return [...allProjects]
  let edges: Map<string, string[]> | undefined
  try {
    edges =
      staged !== null
        ? taskEdgesFrom(staged)
        : (await taskEdges(workspaceRoot, allProjects, load)).edges
  } catch {
    edges = undefined
  }
  const graph = buildPackageGraph([...allProjects], edges)
  const names = new Set(scope.map((p) => p.name))
  for (const p of scope) for (const d of graph.transitiveDeps(p.name)) names.add(d)
  return allProjects.filter((p) => names.has(p.name))
}

/** What one sweep over every config tells the loop. */
export interface ConfigSweep {
  workspaceWide: boolean
  workspaceInputs: string[]
  outputs: Map<string, string[]>
  /**
   * Each task's input globs per directory they are relative to, the
   * counterweight to `outputs`; the task's own outputs ride along as `!`
   * entries, as its key leaves them out.
   */
  inputs: Map<string, string[][]>
  /** Projects with a task that has a command and no cache: it reads what it likes, git-ignored files included. */
  uncached: Set<string>
  /** Files the project configs import by relative path (item 949). */
  configImports: string[]
  /** Files the workspace config imports by relative path: loaded once per process (item 949). */
  workspaceConfigImports: string[]
  /** The staged load the sweep read, when the run path's load succeeded; `watchedProjects` reads the same one. */
  staged: Map<string, ProjectEntry> | null
}

/**
 * One sweep over every config for the two things the loop needs: whether
 * any task declares `inputs.workspaceFiles` — globs with no project
 * prefix, so the whole tree has to be watched — and every project's
 * declared outputs, so their writes are not taken for edits. The run
 * path's load (`loadProjects`): the plugin `project` stage applies, so an
 * output a plugin gave a config-less package is ignored like a declared
 * one, and a pure config is served from its cached evaluation rather than
 * re-evaluated in a worker. A config that fails to load is out of this
 * concern's scope — the run that just happened already said so, or will —
 * and the sweep falls back to the files that do load, one by one.
 */
export async function sweepConfigs(
  projects: readonly ProjectMeta[],
  workspaceRoot: string,
  load: CliLoadOptions = {},
  tasks?: readonly string[],
): Promise<ConfigSweep> {
  const outputs = new Map<string, string[]>()
  const inputs = new Map<string, string[][]>()
  // One task's inputs, less what it writes itself: the key leaves a task's
  // own outputs out of its inputs, so a turbo() task reading `**/*` does not
  // read the `dist/` it builds, and its write is no edit to watch.
  const addInputs = (
    dir: string,
    files: readonly string[] | undefined,
    own: readonly string[] | undefined,
  ): void => {
    if (files === undefined || files.length === 0) return
    const minus = (own ?? []).filter((o) => !o.startsWith('!')).map((o) => `!${o}`)
    inputs.set(dir, [...(inputs.get(dir) ?? []), [...files, ...minus]])
  }
  const addTo = (
    into: Map<string, string[]>,
    dir: string,
    globs: readonly string[] | undefined,
  ): void => {
    if (globs === undefined || globs.length === 0) return
    into.set(dir, [...(into.get(dir) ?? []), ...globs])
  }
  const add = (dir: string, globs: readonly string[] | undefined): void =>
    addTo(outputs, dir, globs)
  const workspaceInputs = new Set<string>()
  const uncached = new Set<string>()
  const folded: [string, ProjectConfig][] = []
  const fold = (dir: string, config: ProjectConfig): void => {
    folded.push([dir, config])
  }
  // Only the tasks the run can reach are judged: `vx watch build` over a
  // turbo() package whose `lint` reads `**/*` took build's own `dist/`
  // write for lint's input, and re-ran build.
  const foldAll = (): void => {
    const names = tasks === undefined ? null : reachableNames(folded, tasks)
    for (const [dir, config] of folded) foldTasks(dir, config, names)
  }
  const foldTasks = (dir: string, config: ProjectConfig, names: Set<string> | null): void => {
    for (const [name, task] of Object.entries(config.tasks ?? {})) {
      add(dir, task.cache?.outputs?.files)
      add(workspaceRoot, task.cache?.outputs?.workspaceFiles)
      if (names !== null && !names.has(name)) continue
      if (task.cache === undefined && task.exec !== undefined && task.exec.persistent === undefined)
        uncached.add(dir)
      for (const g of task.cache?.inputs?.workspaceFiles ?? []) workspaceInputs.add(g)
      addInputs(dir, task.cache?.inputs?.files, task.cache?.outputs?.files)
      addInputs(
        workspaceRoot,
        task.cache?.inputs?.workspaceFiles,
        task.cache?.outputs?.workspaceFiles,
      )
    }
  }
  const result = (staged: Map<string, ProjectEntry> | null): ConfigSweep => ({
    workspaceWide: workspaceInputs.size > 0,
    workspaceInputs: [...workspaceInputs],
    outputs,
    inputs,
    uncached,
    configImports: [...projectImports],
    workspaceConfigImports: [...wsImports],
    staged,
  })
  const projectImports = new Set<string>()
  const wsImports = new Set<string>()
  await Promise.all([
    ...projects.map(async (p) => {
      if (p.configPath === null) return
      for (const f of await configImports(p.configPath)) projectImports.add(f)
    }),
    ...WORKSPACE_CONFIG_FILENAMES.map(async (name) => {
      for (const f of await configImports(path.join(workspaceRoot, name))) wsImports.add(f)
    }),
  ])
  let staged: Map<string, ProjectEntry> | null = null
  try {
    staged = await loadCliProjects(workspaceRoot, projects, 'all', load)
  } catch {
    staged = null
  }
  if (staged !== null) {
    for (const p of staged.values()) fold(p.dir, p.config)
    foldAll()
    return result(staged)
  }
  await Promise.all(
    projects.map(async (p) => {
      if (p.configPath === null) return
      try {
        fold(p.dir, await loadProjectConfig(p.configPath))
      } catch {
        // broken config — out of this concern's scope
      }
    }),
  )
  foldAll()
  return result(null)
}

/**
 * The task names a run of `requested` reaches through `dependsOn`, by name
 * in any project: a superset of the graph's tasks, so a file is never
 * dropped that one of them reads. Null when a name pattern (`build.*`)
 * makes the set unknowable without the graph: every task then counts.
 */
function reachableNames(
  configs: ReadonlyArray<readonly [string, ProjectConfig]>,
  requested: readonly string[],
): Set<string> | null {
  const name = (spec: string): string => spec.slice(spec.indexOf('#') + 1).replace(/^\^/, '')
  const names = new Set(requested.map(name))
  for (let grew = true; grew;) {
    grew = false
    for (const [, config] of configs) {
      for (const [task, def] of Object.entries(config.tasks ?? {})) {
        if (!names.has(task)) continue
        for (const dep of def.dependsOn ?? []) {
          const n = name(dep)
          if (!names.has(n)) {
            names.add(n)
            grew = true
          }
        }
      }
    }
  }
  return [...names].some((n) => n.includes('*')) ? null : names
}

/**
 * The directory entries under a package glob's directory that can be
 * members: directories (or links) whose name is not dotted and not
 * `node_modules`, the same rule discovery applies. A watcher on that
 * directory reacts only when this set changes.
 */
export function memberEntries(base: string): ReadonlySet<string> {
  const out = new Set<string>()
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(base, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    if (e.isDirectory() || e.isSymbolicLink()) out.add(e.name)
  }
  return out
}

export function sameMembers(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const name of a) if (!b.has(name)) return false
  return true
}
