// `--affected` per task. The diff seeds the tasks it reaches; a requested task
// runs when its `dependsOn` closure holds one, through the edges its key folds
// (`inputs.tasks`) or to a dependency whose outputs its inputs read. So a
// change reaches another project only along a keyed task edge: `web#test` behind `^build` runs when `ui#build` (or what it
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
  outputsOverlap,
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
  WORKSPACE_CONFIG_FILENAMES,
} from '../workspace/index.js'
import { applyGraphStage } from './graph-stage.js'
import { hasHook } from './plugin-host.js'
import type { VxPlugin } from './plugin.js'
import { isDefaultBuild } from '../graph/index.js'
import { relPosix } from '../util/index.js'

/**
 * vx's configs: no reason by themselves (M, 2026-11-25). They only generate
 * the locks, whose diff says which tasks moved.
 */
const CONFIGS: ReadonlySet<string> = new Set([
  ...PROJECT_CONFIG_FILENAMES,
  ...WORKSPACE_CONFIG_FILENAMES,
])
const isConfig = (rel: string): boolean => CONFIGS.has(path.posix.basename(rel))

/**
 * Why `--affected` kept a requested task (`vx run --affected --dry`):
 * `input`, a changed `file` is one of its declared inputs; `always`, it has
 * `exec` and no `inputs` in an affected project (one changed, or a package
 * dependant of one); `project`, its key's material moved for the whole
 * project (no single `file`: a lockfile claim, a manifest edge); `workspace`,
 * a workspace-wide `file` (a root file a plugin claims) moved its key; `package`, a `^` edge passes through `project`, a
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
 * A task with `exec` and no `inputs` seeds in an affected project. One with `inputs` seeds
 * when a changed path is one of them, its own definition moved, or its
 * key's material did (`whole`). A config file is no change itself: the
 * lock's entries are. A group seeds only when its definition moved, or when keyed (the
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
): string[] {
  const whole = changes.whole
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
  // The affected projects (M, 2026-11-25): those with a change of their own
  // (a file other than a config, a moved lock entry, key material moved
  // whole) and their package dependants. Only their tasks are scanned.
  const own = new Set<string>(whole)
  for (const [name, rels] of changes.paths) if (rels.some((r) => !isConfig(r))) own.add(name)
  for (const [name, moved] of changes.configTasks ?? []) if (moved.size > 0) own.add(name)
  const affectedSet = packageGraph.dependentsOf(own)
  for (const name of own) affectedSet.add(name)
  const changedProject = (name: string): boolean => affectedSet.has(name)
  const seeded = (n: TaskNode): boolean => {
    const task = n.config
    const keyed = task.inputs !== undefined
    const group = isGroupTask(n)
    // Nothing it declares rules out a change in its own project (M,
    // 2026-11-25): only there, never in a project with no change.
    if (!keyed && !group) {
      if (!changedProject(n.projectName)) return false
      seeds?.set(n.id, { kind: 'always' })
      return true
    }
    // Its own definition moved in the lock: a new task, for a group too.
    const rels = (changes.paths.get(n.projectName) ?? []).filter((r) => !isConfig(r))
    if (changes.configTasks?.get(n.projectName)?.has(n.taskName) === true) {
      seeds?.set(n.id, { kind: 'input', file: LOCKFILE_NAME })
      return true
    }
    // A group is reached through its deps.
    if (!keyed) return false
    // Asked of every node, not only the changed projects' (the
    // `workspaceFiles` owners): a `graph` hook may have given the glob.
    let projectDir: string | undefined
    const file = changes.changed.find((rel) => {
      if (isConfig(rel)) return false
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
    return false
  }
  // Only the affected projects' tasks are matched, and those a path names
  // (a `workspaceFiles` glob's owner). Elsewhere only a task whose
  // `workspaceFiles` a `graph` hook may have given is asked: its key moves.
  const touched = new Set<string>([...changes.projects, ...affectedSet])
  // A `^name` walk passes a changed package only when one has no config.
  const unloaded = [...changes.projects].some((p) => !projects.has(p))
  const wide = changes.changed.length > 0 || changes.nested !== undefined
  const asked = (n: TaskNode): boolean =>
    touched.has(n.projectName)
      ? seeded(n)
      : wide && (n.config.inputs?.workspaceFiles?.length ?? 0) > 0 && seeded(n)
  // The deps a key folds (`inputs.tasks`, less order-only edges): one whose
  // hash the key leaves out cannot move it, so a change there reaches the
  // task no more than a run would miss it (nx task-level affected agrees).
  // Walked forward from each seed to the tasks that fold it, across projects
  // where the edges go; a task is never marked for its project alone.
  const dependants = new Map<string, string[]>()
  const edge = (up: string, id: string): void => {
    const list = dependants.get(up)
    if (list === undefined) dependants.set(up, [id])
    else list.push(id)
  }
  const folded = new Map<string, string[]>()
  const reached = new Set<string>()
  const queue: string[] = []
  for (const n of nodes.values()) {
    const ups = foldedDeps(n, (id) => nodes.get(id)!).map((c) => c.node.id)
    folded.set(n.id, ups)
    for (const up of ups) edge(up, n.id)
  }
  // An unfolded dependency's outputs its key hashes move it all the same: the
  // reading the input-is-output refusal advises (`inputs.tasks: []`, files
  // over the dep's outputs).
  for (const [up, id] of outputReaders(nodes, folded, workspaceRoot)) edge(up, id)
  for (const n of nodes.values()) {
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
 * Each `[writer, reader]` where the reader's `inputs` read outputs of a task in
 * its `dependsOn` closure its key does not fold. Over-reading is safe here: a
 * pair selects one task more, never one less.
 */
function outputReaders(
  nodes: ReadonlyMap<string, TaskNode>,
  folded: ReadonlyMap<string, readonly string[]>,
  workspaceRoot: string,
): Array<[string, string]> {
  if (![...nodes.values()].some((n) => n.deps.some((d) => !folded.get(n.id)!.includes(d)))) {
    return []
  }
  // Whether `to` is reached from `from` along `next`, walked until found.
  const reaches = (from: string, to: string, next: (id: string) => readonly string[]) => {
    const seen = new Set<string>()
    const stack = [...next(from)]
    while (stack.length > 0) {
      const d = stack.pop()!
      if (d === to) return true
      if (seen.has(d) || !nodes.has(d)) continue
      seen.add(d)
      stack.push(...next(d))
    }
    return false
  }
  const at = (globs: readonly string[] | undefined, base: string) =>
    (globs ?? []).filter((g) => !g.startsWith('!')).map((g) => path.posix.join(base, g))
  // Writers by project folder: a `files` read meets only its own project's
  // `files` outputs, the root project's, and `workspaceFiles` outputs.
  const byRel = new Map<string, Array<{ id: string; writes: string[] }>>()
  const anywhere: Array<{ id: string; writes: string[] }> = []
  const all: Array<{ id: string; writes: string[] }> = []
  const rels = new Map<string, string>()
  for (const n of nodes.values()) {
    const rel = relPosix(workspaceRoot, n.projectDir)
    rels.set(n.id, rel)
    const own = at(n.config.outputs?.files, rel)
    const ws = at(n.config.outputs?.workspaceFiles, '')
    if (own.length + ws.length === 0) continue
    const w = { id: n.id, writes: [...own, ...ws] }
    all.push(w)
    if (ws.length > 0) anywhere.push(w)
    else if (rel !== '') {
      const list = byRel.get(rel)
      if (list === undefined) byRel.set(rel, [w])
      else list.push(w)
    }
  }
  const rootWriters = all.filter((w) => rels.get(w.id) === '' && !anywhere.includes(w))
  const pairs: Array<[string, string]> = []
  for (const n of nodes.values()) {
    const rel = rels.get(n.id)!
    const wide = (n.config.inputs?.workspaceFiles?.length ?? 0) > 0 || rel === ''
    const reads = [...at(n.config.inputs?.files, rel), ...at(n.config.inputs?.workspaceFiles, '')]
    if (reads.length === 0) continue
    const candidates = wide ? all : [...(byRel.get(rel) ?? []), ...anywhere, ...rootWriters]
    for (const w of candidates) {
      if (w.id === n.id || !reads.some((r) => w.writes.some((o) => outputsOverlap(r, o)))) continue
      const direct = n.deps.includes(w.id)
      if (!direct && !reaches(n.id, w.id, (id) => nodes.get(id)?.deps ?? [])) continue
      if (!reaches(n.id, w.id, (id) => folded.get(id) ?? [])) pairs.push([w.id, n.id])
    }
  }
  return pairs
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
): R[] {
  const ids = requested.map((r) => `${r.project}#${r.task}`)
  const reached = new Set(
    affectedRoots(nodes, ids, changes, projects, packageGraph, workspaceRoot, explain),
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
  )
  return [...new Set(kept.map((r) => r.project))]
}
