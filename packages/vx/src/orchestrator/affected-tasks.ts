// `--affected` per task (2026-10-04). The diff seeds the tasks it
// reaches; a requested task runs when its `dependsOn` closure holds one.
// So a change reaches another project only along a task edge: `web#test`
// behind `^build` runs when `ui#build` (or what it depends on) is reached,
// and a spec edit `ui#build`'s inputs leave out stops at `ui`'s own tasks.

import path from 'node:path'
import type { WorkspaceRules } from '../config.js'
import { declaresInput, workspaceFilesReachInto } from '../cache/index.js'
import {
  buildTaskGraph,
  compileTaskPattern,
  expandRequested,
  isGroupTask,
  isTaskPattern,
  parseDependencySpec,
  type TaskNode,
} from '../graph/index.js'
import {
  type AffectedChanges,
  type PackageGraph,
  PROJECT_CONFIG_FILENAMES,
  type ProjectEntry,
  type ProjectMeta,
} from '../workspace/index.js'
import { applyGraphStage } from './graph-stage.js'
import { hasHook } from './plugin-host.js'
import type { VxPlugin } from './plugin.js'
import { isDefaultBuild } from '../graph/index.js'

/** Every file in this set re-keys each of its project's tasks, whatever their inputs. */
const KEYED_BY_EVERY_TASK: ReadonlySet<string> = new Set(PROJECT_CONFIG_FILENAMES)

/**
 * The projects every task of which the change reaches: the whole ones the
 * diff named, and those holding a changed path no task of theirs
 * declares as an input. vx cannot prove such a path re-keys nothing (a
 * `project` plugin may read it), so it reaches the whole project, as it did
 * before selection was per task.
 */
function wholeProjects(
  changes: AffectedChanges,
  projects: ReadonlyMap<string, ProjectEntry>,
  byKeys: boolean,
): Map<string, string | undefined> {
  // Each whole project, with the path no task claims when one did it.
  const whole = new Map<string, string | undefined>([...changes.whole].map((n) => [n, undefined]))
  for (const [name, rels] of changes.paths) {
    if (whole.has(name)) continue
    const keyed = Object.values(projects.get(name)?.config.tasks ?? {}).filter(
      (t) => t.exec !== undefined && t.inputs !== undefined,
    )
    const links = changes.dirLinksIn?.get(name)
    const unclaimed = (rel: string): boolean =>
      KEYED_BY_EVERY_TASK.has(rel) ||
      (!byKeys && !keyed.some((t) => declaresInput(t, rel, null, links?.has(rel))))
    const rel = rels.find(unclaimed)
    if (rel !== undefined) whole.set(name, rel)
  }
  return whole
}

/**
 * Why `--affected` kept a requested task (`vx run --affected --dry`):
 * `input`, a changed `file` is one of its declared inputs; `project`, its
 * project changed and the task reads it whole (a task with no inputs, a
 * path no task declares, or no single `file`: a lockfile claim, a manifest
 * edge, a config import); `workspace`, a workspace-wide `file` (the
 * workspace config, a root file a plugin claims) reached every task of its
 * project; `package`, a `^` edge passes through `project`, a
 * changed package with no such task; `named`, asked as `pkg#task`;
 * `selected`, another filter selected its project outright. `via` is the
 * `dependsOn` chain, nearest first, to the task the change seeded.
 */
export interface AffectedReason {
  kind: 'input' | 'project' | 'workspace' | 'package' | 'named' | 'selected'
  /** Workspace-relative. */
  file?: string
  project?: string
  via?: string[]
}

/** Collects each kept task's `AffectedReason` when given; a run without one pays nothing. */
export interface AffectedExplain {
  workspaceRoot: string
  reasons: Map<string, AffectedReason>
}

/**
 * The task ids of `ids` whose closure the change reaches, in their order.
 * A group seeds nothing (it runs nothing) unless it is keyed, as the default
 * `build` is; a task with no inputs seeds when a changed path lies in its
 * project (or the whole project is reached); one with inputs when a changed
 * path is one of them. A `^name` edge the
 * graph passes through a package it loaded no config for reaches it as the
 * default `build` would: any change there reaches the task.
 */
export function affectedRoots(
  nodes: ReadonlyMap<string, TaskNode>,
  ids: readonly string[],
  changes: AffectedChanges,
  projects: ReadonlyMap<string, ProjectEntry>,
  packageGraph: PackageGraph,
  explain?: AffectedExplain,
  /** Only what moves a key: a changed path no task declares reaches no task. */
  byKeys = false,
): string[] {
  const whole = wholeProjects(changes, projects, byKeys)
  const seeds = explain === undefined ? null : new Map<string, AffectedReason>()
  const through = explain === undefined ? null : new Map<string, string>()
  const inProject = (name: string, rel: string | undefined): AffectedReason => {
    if (rel === undefined) {
      const file = changes.wholeBy?.get(name)
      return file === undefined ? { kind: 'project' } : { kind: 'workspace', file }
    }
    const dir = path.relative(explain!.workspaceRoot, projects.get(name)!.dir)
    return { kind: 'project', file: dir === '' ? rel : path.posix.join(dir, rel) }
  }
  // The builder's `^name` walk (task-graph.ts), keeping only the packages
  // it passes through: a holder's own node is already in `deps`.
  const passesChanged = (n: TaskNode): boolean => {
    for (const raw of n.config.dependsOn ?? []) {
      const spec = parseDependencySpec(raw, 'dependsOn')
      if (spec.kind !== 'deps' || spec.negated) continue
      const re = isTaskPattern(spec.task) ? compileTaskPattern(spec.task) : null
      const holds = (name: string): boolean => {
        const tasks = Object.keys(projects.get(name)?.config.tasks ?? {})
        return re === null ? tasks.includes(spec.task) : tasks.some((t) => re.test(t))
      }
      const visited = new Set([n.projectName])
      const frontier = [...packageGraph.directDeps(n.projectName)]
      while (frontier.length > 0) {
        const target = frontier.pop()!
        if (visited.has(target)) continue
        visited.add(target)
        if (holds(target)) continue
        if (changes.projects.has(target)) {
          seeds?.set(n.id, { kind: 'package', project: target })
          return true
        }
        frontier.push(...packageGraph.directDeps(target))
      }
    }
    return false
  }
  const seeded = (n: TaskNode): boolean => {
    const task = n.config
    const keyed = task.inputs !== undefined
    // Asked of every node, not only the changed projects' (the
    // `workspaceFiles` owners): a `graph` hook may have given the glob.
    if (keyed) {
      const file = changes.changed.find((rel) =>
        declaresInput(task, null, rel, changes.dirLinks?.has(rel)),
      )
      const dir =
        file === undefined
          ? (changes.nested ?? []).find((d) => workspaceFilesReachInto(task, d))
          : undefined
      if (file !== undefined || dir !== undefined) {
        seeds?.set(n.id, { kind: 'input', file: (file ?? dir)! })
        return true
      }
    }
    if (!changes.projects.has(n.projectName)) return false
    const rels = changes.paths.get(n.projectName) ?? []
    // An unkeyed group runs nothing. A task with no inputs may read anything
    // in its project: a root file another task of it declares
    // (`workspaceFiles`) is no change there.
    if (!keyed) {
      const hit = !isGroupTask(n) && (whole.has(n.projectName) || changes.paths.has(n.projectName))
      if (hit) seeds?.set(n.id, inProject(n.projectName, rels[0]))
      return hit
    }
    if (whole.has(n.projectName)) {
      seeds?.set(n.id, inProject(n.projectName, whole.get(n.projectName)))
      return true
    }
    const links = changes.dirLinksIn?.get(n.projectName)
    const rel = rels.find((r) => declaresInput(task, r, null, links?.has(r)))
    if (rel === undefined) return false
    if (seeds !== null) seeds.set(n.id, { ...inProject(n.projectName, rel), kind: 'input' })
    return true
  }
  const reached = new Map<string, boolean>()
  // Post-order on an explicit stack: a closure is as deep as the graph, and
  // a recursion per edge threw `RangeError` on a chain the builder takes
  // (item 737's 50,000; ~15,000 sufficed here). A frame holds the next dep
  // to ask, -1 before the task itself is.
  const reaches = (root: string): boolean => {
    const stack: Array<[id: string, next: number]> = [[root, -1]]
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!
      const id = frame[0]
      if (frame[1] === -1) {
        if (reached.has(id)) {
          stack.pop()
          continue
        }
        const n = nodes.get(id)
        if (n === undefined || seeded(n) || passesChanged(n)) {
          reached.set(id, n !== undefined)
          stack.pop()
          continue
        }
        frame[1] = 0
      }
      const deps = nodes.get(id)!.deps
      let i = frame[1]
      while (i < deps.length && reached.get(deps[i]!) === false) i++
      frame[1] = i
      if (i === deps.length || reached.get(deps[i]!) === true) {
        reached.set(id, i < deps.length)
        if (i < deps.length) through?.set(id, deps[i]!)
        stack.pop()
        continue
      }
      stack.push([deps[i]!, -1])
    }
    return reached.get(root)!
  }
  const kept = ids.filter(reaches)
  if (explain !== undefined) {
    for (const root of kept) {
      const via: string[] = []
      let id = root
      for (let next = through!.get(id); next !== undefined; next = through!.get(id)) {
        via.push(next)
        id = next
      }
      const seed = seeds!.get(id)!
      explain.reasons.set(root, via.length > 0 ? { ...seed, via } : seed)
    }
  }
  return kept
}

/**
 * The requested tasks `--affected` keeps, in their order: one the user
 * named (`pkg#task`), one in a project another include selected outright
 * (X-10), and one whose closure the change reaches.
 */
export function keptByAffected<R extends { project: string; task: string }>(
  nodes: ReadonlyMap<string, TaskNode>,
  requested: readonly R[],
  changes: AffectedChanges,
  projects: ReadonlyMap<string, ProjectEntry>,
  packageGraph: PackageGraph,
  keep: { named?: ReadonlySet<string>; outright?: ReadonlySet<string> } = {},
  explain?: AffectedExplain,
): R[] {
  const ids = requested.map((r) => `${r.project}#${r.task}`)
  const reached = new Set(affectedRoots(nodes, ids, changes, projects, packageGraph, explain))
  return requested.filter((r, i) => {
    const id = ids[i]!
    const why: AffectedReason['kind'] | null =
      keep.named?.has(id) === true
        ? 'named'
        : keep.outright?.has(r.project) === true
          ? 'selected'
          : null
    if (why !== null) explain?.reasons.set(id, { kind: why })
    return why !== null || reached.has(id)
  })
}

/**
 * The projects whose `task` a `vx run <task> --affected` over `candidates`
 * keeps (`vx show <task> --affected`): the run's graph, `graph` stage and
 * selection, without opening a cache or keying a task.
 */
export async function affectedTaskProjects(args: {
  task: string
  candidates: readonly string[]
  changes: AffectedChanges
  outright?: readonly string[] | undefined
  projects: Map<string, ProjectEntry>
  packageGraph: PackageGraph
  projectMetas: readonly ProjectMeta[]
  plugins: readonly VxPlugin[]
  workspaceRoot: string
  cacheDir: string
  rules?: WorkspaceRules | undefined
  warn: (message: string) => void
}): Promise<string[]> {
  const requested = expandRequested([args.task], args.candidates, args.projects, isDefaultBuild)
  const nodes = buildTaskGraph({
    projects: args.projects,
    packageGraph: args.packageGraph,
    requested,
    workspaceRoot: args.workspaceRoot,
    rules: args.rules,
  })
  if (hasHook(args.plugins, 'graph')) await applyGraphStage(args.plugins, nodes, args)
  const kept = keptByAffected(nodes, requested, args.changes, args.projects, args.packageGraph, {
    outright: new Set(args.outright),
  })
  return kept.map((r) => r.project)
}
