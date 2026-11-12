import path from 'node:path'
import type { ProjectConfig, TaskConfig, WorkspaceRules } from '../config.js'
import {
  asTrees,
  braceAlternatives,
  GLOB_WILDCARDS,
  checkIgnoreSync,
  ignoreProbes,
  isLiteralPattern,
  literalPath,
  listedSync,
  nearest,
  normalizeGlob,
  relPosix,
  splitNegations,
  staticPrefix,
  taskGlob,
  refusal,
  UserError,
  wholeIgnored,
  wholeSubtreePrefixes,
  DependencySpecError,
  compileTaskPattern,
  isTaskPattern,
  parseDependencySpec,
  type DependencySpec,
} from '../util/index.js'
import type { PackageGraph, ProjectEntry } from '../workspace/index.js'
import { isDefaultBuild } from './default-build.js'
import { foldedDeps, isGroupTask } from './folds.js'
import type { TaskOutcome } from './outcome.js'
import { addStandIn } from './stand-ins.js'

// Re-exported so existing importers keep working while the type's home
// moves to workspace (it's the joint product of discovery + loading).
export type { ProjectEntry } from '../workspace/index.js'

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
   * Members of `deps` that order the run but fold into no key:
   * `--exclude-dependencies` dropped a task between, whose derived key already
   * folds theirs.
   */
  orderOnly?: string[]
  /**
   * True for the tasks the user asked for; false for deps `dependsOn` pulled
   * in. Scopes `forwardArgs` to the addressed tasks.
   */
  requested: boolean
  /**
   * Display-only: a same-project, non-group, direct `dependsOn` task of a
   * REQUESTED GROUP, shown like a requested task since a group has no output of
   * its own (`markSurfacedDeps`). Never `requested`, so `forwardArgs` is
   * unaffected.
   */
  surfaced?: boolean
  /**
   * Plugins' `key` stage material as sorted `[name, value]` pairs; set by
   * `prepareRun`, folded by `Cache.key`.
   */
  keyParts?: ReadonlyArray<readonly [name: string, value: string]>
  /**
   * The platform this run runs it on, when it declares `exec.platforms`:
   * set by placement, folded into its key.
   */
  platform?: string
  /**
   * The worker type its executor runs it on (`TaskExecutor.workers`), set
   * by placement when that executor names types: placement only, unkeyed.
   */
  worker?: string
  /**
   * Upstream tasks whose declared outputs this task's overlap: it ADDS to their
   * trees. Its output set is what its run added or changed, it cleans and
   * restores only its rows, and it is never restore-tier. Set by
   * `detectOutputCollisions`, which refuses the same overlap without an edge.
   */
  addsToOutputsOf?: string[]
  /**
   * Output globs of dependants that add into this task's tree: the hit's
   * current-tree check ignores what they match.
   */
  outputsAddedToBy?: string[]
  /**
   * The dependencies `--exclude-dependencies` took out of the schedule, as
   * outcomes carrying the key each would have. The key folds them beside
   * `deps`, so a key is the same whatever the selection.
   */
  excludedUpstream?: TaskOutcome[]
}

export function taskId(project: string, task: string): string {
  return `${project}#${task}`
}

// Re-exported from util, where the cache reads the same rule.
export { splitTaskId } from '../util/index.js'

/**
 * A keyed group that is only its dependencies' own `name` (`^name`), like the
 * default `build`: only this shape walks last on a package cycle and is passed
 * through.
 */
function isChainGroup(task: TaskConfig, name: string): boolean {
  return (
    task.exec === undefined &&
    task.inputs !== undefined &&
    task.dependsOn?.length === 1 &&
    task.dependsOn[0] === `^${name}`
  )
}

/**
 * Mark for display the real tasks a requested GROUP stands for, or `vx run
 * build` on a group prints nothing. Walk `dependsOn` from the group through
 * nested same-project groups and surface the first real task on each path,
 * never leaving the project and never past a real task. Never flips
 * `requested`. Returns how many were newly surfaced.
 */
export function markSurfacedDeps(nodes: Map<string, TaskNode>): number {
  let surfaced = 0
  for (const node of nodes.values()) {
    if (!node.requested || !isGroupTask(node)) continue
    const project = node.projectName
    const stack = [...node.deps]
    const visited = new Set<string>()
    while (stack.length > 0) {
      const depId = stack.pop()!
      if (visited.has(depId)) continue
      visited.add(depId)
      const dep = nodes.get(depId)
      // Stay inside the requested project; `^`/cross-project deps are
      // neither surfaced nor traversed.
      if (!dep || dep.projectName !== project) continue
      if (isGroupTask(dep)) {
        // A nested group: keep descending, don't surface the group.
        for (const next of dep.deps) stack.push(next)
        continue
      }
      if (dep.surfaced !== true) {
        dep.surfaced = true
        surfaced++
      }
    }
  }
  return surfaced
}

/**
 * Expand the requested list into `{project, task}` pairs. A bare name gives one
 * per project in `candidates` declaring it (missing is normal; an `unselected`
 * task is no match). `pkg#task` gives exactly one, dropped silently if absent
 * (the CLI validated it). Deduped.
 */
export function expandRequested(
  tasks: readonly string[],
  candidates: readonly string[],
  projects: Map<string, ProjectEntry>,
  unselected?: (task: TaskConfig) => boolean,
): Array<{ project: string; task: string }> {
  const seen = new Set<string>()
  const out: Array<{ project: string; task: string }> = []
  const push = (project: string, task: string): void => {
    const key = `${project}#${task}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ project, task })
  }
  for (const spec of tasks) {
    const idx = spec.indexOf('#')
    if (idx >= 0) {
      const project = spec.slice(0, idx)
      const task = spec.slice(idx + 1)
      if (declaresTask(projects, project, task)) push(project, task)
      continue
    }
    for (const name of candidates) {
      if (selectsTask(projects, name, spec, unselected)) push(name, spec)
    }
  }
  return out
}

/**
 * The task a config declares under `name`, by OWN property:
 * `tasks['constructor']` is Object.prototype's.
 */
export function declaredTask(
  config: ProjectConfig | null | undefined,
  name: string,
): TaskConfig | undefined {
  const tasks = config?.tasks
  return tasks !== undefined && Object.hasOwn(tasks, name) ? tasks[name] : undefined
}

/** Shared by `expandRequested` + `unresolvedRequests` so the two can't drift. */
function declaresTask(projects: Map<string, ProjectEntry>, project: string, task: string): boolean {
  return declaredTask(projects.get(project)?.config, task) !== undefined
}

/** What a bare name matches: a declared task `unselected` leaves alone. */
function selectsTask(
  projects: Map<string, ProjectEntry>,
  project: string,
  task: string,
  unselected: ((task: TaskConfig) => boolean) | undefined,
): boolean {
  const config = declaredTask(projects.get(project)?.config, task)
  return config !== undefined && unselected?.(config) !== true
}

/**
 * The requested specs `expandRequested` dropped because they matched NO
 * project. A name matching only some projects is normal, and an empty scope is
 * the selection's own message. Deduped.
 */
export function unresolvedRequests(
  tasks: readonly string[],
  candidates: readonly string[],
  projects: Map<string, ProjectEntry>,
  unselected?: (task: TaskConfig) => boolean,
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const spec of tasks) {
    if (seen.has(spec)) continue
    const idx = spec.indexOf('#')
    const resolved =
      idx >= 0
        ? declaresTask(projects, spec.slice(0, idx), spec.slice(idx + 1))
        : candidates.length === 0 ||
          candidates.some((name) => selectsTask(projects, name, spec, unselected))
    if (resolved) continue
    seen.add(spec)
    out.push(spec)
  }
  return out
}

export interface BuildGraphOptions {
  projects: Map<string, ProjectEntry>
  packageGraph: PackageGraph
  /** Initial set: `{ project, task }` pairs the user asked to run. */
  requested: Array<{ project: string; task: string }>
  /**
   * Set when `projects` is a scoped load. A `^name` no loaded project declares
   * may be declared by one not loaded, so the caller judges it
   * (`undeclaredDepsError`). Unset, the builder refuses it.
   */
  undeclaredDeps?: (taskId: string, name: string) => void
  /**
   * The workspace root anchoring `outputs.workspaceFiles`. Given, a
   * root-anchored output is compared with every project's outputs too.
   */
  workspaceRoot?: string
  /** The workspace's `run.rules`; each is on unless set to `false`. */
  rules?: GraphRules | undefined
  /**
   * By project name, every project rooted inside its dir, and every nested
   * workspace. Given with `workspaceRoot` at `vx lock`, a `files` entry rooted
   * inside a nested project or workspace is refused (`refuseNestedGlobs`).
   */
  nestedProjects?: ReadonlyMap<
    string,
    ReadonlyArray<{ name: string; dir: string; workspace?: boolean }>
  >
  /**
   * Every project's config file (absolute). Given with `workspaceRoot`, an
   * `outputs.workspaceFiles` glob covering one is refused (`refuseConfigOutputs`).
   */
  projectConfigs?: ReadonlyArray<{ name: string; configPath: string }>
}

/**
 * `run.rules` as the graph applies them. `locked`: a run, which never checks
 * them; `vx lock` and `vx lock --check` do.
 */
export type GraphRules = WorkspaceRules & { readonly locked?: boolean }

/**
 * Refuse a literal `^name` no project declares: it can only be a typo (nx#32779
 * ran one as no edge, green). A name SOME project declares stays legal without
 * a holder.
 */
export function undeclaredDepsError(
  taskId: string,
  name: string,
  declared: Iterable<string>,
): UserError {
  const meant = nearest(name, declared)
  return new UserError(
    `${taskId}: dependsOn ^${name} but no project in the workspace declares ${name}${meant === undefined ? '' : `. Did you mean ^${meant}?`}`,
    'VX_E_DEPENDS_ON',
  )
}

/**
 * The `pkg#task` to offer for a cross-project miss: the nearest task in the
 * project named, or the one whose directory or path suffix it is, or the
 * nearest project declaring `task`. Never a default build (it orders nothing),
 * nor one already in `listed`.
 */
function nearestTarget(
  projects: ReadonlyMap<string, ProjectEntry>,
  project: string,
  task: string,
  listed: ReadonlySet<string> = new Set(),
): string | undefined {
  const all = [...projects.values()]
  const declared = (p: ProjectEntry): string[] =>
    Object.entries(p.config.tasks ?? {})
      .filter(([n, t]) => !isDefaultBuild(t) && !listed.has(taskId(p.name, n)))
      .map(([n]) => n)
  const holder =
    projects.get(project) ??
    onlyOne(all.filter((p) => p.dir.endsWith(`/${project}`))) ??
    projects.get(
      nearest(
        project,
        all.filter((p) => declared(p).includes(task)).map((p) => p.name),
      ) ??
        nearest(project, projects.keys()) ??
        '',
    ) ??
    onlyOne(all.filter((p) => p.name.endsWith(`/${project}`)))
  if (holder === undefined) return undefined
  const tasks = declared(holder)
  const name = tasks.includes(task) ? task : nearest(task, tasks)
  return name === undefined ? undefined : taskId(holder.name, name)
}

/** The targets a task's `dependsOn` names by `pkg#task` or a bare task name. */
function listedTargets(node: TaskNode): Set<string> {
  const out = new Set<string>()
  for (const raw of node.config.dependsOn ?? []) {
    let spec: DependencySpec
    try {
      spec = parseDependencySpec(raw, 'dependsOn')
    } catch {
      continue
    }
    if (spec.kind === 'cross') out.add(taskId(spec.project, spec.task))
    else if (spec.kind === 'self') out.add(taskId(node.projectName, spec.task))
  }
  return out
}

function onlyOne<T>(list: readonly T[]): T | undefined {
  return list.length === 1 ? list[0] : undefined
}

/** One task mid-expansion in `buildTaskGraph`'s walk. */
interface Frame {
  node: TaskNode
  /** Index of the next `dependsOn` entry to resolve. */
  entry: number
  /** Whether the current entry has added a new node yet. */
  added: boolean
  /** The current entry's later new nodes, not yet in the graph. */
  pending: TaskNode[] | null
  /** Index into `pending` of the next one to add. */
  next: number
}

export function buildTaskGraph(options: BuildGraphOptions): Map<string, TaskNode> {
  const { projects, packageGraph, requested, undeclaredDeps } = options
  const nodes = new Map<string, TaskNode>()

  // An explicit stack, not recursion per edge: a chain ~20,000 deep overflowed
  // V8's stack (nx#28788) before `detectCycle` could name the cycle. Nodes are
  // added in the recursion's depth-first order, so the same cycle is named. A
  // frame's targets are all found first; the first new one is added at once,
  // the rest wait in `pending`.
  const stack: Frame[] = []

  function add(node: TaskNode): void {
    nodes.set(node.id, node)
    if (isChainGroup(node.config, node.taskName) && onCycle(node.projectName)) deferred.push(node)
    else if ((node.config.dependsOn?.length ?? 0) > 0) {
      stack.push({ node, entry: 0, added: false, pending: null, next: 0 })
    }
  }

  // Adds `projectName#taskName` if new, with the edge from `frame`'s task (null
  // when requested). False when the project or task is not declared.
  function visit(
    frame: Frame | null,
    projectName: string,
    taskName: string,
    requested: boolean,
  ): boolean {
    const id = taskId(projectName, taskName)
    const existing = nodes.get(id)
    if (existing) {
      // Promote an already-added node to requested if any caller asked
      // for it directly. Once requested, never demoted.
      if (requested) existing.requested = true
      frame?.node.deps.push(id)
      return true
    }

    const project = projects.get(projectName)
    if (!project) return false
    const taskConfig = declaredTask(project.config, taskName)
    if (!taskConfig) return false

    const node: TaskNode = {
      id,
      projectName,
      projectDir: project.dir,
      taskName,
      config: taskConfig,
      deps: [],
      requested,
    }
    if (frame === null) {
      add(node)
      return true
    }
    frame.node.deps.push(id)
    if (frame.added) (frame.pending ??= []).push(node)
    else {
      frame.added = true
      add(node)
    }
    return true
  }

  // Every task name `projects` declares, built on the first `^name` that
  // finds no holder and whose own project does not declare it either.
  let declared: Set<string> | null = null
  function declaredAnywhere(projectName: string, name: string): boolean {
    if (declaresTask(projects, projectName, name)) return true
    if (declared === null) {
      declared = new Set()
      for (const p of projects.values()) {
        for (const t of Object.keys(p.config.tasks ?? {})) declared.add(t)
      }
    }
    return declared.has(name)
  }

  // Package cycles for the default `build`: each project on one maps to its
  // strongly connected component, found on first ask (iterative Tarjan in the
  // `^name` walk's order).
  const component = new Map<string, number>()
  const cyclic = new Set<number>()
  let components = 0
  function componentOf(start: string): number {
    const known = component.get(start)
    if (known !== undefined) return known
    const index = new Map<string, number>()
    const low = new Map<string, number>()
    const open: string[] = []
    const work: Array<[name: string, next: number]> = []
    const enter = (name: string): void => {
      index.set(name, index.size)
      low.set(name, index.size - 1)
      open.push(name)
      work.push([name, 0])
    }
    enter(start)
    while (work.length > 0) {
      const top = work[work.length - 1]!
      const deps = packageGraph.directDeps(top[0])
      if (top[1] < deps.length) {
        const dep = deps[top[1]++]!
        if (component.has(dep)) continue
        if (!index.has(dep)) enter(dep)
        else low.set(top[0], Math.min(low.get(top[0])!, index.get(dep)!))
        continue
      }
      work.pop()
      const name = top[0]
      const parent = work[work.length - 1]
      if (parent !== undefined) low.set(parent[0], Math.min(low.get(parent[0])!, low.get(name)!))
      if (low.get(name) !== index.get(name)) continue
      const id = components++
      let size = 0
      for (let member = ''; member !== name; size++) {
        member = open.pop()!
        component.set(member, id)
      }
      if (size > 1) cyclic.add(id)
    }
    return component.get(start)!
  }
  // Default builds on a package cycle, expanded once the rest is built.
  const deferred: TaskNode[] = []
  const onCycle = (name: string): boolean => cyclic.has(componentOf(name))
  const sameCycle = (a: string, b: string): boolean =>
    onCycle(a) && componentOf(a) === componentOf(b)

  // `^name` from `start`: edges to the nearest holders of `name` below it,
  // passing through visited packages, ones declaring no `name`, and a default
  // build on a cycle. True when it found a holder. `past` holds edges already
  // passed, which each new edge stands in for.
  function walkHolders(
    frame: Frame,
    name: string,
    visited: Set<string>,
    start: string,
    past: readonly string[],
  ): boolean {
    const frontier: Array<[project: string, past: readonly string[]]> = packageGraph
      .directDeps(start)
      .map((d) => [d, past])
    let held = false
    while (frontier.length > 0) {
      const [target, via] = frontier.pop()!
      if (visited.has(target)) continue
      visited.add(target)
      if (visit(frame, target, name, false)) {
        held = true
        const id = taskId(target, name)
        if (via.length > 0) addStandIn(frame.node, id, via)
        const task = declaredTask(projects.get(target)!.config, name)!
        if (isChainGroup(task, name) && onCycle(target)) {
          const next = [...via, id]
          for (const d of packageGraph.directDeps(target)) frontier.push([d, next])
        }
      } else for (const d of packageGraph.directDeps(target)) frontier.push([d, via])
    }
    return held
  }

  // An edge to a default build on a package cycle goes on past it, as `^build`
  // does: that build folds nothing of its cycle's builds, so a dependant would
  // hit after a cycle member changed.
  function goPast(frame: Frame, project: string, name: string, visited: Set<string>): void {
    const task = declaredTask(projects.get(project)!.config, name)!
    if (isChainGroup(task, name) && onCycle(project))
      walkHolders(frame, name, visited, project, [taskId(project, name)])
  }

  // Resolves one `dependsOn` entry of `frame`'s task into its edges.
  function resolveEntry(frame: Frame, raw: string): void {
    const { node } = frame
    const { id, projectName, taskName } = node
    let spec: DependencySpec
    try {
      spec = parseDependencySpec(raw, 'dependsOn')
    } catch (err) {
      if (err instanceof DependencySpecError) {
        throw new UserError(`${id}: ${err.message}`, 'VX_E_DEPENDS_ON')
      }
      throw err
    }

    // dependsOn adds tasks, it does not filter: bare wildcards and negation
    // belong to inputs.tasks. Partial patterns (`build.*`) name a namespace to
    // add (Nx 19.5 parity).
    if (spec.kind === 'wildcardSelf' || spec.kind === 'wildcardDeps') {
      throw new UserError(
        `${id}: dependsOn does not accept bare wildcards (got "${raw}")`,
        'VX_E_DEPENDS_ON',
      )
    }
    if (spec.negated) {
      throw new UserError(
        `${id}: dependsOn does not accept negation (got "${raw}")`,
        'VX_E_DEPENDS_ON',
      )
    }
    if (spec.kind === 'cross' && (isTaskPattern(spec.task) || isTaskPattern(spec.project))) {
      throw new UserError(
        `${id}: dependsOn patterns are not supported in the "pkg#task" form (got "${raw}")`,
        'VX_E_DEPENDS_ON',
      )
    }
    if (spec.kind === 'self') {
      if (isTaskPattern(spec.task)) {
        // `build.*`: every OTHER same-project task matching; the declaring task
        // never matches itself. Zero matches is legal.
        const re = compileTaskPattern(spec.task)
        for (const name of Object.keys(projects.get(projectName)!.config.tasks ?? {})) {
          if (name === taskName || !re.test(name)) continue
          visit(frame, projectName, name, false)
          goPast(frame, projectName, name, new Set([projectName]))
        }
      } else {
        // Missing target is a hard error — the user typed a name that
        // doesn't resolve in this project.
        if (!visit(frame, projectName, spec.task, false)) {
          const meant = nearest(
            spec.task,
            Object.keys(projects.get(projectName)!.config.tasks ?? {}).filter(
              (n) => n !== taskName,
            ),
          )
          throw new UserError(
            `${id}: dependsOn ${taskId(projectName, spec.task)} but no such task is declared${meant === undefined ? '' : `. Did you mean ${meant}?`}`,
            'VX_E_DEPENDS_ON',
          )
        }
        goPast(frame, projectName, spec.task, new Set([projectName]))
      }
    } else if (spec.kind === 'deps') {
      // Nearest-holder frontier (Turbo and Nx parity): walk the package graph
      // from this project's deps; each path stops at the FIRST package
      // declaring the task, whose own dependsOn covers the rest. Packages
      // without it are passed through. `visited` dedupes and ends package
      // cycles, and is seeded with the declaring project: a task never depends
      // on itself.
      //
      // With a pattern, a holder declares at least one match and gets edges to
      // all of them; holder-ness is declaration, so it stops the walk even when
      // `--exclude-dependencies` drops every edge to it.
      //
      // The default `build` on a package cycle would make a task cycle no
      // config declares: it walks last (`resolveDeferred`), and a walk meeting
      // it takes the edge and goes past.
      //
      // With no edge source every `^` resolves to nothing, so its upstream
      // folds into no key.
      if (!packageGraph.edgeSource) {
        throw new UserError(
          `${id}: ${isDefaultBuild(node.config) ? `${projectName} declares no build, so it is the default build, whose ` : ''}^${spec.task} needs project edges; add pnpm()/bun()/npm()/yarn() and install so its lockfile exists, or a plugin that returns \`deps\``,
          'VX_E_DEPENDS_ON',
        )
      }
      const visited = new Set<string>([projectName])
      if (!isTaskPattern(spec.task)) {
        const held = walkHolders(frame, spec.task, visited, projectName, [])
        if (!held && !declaredAnywhere(projectName, spec.task)) {
          if (undeclaredDeps === undefined) throw undeclaredDepsError(id, spec.task, declared ?? [])
          undeclaredDeps(id, spec.task)
        }
        return
      }
      // A pattern that matches nothing stays legal, as `build.*` does.
      const re = compileTaskPattern(spec.task)
      const frontier = [...packageGraph.directDeps(projectName)]
      while (frontier.length > 0) {
        const target = frontier.pop()!
        if (visited.has(target)) continue
        visited.add(target)
        const names = Object.keys(projects.get(target)?.config.tasks ?? {}).filter((n) =>
          re.test(n),
        )
        if (names.length > 0) {
          for (const name of names) {
            visit(frame, target, name, false)
            goPast(frame, target, name, new Set([projectName, target]))
          }
        } else {
          frontier.push(...packageGraph.directDeps(target))
        }
      }
    } else {
      // Cross-project edge: pkg#task. Missing target is a hard error
      // because the user named the package + task explicitly.
      if (!visit(frame, spec.project, spec.task, false)) {
        // The loader spells `//` as the root project's name when there is one.
        if (spec.project === '//')
          throw new UserError(
            `${id}: dependsOn //#${spec.task}, the workspace root's task, but the root declares no such task: add a vx.config at the root declaring it and run \`vx lock\``,
            'VX_E_DEPENDS_ON',
          )
        const listed = listedTargets(node)
        const meant = nearestTarget(projects, spec.project, spec.task, listed)
        // The only near target is one the list already has (a deleted
        // project's entry beside its sibling's): the entry is the fix.
        const remove =
          meant === undefined && listed.has(nearestTarget(projects, spec.project, spec.task) ?? '')
        // Which half is missing: a project that exists was told "no such
        // project or task", though only its task was.
        const owner = projects.get(spec.project)
        const tasks = Object.keys(owner?.config.tasks ?? {})
        const what =
          owner === undefined
            ? `no project is named ${spec.project}`
            : `${spec.project} declares no task ${spec.task}${meant === undefined && tasks.length > 0 ? ` (its tasks: ${tasks.join(', ')})` : ''}`
        throw new UserError(
          `${id}: dependsOn ${taskId(spec.project, spec.task)}, but ${what}${remove ? ` — remove ${taskId(spec.project, spec.task)} from dependsOn` : meant === undefined ? '' : `. Did you mean ${meant}?`}`,
          'VX_E_DEPENDS_ON',
        )
      }
      goPast(frame, spec.project, spec.task, new Set([projectName, spec.project]))
    }
  }

  const drain = (): void => {
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!
      const { node, pending } = frame
      if (pending !== null && frame.next < pending.length) {
        // An earlier target's subtree may have added it meanwhile.
        const next = pending[frame.next++]!
        if (!nodes.has(next.id)) add(next)
        continue
      }
      const entries = node.config.dependsOn!
      if (frame.entry < entries.length) {
        frame.added = false
        frame.pending = null
        frame.next = 0
        resolveEntry(frame, entries[frame.entry++]!)
        continue
      }
      // Sorted for deterministic scheduling and keys, and deduped: a target
      // named twice is one edge.
      node.deps = [...new Set(node.deps)].sort()
      stack.pop()
    }
  }

  for (const { project, task } of requested) {
    visit(null, project, task, true)
    drain()
  }

  // A default build on a package cycle: its `^build` walk, run once the graph
  // holds everything else. A build on its cycle that reaches it is passed
  // through (an edge would close a cycle); any other is a holder, waited for
  // and folded. A build no other edge brought is expanded to ask and pruned if
  // it reaches back. Each walk sees the edges before it took, so none closes a
  // cycle.
  let expanded = false
  const resolveDeferred = (x: TaskNode): void => {
    // The default build's one entry is `^` and its own name.
    const name = x.taskName
    const frame: Frame = { node: x, entry: 0, added: false, pending: null, next: 0 }
    let reaching: Set<string> | null = null
    const visited = new Set<string>([x.projectName])
    const frontier: Array<[project: string, past: readonly string[]]> = packageGraph
      .directDeps(x.projectName)
      .map((d) => [d, []])
    const push = (from: string, via: readonly string[]): void => {
      for (const d of packageGraph.directDeps(from)) frontier.push([d, via])
    }
    while (frontier.length > 0) {
      const [target, via] = frontier.pop()!
      if (visited.has(target)) continue
      visited.add(target)
      const task = declaredTask(projects.get(target)?.config, name)
      if (task === undefined) {
        push(target, via)
        continue
      }
      const to = taskId(target, name)
      if (sameCycle(x.projectName, target)) {
        if (!isChainGroup(task, name) && !nodes.has(to)) {
          visit(null, target, name, false)
          drain()
          expanded = true
          reaching = null
        }
        if (isChainGroup(task, name) || (reaching ??= reachingTo(nodes, x.id)).has(to)) {
          push(target, via)
          continue
        }
      }
      const size = nodes.size
      frame.added = false
      visit(frame, target, name, false)
      drain()
      if (nodes.size !== size) reaching = null
      if (via.length > 0) addStandIn(x, to, via)
      if (isChainGroup(task, name) && onCycle(target)) push(target, [...via, to])
    }
    x.deps = [...new Set(x.deps)].sort()
  }
  for (let i = 0; i < deferred.length; i++) resolveDeferred(deferred[i]!)
  if (expanded) {
    const keep = new Set<string>()
    const roots = [...nodes.values()].filter((n) => n.requested).map((n) => n.id)
    while (roots.length > 0) {
      const id = roots.pop()!
      if (keep.has(id)) continue
      keep.add(id)
      roots.push(...nodes.get(id)!.deps)
    }
    for (const id of nodes.keys()) if (!keep.has(id)) nodes.delete(id)
  }

  checkGraph(nodes, options.workspaceRoot, options.rules)
  if (options.nestedProjects !== undefined && options.rules?.locked !== true)
    refuseNestedGlobs(nodes, options.nestedProjects, options.workspaceRoot)
  if (options.projectConfigs !== undefined && options.workspaceRoot !== undefined)
    refuseConfigOutputs(nodes, options.projectConfigs, options.workspaceRoot)
  return nodes
}

/**
 * Refuse an `outputs.workspaceFiles` glob covering a project's config: outputs
 * are cleaned before a run. A root-anchored glob can reach any project, so it
 * is judged here, where every config is known.
 */
function refuseConfigOutputs(
  nodes: ReadonlyMap<string, TaskNode>,
  configs: ReadonlyArray<{ name: string; configPath: string }>,
  workspaceRoot: string,
): void {
  let rels: Array<{ name: string; rel: string }> | undefined
  for (const n of nodes.values()) {
    const ws = n.config.outputs?.workspaceFiles
    if (ws === undefined || ws.length === 0) continue
    const { positive, negative } = splitNegations(ws)
    rels ??= configs.map((c) => ({ name: c.name, rel: relPosix(workspaceRoot, c.configPath) }))
    const back = asTrees(negative)
    for (const g of positive) {
      // Only a config under the glob's fixed prefix can match it.
      const root = rootless(staticPrefix(g))
      const trees = asTrees([g])
      const hit = rels.find(
        (c) =>
          (root === '' || c.rel === root || c.rel.startsWith(`${root}/`)) &&
          trees.some((t) => taskGlob(t).match(c.rel)) &&
          !back.some((t) => taskGlob(t).match(c.rel)),
      )
      if (hit === undefined) continue
      throw new UserError(
        `${n.id}: outputs.workspaceFiles ${JSON.stringify(g)} covers ${hit.rel}, the config of ` +
          `the project ${hit.name} — vx deletes a task's outputs before it runs and restores ` +
          `them on a hit, so the project would lose its config. Name the directory the task ` +
          `writes, or take the file back with "!${hit.rel}".`,
      )
    }
  }
}

/**
 * Refuse an `inputs.files` or `outputs.files` entry rooted inside a nested
 * project (or an output inside a nested workspace): its files belong to that
 * project. An input would key nothing, so an edit there hits; an output saves
 * nothing. An input still reaches into a nested workspace. Judged per brace
 * alternative's fixed prefix.
 */
function refuseNestedGlobs(
  nodes: ReadonlyMap<string, TaskNode>,
  nested: ReadonlyMap<string, ReadonlyArray<{ name: string; dir: string; workspace?: boolean }>>,
  workspaceRoot: string | undefined,
): void {
  for (const n of nodes.values()) {
    const inner = nested.get(n.projectName)
    if (inner === undefined || inner.length === 0 || isGroupTask(n)) continue
    for (const side of ['inputs', 'outputs'] as const) {
      for (const g of positives(n.config[side]?.files)) {
        for (const alt of braceAlternatives(g)) {
          const prefix = staticPrefix(alt)
          if (prefix === '.' || prefix === '') continue
          const abs = path.join(n.projectDir, prefix)
          const hit = inner.find(
            (p) =>
              (side === 'outputs' || p.workspace !== true) &&
              (abs === p.dir || abs.startsWith(p.dir + path.sep)),
          )
          if (hit === undefined) continue
          const rel =
            workspaceRoot === undefined
              ? hit.name
              : relPosix(workspaceRoot, path.join(n.projectDir, alt.replace(/^\.\//, '')))
          if (hit.workspace === true)
            throw new UserError(
              `${n.id} writes ${JSON.stringify(g)} in outputs.files, which lies inside the ` +
                `workspace ${hit.name} (it holds its own .vx/workspace.*): a project's outputs ` +
                `never reach another workspace's files, so it saves nothing. Let that ` +
                `workspace's own tasks write them, or name them in outputs.workspaceFiles ` +
                `(${JSON.stringify(rel)}).`,
              'VX_E_NESTED_OUTPUT',
            )
          throw new UserError(
            side === 'inputs'
              ? `${n.id} reads ${JSON.stringify(g)} in inputs.files, which lies inside the project ` +
                  `${hit.name}: a project's globs never reach another project's files, so it keys ` +
                  `nothing. Depend on a ${hit.name} task, or name the files in inputs.workspaceFiles ` +
                  `(${JSON.stringify(rel)}).`
              : `${n.id} writes ${JSON.stringify(g)} in outputs.files, which lies inside the project ` +
                  `${hit.name}: a project's globs never reach another project's files, so it saves ` +
                  `nothing. Let a ${hit.name} task write them, or name them in outputs.workspaceFiles ` +
                  `(${JSON.stringify(rel)}).`,
            side === 'inputs' ? 'VX_E_NESTED_INPUT' : 'VX_E_NESTED_OUTPUT',
          )
        }
      }
    }
  }
}

/** The ids of the tasks that reach `target` along `deps`, itself included. */
function reachingTo(nodes: Map<string, TaskNode>, target: string): Set<string> {
  const dependants = new Map<string, string[]>()
  for (const n of nodes.values()) {
    for (const d of n.deps) {
      const list = dependants.get(d)
      if (list === undefined) dependants.set(d, [n.id])
      else list.push(n.id)
    }
  }
  const out = new Set<string>()
  const stack = [target]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (out.has(id)) continue
    out.add(id)
    stack.push(...(dependants.get(id) ?? []))
  }
  return out
}

/**
 * What a graph must hold before scheduling: each node under its own id, every
 * dep named once, no cycle, no two tasks deleting each other's outputs. The
 * builder holds the first two by construction; the `graph` stage runs this
 * again after plugins, which could move a node or drop the edge that made an
 * overlap an addition. Addition marks are re-derived from the current edges.
 */
export function checkGraph(
  nodes: Map<string, TaskNode>,
  workspaceRoot?: string,
  rules?: GraphRules,
): void {
  for (const [key, node] of nodes) {
    if (node.id !== key) {
      throw new Error(`the task ${node.id} is stored under '${key}', not its own id`)
    }
    for (const dep of node.deps) {
      if (!nodes.has(dep)) {
        throw new Error(`${node.id} depends on '${dep}', which is not a task in this run's graph`)
      }
    }
    // A plugin's repeated edge, as the builder's own: folded into the key
    // twice, and owed twice by a server held on the remote's answer.
    if (node.deps.length > 1) {
      const unique = new Set(node.deps)
      if (unique.size < node.deps.length) node.deps = [...unique]
    }
    delete node.addsToOutputsOf
    delete node.outputsAddedToBy
  }
  for (const node of nodes.values()) refuseSelfClean(node, workspaceRoot)
  detectCycle(nodes)
  const exclusive = rules?.exclusiveOutputs !== false
  const locked = rules?.locked === true
  // Under a lock an exclusive graph has no overlap to mark; a non-exclusive
  // one still needs the addition marks the walk derives.
  if (!locked || !exclusive) detectOutputCollisions(nodes, workspaceRoot, exclusive)
  if (!locked) detectInputOverlaps(nodes, workspaceRoot)
}

/**
 * Mark the dependants outside the run that add to its tasks' outputs (with
 * `exclusiveOutputs: false`): run alone, `build` would count `types`' additions
 * as strays and wipe them on every warm run. A task outside the run overlapping
 * one inside is its dependant: an unordered pair is `vx lock`'s refusal.
 */
export function markOutsideAdditions(
  nodes: Map<string, TaskNode>,
  projects: ReadonlyMap<string, ProjectEntry>,
  workspaceRoot: string,
): void {
  const all = new Map(nodes)
  const outside = new Set<string>()
  for (const [projectName, project] of projects) {
    for (const [taskName, config] of Object.entries(project.config.tasks ?? {})) {
      const id = taskId(projectName, taskName)
      if (nodes.has(id) || config.outputs === undefined) continue
      outside.add(id)
      all.set(id, {
        id,
        projectName,
        projectDir: project.dir,
        taskName,
        config,
        deps: [],
        requested: false,
      })
    }
  }
  if (outside.size > 0) detectOutputCollisions(all, workspaceRoot, false, outside)
}

/**
 * `--exclude-dependencies`: take `dependsOn` edges out of the SCHEDULE, not the
 * graph. `'all'` drops every edge; a name list drops edges to tasks with those
 * names. What the requested tasks still reach stays; the rest leaves `nodes`
 * with its deps intact, and each task that lost an edge is listed in `dropped`.
 * An edge to a task still scheduled is kept.
 *
 * Under `'all'` a group's own edges stay: a group is its members. A name list
 * still drops a group edge it names.
 *
 * Run after the `graph` and `key` stages: a dropped dependency is still KEYED,
 * since a key never depends on the selection (nx#35234).
 */
export function excludeDependencies(
  nodes: Map<string, TaskNode>,
  exclude: 'all' | readonly string[],
): { keyOnly: Map<string, TaskNode>; dropped: Map<string, string[]> } {
  const names = exclude === 'all' ? null : new Set(exclude)
  const keptBy =
    (node: TaskNode) =>
    (dep: string): boolean =>
      names === null ? isGroupTask(node) : !names.has(nodes.get(dep)!.taskName)
  const scheduled = new Set<string>()
  const stack = [...nodes.values()].filter((n) => n.requested).map((n) => n.id)
  while (stack.length > 0) {
    const id = stack.pop()!
    if (scheduled.has(id)) continue
    scheduled.add(id)
    const node = nodes.get(id)!
    const kept = keptBy(node)
    for (const dep of node.deps) if (kept(dep)) stack.push(dep)
  }
  const keyOnly = new Map<string, TaskNode>()
  const dropped = new Map<string, string[]>()
  for (const [id, node] of nodes) {
    if (!scheduled.has(id)) {
      keyOnly.set(id, node)
      continue
    }
    // An edge to a task this run schedules anyway stays, or the two run
    // unordered.
    const kept = keptBy(node)
    const stays = (d: string): boolean => kept(d) || scheduled.has(d)
    const lost = node.deps.filter((d) => !stays(d))
    if (lost.length === 0) continue
    dropped.set(id, lost)
    node.deps = node.deps.filter(stays)
    // A scheduled task reached through a dropped one still runs first: in `test
    // → gen → build` with `gen` excluded, `test` must still follow `build`.
    const order = new Set<string>()
    const seen = new Set<string>()
    const stack = [...lost]
    while (stack.length > 0) {
      const dep = stack.pop()!
      if (seen.has(dep)) continue
      seen.add(dep)
      if (scheduled.has(dep)) {
        if (!node.deps.includes(dep)) order.add(dep)
        continue
      }
      stack.push(...nodes.get(dep)!.deps)
    }
    if (order.size === 0) continue
    node.orderOnly = [...order].sort()
    node.deps = [...node.deps, ...node.orderOnly].sort()
  }
  for (const id of keyOnly.keys()) nodes.delete(id)
  return { keyOnly, dropped }
}

/**
 * True only when two output globs PROVABLY overlap. Conservative, because the
 * caller REFUSES the run and a false positive breaks a working build:
 *
 * - both literal: equal paths;
 * - literal vs glob: does the glob match the literal;
 * - both globs: identical, or one is `P/**` and the other's literal prefix is P
 *   or under it. Anything else passes.
 *
 * A static-prefix comparison is unsound for a refusal: `dist/vx-*` and
 * `dist/other.txt` share `dist` and match disjoint sets.
 *
 * Each side goes through `asTrees` first, the rule `cleanOutputs` deletes by:
 * `./dist/**` is `dist/**`, and `outputs: ['dist']` is everything under `dist`.
 *
 * On the façade so `@vzn/vx-migrate` asks the same question at migration time.
 */
export function outputsOverlap(rawA: string, rawB: string): boolean {
  // Each brace alternative on its own: the checks read a brace as one opaque
  // segment.
  const as = braceAlternatives(rawA)
  const bs = braceAlternatives(rawB)
  if (as.length === 1 && bs.length === 1) return overlapOne(rawA, rawB)
  return as.some((a) => bs.some((b) => overlapOne(a, b)))
}

function overlapOne(rawA: string, rawB: string): boolean {
  // A built path proves overlap only between globs as written: a literal's
  // `/**` twin reads it as a directory.
  const bothGlobs = literalPath(rawA) === null && literalPath(rawB) === null
  for (const a of asTrees([rawA])) {
    for (const b of asTrees([rawB])) {
      const la = literalPath(a)
      const lb = literalPath(b)
      if (la !== null && lb !== null) {
        if (la === lb) return true
      } else if (la !== null) {
        if (taskGlob(b).match(la)) return true
      } else if (lb !== null) {
        if (taskGlob(a).match(lb)) return true
      } else if (a === b || covers(a, b) || covers(b, a) || (bothGlobs && witnessed(a, b)))
        return true
    }
  }
  return false
}

/** `staticPrefix` names the project root `.`; a path built under it starts bare. */
const rootless = (prefix: string): string => (prefix === '.' ? '' : prefix)

/**
 * Do two globs both match a path built from them? A hit proves the overlap, a
 * miss decides nothing. The path sits under the deeper literal prefix and ends
 * in either glob's filled last segment.
 */
function witnessed(a: string, b: string): boolean {
  const pa = rootless(staticPrefix(a))
  const pb = rootless(staticPrefix(b))
  const nested = (outer: string, inner: string): boolean =>
    outer === '' || inner === outer || inner.startsWith(`${outer}/`)
  if (!nested(pa, pb) && !nested(pb, pa)) return false
  const deeper = pa.length >= pb.length ? pa : pb
  const ga = taskGlob(a)
  const gb = taskGlob(b)
  for (const glob of [a, b]) {
    const last = glob.slice(glob.lastIndexOf('/') + 1)
    if (/[[\]{}()!+@]/.test(last)) continue
    const leaf = last.replace(/\*+|\?/g, 'x')
    for (const mid of ['', 'x/']) {
      const candidate = deeper === '' ? `${mid}${leaf}` : `${deeper}/${mid}${leaf}`
      if (ga.match(candidate) && gb.match(candidate)) return true
    }
  }
  // Each glob filled whole, every wildcard a name and `**` one level or none:
  // `**/dist/**` beside `**/*` meets at `x/dist/x`.
  for (const glob of [a, b]) {
    const segs = glob.split('/')
    if (segs.some((s) => /[[\]{}()!+@]/.test(s))) continue
    for (const drop of [false, true]) {
      const candidate = segs
        .flatMap((s) => (s === '**' ? (drop ? [] : ['x']) : [s.replace(/\*+|\?/g, 'x')]))
        .join('/')
      if (candidate !== '' && ga.match(candidate) && gb.match(candidate)) return true
    }
  }
  const met = unified(a.split('/'), b.split('/'))
  return met !== null && met !== '' && ga.match(met) && gb.match(met)
}

/**
 * A path both globs take, built segment by segment, `**` matching a segment of
 * the other or none. Null when none; a find is checked whole after.
 */
function unified(sa: readonly string[], sb: readonly string[]): string | null {
  // A `!` opening a class is the class's; anywhere else, an extglob.
  if ([...sa, ...sb].some((x) => /[{}()!+@]/.test(x.replaceAll('[!', '[')))) return null
  const memo = new Map<string, string | null>()
  const join = (name: string, rest: string): string => (rest === '' ? name : `${name}/${rest}`)
  const walk = (i: number, j: number): string | null => {
    const key = `${i},${j}`
    if (memo.has(key)) return memo.get(key)!
    memo.set(key, null)
    let out: string | null = null
    if (i === sa.length && j === sb.length) out = ''
    else if (sa[i] === '**' || sb[j] === '**') {
      // A last `**` takes one segment at least: `out/**` is not `out`.
      const lastA = sa[i] === '**' && i === sa.length - 1
      const lastB = sb[j] === '**' && j === sb.length - 1
      const [wide, x, y, other] = sa[i] === '**' ? [sa, i, j, sb] : [sb, j, i, sa]
      if (lastA && lastB) out = 'x'
      if (out === null && sa[i] === '**' && !lastA) out = walk(i + 1, j)
      if (out === null && sb[j] === '**' && !lastB) out = walk(i, j + 1)
      if (out === null && y < other.length && other[y] !== '**') {
        const name = segmentMeet('*', other[y]!)
        // Having taken one, it may take more or stop.
        const rest =
          name === null
            ? null
            : wide === sa
              ? (walk(x, y + 1) ?? walk(x + 1, y + 1))
              : (walk(y + 1, x) ?? walk(y + 1, x + 1))
        if (name !== null && rest !== null) out = join(name, rest)
      }
    } else if (i < sa.length && j < sb.length) {
      const name = segmentMeet(sa[i]!, sb[j]!)
      const rest = name === null ? null : walk(i + 1, j + 1)
      if (name !== null && rest !== null) out = join(name, rest)
    }
    memo.set(key, out)
    return out
  }
  return walk(0, 0)
}

/** A name both segments take, from each filled in and the one's head joined to the other's tail. */
function segmentMeet(x: string, y: string): string | null {
  const fill = (seg: string, star: string): string =>
    seg
      .replace(/\*+/g, star)
      .replace(/\?/g, 'x')
      // A negated class takes a name it does not list: `[!a]` is not `a`.
      .replace(/\[([!^]?)(.)([^\]]*)\]/g, (_, not: string, first: string, more: string) =>
        not === ''
          ? first
          : (['x', 'y', 'z', '0', '_'].find((c) => !`${first}${more}`.includes(c)) ?? first),
      )
  const head = (seg: string): string => {
    const at = seg.search(GLOB_WILDCARDS)
    return at === -1 ? seg : seg.slice(0, at)
  }
  const tail = (seg: string): string => {
    let at = seg.length
    while (at > 0 && !GLOB_WILDCARDS.test(seg[at - 1]!)) at--
    return seg.slice(at)
  }
  const gx = new Bun.Glob(x)
  const gy = new Bun.Glob(y)
  for (const c of [
    fill(x, 'x'),
    fill(y, 'x'),
    fill(x, ''),
    fill(y, ''),
    head(x) + tail(y),
    head(y) + tail(x),
    // Each name a class lists, the other's class filled: `[ab]` beside `[!a]` meets at `b`.
    ...[x, y].flatMap((seg) => {
      const listed = /\[([^!^\]][^\]]*)\]/.exec(seg)?.[1] ?? ''
      return listed.split('').map((ch) => fill(seg.replace(/\[[^!^\]][^\]]*\]/, ch), 'x'))
    }),
  ])
    if (c !== '' && gx.match(c) && gy.match(c)) return c
  return null
}

/**
 * Does `P/**` match every path `glob` can? Yes when `glob`'s literal prefix is
 * P or under it. Undecided, `dist/**` beside `dist/extra/**` let a hit restore
 * a stale copy of the narrow task's files.
 */
const WHOLE_ROOT = new Set(['**', '**/*'])

function covers(tree: string, glob: string): boolean {
  // The root's tree has no directory to name: `**` covers everything under the
  // root.
  if (WHOLE_ROOT.has(normalizeGlob(tree))) {
    const g = normalizeGlob(glob)
    return !g.startsWith('!') && !g.startsWith('/') && !g.split('/').includes('..')
  }
  const dir = wholeSubtreePrefixes([tree])?.[0]
  if (dir === undefined) return false
  const prefix = staticPrefix(glob)
  return prefix === dir || prefix.startsWith(`${dir}/`)
}

/**
 * Refuse a graph where two tasks declare overlapping outputs. vx cleans a
 * task's outputs before it runs and before a restore, so ownership is STRICT:
 * two claims on one path destroy each other's work under a green run. Turbo
 * restores additively and never hits this.
 *
 * `outputs.files` is project-relative, so only one project's tasks collide;
 * `outputs.workspaceFiles` may collide across any two. No key changes.
 */
function detectOutputCollisions(
  nodes: Map<string, TaskNode>,
  workspaceRoot: string | undefined,
  exclusive: boolean,
  outside?: ReadonlySet<string>,
): void {
  // Does `from` reach `to` through deps? Asked only for a colliding pair,
  // memoised per source. With `outside`, a task outside the run reaches every
  // task in it, the only order the lock allows.
  const reachMemo = new Map<string, Set<string>>()
  const reaches = (from: string, to: string): boolean => {
    if (outside !== undefined) return outside.has(from) && !outside.has(to)
    let seen = reachMemo.get(from)
    if (seen === undefined) {
      seen = new Set<string>()
      const stack = [...(nodes.get(from)?.deps ?? [])]
      while (stack.length > 0) {
        const id = stack.pop()!
        if (seen.has(id)) continue
        seen.add(id)
        for (const d of nodes.get(id)?.deps ?? []) if (!seen.has(d)) stack.push(d)
      }
      reachMemo.set(from, seen)
    }
    return seen.has(to)
  }
  // INDEX first, never all-pairs over the graph (quadratic: 1.6 s at 1,000
  // projects × 10 tasks). `files` collide only within a project;
  // `workspaceFiles` across any tasks that declare it. Within a domain each
  // pair set is indexed by path again (`overlapCandidates`), so only pairs that
  // can overlap are compared, in all-pairs order. With `outside`, only pairs of
  // one task in the run and one outside are compared, to mark them: `vx lock`
  // refuses the rest.
  const pair = (a: TaskNode, b: TaskNode, compare: () => void): void => {
    if (outside === undefined) return compare()
    if (outside.has(a.id) === outside.has(b.id)) return
    try {
      compare()
    } catch {
      // A shape the lock refuses: no mark.
    }
  }
  const byProject = new Map<string, TaskNode[]>()
  const wsDeclarers: TaskNode[] = []
  for (const n of nodes.values()) {
    const outs = n.config.outputs
    if ((outs?.files?.length ?? 0) > 0) {
      const bucket = byProject.get(n.projectName)
      if (bucket) bucket.push(n)
      else byProject.set(n.projectName, [n])
    }
    if ((outs?.workspaceFiles?.length ?? 0) > 0) wsDeclarers.push(n)
  }

  // Where outputs MIGHT land: the positive globs. A `!` only narrows, so
  // leaving it out can refuse a pair it separates, never pass one; read as a
  // glob it is `Bun.Glob`'s negation, which overlaps nearly everything.
  const positiveOf = (globs: readonly string[] | undefined): readonly string[] | undefined =>
    globs === undefined ? undefined : splitNegations(globs).positive
  const filesOf = (n: TaskNode): readonly string[] | undefined =>
    positiveOf(n.config.outputs?.files)
  const wsFilesOf = (n: TaskNode): readonly string[] | undefined =>
    positiveOf(n.config.outputs?.workspaceFiles)
  for (const bucket of byProject.values()) {
    // Most projects hold one task with outputs, and a call per project
    // cost the cold build a measured 0.4 ms at 1,000 projects.
    if (bucket.length < 2) continue
    for (const [i, j] of overlapCandidates(bucket, filesOf)) {
      const a = bucket[i]!
      const b = bucket[j]!
      pair(a, b, () => collide(a, b, filesOf(a), filesOf(b), 'files', reaches, exclusive))
    }
  }
  if (wsDeclarers.length >= 2) {
    for (const [i, j] of overlapCandidates(wsDeclarers, wsFilesOf)) {
      const a = wsDeclarers[i]!
      const b = wsDeclarers[j]!
      pair(a, b, () =>
        collide(a, b, wsFilesOf(a), wsFilesOf(b), 'workspaceFiles', reaches, exclusive),
      )
    }
  }
  // A root-anchored output reaching into another project's `files` outputs must
  // be compared with them: each `files` declarer joins the root-anchored domain
  // rebased to the root, and only the mixed pairs are compared.
  if (wsDeclarers.length === 0 || workspaceRoot === undefined) return
  interface Entry {
    node: TaskNode
    globs: readonly string[]
    /** The project's root-relative dir for a rebased `files` entry; undefined for a root-anchored one. */
    rel?: string
  }
  const entries: Entry[] = wsDeclarers.map((node) => ({ node, globs: wsFilesOf(node) ?? [] }))
  for (const bucket of byProject.values()) {
    for (const node of bucket) {
      const rel = relPosix(workspaceRoot, node.projectDir)
      const globs = (filesOf(node) ?? []).map((g) => (rel === '' ? g : `${rel}/${g}`))
      entries.push({ node, globs, rel })
    }
  }
  for (const [i, j] of overlapCandidates(
    entries,
    (e) => e.globs,
    (e) => e.rel !== undefined,
  )) {
    const x = entries[i]!
    const y = entries[j]!
    if (x.node === y.node) continue
    const [ws, files] = x.rel === undefined ? [x, y] : [y, x]
    pair(ws.node, files.node, () =>
      collideAcross(ws.node, ws.globs, files.node, files.globs, files.rel!, reaches, exclusive),
    )
  }
}

/**
 * What a task's `!` outputs take back: a glob of the other task's taken back
 * whole is never cleaned or captured by this one.
 */
function takenBackOf(n: TaskNode, field: 'files' | 'workspaceFiles'): string[] {
  return splitNegations(n.config.outputs?.[field] ?? []).negative
}

/**
 * `collide` for a root-anchored output against another project's rebased
 * `files` output. With an edge the dependant adds to its upstream's tree, told
 * in the upstream's OWN namespace; a glob that does not start in that project
 * cannot be told apart, so the pair is refused.
 */
function collideAcross(
  ws: TaskNode,
  wsGlobs: readonly string[],
  files: TaskNode,
  rebased: readonly string[],
  rel: string,
  reaches: (from: string, to: string) => boolean,
  exclusive: boolean,
): void {
  if (neverWritesLocally(ws) || neverWritesLocally(files)) return
  const wsBack = takenBackOf(ws, 'workspaceFiles')
  const filesBack = takenBackOf(files, 'files').map((g) => (rel === '' ? g : `${rel}/${g}`))
  for (const ga of wsGlobs) {
    for (const gb of rebased) {
      if (!outputsOverlap(ga, gb) || outputTakenBack(gb, wsBack) || outputTakenBack(ga, filesBack))
        continue
      const head =
        `${ws.id} declares the output ${JSON.stringify(ga)} in outputs.workspaceFiles, ` +
        `inside ${files.id}'s ${JSON.stringify(gb.slice(rel === '' ? 0 : rel.length + 1))} in ` +
        `outputs.files — vx cleans a task's declared outputs before it runs and before a ` +
        `cache-hit restore, so whichever of these runs second DELETES the other's output`
      if (exclusive && (reaches(files.id, ws.id) || reaches(ws.id, files.id))) {
        throw new UserError(`${head}. ${EXCLUSIVE_OUTPUTS_FIX}`, 'VX_E_OUTPUT_OVERLAP')
      }
      if (reaches(files.id, ws.id)) {
        ;(files.addsToOutputsOf ??= []).push(ws.id)
        ;(ws.outputsAddedToBy ??= []).push(...rebased)
        return
      }
      if (reaches(ws.id, files.id)) {
        const own = wsGlobs.map((g) =>
          rel === '' ? g : g.startsWith(`${rel}/`) ? g.slice(rel.length + 1) : null,
        )
        if (own.every((g): g is string => g !== null)) {
          ;(ws.addsToOutputsOf ??= []).push(files.id)
          ;(files.outputsAddedToBy ??= []).push(...own)
          return
        }
        // Already ordered: "make one depend on the other" would send the
        // reader after an edge the config has. Name what keeps it out.
        const outside = wsGlobs[own.indexOf(null)]!
        throw new UserError(
          `${head}. ${ws.id} depends on ${files.id}, but adding to its output needs every ` +
            `outputs.workspaceFiles entry inside ${rel === '' ? 'the workspace root' : rel}, ` +
            `and ${JSON.stringify(outside)} is not. Give each task its own output path.`,
          'VX_E_OUTPUT_OVERLAP',
        )
      }
      throw new UserError(
        `${head} and the run still reports success. Give each task its own output path` +
          (exclusive ? '.' : ', or make one depend on the other.'),
        'VX_E_OUTPUT_OVERLAP',
      )
    }
  }
}

/**
 * Where a glob's literal head ends: every character `Bun.Glob` may read as
 * other than itself (`*?{}`, `\` escapes, a leading `!`). Ending early only
 * widens the candidate set, which a fuzz of millions of pairs confirmed.
 */
const GLOB_HEAD_END = /[*?{}[\]\\!]/

/** `firstSegment`'s answer for a glob that can start anywhere. */
const ANYWHERE = ''

/** Where a glob's first segment ends: a separator, or anything `GLOB_HEAD_END` stops at. */
const FIRST_SEGMENT_END = /[*?{}[\]\\!/]/

const firstSegments = new Map<string, string>()

/**
 * The first path segment every path a glob (or its `asTrees` twin) can match
 * starts with, or `ANYWHERE`: globs with different first segments are disjoint.
 * Memoised by the raw string.
 */
function firstSegment(raw: string): string {
  let seg = firstSegments.get(raw)
  if (seg !== undefined) return seg
  const g = normalizeGlob(raw)
  const cut = g.search(FIRST_SEGMENT_END)
  seg = cut === -1 ? g : g[cut] === '/' ? g.slice(0, cut) : ANYWHERE
  if (seg === '.' || seg === '..') seg = ANYWHERE
  firstSegments.set(raw, seg)
  return seg
}

/**
 * False only when no candidate pair can overlap: every glob starts in a named
 * segment and no two members (on different sides, given `sideOf`) share one.
 * Most per-project buckets look like that, and building their indexes cost tens
 * of ms at 1,090 projects.
 */
function mayOverlap<T>(
  tasks: readonly T[],
  globsOf: (n: T) => readonly string[] | undefined,
  sideOf?: (n: T) => boolean,
): boolean {
  // Per segment: the first member seen (one side) or the sides seen as a mask.
  const seen = new Map<string, number>()
  for (let i = 0; i < tasks.length; i++) {
    const mark = sideOf === undefined ? i : sideOf(tasks[i]!) ? 2 : 1
    for (const g of globsOf(tasks[i]!) ?? []) {
      const seg = firstSegment(g)
      if (seg === ANYWHERE) return true
      const was = seen.get(seg)
      if (was === undefined) seen.set(seg, mark)
      else if (sideOf === undefined) {
        if (was !== i) return true
      } else if ((was | mark) === 3) return true
      else seen.set(seg, was | mark)
    }
  }
  return false
}

/**
 * The pairs `[i, j]` whose declared outputs CAN overlap, ascending: a superset
 * of what `outputsOverlap` accepts, so `collide` decides exactly as over all
 * pairs, in the same order.
 *
 * Two globs meet only when one's literal prefix lies at or under the other's;
 * equal literals meet; a glob matches a literal only under its head's directory
 * (a wildcard in the first segment meets every literal). So a literal meets the
 * globs filed at each of its ancestors.
 *
 * Given `sideOf`, only pairs across sides are wanted (a reader and a writer),
 * and each index is kept per side: readers sharing `src/**` are never paired
 * with each other.
 */
function overlapCandidates<T>(
  tasks: readonly T[],
  globsOf: (n: T) => readonly string[] | undefined,
  sideOf?: (n: T) => boolean,
): Iterable<[number, number]> {
  // Nearly every bucket stops here, so it starts no generator.
  return mayOverlap(tasks, globsOf, sideOf) ? indexedCandidates(tasks, globsOf, sideOf) : []
}

/** `overlapCandidates` past `mayOverlap`. */
function* indexedCandidates<T>(
  tasks: readonly T[],
  globsOf: (n: T) => readonly string[] | undefined,
  sideOf?: (n: T) => boolean,
): Generator<[number, number]> {
  const sides = sideOf === undefined ? 1 : 2
  // The index a member of side `s` looks up: its own side's, or the other's.
  const across = (s: number): number => (sides === 1 ? s : 1 - s)
  const perSide = (): Array<Map<string, number[]>> =>
    Array.from({ length: sides }, () => new Map<string, number[]>())
  const file = (index: Map<string, number[]>, key: string, i: number): void => {
    const list = index.get(key)
    if (list === undefined) index.set(key, [i])
    else list.push(i)
  }
  const fileAncestors = (index: Map<string, number[]>, key: string, i: number): void => {
    for (let sep = key.indexOf('/'); sep !== -1; sep = key.indexOf('/', sep + 1)) {
      file(index, key.slice(0, sep), i)
    }
  }
  // Each relation is filed from both ends, so a member finds every partner by
  // its own lookups and pairs are built one `i` at a time: 20,000 tasks sharing
  // `dist/**` are 200 million pairs, and the caller refuses at the first. Each
  // glob is filed at its prefix and at each ancestor.
  const byPrefix = perSide()
  const overPrefix = perSide()
  // A literal meets the globs filed at each of its ancestors.
  const globsUnder = perSide()
  const literals = perSide()
  interface Tree {
    /** Its literal prefix, `''` at the root. */
    prefix: string
    /** The directory its literal head names. */
    head: string
  }
  const trees: Tree[][] = []
  const paths: string[][] = []
  const side: number[] = []
  for (let i = 0; i < tasks.length; i++) {
    const s = sideOf?.(tasks[i]!) === true ? 1 : 0
    side.push(s)
    const own: Tree[] = []
    const lits: string[] = []
    // Each brace alternative, as `outputsOverlap` reads them.
    for (const tree of asTrees((globsOf(tasks[i]!) ?? []).flatMap(braceAlternatives))) {
      const lit = literalPath(tree)
      if (lit !== null) {
        lits.push(lit)
        file(literals[s]!, '', i)
        fileAncestors(literals[s]!, lit, i)
        continue
      }
      const prefix = rootless(staticPrefix(tree))
      file(byPrefix[s]!, prefix, i)
      file(overPrefix[s]!, prefix, i)
      if (prefix !== '') file(overPrefix[s]!, '', i)
      fileAncestors(overPrefix[s]!, prefix, i)
      const lead = tree.slice(0, tree.search(GLOB_HEAD_END))
      const head = lead.slice(0, Math.max(0, lead.lastIndexOf('/')))
      file(globsUnder[s]!, head, i)
      own.push({ prefix, head })
    }
    trees.push(own)
    paths.push(lits)
  }
  const n = tasks.length
  // The `i` each partner was last taken for, so one found twice is kept once.
  const takenFor = new Int32Array(n).fill(-1)
  let found: number[] = []
  const take = (i: number, list: readonly number[] | undefined): void => {
    if (list === undefined) return
    for (const j of list) {
      if (j > i && takenFor[j] !== i) {
        takenFor[j] = i
        found.push(j)
      }
    }
  }
  const takeAncestors = (i: number, index: Map<string, number[]>, key: string): void => {
    for (let sep = key.indexOf('/'); sep !== -1; sep = key.indexOf('/', sep + 1)) {
      take(i, index.get(key.slice(0, sep)))
    }
  }
  for (let i = 0; i < n; i++) {
    const o = across(side[i]!)
    for (const { prefix, head } of trees[i]!) {
      take(i, byPrefix[o]!.get(prefix))
      if (prefix !== '') take(i, byPrefix[o]!.get(''))
      takeAncestors(i, byPrefix[o]!, prefix)
      take(i, overPrefix[o]!.get(prefix))
      take(i, literals[o]!.get(head))
    }
    for (const path of paths[i]!) {
      take(i, globsUnder[o]!.get(''))
      takeAncestors(i, globsUnder[o]!, path)
    }
    if (found.length === 0) continue
    const partners = found.sort((x, y) => x - y)
    found = []
    for (const j of partners) yield [i, j]
  }
}

/**
 * A `remote: 'only'` task never materialises its outputs here: no probe,
 * restore, clean or local save. The hazard is local cleaning, so a pair
 * including one cannot exhibit it.
 */
function neverWritesLocally(n: TaskNode): boolean {
  return n.config.exec?.remote === 'only'
}

/**
 * The way out of an edge-ordered overlap: an ordered pair is correct (the
 * addition shape), only slower, so the rule may be turned off.
 */
const EXCLUSIVE_OUTPUTS_FIX =
  'Give each task its own output path, or set run.rules.exclusiveOutputs: false in ' +
  ".vx/workspace.ts to let a dependant add to its upstream's outputs."

function collide(
  a: TaskNode,
  b: TaskNode,
  aGlobs: readonly string[] | undefined,
  bGlobs: readonly string[] | undefined,
  field: 'files' | 'workspaceFiles',
  reaches: (from: string, to: string) => boolean,
  exclusive: boolean,
): void {
  if (neverWritesLocally(a) || neverWritesLocally(b)) return
  const aBack = takenBackOf(a, field)
  const bBack = takenBackOf(b, field)
  for (const ga of aGlobs ?? []) {
    for (const gb of bGlobs ?? []) {
      if (!outputsOverlap(ga, gb) || outputTakenBack(gb, aBack) || outputTakenBack(ga, bBack))
        continue
      const head =
        `${a.id} and ${b.id} both declare the output ${JSON.stringify(ga)}` +
        (ga === gb ? '' : ` / ${JSON.stringify(gb)}`) +
        ` in outputs.${field} — vx cleans a task's declared outputs before it runs and ` +
        `before a cache-hit restore, so whichever of these runs second DELETES the other's ` +
        `output`
      // An overlap WITH an edge is the addition shape: the dependant runs after
      // and adds to the tree, so its own set can be told from what it found.
      // Marked on both; allowed when `exclusiveOutputs` is off. Without an edge
      // the order is free, and the refusal stands.
      const [up, down] = reaches(b.id, a.id) ? [a, b] : reaches(a.id, b.id) ? [b, a] : []
      const parts = {
        headline: `${a.id} and ${b.id} both write ${ga === gb ? ga : `${ga} / ${gb}`}`,
        ...(field === 'files' ? {} : { what: ['in outputs.workspaceFiles'] }),
        why: "vx clears a task's outputs before it runs, so one deletes the other's",
      }
      if (up !== undefined && exclusive)
        throw refusal(
          {
            ...parts,
            fix: 'give each task its own output path, or set run.rules.exclusiveOutputs: false in .vx/workspace.ts',
          },
          { code: 'VX_E_OUTPUT_OVERLAP', message: `${head}. ${EXCLUSIVE_OUTPUTS_FIX}` },
        )
      if (up !== undefined && down !== undefined) {
        const downGlobs = splitNegations(
          (field === 'files' ? down.config.outputs?.files : down.config.outputs?.workspaceFiles) ??
            [],
        ).positive
        ;(down.addsToOutputsOf ??= []).push(up.id)
        ;(up.outputsAddedToBy ??= []).push(...(downGlobs ?? []))
        return
      }
      throw refusal(
        { ...parts, fix: 'give each task its own output path' },
        {
          code: 'VX_E_OUTPUT_OVERLAP',
          message: `${head} and the run still reports success. Give each task its own output path.`,
        },
      )
    }
  }
}

/**
 * Does `negatives` take back every path `output` can select? Each `asTrees`
 * form must be a negative's form, sit inside a negative subtree, or as a
 * literal be matched by one. A partial take-back answers false.
 */
export function outputTakenBack(output: string, negatives: readonly string[]): boolean {
  if (negatives.length === 0) return false
  const neg = asTrees(negatives)
  return asTrees([output]).every((t) =>
    neg.some((n) => n === t || covers(n, t) || (isLiteralPattern(t) && taskGlob(n).match(t))),
  )
}

/**
 * A task whose input entry its own outputs take back whole would clean its own
 * sources (a formatter declaring `src/**` as both deleted every committed file
 * under it). Always refused. Compared across fields too, `files` rebased to the
 * root.
 */
function refuseSelfClean(node: TaskNode, workspaceRoot: string | undefined): void {
  const outputs = node.config.outputs
  const inputs = node.config.inputs
  if (outputs === undefined || inputs === undefined) return
  selfClean(node, 'files', inputs.files, outputs.files)
  selfClean(node, 'workspaceFiles', inputs.workspaceFiles, outputs.workspaceFiles)
  const wsOut = (outputs.workspaceFiles?.length ?? 0) > 0
  const wsIn = (inputs.workspaceFiles?.length ?? 0) > 0
  if (workspaceRoot === undefined || (!wsOut && !wsIn)) return
  const rel = relPosix(workspaceRoot, node.projectDir)
  const rebased = (globs: readonly string[] | undefined) =>
    globs?.map((g) => {
      const neg = g.startsWith('!') ? '!' : ''
      const body = g.slice(neg.length).replace(/^\.\//, '')
      return rel === '' ? g : `${neg}${rel}/${body}`
    })
  if (wsOut) selfClean(node, 'files', rebased(inputs.files), outputs.workspaceFiles, inputs.files)
  if (wsIn) selfClean(node, 'workspaceFiles', inputs.workspaceFiles, rebased(outputs.files))
}

/** Throws when an output in `out` takes back an entry of `ins` whole. `said` is `ins` as declared. */
function selfClean(
  node: TaskNode,
  field: 'files' | 'workspaceFiles',
  ins: readonly string[] | undefined,
  out: readonly string[] | undefined,
  said: readonly string[] | undefined = ins,
): void {
  if (!coversAny(ins, out)) return
  const inputs = splitNegations(ins ?? [])
  const declared = said === ins ? inputs : splitNegations(said ?? [])
  const taken = splitNegations(out ?? [])
  const outputs = taken.positive
  if (outputs.length === 0) return
  const roots = outputs.map((g) => rootless(staticPrefix(g)))
  for (const [i, gi] of inputs.positive.entries()) {
    // Only an output rooted at or above the input's prefix can cover it;
    // the prefix test keeps the glob matchers off the common disjoint pair.
    const pi = rootless(staticPrefix(gi))
    const near = outputs.filter((_, k) => {
      const r = roots[k]!
      return r === '' || pi === r || pi.startsWith(`${r}/`)
    })
    // Taken back by the task's own `!` inputs, or by an output `!` (no
    // output, so never cleaned), the entry reads what it says.
    if (near.length === 0 || outputTakenBack(gi, inputs.negative)) continue
    if (outputTakenBack(gi, taken.negative)) continue
    if (!outputTakenBack(gi, near)) continue
    throw new UserError(
      `${node.id}: every file ${JSON.stringify(declared.positive[i])} in inputs.${field} selects ` +
        `is also its own output — vx removes a task's outputs before it runs, so the task would ` +
        `delete its own sources. A task that rewrites files in place (a formatter) declares ` +
        `no outputs.`,
      'VX_E_INPUT_IS_OUTPUT',
    )
  }
}

/**
 * False only when no positive output can cover a positive input: each starts in
 * a named first segment and none is shared.
 */
function coversAny(
  inputs: readonly string[] | undefined,
  outputs: readonly string[] | undefined,
): boolean {
  if (inputs === undefined || outputs === undefined) return false
  let anyOutput = false
  for (const go of outputs) {
    if (go.startsWith('!')) continue
    anyOutput = true
    if (firstSegment(go) === ANYWHERE) return true
  }
  if (!anyOutput) return false
  for (const gi of inputs) {
    if (gi.startsWith('!')) continue
    const seg = firstSegment(gi)
    if (seg === ANYWHERE) return true
    for (const go of outputs) if (!go.startsWith('!') && firstSegment(go) === seg) return true
  }
  return false
}

/** A glob list's positive entries: the list itself when it takes nothing back. */
function positives(globs: readonly string[] | undefined): readonly string[] {
  if (globs === undefined) return []
  for (const g of globs) if (g.startsWith('!')) return splitNegations(globs).positive
  return globs
}

/** One task's inputs (`reads`) or outputs in one namespace, for `detectInputOverlaps`. */
interface Side {
  node: TaskNode
  globs: readonly string[]
  reads: boolean
  /** The project's root-relative dir for rebased `files` globs. */
  rel?: string
  /** The root-relative dir project-relative `globs` sit in, for git. */
  anchor?: string | undefined
}

/**
 * Refuse a task whose input globs can match another task's declared outputs (no
 * opt-out): such a key reads bytes a producer writes this run, unknown until it
 * ran. Refused, every key can be derived before anything runs. A dependency's
 * key already cascades through `dependsOn`; the exception is `refuseOverlaps`'s
 * unfolded dependency.
 *
 * Proven overlaps only (`outputsOverlap`). Same scope as
 * `detectOutputCollisions`: `files` against same-project outputs, root-anchored
 * inputs against every `workspaceFiles` output and, with the root known,
 * rebased `files` outputs, and rebased `files` inputs against `workspaceFiles`
 * outputs. A task's own outputs and outputs taken back whole by the reader's
 * `!` are no overlap. A keyed group runs nothing and is exempt.
 */
function detectInputOverlaps(nodes: Map<string, TaskNode>, workspaceRoot?: string): void {
  const byProject = new Map<string, Side[]>()
  const rooted: Side[] = []
  const wsWriters: Side[] = []
  const filesReaders: TaskNode[] = []
  const filesWriters: TaskNode[] = []
  let projectReaders = false
  let rootReaders = false
  const memo: TakeBackMemo = { bySide: new Map(), byList: new Map() }
  const found: Found = new Map()
  const bucket = (name: string): Side[] => {
    let list = byProject.get(name)
    if (list === undefined) byProject.set(name, (list = []))
    return list
  }
  for (const n of nodes.values()) {
    const declaredOutputs = n.config.outputs
    const inputs = n.config.inputs
    if (inputs === undefined) continue
    const outFiles = positives(declaredOutputs?.files ?? [])
    const outWs = positives(declaredOutputs?.workspaceFiles ?? [])
    if (outFiles.length > 0) {
      const anchor = workspaceRoot === undefined ? undefined : relPosix(workspaceRoot, n.projectDir)
      bucket(n.projectName).push({ node: n, globs: outFiles, reads: false, anchor })
      filesWriters.push(n)
    }
    if (outWs.length > 0) {
      const side = { node: n, globs: outWs, reads: false }
      rooted.push(side)
      wsWriters.push(side)
    }
    if (isGroupTask(n)) continue
    const inFiles = positives(inputs.files)
    const inWs = positives(inputs.workspaceFiles ?? [])
    if (inFiles.length > 0) {
      const anchor = workspaceRoot === undefined ? undefined : relPosix(workspaceRoot, n.projectDir)
      bucket(n.projectName).push({ node: n, globs: inFiles, reads: true, anchor })
      filesReaders.push(n)
      projectReaders = true
    }
    if (inWs.length > 0) {
      rooted.push({ node: n, globs: inWs, reads: true })
      rootReaders = true
    }
  }
  if (projectReaders) {
    for (const sides of byProject.values()) {
      if (sides.length < 2) continue
      for (const [i, j] of overlapCandidates(
        sides,
        (s) => s.globs,
        (s) => s.reads,
      )) {
        readsOutputs(memo, found, sides[i]!, sides[j]!, 'files')
      }
    }
  }
  if (projectReaders && wsWriters.length > 0 && workspaceRoot !== undefined) {
    const sides = [...wsWriters]
    for (const node of filesReaders) {
      const rel = relPosix(workspaceRoot, node.projectDir)
      const globs = positives(node.config.inputs!.files).map((g) =>
        rel === '' ? g : `${rel}/${g}`,
      )
      sides.push({ node, globs, reads: true, rel })
    }
    for (const [i, j] of overlapCandidates(
      sides,
      (s) => s.globs,
      (s) => s.reads,
    )) {
      readsOutputs(memo, found, sides[i]!, sides[j]!, 'files')
    }
  }
  if (rootReaders) readsRootedOutputs(memo, found, rooted, filesWriters, workspaceRoot)
  refuseOverlaps(found, nodes, workspaceRoot)
}

function readsRootedOutputs(
  memo: TakeBackMemo,
  found: Found,
  rooted: Side[],
  filesWriters: readonly TaskNode[],
  workspaceRoot: string | undefined,
): void {
  if (workspaceRoot !== undefined) {
    for (const node of filesWriters) {
      const rel = relPosix(workspaceRoot, node.projectDir)
      const globs = positives(node.config.outputs!.files).map((g) =>
        rel === '' ? g : `${rel}/${g}`,
      )
      rooted.push({ node, globs, reads: false, rel })
    }
  }
  for (const [i, j] of overlapCandidates(
    rooted,
    (s) => s.globs,
    (s) => s.reads,
  )) {
    readsOutputs(memo, found, rooted[i]!, rooted[j]!, 'workspaceFiles')
  }
}

/** One reader of another task's output: the reader's glob's fixed prefix, root-relative. */
interface Overlap {
  reader: TaskNode
  writer: TaskNode
  prefix: string
  refuse: () => UserError
}

/** Each overlapped output, root-relative, and every reader of it. */
type Found = Map<string, Overlap[]>

/**
 * Which overlaps stand. A reader may read outputs of a task in its `dependsOn`
 * closure its key does not fold: its key waits and hashes the bytes. Otherwise
 * an output git ignores whole is no overlap, unless the reader's glob starts in
 * an ignored path (`dist/**`): naming it is asking for it. Git is asked once
 * for everything; what it cannot speak for is refused. A run's stability gate
 * asks again.
 */
function refuseOverlaps(
  found: Found,
  nodes: ReadonlyMap<string, TaskNode>,
  workspaceRoot: string | undefined,
): void {
  if (found.size === 0) return
  const reads = dependencyReads(nodes)
  const left = new Map<string, Overlap[]>()
  for (const [g, list] of found) {
    const refused = list.filter((o) => !reads(o.reader, o.writer))
    if (refused.length > 0) left.set(g, refused)
  }
  if (left.size === 0) return
  if (workspaceRoot === undefined) throw left.values().next().value![0]!.refuse()
  const asks = [...left.keys()].map(ignoreProbes)
  const prefixes = new Set<string>()
  for (const list of left.values()) {
    for (const o of list) if (o.prefix !== '') prefixes.add(o.prefix).add(`${o.prefix}/`)
  }
  const ignored = checkIgnoreSync(workspaceRoot, [
    ...asks.flatMap((a) => a?.paths ?? []),
    ...prefixes,
  ])
  let listed: string[] | null | undefined
  const pass = wholeIgnored(left.keys(), ignored, (g) => {
    listed ??= listedSync(workspaceRoot, [
      ...new Set(asks.flatMap((a) => (a?.deep === true ? [a.dir] : []))),
    ])
    return listed === null || listed.some((f) => taskGlob(g).match(f))
  })
  const named = (o: Overlap): boolean =>
    o.prefix !== '' && ignored !== null && (ignored.has(o.prefix) || ignored.has(`${o.prefix}/`))
  for (const [g, list] of left) {
    for (const o of list) if (!pass.has(g) || named(o)) throw o.refuse()
  }
}

/**
 * Whether the writer is in the reader's `dependsOn` closure and not its folded
 * closure. Each closure walked once per reader.
 */
function dependencyReads(
  nodes: ReadonlyMap<string, TaskNode>,
): (reader: TaskNode, writer: TaskNode) => boolean {
  const nodeOf = (id: string): TaskNode => nodes.get(id)!
  const deps = new Map<string, Set<string>>()
  const folded = new Map<string, Set<string>>()
  const closure = (
    memo: Map<string, Set<string>>,
    root: TaskNode,
    next: (n: TaskNode) => Iterable<TaskNode>,
  ): Set<string> => {
    let out = memo.get(root.id)
    if (out !== undefined) return out
    out = new Set()
    const stack = [...next(root)]
    while (stack.length > 0) {
      const n = stack.pop()!
      if (out.has(n.id)) continue
      out.add(n.id)
      stack.push(...next(n))
    }
    memo.set(root.id, out)
    return out
  }
  return (reader, writer) =>
    closure(deps, reader, (n) => n.deps.flatMap((d) => nodes.get(d) ?? [])).has(writer.id) &&
    !closure(folded, reader, (n) => foldedDeps(n, nodeOf).map((c) => c.node)).has(writer.id)
}

/**
 * Whether a reader's take-back list covers an output glob, asked once per list
 * and glob (per pair was 2.7 s of an astro plan).
 */
interface TakeBack {
  list: string[]
  verdicts: Map<string, boolean>
}
type TakeBackMemo = { bySide: Map<Side, TakeBack>; byList: Map<string, TakeBack> }

function takenBack(
  memo: TakeBackMemo,
  reader: Side,
  field: 'files' | 'workspaceFiles',
  go: string,
): boolean {
  let tb = memo.bySide.get(reader)
  if (tb === undefined) {
    const inputs = reader.node.config.inputs!
    const declaredOutputs = reader.node.config.outputs
    // A reader rebased to the root speaks in its project's terms.
    const at = reader.rel === undefined || reader.rel === '' ? '' : `${reader.rel}/`
    // What the reader's key never reads: its `!` entries and its own outputs.
    const list = [
      ...splitNegations(field === 'files' ? inputs.files : (inputs.workspaceFiles ?? [])).negative,
      ...splitNegations(
        field === 'files'
          ? (declaredOutputs?.files ?? [])
          : (declaredOutputs?.workspaceFiles ?? []),
      ).positive,
    ].map((g) => at + g)
    const key = list.join('\0')
    tb = memo.byList.get(key)
    if (tb === undefined) memo.byList.set(key, (tb = { list, verdicts: new Map() }))
    memo.bySide.set(reader, tb)
  }
  let verdict = tb.verdicts.get(go)
  if (verdict === undefined) tb.verdicts.set(go, (verdict = outputTakenBack(go, tb.list)))
  return verdict
}

function readsOutputs(
  memo: TakeBackMemo,
  found: Found,
  x: Side,
  y: Side,
  field: 'files' | 'workspaceFiles',
): void {
  if (x.reads === y.reads || x.node === y.node) return
  const [reader, writer] = x.reads ? [x, y] : [y, x]
  const at = reader.rel === undefined || reader.rel === '' ? '' : `${reader.rel}/`
  const readerAt = reader.anchor === undefined || reader.anchor === '' ? '' : `${reader.anchor}/`
  for (const go of writer.globs) {
    const rooted =
      writer.anchor === undefined || writer.anchor === '' ? go : `${writer.anchor}/${go}`
    let list = found.get(rooted)
    if (list?.some((o) => o.reader === reader.node) === true) continue
    if (takenBack(memo, reader, field, go)) continue
    for (const gi of reader.globs) {
      if (!outputsOverlap(gi, go)) continue
      const shown =
        writer.rel === undefined || writer.rel === '' ? go : go.slice(writer.rel.length + 1)
      const out = at !== '' && go.startsWith(at) ? go.slice(at.length) : go
      const prefix = staticPrefix(readerAt + gi)
      if (list === undefined) found.set(rooted, (list = []))
      list.push({
        reader: reader.node,
        writer: writer.node,
        prefix: prefix === '.' ? '' : prefix,
        refuse: () =>
          new UserError(
            `${reader.node.id} reads ${JSON.stringify(gi.slice(at.length))} in inputs.${field}, which matches ` +
              `${writer.node.id}'s output ${JSON.stringify(shown)} — ` +
              // "or depend on it" told a task that already did to do it.
              (reader.node.deps.includes(writer.node.id)
                ? `it depends on ${writer.node.id}, whose key its own already includes. ` +
                  `Exclude it: add ${JSON.stringify(`!${out}`)} to ` +
                  `${reader.node.id}'s inputs.${field}, or leave ${writer.node.id} out of ` +
                  `${reader.node.id}'s inputs.tasks, so its key hashes those bytes instead.`
                : `a task's key must not read the outputs of a task it does not depend on, or whose key it already includes. ` +
                  `Exclude it: add ${JSON.stringify(`!${out}`)} to ${reader.node.id}'s ` +
                  `inputs.${field}, or depend on ${writer.node.id} and leave it out of ` +
                  `${reader.node.id}'s inputs.tasks, so its key hashes those bytes instead.`),
            'VX_E_INPUT_IS_OUTPUT',
          ),
      })
      break
    }
  }
}

function detectCycle(nodes: Map<string, TaskNode>): void {
  // Iterative DFS over a Uint8Array of colors by node index: recursion
  // overflows on deep chains, and Map lookups dominated. 0 = WHITE, the
  // zero-init default.
  const GRAY = 1
  const BLACK = 2
  const idsArr = [...nodes.keys()]
  const idIdx = new Map<string, number>()
  for (let i = 0; i < idsArr.length; i++) idIdx.set(idsArr[i]!, i)
  const color = new Uint8Array(idsArr.length)

  // Each frame is `[idIndex, nextChildIdx]`, the child index advanced in place
  // so the frame resumes where it left off.
  const stack: number[] = []
  for (let start = 0; start < idsArr.length; start++) {
    if (color[start] === BLACK) continue
    stack.push(start, 0)
    color[start] = GRAY
    while (stack.length > 0) {
      const childIdx = stack[stack.length - 1]!
      const idx = stack[stack.length - 2]!
      const node = nodes.get(idsArr[idx]!)
      const deps = node ? node.deps : []
      if (childIdx < deps.length) {
        stack[stack.length - 1] = childIdx + 1
        const depIdx = idIdx.get(deps[childIdx]!)
        if (depIdx === undefined) continue
        const c = color[depIdx]!
        if (c === BLACK) continue
        if (c === GRAY) {
          // Reconstruct the cycle by walking the open stack until we
          // hit the id that triggered the GRAY-on-GRAY hit.
          const path: string[] = []
          for (let i = 0; i < stack.length; i += 2) path.push(idsArr[stack[i]!]!)
          const startInPath = path.indexOf(idsArr[depIdx]!)
          const cycle = [...path.slice(startInPath), idsArr[depIdx]!].join(' -> ')
          throw new UserError(
            `dependsOn cycle: ${cycle} — remove one edge of the loop`,
            'VX_E_CYCLE',
          )
        }
        color[depIdx] = GRAY
        stack.push(depIdx, 0)
      } else {
        color[idx] = BLACK
        stack.pop()
        stack.pop()
      }
    }
  }
}
