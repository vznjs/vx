# `src/history/` — what runs leave behind, written and read back

## `src/history/history.ts` — per-task duration history

### Purpose

A per-run, read-only `HistoryTable` snapshot: each `(project, task)`
pair's rows over the last N **invocations**, folded into one row each
(p50 / p99 duration, success rate, hit rate, failure mode) by one
aggregate over a rowid slice of `cache.db.runs`.

### Public surface

```ts
export interface TaskHistory {
  runs: number
  p50DurationMs: number | undefined
  p99DurationMs: number | undefined
  successRate: number
  hitRate: number
  failureMode: FailureMode
  maxPeakRssBytes?: number
  maxCpuParallelism?: number
  saturatedCores?: number // the most cores of a machine it filled (resourcesFor)
  saturatedMemoryBytes?: number // and the most memory
  slowDurationMs?: number // a slow run: the slowest the forecast read, or the server's (resourcesFor)
}
export type HistoryTable = ReadonlyMap<string, TaskHistory>
export type TaskResources = Pick<
  TaskHistory,
  | 'p50DurationMs'
  | 'maxPeakRssBytes'
  | 'maxCpuParallelism'
  | 'saturatedCores'
  | 'saturatedMemoryBytes'
  | 'slowDurationMs'
>

export interface HistoryProvider {
  loadFor(taskIds: readonly string[]): Promise<HistoryTable>
  /** `loadFor`'s p50s alone; optional, a reader without it uses `loadFor`. */
  p50sFor?(taskIds: readonly string[]): Promise<ReadonlyMap<string, number>>
}
export class EmptyHistoryProvider implements HistoryProvider {}

// failure-mode.ts, not history.ts:
/** A task whose SAME cache key failed after it had passed — the definition
 *  of flaky, answered from local history with no service. Named in a
 *  run's footer, listed by `vx info`. */
export interface FlakyTask {
  taskId: string
  project: string
  task: string
  keys: number // distinct keys that failed after a pass
  passes: number
  failures: number
}
export function flakyTasks(db: Database): FlakyTask[]
/** An executed, keyed outcome of the run in progress, what `detectFlaky` judges. */
export interface FlakyCandidate {
  project: string
  task: string
  hash: string
  status: 'success' | 'failed'
  attempts: number // > 1 is a within-run retry
}
/** One task the run just proved nondeterministic; `passes`/`failures` fold this run in. */
export interface FlakyFinding extends FlakyCandidate {
  taskId: string
  passes: number
  failures: number
}
// judged before the run's own rows are recorded; no candidate, no query
export function detectFlaky(db: Database, candidates: readonly FlakyCandidate[]): FlakyFinding[]
// asked after a failure only: does the record know this task as flaky?
export function knownFlaky(db: Database, project: string, task: string, hash: string): boolean

// history.ts again:
export const PASS_STATUSES: string // the pass set as SQL `(…)`, derived from `isPassStatus`
// What a plugin reads history through (the façade's only door to it): the
// provider below over `cache`'s index, typed so no handle leaves core.
export function localHistory(cache: Cache, options?: LocalHistoryOptions): LocalHistory
export interface LocalHistoryOptions {
  recent?: number // the window; default 50 invocations
  branch?: string | null // undefined: a forecast reads every branch
  defs?: ReadonlyMap<string, string> // `taskDefinitions`: rows of each task as it is now
}
// LocalHistory: HistoryProvider + resourcesFor, durationsFor, measuresFor, hasImported, importTimings.
// measuresFor: each plugin measure's forecast, tiered as a task's duration
export interface MeasureForecast {
  durationMs: number // median of its newest timings
  cores?: number // median of the same rows' cores
}
// Core's own readers (`vx last`, `--dry`) build the provider on the handle.
export class LocalHistoryProvider implements HistoryProvider {
  // without branch a forecast reads every branch
  constructor(
    db: Database,
    recent?: number,
    branch?: string | null,
    defs?: ReadonlyMap<string, string>,
  ) // the window; defaults to 50 invocations
  /** `loadFor`'s p50 and resource maxima, without its rates. */
  resourcesFor(taskIds: readonly string[]): Promise<ReadonlyMap<string, TaskResources>>
  /** Only `resourcesFor`'s p50s: the forecast, else a restored task's producer time. */
  durationsFor(taskIds: readonly string[]): Promise<ReadonlyMap<string, number>>
  /** The last forecast read found a task with no timing on this branch. */
  lackedBranchHistory: boolean
  hasImported(sha: string): boolean // rows of default-branch commit `sha` exist
  // of `taskIds`, each whose one timing is at or after `since` (`vx last`'s `—`): two rows per task by index
  timedOnlySince(taskIds: readonly string[], since: number): string[]
  // each task id the window's rows name, sorted: what a mistyped id is matched against
  recentTaskIds(): string[]
  // one 'remote' row per task, with its measured need from `needs` (v45)
  importTimings(
    sha: string,
    timings: ReadonlyMap<string, number>,
    needs?: ReadonlyMap<string, TaskResources>,
  ): void
}
```

### The forecast

Every `p50DurationMs` (and `p50sFor`) is a forecast (2026-10-14):
the median of the task's last five timings on this run's branch, else
the default branch's newest imported timing, else the median of the last
five on any branch, else none. A timing from a crowded worker (`cpuShare`
< 1) is the time the task would take alone, so a plan does not carry the
crowd of the run it learned from. An import (`importTimings`, by
`@vzn/vx-history` from its history server) is rows tagged `remote` with
the commit, unique per (commit, task), so a repeat import from any worktree
adds nothing; a store with no import pays one probe of that partial
index, never a query per task, and a store with no timing at all (a
cold cache, a first run) one probe of the table, no tier (20 ms of a
cold 8,002-task schedule stage). `resourcesFor` gives a task with no run
in its window the newest imported row's need, so a fresh machine packs
by what the default branch measured. Each tier is one statement over every
task still unanswered (`json_each`), an index probe per task inside
SQLite: 5-8 ms for 2,000 tasks, where a query per task was 31-40. The read learns whether some task lacked
a timing on its branch (`lackedBranchHistory`), so a caller deciding to
import asks no second question. The timings are
`task_durations` in the shared store (`schema.ts`), one row per executed
success appended in the run's history transaction and tagged
`branch:<name>` with the commit, so every worktree of the repo reads them
and a new one forecasts on its first run; `vx last` and the runs stay
per worktree. A read is a point lookup per task on `(project, task,
source, id)`, exact however old the rows. A run learns its branch once
(`run.branch` if set, else git's, else the CI provider's;
`PreparedRun.branch`, the schedule hook's `ctx.branch`;
`currentBranch` in `run-context.ts` for any other reader).
`p99DurationMs`, the rates and the resource maxima stay over the
window. `tests/history-forecast-branch.test.ts`.

A reader given the run's definitions (`taskDefinitions`, the fourth
argument) reads only the rows of each task as it is now. Every row
carries the task's definition: an xxh3 of its id, command and
`env.define` (`graph/definition.ts`). A task whose command or defines
changed under the same name starts over (2026-10-23); editing its
inputs, outputs, cache, sandbox grants, timeout, description or
dependencies keeps its history. An imported timing carries the
definition it was taken of (the blob's `defs`); a row of none (a blob
shared before definitions were kept) is read by every reader, or a PR's
first run would have read every task unmeasured. `tests/history-definition.test.ts`.

### Who reads it

- Every row's `usual` (running and finished, terminal and log) and the
  live region's end-of-run forecast (`p50sNow`), read once per run on
  the first row that asks: a run that executes nothing never reads it.

- `plan.ts` (`--dry`): attaches each would-run task's p50 and
  predicts the run's wall-clock, through `p50sFor` when the provider has
  it: the executed successes' durations alone, 4 ms against `loadFor`'s
  38 at 27,000 rows (its rates and per-hit entry join read every row).
- `@vzn/vx-history` (opt-in): the `schedule` stage's
  priorities and reservations, over a 20-invocation window by default,
  through `resourcesFor`: the executed successes grouped alone and the
  hits as distinct keys, each joined to its entry once. 148 ms against
  `loadFor`'s 407 at 168,000 rows (8,002 tasks), the same numbers
  (`tests/history-p50s.test.ts`). Its timings file, written at the run's
  end, takes `durationsFor`: the same p50s without the window's grouped
  reads, the hits read only for a task with no forecast (23-27 ms
  against 40 at 8,002 tasks). `vx history` reads `loadFor` (it shows
  runs).
- Nothing on the default `vx run` path.

### The window is a rowid slice

`runs` has no `(project, task)` index (it cost every run a scattered
B-tree write per task and bought this reader nothing; `caching.md`). Rows
are appended in time order, one contiguous block per invocation, so the
rows of the newest `recent` invocations are exactly `id >= MIN(id)` of
the newest `recent` `invocations` headers' rows (an index probe per
header; a run of only a group records a header and no row): a
primary-key range, no sort, plain aggregates. At most one row per pair per invocation, so the
slice IS the last `recent` runs for a pair that runs every time, and
whatever fewer it has for one that runs less often — a hint for ordering
and prediction, not a ledger (`vx why` / `vx last` read by `run_id` and
stay exact). Measured 2026-09-09 at 116k rows, 1,000 pairs, window 50:
550 ms for the ranked-per-pair query the index served → 50 ms.

### Invariants

- Zero cost on a plain run: no history query is issued.
- `LocalHistoryProvider(db, window)` (and `localHistory`) reads only; `importTimings` is its one write; `EmptyHistoryProvider`
  is the no-history stand-in.
- The flakiness / failure-mode verdict is `failureModeOf` over
  `mixedOutcomeKeysSql` (`failure-mode.ts`) — one rule, applied here over
  the window and by `mixedOutcomeKeyCount` over a task's whole history,
  so the two cannot disagree. The window's key-outcome pass runs only for
  pairs that failed without a retry already proving nondeterminism.
- `saturatedCores` / `saturatedMemoryBytes` (`resourcesFor` only): the
  most cores, and the most memory, of a machine an executor ran the task on
  (`placement_cores`, `placement_memory`) that it filled: 90% of the cores
  over its run on average (a burst to every core is not), or 90% of the
  memory. Failures count: a task killed for memory filled its machine. `@vzn/vx-dte` runs
  such a task on a bigger size next time.
- Skipped rows (`status = 'skipped'`) are excluded from the window
  (`EXECUTED_RUNS_SQL`), so a run of skips cannot dilute the numbers.
- `maxPeakRssBytes` is the maximum and `maxCpuParallelism` (cpu time over
  wall time over the CPU share) the mean over the window's successful
  executions (one crowded run's reading booked a build a whole Mac, main
  b5b83bb), plus — for hit rows —
  what the PRODUCING execution used, read from the hit's `entries` row
  (a primary-key join, hit rows only): the artifact's sidecar carries it,
  save and ingest index it, so a task this machine has only ever
  restored (a fresh runner behind a remote cache) still has a number.
  The entry keeps no CPU share, so a crowded producer's use reads low:
  a hit's `maxCpuParallelism` counts only for a task no execution here
  measured and (`resourcesFor`) no default-branch import names. A
  hit's own row says what the restore cost, never what the task needs; a
  failure's usage is not what the task needs to succeed; an entry pruned
  since contributes nothing. Absent when no row carried the number.
  `resourcesFor` times a task with no forecast by its hits' producers,
  the longest: a task made on a branch that main only restores has no
  timing of its own anywhere.
  `@vzn/vx-history` turns them into the reservations its
  `admit` hook packs (`docs/design/resource-estimates-2026-09.md`).

### The per-run surfaces (`failure-mode.ts`)

The same rule, applied at the end of every run and by the doctor:

- `detectFlaky(db, candidates)` — each a `FlakyCandidate`
  (`{ project, task, hash, status, attempts }`): the run's executed, keyed,
  cache-declaring outcomes (`run.ts` builds the list; a hit, a skip, a
  group or a task with no `cache: true` is not one), judged BEFORE the
  run's own rows land. A failure on a key that passed before, a pass on
  a key that already failed after a pass, or a within-run retry is a
  `FlakyFinding` (a first pass after only failures is a recovery)
  with the key's outcome counts, this run folded in. `run.ts` judges each
  task as it finishes, so its row carries the note (`flakyNote`).
- Both read the shared store's flaky record, `task_outcomes` (v38), not
  this workspace's `runs`: every worktree of a repo judges a key on what
  all of them saw. It keeps every executed outcome that names its key and
  a key's first hit; a later hit replays a pass on record and adds none.
- `knownFlaky(db, project, task, hash)` — asked by the retry loop
  (`execute-task.ts`) after a failure only, so a green run never reads it:
  this key passed before, or a key of the task failed after it passed, or
  a pass took a retry. True gives a task with no `retries` one more
  attempt.
- `flakyTasks(db)` — every task with a key that failed after a pass in the whole
  retained history, most failures first: the `vx info` row. A pass that
  took a retry is one `success` row; its failed attempts count as
  failures, so it counts on its own. One pass over `task_outcomes` picks
  the keys with a failure or a retry; the projection reads only theirs, by
  `task_outcomes_hash` (95 ms at 2M rows, against 4.2 s projecting every
  key; a partial index on the candidates would make the pass a probe, a
  schema change). Pinned by plan in `tests/history-scale.test.ts`.
- Cost follows the run's colour. No candidate: no query. A green miss:
  one probe of `task_outcomes_hash` (a key holds a handful of rows),
  which answers "did this key ever fail?" in microseconds at any history
  size. Only a key that did fail before, or a task failing now, pays the
  projection over its own keys. Recording a warm run's hits costs one
  probe of the same index, ~1 ms per 1,000 (2026-10-15). Judged one task at a time
  as each finishes (2026-10-06, so the row carries it): 1,000 green
  misses cost 3.0 ms in all against 0.4 batched, spread over the run
  beside 1,000 spawns.
- Every reader is a filter over one projection, `keyOutcomesSql`, so
  the definition of "mixed" cannot fork between the window, the
  all-time count, the run's findings and the doctor's list.
- Percentiles are over the slice's executed-success rows; rates count
  every executed row. A hit is a success in `successRate` (the pass
  statuses, from `isPassStatus`).

### Tests

`tests/history.test.ts`, `tests/plan-predict.test.ts`,
`tests/run-record-completeness.test.ts`, `tests/history-scale.test.ts` (the plans of
`vx last`'s, `vx why`'s and `vx info`'s reads of a long history); `tests/failure-mode.test.ts`
(the rule, `detectFlaky`, `flakyTasks`, the partial index's plan and
its creation on an older database); `tests/flaky.test.ts` (end to end:
footer, `vx last`, `vx info`, with a hit and a changed-key break as
controls).

## `src/history/metrics.ts` — run-history queries

### Purpose

Pure functions over the run-history tables (`runs`, `invocations`,
`entries`, `entry_inputs`) — one canonical home for every aggregate,
so `vx last`, `vx why` and any other reader ask the same questions the
same way. The schema itself is owned by `src/index-db/schema.ts`; this
module only reads it.

### Public surface

```ts
listRuns(db, { limit?, project?, task?, runId? }): RunSummaryRow[]
getRun(db, runId): RunDetail | null                 // one invocation's task rows
listInvocations(db, { limit? }): InvocationDetail[]
getInvocation(db, runId): InvocationDetail | null   // the header row, tags parsed
explainCacheKey(db, taskId): CacheKeyExplanation    // latest entry for a task
latestRunId(db, taskId): string | null              // the run a caller without one means
whyDidThisRerun(db, runId, taskId): WhyDidThisRerun // this run vs the previous one
cacheKeyDiff(db, runId, taskId): CacheKeyDiff       // which key components moved
diffsOlderRun(diff): boolean                         // the diff is against the last run that saved an entry, not the previous one (its note names it)
rootCauses(db, runId, taskId, entries, groups?): RootCause[] // under moved upstreams (through groups), the tasks whose own inputs moved between the keys the dependant folded; on its own stack, each visit linked to the one that reached it, so no chain is copied per level
recordedTasks(db, runId): Set<string>               // the run's rows as project#task, read once
upstreamTask(name): string                           // the task an upstream row names, past a group (GROUP_VIA)
inputWriters(db, runId, root, taskId, entries, roots): InputWriter[] // tasks running when a moved input file last changed, if not after run runId ended (stats and asks once per file)
loadEntryInputs(db, entryHash): TaskInputComponent[] // one entry's key components, [] when none
diffKeyComponents(before, after): { entries, unchangedCount } // the join, no store

// The argument and row types, exported from the module index:
ListRunsArgs        // { limit?, project?, task?, runId? }
ListInvocationsArgs // { limit? }
CacheEntryRow       // an entries row: hash, project, task, command, exitCode, durationMs, sizeBytes, createdAt, accessedAt
InputDiffEntry      // one moved component: kind, name, change ('added' | 'removed' | 'changed'), before, after
RootCause           // { chain: the asked task down to the root, built on each read; task: the root; entries: its own moved components }; JSON is { chain, entries }
InputWriter         // { taskId, file, writers: the tasks running when the file last changed }
```

`run-failures.ts` beside it keeps a failed run's task output as rows of
cache.db's `failures` (caching.md § Schema), through
`cache/run-notes.ts`:

```ts
writeRunFailures(cache, runId, outcomes, warn): void // at run end; only when an outcome carries failedOutput or inputMoved; newest 50 failed runs kept; a refused write warns
runFailures(db, runId?): RunFailures | null // default the latest failed run; a failed task with no kept row reads output ''
taskLog(db, taskId, runId?): TaskLog | null // default the latest run that recorded the task

export interface RunFailures {
  runId: string
  tasks: TaskFailure[]
}
export interface TaskFailure {
  taskId: string
  exitCode: number
  timedOut?: true
  inputMoved?: string // the input that changed during the run (inputs.stability 'error')
  output: string // '' when the run kept none
  locations: OutputLocation[]
  sandboxFix?: NonNullable<TaskOutcome['sandboxFix']> // the grants that would have allowed its sandbox denials
  fixedIn?: string // the first later run where the task passed
}
export interface TaskLog {
  runId: string
  taskId: string
  status: string
  source: 'failure' | 'cache' | null // the kept failure output, the cache entry's log, or none kept
  output: string // '' when source is null
}
```

`taskLog` reads one task's output: a failed task's from its `failures`
row, any other from the cache entry its key names (the log a hit
replays, masked as it was), and nothing for an uncached pass or a skip.
`vx last --log` answers from it.

`runFailures` lists the run's failed `runs` rows and fills each from its
`failures` row; `vx last --format json` answers from it.

`cache/run-notes.ts` holds the statements over `steps`, `warnings` and
`failures`: what a run said that its `runs` rows do not hold. A run's
steps it did not wait on (`vx:prefetch`), which its output never shows,
and its warnings go in at run end, in one transaction; each table keeps
the newest 50 runs that had any (run ids are UUIDv7, so they sort by
age). `vx last --sql` reads them as it reads `runs`.

```ts
keepRunNotes(db, runId, notes: RunNotes): void // RunNotes: { steps?, warnings?, failures? } // one IMMEDIATE transaction, then the trim; nothing when all are empty
keptSteps(db, runId): RunStep[] // [] when the run kept none
keptWarnings(db, runId): string[] // [] when it said none or they are gone
keptFailures(db, runId): Map<string, KeptFailure> // by task id

export interface RunStep {
  id: string // 'vx:prefetch'
  durationMs: number
  ok: boolean
}
```

The module index re-exports `explainCacheKey` as `explainCacheKeyQuery`
and `whyDidThisRerun` as `whyDidThisRerunQuery`.

`run-id.ts` beside it resolves the run id a caller types:
`resolveRunId(db, raw, verb)` answers the whole id, or the one run it is
a prefix of (null for none; a prefix several runs share is refused,
naming them), and `shortRunId(db, id)` is the shortest unique prefix, at
least 13 characters, `vx last --list` prints. `vx why` and `vx last`
take ids through it.

Every function but `diffKeyComponents` and `upstreamTask` takes an open `bun:sqlite`
`Database` (the caller owns the `Cache` lifecycle — `indexDb(cache)`),
returns JSON-safe shapes (bigint spans as decimal strings, like
`WireEvent.timeUnixNano`), and never throws on a missing row:
`found: false`, `null`, or an empty list, with a `note` that says which
case it is.

### The two explanations

- `whyDidThisRerun` compares a task's row in `runId` with its
  immediately previous row: `hashChanged` when the keys differ; when
  they do not, the note says whether the run was served from cache,
  recorded no cache outcome at all, or re-executed on the same key — and
  why, from what the index holds: the previous run on the key failed
  (saving nothing), the invocation's `cache_policy` read no cache, or
  the key's entry was created by this run (none was there when it ran),
  or the previous run was not saved because it ran beside a failed task
  (a task run past a failed dependency under `--continue` is never
  cached; ahead of the prune verdict, and "neither run saved it" when
  this run ran beside one too and saved nothing either), or
  the previous run executed and succeeded and no entry holds the key (its
  save failed or was pruned: no row records a failed save, only this
  trace; a previous policy that wrote nothing is named instead, ahead of
  the prune verdict, and so
  is a `blocked_by` that run has no row of: the dependency
  `--exclude-dependencies` left out).
  Only when none applies does it name `--no-cache` / `--force` (item
  1009), and only with no recorded policy: a recorded one that read the
  cache rules the flags out, and the note says vx cannot name the cause
  (X-46).
- `cacheKeyDiff` is the moat: it resolves both runs to their task
  hashes and full-outer-joins the two `entry_inputs` fingerprint sets
  over `(kind, name)` — `changed` / `added` / `removed`, unchanged ones
  counted — with no config re-evaluation and no re-hash. A side with no
  fingerprints is named for why: a run that failed, wrote no cache, or
  passed beside a failed task (`--continue`),
  an entry a remote hit restored (a `cache-hit-remote` row of that key:
  the artifact carries none), and only then a prune. Values are
  digests, never the material (an env value can be a secret), and a
  secret-named env input's digest leaves as `***` (unsalted, a short
  value is recoverable from it, M-62), as does one its task's
  `exec.env.secret` names, whose stored row carries a `***` mark (M-63); STATUS
  § Next 8(g) records why a plugin part's raw value is not stored.
- `diffKeyComponents` is that join with no store under it: two keys'
  `{ kind, name, hash }` sets in, the entries (ordered by kind, then
  name, in code units, not `localeCompare`, whose order follows the
  machine's locale, item 707) and the unchanged count out. `cacheKeyDiff`
  calls it on the two `entry_inputs` sets (item 703).

Keyed-run filtering (`KEYED_RUNS_SQL`, the cache module's) is
imported, not restated, so a rule written once cannot drift between
readers.

### What it does NOT do

- Open or close anything; no `Cache` lifecycle.
- Evaluate configs or recompute a key — `explainCacheKey` says so in
  its note: it returns persisted entry metadata.
- Write rows. `recordRunBundle` (`cache/run-history.ts`) is the writer.

### Tests

`tests/metrics.test.ts` (every query, the three unchanged-key notes,
the diff's four verdicts and its order by kind and by name, degraded
rows whose fingerprints were pruned; the root-cause walk and the
writers over a 10,000-task chain, by memory and statement count);
`tests/run-record-completeness.test.ts` (a run writes what these read);
`tests/status-vocabulary.test.ts` (no hand-typed status lists).

### Replacing this module

A reader over another store implements the same twelve signatures (the
join, `diffKeyComponents`, needs no store and is reused as it is, and
`diffsOlderRun` answers only for this module's own `cacheKeyDiff`
results, so such a reader supplies its own); the CLI verbs format, they
do not query.

## `src/history/miss-reason.ts` — what a miss's key changed

### Purpose

A telemetry sink wants to say why a task ran: "rebuilt because a source file changed". `vx why` answers that after a run, from the run
history; this answers it during one, so a live export carries it. A
missed task's key components (captured before its command spawns)
are joined with those of the last entry the cache saved for the same
task, by `diffKeyComponents`, the rule `vx why` uses.

### Public surface

```ts
export type MissExplainer = (
  taskId: string,
  components: readonly TaskInputComponent[],
) => InputChanges | undefined
export function createMissExplainer(db: Database): MissExplainer
```

- Undefined when the cache holds no earlier entry for the task, or its
  fingerprint rows are gone; a count of 0 when the key is the entry's
  own (the entry went, so the task ran).
- Names the first ten changes; `count` is all of them. Hashes are left
  out, so a secret input's value never reaches a sink.

### Cost

`run()` creates one only when a telemetry sink exists. The first miss
reads the newest entry per task (one `GROUP BY` over `entries`); each
miss then reads its entry's `entry_inputs` by primary key. A hit asks
nothing.

## `src/history/history-writes.ts` — a run's rows into the store's index

### Purpose

`runHistory(cache)` is the one writer of a run's history: `RunHistory`
over the handle the cache exposes (`indexDb`), gated as the cache's own
writes are (`indexWritable`) and digesting value-bearing rows with its
salt (`valueDigest`). Core records each run itself; no plugin writes the
history.

`recordRunBundle()` is the write at a run's end: one `runs` row for every
task (hits and misses, successes and failures) and one `invocations`
header row (command, git/CI/host context, run-level counts) **atomically
in one transaction**, less the hits a `HistoryStream` already wrote while
the graph ran, with one shared-store `task_durations` row per executed
success, tagged `branchSource(branch)` (`'branch:<name>'`, `'branch:'`
with none) and the commit: what a duration forecast reads. The
input-fingerprint rows (`entry_inputs`) are NOT written here: they ride
each entry's save transaction (miss path only), so a warm all-hit run
writes none.

### Public surface

```ts
export interface HistoryWrites {
  recordRun(run: RunRecord): void
  recordRuns(runs: readonly RunRecord[], head?: RunHead): void
  recordMeasures(measures: readonly MeasureRecord[], head: RunHead): void
  recordRunBundle(bundle: { runs: readonly RunRecord[]; invocation: InvocationRecord }): void
  recordRemoteErrors(runId: string, errors: readonly (readonly [string, string])[]): void
}
export function runHistory(cache: Cache): HistoryWrites
```

## `src/history/run-history.ts` — the `runs`, `invocations` and timing rows

### Purpose

`RunHistory`: `runs` + `invocations` writes (one transaction per run, plus one per streamed batch of hits), the SQL binders, and the 30-day retention (run by a prune only, never a run's close; a dry-run prune deletes nothing, item 1004).

### Public surface

```ts
// (Tier 3) One header row per `vx run` invocation — see the
// `invocations` table in docs/caching.md.
export interface InvocationRecord {
  runId: string
  command: string
  requestedTasks: string // JSON string[]
  cachePolicy: string // the --cache-policy spec, e.g. 'local:rw,remote:r'
  concurrency: number
  flow: 'focused' | 'broad' | null
  startedAt: number
  endedAt: number
  totalDurationMs: number
  taskCount: number
  failedCount: number
  hitCount: number
  hitLocalCount: number
  hitRemoteCount: number
  // v31: the hits by what they did to the disk; they sum to hitCount
  upToDateCount: number
  restoredLocalCount: number
  restoredRemoteCount: number
  exitOk: boolean
  commitSha: string | null
  branch: string | null
  dirty: boolean | null
  ci: boolean
  ciProvider: string | null
  host: string | null
  os: string | null
  arch: string | null
  vxVersion: string
}

export interface RunRecord {
  hash?: string // absent = no cache key derived (skipped, or persistent with no dependant); stored as ''
  project: string
  task: string
  status: 'success' | 'failed' | 'cache-hit' | 'cache-hit-remote' | 'skipped'
  exitCode: number
  durationMs: number
  forwardArgs?: readonly string[]
  startedAt: number // ms-epoch
  endedAt: number // ms-epoch
  // v11 analytics columns (all optional; populated by runner / orchestrator)
  runId?: string // UUIDv7 shared across all tasks in one `vx run`
  cpuMs?: number // user + system CPU time from Bun.spawn rusage
  peakRssBytes?: number // peak resident set size
  wallclockStartNs?: bigint // hrtime span relative to run t=0
  wallclockEndNs?: bigint
  cacheHit?: boolean // convenience for flamegraph color; absent (NULL) on a hit whose restore failed
  restored?: boolean // v31, on a hit: outputs restored (true) or already up to date (false)
  attempts?: number // >1 when the task retried (the within-run flaky signal)
  cached?: boolean // the task declared `cache`
  // v27: why it failed or was skipped, as the run's footer said it
  blockedBy?: string
  timedOut?: true
  sandboxViolations?: number
  notReady?: 'timeout' | 'exited' | 'spawn'
  remoteError?: string // v40: each failed remote read or write of its key, `; `-joined
  peakCores?: number // v43: sampled, most cores one interval burned
  avgRssBytes?: number // v43: sampled, mean resident memory
  placement?: string // v44: where an executor ran it (`small#1`)
  placementCores?: number // v44: that machine's cores
  placementMemoryBytes?: number // v44: and memory
  keylessBy?: string // v46: the task with no inputs its key folded
  def?: string // v48: the task's definition (`taskDefinition`), which history reads by
  cpuShare?: number // v49: the share of a core its threads got there; history divides its CPU by it
  queuedMs?: number // v51: waited ready for a slot
  outputBytes?: number // v51: its output files' bytes, restored or saved
  blocks?: number // v51: the tasks and groups downstream of it in the run
  flakyPasses?: number // v51: the flaky record its row quoted
  flakyFailures?: number
}

// A plugin measure kept as a timing (the `measures` seam).
export interface MeasureRecord {
  // …
}
export class RunHistory {}
```

## `src/history/history-stream.ts` — a run's hits written on a thread

### Purpose

`HistoryStream`: a run's hits written on a thread of their own while the graph runs, 512 to a transaction, through a second connection on the same files (`historyFiles(cache)`). The thread starts only for a run of 2,048 hits or more (its confirmed local hits after the classify, or the hit that reaches it): below that its start cost more than it saved. A batch the thread does not land comes back and goes in the bundle. The writer is a second `bun build --compile` entry point. `src/history/history-writer.ts` is
the thread's own entry point.

### Public surface

```ts
// A run's hits written on a thread while the graph runs, 512 to a
// transaction, once `expected` (its confirmed local hits) or the hits
// added reach 2,048; `finish` hands back what did not land, for the bundle.
export class HistoryStream<T> {
  constructor(files: { index: string; store?: string }, expected: number)
  add(item: T, record: RunRecord): void
  finish(): Promise<{ landed: Streamed<T>[]; unlanded: Streamed<T>[] }>
}
```
