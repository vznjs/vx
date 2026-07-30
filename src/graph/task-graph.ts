import type { TaskConfig } from '../config.js'
import { UserError } from '../util/index.js'
import type { PackageGraph, ProjectEntry } from '../workspace/index.js'
import {
  DependencySpecError,
  compileTaskPattern,
  isTaskPattern,
  parseDependencySpec,
  type DependencySpec,
} from './dependency-spec.js'

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
}

export function taskId(project: string, task: string): string {
  return `${project}#${task}`
}

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
      // CLI `--excludeDependencies=name1,name2` drops edges whose target
      // task name matches, regardless of bucket (self / deps / cross).
      // Pattern specs re-apply the filter per EXPANDED name below.
      if (skipNames?.has(spec.task)) continue

      if (spec.kind === 'self') {
        if (isTaskPattern(spec.task)) {
          // `build.*` — every OTHER same-project task matching the
          // pattern (the declaring task never matches itself — that
          // would be an instant self-cycle). Zero matches is legal: a
          // preset-spread pattern needn't match in every project.
          const re = compileTaskPattern(spec.task)
          for (const name of Object.keys(project.config.tasks ?? {})) {
            if (name === taskName || !re.test(name)) continue
            if (skipNames?.has(name)) continue
            const child = addNode(projectName, name, false)
            if (child) node.deps.push(child.id)
          }
        } else {
          // Missing target is a hard error — the user typed a name that
          // doesn't resolve in this project.
          const child = addNode(projectName, spec.task, false)
          if (!child) {
            throw new UserError(
              `Task ${id} depends on ${taskId(projectName, spec.task)} but no such task is declared`,
            )
          }
          node.deps.push(child.id)
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
        // stops the walk even when every match is --excludeDependencies'd.
        //
        // The declaring project seeds `visited`: package graphs may legally
        // contain cycles (the common "b devDepends on a for its tests"
        // shape), and a cycle walks the frontier straight back to the
        // origin. Mirrors the self-pattern rule below — a task can never
        // depend on itself.
        const re = isTaskPattern(spec.task) ? compileTaskPattern(spec.task) : null
        const visited = new Set<string>([projectName])
        const frontier = [...packageGraph.directDeps(projectName)]
        while (frontier.length > 0) {
          const target = frontier.pop()!
          if (visited.has(target)) continue
          visited.add(target)
          if (re === null) {
            const child = addNode(target, spec.task, false)
            if (child) node.deps.push(child.id)
            else frontier.push(...packageGraph.directDeps(target))
          } else {
            const names = Object.keys(projects.get(target)?.config.tasks ?? {}).filter((n) =>
              re.test(n),
            )
            if (names.length > 0) {
              for (const name of names) {
                if (skipNames?.has(name)) continue
                const child = addNode(target, name, false)
                if (child) node.deps.push(child.id)
              }
            } else {
              frontier.push(...packageGraph.directDeps(target))
            }
          }
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

    // Stable ordering for deterministic scheduling and cache keys — deduped:
    // a target named twice (an exact entry + a pattern matching it, or a
    // literal duplicate) must contribute ONE edge, not a double-folded
    // upstream hash and a doubled DOT edge.
    node.deps = [...new Set(node.deps)].sort()
    return node
  }

  for (const { project, task } of requested) {
    addNode(project, task, true)
  }

  detectCycle(nodes)
  detectOutputCollisions(nodes)
  return nodes
}

/** A glob with no wildcard — it names exactly one path. */
function isLiteralGlob(g: string): boolean {
  return g.search(/[*?[\]]/) === -1
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
 */
function outputsOverlap(a: string, b: string): boolean {
  if (isLiteralGlob(a) && isLiteralGlob(b)) return a === b
  if (isLiteralGlob(a)) return new Bun.Glob(b).match(a)
  if (isLiteralGlob(b)) return new Bun.Glob(a).match(b)
  return a === b
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
        collide(a, b, a.config.cache?.outputs.files, b.config.cache?.outputs.files, 'files')
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
      )
    }
  }
}

function collide(
  a: TaskNode,
  b: TaskNode,
  aGlobs: readonly string[] | undefined,
  bGlobs: readonly string[] | undefined,
  field: 'files' | 'workspaceFiles',
): void {
  for (const ga of aGlobs ?? []) {
    for (const gb of bGlobs ?? []) {
      if (!outputsOverlap(ga, gb)) continue
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
