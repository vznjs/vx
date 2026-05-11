import type { ProjectConfig, TaskConfig } from './config.js'
import type { PackageGraph } from './package-graph.js'

export interface TaskNode {
  /** Stable id: `${projectName}#${taskName}`. */
  id: string
  projectName: string
  projectDir: string
  taskName: string
  config: TaskConfig
  /** Ids of tasks that must complete before this one runs. */
  deps: string[]
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
  /** Skip `dependsOn` expansion; only the requested nodes are added. */
  ignoreDependsOn?: boolean
}

export function buildTaskGraph(options: BuildGraphOptions): Map<string, TaskNode> {
  const { projects, packageGraph, requested, ignoreDependsOn = false } = options
  const nodes = new Map<string, TaskNode>()

  function addNode(projectName: string, taskName: string): TaskNode | null {
    const id = taskId(projectName, taskName)
    const existing = nodes.get(id)
    if (existing) return existing

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
    }
    nodes.set(id, node)

    if (ignoreDependsOn) {
      return node
    }

    const dependsOn = taskConfig.dependsOn ?? {}

    // Same-project tasks. Missing target is a hard error.
    for (const t of dependsOn.self ?? []) {
      const child = addNode(projectName, t)
      if (!child) {
        throw new Error(
          `Task ${id} depends on ${taskId(projectName, t)} but no such task is declared`,
        )
      }
      node.deps.push(child.id)
    }

    // For each transitive workspace dep, look for the named task. Missing
    // tasks are silently skipped — not every dep needs to participate.
    if ((dependsOn.dependencies ?? []).length > 0) {
      const workspaceDeps = packageGraph.transitiveDeps(projectName)
      for (const t of dependsOn.dependencies ?? []) {
        for (const target of workspaceDeps) {
          const child = addNode(target, t)
          if (child) node.deps.push(child.id)
        }
      }
    }

    // Stable ordering for deterministic scheduling and cache keys.
    node.deps.sort()
    return node
  }

  for (const { project, task } of requested) {
    addNode(project, task)
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
      throw new Error(`Cycle detected in task graph: ${cycle}`)
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
