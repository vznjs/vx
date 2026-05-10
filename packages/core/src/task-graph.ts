import type { ProjectConfig, TaskConfig, TaskDependency } from '@nxt/config'
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
}

export function buildTaskGraph(options: BuildGraphOptions): Map<string, TaskNode> {
  const { projects, packageGraph, requested } = options
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

    for (const dep of taskConfig.dependsOn ?? []) {
      const targets = resolveDependencyTargets(projectName, dep, packageGraph)
      for (const target of targets) {
        const child = addNode(target, dep.task)
        if (child) {
          node.deps.push(child.id)
        } else if (target === projectName) {
          // Same-project dependency that doesn't exist is a hard error.
          throw new Error(
            `Task ${id} depends on ${taskId(target, dep.task)} but no such task is declared`,
          )
        }
        // Cross-project dependency missing is silently skipped: not every
        // dependency needs to participate in every task.
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

function resolveDependencyTargets(
  fromProject: string,
  dep: TaskDependency,
  packageGraph: PackageGraph,
): string[] {
  const patterns = dep.dependencies ?? []
  if (patterns.length === 0) return [fromProject]

  const candidates = packageGraph.transitiveDeps(fromProject)
  const candidateSet = new Set(candidates)
  const selected = new Set<string>()
  for (const p of patterns) {
    if (p === '*') {
      for (const c of candidates) selected.add(c)
    } else if (p.startsWith('!')) {
      selected.delete(p.slice(1))
    } else if (candidateSet.has(p)) {
      selected.add(p)
    }
    // Literal name not in transitive deps: silently skipped (consistent
    // with how cross-project missing tasks are handled below).
  }
  return [...selected]
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
