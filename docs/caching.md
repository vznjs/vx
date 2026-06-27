# Caching

`@vzn/vx`'s cache is content-addressed, opt-in per task, and shaped to
cascade through the dependency graph the same way Turborepo's does.
This page explains _what's in the cache key_, _what triggers
invalidation_, _what's actually stored_, and _why_.

## Why caching is opt-in

A task is cached iff its `TaskConfig` provides a `cache` block, with
**both** `inputs.files` and `outputs.files`. Omit `cache` and the
task always runs; no read, no write.

The reasoning:

- **Defaulting caching ON with implicit globs leads to silently stale
  builds.** The first time a user forgets to revisit their config to
  add an input, the cache returns a hit for an out-of-date snapshot.
  Stale hits are the worst failure mode of a task runner — they erode
  trust in the cache itself.
- **Forcing declaration makes "what does this task read?" and "what
  does it produce?" conscious choices.** The user pays a one-time
  cost (write the globs) for a permanent gain (the cache key actually
  reflects reality).
- **The cost of a forgotten cache miss is small.** A task re-runs.
  The cost of a stale cache hit is large. Asymmetric risk justifies
  asymmetric defaults.

Turbo defaults caching ON for `outputs: []` tasks; Nx requires you to
opt _out_ via `cache: false`. We chose the strictest of the three.

## Cache key derivation

The cache key for one task is a SHA-256 hex digest over (in order):

1. **`CACHE_VERSION`** — the schema-version sentinel
   (currently `'vx-cache-v20'`, in `src/cache/cache.ts`). Bumped only
   when the key derivation format changes. See
   [§ Bumping CACHE_VERSION](#bumping-cache_version).
2. **`taskId`** — `${projectName}#${taskName}`. Two tasks with
   identical everything else still produce distinct keys — protects
   against e.g. `pkg-a#build` accidentally cache-hitting on a
   `pkg-b#build` entry.
3. **Workspace fingerprint** — sha256 of every supported workspace
   marker found at the root (see
   [`modules/fingerprint.md`](./modules/fingerprint.md)):
   `pnpm-lock.yaml`, `package-lock.json`, `npm-shrinkwrap.json`,
   `yarn.lock`, `bun.lock`, `bun.lockb`, `pnpm-workspace.yaml`. Any
   install-resolved change (a `bun install` that bumps `bun.lock`) or
   any workspace-shape change invalidates _every_ cache entry. This is
   the single global "the world changed" lever.
4. **Project `package.json` hash** — sha256 of the project's
   `package.json` bytes. Folded in implicitly (Turbo / Nx parity).
   Covers the case where `cache.inputs.files: ['src/**']` is narrow
   and a `package.json` dep change would otherwise leak undetected.
   (Added at v12; rationale in [§ History](#history).)
5. **Task config hash** — `sha256(JSON.stringify(node.config))` of the
   _evaluated_ task config. Captures:
   - `exec` block (command, env declarations).
   - `dependsOn` and `cache.inputs.tasks` declarations.
   - `cache.outputs.files`, `cache.inputs.files`, `cache.inputs.env`
     declarations (the strings themselves; their resolved file content
     / env values contribute separately).
   - `description` (because it's part of the resolved object — even
     though it has no behavioural effect; a description change isn't a
     correctness change but the cost of a re-run is low).
   - **Imported / computed values** — anything a preset or
     `process.env`-read at config-load time injected. Bun's native
     `await import()` evaluates the module and bakes those values into
     the object before we serialize.
6. **`cache.inputs.env` resolved values** — `[name, value]` pairs
   read from host `process.env` at hash time. Listed names get their
   current values; unset names contribute the empty string (and the
   count of names + the names themselves are also folded in).
7. **`cache.inputs.runtime` resolved output** — `[command, output]`
   pairs, where `output` is the combined, trimmed stdout + stderr of
   each command run via `sh -c` in the **project dir** at hash time.
   The runtime-output analog of step 6: the command _strings_ are in
   the resolved config (step 5), their _output_ is resolved live every
   run. Folded with the command count + each `command\0output` pair.
8. **`cache.inputs.workspaceRuntime` resolved output** — same as step
   7 but commands run at the **workspace root**, and the pairs fold
   into a **distinct namespace** (`ws-runtime-values:`) so an identical
   `(command, output)` never aliases the project-cwd `runtime` values.
9. **`forwardArgs`** — CLI args passed after `--`. Folded into the
   key so `vx run test -- --watch` doesn't cache-hit a previous
   `vx run test`. Scoped to the user-requested tasks only — dependsOn-
   pulled deps don't see them (their cache identity stays clean).
10. **Filtered upstream task cache hashes** — every upstream task's
    own cache key, filtered by `cache.inputs.tasks` (default: all of
    them). Sorted by hash before folding so the ordering of `dependsOn`
    doesn't change the key. This is the cascade mechanism: if anything
    beneath you changes, your hash changes too.
11. **Input files' content hashes** — `cache.inputs.files` resolved to
    a concrete list of project-relative paths (gitignore-aware,
    declared-outputs-excluded, nested-projects-excluded), each file
    contributing its **git blob OID** (v20). On a clean tree the OID
    comes straight from the index — the same bulk
    `git ls-files -s --others` spawn that enumerates files also yields
    every tracked file's OID, and one `git status --porcelain` prunes
    paths whose working tree diverges, so deriving these hashes costs
    zero file reads, zero per-file stats, zero SQLite lookups. Dirty /
    untracked files (and symlinks) fall back to an in-process
    `HASH("blob " + len + "\0" + content)` computation (sha1, or
    sha256 in `--object-format=sha256` repos) with the
    `file_hashes` mtime+size memo as the fast path — byte-identical
    to the index OID for identical content, so a file's contribution
    never flips across dirty↔clean transitions. Folded as
    `(relPath, oid)` pairs, sorted by relPath for stability across
    OSes and walk orders.

The composition is hash-then-concat-then-hash: each step appends
length-prefixed bytes to the running hasher, so two different field
layouts can't collide.

## Cache lookup → restore

On a hit:

1. The matching entry's directory at `<cacheDir>/<hash>/` is found.
2. The task's declared outputs are wiped from the project dir
   (`cleanOutputs`) — see [§ Strict output ownership](#strict-output-ownership).
3. Files at `<cacheDir>/<hash>/outputs/<rel>` are copied into the
   project dir, recreating parent directories as needed. Pre-existing
   local files at output paths are overwritten.
4. Captured stdout / stderr from `<cacheDir>/<hash>/{stdout,stderr}`
   are replayed to the live terminal via the logger — the framed block
   looks exactly the same as a fresh run.
5. The task is marked `cache-hit` (or `cache-hit-remote` when the
   `LayeredCache` hydrated from the remote layer this lookup);
   `durationMs` is the wallclock for the restore op, not the original
   exec time.

The cached `exitCode` is preserved. A cached non-zero exit is
impossible by construction — see [§ Cache write](#cache-write).

### Remote prefetch (async, remote-only)

When a run is backed by a remote cache (`VX_REMOTE_CACHE_URL` +
`VX_REMOTE_CACHE_TOKEN`), the network latency of every remote GET
would otherwise sit on the critical path of the task that needs it.
So before execution starts, `run()` kicks off **background prefetches**:

1. Every cacheable task's key is derived once, up front, in
   topological order (reusing the run's `hashCache` memo, so
   `execute-task`'s later `computeTaskHash` for the same task hits the
   memo — no double hashing). This derivation touches **no cache layer**
   — keys only.
2. Each **stable-key** task's remote GET is fired concurrently under a
   bounded pool (the run's concurrency). The prefetch ingests a hit
   into the _local_ cache; misses/errors degrade to `false`.
3. Execution starts immediately — the prefetches race alongside it, so
   remote latency overlaps real work instead of blocking it.
4. When `execute-task` later calls `cache.get(hash)`, the `LayeredCache`
   **awaits the already-in-flight (resolved-or-pending) prefetch** for
   that key rather than starting a fresh round-trip: **at most ONE
   remote GET per key**, whether it was served by the prefetch, the
   lazy read-through, or both.

Hard invariants:

- **Remote-only.** This entire path is gated on a `LayeredCache` being
  configured. A local-only run never derives the upfront keys, never
  prefetches, and is byte-for-byte identical (behavior and perf) to a
  run without this feature. It never adds an upfront _local_ `get` /
  `isOutputsCurrent` / stat pass.
- **Stable keys only.** A task whose `cache.inputs.files` could match
  an upstream's declared output has a _preliminary_ key until that
  upstream runs (e.g. a consumer that globs `**/*` over a sibling's
  `generated.txt`). Prefetching it would target the wrong artifact, so
  it's skipped — its key resolves correctly via the lazy read-through
  in `execute-task`. Instability propagates: a task that folds an
  unstable upstream is itself unstable. When in doubt, skip.
- **At most once.** The `LayeredCache` keeps an in-flight map keyed by
  hash; `prefetch` and `get` share it, and a settled `false` (remote
  miss) prevents a second lazy probe of the same dead key.
- **Provenance preserved.** A hash pulled from remote — even when a
  later `get` finds it as a now-local hit — still reports
  `source: 'remote'`, so the outcome is `cache-hit-remote`.
- **A remote-read-off policy** (`--no-cache`, `--force`, or
  `--cache=remote:`) fires no prefetch.

## Cache policy (read/write axes)

Caching is controlled by a four-axis `CachePolicy` — **localRead**,
**localWrite**, **remoteRead**, **remoteWrite** — independent toggles,
each enforced inside the matching cache layer at construction time. The
local `Cache` gets a `{ read, write }` slice gating only its task
artifact get/save (never `recordRun` / `stats` / `prune` / ingest /
hashing); the `LayeredCache` additionally gates its own remote
read-through (`remoteRead`), upload (`remoteWrite`), and prefetch
(`remoteRead`). The orchestrator derives two booleans per task:

- `willRead = task has a cache block AND (localRead || remoteRead)`
- `willWrite = task has a cache block AND (localWrite || remoteWrite)`

A task reads the cache only when `willRead`, saves only when
`willWrite`, and cleans its declared outputs before exec only when
`willWrite`.

The CLI maps three flags to a policy (precedence: start all-on → apply
`--cache` → `--no-cache` forces all off → `--force` forces both reads
off): `--no-cache` = everything off (no read, no write, no output
clean); `--force` = reads off / writes on (re-execute and refresh the
cache, outputs cleaned); `--cache=<spec>` = explicit per-layer control.
See `docs/cli.md` § Cache control.

One subtlety: when `localWrite` is off but `remoteWrite` is on
(`--cache=local:,remote:rw`), there's no on-disk artifact for the
`LayeredCache` to read before uploading — so it packs the tar.zst bytes
in memory (`Cache.packArtifactBytes`) and uploads those.

## Cache write

A miss runs the task. If the final exit code is `0` and the task's
`willWrite` is true (it has a `cache` block AND at least one write axis
is on):

1. `cache.outputs.files` is resolved against the project dir.
2. Matching files are copied into `<cacheDir>/<hash>.tmp-<pid>-<ms>/outputs/<rel>`.
3. Captured stdout / stderr text is written to the same temp dir's
   `stdout` and `stderr` files.
4. The temp dir is atomically renamed to its final `<cacheDir>/<hash>/`.
   Concurrent readers see either no entry or a complete entry — never
   a partial one.
5. An `entries` row is upserted in SQLite (taskId, command, exit code,
   duration, total byte count, created_at, accessed_at).

If the task exits non-zero, **nothing is cached.** This is deliberate:

- Caching a failure prevents retry flows. The next run gets the same
  failure even after the user fixes the underlying cause (the inputs
  haven't changed, so the cache key matches).
- Failures should be transient by default — flaky tests, network
  blips, transient resource exhaustion shouldn't bake into the cache.

Failed-task stdout / stderr are still surfaced to the user via the
live stream and on the `TaskOutcome.stderr` field. The `runs` table
records the failure (status + exit code) for analytics.

## Strict output ownership

Declared `cache.outputs.files` are wiped in two distinct places:

- **Before exec on a cache miss.** A leftover `dist/old.js` from a
  prior build can't survive into a fresh build that doesn't rewrite
  it.
- **Before restore on a cache hit.** The post-restore tree is the
  cached snapshot byte-for-byte. Hand-edits to output files don't
  persist through a cache replay.

Both branches use the same `cleanOutputs` helper (`src/cache/inputs.ts`)
with the same boundary rules. Skipped when:

- `cache.outputs.files` is empty (nothing declared as output).
- The task's `willWrite` is false — no write axis is enabled (e.g.
  `--no-cache`, or a read-only `--cache=local:r`). The user is debugging
  and managing the tree, so vx leaves it alone. `--force` keeps writes
  on, so it DOES clean (the saved snapshot must be clean).

Why so strict? Turbo and Nx restore additively — files from a prior
state can survive. We've seen this cause:

- Wrong test runs (a deleted-but-resurrected snapshot file from a
  cache miss survives a hit and now your test passes against the
  wrong baseline).
- Wrong shipped artifacts (a deleted source-mapped file from a prior
  build sits in `dist/` alongside the new bundle).

The strict-ownership behavior makes the project dir post-run a pure
function of the cache key.

## Invalidation paths

A task's cache becomes invalid when any of these change:

| Trigger                                                                                                                                  | Mechanism                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Edit a file in the task's `inputs.files` set                                                                                             | step 11 of key derivation                                                                                                 |
| Edit a file in the task's `inputs.workspaceFiles` set (root-anchored; may live in ANY project's dir — the documented boundary exception) | step 11 — resolved workspace files join the same input-file list                                                          |
| Any package manager updates a lockfile (`pnpm`, `npm`, `yarn`, `bun`)                                                                    | step 3 (workspace fingerprint)                                                                                            |
| Edit `pnpm-workspace.yaml` or `package.json`'s `workspaces` field                                                                        | step 3                                                                                                                    |
| Edit the project's `package.json` (dep / version / scripts change)                                                                       | step 4 (project package.json hash)                                                                                        |
| Edit the task's `vx.config.ts`                                                                                                           | step 5 (task config hash)                                                                                                 |
| Edit a config file that the task config imports                                                                                          | step 5 (configHash sees the resolved object after Bun evaluates imports)                                                  |
| Change a `cache.inputs.env` host value                                                                                                   | step 6                                                                                                                    |
| Change the combined stdout+stderr of a `cache.inputs.runtime` command (resolved at hash time)                                            | step 7                                                                                                                    |
| Change the combined stdout+stderr of a `cache.inputs.workspaceRuntime` command (resolved at hash time)                                   | step 8                                                                                                                    |
| Change CLI `forwardArgs` (after `--`)                                                                                                    | step 9                                                                                                                    |
| Upstream task's cache key changes (because its inputs changed)                                                                           | step 10                                                                                                                   |
| Bump `CACHE_VERSION`                                                                                                                     | step 1 — orphans every entry                                                                                              |
| Change `exec.env.passThrough` _values_ alone                                                                                             | **NOT a trigger** by design — passThrough values are host-specific                                                        |
| Change a file not in `inputs.files` / `inputs.workspaceFiles`                                                                            | **NOT a trigger** by design — declare it explicitly                                                                       |
| Change a file in a nested project's dir                                                                                                  | **NOT a trigger** for the parent's `files` globs — project boundaries are hard (workspaceFiles is the explicit exception) |

The cascade in row 11 is what makes monorepo caching work: edit a file
in `lib/`, and every package that depends on `lib`'s `build` task
re-runs automatically.

## Cross-project boundaries

A project's `cache.inputs.files` globs **never** reach into another
project's directory, even if a `**/*` pattern would otherwise match.

`workspace/nested-dirs.ts` computes the set of nested project
directories (projects rooted inside this one) once per `vx run`, and
adds them to the ignore list passed to every glob pass. The only way
for project A to depend on project B's state via project-relative
globs is `dependsOn` + upstream-hash propagation (step 10).

**Exception:** `cache.inputs.workspaceFiles` /
`cache.outputs.workspaceFiles` are workspace-root-anchored and apply
NO boundary rule — a deliberate escape hatch (owner call: "they don't
care about boundaries; it is bad practice but is there"). Prefer
project-relative declarations; reach for workspaceFiles only for
genuinely root-anchored files.

## Runtime inputs and the lock (the env parallel)

`cache.inputs.runtime` / `cache.inputs.workspaceRuntime` are modeled
exactly on `cache.inputs.env`, and they share its asymmetry with the
lockfile:

- **The command _strings_ live in the resolved config**, so `vx lock`
  freezes them into `vx-lock.json` (just as it freezes the env _names_
  a task declares).
- **The command _output_ is resolved live at hash time on every run**
  — inside `resolveInputs`, the same place env _values_ are read from
  the host `process.env`. The lock never stores it.

So `vx run --frozen` loads the frozen command strings but still spawns
them and folds their current output into the key. A `node -v` that goes
from `v20` to `v22` after the lock was written busts the cache under
`--frozen`, exactly as a changed `NODE_ENV` value would — the TypeScript
escape hatch (`define: { TSC_VERSION: execSync(...) }`) goes stale here
because its value was baked into the config object at lock time, whereas
a runtime input re-resolves.

Consequently **`vx lock --check` does not — and need not — flag
runtime-output drift.** `lock --check` audits that the frozen config
object still matches a fresh evaluation; the command output was never
part of that object (only the strings are), so a changed probe output
is correct, expected, live behavior rather than lock drift. This is the
same reason `lock --check` ignores `inputs.env` value changes.

## Storage layout (v17+)

```
<workspaceRoot>/.vx/cache/                  (configurable via vx.workspace.ts cacheDir)
├── cache.db                                SQLite metadata + run history
├── cache.db-wal                            write-ahead log
├── cache.db-shm                            shared memory
└── <hash>.tar.zst                          one artifact per cache entry:
    ├── stdout                              captured stdout (always present, may be empty)
    ├── outputs/<rel>                       declared output files, project-relative (when any)
    └── workspace-outputs/<rel>             declared outputs.workspaceFiles,
                                            WORKSPACE-ROOT-relative (when any)
```

`<hash>` is the 16-hex xxh3 key. The `workspace-outputs/` namespace is
additive: tasks that don't declare `outputs.workspaceFiles` produce
byte-identical artifacts to the plain v17 format (which is why the
field needed no `CACHE_VERSION` bump). `output_files` rows mirror the
two namespaces — project rows store the bare rel, workspace rows store
the full `workspace-outputs/<rel>` name as the discriminator.

**Key property:** one entry is one file. Eviction is a single unlink.
There is no separate `logs/` tree or per-entry manifest to worry
about.

### SQLite tables

```sql
-- src/cache/cache.ts schema (SCHEMA_VERSION = 'v18')

CREATE TABLE schema_meta (
  key   TEXT PRIMARY KEY,  -- 'version'
  value TEXT NOT NULL
);

CREATE TABLE entries (
  hash         TEXT PRIMARY KEY,  -- the sha256 cache key
  project      TEXT NOT NULL,
  task         TEXT NOT NULL,
  command      TEXT NOT NULL,
  exit_code    INTEGER NOT NULL,
  duration_ms  INTEGER NOT NULL,
  size_bytes   INTEGER NOT NULL,  -- total bytes under <hash>/
  created_at   INTEGER NOT NULL,  -- ms-epoch
  accessed_at  INTEGER NOT NULL   -- ms-epoch; bumped on every hit (LRU)
);

CREATE TABLE runs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  hash                TEXT NOT NULL,
  project             TEXT NOT NULL,
  task                TEXT NOT NULL,
  status              TEXT NOT NULL,   -- success | failed | cache-hit | cache-hit-remote | skipped
  exit_code           INTEGER NOT NULL,
  duration_ms         INTEGER NOT NULL,
  forward_args        TEXT,             -- JSON-encoded; null when no `--` args
  started_at          INTEGER NOT NULL, -- ms-epoch
  ended_at            INTEGER NOT NULL,
  run_id              TEXT,             -- ULID shared across all tasks in one invocation
  cpu_ms              INTEGER,
  peak_rss_bytes      INTEGER,
  wallclock_start_ns  INTEGER,          -- bigint; serialized as SQLite INTEGER (signed 64-bit)
  wallclock_end_ns    INTEGER,
  cache_hit           INTEGER,          -- 0/1; convenience for flamegraph color
  bytes_uploaded      INTEGER,          -- remote-cache push size; null when no remote
  bytes_downloaded    INTEGER           -- remote-cache pull size on hit
);

CREATE INDEX runs_hash       ON runs(hash);
CREATE INDEX runs_started_at ON runs(started_at);
CREATE INDEX runs_project    ON runs(project, task);
CREATE INDEX runs_run_id     ON runs(run_id);
```

WAL mode is on; readers don't block writers. `PRAGMA busy_timeout =
5000` makes concurrent `vx run` invocations queue instead of failing
with `SQLITE_BUSY`.

### Why SQLite + on-disk outputs

- **Index queries are fast.** Stats (`SELECT COUNT(*) FROM entries`),
  TTL pruning (`WHERE accessed_at < ?`), per-task lookup
  (`WHERE hash = ?`) all hit a B-tree.
- **Output files stay as files.** Cache-hit restore is a file copy;
  putting outputs in BLOBs would just be a detour.
- **Stream identity preserved.** Stdout + stderr live as separate
  text files so cache-hit replay round-trips them faithfully.
- **One handle, one schema-meta sentinel.** Schema mismatch wipes
  the tables (pre-alpha) — there's no migration code to maintain.

## Performance characteristics

- **Hashing cost** scales linearly with total input file bytes per
  task. For large repos with `files: ['**/*']` this can dominate. Cut
  it by declaring narrow `inputs.files`. Bun's `Bun.file(...).stream()`
  is async-iterable so files never fully load into memory.
- **Cache read** is one indexed `SELECT` + an `existsSync` of the
  on-disk artifact + a recursive file copy of `outputs/`. SQLite's
  WAL keeps reads non-blocking during concurrent writes.
- **Cache write** is one upsert + atomic dir rename. Hashing
  dominates the run; storage itself is cheap.
- **Workspace fingerprint** is computed once per `vx run` invocation
  and reused for every task in that run.

## What's NOT in the key (and why)

- **`exec.env.passThrough` _values_.** Would force cache misses across
  machines with different CI flags, regions, or shell prompts. The
  _names_ are in the config hash (step 5) so adding/removing a
  passthrough still bumps the key for affected tasks.
- **Files outside the project directory that aren't in `inputs.files`.**
  Workspace-root configs (`tsconfig.base.json`, etc.) are not
  auto-included — see the deferred `WorkspaceConfig.globalInputs` in
  [`schema.md`](./schema.md). If you need them, list them explicitly
  in each task's `inputs.files` until that field ships.
- **Node / Bun / OS / build-tool versions.** If you need these, set
  them via `define` (`define: { TSC_VERSION: execSync('tsc --version').toString() }`)
  → the value lands in the config hash.

## Bumping `CACHE_VERSION`

Required when:

- A new field is added to the cache key derivation (step list above).
- The order or framing of existing key fields changes.
- The on-disk layout changes (file placement, log path conventions).
- The `CacheEntry` JSON shape changes in a way that affects restore.
- The SQLite schema changes in a way that affects existing rows
  (`SCHEMA_VERSION` also bumps in that case).

Not required when:

- Behavioural changes that adjust _which_ values flow into existing
  key components — those naturally produce different keys for
  affected tasks.
- Doc-only updates.
- Refactors that don't change the bytes fed into the hash.

The bump procedure has a dedicated skill at
`.claude/skills/bump-cache-version/` (used as `/bump-cache-version`).
Files touched: `src/cache/cache.ts` (the constant), this doc (history),
`docs/modules/cache.md` (key/entry shape if it changed),
`CLAUDE.md` (decision log), and the cache test file.

### History

- **v23 → v24**: exclude `vx-lock.json` from the input file set
  globally (`ALWAYS_IGNORE` in `cache/inputs.ts`). The lockfile is
  committed, so git enumerates it, but it's vx's own frozen-config
  metadata — never a task input. Without this, a `vx lock` re-write
  busts every key on a project that globs the root lockfile (a broad
  `**/*` on the root project). Tasks whose `cache.inputs.files` never
  matched it derive byte-identical keys. No SCHEMA bump — only the
  hashed file set changed, not the key layout or on-disk format.

- **v22 → v23**: fold `cache.inputs.runtime` / `workspaceRuntime`
  command output into the key (two namespaced sections after
  env-values). The command _strings_ stay in the config hash (step 5);
  their combined trimmed stdout+stderr is resolved live at hash time
  and folded as `runtime-values:` (project-cwd) and `ws-runtime-values:`
  (root-cwd) sections, each `command\0output`. No SCHEMA bump — only
  `Cache.key` derivation gained two sections; the on-disk format is
  unchanged. Tasks declaring neither field fold a `:0` count for both
  and derive byte-identical keys to before the bump.

- **v22 → pure-input transitive** (+ SCHEMA v21): reverted the v21
  output-fold. Downstream keys fold the upstream's **input key** (its
  own task hash) — a pure function of the filesystem, like Turbo/Nx.
  No output content participates in any cache key. **Early cutoff is
  gone**: an upstream that re-executes (comment edit, env change) but
  reproduces byte-identical output now still re-runs its dependents.
  This was a deliberate simplification — cutoff is rare in practice
  and not worth the cascade complexity (it forced output content into
  keys, which blocks any upfront/batched probe). **Multi-state is
  preserved**: branch ping-pong A→B→A still re-hits, because the
  upstream's _input_ differs per state and folds transitively into
  every dependent key. SCHEMA v21 drops the now-unused `outputs_hash`
  column; `CacheLayer.save` returns `void`.

- **v21 → early cutoff** (+ SCHEMA v19, **reverted in v22**):
  downstream keys folded the upstream's output content identity
  (`outputsHash`) instead of its task hash. Removed — see v22.

- **v7 → v8** (PR #2): folded `forwardArgs` into the key for CLI
  argument-forwarding alignment.
- **v8 → v9** (PR #3): `TaskConfig` shape changed — `exec` collapsed
  from an array to a single command, `tasks` nested under `run`.
- **v9 → v10** (PR #7): on-disk layout switched from per-entry
  `meta.json` + `outputs/` directory to a workspace-wide `cache.db`
  (SQLite) plus output files directly at `<hash>/` and log files at
  `logs/<hash>.{stdout,stderr}`. Adds run history for `vx stats`.
  Removes the per-entry manifest.
- **v10 → v11** (PR #19): analytics columns added to the `runs`
  table: `run_id` (ULID), `cpu_ms`, `peak_rss_bytes`,
  `wallclock_start_ns` / `wallclock_end_ns`, `cache_hit`,
  `bytes_uploaded`, `bytes_downloaded`. All nullable; surfaced via
  `vx stats` and directly queryable via `sqlite3 cache.db`. The
  on-disk `<hash>/` layout itself was unchanged.
- **v11 → v12** (PR #42): project's `package.json` bytes folded into
  every task's cache key implicitly. Matches Turbo / Nx "implicit
  dependencies" behavior — a `package.json` dep change invalidates
  the project's tasks even when `cache.inputs.files` is narrow and
  doesn't cover the file.
- **v12 → v13** (PR #65): per-entry on-disk layout unified. Outputs
  moved from `<hash>/<rel>` (mixed with metadata) to
  `<hash>/outputs/<rel>`; stdout / stderr moved from the sibling
  `logs/<hash>.{stdout,stderr}` into `<hash>/stdout` and
  `<hash>/stderr`. Eviction collapses to a single `rm -rf <hash>/`.
  Also dropped the runner's `logs/<run_id>/<project>__<task>.{stdout,stderr}`
  dump — output is already streamed live, surfaced on the outcome
  object, and the cache entry covers successful runs; CI captures
  parent stdout natively. The duplicate sibling dump was pure
  redundancy.
- **v13 → v14**: file enumeration switched from a `Bun.Glob` walker
  with our own `ignore`-library filter to `git ls-files --cached
--others --exclude-standard` when the project is inside a git repo.
  Matches what Turborepo and Nx both do at the bottom of their hash
  pipelines. Side-effects user-visible: (a) nested `.gitignore`
  patterns are anchored to the gitignore's own directory, fixing the
  v13 footgun where `pkg/.gitignore: src/skip.ts` was misinterpreted
  as `<workspaceRoot>/src/skip.ts`; (b) `.git/info/exclude` and
  global excludes participate; (c) untracked-but-not-ignored files
  enter inputs immediately (no `git add` required). When git isn't
  available (no `.git`, git binary missing), we fall back to the
  pre-v14 `ignore`-library walker — same behavior as before. Bumped
  because the file-set definition for the same `inputs.files` globs
  could differ (e.g. a previously-mis-handled nested gitignore now
  filters correctly). Pre-alpha tolerates the one-time cache
  invalidation freely.
- **v14 → v15**: cache-key hash swapped from SHA-256 (via
  `Bun.CryptoHasher`) to xxHash3 (via `Bun.hash.xxHash3`). Key strings
  shrink from 64 hex chars to 16, matching Turbo's xxh64 output width;
  derivation is ~5× faster, dominating the cache-warm path that
  hashes hundreds of input files. xxHash3 has no streaming Hasher
  API, so `Cache.key()` chains via the seed parameter (each
  `xxh3(part, prevDigest)` folds one field into the running digest)
  and `hashFileFromDisk` reads the whole file before hashing — fine
  for source files (typically < 1MB each); the throughput win
  outweighs the memory hit. `SCHEMA_VERSION` bumps to `v15` at the
  same time (PR #86 already took `v14` for the tar.zst artifact
  layout): the `file_hashes.sha256` column is renamed to
  `content_hash`, and the schema-mismatch path now `DROP`s the stale
  tables before `CREATE TABLE IF NOT EXISTS` runs so the rename
  actually takes effect on existing DBs. Non-cryptographic by design
  — cache keys never need collision resistance against an adversary,
  just uniqueness across honest inputs.
- **v15 → v16** (PR #86 series): artifact storage moved to a single
  compressed `<hash>.tar.zst` per entry; the manifest.json entry was
  dropped (file fingerprints live in the `output_files` table).
- **v16 → v17**: artifact narrowed to exactly `stdout` +
  `outputs/<rel>` — no `meta.json`, no stderr (only successful runs
  are cached and their stderr is near-always empty noise). Local and
  remote layers transport the same bytes end-to-end; entry metadata
  lives solely in SQLite.
- **v17 → v18**: env-value folding in `Cache.key()` switched its
  name/value delimiter from `=` to `\0`. `${n}=${v}` was ambiguous —
  `("A", "B=C")` and `("A=B", "C")` folded identical bytes. Env names
  containing `=` are unreachable from a real POSIX environ, so this
  is contract hardening rather than a field bug, but the key
  derivation's stated invariant is unambiguous part boundaries —
  now it holds everywhere (file inputs already used `\0`).
- **v18 → v19**: `'^task'` dependsOn expansion switched from
  transitive-deps to nearest-holder frontier semantics (Turbo/Nx
  direct-deps parity, plus vx's sparse bridging through deps that
  don't declare the task). Task graphs lose the redundant deep edges,
  so the filtered-upstream-hash set (step 10) shrinks for any task
  whose deps chain `'^task'` themselves — same inputs now derive a
  different key. Reachability/ordering is unchanged whenever holders
  chain `'^task'` (the universal pattern); a holder that doesn't is
  now the documented stopping point. No on-disk format change.
- **v19 → v20**: input-file content hashes switched from xxh3 to
  **git blob OIDs** (Turbo's technique). The bulk enumeration spawn
  became `git ls-files -s --others --exclude-standard` — `-s` lines
  carry `<mode> <oid> <stage>\t<path>` for tracked files, so one
  spawn yields the file list AND the index OIDs; a second
  `git status --porcelain -z` spawn prunes OIDs for paths whose
  working tree diverges from the index (renames drop both sides;
  stage>0 conflict entries and symlinks never get one). A clean
  tree's key derivation does zero reads / stats / SQLite per file.
  Everything else falls back to `Cache.hashFile`, which now computes
  the identical blob OID in-process (object format auto-detected via
  `git rev-parse --show-object-format`, sha1 default) behind the
  existing mtime+size memo. `SCHEMA_VERSION` bumps to `v18` in the
  same change: pre-v20 `file_hashes.content_hash` rows store 16-hex
  xxh3 digests that must not leak into the OID domain through the
  memo. File-set visibility semantics are unchanged (verified: the
  `-s --others` path set is identical to `--cached --others`,
  including staged-but-deleted files and per-stage conflict
  duplicates).
