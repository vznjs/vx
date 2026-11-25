// `--affected` per task. The diff seeds the tasks it reaches; a requested task
// runs when its `dependsOn` closure holds one, through the edges its key folds
// (`inputs.tasks`). So a change reaches another project only along a keyed
// task edge: `web#test` behind `^build` runs when `ui#build` (or what it
// depends on) is reached, and a spec edit `ui#build`'s inputs leave out stops
// at `ui`'s own tasks.

import path from 'node:path'
import type { WorkspaceRules } from '../config.js'
import { declaresInput, workspaceFilesReachInto } from '../cache/index.js'
import {
  buildTaskGraph,
  compileTaskPattern,
  expandRequested,
  foldedDeps,
  isGroupTask,
  isTaskPattern,
  parseDependencySpec,
  type TaskNode,
} from '../graph/index.js'
import {
  type AffectedChanges,
  LOCKFILE_NAME,
  type PackageGraph,
  PROJECT_CONFIG_FILENAMES,
  type ProjectEntry,
  type ProjectMeta,
} from '../workspace/index.js'
import { applyGraphStage } from './graph-stage.js'
import { hasHook } from './plugin-host.js'
import type { VxPlugin } from './plugin.js'
import { isDefaultBuild } from '../graph/index.js'
import { relPosix } from '../util/index.js'

/** A project's config: its edit is a definition change of each task the lock cannot rule out. */
const KEYED_BY_EVERY_TASK: ReadonlySet<string> = new Set(PROJECT_CONFIG_FILENAMES)

/**
 * The projects whose every keyed task's key the change may move: those the
 * diff named whole (a lockfile claim, a moved lock entry or edge), and those
 * whose config file changed where the lock cannot say which tasks moved. A
 * path no input declares reaches no task (M, 2026-11-25): the key never
 * reads it.
 */
function wholeProjects(changes: AffectedChanges): Map<string, string | undefined> {
  // Each whole project, with its config file when an edit there did it.
  const whole = new Map<string, string | undefined>([...changes.whole].map((n) => [n, undefined]))
  for (const [name, rels] of changes.paths) {
    if (whole.has(name) || changes.configTasks?.has(name) === true) continue
    const rel = rels.find((r) => KEYED_BY_EVERY_TASK.has(r))
    if (rel !== undefined) whole.set(name, rel)
  }
  return whole
}

/**
 * Why `--affected` kept a requested task (`vx run --affected --dry`):
 * `input`, a changed `file` is one of its declared inputs; `always`, it has
 * `exec` and no `inputs`, so nothing rules a change out; `project`, its
 * key's material moved for the whole project (no single `file`: a lockfile
 * claim, a manifest edge, a config import); `workspace`, a workspace-wide
 * `file` (a root file a plugin claims, the workspace config under a plugin
 * that keys tasks) moved its key; `package`, a `^` edge passes through `project`, a
 * changed package with no such task; `named`, asked as `pkg#task`;
 * `selected`, another filter selected its project outright. `via` is the
 * `dependsOn` chain, nearest first, to the task the change seeded.
 */
export interface AffectedReason {
  kind: 'input' | 'always' | 'project' | 'workspace' | 'package' | 'named' | 'selected'
  /** Workspace-relative. */
  file?: string
  project?: string
  via?: string[]
  /** `workspace`: the file reached every project. The text label's, never on the JSON wire. */
  wide?: true
}

/** Collects each kept task's `AffectedReason` when given; a run without one pays nothing. */
export interface AffectedExplain {
  reasons: Map<string, AffectedReason>
}

/**
 * The task ids of `ids` whose closure the change reaches, in their order.
 * A task with `exec` and no `inputs` always seeds. One with `inputs` seeds
 * when a changed path is one of them, its own definition moved, or its
 * key's material did (`whole`, a plugin's `key` under a workspace config
 * edit). A group seeds only when its definition moved, or when keyed (the
 * default `build`) as a task with inputs does. A `^name` edge the
 * graph passes through a package it loaded no config for reaches it as the
 * default `build` would: any change there reaches the task.
 */
export function affectedRoots(
  nodes: ReadonlyMap<string, TaskNode>,
  ids: readonly string[],
  changes: AffectedChanges,
  projects: ReadonlyMap<string, ProjectEntry>,
  packageGraph: PackageGraph,
  workspaceRoot: string,
  explain?: AffectedExplain,
  /** A plugin keys tasks (`key`) from more than a recorded claim: a workspace config edit may move it. */
  keyPlugins = false,
): string[] {
  const whole = wholeProjects(changes)
  const seeds = explain === undefined ? null : new Map<string, AffectedReason>()
  const through = explain === undefined ? null : new Map<string, string>()
  const inProject = (name: string, rel: string | undefined): AffectedReason => {
    if (rel === undefined) {
      const file = changes.wholeBy?.get(name)
      if (file === undefined) return { kind: 'project' }
      return changes.wide === true
        ? { kind: 'workspace', file, wide: true }
        : { kind: 'workspace', file }
    }
    const dir = path.relative(workspaceRoot, projects.get(name)!.dir)
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
        // A loaded project without the task folds nothing into the key; the
        // holders past it seed as nodes of their own.
        if (!projects.has(target) && changes.projects.has(target)) {
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
    const group = isGroupTask(n)
    // Nothing it declares rules a change out (M, 2026-11-25).
    if (!keyed && !group) {
      seeds?.set(n.id, { kind: 'always' })
      return true
    }
    // Its own definition moved: a new task, for a group too.
    const rels = changes.paths.get(n.projectName) ?? []
    if (changes.configTasks?.get(n.projectName)?.has(n.taskName) === true) {
      if (seeds !== null) {
        // An imported file moved the entry, not the config: the lock is the
        // input.
        const config = rels.find((r) => KEYED_BY_EVERY_TASK.has(r))
        seeds.set(
          n.id,
          config === undefined
            ? { kind: 'input', file: LOCKFILE_NAME }
            : { ...inProject(n.projectName, config), kind: 'input' },
        )
      }
      return true
    }
    const wholeBy = whole.get(n.projectName)
    // A config edit the lock cannot split may have moved any task's definition.
    if (wholeBy !== undefined && whole.has(n.projectName)) {
      if (seeds !== null) seeds.set(n.id, { ...inProject(n.projectName, wholeBy), kind: 'input' })
      return true
    }
    // A group is reached through its deps.
    if (!keyed) return false
    // Asked of every node, not only the changed projects' (the
    // `workspaceFiles` owners): a `graph` hook may have given the glob.
    let projectDir: string | undefined
    const file = changes.changed.find((rel) => {
      const untracked = changes.untracked?.has(rel) === true
      if (untracked) projectDir ??= relPosix(workspaceRoot, n.projectDir)
      return declaresInput(task, null, rel, changes.dirLinks?.has(rel), untracked, projectDir)
    })
    const dir =
      file === undefined
        ? (changes.nested ?? []).find((d) => workspaceFilesReachInto(task, d))
        : undefined
    if (file !== undefined || dir !== undefined) {
      seeds?.set(n.id, { kind: 'input', file: (file ?? dir)! })
      return true
    }
    const links = changes.dirLinksIn?.get(n.projectName)
    const loose = changes.untrackedIn?.get(n.projectName)
    const rel = rels.find((r) => declaresInput(task, r, null, links?.has(r), loose?.has(r)))
    if (rel !== undefined) {
      if (seeds !== null) seeds.set(n.id, { ...inProject(n.projectName, rel), kind: 'input' })
      return true
    }
    // Its key's material moved for the whole project (a lockfile claim).
    if (whole.has(n.projectName)) {
      seeds?.set(n.id, inProject(n.projectName, undefined))
      return true
    }
    if (changes.workspace !== undefined && keyPlugins) {
      seeds?.set(n.id, { kind: 'workspace', file: changes.workspace, wide: true })
      return true
    }
    return false
  }
  // Which projects the change touched (M, 2026-11-25): only their tasks are
  // matched against inputs. Elsewhere a task seeds by what it declares, never
  // by a path: one with `exec` and no `inputs`, one whose `workspaceFiles` may
  // name a root or another project's path (a `graph` hook may have given the
  // glob), and, under a workspace edit a plugin's `key` may follow, any with
  // `inputs`.
  const touched = new Set<string>([...changes.projects, ...whole.keys()])
  for (const name of changes.configTasks?.keys() ?? []) touched.add(name)
  // A `^name` walk passes a changed package only when one has no config.
  const unloaded = [...changes.projects].some((p) => !projects.has(p))
  const asked = (n: TaskNode): boolean => {
    if (touched.has(n.projectName)) return seeded(n)
    const inputs = n.config.inputs
    if (inputs === undefined ? !isGroupTask(n) : changes.workspace !== undefined && keyPlugins)
      return seeded(n)
    const wide = changes.changed.length > 0 || changes.nested !== undefined
    return wide && (inputs?.workspaceFiles?.length ?? 0) > 0 && seeded(n)
  }
  // The deps a key folds (`inputs.tasks`, less order-only edges): one whose
  // hash the key leaves out cannot move it, so a change there reaches the
  // task no more than a run would miss it (nx task-level affected agrees).
  // Walked forward from each seed to the tasks that fold it, across projects
  // where the edges go; a task is never marked for its project alone.
  const dependants = new Map<string, string[]>()
  const reached = new Set<string>()
  const queue: string[] = []
  for (const n of nodes.values()) {
    for (const c of foldedDeps(n, (id) => nodes.get(id)!)) {
      const up = c.node.id
      const list = dependants.get(up)
      if (list === undefined) dependants.set(up, [n.id])
      else list.push(n.id)
    }
    if (asked(n) || (unloaded && passesChanged(n))) {
      reached.add(n.id)
      queue.push(n.id)
    }
  }
  for (let i = 0; i < queue.length; i++) {
    const up = queue[i]!
    for (const id of dependants.get(up) ?? []) {
      if (reached.has(id)) continue
      reached.add(id)
      through?.set(id, up)
      queue.push(id)
    }
  }
  const reaches = (id: string): boolean => reached.has(id)
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
 * The requested tasks `--affected` keeps, in their order: one the user named
 * (`pkg#task`), one in a project another include selected outright, and one
 * whose closure the change reaches.
 */
export function keptByAffected<R extends { project: string; task: string }>(
  nodes: ReadonlyMap<string, TaskNode>,
  requested: readonly R[],
  changes: AffectedChanges,
  projects: ReadonlyMap<string, ProjectEntry>,
  packageGraph: PackageGraph,
  workspaceRoot: string,
  keep: { named?: ReadonlySet<string>; outright?: ReadonlySet<string> } = {},
  explain?: AffectedExplain,
  keyPlugins = false,
): R[] {
  const ids = requested.map((r) => `${r.project}#${r.task}`)
  const reached = new Set(
    affectedRoots(nodes, ids, changes, projects, packageGraph, workspaceRoot, explain, keyPlugins),
  )
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
 * Whether a plugin keys tasks (`key`) from more than a claim `vx lock`
 * records (`fingerprint`): its material may move with a workspace config
 * edit that moves no locked config.
 */
export function keysTasks(plugins: readonly VxPlugin[]): boolean {
  return plugins.some((p) => p.key !== undefined && p.fingerprint === undefined)
}

/**
 * The projects whose `tasks` a `vx run <tasks> --affected` over `candidates`
 * keeps (`vx show [<task>] --affected`): the run's graph, `graph` stage and
 * selection, without opening a cache or keying a task.
 */
export async function affectedTaskProjects(args: {
  tasks: readonly string[]
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
  const requested = expandRequested(args.tasks, args.candidates, args.projects, isDefaultBuild)
  const nodes = buildTaskGraph({
    projects: args.projects,
    packageGraph: args.packageGraph,
    requested,
    workspaceRoot: args.workspaceRoot,
    rules: args.rules,
  })
  if (hasHook(args.plugins, 'graph')) await applyGraphStage(args.plugins, nodes, args)
  const kept = keptByAffected(
    nodes,
    requested,
    args.changes,
    args.projects,
    args.packageGraph,
    args.workspaceRoot,
    { outright: new Set(args.outright) },
    undefined,
    keysTasks(args.plugins),
  )
  return [...new Set(kept.map((r) => r.project))]
}
