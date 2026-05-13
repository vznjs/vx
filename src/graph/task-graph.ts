import type { ProjectConfig, TaskConfig } from '../config.js'
import { UserError } from '../util/errors.js'
import type { PackageGraph } from '../workspace/package-graph.js'
import { DependencySpecError, parseDependencySpec, type DependencySpec } from './dependency-spec.js'

export interface TaskNode {
  /** Stable id: `${projectName}#${taskName}`. */
  id: string
  projectName: string
  projectDir: string
  taskName: string
  config: TaskConfig
  /** Ids of tasks that must complete before this one runs. */
  deps: string[]
  /**
   * True for the tasks the user actually asked for (via cwd, `-r`, `-F`,
   * or `pkg#task`). False for dependencies pulled in by `dependsOn`
   * expansion. Used by the orchestrator to scope `forwardArgs` so trailing
   * CLI args don't leak into upstream tasks the user didn't address.
   */
  requested: boolean
}

export interface ProjectEntry {
  name: string
  dir: string
  config: ProjectConfig
}

export function taskId(project: string, task: string): string {
  return `${project}#${task}`
}

export interface BuildGraphOptions {
  projects: Map<string, ProjectEntry>
  packageGraph: PackageGraph
  /** Initial set: `{ project, task }` pairs the user asked to run. */
  requested: Array<{ project: string; task: string }>
  /**
   * Filter `dependsOn` expansion.
   *   - `undefined` → every dependsOn entry is followed (default).
   *   - `'all'`     → no expansion; only the requested nodes are added.
   *   - `string[]`  → expand normally, but drop edges whose target
   *                   task name is in the list. `dependsOn.self` and
   *                   `dependsOn.dependencies` are both filtered.
   */
  excludeDependencies?: 'all' | readonly string[]
}

export function buildTaskGraph(options: BuildGraphOptions): Map<string, TaskNode> {
  const { projects, packageGraph, requested, excludeDependencies } = options
  const skipAll = excludeDependencies === 'all'
  const skipNames =
    Array.isArray(excludeDependencies) && excludeDependencies.length > 0
      ? new Set(excludeDependencies)
      : null
  const nodes = new Map<string, TaskNode>()

  function addNode(projectName: string, taskName: string, requested: boolean): TaskNode | null {
    const id = taskId(projectName, taskName)
    const existing = nodes.get(id)
    if (existing) {
      // Promote an already-added node to requested if any caller asked
      // for it directly. Once requested, never demoted.
      if (requested) existing.requested = true
      return existing
    }

    const project = projects.get(projectName)
    if (!project) return null
    const taskConfig = project.config.tasks?.[taskName]
    if (!taskConfig) return null

    const node: TaskNode = {
      id,
      projectName,
      projectDir: project.dir,
      taskName,
      config: taskConfig,
      deps: [],
      requested,
    }
    nodes.set(id, node)

    if (skipAll) return node

    const rawSpecs = taskConfig.dependsOn ?? []
    for (const raw of rawSpecs) {
      let spec: DependencySpec
      try {
        spec = parseDependencySpec(raw)
      } catch (err) {
        if (err instanceof DependencySpecError) {
          throw new UserError(`Task ${id}: ${err.message}`)
        }
        throw err
      }

      // dependsOn is about which tasks to ADD to the graph, not which
      // to filter. Wildcards and negation aren't meaningful here —
      // they're cache.inputs.tasks operations.
      if (spec.kind === 'wildcardSelf' || spec.kind === 'wildcardDeps') {
        throw new UserError(`Task ${id}: dependsOn does not accept wildcards (got "${raw}")`)
      }
      if (spec.negated) {
        throw new UserError(`Task ${id}: dependsOn does not accept negation (got "${raw}")`)
      }
      // CLI `--excludeDependencies=name1,name2` drops edges whose target
      // task name matches, regardless of bucket (self / deps / cross).
      if (skipNames?.has(spec.task)) continue

      if (spec.kind === 'self') {
        // Missing target is a hard error — the user typed a name that
        // doesn't resolve in this project.
        const child = addNode(projectName, spec.task, false)
        if (!child) {
          throw new UserError(
            `Task ${id} depends on ${taskId(projectName, spec.task)} but no such task is declared`,
          )
        }
        node.deps.push(child.id)
      } else if (spec.kind === 'deps') {
        // For each transitive workspace dep, look for the named task.
        // Missing tasks in particular deps are silently skipped — not
        // every dep needs to participate.
        const workspaceDeps = packageGraph.transitiveDeps(projectName)
        for (const target of workspaceDeps) {
          const child = addNode(target, spec.task, false)
          if (child) node.deps.push(child.id)
        }
      } else {
        // Cross-project edge: pkg#task. Missing target is a hard error
        // because the user named the package + task explicitly.
        const child = addNode(spec.project, spec.task, false)
        if (!child) {
          throw new UserError(
            `Task ${id} depends on ${taskId(spec.project, spec.task)} but no such project or task is declared`,
          )
        }
        node.deps.push(child.id)
      }
    }

    // Stable ordering for deterministic scheduling and cache keys.
    node.deps.sort()
    return node
  }

  for (const { project, task } of requested) {
    addNode(project, task, true)
  }

  detectCycle(nodes)
  return nodes
}

function detectCycle(nodes: Map<string, TaskNode>): void {
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>()
  for (const id of nodes.keys()) color.set(id, WHITE)

  const stack: string[] = []
  function visit(id: string): void {
    const c = color.get(id)
    if (c === BLACK) return
    if (c === GRAY) {
      const cycle = [...stack.slice(stack.indexOf(id)), id].join(' -> ')
      throw new UserError(`Cycle detected in task graph: ${cycle}`)
    }
    color.set(id, GRAY)
    stack.push(id)
    const node = nodes.get(id)
    if (node) {
      for (const d of node.deps) visit(d)
    }
    stack.pop()
    color.set(id, BLACK)
  }

  for (const id of nodes.keys()) visit(id)
}
