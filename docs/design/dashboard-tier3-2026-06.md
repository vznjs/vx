# Dashboard Tier 3 — schema, recording, and the input-fingerprint moat (2026-06)

> **Status:** proposal

Implements Tier 3 of `docs/design/dashboard-competitive-2026-06.md`: the
features that need durable schema. Tier 1–2 shipped read-only over the existing
`runs`/`entries` tables; Tier 3 adds the data those tables never recorded —
**per-invocation git/CI context**, **per-task input fingerprints** (the
Develocity "which exact input changed" diff), **tags + `--report`**, and a
**local-vs-remote hit-rate split**.

Owner directive: "do all, no stopping, don't care about backward compatibility."
The schema gate (`cache.ts` ~L541) drops + recreates tables on a `SCHEMA_VERSION`
mismatch, so there is **no migration burden** — we add tables and bump the
version.

## What we're solving

1. The top object today is a task row. A `vx run` invocation has no header row,
   no git/CI/host context, no command, no tags. `listInvocations` reconstructs
   one with a `GROUP BY run_id` over `runs` — lossy and slow.
2. `whyDidThisRerun` can only say "the hash changed." Inputs are folded into the
   key and discarded, so we can't name the file/env/upstream that actually
   differed. This is the single most-cited feature in the field (the moat).
3. No tags, no PR-comment report.
4. Hit-rate is blended; `cache-hit` vs `cache-hit-remote` already distinguishes
   local from remote but no query/view splits them.

## Access pattern (this drives the schema)

- **Write:** once per `vx run`, batched. One `invocations` row; N
  `run_task_inputs` rows (one per cache-key component, per task, ~10–100
  components × ~1–3000 tasks). All in **one transaction** alongside the existing
  `recordRuns`. The component values **already exist in memory** at hash time
  (`CacheKeyInput`) — we are persisting, not recomputing.
- **Read (diff):** "for run R, task T, what changed vs the previous run of T?"
  = two indexed `SELECT`s on `run_task_inputs` + a SQL anti-join. Pure SQL,
  no app-side recompute.
- **Read (filter):** "invocations on branch X / with ci=1 / tagged k=v" =
  indexed `SELECT` on `invocations`.

Normalized rows beat a JSON blob here precisely because the hot read is a
**diff** — `(kind,name,hash)` rows anti-join in SQL; a JSON blob would force a
full app-side parse + compare of every component on every probe.

## Version decision

- `SCHEMA_VERSION` → **v22**. New tables (`invocations`, `run_task_inputs`) +
  added `runs` columns. The gate drops the old set and recreates.
- `CACHE_VERSION` stays **v24**. The cache **key derivation is unchanged** — we
  persist components already fed to `Cache.key()`; we do not add to, reorder, or
  reweight anything inside `key()`. Artifact bytes are untouched. A task's hash
  is byte-identical before and after Tier 3. (If any implementer finds they must
  change `key()` to capture a component, stop — that means the capture point is
  wrong; capture must read the same `CacheKeyInput` the key already consumes.)

The DROP-gate line (cache.ts ~L543) becomes:

```sql
DROP TABLE IF EXISTS entries; DROP TABLE IF EXISTS runs;
DROP TABLE IF EXISTS file_hashes; DROP TABLE IF EXISTS output_files;
DROP TABLE IF EXISTS invocations; DROP TABLE IF EXISTS run_task_inputs;
```

## Concrete schema (DDL)

Added to the `CREATE TABLE IF NOT EXISTS` block in `cache.ts` (~L552).

### `invocations` — one header row per `vx run`

```sql
CREATE TABLE IF NOT EXISTS invocations (
  run_id           TEXT PRIMARY KEY,         -- ULID, == runs.run_id
  command          TEXT NOT NULL,            -- full argv, e.g. "vx run build test --all"
  requested_tasks  TEXT NOT NULL,            -- JSON string[] of options.tasks
  cache_policy     TEXT NOT NULL,            -- "lR,lW,rR,rW" compact flags, e.g. "rw,rw"
  concurrency      INTEGER NOT NULL,
  flow             TEXT,                     -- 'focused' | 'broad' | NULL (programmatic)
  started_at       INTEGER NOT NULL,         -- ms-epoch
  ended_at         INTEGER NOT NULL,
  total_duration_ms INTEGER NOT NULL,        -- wall clock of the whole run
  task_count       INTEGER NOT NULL,         -- non-group, non-aborted tasks recorded
  failed_count     INTEGER NOT NULL,
  hit_count        INTEGER NOT NULL,         -- cache-hit + cache-hit-remote
  hit_local_count  INTEGER NOT NULL,         -- cache-hit
  hit_remote_count INTEGER NOT NULL,         -- cache-hit-remote
  exit_ok          INTEGER NOT NULL,         -- 1 if the run's `ok`
  -- VCS / CI / host context (all nullable: not a git repo, env probe failed)
  commit_sha       TEXT,
  branch           TEXT,
  dirty            INTEGER,                  -- 1 if worktree had uncommitted changes
  ci               INTEGER NOT NULL,         -- 1 if a CI env was detected
  ci_provider      TEXT,                     -- 'github' | 'gitlab' | 'generic' | NULL
  host             TEXT,                     -- os.hostname()
  os               TEXT,                     -- process.platform
  arch             TEXT,                     -- process.arch
  vx_version       TEXT NOT NULL,            -- VERSION
  tags             TEXT NOT NULL DEFAULT '{}' -- JSON object {k:v} from --tag
);
CREATE INDEX IF NOT EXISTS invocations_started ON invocations(started_at);
CREATE INDEX IF NOT EXISTS invocations_branch  ON invocations(branch);
CREATE INDEX IF NOT EXISTS invocations_ci      ON invocations(ci);
```

Tags filtering is by `tags LIKE '%"k":"v"%'` (good enough; the table is small).
A normalized `invocation_tags(run_id, key, value)` side table is the clean
alternative but unnecessary at this scale — **out of scope**.

### `run_task_inputs` — the input-fingerprint moat

One row per cache-key component, per task, per invocation. Captured for
**hits and misses alike** (a hit still needs the row so the *next* run can diff
against it).

```sql
CREATE TABLE IF NOT EXISTS run_task_inputs (
  run_id   TEXT NOT NULL,            -- == runs.run_id / invocations.run_id
  task_id  TEXT NOT NULL,            -- "project#task"
  kind     TEXT NOT NULL,            -- file|env|runtime|ws-runtime|upstream|package|config|forward|workspace
  name     TEXT NOT NULL,            -- file: workspace-rel path; env: var name;
                                     -- runtime/ws-runtime: command string;
                                     -- upstream: upstream task id;
                                     -- package: "package.json"; config: "config";
                                     -- forward: "argv"; workspace: "fingerprint"
  hash     TEXT NOT NULL,            -- the component's contribution to the key
                                     -- (file: blob OID; env/runtime: value;
                                     --  upstream: upstream hash; package/config/
                                     --  workspace: the hash; forward: joined argv)
  PRIMARY KEY (run_id, task_id, kind, name)
);
CREATE INDEX IF NOT EXISTS rti_task ON run_task_inputs(task_id, run_id);
```

Component → row mapping (mirrors the `key()` fold order exactly so the set is
complete and lossless):

| `CacheKeyInput` field        | kind        | name (per row)        | hash (per row)        |
| ---------------------------- | ----------- | --------------------- | --------------------- |
| `inputFiles` + `fileHashes`  | `file`      | workspace-rel path    | blob OID              |
| `envValues`                  | `env`       | var name              | value                 |
| `runtimeValues`              | `runtime`   | command               | trimmed output        |
| `workspaceRuntimeValues`     | `ws-runtime`| command               | trimmed output        |
| `upstreamHashes`             | `upstream`  | upstream task id*     | upstream hash         |
| `projectPackageJsonHash`     | `package`   | `package.json`        | hash                  |
| `taskConfigHash`             | `config`    | `config`              | hash                  |
| `workspaceFingerprint`       | `workspace` | `fingerprint`         | hash                  |
| `forwardArgs`                | `forward`   | `argv`                | JSON-joined args      |

\* `upstreamHashes` is currently a bare `string[]` of hashes with no task id.
To name the upstream in the diff, `filterUpstreamHashes` must return
`Array<[upstreamTaskId, hash]>` instead of `string[]` — see "the upstream-id
seam" below. If that change is judged too invasive for one wave, fall back to
`name = upstream hash, hash = upstream hash` (still diffable, just less
readable); recommend doing the seam.

Storing values verbatim for `env`/`runtime` means **secrets can land in
`cache.db`**. `cache.db` is already a local, gitignored, single-user file that
records commands and stdout, so this is consistent with the existing trust
boundary — but call it out in `docs/caching.md`. **Out of scope:** redaction /
opt-out of value persistence (a future `cache.inputs.env` `secret: true` flag).

## Recording wiring (the crux: capture without recomputing or regressing)

### 1. Emit components from the existing hash computation

`computeTaskHash` (src/orchestrator/task-hash.ts) already assembles every
component into the `CacheKeyInput` it passes to `cache.key()`. Add an **optional
out-param** so the components escape without any extra work:

```ts
// task-hash.ts
export interface TaskInputComponent { kind: string; name: string; hash: string }

export interface ComputeHashArgs {
  // ...existing fields...
  /** When provided, the resolved CacheKeyInput components are pushed here
   *  (one per key contribution) so the caller can persist them. No effect
   *  on the returned hash — pure capture of values already computed. */
  captureInto?: TaskInputComponent[]
}
```

In `computeTaskHash`, immediately before the `return await args.cache.key(...)`,
if `args.captureInto !== undefined`, push the rows derived from the very same
locals (`resolved.files` + `fileHashes`, `resolved.envValues`,
`resolved.runtimeValues`, `resolved.workspaceRuntimeValues`, `upstreamHashes`,
`projectPackageJsonHash`, `taskConfigHash`, `workspaceFingerprint`,
`effectiveForwardArgs`). File rows use `relPosix(workspaceRoot, file)` for
`name` and `fileHashes?.get(file) ?? await cache.hashFile(file)` for `hash` —
but the `fileHashes`/`hashFile` results are **already awaited** by `key()`; to
avoid a second hash pass, refactor `key()`'s per-file `Promise.all` result to be
reusable, OR (simpler, recommended) capture in `key()` itself — see option B.

**Recommended capture point — option B (capture inside `cache.key`).** `key()`
is where every component is already in hand *and* the per-file OIDs are already
awaited. Add an optional sink to `CacheKeyInput`:

```ts
// cache.ts — CacheKeyInput
/** When set, key() pushes each component (kind,name,hash) it folds.
 *  Pure side-channel: does not change the returned digest. */
captureInto?: Array<{ kind: string; name: string; hash: string }>
```

Inside `key()`, at each fold site, also push to `input.captureInto` when present
(the file loop already has `fileHashes[i]` awaited — zero extra I/O). This keeps
capture in lockstep with the fold order by construction (a future component that
forgets to capture is a one-line miss, not a silent drift). `computeTaskHash`
just allocates the array and threads it through.

Cost: a few array pushes per task. **No second hash, no second stat, no second
git spawn.** Hot path unaffected.

### 2. Carry components on the outcome

`executeCachedTask` (execute-task.ts) calls `computeTaskHash` once at L200.
Allocate `const inputComponents: TaskInputComponent[] = []`, pass
`captureInto: inputComponents`, and attach to **every** returned `TaskOutcome`
(hit path L318, abort path L459 — skip, miss path L528). Add to `TaskOutcome`
(src/graph/scheduler.ts):

```ts
/** Cache-key components captured at hash time. Persisted to
 *  run_task_inputs so a later run can diff against this one. Present
 *  on cached-task outcomes (hit + miss); absent on group/persistent/
 *  aborted. */
inputComponents?: TaskInputComponent[]
```

The in-flight-dedup path in run.ts (L288) computes a hash with no
`captureInto` — that's fine; the real `executeTask` call that follows captures.

### 3. Capture run-level context once (run.ts)

In `run()`, after `runId`/`runStartHrTimeNs` are set (~L169) and before
scheduling, gather context **once**:

- **git** — one `git` spawn (cheap, ~one-time). Add a helper
  `captureGitContext(workspaceRoot)` in a new file
  `src/orchestrator/run-context.ts`:
  - `commit_sha`: `git rev-parse HEAD` (spawnSync, ignore-on-fail → null).
  - `branch`: `git rev-parse --abbrev-ref HEAD`.
  - `dirty`: `git status --porcelain` non-empty → 1.
  Run these as one `git -C <root> ...` batch where possible; on any failure each
  field degrades to null (the doctor pattern — never fail a run for telemetry).
  Use `Bun.spawnSync` (these are short; one-time per run; mirrors affected.ts).
- **CI** — `detectCi(env)` in the same file: `ci=1` if any of `CI`,
  `GITHUB_ACTIONS`, `GITLAB_CI`, `BUILDKITE`, `CIRCLECI` is truthy (not
  `'0'`/`'false'`); `ci_provider` from which one matched.
- **host/os/arch** — `os.hostname()`, `process.platform`, `process.arch`.
- **vx_version** — `VERSION` (already imported).
- **command** — reconstruct from `process.argv.slice(1)` joined, OR thread the
  raw argv from the CLI (cleaner — add `options.command?: string` to RunOptions,
  set in `resolveRunOptions` from the original args). Recommend threading; fall
  back to `argv` join when absent (programmatic callers).
- **tags / cachePolicy / concurrency / flow** — from `options` (tags is a new
  `options.tags?: Record<string,string>`; see CLI section).

This block is **skipped entirely when `options.log !== undefined`** is NOT the
gate — context is cheap and useful for embedders too; gate only the git spawns
behind a try/catch. Keep it unconditional.

### 4. Persist once, in the existing transaction (run.ts + cache.ts)

After the existing `cache.recordRuns(toRecord)` (run.ts ~L457), build the
invocation row and the input rows from `list` and call **one new method** that
wraps everything in a single transaction:

```ts
// cache.ts
recordInvocation(inv: InvocationRecord, inputs: readonly TaskInputRow[]): void
```

`InvocationRecord` mirrors the `invocations` columns; `TaskInputRow` is
`{ runId, taskId, kind, name, hash }`. Implementation: one `db.transaction`
that inserts the invocation row then `INSERT`s all input rows via a prepared
statement. For a 3000-task run × ~30 components = ~90k rows — bind in the
transaction (one fsync). Measure; if 90k inserts is slow, chunk, but a single
transaction of prepared-stmt runs is typically fine (bun:sqlite does ~1M
inserts/s in a tx).

**Move the `recordRuns` + `recordInvocation` into one transaction** so the whole
run records atomically: add `recordRunBundle({ runs, invocation, inputs })` to
`Cache` that opens one transaction and does all three inserts, replacing the
bare `recordRuns` call in run.ts. This is the only run.ts recording change.

Skip input rows for outcomes without `inputComponents` (group/persistent/
aborted) — same filter as `toRecord`.

### Perf summary

- Capture: array pushes inside the already-running `key()` fold. **0 extra
  hashing/IO.**
- Git context: 1–3 spawnSync per *run* (not per task), behind try/catch.
- Recording: one transaction (one fsync) for runs + invocation + inputs.
- Reads are all indexed `run_task_inputs(task_id, run_id)` /
  `invocations(...)`.

## Queries (metrics.ts)

### Upgraded `whyDidThisRerun` → add a real component diff

Keep the existing function (UI relies on `hashChanged`) and add the actual diff:

```ts
export interface InputDiffEntry { kind: string; name: string;
  change: 'added' | 'removed' | 'changed'; before: string | null; after: string | null }
export interface CacheKeyDiff {
  runId: string; taskId: string; found: boolean;
  previousRunId: string | null;
  entries: InputDiffEntry[];     // only changed/added/removed components
  unchangedCount: number;
  note: string;
}
export function cacheKeyDiff(db: Database, runId: string, taskId: string): CacheKeyDiff
```

Implementation (pure SQL, no recompute):
1. Find this run's components: `SELECT kind,name,hash FROM run_task_inputs
   WHERE run_id=? AND task_id=?`.
2. Find the previous run id for this task:
   `SELECT run_id FROM run_task_inputs rti JOIN runs r ON r.run_id=rti.run_id
    AND r.project||'#'||r.task=? WHERE rti.task_id=? AND r.started_at <
    (this run's started_at) ORDER BY r.started_at DESC LIMIT 1` — or simpler,
    reuse `whyDidThisRerun`'s previous-run lookup to get the prev `run_id`, then
    pull its components.
3. Full outer join the two `(kind,name)` sets in app code (both are small):
   present-in-both-with-different-hash → `changed`; only-in-this → `added`;
   only-in-prev → `removed`; equal → bump `unchangedCount`.

This is the Wave-1 "why" panel upgraded from "hash changed" to
**"these 3 files + this env var changed, here's the OID before/after."**

### `getInvocation` + reworked `listInvocations`

```ts
export interface InvocationDetail { /* every invocations column, camelCased,
  tags parsed to Record<string,string>, dirty/ci/exitOk as booleans */ }
export function getInvocation(db: Database, runId: string): InvocationDetail | null
export interface ListInvocationsArgs { limit?: number; branch?: string;
  ci?: boolean; tagKey?: string; tagValue?: string }
export function listInvocations(db: Database, args?: ListInvocationsArgs): InvocationDetail[]
```

`listInvocations` now reads the **`invocations` table directly** (replacing the
`GROUP BY run_id` over `runs`) with `WHERE` filters for branch / ci / tag. It
returns the richer `InvocationDetail`; the SPA's existing fields
(`runId/startedAt/endedAt/taskCount/failedCount/hitCount/totalDurationMs`) are a
subset, so the views keep working and gain git/ci/tag fields. Keep the int
signature `listInvocations(db, 50)` working by accepting `number | args`.

### Local-vs-remote hit-rate split (query only)

Add to `getCacheStatsSql` (or a sibling `getHitRateSplit`):
`SUM(status='cache-hit')` as `hitLocal24h`, `SUM(status='cache-hit-remote')` as
`hitRemote24h`. Add the same split to `getRunTrends` (two new series:
`hitsLocal`, `hitsRemote`) and to `InvocationDetail`
(`hitLocalCount`/`hitRemoteCount`, already columns).

## Endpoints (packages/cloud/src/cli/serve.ts)

Add routes (mirror existing patterns; all read `cache.dbHandle()`):

- `GET /v1/invocations` — extend to read query params `branch`, `ci`,
  `tagKey`, `tagValue`, `limit`; pass to the new `listInvocations`.
- `GET /v1/invocations/:runId` — `getInvocation`.
- `GET /v1/diff/:runId/:taskId` — `cacheKeyDiff` (the moat). Always 200.
- `GET /v1/cache/hit-split` — `getHitRateSplit` (optional; or fold into
  `/v1/cache/stats`).

`/v1/why/:runId/:taskId` stays (back-compat); the SPA's "why" data source
switches to `/v1/diff` for the rich panel.

## CLI flags (src/cli/run.ts)

In `RunArgs` + `parseRunArgs`:

- `--tag k=v` (repeatable) → `tags: Record<string,string>`. Parse: split on the
  first `=`; empty key → error. `--tag=k=v` form too.
- `--report` / `--report=markdown` → `report: 'markdown' | undefined`. Only
  `markdown` supported (validate; reserve `json`).

Thread into `RunOptions` (`resolveRunOptions`): add `tags`, `command` (the raw
argv string), and `report`. Report generation happens **after** the run returns
in `runCmd` (it needs the outcomes): a new
`src/orchestrator/run-report.ts` `formatRunReportMarkdown(summary, runContext,
invocation)` reusing `tallyOutcomes` + the per-task list (moon-style table:
task | status | cache | duration | Δ-vs-prev). `runCmd` writes it to stdout
(so `vx run ci --report=markdown >> $GITHUB_STEP_SUMMARY` works) — NOT to the
status logger (keep it machine-clean on stdout). Out of scope: posting to a PR
(that's a CI step, not vx's job).

## UI (apps/ui)

Plumbing partitioned to avoid conflicts (see phasing):

- `api.ts`: add `getInvocation`, `cacheKeyDiff`, extend `listInvocations` args,
  add the hit-split fields + types.
- `jr/data.ts`: replace the `runWhy` source's body to call `cacheKeyDiff`
  (returns added/removed/changed rows); add `invocationDetail` param source.
- Views (`apps/ui/src/views/`):
  - `runDetail.json`: the "Why did this re-run?" table now shows the actual
    changed components (kind/name/before→after), not just "inputs changed".
  - `runs.json` / `invocations`: add branch / commit / ci / tags columns +
    branch/ci filter controls.
  - `cache.json` / `overview.json`: local-vs-remote hit split (two-segment bar
    or two series on the trend).

The embedded `apps/ui/dist/index.html` is rebuilt **once at integration** and
verified e2e over the DevTools Protocol (the established dashboard practice),
not per-agent.

## Phasing — disjoint file ownership for parallel agents

### Phase A — schema + recording foundation (one coherent commit, serial)

Must land first; everything else reads what it writes. Files:

- `src/cache/cache.ts` — DROP-gate lines; new tables; `CacheKeyInput.captureInto`
  + the per-fold push in `key()`; `InvocationRecord`/`TaskInputRow` types;
  `recordInvocation` / `recordRunBundle` + prepared statements; `SCHEMA_VERSION`
  → v22; CACHE_VERSION comment confirming **no bump**.
- `src/orchestrator/task-hash.ts` — `TaskInputComponent` type; thread
  `captureInto` through `computeTaskHash` (allocate + pass to `key()`).
- `src/orchestrator/upstream.ts` — **the upstream-id seam**:
  `filterUpstreamHashes` → return `Array<[taskId, hash]>` (update its callers in
  task-hash.ts; the key fold sorts by hash, unchanged ordering).
- `src/graph/scheduler.ts` — `TaskOutcome.inputComponents`.
- `src/orchestrator/execute-task.ts` — allocate `inputComponents`, pass
  `captureInto`, attach to hit + miss outcomes.
- `src/orchestrator/run-context.ts` (new) — `captureGitContext`, `detectCi`,
  host/os/arch helpers.
- `src/orchestrator/run.ts` — capture context once; build invocation + input
  rows from `list`; call `recordRunBundle` (replacing `recordRuns`); thread
  `options.tags`/`options.command`.
- `src/orchestrator/options.ts` — `RunOptions.tags`, `.command`, `.report`.
- Bump-cache-version skill checklist (SCHEMA bump touches these even though
  CACHE_VERSION is unchanged — update the SCHEMA history note in each):
  `src/cache/cache.ts` (version + comment), `docs/caching.md`,
  `docs/modules/cache.md`, `CLAUDE.md` (decision-log entry),
  `tests/cache.test.ts` (schema-gate + recordInvocation + key-unchanged tests).

Phase A is the only change to `cache.ts`, `run.ts`, `task-hash.ts`,
`execute-task.ts`, `scheduler.ts`, `upstream.ts`, `options.ts` — so Phase B
units never touch them.

### Phase B — independent units, parallelizable (disjoint files)

| Unit | Owns (exclusive) | Depends on |
| ---- | ---------------- | ---------- |
| **B1 Queries** | `src/orchestrator/metrics.ts` | A (tables) |
| **B2 Endpoints** | `packages/cloud/src/cli/serve.ts` | B1 (query sigs) |
| **B3 CLI tags+report** | `src/cli/run.ts`, `src/orchestrator/run-report.ts` (new), `docs/cli.md` | A (options.tags/command/report exist) |
| **B4 UI data layer** | `apps/ui/src/api.ts`, `apps/ui/src/jr/data.ts` | B2 (endpoints) |
| **B5 UI views** | `apps/ui/src/views/runDetail.json`, `runs.json`, `cache.json`, `overview.json` | B4 |

B1 → B2 → (B4 → B5) is a chain on the *contract*, but each owns disjoint files,
so they can be developed against the agreed signatures in parallel and
integrated in order. B3 is fully independent of B1/B2/B4 (it only needs Phase A
options). No two units write the same file. The shared plumbing
(`cache.ts`/`run.ts`/`metrics.ts`/`serve.ts`/`api.ts`/`data.ts`) is partitioned:
metrics.ts→B1 only, serve.ts→B2 only, api.ts+data.ts→B4 only,
cache.ts+run.ts→Phase A only.

## Test plan

**Phase A** (`tests/cache.test.ts`, `tests/orchestrator*.test.ts`):
- Schema gate: open v21 DB, reopen → `invocations`/`run_task_inputs` exist,
  old rows dropped.
- **Key unchanged:** compute a task's hash with and without `captureInto` →
  identical digest. A fixture asserting a known hash string is byte-identical to
  pre-Tier-3 (guards CACHE_VERSION-not-bumped).
- `captureInto` completeness: a task with files+env+runtime+upstream+forward →
  the captured set has one row per component, matching the fold table above.
- `recordRunBundle`: one run → one `invocations` row with correct
  git/ci/host/tags; `run_task_inputs` row count == sum of components; all in the
  DB after a single `close`. Cache-hit task also gets input rows (capture-for-
  hits).
- `captureGitContext`/`detectCi`: in a temp git repo (commit + dirty file) →
  correct sha/branch/dirty; CI env matrix → provider detection; non-git dir →
  all-null, no throw.

**B1** (`tests/metrics.test.ts`): seed two runs of a task with a changed file +
changed env → `cacheKeyDiff` returns exactly those as `changed`, others
`unchanged`; first-run case (no previous) → `found:true, entries:[]`;
`getInvocation` round-trips a recorded row; `listInvocations` branch/ci/tag
filters; hit-split counts local vs remote.

**B2** (`tests/serve.test.ts` in packages/cloud): `GET /v1/diff/:runId/:taskId`
returns the diff shape; `/v1/invocations?branch=x` filters;
`/v1/invocations/:runId` 200 + 404.

**B3** (`tests/cli.test.ts`): `--tag k=v` parses (repeatable, `=` in value);
bad `--tag` errors; `--report=markdown` parses; bad `--report` errors; e2e:
`vx run <task> --report=markdown` prints a markdown table to stdout +
the invocation row carries the tag.

**B4/B5**: e2e over DevTools after the single dist rebuild — run-detail "why"
panel shows named changed inputs; runs table shows branch/commit/ci/tags +
filters; cache view shows local-vs-remote split. 0 console errors.

## What's out of scope

- Secret redaction / opt-out of `env`/`runtime` value persistence (note the
  trust boundary; future `secret: true` input flag).
- Normalized `invocation_tags` side table (LIKE-filtering the JSON is enough).
- Persisted DAG edges / historical critical-path reconstruction (Tier-2 does it
  live; a `run_task_deps` table is a separate follow-up).
- Remote-transfer byte accounting (Tier-3 item #10 in the parent doc — needs
  LayeredCache instrumentation; separate).
- Posting reports to PRs (a CI step, not vx).

## OTLP export (feasibility note, not designed here)

Feasible and cheap via the existing cloud `eventSink` + the native
`attachOtelEmit` already wired in run.ts. The invocation context (commit/branch/
ci/tags) Tier-3 captures maps directly onto OTel CI/CD semantic-convention
resource attributes (`vcs.repository.ref.name`, `cicd.pipeline.run.id`), so the
natural follow-up is to enrich the existing OTel span resource with the
`run-context.ts` output. **Recommendation:** do NOT add it in Tier 3 — land the
schema + diff first; OTLP enrichment is a one-file follow-up
(`src/orchestrator/otel-emit.ts`) once `captureGitContext` exists.

## Why this is the right move

- The diff is **pure SQL over normalized rows** — the moat feature costs two
  indexed selects, not a re-evaluation of the config or a re-hash.
- Capture rides the existing `key()` fold: **zero extra hashing/IO on the hot
  path**, and it can't drift from the key because it's pushed at the same fold
  sites.
- One transaction per run keeps recording at one fsync; git context is one
  spawn per run, behind try/catch (telemetry never fails a build).
- The key derivation is provably unchanged (no CACHE_VERSION bump), so existing
  artifacts stay valid; only the analytics schema rolls.
- File ownership is disjoint per unit, so Phase B agents run in parallel without
  touching each other's files.
