import type { LoadedConfig, TaskConfig } from '../config/types.ts'
import { parseDependencySpec } from './dependency-spec.ts'
import type { BuildGraph, TaskNode } from './types.ts'
import { GraphError } from './types.ts'

export const buildGraph: BuildGraph = ({ configs, requested }) => {
  if (requested.length === 0) return { nodes: [], byId: new Map() }

  const byProject = new Map<string, LoadedConfig>()
  for (const c of configs) byProject.set(c.project.name, c)

  const seedIds = expandRequested(requested, configs)
  const visited = materialize(seedIds, byProject)
  detectCycle(visited)
  const ordered = topoSort(visited)

  const byId = new Map<string, TaskNode>()
  for (const node of ordered) byId.set(node.id, node)
  return { nodes: ordered, byId }
}

function expandRequested(
  requested: readonly string[],
  configs: readonly LoadedConfig[],
): readonly string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const req of requested) {
    const matches = matchRequested(req, configs)
    for (const id of matches) {
      if (seen.has(id)) continue
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

function matchRequested(req: string, configs: readonly LoadedConfig[]): readonly string[] {
  if (req.includes('#')) {
    const hashIdx = req.indexOf('#')
    const proj = req.slice(0, hashIdx)
    const task = req.slice(hashIdx + 1)
    if (!proj || !task) throw new GraphError(`invalid requested task "${req}"`)
    const cfg = configs.find((c) => c.project.name === proj)
    if (!cfg) throw new GraphError(`no project named "${proj}"`)
    if (!cfg.config.tasks?.[task]) {
      throw new GraphError(`project "${proj}" has no task "${task}"`)
    }
    return [`${proj}#${task}`]
  }

  const matches: string[] = []
  for (const c of configs) {
    if (c.config.tasks?.[req]) matches.push(`${c.project.name}#${req}`)
  }
  if (matches.length === 0) {
    throw new GraphError(`no project declares task "${req}"`)
  }
  return matches
}

function materialize(
  seedIds: readonly string[],
  byProject: ReadonlyMap<string, LoadedConfig>,
): Map<string, TaskNode> {
  const visited = new Map<string, TaskNode>()
  const queue: string[] = [...seedIds]

  while (queue.length > 0) {
    const id = queue.shift()!
    if (visited.has(id)) continue

    const hashIdx = id.indexOf('#')
    const proj = id.slice(0, hashIdx)
    const task = id.slice(hashIdx + 1)

    const cfg = byProject.get(proj)
    if (!cfg) throw new GraphError(`unknown project "${proj}" (id "${id}")`)
    const taskCfg = cfg.config.tasks?.[task]
    if (!taskCfg) throw new GraphError(`project "${proj}" has no task "${task}"`)

    const dependencies = resolveDeps(proj, task, taskCfg, byProject)
    visited.set(id, { id, project: proj, task, config: taskCfg, dependencies })
    for (const dep of dependencies) queue.push(dep)
  }

  return visited
}

function resolveDeps(
  proj: string,
  task: string,
  taskCfg: TaskConfig,
  byProject: ReadonlyMap<string, LoadedConfig>,
): readonly string[] {
  const out: string[] = []
  const seen = new Set<string>()

  for (const raw of taskCfg.dependsOn ?? []) {
    const spec = parseDependencySpec(raw)
    const taskRef = `task "${proj}#${task}" dependsOn "${raw}"`

    if (spec.negated) {
      throw new GraphError(`${taskRef}: negation is filter-only, not valid as a dependency`)
    }

    let depId: string
    switch (spec.kind) {
      case 'self': {
        const depCfg = byProject.get(proj)
        if (!depCfg?.config.tasks?.[spec.task]) {
          throw new GraphError(`${taskRef}: project "${proj}" has no task "${spec.task}" (missing)`)
        }
        depId = `${proj}#${spec.task}`
        break
      }
      case 'cross': {
        const depCfg = byProject.get(spec.project)
        if (!depCfg) {
          throw new GraphError(`${taskRef}: no project named "${spec.project}" (nonexistent)`)
        }
        if (!depCfg.config.tasks?.[spec.task]) {
          throw new GraphError(
            `${taskRef}: project "${spec.project}" has no task "${spec.task}" (missing)`,
          )
        }
        depId = `${spec.project}#${spec.task}`
        break
      }
      case 'deps':
        throw new GraphError(
          `${taskRef}: "^name" deps require the package-graph module (not yet shipped)`,
        )
      case 'wildcardSelf':
      case 'wildcardDeps':
        throw new GraphError(`${taskRef}: wildcards are filter-only, not valid as a dependency`)
    }

    if (seen.has(depId)) continue
    seen.add(depId)
    out.push(depId)
  }
  return out
}

type Color = 0 | 1 | 2 // white | gray | black

function detectCycle(visited: ReadonlyMap<string, TaskNode>): void {
  const color = new Map<string, Color>()
  for (const id of visited.keys()) color.set(id, 0)

  for (const start of visited.keys()) {
    if (color.get(start) !== 0) continue

    const stack: { id: string; depIdx: number }[] = [{ id: start, depIdx: 0 }]
    color.set(start, 1)

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!
      const node = visited.get(frame.id)!
      if (frame.depIdx >= node.dependencies.length) {
        color.set(frame.id, 2)
        stack.pop()
        continue
      }
      const dep = node.dependencies[frame.depIdx]!
      frame.depIdx += 1
      const depColor = color.get(dep) ?? 0
      if (depColor === 1) {
        const path = stack.map((f) => f.id)
        const cycleStart = path.indexOf(dep)
        const slice = cycleStart >= 0 ? path.slice(cycleStart) : path
        throw new GraphError(`cycle detected: ${[...slice, dep].join(' -> ')}`)
      }
      if (depColor === 0) {
        color.set(dep, 1)
        stack.push({ id: dep, depIdx: 0 })
      }
    }
  }
}

function topoSort(visited: ReadonlyMap<string, TaskNode>): readonly TaskNode[] {
  const inDegree = new Map<string, number>()
  const outgoing = new Map<string, string[]>()
  for (const id of visited.keys()) {
    inDegree.set(id, 0)
    outgoing.set(id, [])
  }
  for (const node of visited.values()) {
    for (const dep of node.dependencies) {
      inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1)
      const arr = outgoing.get(dep)
      if (arr) arr.push(node.id)
    }
  }

  const ready: string[] = []
  for (const [id, deg] of inDegree) {
    if (deg === 0) ready.push(id)
  }
  ready.sort()

  const out: TaskNode[] = []
  while (ready.length > 0) {
    const id = ready.shift()!
    out.push(visited.get(id)!)
    for (const next of outgoing.get(id) ?? []) {
      const newDeg = (inDegree.get(next) ?? 0) - 1
      inDegree.set(next, newDeg)
      if (newDeg === 0) insertSorted(ready, next)
    }
  }

  if (out.length !== visited.size) {
    throw new GraphError('cycle detected in residual graph')
  }
  return out
}

function insertSorted(arr: string[], value: string): void {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (arr[mid]! < value) lo = mid + 1
    else hi = mid
  }
  arr.splice(lo, 0, value)
}
