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
import type { TaskOutcome } from './scheduler.js'

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
   * The members of `deps` that order the run and fold into no key:
   * `--exclude-dependencies` dropped a task between this one and them
   * (`excludeDependencies`). The dropped task's derived key already folds
   * theirs, so folding them again would give a key no full run derives.
   */
  orderOnly?: string[]
  /**
   * True for the tasks the user actually asked for (via cwd, `--all`,
   * `--filter`, or `pkg#task`). False for deps pulled in by `dependsOn`
   * expansion. Used by the orchestrator to scope `forwardArgs` so trailing
   * CLI args don't leak into upstream tasks the user didn't address.
   */
  requested: boolean
  /**
   * Display-only: a same-project, non-group, direct `dependsOn` task of
   * a REQUESTED GROUP. A group produces no output of its own, so in
   * focused flow we surface the work it stands for one level down (no
   * recursion, no `^`/cross-project deps — see `markSurfacedDeps`). The
   * focused logger shows these like requested tasks; it does NOT make
   * them `requested`, so `forwardArgs` scoping is unaffected.
   */
  surfaced?: boolean
  /**
   * Extra cache-key material from plugins' `key` stage, as sorted
   * `[name, value]` pairs; set by `prepareRun`, folded by `Cache.key`.
   * Absent when no plugin declares the stage.
   */
  keyParts?: ReadonlyArray<readonly [name: string, value: string]>
  /**
   * The platform this run runs it on, when it declares `exec.platforms`:
   * set by placement, folded into its key.
   */
  platform?: string
  /**
   * Ids of upstream tasks whose declared outputs this task's outputs
   * overlap: this task ADDS to their trees (twenty's `build:individual`
   * into `build`'s `dist`; item 588). Its own output set is what its run
   * added or changed, it cleans and restores only its recorded rows, and
   * it is never restore-tier. Set by `detectOutputCollisions`, which refuses
   * the same overlap without an edge.
   */
  addsToOutputsOf?: string[]
  /**
   * Declared output globs of dependants that add into this task's tree.
   * The hit path ignores paths they match when it decides whether this
   * task's tree is already current, so an addition below is not a stray.
   */
  outputsAddedToBy?: string[]
  /**
   * The dependencies `--exclude-dependencies` took out of the schedule, as
   * outcomes carrying the key each would have (`excludeDependencies`, then
   * `prepareRun`). The scheduler never sees them; the key folds them next
   * to `deps`' own outcomes, so a key is the same whatever the selection.
   */
  excludedUpstream?: TaskOutcome[]
}

export function taskId(project: string, task: string): string {
  return `${project}#${task}`
}

// `splitTaskId` lives in util so the cache (which may not import graph)
// reads the same rule instead of a copy; re-exported here because the
// graph is where every reader of a task id looks for it.
export { splitTaskId } from '../util/index.js'

/**
 * A keyed group that is only its dependencies' own `name` (`^name`): the
 * default `build` (orchestrator/projects.ts), or a config's of that shape.
 * Only this shape walks last on a package cycle and is passed through.
 * Any keyed group was: `ci` keyed on `lint` lost its edge and ran nothing,
 * and `deploy` on `^build` walked `^deploy`.
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
 * Mark, for focused-flow display, the real tasks a requested GROUP
 * stands for. A group has no output of its own, so `vx run build`
 * (where `build` is a group) would otherwise print nothing.
 *
 * Walk `dependsOn` from the requested group, DESCENDING THROUGH nested
 * same-project groups (e.g. `build` → `build.bun` → `build.bun.*`), and
 * surface the first non-group task on each path. Two hard limits:
 *   - never leave the requested project — `^`/cross-project deps are
 *     not entered (the user asked to run THIS project's group),
 *   - never descend past a real task — its own `dependsOn` is its
 *     implementation detail, not work the group "is".
 *
 * Display-only: it never flips `requested`, so `forwardArgs` scoping
 * stays put. Returns the count of newly surfaced nodes.
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
 * Expand the user-requested task list into concrete `{project, task}`
 * pairs the graph builder consumes.
 *
 *   - Bare task names (`'build'`) → one entry per project in
 *     `candidates` that declares the task. Missing in a given project
 *     is silent (sparse tasks are normal across a workspace). A task
 *     `unselected` holds (the default `build`) is no match.
 *   - Anchored entries (`'pkg#task'`) → one entry exactly, ignoring
 *     `candidates`. Silently dropped if pkg/task doesn't exist (the
 *     CLI's pre-validation catches malformed strings).
 *
 * Duplicates are deduped (a user might pass `vx run build pkg#build`).
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
 * The task a config declares under `name`, by OWN property. `tasks` is a
 * plain object, so `tasks['constructor']` and `tasks['toString']` are
 * Object.prototype's: `vx show constructor` printed a group task for every
 * project and `vx run a#toString` ran nothing, exit 0 (item 897).
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
 * The requested specs `expandRequested` silently dropped — each one
 * matched NO project, so nothing it asked for will run.
 *
 * A bare name matching only SOME projects is normal (sparse tasks across
 * a workspace) and never reported. An empty `candidates` scope is also
 * never reported: that is the legitimate "nothing selected" outcome
 * (`--affected` with nothing changed), not a typo — the CLI's selection
 * layer owns that message.
 *
 * Deduped so `vx run x x` names `x` once.
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
   * Set when `projects` is a scoped load rather than the whole workspace. A
   * literal `^name` no project in `projects` declares may still be declared
   * by one that was not loaded, so the builder hands it here instead of
   * refusing it, and the caller judges it against the rest
   * (`undeclaredDepsError` is the refusal). Unset, `projects` is the whole
   * workspace and the builder refuses it itself.
   */
  undeclaredDeps?: (taskId: string, name: string) => void
  /**
   * The workspace root, where `cache.outputs.workspaceFiles` is anchored.
   * Given, a root-anchored output is also compared with every project's
   * `files` outputs (item 1088); absent (a graph built for a unit row), only
   * with other root-anchored ones.
   */
  workspaceRoot?: string
  /** The workspace's `run.rules`; each is on unless set to `false`. */
  rules?: GraphRules | undefined
}

/**
 * `run.rules` as the graph applies them. `locked`: a run, which never
 * checks them; `vx lock` and `vx lock --check` do (2026-10-14).
 */
export type GraphRules = WorkspaceRules & { readonly locked?: boolean }

/**
 * The refusal of a literal `^name` that no project in the workspace
 * declares: it has no holder anywhere, so it can only be a typo (nx#32779
 * ran such an edge as no edge, green). A name SOME project declares stays
 * legal without a holder — a preset spreads `^build` over projects whose
 * dependencies lack it.
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

  // The walk keeps its own stack instead of recursing once per edge: a
  // `dependsOn` chain or ring ~20,000 deep overflowed V8's call stack
  // (nx#28788's shape) before `detectCycle` could name the cycle. It adds
  // nodes in the order the recursion did — depth-first, each target's
  // subtree before the next target — and `detectCycle` walks that order,
  // so it names the same cycle. Resolving an entry only reads configs and
  // the package graph, so its targets can all be found first: the first
  // new one is added at once (its subtree is expanded next, on top of the
  // stack), the later ones wait in `pending` for their turn.
  const stack: Frame[] = []

  function add(node: TaskNode): void {
    nodes.set(node.id, node)
    if (isChainGroup(node.config, node.taskName) && onCycle(node.projectName)) deferred.push(node)
    else if ((node.config.dependsOn?.length ?? 0) > 0) {
      stack.push({ node, entry: 0, added: false, pending: null, next: 0 })
    }
  }

  // Adds `projectName#taskName` to the graph if it is new, and the edge to
  // it from `frame`'s task (null for a requested task). False when the
  // project or the task is not declared.
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

  // Package cycles, for the default `build` (`isChainGroup`): each project
  // on one maps to its strongly connected component, found on the first ask
  // (iterative Tarjan over `directDeps`, the order the `^name` walk reads).
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

  // `^name` from `start`: edges to the nearest holders of `name` among the
  // packages below it, passing through the ones `visited` holds and the
  // ones that declare no `name`, and on past a default build on a cycle.
  // True when it found a holder.
  function walkHolders(frame: Frame, name: string, visited: Set<string>, start: string): boolean {
    const frontier = [...packageGraph.directDeps(start)]
    let held = false
    while (frontier.length > 0) {
      const target = frontier.pop()!
      if (visited.has(target)) continue
      visited.add(target)
      if (visit(frame, target, name, false)) {
        held = true
        const task = declaredTask(projects.get(target)!.config, name)!
        if (isChainGroup(task, name) && onCycle(target)) {
          frontier.push(...packageGraph.directDeps(target))
        }
      } else frontier.push(...packageGraph.directDeps(target))
    }
    return held
  }

  // An edge by name (`build`, `pkg#build`) or pattern (`bui*`, `^bui*`) to
  // a default build on a package cycle goes on past it as a `^build` walk
  // does: that build folds nothing of the builds on its cycle, so `a#test`
  // on `build` with `a` ↔ `b` both on the default build folded none of `b`
  // and hit after `b` changed.
  function goPast(frame: Frame, project: string, name: string, visited: Set<string>): void {
    const task = declaredTask(projects.get(project)!.config, name)!
    if (isChainGroup(task, name) && onCycle(project)) walkHolders(frame, name, visited, project)
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

    // dependsOn is about which tasks to ADD to the graph, not which
    // to filter. BARE wildcards ("*"/"^*" = "everything upstream") and
    // negation aren't meaningful here — they're inputs.tasks
    // operations. PARTIAL patterns (`build.*`, `^build.*`) are legal:
    // they name a namespace of tasks to add (Nx 19.5 parity).
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
        // `build.*` — every OTHER same-project task matching the
        // pattern (the declaring task never matches itself — that
        // would be an instant self-cycle). Zero matches is legal: a
        // preset-spread pattern needn't match in every project.
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
      // Nearest-holder frontier (Turbo/Nx direct-deps parity +
      // sparse bridging): walk the package dep graph from this
      // project's direct deps; each path stops at the FIRST package
      // declaring the task — a holder's own dependsOn is responsible
      // for anything deeper. Packages without the task are passed
      // through so a sparse dep doesn't break ordering to deeper
      // holders. The visited set both dedupes shared subtrees and
      // terminates on package-graph cycles (legal in PMs).
      //
      // With a pattern (`^build.*`), a holder is a package declaring
      // AT LEAST ONE matching task and it receives edges to ALL its
      // matches — holder-ness is about declaration, so a holder still
      // stops the walk even when `--exclude-dependencies` drops every
      // edge to it (`excludeDependencies`).
      //
      // The declaring project seeds `visited`: package graphs may legally
      // contain cycles (the common "b devDepends on a for its tests"
      // shape), and a cycle walks the frontier straight back to the
      // origin. Mirrors the self-pattern rule above — a task can never
      // depend on itself.
      //
      // The default `build` sits on every project, so on a package cycle it
      // would make a task cycle no config declares. One on a cycle walks
      // last (`resolveDeferred`), and a walk that meets it on a cycle takes
      // the edge and goes on past it, so the builds it could not depend on
      // still come first.
      //
      // With no edge source every `^` resolves to nothing and its upstream
      // folds into no key: a stale hit, green. With one, a project with no
      // deps is a leaf. The default `build`'s `^build` is no exception: a
      // task behind it would fold no upstream either.
      if (!packageGraph.edgeSource) {
        throw new UserError(
          `${id}: ${isDefaultBuild(node.config) ? `${projectName} declares no build, so it is the default build, whose ` : ''}^${spec.task} needs project edges; add pnpm()/bun()/npm()/yarn() and install so its lockfile exists, or a plugin that returns \`deps\``,
          'VX_E_DEPENDS_ON',
        )
      }
      const visited = new Set<string>([projectName])
      if (!isTaskPattern(spec.task)) {
        const held = walkHolders(frame, spec.task, visited, projectName)
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
        throw new UserError(
          `${id}: dependsOn ${taskId(spec.project, spec.task)} but no such project or task is declared`,
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
      // Stable ordering for deterministic scheduling and cache keys — deduped:
      // a target named twice (an exact entry + a pattern matching it, or a
      // literal duplicate) must contribute ONE edge, not a double-folded
      // upstream hash and a doubled DOT edge.
      node.deps = [...new Set(node.deps)].sort()
      stack.pop()
    }
  }

  for (const { project, task } of requested) {
    visit(null, project, task, true)
    drain()
  }

  // A default build on a package cycle: its `^build` walk, run once the
  // graph holds everything else. A build on its cycle that reaches it is
  // passed through (an edge to it would close a task cycle no config
  // declares); one that does not is a holder like any other, so the default
  // build waits for it and folds its key. Passed through unasked, `p#test`
  // on `p#build` ran beside a `t#build` on no `^build` and hit after `t`
  // changed. A build no other edge brought is expanded to ask, and pruned
  // again when it reaches back. Each walk sees the edges the ones before it
  // took, so no edge closes a cycle.
  let expanded = false
  const resolveDeferred = (x: TaskNode): void => {
    // The default build's one entry is `^` and its own name.
    const name = x.taskName
    const frame: Frame = { node: x, entry: 0, added: false, pending: null, next: 0 }
    let reaching: Set<string> | null = null
    const visited = new Set<string>([x.projectName])
    const frontier = [...packageGraph.directDeps(x.projectName)]
    while (frontier.length > 0) {
      const target = frontier.pop()!
      if (visited.has(target)) continue
      visited.add(target)
      const task = declaredTask(projects.get(target)?.config, name)
      if (task === undefined) {
        frontier.push(...packageGraph.directDeps(target))
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
          frontier.push(...packageGraph.directDeps(target))
          continue
        }
      }
      const size = nodes.size
      frame.added = false
      visit(frame, target, name, false)
      drain()
      if (nodes.size !== size) reaching = null
      if (isChainGroup(task, name) && onCycle(target))
        frontier.push(...packageGraph.directDeps(target))
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
  return nodes
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
 * What a task graph must hold before it is scheduled: each node under its
 * own id, every dep a node, no cycle, and no two tasks deleting each
 * other's outputs. The builder's output holds the first two by
 * construction; the `graph` stage runs this again after its plugins, which
 * could move a node to another key (the scheduler then died on a raw
 * TypeError) or drop the edge that made two overlapping outputs an
 * addition, and a green run lost one task's files (item 981). The addition
 * marks are derived here, so they are cleared first and follow the edges
 * the graph has now.
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
    delete node.addsToOutputsOf
    delete node.outputsAddedToBy
  }
  for (const node of nodes.values()) refuseSelfClean(node)
  detectCycle(nodes)
  const exclusive = rules?.exclusiveOutputs !== false
  const locked = rules?.locked === true
  // Under a lock an exclusive graph has no overlap to mark; a non-exclusive
  // one still needs the addition marks the walk derives.
  if (!locked || !exclusive) detectOutputCollisions(nodes, workspaceRoot, exclusive)
  if (!locked) detectInputOverlaps(nodes, workspaceRoot)
}

/**
 * `--exclude-dependencies`: take `dependsOn` edges out of the SCHEDULE, not
 * out of the graph. `'all'` drops every edge; a name list drops each edge
 * whose target task has one of those names, whichever `dependsOn` form
 * reached it. What stays scheduled is what the requested tasks still reach;
 * the rest leaves `nodes` and is returned with its `deps` intact, and each
 * scheduled task that lost an edge is listed in `dropped` with the ids it
 * lost. An edge to a task that stays scheduled (requested itself, or
 * reached another way) is kept: the two still run in order.
 *
 * Under `'all'` a group's own edges stay: a group is its members (running
 * one is running them), so `vx run ci --exclude-dependencies` runs what
 * `ci` names without what THEY depend on. Dropping them left the group
 * alone, and the run ran nothing and exited 0 (item 894). A name list
 * still drops a group's edge it names: `--exclude-dependencies=lint.oxfmt`
 * takes one member out of `lint`.
 *
 * Run on the whole graph, after the `graph` and `key` stages, because a
 * dropped dependency is still KEYED: a key is a function of inputs, never of
 * the selection (nx#35234), so the caller derives each dropped task's key
 * as a full run would and hands it to the dependant (`excludedUpstream`).
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
    // An edge to a task this run schedules anyway stays: dropped, the two
    // ran unordered, and `a#build` read `b`'s output mid-rewrite or from
    // the run before (item 980). Only an edge to a task that leaves the
    // schedule is taken out.
    const kept = keptBy(node)
    const stays = (d: string): boolean => kept(d) || scheduled.has(d)
    const lost = node.deps.filter((d) => !stays(d))
    if (lost.length === 0) continue
    dropped.set(id, lost)
    node.deps = node.deps.filter(stays)
    // A scheduled task reached through a dropped one still runs first: in
    // `test → gen → build` with `gen` excluded and `build` requested, the
    // edge to `gen` went and nothing ordered `test` after `build`, so the
    // two ran at once (item 1019). The walk reads unscheduled nodes only,
    // whose deps this loop leaves as they are.
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
 * True only when two output globs PROVABLY select an overlapping set.
 *
 * Deliberately conservative, because the caller REFUSES the run: a false
 * positive breaks a build that works today, which is worse than the defect
 * being caught. So the three cases are exactly the ones that can be decided
 * without a general glob-intersection algorithm:
 *
 *   both literal    — equal paths
 *   literal vs glob — ask the glob whether it matches the literal (exact)
 *   both globs      — identical strings, or one a whole subtree `P/**`
 *                     and the other's literal prefix P or under it: every
 *                     path the second matches is under P, so the first
 *                     covers it (item 941). Anything else is undecided
 *                     here and deliberately allowed through
 *
 * The rejected alternative was comparing each glob's static prefix. It is
 * cheaper and catches more, but it is UNSOUND for a refusal — measured:
 * `dist/vx-*` and `dist/other.txt` share the prefix `dist` while matching
 * disjoint sets, so a prefix check refuses a legitimate config. (vx's own
 * `build.bun.*` tasks escape only because they declare distinct literals.)
 *
 * All three cases compare SPELLINGS, so each side is run through
 * `asTrees` first — the same rule the resolver and `cleanOutputs` read,
 * and `cleanOutputs` is what actually does the deleting. That folds two
 * things this check used to miss, both of them the data loss it exists to
 * prevent:
 *
 *   - the SPELLING: `./dist/**` and `dist/**` are one tree to every
 *     matcher in vx, and `Bun.Glob('dist/**')` does not match the literal
 *     `./dist/app.js` either (item 441, probed one spelling at a time);
 *   - the literal DIRECTORY: `outputs: ['dist']` means everything under
 *     `dist` — `asTrees` compiles it to `dist` + `dist/**` — while this
 *     compared it to `dist/app.js` as two unequal literals. Measured end
 *     to end: the task declaring `dist` wiped the other's `dist/app.js`
 *     and the run reported success (item 442).
 *
 * Neither is a widening. Both read the declaration the way the code that
 * deletes reads it, which is the only reading that decides the hazard.
 *
 * Exported through the façade because `@vzn/vx-migrate` asks the same
 * question at MIGRATION time — it uncaches the losers so the generated
 * config loads — and it used to ask it with a copy of this function. The
 * copy did not get items 441 and 442, so it reported clean on configs
 * core then refused, including `outputs: ['dist']` against
 * `dist/app.js`, which is the commonest turbo.json shape there is (item
 * 445). One rule, one place: the copy is gone.
 */
export function outputsOverlap(rawA: string, rawB: string): boolean {
  // Each brace alternative on its own: the checks below read a brace as
  // one opaque segment, so `build/{a,b}.js` met `build/*.js`, and
  // `dist/{esm,cjs}/**` met `**/*.js`, nowhere (fuzz, 2026-10-25).
  const as = braceAlternatives(rawA)
  const bs = braceAlternatives(rawB)
  if (as.length === 1 && bs.length === 1) return overlapOne(rawA, rawB)
  return as.some((a) => bs.some((b) => overlapOne(a, b)))
}

function overlapOne(rawA: string, rawB: string): boolean {
  // A built path proves overlap only between globs as written: a literal's
  // `/**` twin reads it as a directory, and `dist/types.d.ts` met
  // `dist/**/*.js` at `dist/types.d.ts/x.js`, a file no one can write.
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
 * Do two globs both match a path built from them? Each candidate is a
 * real path, so a hit proves the overlap and a miss decides nothing. The
 * path sits under the deeper of the two literal prefixes and ends in
 * either glob's last segment with its wildcards filled: a glob for every
 * `.js` file under `dist` beside `dist/sth/**` meets at `dist/sth/x.js`,
 * a pair `covers` cannot decide since neither is a subtree holding the
 * other's prefix.
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
  // Each glob filled in whole, every wildcard a name and `**` one level or
  // none: `**/dist/**` beside `**/*` meets at `x/dist/x`, a path neither
  // last segment builds (solid, 2026-10-15).
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
 * A path both globs take, built segment by segment, each a name both
 * segments take, `**` matching a segment of the other or none: `out/**`
 * beside every `.d.ts` in a `types` directory one level down meets at
 * `out/types/x.d.ts`, and `*` beside `[ab]` at `a`, paths neither glob
 * filled alone builds (fuzz, 2026-10-25). Null when none is found; a find
 * is checked whole after.
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
 * Does the whole-subtree glob `tree` (`P/**`) match every path `glob` can?
 * It does when `glob`'s literal prefix is P or a directory under it. Left
 * undecided, `dist/**` beside `dist/extra/**` was no overlap: each task
 * cleaned and restored the other's files, and a hit of the wide one put
 * back its own stale copy of the narrow one's output under a green run
 * (item 941).
 */
const WHOLE_ROOT = new Set(['**', '**/*'])

function covers(tree: string, glob: string): boolean {
  // The root's own tree has no directory to name: `**` beside a `!` that
  // spared the config cleaned every source under it, and the refusal of
  // a task's own sources as outputs never fired.
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
 * Refuse a graph in which two tasks declare overlapping outputs.
 *
 * vx cleans a task's declared outputs before it runs AND before a cache-hit
 * restore, so that the tree ends byte-identical to the cached artifact. That
 * makes output ownership STRICT — and two tasks claiming the same path
 * silently destroy each other's work, in whichever order they happen to run,
 * while the run reports success. It is data loss with a green summary.
 *
 * This is a hazard vx CREATED: Turbo restores additively and cannot hit it,
 * which is why no Turbo test surfaces it and why the parity research had to
 * reproduce it end to end.
 *
 * Scope follows the two namespaces' reach. `outputs.files` is
 * project-relative, so only tasks in the SAME project can collide;
 * `outputs.workspaceFiles` is anchored at the workspace root and ignores
 * project boundaries by design, so ANY two tasks can. No cache key changes —
 * this only refuses a graph that was already destroying files.
 */
function detectOutputCollisions(
  nodes: Map<string, TaskNode>,
  workspaceRoot: string | undefined,
  exclusive: boolean,
): void {
  // Does `from` reach `to` through deps? Asked only for a colliding pair,
  // so the walk is rare; memoised per source across the detector's calls.
  const reachMemo = new Map<string, Set<string>>()
  const reaches = (from: string, to: string): boolean => {
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
  // INDEX FIRST, then compare — never all-pairs over the graph. A naive
  // pairwise loop that filters by project INSIDE the loop is quadratic in the
  // whole graph: measured 1.6 SECONDS at this project's stated target of 1000
  // projects x 10 tasks, on every run, against a ~120ms warm run. (Same shape
  // as the scheduler's priority closure, which took 8.5s on a 1090-package
  // repo before it was rewritten.)
  //
  // Both namespaces have a much smaller natural domain:
  //   files          — project-relative, so only same-project tasks can
  //                    collide.
  //   workspaceFiles — root-anchored and boundary-free, so any two tasks can
  //                    collide — but only tasks that DECLARE it participate.
  // Within a domain all pairs was still quadratic in ONE project's tasks
  // (4,000 with outputs spent 10.7 s here, item 741), so each domain is
  // indexed again by path (`overlapCandidates`) and only the pairs that can
  // overlap are compared, in the order the all-pairs loop met them.
  const byProject = new Map<string, TaskNode[]>()
  const wsDeclarers: TaskNode[] = []
  for (const n of nodes.values()) {
    const outs = n.config.cache?.outputs
    if ((outs?.files?.length ?? 0) > 0) {
      const bucket = byProject.get(n.projectName)
      if (bucket) bucket.push(n)
      else byProject.set(n.projectName, [n])
    }
    if ((outs?.workspaceFiles?.length ?? 0) > 0) wsDeclarers.push(n)
  }

  // Where each task's outputs MIGHT land: its positive globs. A `!` entry
  // only narrows, so leaving it out can refuse a pair it separates, never
  // pass one it does not (A-44); read as a glob it is `Bun.Glob`'s own
  // negation, which overlaps nearly everything.
  const positiveOf = (globs: readonly string[] | undefined): readonly string[] | undefined =>
    globs === undefined ? undefined : splitNegations(globs).positive
  const filesOf = (n: TaskNode): readonly string[] | undefined =>
    positiveOf(n.config.cache?.outputs.files)
  const wsFilesOf = (n: TaskNode): readonly string[] | undefined =>
    positiveOf(n.config.cache?.outputs.workspaceFiles)
  for (const bucket of byProject.values()) {
    // Most projects hold one task with outputs, and a call per project
    // cost the cold build a measured 0.4 ms at 1,000 projects.
    if (bucket.length < 2) continue
    for (const [i, j] of overlapCandidates(bucket, filesOf)) {
      const a = bucket[i]!
      const b = bucket[j]!
      collide(a, b, filesOf(a), filesOf(b), 'files', reaches, exclusive)
    }
  }
  if (wsDeclarers.length >= 2) {
    for (const [i, j] of overlapCandidates(wsDeclarers, wsFilesOf)) {
      const a = wsDeclarers[i]!
      const b = wsDeclarers[j]!
      collide(a, b, wsFilesOf(a), wsFilesOf(b), 'workspaceFiles', reaches, exclusive)
    }
  }
  // A root-anchored output that reaches into ANOTHER project's `files`
  // outputs was compared with neither: `a` writing `packages/b/dist/a.txt`
  // beside `b`'s `dist/**` had its file deleted by `b`'s clean and still
  // replayed `up-to-date` (item 1088). Each `files` declarer joins the
  // root-anchored domain with its globs rebased to the root, and only the
  // mixed pairs are compared.
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
  for (const [i, j] of overlapCandidates(entries, (e) => e.globs)) {
    const x = entries[i]!
    const y = entries[j]!
    if ((x.rel === undefined) === (y.rel === undefined) || x.node === y.node) continue
    const [ws, files] = x.rel === undefined ? [x, y] : [y, x]
    collideAcross(ws.node, ws.globs, files.node, files.globs, files.rel!, reaches, exclusive)
  }
}

/**
 * What a task's `!` output entries take back (A-44). A glob of the other
 * task's that one takes back whole is a path this task never cleans or
 * captures, so the pair cannot collide there.
 */
function takenBackOf(n: TaskNode, field: 'files' | 'workspaceFiles'): string[] {
  return splitNegations(n.config.cache?.outputs[field] ?? []).negative
}

/**
 * `collide` for a root-anchored output against another project's `files`
 * output rebased to the root. With an edge the dependant adds to its
 * upstream's tree, and the upstream is told the dependant's globs in its
 * OWN namespace: root-relative for the root-anchored side, project-relative
 * for the `files` side, where a glob that does not start in that project
 * cannot be told apart and the pair is refused.
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
        `${ws.id} declares the output ${JSON.stringify(ga)} in cache.outputs.workspaceFiles, ` +
        `inside ${files.id}'s ${JSON.stringify(gb.slice(rel === '' ? 0 : rel.length + 1))} in ` +
        `cache.outputs.files — vx cleans a task's declared outputs before it runs and before a ` +
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
            `cache.outputs.workspaceFiles entry inside ${rel === '' ? 'the workspace root' : rel}, ` +
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
 * something other than itself. `*?{}` are the task-glob wildcards; `\`
 * escapes (`x\y/*` matches `xy/a`), and a leading `!` negates (`!a/**`
 * matches `b`). Ending early only widens the candidate set. A fuzz of
 * nearly four million glob/literal pairs (over 400,000 of them matching)
 * found no match outside the head this cuts, and thousands once `\` and
 * `!` were left out (item 746).
 */
const GLOB_HEAD_END = /[*?{}[\]\\!]/

/** `firstSegment`'s answer for a glob that can start anywhere. */
const ANYWHERE = ''

/** Where a glob's first segment ends: a separator, or anything `GLOB_HEAD_END` stops at. */
const FIRST_SEGMENT_END = /[*?{}[\]\\!/]/

const firstSegments = new Map<string, string>()

/**
 * The first path segment every path a glob (or its `asTrees` twin) can
 * match starts with, or `ANYWHERE`. A task glob matches whole paths, so
 * two globs with different first segments select disjoint sets, and none
 * of `outputsOverlap`'s three cases can hold for them. Memoised by the
 * raw string: a pure function, and one glob (`src/**`) recurs in every
 * project.
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
 * False only when no pair `overlapCandidates` could return can overlap:
 * every glob starts in a named segment and no two members (on different
 * sides, given `sideOf`) share one. The per-project buckets are nearly
 * all of this shape (`src/**` read, `dist/**` written), and building the
 * indexes for each cost the warm run's graph stage tens of milliseconds
 * at 1,090 projects (X-148).
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
 * The pairs `[i, j]`, `i < j`, of `tasks` whose declared outputs CAN
 * overlap, ascending by `i` then `j`: a superset of the pairs
 * `outputsOverlap` accepts, so `collide` over them decides exactly what it
 * decided over all pairs, and in the same order (the first refusal named,
 * and the addition marks pushed, are all-pairs' own).
 *
 * `outputsOverlap` compares the `asTrees` forms three ways. Two equal
 * globs are one lookup. Two equal literals are too, since each literal
 * carries its `/**` twin. And a glob matches a literal only when the
 * literal lies under the directory the glob's literal head names
 * (`dist/sub/**` → `dist/sub`; `*.js` → the root, so a wildcard in the
 * first segment meets every literal): a literal meets the globs filed at
 * each of its ancestors. The fuzz above found no glob matching the
 * directory its own head names. A whole subtree meets the globs whose
 * literal prefix lies at or under it, found the same way from the glob's
 * side (item 941).
 *
 * Given `sideOf`, only the pairs whose members sit on different sides are
 * wanted (a reader and a writer, `detectInputOverlaps`), and each index is
 * kept per side, so a member looks up only the other side's: thousands of
 * readers sharing one input (`src/**`, a root `tsconfig.base.json`) were
 * paired with each other, millions of pairs no rule judges (X-101).
 */
function overlapCandidates<T>(
  tasks: readonly T[],
  globsOf: (n: T) => readonly string[] | undefined,
  sideOf?: (n: T) => boolean,
): Array<[number, number]> {
  if (!mayOverlap(tasks, globsOf, sideOf)) return []
  const sides = sideOf === undefined ? 1 : 2
  // The index a member of side `s` looks up: its own side's, or the other's.
  const across = (s: number): number => (sides === 1 ? s : 1 - s)
  const perSide = (): Array<Map<string, number[]>> =>
    Array.from({ length: sides }, () => new Map<string, number[]>())
  const globs = perSide()
  const globsUnder = perSide()
  const literals: Array<[task: number, path: string]> = []
  // `covers` (item 941): a whole subtree `P/**` meets every glob whose
  // literal prefix is P or under it, so each glob looks up the subtrees
  // filed at its prefix and at each of that prefix's ancestors.
  const subtrees = perSide()
  const prefixes: Array<[task: number, prefix: string]> = []
  const file = (index: Map<string, number[]>, key: string, i: number): void => {
    const list = index.get(key)
    if (list === undefined) index.set(key, [i])
    else list.push(i)
  }
  const side: number[] = []
  for (let i = 0; i < tasks.length; i++) {
    const s = sideOf?.(tasks[i]!) === true ? 1 : 0
    side.push(s)
    // Each brace alternative, as `outputsOverlap` reads them.
    for (const tree of asTrees((globsOf(tasks[i]!) ?? []).flatMap(braceAlternatives))) {
      const lit = literalPath(tree)
      if (lit !== null) {
        literals.push([i, lit])
        continue
      }
      file(globs[s]!, tree, i)
      const dir = wholeSubtreePrefixes([tree])?.[0]
      if (dir !== undefined) file(subtrees[s]!, dir, i)
      prefixes.push([i, staticPrefix(tree)])
      const head = tree.slice(0, tree.search(GLOB_HEAD_END))
      file(globsUnder[s]!, head.slice(0, Math.max(0, head.lastIndexOf('/'))), i)
    }
  }
  const n = tasks.length
  const pairs = new Set<number>()
  const pair = (x: number, y: number): void => {
    if (x !== y) pairs.add(x < y ? x * n + y : y * n + x)
  }
  for (const [tree, list] of globs[0]!) {
    const other = sides === 1 ? list : (globs[1]!.get(tree) ?? [])
    for (let x = 0; x < list.length; x++) {
      for (let y = sides === 1 ? x + 1 : 0; y < other.length; y++) pair(list[x]!, other[y]!)
    }
  }
  // `witnessed`: two globs meet only when one's literal prefix is the
  // other's or under it, so each looks up the globs filed at its prefix
  // and at each ancestor.
  const byPrefix = perSide()
  for (const [i, prefix] of prefixes) file(byPrefix[side[i]!]!, rootless(prefix), i)
  for (const [i, raw] of prefixes) {
    const index = byPrefix[across(side[i]!)]!
    const prefix = rootless(raw)
    for (const j of index.get(prefix) ?? []) pair(i, j)
    if (prefix !== '') for (const j of index.get('') ?? []) pair(i, j)
    for (let sep = prefix.indexOf('/'); sep !== -1; sep = prefix.indexOf('/', sep + 1)) {
      for (const j of index.get(prefix.slice(0, sep)) ?? []) pair(i, j)
    }
  }
  for (const [i, prefix] of prefixes) {
    const index = subtrees[across(side[i]!)]!
    for (const j of index.get(prefix) ?? []) pair(i, j)
    for (let sep = prefix.indexOf('/'); sep !== -1; sep = prefix.indexOf('/', sep + 1)) {
      for (const j of index.get(prefix.slice(0, sep)) ?? []) pair(i, j)
    }
  }
  for (const [i, path] of literals) {
    const index = globsUnder[across(side[i]!)]!
    for (const j of index.get('') ?? []) pair(i, j)
    for (let sep = path.indexOf('/'); sep !== -1; sep = path.indexOf('/', sep + 1)) {
      for (const j of index.get(path.slice(0, sep)) ?? []) pair(i, j)
    }
  }
  return [...pairs].sort((x, y) => x - y).map((p) => [Math.floor(p / n), p % n])
}

/**
 * A `remote: 'only'` task never materialises its outputs on THIS machine —
 * execute-task turns off both the read and the write axis for it, so there is
 * no probe, no restore, no output clean and no local save. The collision
 * hazard is entirely about local cleaning ("whichever runs second DELETES the
 * other's output"), so a pair including one of these cannot exhibit it: there
 * is nothing of its on disk to delete, and it deletes nothing of anyone's.
 *
 * Found while trying to give two projects their own install-as-an-action:
 * both legitimately capture the workspace-root `node_modules` under a
 * hoisting package manager, and the refusal fired on a pair that cannot
 * exhibit the hazard. That particular layout was abandoned for an unrelated
 * reason (identical definitions still get different cache keys), so this is
 * not load-bearing today — it is a refusal narrowed to what it can prove,
 * which this file's header asks for explicitly.
 */
function neverWritesLocally(n: TaskNode): boolean {
  return n.config.exec?.remote === 'only'
}

/**
 * The way out of an edge-ordered overlap under `run.rules.exclusiveOutputs`: an
 * ordered pair is correct (the addition shape, item 588), only slower to
 * clean and restore, so the rule may be turned off.
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
        ` in cache.outputs.${field} — vx cleans a task's declared outputs before it runs and ` +
        `before a cache-hit restore, so whichever of these runs second DELETES the other's ` +
        `output`
      // An overlap WITH an edge is the addition shape (item 588): the
      // dependant runs after its upstream and adds to that tree, so the
      // order is fixed and the dependant's own set can be told apart from
      // what it found. Marked on both, and the pair is allowed when
      // `run.rules.exclusiveOutputs` is off (X-53). Without an edge the two run
      // in either order, and the refusal below stands.
      const [up, down] = reaches(b.id, a.id) ? [a, b] : reaches(a.id, b.id) ? [b, a] : []
      const parts = {
        headline: `${a.id} and ${b.id} both write ${ga === gb ? ga : `${ga} / ${gb}`}`,
        ...(field === 'files' ? {} : { what: ['in cache.outputs.workspaceFiles'] }),
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
          (field === 'files'
            ? down.config.cache?.outputs.files
            : down.config.cache?.outputs.workspaceFiles) ?? [],
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
 * Does the `!` set `negatives` take back every path the output glob
 * `output` can select? Each of the output's `asTrees` forms must be one of
 * the negatives' forms, sit inside a negative whole subtree (`covers`), or,
 * as a literal, be matched by one. Sound and no more: an output only partly
 * taken back answers false.
 */
export function outputTakenBack(output: string, negatives: readonly string[]): boolean {
  if (negatives.length === 0) return false
  const neg = asTrees(negatives)
  return asTrees([output]).every((t) =>
    neg.some((n) => n === t || covers(n, t) || (isLiteralPattern(t) && taskGlob(n).match(t))),
  )
}

/**
 * A task whose input entry its own outputs take back whole cleans its own
 * sources: vx removes a task's outputs before it runs, so a formatter
 * declaring `src/**` as both deleted every committed file under `src`,
 * and its key read nothing (hunt 8). Always refused, whatever the rules.
 */
function refuseSelfClean(node: TaskNode): void {
  const cache = node.config.cache
  const declared = node.config.inputs
  if (cache === undefined || declared === undefined) return
  for (const field of ['files', 'workspaceFiles'] as const) {
    if (!coversAny(declared[field], cache.outputs[field])) continue
    const inputs = splitNegations(declared[field] ?? [])
    const out = splitNegations(cache.outputs[field] ?? [])
    const outputs = out.positive
    if (outputs.length === 0) continue
    const roots = outputs.map((g) => rootless(staticPrefix(g)))
    for (const gi of inputs.positive) {
      // Only an output rooted at or above the input's prefix can cover it;
      // the prefix test keeps the glob matchers off the common disjoint pair.
      const pi = rootless(staticPrefix(gi))
      const near = outputs.filter((_, k) => {
        const r = roots[k]!
        return r === '' || pi === r || pi.startsWith(`${r}/`)
      })
      // Taken back by the task's own `!` inputs, or by an output `!` (no
      // output, so never cleaned: A-44), the entry reads what it says.
      if (near.length === 0 || outputTakenBack(gi, inputs.negative)) continue
      if (outputTakenBack(gi, out.negative)) continue
      if (!outputTakenBack(gi, near)) continue
      throw new UserError(
        `${node.id}: every file ${JSON.stringify(gi)} in inputs.${field} selects is also ` +
          `its own output — vx removes a task's outputs before it runs, so the task would ` +
          `delete its own sources. A task that rewrites files in place (a formatter) declares ` +
          `no outputs.`,
        'VX_E_INPUT_IS_OUTPUT',
      )
    }
  }
}

/**
 * False only when no positive output can cover a positive input: each
 * starts in a named first segment and no input shares one with an output
 * (`firstSegment`). The common task reads `src/**` and writes `dist/**`.
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
 * Refuse a task whose input globs can match another task's declared
 * outputs (X-54; no opt-out, 2026-10-16). Such a key reads bytes a
 * producer writes this run, so it is not known until the producer ran;
 * refused, every key reads only what no task writes and can be derived
 * before anything runs (2026-10-07: "hash ahead of time, not
 * waterfall"). A dependency's own key already cascades through
 * `dependsOn`, so the bytes it wrote add nothing a key needs; the one
 * exception is `refuseOverlaps`'s unfolded dependency.
 *
 * Proven overlaps only (`outputsOverlap`), as for outputs: a pair the rule
 * cannot decide passes, and the stability gate still keeps it waiting. The
 * scope mirrors `detectOutputCollisions`: `inputs.files` against another
 * same-project task's `outputs.files`; root-anchored `inputs.workspaceFiles`
 * against every other task's `outputs.workspaceFiles` and, with the root
 * known, its `outputs.files` rebased to the root; and, with the root known,
 * `inputs.files` rebased to the root against another task's
 * `outputs.workspaceFiles`, which may land in any project (X-135). A task's own outputs are
 * already subtracted from its inputs, and an output the reader's `!` entries
 * take back whole is no overlap. A keyed group is exempt: it runs nothing
 * (the default `build` reads `**` of a config-less dependency), and its
 * key waits as before.
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
    const cache = n.config.cache
    const inputs = n.config.inputs
    if (inputs === undefined) continue
    const outFiles = positives(cache?.outputs.files ?? [])
    const outWs = positives(cache?.outputs.workspaceFiles ?? [])
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
      const globs = positives(node.config.cache!.outputs.files).map((g) =>
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
 * Which overlaps stand. A reader may read the outputs of a task in its
 * `dependsOn` closure whose key its own does not fold (it sets
 * `inputs.tasks` and leaves the producer out, also through the tasks it
 * folds): its key waits for the producer and hashes the bytes
 * (2026-10-16). Otherwise an output git ignores whole is no overlap
 * (2026-10-15), a key reading only what git lists, unless the reader's
 * glob starts in an ignored path (`dist/**`): naming it is asking for it.
 * Git is asked once, for every output and prefix together; one it cannot
 * speak for is refused. The answer holds for the lock; a run's stability
 * gate asks git again for itself.
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
 * Whether a reader may read a writer's outputs: the writer is in the
 * reader's `dependsOn` closure and not in its folded closure. Each closure
 * walked once per reader.
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
 * Whether a reader's take-back list covers an output glob, asked once per
 * list and glob: a Turbo-mapped repo gives two thousand readers one
 * 400-entry list, and asking it per reader and writer pair was 2.7 s of an
 * astro plan (2026-10-09). One per `detectInputOverlaps` call.
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
    const cache = reader.node.config.cache
    // A reader rebased to the root (X-135) speaks in its project's terms.
    const at = reader.rel === undefined || reader.rel === '' ? '' : `${reader.rel}/`
    // What the reader's key never reads: its `!` entries and its own outputs.
    const list = [
      ...splitNegations(field === 'files' ? inputs.files : (inputs.workspaceFiles ?? [])).negative,
      ...splitNegations(
        field === 'files' ? (cache?.outputs.files ?? []) : (cache?.outputs.workspaceFiles ?? []),
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
              `${writer.node.id}'s output ${JSON.stringify(shown)} — a task's key must not read ` +
              `the outputs of a task it does not depend on, or whose key it already folds. ` +
              `Exclude it: add ${JSON.stringify(`!${out}`)} to ${reader.node.id}'s ` +
              `inputs.${field}, or depend on ${writer.node.id} and leave it out of ` +
              `${reader.node.id}'s inputs.tasks, so its key hashes those bytes instead.`,
            'VX_E_INPUT_IS_OUTPUT',
          ),
      })
      break
    }
  }
}

function detectCycle(nodes: Map<string, TaskNode>): void {
  // Iterative DFS over dense-indexed colors. Recursion + `Map<string,
  // number>` worked, but deep workspaces (long chains of `dependsOn`)
  // can blow V8's frame budget, and per-node Map lookups dominate the
  // pass. A Uint8Array indexed by node-position is allocation-free
  // and ~2× faster on cycle detection itself.
  // 0 = WHITE (unvisited) — the typed array's zero-init default.
  const GRAY = 1
  const BLACK = 2
  const idsArr = [...nodes.keys()]
  const idIdx = new Map<string, number>()
  for (let i = 0; i < idsArr.length; i++) idIdx.set(idsArr[i]!, i)
  const color = new Uint8Array(idsArr.length)

  // Each stack frame is `[idIndex, nextChildIdx]`. We mutate the
  // child index in place as children are visited so we know which one
  // to resume on when the leaf returns control here.
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
