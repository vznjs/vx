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

- **Write:** the input-fingerprint rows are written **per cache-entry hash, only
  when an entry is SAVED** (a cache MISS), inside the same transaction that
  writes the `entries` row — via `INSERT OR IGNORE` (a re-save of the same hash
  is a no-op). A cache HIT does not save, so it writes nothing: a warm
  all-cache-hit run does **zero** extra input-fingerprint work. The per-`vx run`
  `invocations` header row is still written once per run (with `runs`) in one
  transaction. The component values **already exist in memory** at hash time
  (`CacheKeyInput`) — we persist, not recompute, and only on the miss path.
- **Read (diff):** "for run R, task T, what changed vs the previous run of T?" =
  map each run to its task hash (`runs.hash`), then two indexed `SELECT`s on
  `entry_inputs` (this run's hash + the previous run's hash) + a SQL anti-join.
  Pure SQL, no app-side recompute.
- **Read (filter):** "invocations on branch X / with ci=1 / tagged k=v" =
  indexed `SELECT` on `invocations`.

Normalized rows beat a JSON blob here precisely because the hot read is a
**diff** — `(kind,name,hash)` rows anti-join in SQL; a JSON blob would force a
full app-side parse + compare of every component on every probe.

**Why keyed by entry hash, not run id (the warm-path rule).** An earlier draft
keyed these rows by `(run_id, task_id)` and wrote them on **every** run including
all-cache-hit warm runs (~one INSERT per component per task per run). That
regressed warm `vx run` ~21% on an 800-package workspace — pure waste, since a
hit re-derives the exact same components it persisted on the cold run. Keying by
the **cache-entry hash** and writing **only on save** means identical inputs
(same hash) never re-write, and a warm run writes nothing. The owner's hard rule
— **Tier 3 must not impact run performance** — is satisfied by construction.

## Version decision

- `SCHEMA_VERSION` → **v22**. New tables (`invocations`, `entry_inputs`) +
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
DROP TABLE IF EXISTS entry_inputs;
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

### `entry_inputs` — the input-fingerprint moat

One row per cache-key component, keyed by the cache-**entry** hash it belongs to
(NOT a run id). Written **inside the entry-save transaction** — only on a cache
MISS, never on a hit — via `INSERT OR IGNORE`. A warm all-cache-hit run writes
nothing here; identical inputs derive the same hash, whose rows already exist, so
the idempotent insert is a no-op. The diff resolves a run to its entry hash via
`runs.hash`.

```sql
CREATE TABLE IF NOT EXISTS entry_inputs (
  entry_hash TEXT NOT NULL,          -- == entries.hash / runs.hash
  kind       TEXT NOT NULL,          -- file|env|runtime|ws-runtime|upstream|package|config|forward|workspace
  name       TEXT NOT NULL,          -- file: workspace-rel path; env: var name;
                                     -- runtime/ws-runtime: command string;
                                     -- upstream: upstream task id;
                                     -- package: "package.json"; config: "config";
                                     -- forward: "argv"; workspace: "fingerprint"
  hash       TEXT NOT NULL,          -- the component's contribution to the key
                                     -- (file: blob OID; env/runtime: value;
                                     --  upstream: upstream hash; package/config/
                                     --  workspace: the hash; forward: joined argv)
  PRIMARY KEY (entry_hash, kind, name),
  FOREIGN KEY (entry_hash) REFERENCES entries(hash) ON DELETE CASCADE
);
```

`ON DELETE CASCADE` keeps these rows in sync with `entries` — a `vx cache prune`
that drops an entry sweeps its input rows automatically (no `run_id`-keyed orphan
rows accumulating per run).

Component → row mapping (mirrors the `key()` fold order exactly so the set is
complete and lossless):

| `CacheKeyInput` field       | kind         | name (per row)     | hash (per row)   |
| --------------------------- | ------------ | ------------------ | ---------------- |
| `inputFiles` + `fileHashes` | `file`       | workspace-rel path | blob OID         |
| `envValues`                 | `env`        | var name           | value            |
| `runtimeValues`             | `runtime`    | command            | trimmed output   |
| `workspaceRuntimeValues`    | `ws-runtime` | command            | trimmed output   |
| `upstreamHashes`            | `upstream`   | upstream task id\* | upstream hash    |
| `projectPackageJsonHash`    | `package`    | `package.json`     | hash             |
| `taskConfigHash`            | `config`     | `config`           | hash             |
| `workspaceFingerprint`      | `workspace`  | `fingerprint`      | hash             |
| `forwardArgs`               | `forward`    | `argv`             | JSON-joined args |

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
export interface TaskInputComponent {
  kind: string
  name: string
  hash: string
}

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
is where every component is already in hand _and_ the per-file OIDs are already
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

### 2. Capture on the MISS path only; persist with the entry (revised)

The original draft captured on every task (including hits) and carried the
components on the `TaskOutcome` for `run()` to persist per run. **That is the
warm-path regression — removed.** The shipped design:

- `executeCachedTask` (execute-task.ts) computes the **probe** hash with **no**
  `captureInto`. A warm hit allocates no component array and pushes nothing.
- On a cache **miss**, right before `cache.save`, a second `computeTaskHash` runs
  with `captureInto` set. The `HashCache` memos (package.json bytes, task config,
  runtime command output) and the `GitFilesCache` OID map make that second pass a
  fold + array pushes — no re-stat, no re-hash I/O. It runs only on the miss
  path, where the task is about to spawn a subprocess anyway, so its cost is in
  the noise.
- The captured components are passed to `cache.save({ ..., inputComponents })` as
  `{ entryHash, kind, name, hash }` rows and written to `entry_inputs` inside the
  save transaction.

`TaskOutcome.inputComponents` is **dropped** (no longer needed — the save reads
components directly). The in-flight-dedup path in run.ts still computes a hash
with no `captureInto` — fine; the real `executeTask` call that follows captures
on its own miss path.

### 3. Capture run-level context once (run.ts)

In `run()`, after `runId`/`runStartHrTimeNs` are set (~L169) and before
scheduling, gather context **once**:

- **git** — ONE `git` spawn (cheap, one-time). `captureGitContext(workspaceRoot,
dirty)` in `src/orchestrator/run-context.ts`:
  - `commit_sha` + `branch`: a single `git rev-parse HEAD --abbrev-ref HEAD`
    (commit on line 1, branch on line 2) — half the spawns of two `rev-parse`
    calls. spawnSync, ignore-on-fail → null per field.
  - `dirty`: **not probed here.** The run's `GitFilesCache` populate already ran
    `git status --porcelain` for input enumeration; the aggregate dirtiness from
    that spawn is stored on the cache (`GitFilesCache.worktreeDirty`) and passed
    in. No second status spawn. `null` when the status spawn failed (non-repo).
    On any failure each field degrades to null (the doctor pattern — never fail a
    run for telemetry). Net: **≤ 1 extra cheap git spawn per run.**
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

### 4. Persist the invocation per run; the input rows ride the save (revised)

Two disjoint write paths:

- **Per run** (run.ts end-of-run): build the invocation header from `list` and
  call `recordRunBundle({ runs, invocation })` — one transaction inserting the
  per-task `runs` rows + the one `invocations` header. **No input rows here.** A
  warm all-cache-hit run does only this (cheap, bounded by task count, one
  fsync).
- **Per cache save** (cache.ts `save`/`writeArtifactAndIndex`, miss path only):
  the captured `entry_inputs` rows are `INSERT OR IGNORE`'d inside the SAME
  transaction as the `entries` row. Idempotent — re-saving the same hash adds no
  rows. A hit never saves, so it writes none.

`recordRunBundle({ runs, invocation })` replaces the bare `recordRuns` call. The
original draft's `recordRunBundle({ runs, invocation, inputs })` (input rows in
the per-run transaction, written on every run) is **gone** — that was the warm
regression.

### Perf summary

- Capture: on the **miss** path only — a second `computeTaskHash` that reuses the
  `HashCache` memos + `GitFilesCache` OID map, so it's a fold + array pushes (no
  re-stat / re-hash I/O), negligible next to the subprocess the task ran. **Warm
  path: zero capture, zero allocation.**
- Recording: per-run transaction is `runs` + `invocations` only (no input rows).
  Input rows ride the per-entry save transaction (miss only), `INSERT OR IGNORE`.
- Git context: **≤ 1** extra spawnSync per _run_ (commit+branch in one
  `rev-parse`; `dirty` reuses the populate-time `git status`), behind try/catch.
- Recording: one transaction (one fsync) for runs + invocation + inputs.
- Reads are all indexed: `entry_inputs(entry_hash)` (its primary key) joined via
  `runs.hash`, and `invocations(...)`.

## Queries (metrics.ts)

### Upgraded `whyDidThisRerun` → add a real component diff

Keep the existing function (UI relies on `hashChanged`) and add the actual diff:

```ts
export interface InputDiffEntry {
  kind: string
  name: string
  change: 'added' | 'removed' | 'changed'
  before: string | null
  after: string | null
}
export interface CacheKeyDiff {
  runId: string
  taskId: string
  found: boolean
  previousRunId: string | null
  entries: InputDiffEntry[] // only changed/added/removed components
  unchangedCount: number
  note: string
}
export function cacheKeyDiff(db: Database, runId: string, taskId: string): CacheKeyDiff
```

Implementation (pure SQL, no recompute) — `entry_inputs` is keyed by the cache
ENTRY hash, so the diff resolves each run to its task hash via `runs.hash`:

1. Find this run's entry hash for the task:
   `SELECT hash FROM runs WHERE run_id=? AND project||'#'||task=?`, then this
   run's components: `SELECT kind,name,hash FROM entry_inputs WHERE entry_hash=?`.
2. Find the previous run's entry hash for this task:
   `SELECT hash FROM runs r WHERE r.project||'#'||r.task=? AND r.started_at <
(this run's started_at) ORDER BY r.started_at DESC LIMIT 1`, then pull its
   components by that hash. (If the two hashes are equal — a re-run that hit —
   there's nothing to diff: `entries:[]`.)
3. Full outer join the two `(kind,name)` sets in app code (both are small):
   present-in-both-with-different-hash → `changed`; only-in-this → `added`;
   only-in-prev → `removed`; equal → bump `unchangedCount`.

Note: because rows are keyed by entry hash (not run id), two runs that share the
same inputs share the same `entry_inputs` rows — the diff between them is
correctly empty without storing duplicate per-run copies.

This is the Wave-1 "why" panel upgraded from "hash changed" to
**"these 3 files + this env var changed, here's the OID before/after."**

### `getInvocation` + reworked `listInvocations`

```ts
export interface InvocationDetail {
  /* every invocations column, camelCased,
  tags parsed to Record<string,string>, dirty/ci/exitOk as booleans */
}
export function getInvocation(db: Database, runId: string): InvocationDetail | null
export interface ListInvocationsArgs {
  limit?: number
  branch?: string
  ci?: boolean
  tagKey?: string
  tagValue?: string
}
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

- `src/cache/cache.ts` — DROP-gate lines (drop both legacy `run_task_inputs`
  AND `entry_inputs`); new tables (`invocations`, `entry_inputs` keyed by entry
  hash, FK→entries ON DELETE CASCADE); `CacheKeyInput.captureInto` + the per-fold
  push in `key()`; `InvocationRecord`/`TaskInputRow` (`{entryHash,kind,name,hash}`)
  types; `save`/`writeArtifactAndIndex` write `entry_inputs` via `INSERT OR IGNORE`
  inside the entry transaction; `recordRunBundle({ runs, invocation })` (no input
  rows) + prepared statements; `SCHEMA_VERSION` → v22; CACHE_VERSION comment
  confirming **no bump**.
- `src/orchestrator/task-hash.ts` — `TaskInputComponent` type; thread
  `captureInto` through `computeTaskHash` (allocate + pass to `key()`).
- `src/orchestrator/upstream.ts` — **the upstream-id seam**:
  `filterUpstreamHashes` → return `Array<[taskId, hash]>` (update its callers in
  task-hash.ts; the key fold sorts by hash, unchanged ordering).
- `src/graph/scheduler.ts` — (no `TaskOutcome` change; the dropped
  `inputComponents` field is not added — the save reads components directly).
- `src/orchestrator/execute-task.ts` — probe hash with NO capture (warm path
  free); on a MISS, a second `computeTaskHash` with `captureInto` → pass the
  rows to `cache.save({ inputComponents })`.
- `src/orchestrator/run-context.ts` (new) — `captureGitContext(root, dirty)` (one
  commit+branch spawn; dirty passed in), `detectCi`, host/os/arch helpers.
- `src/cache/inputs.ts` — `GitFilesCache.worktreeDirty` (aggregate dirtiness from
  the populate-time `git status --porcelain`, so run.ts needs no second spawn).
- `src/orchestrator/run.ts` — capture context once (dirty from
  `gitFilesCache.worktreeDirty`); build the invocation header from `list`; call
  `recordRunBundle({ runs, invocation })` (replacing `recordRuns`, no input rows);
  thread `options.tags`/`options.command`.
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

| Unit                   | Owns (exclusive)                                                               | Depends on                            |
| ---------------------- | ------------------------------------------------------------------------------ | ------------------------------------- |
| **B1 Queries**         | `src/orchestrator/metrics.ts`                                                  | A (tables)                            |
| **B2 Endpoints**       | `packages/cloud/src/cli/serve.ts`                                              | B1 (query sigs)                       |
| **B3 CLI tags+report** | `src/cli/run.ts`, `src/orchestrator/run-report.ts` (new), `docs/cli.md`        | A (options.tags/command/report exist) |
| **B4 UI data layer**   | `apps/ui/src/api.ts`, `apps/ui/src/jr/data.ts`                                 | B2 (endpoints)                        |
| **B5 UI views**        | `apps/ui/src/views/runDetail.json`, `runs.json`, `cache.json`, `overview.json` | B4                                    |

B1 → B2 → (B4 → B5) is a chain on the _contract_, but each owns disjoint files,
so they can be developed against the agreed signatures in parallel and
integrated in order. B3 is fully independent of B1/B2/B4 (it only needs Phase A
options). No two units write the same file. The shared plumbing
(`cache.ts`/`run.ts`/`metrics.ts`/`serve.ts`/`api.ts`/`data.ts`) is partitioned:
metrics.ts→B1 only, serve.ts→B2 only, api.ts+data.ts→B4 only,
cache.ts+run.ts→Phase A only.

## Test plan

**Phase A** (`tests/cache.test.ts`, `tests/orchestrator*.test.ts`):

- Schema gate: open a stale-version DB, reopen → `invocations`/`entry_inputs`
  exist, old rows dropped.
- **Key unchanged:** compute a task's hash with and without `captureInto` →
  identical digest (guards CACHE_VERSION-not-bumped).
- `captureInto` completeness: a task with files+env+runtime+upstream+forward →
  the captured set has one row per component, matching the fold table above.
- **Entry-save persistence + warm-writes-nothing:** a `cache.save({ inputComponents })`
  populates `entry_inputs` for that hash; a subsequent cache hit (and a defensive
  idempotent re-save of the same hash) adds ZERO new rows.
- `recordRunBundle`: one run → one `invocations` row with correct git/ci/host/tags
  and the `runs` rows, in one `close`; it does NOT touch `entry_inputs`.
- e2e (orchestrator): a cold miss writes `entry_inputs` (reachable via
  `runs.hash`); the warm hit run adds no `entry_inputs` rows but still records its
  `invocations` header.
- `captureGitContext`/`detectCi`: a temp git repo → correct sha/branch (one
  spawn); supplied `dirty` passes straight through; CI env matrix → provider
  detection; non-git dir → null commit/branch, no throw.

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
