import type { TaskConfig } from '../config.js'
import { asTrees, isLiteralPattern, taskGlob, UserError } from '../util/index.js'
import type { PackageGraph, ProjectEntry } from '../workspace/index.js'
import {
  DependencySpecError,
  compileTaskPattern,
  isTaskPattern,
  parseDependencySpec,
  type DependencySpec,
} from './dependency-spec.js'
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
 * A task is a "group" if it has no `exec` — it exists only to chain
 * `dependsOn` (an umbrella for `vx run ci`). Group tasks:
 *   - never spawn a process,
 *   - never read/write the cache (it's a config error to declare one),
 *   - never appear in the run summary or `runs` analytics table,
 *   - render no framed block in the live output.
 * Six call sites used to repeat `node.config.exec === undefined`;
 * centralising the predicate prevents that check from drifting.
 */
export function isGroupTask(node: TaskNode): boolean {
  return node.config.exec === undefined
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
 *     is silent (sparse tasks are normal across a workspace).
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
      if (declaresTask(projects, name, spec)) push(name, spec)
    }
  }
  return out
}

/** Shared by `expandRequested` + `unresolvedRequests` so the two can't drift. */
function declaresTask(projects: Map<string, ProjectEntry>, project: string, task: string): boolean {
  return projects.get(project)?.config.tasks?.[task] !== undefined
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
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const spec of tasks) {
    if (seen.has(spec)) continue
    const idx = spec.indexOf('#')
    const resolved =
      idx >= 0
        ? declaresTask(projects, spec.slice(0, idx), spec.slice(idx + 1))
        : candidates.length === 0 || candidates.some((name) => declaresTask(projects, name, spec))
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
}

/**
 * The refusal of a literal `^name` that no project in the workspace
 * declares: it has no holder anywhere, so it can only be a typo (nx#32779
 * ran such an edge as no edge, green). A name SOME project declares stays
 * legal without a holder — a preset spreads `^build` over projects whose
 * dependencies lack it.
 */
export function undeclaredDepsError(taskId: string, name: string): UserError {
  return new UserError(
    `Task ${taskId} depends on ^${name} but no project in the workspace declares ${name}`,
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
    if ((node.config.dependsOn?.length ?? 0) > 0) {
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
    const taskConfig = project.config.tasks?.[taskName]
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

  // Resolves one `dependsOn` entry of `frame`'s task into its edges.
  function resolveEntry(frame: Frame, raw: string): void {
    const { node } = frame
    const { id, projectName, taskName } = node
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
    // to filter. BARE wildcards ("*"/"^*" = "everything upstream") and
    // negation aren't meaningful here — they're cache.inputs.tasks
    // operations. PARTIAL patterns (`build.*`, `^build.*`) are legal:
    // they name a namespace of tasks to add (Nx 19.5 parity).
    if (spec.kind === 'wildcardSelf' || spec.kind === 'wildcardDeps') {
      throw new UserError(`Task ${id}: dependsOn does not accept bare wildcards (got "${raw}")`)
    }
    if (spec.negated) {
      throw new UserError(`Task ${id}: dependsOn does not accept negation (got "${raw}")`)
    }
    if (spec.kind === 'cross' && (isTaskPattern(spec.task) || isTaskPattern(spec.project))) {
      throw new UserError(
        `Task ${id}: dependsOn patterns are not supported in the "pkg#task" form (got "${raw}")`,
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
        }
      } else {
        // Missing target is a hard error — the user typed a name that
        // doesn't resolve in this project.
        if (!visit(frame, projectName, spec.task, false)) {
          throw new UserError(
            `Task ${id} depends on ${taskId(projectName, spec.task)} but no such task is declared`,
          )
        }
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
      const re = isTaskPattern(spec.task) ? compileTaskPattern(spec.task) : null
      const visited = new Set<string>([projectName])
      const frontier = [...packageGraph.directDeps(projectName)]
      let held = false
      while (frontier.length > 0) {
        const target = frontier.pop()!
        if (visited.has(target)) continue
        visited.add(target)
        if (re === null) {
          if (visit(frame, target, spec.task, false)) held = true
          else frontier.push(...packageGraph.directDeps(target))
        } else {
          const names = Object.keys(projects.get(target)?.config.tasks ?? {}).filter((n) =>
            re.test(n),
          )
          if (names.length > 0) {
            for (const name of names) visit(frame, target, name, false)
          } else {
            frontier.push(...packageGraph.directDeps(target))
          }
        }
      }
      // A pattern that matches nothing stays legal, as `build.*` does.
      if (re === null && !held && !declaredAnywhere(projectName, spec.task)) {
        if (undeclaredDeps === undefined) throw undeclaredDepsError(id, spec.task)
        undeclaredDeps(id, spec.task)
      }
    } else {
      // Cross-project edge: pkg#task. Missing target is a hard error
      // because the user named the package + task explicitly.
      if (!visit(frame, spec.project, spec.task, false)) {
        throw new UserError(
          `Task ${id} depends on ${taskId(spec.project, spec.task)} but no such project or task is declared`,
        )
      }
    }
  }

  for (const { project, task } of requested) {
    visit(null, project, task, true)
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

  detectCycle(nodes)
  detectOutputCollisions(nodes)
  return nodes
}

/**
 * `--exclude-dependencies`: take `dependsOn` edges out of the SCHEDULE, not
 * out of the graph. `'all'` drops every edge; a name list drops each edge
 * whose target task has one of those names, whichever `dependsOn` form
 * reached it. What stays scheduled is what the requested tasks still reach;
 * the rest leaves `nodes` and is returned with its `deps` intact, and each
 * scheduled task that lost an edge is listed in `dropped` with the ids it
 * lost.
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
  const kept = (dep: string): boolean => names !== null && !names.has(nodes.get(dep)!.taskName)
  const scheduled = new Set<string>()
  const stack = [...nodes.values()].filter((n) => n.requested).map((n) => n.id)
  while (stack.length > 0) {
    const id = stack.pop()!
    if (scheduled.has(id)) continue
    scheduled.add(id)
    for (const dep of nodes.get(id)!.deps) if (kept(dep)) stack.push(dep)
  }
  const keyOnly = new Map<string, TaskNode>()
  const dropped = new Map<string, string[]>()
  for (const [id, node] of nodes) {
    if (!scheduled.has(id)) {
      keyOnly.set(id, node)
      continue
    }
    const lost = node.deps.filter((d) => !kept(d))
    if (lost.length === 0) continue
    dropped.set(id, lost)
    node.deps = node.deps.filter(kept)
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
 *   both globs      — only identical strings; anything else is undecided
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
  for (const a of asTrees([rawA])) {
    for (const b of asTrees([rawB])) {
      if (isLiteralPattern(a) && isLiteralPattern(b)) {
        if (a === b) return true
      } else if (isLiteralPattern(a)) {
        if (taskGlob(b).match(a)) return true
      } else if (isLiteralPattern(b)) {
        if (taskGlob(a).match(b)) return true
      } else if (a === b) return true
    }
  }
  return false
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
function detectOutputCollisions(nodes: Map<string, TaskNode>): void {
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
  //                    collide. Bucketing makes this O(sum of k^2) over
  //                    per-project task counts, and k is single digits.
  //   workspaceFiles — root-anchored and boundary-free, so any two tasks can
  //                    collide — but only tasks that DECLARE it participate,
  //                    and that set is nearly always empty.
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

  for (const bucket of byProject.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i]!
        const b = bucket[j]!
        collide(
          a,
          b,
          a.config.cache?.outputs.files,
          b.config.cache?.outputs.files,
          'files',
          reaches,
        )
      }
    }
  }
  for (let i = 0; i < wsDeclarers.length; i++) {
    for (let j = i + 1; j < wsDeclarers.length; j++) {
      const a = wsDeclarers[i]!
      const b = wsDeclarers[j]!
      collide(
        a,
        b,
        a.config.cache?.outputs.workspaceFiles,
        b.config.cache?.outputs.workspaceFiles,
        'workspaceFiles',
        reaches,
      )
    }
  }
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

function collide(
  a: TaskNode,
  b: TaskNode,
  aGlobs: readonly string[] | undefined,
  bGlobs: readonly string[] | undefined,
  field: 'files' | 'workspaceFiles',
  reaches: (from: string, to: string) => boolean,
): void {
  if (neverWritesLocally(a) || neverWritesLocally(b)) return
  for (const ga of aGlobs ?? []) {
    for (const gb of bGlobs ?? []) {
      if (!outputsOverlap(ga, gb)) continue
      // An overlap WITH an edge is the addition shape (item 588): the
      // dependant runs after its upstream and adds to that tree, so the
      // order is fixed and the dependant's own set can be told apart from
      // what it found. Marked on both, and the pair is allowed. Without an
      // edge the two run in either order, and the refusal below stands.
      const [up, down] = reaches(b.id, a.id) ? [a, b] : reaches(a.id, b.id) ? [b, a] : []
      if (up !== undefined && down !== undefined) {
        const downGlobs =
          field === 'files'
            ? down.config.cache?.outputs.files
            : down.config.cache?.outputs.workspaceFiles
        ;(down.addsToOutputsOf ??= []).push(up.id)
        ;(up.outputsAddedToBy ??= []).push(...(downGlobs ?? []))
        return
      }
      throw new UserError(
        `${a.id} and ${b.id} both declare the output ${JSON.stringify(ga)}` +
          (ga === gb ? '' : ` / ${JSON.stringify(gb)}`) +
          ` in cache.outputs.${field} — vx cleans a task's declared outputs before it runs and ` +
          `before a cache-hit restore, so whichever of these runs second DELETES the other's ` +
          `output and the run still reports success. Give each task its own output path.`,
      )
    }
  }
}

export function detectCycle(nodes: Map<string, TaskNode>): void {
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
          throw new UserError(`Cycle detected in task graph: ${cycle}`)
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
