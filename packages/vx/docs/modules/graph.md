# `src/graph/` — the task graph and scheduler

## `src/graph/task-graph.ts` — task DAG construction + cycle detection

### Purpose

Take the set of requested `(project, task)` pairs and a workspace
package graph; produce the concrete DAG of `TaskNode`s. `--exclude-dependencies`
is a later pass over that DAG (`excludeDependencies`): it narrows the
SCHEDULE and leaves the dropped tasks to be keyed.

### Public surface

```ts
export interface TaskNode {
  id: string // `${projectName}#${taskName}`
  projectName: string
  projectDir: string
  taskName: string
  config: TaskConfig
  deps: string[] // ids of tasks that must finish first; sorted
  orderOnly?: string[] // members of deps that order and key nothing (--exclude-dependencies, item 1019)
  requested: boolean // user-requested vs dep-pulled
  surfaced?: boolean // display-only: a task a requested group stands for (markSurfacedDeps)
  keyParts?: ReadonlyArray<readonly [name: string, value: string]> // the `key` stage's material, sorted
  platform?: string // the platform this run runs it on, when it names `exec.platforms`: set by placement, keyed
  worker?: string // the worker type its executor runs it on (`TaskExecutor.workers`): set by placement, unkeyed
  addsToOutputsOf?: string[] // upstream ids whose output trees this task adds to (item 588)
  outputsAddedToBy?: string[] // dependants' output globs that add into this task's tree, those outside the run too
  excludedUpstream?: TaskOutcome[] // dependencies --exclude-dependencies dropped, with their keys
}

import type { ProjectEntry } from '../workspace/index.js' // { name, dir, config }

export interface BuildGraphOptions {
  projects: Map<string, ProjectEntry>
  packageGraph: PackageGraph
  requested: Array<{ project: string; task: string }>
  // Set when `projects` is a scoped load: a literal `^name` nothing in
  // `projects` declares is handed here instead of refused (see below).
  undeclaredDeps?: (taskId: string, name: string) => void
  workspaceRoot?: string // lets root-anchored outputs be checked against `files` outputs (item 1088)
  rules?: GraphRules | undefined // the workspace's `rules`; each on unless false (X-53)
  // By project name, every project rooted inside its dir; with `workspaceRoot`
  // and unlocked (`vx lock`), an `inputs.files` entry rooted in one is refused.
  nestedProjects?: ReadonlyMap<
    string,
    ReadonlyArray<{ name: string; dir: string; workspace?: boolean }>
  >
  // Every project's config (absolute); with `workspaceRoot`, an
  // `outputs.workspaceFiles` glob covering one is refused (`vx lock`).
  projectConfigs?: ReadonlyArray<{ name: string; configPath: string }>
}

// `locked`: a run, which never checks the rules; `vx lock` does.
export type GraphRules = WorkspaceRules & { readonly locked?: boolean }

export function taskId(project: string, task: string): string
// graph/definition.ts: what history keys a task by (## Definitions)
export function taskDefinition(node: TaskNode): string | undefined
export function taskDefinitions(nodes: Iterable<TaskNode>): Map<string, string>
// graph/critical-path.ts: the order a `schedule` plugin returns from timings
export function criticalPath(
  nodes: readonly TaskNode[],
  history: ReadonlyMap<string, { readonly p50DurationMs?: number | undefined }>,
  assume?: Readonly<Record<string, number>>,
): ReadonlyMap<string, number>
export function buildTaskGraph(options: BuildGraphOptions): Map<string, TaskNode>
// Removes the unscheduled tasks from `nodes` (returned, deps intact, as
// `keyOnly`) and trims each scheduled task's `deps` (the ids it lost in
// `dropped`).
export function excludeDependencies(
  nodes: Map<string, TaskNode>,
  exclude: 'all' | readonly string[],
): { keyOnly: Map<string, TaskNode>; dropped: Map<string, string[]> }
// Lives in `src/util/task-id.ts` (the cache reads the same rule and may
// not import the graph); re-exported here and on the façade.
export function splitTaskId(id: string): [project: string, task: string]
// The task a config declares under `name`, by OWN property: `constructor`
// or `toString` is no task unless the config names it (item 897).
export function declaredTask(
  config: ProjectConfig | null | undefined,
  name: string,
): TaskConfig | undefined
export function checkGraph(
  nodes: Map<string, TaskNode>,
  workspaceRoot?: string,
  rules?: GraphRules, // `exclusiveOutputs`: edge-ordered overlap
): void // id keys, deps (a repeat dropped), cycle, output collisions, inputs reading outputs; `locked` skips the rules
// Does `negatives` (an input list's `!` entries, `!` stripped) take back
// every path `output` can select? (X-54)
export function outputTakenBack(output: string, negatives: readonly string[]): boolean
// The refusal of a `^name` no project in the workspace declares; thrown by
// the builder, or by `prepareRun` once a scoped run's other configs agree.
// `declared` (every task name) supplies the "did you mean".
export function undeclaredDepsError(
  taskId: string,
  name: string,
  declared: Iterable<string>,
): UserError

// The `build` a project declaring none gets (projects.md), and the test
// for it: the picker, the "tasks here" and `vx build` hints and
// `vx show <task>` leave it out, and its `^build` refusal with no edge
// source says it is the default build's.
export const DEFAULT_BUILD: TaskConfig
export function isDefaultBuild(task: TaskConfig | undefined): boolean

// Which `{project, task}` pairs a run's requested names resolve to, and
// which resolve to nothing (`vx run`'s "every requested name must resolve").
// A bare name matches no task `unselected` holds: `prepareRun` passes
// `isDefaultBuild`, so `vx run build` in a project declaring none is
// refused like any undeclared name, and `lib#build` still plans it (X-102).
export function expandRequested(
  tasks: readonly string[],
  candidates: readonly string[],
  projects: Map<string, ProjectEntry>,
  unselected?: (task: TaskConfig) => boolean,
): Array<{ project: string; task: string }>
export function unresolvedRequests(
  tasks: readonly string[],
  candidates: readonly string[],
  projects: Map<string, ProjectEntry>,
  unselected?: (task: TaskConfig) => boolean,
): string[]

// With `run.rules.exclusiveOutputs: false`: marks `outputsAddedToBy` on
// `nodes` for every task in `projects` outside the run whose outputs
// overlap one in it. Such a task is a dependant (an upstream would be in
// the run, and `vx lock` refuses an unordered pair), so an upstream run
// alone still ignores what it added (`prepareRun` calls it).
export function markOutsideAdditions(
  nodes: Map<string, TaskNode>,
  projects: ReadonlyMap<string, ProjectEntry>,
  workspaceRoot: string,
): void

// Flags the display-only `surfaced` tasks a requested GROUP stands for;
// returns how many it flagged. See "transparent folders" in cli.md.
export function markSurfacedDeps(nodes: Map<string, TaskNode>): number

// stand-ins.ts, internal (not on the façade): what each edge past a default
// build on a package cycle stands in for, kept off TaskNode's public shape
// under a symbol key that spread copies carry.
export type StandIns = Readonly<Record<string, readonly string[]>>
export function standInsOf(node: TaskNode): StandIns | undefined
export function setStandIns(node: TaskNode, standIns: StandIns): void
export function addStandIn(node: TaskNode, id: string, past: readonly string[]): void // the walk's

// True only when two output globs PROVABLY select an overlapping set —
// the test behind the refusal below, on the façade because
// `@vzn/vx-migrate` asks the same question at migration time and used to
// ask it with a copy that drifted (item 445).
export function outputsOverlap(a: string, b: string): boolean
```

### Construction rules

Starting from `requested`, the builder expands `dependsOn` depth-first
— each target's subtree before the next target — on its own stack, not
the call stack: the recursion it replaced threw `RangeError: Maximum
call stack size exceeded` at a chain ~20,000 deep (nx#28788's shape). A
depth is bounded by memory only, and the order nodes are added in (which
`detectCycle` walks, so which cycle it names) is the recursion's. Each
entry is parsed via [`dependency-spec.ts`](./util.md#srcutildependency-spects--turbonx-micro-syntax-parser):

| Form          | Behavior                                                                                                                                                                                                                                                                                                                                                                         |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'name'`      | Same-project. Missing target throws (hard error).                                                                                                                                                                                                                                                                                                                                |
| `'^name'`     | Nearest-holder frontier: walk the package dep graph from direct deps; each path stops at the first package declaring the task (edge added there). Non-declaring deps are passed through (sparse bridging); nothing past a holder is walked — its own `dependsOn` owns deeper ordering. No holder is legal while some project declares `name`; a name no project declares throws. |
| `'pkg#name'`  | Specific cross-project edge. Missing pkg or task throws.                                                                                                                                                                                                                                                                                                                         |
| `'*'`, `'^*'` | Rejected in `dependsOn` (filter-only). UserError.                                                                                                                                                                                                                                                                                                                                |
| `'!form'`     | Rejected in `dependsOn` (filter-only). UserError.                                                                                                                                                                                                                                                                                                                                |

The micro-syntax parser is shared with `inputs.tasks`; the
builder enforces the dependsOn-specific rejections.

**The default `build` on a package cycle** (X-100). Every project the
loader gives the default `build` (a keyed group, `isChainGroup`)
holds `build`, so on a package cycle (`directDeps`' strongly connected
components, found on the first ask) `^build` closed a task cycle no
config declares. A default `build` on a cycle walks last, once the rest
of the graph is built: a build on its cycle that reaches it is passed
through, and one that does not is a holder like any other (X-118: passed
through unasked, `p#test` on `p#build` ran beside a `t#build` on no
`^build` and hit after `t` changed). A build only that question brought
in is pruned again when it reaches back. An edge to a default `build` on
a cycle — a `^build` walk, or one by name (`build`, `pkg#build`) or
pattern (`bui*`, `^bui*`) —
is added and goes on past it, so the builds it cannot depend on still
come first (X-120: by name it stopped there, and `a#test` on `build`,
with `a` and `b` on the default build depending on each other, folded
nothing of `b`). Each edge taken past one is recorded in the
dependant against the edges it went past (`standInsOf`), and
`inputs.tasks` selecting those selects it (`selectFoldedDeps`): by name
alone, `tasks: ['build']` or `['a#build']` kept `a#build`, dropped
`b#build`, and an edit to `b` replayed the hit. The record is not on
`TaskNode`'s public shape; the graph memo stores it, and
`applyGraphStage` re-attaches it by id to a node a `graph` hook rebuilt,
less any edge the hook removed. Off a cycle it is a holder like any other. A config's
keyed group of the same shape (`inputs`, no `exec`, `dependsOn` exactly
`['^name']` of its own name; `isChainGroup`) is treated the same; any
other keyed group on a cycle expands its own `dependsOn` like a task
(a `ci` keyed on `lint` was deferred as a default build, lost its edge
and ran nothing).

**`requested: true`** marks the user-requested set. A node added via
dependsOn expansion is `requested: false`. If a node is later named
explicitly (or the user passed both `build` AND `pkg#build`), it gets
promoted to `requested: true` — never demoted.

`excludeDependencies` narrows the schedule after the `graph` and `key`
stages have seen the whole graph:

- `'all'` — drop every edge but a group's: a group is its members,
  so the requested tasks and the members of any group among them
  (nested groups too) stay scheduled, without their dependencies.
  Before item 894 a requested group was scheduled alone and the run
  ran nothing, exit 0.
- `string[]` — drop edges whose target task name appears. Works
  uniformly across same-project, deps-bucket, and cross-project edges,
  and per expanded name for a pattern.

What the requested tasks still reach stays in `nodes`; the rest is
returned as `keyOnly`. It is a pass and not a filter on the expansion
because a dropped dependency is still KEYED (nx#35234): `prepareRun`
derives each dropped task's key on the whole graph as a full run would
(`orchestrator/excluded-keys.ts`) and sets it on the dependant as
`excludedUpstream`, so a key never depends on the selection.
A scheduled task the requested one reached THROUGH a dropped one
(`test → gen → build`, `gen` dropped, `build` requested) gets an edge
of its own, listed in `orderOnly`: it orders the run, and the key sites
leave it out (`keyUpstream`, `keyedDeps`), since the dropped task's
key already folds it (item 1019).

The resulting `TaskNode.deps` is the concrete id list of upstream
tasks. It's sorted before being stored so downstream cache-key
computations are deterministic regardless of how the user ordered
their `dependsOn` array.

### Cycle detection

After every reachable node has been added, `checkGraph()` checks the
graph (the `graph` stage runs it again after its plugins, item 981,
unlocked even in a run, since a hook can edit what the lock never saw):
each node under its own id, every dep a node named once (a plugin's
repeat is dropped), then `detectCycle()` runs a
3-color DFS:

- WHITE = unvisited
- GRAY = on the current DFS stack
- BLACK = fully explored

Encountering a GRAY node while traversing means we're in a cycle. The
error message formats the cycle path:

```
dependsOn cycle: a#build -> b#build -> a#build — remove one edge of the loop
```

Both cross-project cycles and self-cycles (a task listing itself) are
detected. Throws as `UserError` so the CLI prints cleanly.

### Overlapping outputs

Last, `detectOutputCollisions` refuses two tasks whose declared outputs
overlap (`outputsOverlap`) with no edge between them. A pair with one is
refused too while `rules.exclusiveOutputs` is on (the default, X-53), its
message naming the rule; off, the pair is marked as the addition shape.
It never compares all pairs:
`outputs.files` is compared only within a project and
`outputs.workspaceFiles` only among its declarers, and within each
domain a path index (`overlapCandidates`) names the pairs that can
overlap. Two globs meet only when one's literal prefix lies at or
under the other's (equal literals too, through their `/**` twins), and
a literal meets the globs whose literal head names one of its ancestor
directories. The head ends at the first character `Bun.Glob` may read
as other than itself, `*?{}` plus `\` and a leading `!`, so a wildcard
in the first segment files the glob at the root. The pairs are compared
in the order all pairs met them, so the refusal names the same pair and
the marks land in the same order. One project of 4,000 tasks with
outputs built its graph in 10.0 s (distinct literals) and now in 10 ms
(item 746). Each relation is indexed from both ends, so the pairs are
found one task at a time as they are compared: 20,000 tasks sharing
`dist/**` held all 200 million pairs before the first refused, and died
`RangeError: Out of memory`; now the first pair refuses at once.

### Inputs and outputs inside a nested project

Given `nestedProjects` (only `vx lock` passes it) and unlocked,
`refuseNestedGlobs` refuses an `inputs.files` or `outputs.files` entry
whose brace alternative's fixed prefix lies inside a project nested in
the task's own (`VX_E_NESTED_INPUT`, `VX_E_NESTED_OUTPUT`), or an
`outputs.files` one inside a nested workspace (an entry marked
`workspace`, named by its root-relative dir; `VX_E_NESTED_OUTPUT`): the
boundary drops every file it can match, so an input keys nothing and an
output saves nothing. An input still reaches into a nested workspace
(`tests/nested-input.test.ts`).

### Inputs that read outputs

Unless the graph is locked, `detectInputOverlaps` (X-54, no opt-out)
refuses a cached task whose input globs can match another task's
declared outputs: `inputs.files` against the same project's
`outputs.files`, and `inputs.workspaceFiles` against every
`outputs.workspaceFiles` and every other project's `outputs.files` at its
workspace path, and `inputs.files` at its workspace path against every
other task's `outputs.workspaceFiles`, which may land in any project
(X-135). The test is `outputsOverlap`, so only a proven overlap is
refused; the stability gate keeps the "may reach" cases preliminary. An
output the reader's own `!` entries take back whole (`outputTakenBack`)
does not count, nor do its own outputs, nor an output git ignores
whole: the overlaps found are collected, one per output, and git is
asked once for all of them (`refuseOverlaps`: one `git
check-ignore` over each output's directory, `util/git-ignored.ts`, and a
`git ls-files` for a glob that reaches below it, which must list no file
the glob matches). Undecided, or no work tree: refused. A group has no
outputs and no key of its own, so the default build (`**`) is exempt. Each domain runs
through `overlapCandidates`, so it is not all pairs: 4,000 tasks in one
project check in milliseconds. The index is kept per side, readers and
writers, and pairs across sides only (X-101): filed together, 5,000
tasks reading one shared input (`tsconfig.base.json`) paired every
reader with every other and built the graph in 15 s; 0.2 s now.

Whatever the rules, `refuseSelfClean` refuses a task whose own outputs
take back one of its input entries whole (`src/**` as both): vx removes
a task's outputs before it runs, so it would delete its own sources. An
in-place rewriter (a formatter) declares no outputs. With the workspace
root known, `files` is rebased to it and compared with `workspaceFiles`
both ways (`src/**` read, `app/src/**` written).

Given every project's config path (`projectConfigs`, from `vx lock`),
`refuseConfigOutputs` refuses an `outputs.workspaceFiles` glob that
covers any project's `vx.config.*` unless an output `!` entry takes it
back: the clean deleted another project's untracked files through
`packages/b/**`. `outputs.files` refuses its own config at load.

### Definitions

`graph/definition.ts`: `taskDefinition(node)` hashes a task's id, command
and sorted `env.define` (undefined for a group); `taskDefinitions(nodes)`
maps each id to it. History stores it per row (`runs.def`, v48) and reads
only rows of the task's current definition, so a changed command starts
over and an inputs edit keeps its timings.

### What this does NOT do

- It doesn't check that `inputs.tasks` names resolve to declared
  upstream. The schema refuses an exact name no `dependsOn` entry names
  (`workspace/config-schema.ts`, item 994), and
  [`orchestrator/upstream.ts:filterUpstreamHashes`](./orchestrator.md#srcorchestratorupstreamts--upstream-selection)
  applies the rest; only a pattern that matches nothing stays silent.
- It doesn't compute a topological order — that's the scheduler's
  job. The graph only encodes "X must finish before Y," not
  "Y runs at step N."
- It doesn't validate `excludeDependencies` against declared task
  names — `prepareRun` does, before it calls the builder's narrowing: a
  name no project declares is a `UserError` with a near-miss hint
  (item 1026).
- It doesn't fail when `requested` is empty — produces an empty map.
  The orchestrator decides whether that's a footgun.

### Tests

`tests/task-graph.test.ts` covers:

- zero-dependency single node
- `'name'` (self) expansion + missing-task error
- `'^name'` frontier expansion: nearest holder, sparse bridging,
  stop-at-holder, shared-subtree dedup; default builds on a package
  cycle make no task cycle and keep the builds past them
- `'pkg#name'` cross-project edge (missing throws)
- `'^name'` no project declares throws `undeclaredDepsError`'s message;
  the controls — declared only off the dependency path, declared by the
  leaf itself, a `^pattern` matching nothing — plan; a scoped caller's
  `undeclaredDeps` receives the name instead. The builder no longer
  knows `--exclude-dependencies`, so a name the flag drops is judged
  too (`tests/prepare-run.test.ts` holds the refusal under the flag)
- wildcard / negation rejection in dependsOn
- diamond dedup (shared upstream created once)
- cross-project cycle detection
- self-cycle detection
- a 50,000-deep chain plans and a 50,000-deep ring is refused as that
  cycle (the recursive builder overflowed the stack on both), and
  `excludeDependencies(nodes, 'all')` narrows that chain to its head
- empty `requested` → empty graph
- `excludeDependencies(nodes, 'all')` schedules only the requested, and
  returns the rest as `keyOnly` with the edges each task lost
- `excludeDependencies(nodes, [...])` drops named edges only

`tests/exclude-dependencies-properties.test.ts` holds both forms over
2,000 seeded random graphs: every order between two tasks still
scheduled survives (item 1019), a direct edge to a task still scheduled
stays a real one (item 980), and no edge names a task that left (C-71).

`tests/output-collision.test.ts` covers the overlapping-output refusal:
what is refused, the spellings that name one path (`./dist/**` against
`dist/**`), the literal that is a whole tree (`dist` against
`dist/app.js`) with the clean that proves it, two globs a path built
from them proves overlapping (`dist/*.js` against `dist/**/*.js` meet at
`dist/x.js`, X-51) beside disjoint pairs of the same shapes, and the false-positive
controls — the refusal aborts the run, so a widening breaks a build that
works today. It also holds the path index: a row per way an index could
miss a pair (a literal deep under a glob's head, a wildcard or brace in
the first segment, an escape in the head), the first refusal and the
marks in all-pairs order, 3,000 random configs against the all-pairs
loop, and a time bound at 4,000 tasks in one project that the old loop
misses tenfold.

`tests/input-overlap.test.ts` covers the input refusal: the exact
message, each shape refused and loaded with the rule off, edge or no
edge, both workspace domains, the `!` take-back and a partial one that
is still refused, the exemptions (own outputs, uncached, group, the
default build), a run refused and the same run with the rule off, a
non-boolean value, a time bound at 4,000 tasks and at 4,000 readers of
one shared input, and a row per way the per-side index could miss a
reader and a writer.

### Replacing this module

- **Lazier graphs** — return an iterator instead of a Map, useful for
  very large workspaces. Current implementation is O(tasks × avg-deps)
  at graph build time and that's fine for any realistic monorepo.
- **Different dependency model** — e.g., conditional deps
  (`dependsOn: { task: 'build', when: 'production' }`). Would need a
  schema change on `TaskConfig.dependsOn` plus updated resolution.
  Cycle detection still terminates regardless.
- **Stable-after-add ordering** — currently `deps` is sorted. If the
  scheduler grew priority logic (longest-first), sort here.

## `src/graph/scheduler.ts` — two-tier parallel topological executor

### Purpose

Walk the task graph honoring dependencies, running up to `N` tasks
concurrently, propagating failure as `skipped` to dependents while
keeping unrelated tasks moving — with a second, low-priority ready
queue for confirmed local cache hits (the restore tier) that may run
ahead of their dependencies, on its own lane: restores are disk I/O,
so up to twice `N` run at once while exec-tier work keeps the cap
(at `--concurrency 1` the two lanes share one slot). An outcome may still owe
something before its dependents start — `settledOf(outcome)`, the
orchestrator's off-slot cache save landing — and the scheduler frees
the slot at the outcome and unblocks the dependents at the settle. What
the settle resolves with (the save's time and size) is merged into the
outcome the dependents and observers see.

### Public surface

```ts
export type TaskStatus =
  'success' | 'cache-hit' | 'cache-hit-remote' | 'failed' | 'skipped' | 'aborted' // child killed by a shutdown signal (Ctrl-C teardown)

export interface InputChanges {
  count: number // components changed, added or removed; 0: the same key, its entry gone
  first: readonly { kind: string; name: string; change: 'changed' | 'added' | 'removed' }[] // the first ten, by kind then name
}

export interface OutcomeTiming { // on the run's clock
  queuedMs?: number // how long it waited ready for a worker, any admission hold included
  admissionHeldMs?: number // how long an `admit` policy held a ready task with a free worker
  startNs?: bigint // hrtime span relative to run t=0
  endNs?: bigint
  fetchMs?: number // a remote hit this run pulled: download + ingest
  saveMs?: number // a miss that saved, sink listening: the save's own time
}

export interface OutcomeUsage { // what this run's execution used; absent on a hit
  cpuMs?: number
  peakRssBytes?: number
  peakCores?: number // sampled: most cores one interval burned
  avgRssBytes?: number // sampled: mean resident memory
}

export interface OutcomeCache {
  stored?: { durationMs: number; cpuMs?: number; peakRssBytes?: number } // hits: what the producing execution took — the work skipped
  restored?: boolean // cache hits: false = tree already current (up-to-date)
  saved?: true // ran here and its result went to the cache: the footer's `↑`
  inputFiles?: number // on a cacheable task that ran: the files its key read
  artifactBytes?: number // a hit's entry size, or (sink listening) the size a miss's save wrote
  outputBytes?: number // its output files' raw bytes, restored or saved: the row's `outputs`
  inputChanges?: InputChanges // on one that ran with a sink listening: its key against the last saved entry
  deferred?: true // outputs left in the remote store (`--cache-download=none`)
  off?: true // the run's policy read and wrote nothing: a run of it is no-cache, not a miss
  unkeyed?: true // ran over inputs its key no longer describes: no save, nor by a dependant (A-12)
  driftedInput?: string | null // its own re-check found this input (absolute) moved while it ran, null unnamed: vx watch judges it changed next
  keylessBy?: string // the task with no `inputs` its key includes (or itself): no read, no save
}

export interface OutcomeSandbox { // any denial fails the task
  violations: number
  lines?: string[]
  fix?: SandboxFix
}

export interface SandboxFix { // the grants that would have allowed the denials
  read?: string[]
  write?: string[]
  network?: string[]
  systemInfo?: string[]
  withheld?: string[] // credential paths left out
  inputs?: string[] // a cached task's unkeyed reads of its project
  workspaceFiles?: string[] // the same elsewhere in the workspace
}

export interface OutcomeAttempts {
  count?: number // set only when `retries` / `--retries` ran it more than once
  failed?: readonly { endedAt: number; exitCode: number; timedOut?: true }[] // the attempts that were run again
  outputs?: readonly string[] // each failed attempt's output, encoded as failedOutput: vx last --log
  flaky?: { passes: number; failures: number } // the run proved it flaky; its row says so
}

export interface OutcomePlacement { // executor-reported, when not this host
  where?: string
  carried?: true // a persistent task each dependant's executor starts where it runs: nothing ran here
  cores?: number // that machine's cores and memory (ExecuteResult.machine)
  memoryBytes?: number
  cpuShare?: number // ExecuteResult.machine.cpuShare: the share of a core its threads got there
}

interface OutcomeBase { // every status; a group exists only when it holds a value
  node: TaskNode
  durationMs: number // what THIS run spent (a hit's restore cost)
  timing?: OutcomeTiming
  usage?: OutcomeUsage
  cache?: OutcomeCache
  sandbox?: OutcomeSandbox
  attempts?: OutcomeAttempts
  placement?: OutcomePlacement
  groupUpstream?: readonly TaskOutcome[] // a group's own dependency outcomes; never folded
  taintedBy?: string // ran behind a failure (`always`) or a dropped dependency: its root; set by run() before any observer hears it, so no flaky verdict reads it
  runLog?: string // run keeps bytes in a remote and this task saved no entry: its whole output log, masked
}

interface StartedOutcome extends OutcomeBase {
  exitCode: number
  hash?: string // cache key (pure-input transitive; folded into dependents)
}

interface FailureFacts { // failed only
  timedOut?: true // vx's own `timeout` killed the final attempt
  notReady?: 'timeout' | 'exited' | 'spawn' // failed persistent task: why it never became ready
  inputMoved?: string // failed by inputs.stability.severity 'error': the input that changed ('' unnamed)
  restoreFailed?: true // a hit whose restore threw; in no cache count
  failedOutput?: string // failed command: its output log (output-log.ts), first 8 KiB + last 56 KiB, masked
}

interface BlockFacts { // skipped or aborted
  blockedBy?: string // the failed or aborted task at the root of the block
}

interface PlatformFacts { // skipped only
  otherPlatform?: { readonly needs: readonly string[]; readonly host: string } // its `exec.platforms` leave this machine out
  platform?: true // it, or the task it is blocked behind, is a platform skip: it fails nothing
}

type None<T> = { [K in keyof T]?: never } // a variant's absent facts read as undefined on the union

export interface SucceededOutcome extends StartedOutcome, None<FailureFacts>, None<BlockFacts>, None<PlatformFacts> {
  status: Exclude<TaskStatus, 'failed' | 'aborted' | 'skipped'>
  serverExit?: number // ready persistent task whose child exited on its own mid-run: no label calls it running
}
export interface FailedOutcome extends StartedOutcome, FailureFacts, None<BlockFacts>, None<PlatformFacts> {
  status: 'failed'
  serverExit?: never
}
export interface AbortedOutcome extends StartedOutcome, None<FailureFacts>, BlockFacts, None<PlatformFacts> {
  status: 'aborted' // a shutdown stopped it; exitCode is the signal's
  serverExit?: number
}
export interface SkippedOutcome extends OutcomeBase, None<FailureFacts>, BlockFacts, PlatformFacts {
  status: 'skipped' // never started: no exit
  exitCode?: never
  hash?: string // fail-fast stopped it after its key was derived
  serverExit?: never
}

export type TaskOutcome = SucceededOutcome | FailedOutcome | AbortedOutcome | SkippedOutcome

export function exitCodeOf(o: TaskOutcome): number // the exit a record writes: a skip's is 0 behind a platform skip, else 1

export type ContinueMode = 'never' | 'deps-ok' | 'always'

export interface ScheduleOptions {
  nodes: Map<string, TaskNode>
  concurrency: number
  restoreConcurrency?: number // restore-tier tasks at once; twice concurrency unset
  /** Aborted → nothing further dispatches; every task not yet started completes `aborted`. */
  signal?: AbortSignal
  /** Failure propagation; default 'deps-ok'. */
  continueMode?: ContinueMode
  /** A ready server that died: its dependants not yet started skip (through groups too); under 'never' dispatch stops. */
  serverDied?: (id: string) => boolean
  /** Called once, when 'never' stops dispatch: a task in flight starts no retry. */
  onFailFast?: () => void
  execute: (node: TaskNode, upstream: TaskOutcome[]) => Promise<TaskOutcome>
  onStart?: (node: TaskNode) => void
  onFinish?: (outcome: TaskOutcome) => void
  /** Where a rejected `execute`'s line goes, before its outcome; default stderr. */
  onError?: (node: TaskNode, line: string, err: unknown) => void
  /** What an outcome still owes before its dependents may start (the off-slot cache save). */
  settledOf?: (outcome: TaskOutcome) => Promise<Partial<TaskOutcome> | void> | undefined
  /** The outcome of an exec-tier task settled in place, or undefined to dispatch it. */
  settleNow?: (node: TaskNode, upstream: TaskOutcome[]) => (() => TaskOutcome) | undefined
  /** Optional per-node weight override (a scheduling policy's seam). */
  priorities?: ReadonlyMap<string, number>
  /** Later weights for `priorities`: the ready queues re-rank at once (a `schedule` plugin's `refine`). */
  reprioritize?: (apply: (priorities: ReadonlyMap<string, number>) => void) => void
  /** The baseline ranking under `priorities`: `schedule` in .vx/workspace.ts. */
  strategy?: 'most-work' | 'critical-path' | 'direct-dependents' | 'ready-order'
  /** The `most-work` baseline already counted (`computeReverseDepCount`), asked only when used. */
  reverseDeps?: () => ReadonlyMap<string, number>
  /** Confirmed stable-key local hits — ready immediately, backfill-only. */
  restoreTier?: ReadonlySet<string>
  /** Servers held until the caller adds their remote-hit dependants to `restoreTier` (the ids it added). */
  heldServers?: ReadonlyMap<string, Promise<readonly string[]>>
  /** Pool for tasks placed on an executor with its own capacity; undefined = the local pool. */
  poolOf?: (id: string) => { name: string; capacity: number } | undefined
  /** Admission over the worker count for local exec-tier tasks; `false` parks the task. */
  admit?: (id: string, running: ReadonlySet<string>) => boolean
  /** Tasks that hold the terminal: each starts once nothing runs, and nothing starts beside it. */
  exclusive?: ReadonlySet<string>
}

export async function runGraph(options: ScheduleOptions): Promise<Map<string, TaskOutcome>>

// The dead server a dependency stands for: itself, or one a group or a server
// reaches (`web` stays up on `api`). Iterative, each node once: a deep chain
// of groups does not overflow.
export function deadServerBehind(
  nodes: ReadonlyMap<string, TaskNode>,
  serverDied: (id: string) => boolean,
  id: string,
): string | undefined

// Persistent tasks nobody asked for whose every dependant is a restore-tier hit,
// or an unrequested group or server only such hits stand behind (those groups and
// servers go in `groups`, settled as a group is).
export function idleServers(
  nodes: ReadonlyMap<string, TaskNode>,
  dependents: ReadonlyMap<string, string[]>,
  restoreTier: ReadonlySet<string> | undefined,
  groups?: Set<string>,
): Set<string>

// Thrown by `execute` for a restore-tier task with nothing to restore.
export class RestoreDemoted extends Error {
  constructor(readonly taskId: string)
}

// Thrown by `execute` when a hit's restore threw: reported as `error`, the
// outcome `failed` with `restoreFailed`.
export class RestoreFailed extends Error {
  constructor(readonly error: unknown)
}

// Thrown by `execute` when deriving the key threw (orchestrator.md `keyOf`):
// reported as `[vx] <id>: cache key not derived: <error>`, the outcome
// `failed` and marked: `isKeyFailed(outcome)`.
export class KeyFailed extends Error {
  constructor(readonly error: unknown)
}

// A symbol mark, not a field (`TaskOutcome` and `RunPlan` are public types):
// it rides a spread copy and never reaches JSON. The plan marks itself when
// any task's key failed, and `--dry` exits 1 on it.
export function markKeyFailed<T extends object>(o: T): T
export function isKeyFailed(o: object): boolean

// Thrown by `execute` when vx's own clean before an attempt, or its save
// after an exit 0, threw: the outcome keeps `exitCode` and `durationMs`
// (the command's, or vx's 1 and 0 when it never ran) and is marked with
// the step, so no label names an exit the command never returned.
export class OutputsFailed extends Error {
  constructor(readonly error: unknown, readonly step: 'clean' | 'save', readonly exitCode: number, readonly durationMs: number)
}
export function markOutputsFailed<T extends object>(o: T, step: 'clean' | 'save'): T
export function outputsFailedOf(o: object): 'clean' | 'save' | undefined
```

`task-status.ts` holds `TaskStatus` and what each status means, so no
reader re-lists the statuses:

- `deriveCacheSource(status)` — the `CacheSource`
  (`'miss' | 'local' | 'remote' | 'none'`): `'local'` / `'remote'` for the
  two hits, `'miss'` for `success` / `failed`, `'none'` for `skipped` /
  `aborted`; never null. Telemetry reports a `restoreFailed` failure as
  `'none'`: it is neither a miss nor a hit.
- `TASK_STATUSES`, `isPassStatus(status)`, `isCacheHit(status)` — every
  status at runtime and the two predicates every surface shares.

A restore-tier task whose `execute` rejects with `RestoreDemoted` (its
artifact vanished after the up-front probe) records no outcome: the
scheduler releases its restore slot and dispatches it again as an
exec-tier task — at once if its deps are done, else when the last one
finishes, with the failed-dep skip applied like any other. It may have
been running ahead of those deps, so running its command in the
restore slot would build from outputs they have not written.
`onStart` fires once; its dependents wait for the second dispatch.

`settleNow` is asked of a task once it is due (a restore-tier one when
its lane has room), after the skip check. A thunk settles it in the
same tick: `onStart` hears it, the thunk runs (a hit replays its output
there), and `onFinish` hears the outcome the thunk returned, its queue
time set on it, not on a copy; no slot, no admission ask, no `execute`
promise. A throw from either dispatches it instead, started
once. The run passes it for unkeyed groups (they run nothing, X-192)
and for restore-tier hits whose tree is current (`currentHit`), unless a
taint or `--continue=always` needs the full path.

A persistent task neither requested nor surfaced whose every dependant
is in the restore tier is idle (X-59): due, it goes dormant instead of
dispatching, asking no admission policy and taking no slot. A demoted
dependant starts it, and that dependant runs once it is ready. Once
every dependant has an outcome it settles with none of its own and
releases them, so it is never spawned and the returned map lacks it.
Its own deps still run first and a failed one skips it as before; a
stop or fail-fast leaves it with no outcome.
A group neither requested nor surfaced that stands only between such a
server and its hits is idle with it: it waits the same way, settles
with no outcome once every hit above it has one, and a demotion above
it wakes it and the server.
A `heldServers` server does not dispatch until its promise answers: the
dependants it names join the restore lane, and it is idle when
`idleServers` then finds it so, with the groups and the held servers
beneath it that the same walk passes through; else it dispatches as
usual (`orchestrator/held-servers.ts` holds every server that walk would
idle were each remote key a hit, and asks the remote for the keys above
it).

A run counts dependents once: the `most-work` baseline is also every
row's `blocks`, groups counted as the scheduler counts them, and the
orchestrator remembers it with the graph (`graphCounts`, keyed by the graph
token and the node ids). A second count for the rows alone was a pass of
its own (2026-10-29). `prepareRun` takes it while git's blob-size check
runs, when nothing after the graph can edit the nodes
(`PreparedRun.dependents`, `orchestrator.md`).

The ranking lives in `src/graph/priorities.ts`, a file with no runtime
import at all. The Learn page's scheduler simulator bundles it for the
browser (through `private/vx-bench/schedule-policy.ts`), and
`scheduler.ts` imports `util/`, whose modules read `Bun` and `process`
when they load:

```ts
export function computeReverseDepCount(
  nodes: ReadonlyMap<string, TaskNode>,
  counted?: ReadonlyMap<string, unknown>,
): Map<string, number> // also the live region's waiting order; `counted` limits the dependents counted (the exec tier)
export function tieredReverseDepCount(
  nodes: Map<string, TaskNode>,
  restoreTier: ReadonlySet<string>,
): Map<string, number>
export function mergePriorities(
  baseline: ReadonlyMap<string, number>,
  overrides: ReadonlyMap<string, number>,
): (id: string) => number // read as asked: no merged copy of the two maps
```

### Algorithm

Per-node **dep counters + two ready heaps** — O(E) counter decrements
over a whole run plus one O(log N) heap operation per enqueue and per
dispatch (the old scan-everything-per-completion tick was O(N²)):

1. Build reverse adjacency + `pending` counts once. A node enqueues
   when `pending` hits 0 — onto **execReady** (normal priority).
2. **Restore-tier nodes bypass the dep gate**: they enqueue onto
   **restoreReady** at startup (a stable hit's restore needs none of
   its deps' output). Their pending decrements still happen but never
   re-enqueue them.
3. `tick()` fills free worker slots by draining **execReady FIRST** —
   cache misses own the pool; restores only backfill idle capacity
   (or run when they're the only ready work, unblocking a dependent).
4. **Pooled nodes are admitted against their own pool.** When `poolOf`
   returns a pool for a node (its executor declared a `capacity` — see
   `exec.md`), it occupies one of that pool's slots instead of a
   local worker slot and reserves ZERO local resources: work running on
   another machine spends none of this one's CPU or RAM. Restore-tier
   nodes are always local (a restore is a tar extract on this disk). With
   no `poolOf` passed the admission gate is the legacy `active <
concurrency` check for exec-tier nodes — including its O(1) early-out
   — and `activeRestore < 2 × concurrency` for restore-tier nodes, a
   separate counter so neither lane waits on the other (measured
   2026-09-10 on the 1,000-project bench with every task a restore: 4 → 8
   workers cut the run-graph stage 683–754 → 556–595 ms, 16 no better).
   With pools
   (or with an `admit` policy) a saturated tick instead SCANS the ready
   queue, parking what does not fit and repushing it with its original
   seq; that is the price of a per-task admission predicate, and it is
   paid only when one exists. With pools the scan still skips when every
   pool is full and no ready task is local: a DTE pool of 6 slots before
   2,000 ready tasks re-popped them all on every task's end (2026-10-25). `admit(id, running)` is that predicate for
   local exec-tier nodes: asked after the count gate with the set of
   local exec-tier tasks running right now (tracked only while a policy
   exists; a persistent task leaves it at ready, with its slot, since it
   never finishes before its dependants and a policy that counted it
   would hold them with no completion left to ask again), a `false` parks
   the node; restore-tier, pooled and group nodes are never asked and
   never in the set. Core passes the plugins' `admit` stage here
   (`plugin-host.buildAdmission`) and holds no costs of its own. A
   task a policy refused while a worker was free is timed from that
   first refusal to its dispatch, and its outcome carries the wait as
   `admissionHeldMs` — the event stream and the
   footer's `admit held N tasks` show the policy's hand; no policy, no
   field, no clock read.
5. **Exclusive nodes** (`exec.interactive` on a TTY) hold the terminal.
   When one is the next exec-tier node and anything runs, it parks and
   the tick dispatches nothing more, restores included, so the running
   nodes drain; it starts once none runs, and nothing starts while it
   holds. A persistent one releases at spawn, when `execute` resolves.
   A higher-priority node that becomes ready first still goes first.
6. **Failed upstream** → an exec-tier node is marked `skipped`
   synchronously (no `execute` call). Restore-tier nodes **bypass**
   this check — their key is dep-success-independent (pure-input
   transitive hashing), so a valid cached output reports `cache-hit`
   even when a dep failed.
7. When every node has an outcome and nothing is active, resolve.

Priority within a queue: highest transitive-reverse-dependent count
first (`computeReverseDepCount` — an exact bitset closure swept in
reverse-topo order, O(E·N/32); Set-based closures cost 8.5 s at 3,270
tasks). The sweep runs once per block of words that fits the cache:
at 9,603 tasks the whole closure is 11.5 MB and its one call took
77 ms, blocked 37 ms. Ties break in graph-insertion order: `ReadyHeap` is a binary
max-heap ordered by (priority DESC, enqueue-seq ASC).
With a restore tier the count is `tieredReverseDepCount` (item 754): a
restore-tier task never waits on its deps, so it blocks only the
exec-tier tasks that depend on it. Its dependents do wait on its deps:
one that finishes early releases them once its own deps have settled,
so `dependsOn` order holds through a hit (released at its own finish,
an `e2e` ran beside the `db:migrate` two edges up; item 963). An exec-tier task's count is the
exact closure over the exec tier, each restore dep read as the exec
tasks that restore waits on (`e1 → r → e2` holds `e2` until `e1` ran,
so `e1` counts `e2`; counted over the exec tier alone it ranked 0 behind
every idle task, about 1 ms more at 3,000 tasks); a restore's is the sum over its
direct exec-tier dependents of one plus theirs, plus the rank of each
restore that depends on it, since that one releases its dependents only
after it (C-51: `r1 → r2 → e` ranked `r1` 0, behind every idle restore,
and `e` waited for it; skipped when no restore feeds an exec task, so an
all-hit run pays nothing). The rank can count a diamond twice; that only
reorders restores among themselves, on a lane twice the exec cap. A warm run's exec tier is its group tasks with no
edges among them, and the whole-graph closure (476 packages: 1,428
nodes, 12.8k edges of 45-word bitsets) was 10 ms of the run-graph
stage (48.1 → 37.7 ms, min of 6).
When `priorities` is passed, `mergePriorities` scales those weights
(by 2^20, the lowest of them, 0 at most, mapped to one step) to sort
above the baseline for every covered node, a weight of 0 or below
included, with the
baseline as the tie-break inside the override set. Nothing in core
computes one; it is the seam a scheduling-policy plugin
(`@vzn/vx-history`) feeds.

### Failure isolation

A failed task does not stop the scheduler: its transitive exec-tier
dependents get `skipped`, through a restore-tier hit between them too
(the hit stays a `cache-hit`, its key being its deps' inputs, and passes
the block down with the root); unrelated tasks continue; the promise
resolves only after every task has _some_ outcome (an idle server
and its groups excepted, above). This is Turbo's
middle `--continue` setting, `deps-ok`, as the default; `never` stops
dispatch at the first failure (in-flight tasks finish, everything not
yet started — restores included — completes `skipped`); `always` runs
dependents on a failed upstream, and the orchestrator withholds their
save (`ExecuteArgs.taintedUpstream`), since a healthy key over bytes
built on a partial tree would be the next clean run's stale hit. A
skipped outcome names the failed or aborted task at the root of its
block (`blockedBy`); fail-fast's skips name nothing. A rejected
`execute` promise becomes a `failed` outcome; a `UserError`, a
file-system refusal or running out of descriptors reports plainly, once per run (a repeat says `as
<id> above`), anything else as `[vx] internal error in <id>`. The line
goes to `onError` before the outcome lands (stderr when absent); a run
gives it the task's own stderr, so the task's frame and the failure
recap carry it. One that rejects after the run's stop is the stop's
doing (a runtime probe it killed) and becomes `aborted`, with no line
(C-65).

### What this does NOT do

- Doesn't compute the graph (that's `task-graph.ts`).
- Doesn't know about caching — `execute` is the seam; the
  restore-tier set is opaque input classified by the orchestrator
  (`local-shortcircuit.ts`).
- Doesn't enforce timeouts (that's `exec.timeout` in the runner).

### Tests

`tests/scheduler.test.ts`: topo order, concurrency cap, skip
propagation, independent siblings, throw handling, priority contract,
a perf guard on `computeReverseDepCount` (dense 100×30 graph must
stay under 1.5 s; old code took 7.2 s), and the two-tier contract
(restore-tier ready immediately / low priority / failed-dep bypass).
`tests/scheduler-properties.test.ts` holds the promises over seeded
random graphs (restores, demotions, groups, pools, an admission policy,
failures, a stop, each `--continue` mode): one outcome per task, an
exec task starts after everything above it finished, `deps-ok` never
runs over a failure, a skip names a failed ancestor, nothing starts
after the stop, every lane stays under its cap; and the taint tracker
against its definition (C-70).
`tests/graph-pipeline-properties.test.ts` feeds `buildTaskGraph`'s
output over random workspaces that sometimes cycle into `runGraph`: a
refusal names a simple cycle of real edges, build and serial order
repeat, each task runs at most once, after its deps, under the cap,
and each `--continue` mode runs exactly the tasks it promises.

### Replacing this module

The contract is small: take a graph + an `execute`, return outcomes.
Keep `ScheduleOptions` and `TaskOutcome` shapes stable to avoid
churning consumers. Distribution (fanning `execute` to remote
workers) is a plugin's job through the `executor` seam —
`@vzn/vx-reapi` does it against a Bazel REAPI worker pool — and it
reuses these types unchanged; the scheduler never knows where a task
ran.

## `src/graph/folds.ts` — which dependencies a key folds

### Purpose

The fold relation on the graph alone, before any hash exists: which of a
task's dependencies its cache key folds, per its `inputs.tasks`. The
hash path (`orchestrator/upstream.ts`), the sandbox's keyed set
(`keyed-projects.ts`), the stable-key gate and `vx lock`'s input-overlap
rule (`task-graph.ts`) all read this one selection, so they cannot drift.

### Public surface

```ts
// A group runs nothing: no `exec`.
export function isGroupTask(node: TaskNode): boolean
// `node.deps` less `node.orderOnly`: the dependencies a key may fold.
export function keyedDeps(node: TaskNode): readonly string[]

export interface FoldCandidate {
  node: TaskNode
  unit: string // what the fold dedups by: the hash, or a stand-in equal exactly when the hashes are
}
// `inputs.tasks` applied in order, last write wins; undefined selects all, [] none.
// An edge in `standIns` (the task's `standInsOf`) is selected with any edge it went past.
export function selectFoldedDeps(
  deps: readonly FoldCandidate[],
  filter: readonly string[] | undefined,
  selfProjectName: string,
  selfTaskId: string,
  standIns?: StandIns,
): FoldCandidate[]
// The dependencies one task's key folds, as `keyUpstream` hands them to
// the key: scheduled edges less order-only ones, plus `excludedUpstream`.
export function foldedDeps(node: TaskNode, nodeOf: (id: string) => TaskNode): FoldCandidate[]
// An `inputs.tasks` spec that matches a member only through a group is refused,
// and an exact one that names no dependency.
export function refuseFiltersThroughGroups(nodes: ReadonlyMap<string, TaskNode>): void
```

### Rules

- **A filter selects among the task's own dependencies, never through a
  group.** `build.*` over a group `build` misses the members the key
  does not fold otherwise, so it is refused rather than decoupling the
  key, also when it matches another dependency directly.
- **An exact filter names a dependency.** The load pairs a `pkg#task`
  entry or dependency with any form whose task half matches, unable to
  tell this project's name from another's, so `['nope#build']` over
  `dependsOn: ['build']` (or `['build']` over `['b#build']`) selected
  nothing and replayed a stale hit. Once the graph is built (`vx lock`,
  `--check` and a run's plan) it is refused unless a `^` entry or a pattern names its task, either of
  which may match nothing in a preset's project.
- **A group folds every dependency**; an exec task what its
  `inputs.tasks` selects (absent means all).
- **Folded transitively counts.** `vx lock` lets a task read a
  producer's outputs only when the producer is in its `dependsOn`
  closure and in none of the folded closure this relation walks.
