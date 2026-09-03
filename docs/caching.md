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

The cache key for one task is a **16-hex xxHash3 digest**, seed-chained
over (in order):

1. **`CACHE_VERSION`** — the key-derivation sentinel
   (currently `'vx-cache-v27'`, in `src/cache/cache.ts`). Bumped only
   when the key derivation format changes. See
   [§ Bumping CACHE_VERSION](#bumping-cache_version).
2. **`taskId`** — `${projectName}#${taskName}`. Two tasks with
   identical everything else still produce distinct keys — protects
   against e.g. `pkg-a#build` accidentally cache-hitting on a
   `pkg-b#build` entry.
3. **Workspace fingerprint** — xxh3 of every supported workspace
   marker found at the root (see
   [`modules/fingerprint.md`](./modules/fingerprint.md)):
   `pnpm-lock.yaml`, `package-lock.json`, `npm-shrinkwrap.json`,
   `yarn.lock`, `bun.lock`, `bun.lockb`, `pnpm-workspace.yaml`. Any
   install-resolved change (a `bun install` that bumps `bun.lock`) or
   any workspace-shape change invalidates _every_ cache entry. This is
   the single global "the world changed" lever.
4. **Project `package.json` hash** — xxh3 of the project's
   `package.json` bytes. Folded in implicitly (Turbo / Nx parity).
   Covers the case where `cache.inputs.files: ['src/**']` is narrow
   and a `package.json` dep change would otherwise leak undetected.
   (Added at v12; rationale in [§ History](#history).)
5. **Task config hash** — `xxh3(JSON.stringify(node.config))` of the
   _evaluated_ task config. Captures:
   - `exec` block (command, env declarations, timeout, persistent).
   - `dependsOn` and `cache.inputs.tasks` declarations.
   - `cache.outputs.files`, `cache.inputs.files`, `cache.inputs.env`,
     `cache.inputs.runtime` / `workspaceRuntime` declarations (the
     strings themselves; their resolved file content / env values /
     command output contribute separately).
   - `description` (because it's part of the resolved object — even
     though it has no behavioural effect; a description change isn't a
     correctness change but the cost of a re-run is low).
   - **Imported / computed values** — anything a preset or
     `process.env`-read at config-load time injected. Bun's native
     `await import()` evaluates the module and bakes those values into
     the object before we serialize.
6. **`forwardArgs`** — CLI args passed after `--`. Folded into the
   key so `vx run test -- --watch` doesn't cache-hit a previous
   `vx run test`. Scoped to the user-requested tasks only — dependsOn-
   pulled deps don't see them (their cache identity stays clean).
7. **`cache.inputs.env` resolved values** — `[name, value]` pairs
   read from host `process.env` at hash time (delimited `name\0value`
   so boundaries are unambiguous). Listed names get their current
   values; unset names contribute the empty string.
8. **`cache.inputs.runtime` resolved output** — `[command, output]`
   pairs, where `output` is the combined, trimmed stdout + stderr of
   each command run via `sh -c` in the **project dir** at hash time.
   The runtime-output analog of step 7: the command _strings_ are in
   the resolved config (step 5), their _output_ is resolved live every
   run. Folded with the command count + each `command\0output` pair.
9. **`cache.inputs.workspaceRuntime` resolved output** — same as step
   8 but commands run at the **workspace root**, and the pairs fold
   into a **distinct namespace** (`ws-runtime-values:`) so an identical
   `(command, output)` never aliases the project-cwd `runtime` values.
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
    `git ls-files -s --others --exclude-standard` spawn that enumerates
    files also yields every tracked file's OID — so deriving these
    hashes costs zero file reads, zero per-file stats, zero SQLite
    lookups.

    Your globs are a **filter over the set git reports**, so a filter
    can only ever remove — a gitignored file can never be filtered back
    in, however explicitly you name it. Naming one by hand is therefore
    a **hard error** rather than a silent nothing: it would leave the
    task ignoring a file its own config claims as an input, reporting
    `up-to-date` while that file changed. Turbo lets an explicit entry
    override gitignore; vx cannot, because the key would then depend on
    a change `git diff` cannot see and `--affected` would stop selecting
    the task. If the file is generated, depend on the task that produces
    it via `cache.inputs.tasks`. A **glob** matching nothing stays
    silent — that is legitimate — and so does a literal naming a file
    that does not exist.

    An index OID is only trusted where git stores the worktree bytes
    **verbatim**, so three concurrent probes prune it:
    `git status --porcelain` drops paths whose working tree diverges;
    `git ls-files -v` drops `skip-worktree` / `assume-unchanged`
    entries, whose OID says nothing about what is (or isn't) on disk;
    and a clean-filter gate drops paths where `text` / `eol` / `ident`
    or `core.autocrlf` can rewrite bytes between index and worktree
    (the blob would be the LF-normalized form while the task reads the
    CRLF file). The gate costs nothing in a repo with no attributes
    and no `core.autocrlf` — see "Clean filters" below.

    Every pruned path, plus untracked files and symlinks, falls back
    to an in-process `HASH("blob " + len + "\0" + content)` over the
    **worktree bytes** (sha1, or sha256 in `--object-format=sha256`
    repos), memoized in `file_hashes` on `(mtime, size, ctime, ino)`.
    That is the same value the index holds whenever no filter applies,
    so a file's contribution doesn't flip across dirty↔clean
    transitions. Folded as `(relPath, oid)` pairs, sorted for
    stability across OSes and walk orders.

The composition is seed-chained (`xxh3(part, prevDigest)`) with a
label prefix per field, so two different field layouts can't collide.
xxHash3 is non-cryptographic by design — cache keys need uniqueness
across honest inputs, not adversarial collision resistance.

## Cache lookup → restore

On a hit:

1. `cache.get(hash)` is **pure SQL**: the `entries` row carries the
   metadata and the captured stdout; the `output_files` rows carry the
   output fingerprints. The tar artifact is not touched by the probe
   (its existence is verified with one stat), so hit cost doesn't
   scale with artifact size.
2. If the on-disk output tree already matches the cached snapshot
   (size + mode + **millisecond**-mtime check against `output_files`),
   extraction is skipped entirely — the outcome reports **up-to-date**
   (`restored: false`). Mode and millisecond mtime ride the artifact's
   own `.vx-meta.json` sidecar — recorded from a stat while packing —
   so the index rows and the restored tree carry the identical values
   whether the entry was saved locally or ingested from a remote, and
   the comparison is exact in steady state. Residual blind spot,
   accepted like every mtime-based check:
   a same-size edit landing in the same millisecond as the recorded
   write, or a deliberately forged mtime (`touch -r`).
3. Otherwise the task's declared outputs are wiped from the project
   dir (`cleanOutputs`) — see
   [§ Strict output ownership](#strict-output-ownership) — and the
   `outputs/<rel>` (+ `workspace-outputs/<rel>`) entries are extracted
   from `<cacheDir>/<hash>.tar.zst` into place.
4. Captured stdout is replayed to the live terminal via the logger —
   the framed block looks like a fresh run. (stderr is not cached —
   only successful runs are cached and their stderr is near-always
   empty; live runs still stream stderr normally.)
5. The task is marked `cache-hit` (or `cache-hit-remote` when the
   `LayeredCache` hydrated from the remote layer this run);
   `durationMs` is the wallclock for the restore op, not the original
   exec time.

The cached `exitCode` is preserved. A cached non-zero exit is
impossible by construction — see [§ Cache write](#cache-write) — and
"by construction" is literal: neither `save` nor `ingest` accepts an
`exitCode` at all, so the stored value is pinned to `0` rather than
supplied. The restore path still checks it, because the column outlives
this process: a row from a hand-edited or foreign `cache.db` with a
non-zero exit classifies the hit `failed` instead of restoring a broken
build's outputs under a green run.

### Local restore tier (two-tier scheduler)

`dependsOn` is an ordering gate, so a dependent normally can't even
probe the cache until its upstream finishes running. But a
**stable-key** task's key is provably independent of any upstream's
_outputs_ — its hit/miss status is knowable up front, and restoring
it needs none of its deps' output. So on local-only runs, `run()`
performs an up-front CLASSIFY (`orchestrator/local-shortcircuit.ts`):

1. Derive every stable, cacheable, local-read task's key (reusing the
   run's `hashCache` memo) and probe local `cache.get` **once**,
   building a `preProbed` map covering stable hits AND stable misses.
2. Confirmed hits become the **restore tier**: the scheduler makes
   them ready immediately (no dep gate, and no failed-dep→skip check —
   their key is dep-success-independent) but at LOW priority, so cache
   **misses own the worker pool and restores only backfill idle
   capacity**.
3. `execute-task` consumes `preProbed`, so the up-front probes ARE the
   probes it would have done, hoisted — no double work, and every task
   still flows through `execute()` so output is unchanged.

Stability gate (shared with remote prefetch via
`stable-keys.ts:deriveStableKeys`): a task whose input globs could
match a same-project upstream's declared `outputs.files`, or whose
`inputs.workspaceFiles` could reach any upstream's outputs, has a
_preliminary_ key and stays exec-tier / dep-gated. **Any**
`outputs.workspaceFiles` producer upstream also makes a dependent's key
preliminary, whatever that dependent reads: a root-anchored output is
boundary-ignoring by design, so it can land inside the dependent's own
project dir, where an ordinary project-relative glob reads it. Such a
dependent is therefore in NEITHER tier — it is excluded from probe
reuse as well as from the restore tier, because `execute-task` reuses a
`preProbed` hash verbatim, so probe reuse is itself a stale-hit path
when the key is preliminary. On top of that, a graph declaring any
`outputs.workspaceFiles` disables the restore tier graph-wide. The
short-circuit never runs under a `LayeredCache` (remote prefetch owns
those runs — an up-front `get` there would put remote GETs on the
critical path), never fires with local reads off, and never throws —
any error degrades to the normal lazy schedule. Measured: −6.6% on a
mixed slow-upstream/warm-downstream workload; parity on all-hit warm
runs.

### Remote prefetch (async, remote-only)

When a run is backed by a remote cache — a plugin's `cache` capability
or an injected `RunOptions.remoteCache` layer — the network latency of
every remote GET
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

## A current tree: when a warm hit restores nothing

A hit whose outputs are already on disk should cost a few stats, not an
extraction. Two checks decide, both against rows the cache recorded when
the tree last matched the entry (`output_files`, and since 2026-09-03
`output_dirs`):

1. **The set.** The files under the declared output globs must be exactly
   the entry's files — no strays, nothing missing — because a restore
   wipes and rewrites the declared outputs, and a stray left in place
   would be a stale file the hit silently kept. Until Wave 6 this was a
   glob walk on every hit (0.36 ms each; 365 ms of CPU on a warm
   1000-project run). Now, for globs of the shape `<dir>/**` (a whole
   subtree — `wholeSubtreePrefixes`), the cache records every directory
   under `<dir>` with its mtime after each save and restore; on the next
   hit, unchanged mtimes on all of them prove the set unchanged, since a
   file added or removed anywhere the glob could see bumps its parent
   directory, and a new directory bumps the recorded directory that
   contains it. Any other glob shape (`**/*.js`, `dist/*`), a missing
   row set (a remote ingest records none), a moved directory, or more
   than 256 directories keeps the walk — and a walk that proves the tree
   current records the directories so the following hit can skip it.
2. **The files.** Every recorded file's `(size, mode, mtime-ms)` must
   match. This never left: the directory rule only replaces the
   enumeration, not the fingerprint.

The trade is the one every mtime-based skip accepts, already documented
for files: a deliberately forged directory mtime (`touch -r`) hides a
stray. Both directions are pinned in `tests/output-dirs.test.ts`.

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
- **Never fail.** Every remote path (get / put / ingest / prefetch)
  catches all errors and degrades to a cache miss. A remote 500, a
  network drop, a corrupt artifact, or a failed integrity check can
  never fail a run.

### Remote uploads (background, drained at run end)

Writes go to the local cache synchronously; the **remote PUT is a
fire-and-forget background upload**. The task's outcome (and its
dependents) never wait on upload latency — the uploads race alongside
the rest of the run and are drained before `cache.close()`, so a
short run still ships every artifact before the process exits. Upload
failures log via `onRemoteError` and are otherwise ignored (the task
already succeeded; the only loss is the remote entry).

### Planning probes (`--dry` / `--graph`)

The planning paths (`vx run --dry`, `--graph`) predict hits without
side effects: against a remote cache they use a **lightweight
existence probe** — no artifact download, no local ingest. A predicted
`hit-remote` means the artifact exists remotely; the bytes move only
when a real run needs them.

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

1. `cache.outputs.files` (and `outputs.workspaceFiles`) are resolved
   against the project dir / workspace root.
2. A second `computeTaskHash` runs with the `captureInto` side-channel
   to record the per-component input fingerprint (miss-only; the
   HashCache memos make it a re-fold, no extra I/O).
3. The artifact — one `stdout` entry, the `outputs/<rel>` (+
   `workspace-outputs/<rel>`) entries and the `.vx-meta.json` sidecar —
   is packed in-process (no staging dir, no subprocess) into a
   single `<hash>.tar.zst`, written to a temp name, validated, and
   atomically renamed into place. Concurrent readers see either no
   entry or a complete entry — never a partial one.
4. One SQLite transaction upserts the `entries` row (taskId, command,
   exit code, duration, size, stdout, timestamps), the `output_files`
   fingerprint rows, and the `entry_inputs` component rows
   (`INSERT OR IGNORE`).

If the task exits non-zero, **nothing is cached.** This is deliberate:

- Caching a failure prevents retry flows. The next run gets the same
  failure even after the user fixes the underlying cause (the inputs
  haven't changed, so the cache key matches).
- Failures should be transient by default — flaky tests, network
  blips, transient resource exhaustion shouldn't bake into the cache.

Failed-task stdout / stderr still reach the user via the live stream
and the framed failure block replayed at run end. The `runs` table
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
| Change CLI `forwardArgs` (after `--`)                                                                                                    | step 6                                                                                                                    |
| Change a `cache.inputs.env` host value                                                                                                   | step 7                                                                                                                    |
| Change the combined stdout+stderr of a `cache.inputs.runtime` command (resolved at hash time)                                            | step 8                                                                                                                    |
| Change the combined stdout+stderr of a `cache.inputs.workspaceRuntime` command (resolved at hash time)                                   | step 9                                                                                                                    |
| Upstream task's cache key changes (because its inputs changed)                                                                           | step 10                                                                                                                   |
| Bump `CACHE_VERSION`                                                                                                                     | step 1 — orphans every entry                                                                                              |
| Change `exec.env.passThrough` _values_ alone                                                                                             | **NOT a trigger** by design — passThrough values are host-specific                                                        |
| Change a file not in `inputs.files` / `inputs.workspaceFiles`                                                                            | **NOT a trigger** by design — declare it explicitly                                                                       |
| Edit `vx-lock.json`                                                                                                                      | **NOT a trigger** — globally excluded from inputs (v24); it's vx's own metadata, never a task input                       |
| Change a file in a nested project's dir                                                                                                  | **NOT a trigger** for the parent's `files` globs — project boundaries are hard (workspaceFiles is the explicit exception) |

The cascade in step 10 is what makes monorepo caching work: edit a
file in `lib/`, and every package that depends on `lib`'s `build` task
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

## Clean filters (`text` / `eol` / `ident`, `core.autocrlf`)

Git can store a file's blob in a different form than the bytes in your
working tree. Under a `text`, `eol` or `ident` attribute — or with
`core.autocrlf` set to `true`/`input` — the index holds the
LF-normalized (or ident-collapsed) blob while your editor and your
build see the CRLF (or expanded) file.

That matters because `git status` compares **after** applying the
filter, so such a file reports _clean_: git considers it unmodified
even though the blob and the worktree file are different byte
sequences. Trusting the index OID as the file's content hash would
then let two genuinely different worktree contents fold the **same**
cache key, and a real change would be invisible.

So vx does not trust an index OID where a filter can apply. The check
is gated in three steps, and the common case pays nothing:

1. `core.autocrlf` is `true`/`input` — conversion applies to every
   auto-detected text file with no attribute needed, so no OID is
   trusted.
2. Otherwise, if no attributes source exists anywhere (no in-tree
   `.gitattributes`, no `$GIT_DIR/info/attributes`, no
   `core.attributesFile`), no rule can name a filter and vx does
   **no** extra work. This is the default `git init` repo.
3. Otherwise `git check-attr` resolves the three attributes from the
   index — without reading worktree content — and only the paths
   actually carrying one lose their OID.

`-text` (explicitly unset) and unspecified paths keep their OIDs:
both leave the blob byte-identical to the worktree file.

Losing an OID is not over-invalidation. It routes that path to the
content hasher, which hashes the worktree bytes — the correct source
either way. The only cost is reading the file, which is exactly what
the gate exists to avoid paying needlessly.

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

A runtime command executes **once per run, per project** (memoized by
`projectDir + command`), at key-derivation time — which, with the
up-front classify/prefetch pass, is before any task runs. It is a
run-level reading of the ENVIRONMENT (toolchain versions, resolved
config), not a per-task probe: a command that reads another task's
OUTPUT folds the pre-run state, which under deterministic upstreams is
subsumed by the folded upstream keys and degrades to a spurious miss on
the run after that output changes — never a stale hit — but declare the
producing task's output as an input (`dependsOn` + files) rather than
sampling it from a runtime command.

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

## Storage layout

```
<workspaceRoot>/.vx/cache/                  (configurable via vx.workspace.ts cacheDir)
├── .gitignore                              `*` — written when the dir is created, so the
│                                           cache is never committed and never enumerated
│                                           as an input (a user's own file is left alone)
├── cache.db                                SQLite metadata + run history
├── cache.db-wal                            write-ahead log
├── cache.db-shm                            shared memory
└── <hash>.tar.zst                          one artifact per cache entry:
    ├── stdout                              captured stdout (always present, may be empty)
    ├── outputs/<rel>                       declared output files, project-relative (when any)
    ├── workspace-outputs/<rel>             declared outputs.workspaceFiles,
    │                                       WORKSPACE-ROOT-relative (when any)
    └── .vx-meta.json                       per-output [mode, mtimeMs] sidecar
```

`<hash>` is the 16-hex xxh3 key. The `workspace-outputs/` namespace is
additive: tasks that don't declare `outputs.workspaceFiles` produce
byte-identical artifacts to the plain v17 format (which is why the
field needed no `CACHE_VERSION` bump). `output_files` rows mirror the
two namespaces — project rows store the bare rel, workspace rows store
the full `workspace-outputs/<rel>` name as the discriminator.

The container is `Bun.Archive` (libarchive), so the tar DIALECT is not
vx's decision: long names, PAX records and truncation detection are the
library's, and there is no `tar` subprocess, no `--format=gnu` /
`--format=gnutar` spelling probe, and no staging copy of every output
byte before packing (v27).

What libarchive carries no channel for is per-entry metadata: its
writer takes `{ name: bytes }` and its reader hands back regular files
only. vx needs both permission bits (a lost executable bit builds cold
and breaks warm) and millisecond mtimes (the skip-restore probe compares
them), so `packArtifact` stats each output once and writes
`.vx-meta.json` — `{ version, files: { <entry>: [mode, mtimeMs] } }` —
into the archive. Restore applies both. Entries that are not regular
files (symlinks, hardlinks, devices) are not surfaced by the reader at
all, so a poisoned artifact cannot smuggle one onto disk; entry NAMES
are still validated by vx before anything decides where to write.

**Key properties:** one entry is one file — eviction is a single
unlink; no per-entry manifest, no separate `logs/` tree; and local +
remote layers transport the exact same tar.zst bytes end-to-end.
Captured stdout is stored twice on purpose: in the artifact (so it
survives the remote round-trip) and in the `entries` row (so a local
hit replays it with pure SQL, never decompressing the artifact).

### SQLite tables

```sql
-- src/cache/cache.ts schema (SCHEMA_VERSION = 'v22')

CREATE TABLE schema_meta (
  key   TEXT PRIMARY KEY,  -- 'version'
  value TEXT NOT NULL
);

CREATE TABLE entries (
  hash         TEXT PRIMARY KEY,  -- the 16-hex xxh3 cache key
  project      TEXT NOT NULL,
  task         TEXT NOT NULL,
  command      TEXT NOT NULL,
  exit_code    INTEGER NOT NULL,
  duration_ms  INTEGER NOT NULL,
  size_bytes   INTEGER NOT NULL,  -- artifact size
  stdout       TEXT NOT NULL DEFAULT '',  -- captured stdout (pure-SQL hit replay)
  created_at   INTEGER NOT NULL,  -- ms-epoch
  accessed_at  INTEGER NOT NULL   -- ms-epoch; bumps batch at flush (LRU)
);

CREATE TABLE runs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  hash                TEXT NOT NULL,   -- '' when the outcome derived no key (see below)
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
  cache_hit           INTEGER           -- 0/1; convenience for flamegraph color
);

CREATE INDEX runs_hash       ON runs(hash);
CREATE INDEX runs_started_at ON runs(started_at);
CREATE INDEX runs_project    ON runs(project, task);
CREATE INDEX runs_run_id     ON runs(run_id);

-- Every non-group, non-aborted outcome of a run gets a row, so
-- `invocations.task_count` always equals `COUNT(*)` here for that run_id
-- and the terminal summary's "N total". Two of those outcomes never derive
-- a cache key — a `skipped` task (its upstream failed, so it never probed)
-- and a `persistent` one (a dev server is not cacheable) — and they store
-- `hash = ''`. `''` is impossible for a real key (16 hex chars), so it reads
-- unambiguously as "no key recorded"; the key-diff surfaces (`vx why`'s
-- whyDidThisRerun, the cache-key diff) guard it rather than reporting
-- "inputs unchanged" from two rows that never had inputs to compare.
--
-- A `skipped` row is a task of the run but NOT an execution, so the rate and
-- average aggregates in metrics.ts exclude it: counting a zero-duration
-- non-event would dilute success rate, hit rate and mean duration. The
-- completeness reads (listRuns / getRun / the run-detail timeline) include it.

-- v22 (Tier 3): one header row per `vx run` invocation. The `runs`
-- table is per-task; this is the per-invocation record carrying the
-- command, git/CI/host context, tags, and run-level counts. Recorded
-- atomically alongside `runs` via recordRunBundle (one transaction).
CREATE TABLE invocations (
  run_id            TEXT PRIMARY KEY,         -- ULID, == runs.run_id
  command           TEXT NOT NULL,            -- full argv, e.g. "vx run build --all"
  requested_tasks   TEXT NOT NULL,            -- JSON string[] of options.tasks
  cache_policy      TEXT NOT NULL,            -- compact flags, e.g. "lR,lW,rR,rW"
  concurrency       INTEGER NOT NULL,
  flow              TEXT,                     -- 'focused' | 'broad' | NULL (programmatic)
  started_at        INTEGER NOT NULL,         -- ms-epoch
  ended_at          INTEGER NOT NULL,
  total_duration_ms INTEGER NOT NULL,         -- wall clock of the whole run
  task_count        INTEGER NOT NULL,         -- non-group, non-aborted tasks recorded
  failed_count      INTEGER NOT NULL,
  hit_count         INTEGER NOT NULL,         -- cache-hit + cache-hit-remote
  hit_local_count   INTEGER NOT NULL,         -- cache-hit
  hit_remote_count  INTEGER NOT NULL,         -- cache-hit-remote
  exit_ok           INTEGER NOT NULL,         -- 1 if the run's `ok`
  commit_sha        TEXT,                     -- nullable: not a git repo / probe failed
  branch            TEXT,
  dirty             INTEGER,                  -- 1 if worktree had uncommitted changes
  ci                INTEGER NOT NULL,         -- 1 if a CI env was detected
  ci_provider       TEXT,                     -- 'github' | 'gitlab' | 'buildkite' | 'circleci' | 'generic'
  host              TEXT,                     -- os.hostname()
  os                TEXT,                     -- process.platform
  arch              TEXT,                     -- process.arch
  vx_version        TEXT NOT NULL,
  tags              TEXT NOT NULL DEFAULT '{}' -- JSON object {k:v} from --tag
);
CREATE INDEX invocations_started ON invocations(started_at);
CREATE INDEX invocations_branch  ON invocations(branch);
CREATE INDEX invocations_ci      ON invocations(ci);

-- v22 (Tier 3): the input-fingerprint moat. One row per cache-key
-- component, keyed by the cache-ENTRY hash it belongs to (NOT a run
-- id). Written INSIDE the entry-save transaction — only on a cache
-- MISS, never on a hit — via INSERT OR IGNORE. A warm all-cache-hit
-- run writes nothing here. The "why did this re-run?" diff resolves a
-- run to its task hash (runs.hash), then anti-joins two entries'
-- (kind,name,hash) rows in SQL, no app-side recompute. ON DELETE
-- CASCADE sweeps the rows when a prune drops the entry.
CREATE TABLE entry_inputs (
  entry_hash TEXT NOT NULL,          -- == entries.hash / runs.hash
  kind       TEXT NOT NULL,          -- file|env|runtime|ws-runtime|upstream|package|config|forward|workspace
  name       TEXT NOT NULL,          -- file: workspace-rel path; env: var name; upstream: task id; …
  hash       TEXT NOT NULL,          -- the component's contribution to the key
  PRIMARY KEY (entry_hash, kind, name),
  FOREIGN KEY (entry_hash) REFERENCES entries(hash) ON DELETE CASCADE
);
```

WAL mode is on; readers don't block writers. `PRAGMA busy_timeout =
5000` makes concurrent `vx run` invocations queue instead of failing
with `SQLITE_BUSY`.

> **Trust boundary (Tier 3):** `entry_inputs` stores `env` / `runtime`
> component values verbatim, so a secret read as a cache input can land
> in `cache.db`. This is consistent with the existing trust boundary —
> `cache.db` is already a local, gitignored, single-user file that
> records commands and captured stdout. Redaction / an opt-out
> (`cache.inputs.env` `secret: true`) is out of scope for Tier 3.

The Tier-3 tables persist components that were **already fed to
`Cache.key()`** — the cache key derivation is unchanged, so the
`CACHE_VERSION` is NOT bumped (only `SCHEMA_VERSION` rolls to `v22`).
Capture happens as a pure side-channel inside the existing `key()` fold
(`CacheKeyInput.captureInto`), **only on a cache miss** (the warm path
captures nothing), and the rows are persisted with the entry — so a
warm all-cache-hit run does no extra hashing, I/O, or DB writes for the
moat.

### Why SQLite + a single artifact per entry

- **Index queries are fast.** Stats (`SELECT COUNT(*) FROM entries`),
  TTL pruning (`WHERE accessed_at < ?`), per-task lookup
  (`WHERE hash = ?`) all hit a B-tree.
- **A hit costs SQL, not decompression.** Metadata + stdout live in
  the row; the artifact is only opened when outputs actually restore.
- **One artifact = one wire payload.** The same tar.zst bytes serve
  local storage and the remote round-trip — no repacking.
- **One handle, one schema-meta sentinel.** Schema mismatch wipes
  the tables (pre-alpha) — there's no migration code to maintain.

## Config evaluation cache

Evaluating configs is the largest fixed cost of a warm run on a big
workspace (~80 ms for 1000 synthetic configs; reading them as data is
~12 ms). A config that is **provably pure** — every import relative or
`@vzn/vx`, and no mention of `process`, `Bun`, `Date`, `fetch`,
`import.meta`, `require`, a dynamic `import()`, `await`, … outside string
literals and comments — is served from `cache.db`'s `config_evals` table,
keyed by its bytes, the bytes of every file in its relative import
closure, the workspace fingerprint (lockfiles) and Bun's version. Editing
a shared preset moves the key. Anything the static check cannot prove
pure evaluates live, exactly as before, so the cache can be slower but
never wrong. Details and the deny-list:
[`modules/config-cache.md`](./modules/config-cache.md).

## Performance characteristics

- **Hashing cost** on a clean tree is near-zero per file: git index
  OIDs come from the bulk enumeration spawn, so key derivation does no
  file reads. Dirty/untracked files — and any path whose OID is not
  trustworthy (see "Clean filters") — hash in-process (whole-file
  read, behind a `(mtime, size, ctime, ino)` memo). Narrow
  `inputs.files` still helps on heavily dirty trees.
- **Cache read** is one indexed `SELECT` (+ a stat of the artifact).
  Restore is a tar.zst extract, skipped entirely when the on-disk
  tree already matches. `accessed_at` bumps are batched into one
  UPDATE at flush time.
- **Cache write** is one in-process tar.zst pack + atomic rename +
  one SQLite transaction. Hashing dominates the run; storage itself
  is cheap. The remote upload (if any) is backgrounded.
- **Workspace fingerprint** is computed once per `vx run` invocation
  and reused for every task in that run.

## What's NOT in the key (and why)

- **`exec.env.passThrough` _values_.** Would force cache misses across
  machines with different CI flags, regions, or shell prompts. The
  _names_ are in the config hash (step 5) so adding/removing a
  passthrough still bumps the key for affected tasks.
- **Files outside the project directory that aren't declared.**
  Workspace-root configs (`tsconfig.base.json`, etc.) are not
  auto-included — declare them via `cache.inputs.workspaceFiles`
  (root-anchored globs).
- **Node / Bun / OS / build-tool versions — unless you declare them.**
  The canonical mechanism is `cache.inputs.runtime` /
  `workspaceRuntime` (e.g. `workspaceRuntime: ['node -v']`): the
  command output is resolved live at hash time, so it stays correct
  under `--frozen`. Avoid baking versions via
  `define: { X: execSync(...) }` — that value freezes into the config
  object at lock time and goes stale.
- **`vx-lock.json`** — globally excluded (v24); also filtered out of
  `--affected` change sets.
- **`exec.resources` and `exec.remote`.** Both are pure PLACEMENT: they
  decide _where_ and _alongside what_ a task runs, never what it
  produces. Tuning a memory reservation, or pinning a task to this
  machine, does not bust its cache. `remote` especially must not — the
  whole contract of a remote executor is that the same command over the
  same inputs yields the same outputs, so a key that moved with
  placement would split your laptop from the worker pool over nothing.

  **`exec.timeout` and `exec.retries` are the deliberate exception** —
  they stay in the key. That asymmetry is easy to misread as an
  oversight, so: a timeout or a retry budget can change _whether the
  task completes at all_, which is a different question from where it
  ran. They were folded in before the placement fields existed, and
  stripping them now would be a `CACHE_VERSION` bump for no correctness
  gain.

## Bumping `CACHE_VERSION`

Required when:

- A new field is added to the cache key derivation (step list above).
- The order or framing of existing key fields changes.
- The on-disk layout changes (artifact format, entry naming).
- The `CacheEntry` shape changes in a way that affects restore.
- The SQLite schema changes in a way that affects existing rows
  (`SCHEMA_VERSION` also bumps in that case).

Not required when:

- Behavioural changes that adjust _which_ values flow into existing
  key components — those naturally produce different keys for
  affected tasks.
- Changes to WHEN reads/writes fire (policy, prefetch, restore tier,
  background uploads) — key derivation and artifact bytes untouched.
- Doc-only updates.
- Refactors that don't change the bytes fed into the hash.

The bump procedure has a dedicated skill at
`.claude/skills/bump-cache-version/` (used as `/bump-cache-version`).
Files touched: `src/cache/cache.ts` (the constant), this doc (history),
`docs/modules/cache.md` (key/entry shape if it changed),
`CLAUDE.md` (decision log), and the cache test file.

### History

- **v26 → v27**: the artifact CONTAINER changed, so the stored bytes
  under an unchanged key are no longer readable the same way — the
  layout case, not the wrong-bytes case. Packing moved from a `tar`
  subprocess (with a staged copy of every output and a per-host
  `--format=gnu` / `--format=gnutar` probe) to `Bun.Archive`, and the
  per-entry mode + millisecond mtime that tar headers carried natively
  now ride a `.vx-meta.json` sidecar. Measured on the real `Cache.save`
  path (300 outputs / 12 MB, min-of-5, interleaved arms against a
  `git worktree` of the previous commit): **158 ms → 11 ms** to pack,
  the artifact grows ~7 compressed bytes per output for the sidecar.
  Restore is indistinguishable up to ~12 MB, but on a 150 MB
  incompressible artifact it costs +28% time and +19% peak RSS
  (74 → 95 ms, 575 → 683 MB peak, fresh process per arm): `files()`
  returns entries that OWN their bytes, so they coexist with the
  decompressed tar where the old reader returned views into it. Peak is
  ~4.5× artifact size, up from ~3.8×. The bump is mandatory rather than
  self-healing: a v26 artifact has no sidecar, so a v27 reader would
  restore its outputs mode-0644 and mtime-now — silently wrong on disk
  rather than a miss.

- **v25 → v26**: the same shape as v25 — stored bytes that are wrong
  under a key nothing about the fix changes — reached by a different
  producer. A task whose child was killed by a shutdown signal reports
  `aborted`, but `aborted` did not propagate to dependents the way
  `failed` and `skipped` do. So a dependent ran against the aborted
  task's PARTIAL outputs, succeeded, and cached what it had built.
  Because a dependent's key folds its upstream's INPUT key — and a
  signal changes no input — that entry sits under exactly the key a
  healthy run derives, and the next run replays it as a green hit with
  exit 0. Reproduced end to end: run 1 killed mid-write leaves
  `PARTIAL`, run 2 is fully healthy and still serves `PARTIAL` from
  cache.

  Making `aborted` propagate stops new poison but cannot reach entries
  already written, and a `LayeredCache` uploads them — so the reach is
  a whole team's shared cache, not one developer's disk. That is what
  makes the trade worth it: one cold rebuild against a class of
  silently-wrong output. The interactive Ctrl-C path was never the
  vector (vx's handler exits before a dependent can cache); the
  reachable ones are an external `kill`, a supervisor, `docker stop`, a
  self-terminating script, and every `handleSignals: false` embedder —
  which includes `vx watch` and the distributed agent loop.

- **v24 → v25**: the ARTIFACT BYTES in every existing entry are wrong
  while the key addressing them is unchanged — the one situation a
  version bump exists for, and the opposite of the recent self-healing
  no-bump cases. Two defects on the pack/restore path, both silent data
  loss on an ordinary cache hit with no attacker involved:
  - **The executable bit was stripped from every cached output.**
    `packArtifact` staged each output with `Bun.write`, which creates
    the destination under the process umask and does NOT carry the
    source's mode, so the tar header recorded 0644 and the restore
    faithfully reproduced 0644. Any build emitting a CLI shim, a
    compiled binary or a generated script worked cold and broke warm —
    including this repo's own `build.bun.*` release binaries. Fixed by
    chmod-ing each staged copy to the source's mode.
  - **Outputs whose archive entry name exceeded 100 bytes were dropped
    on every restore.** POSIX ustar splits such a name into
    `prefix` + `name`; the reader read only `name`, which no longer
    starts with `outputs/`, so the file was neither restored nor
    indexed. Not self-healing: with no `output_files` row, the
    skip-restore check compared a truncated expectation against a
    truncated tree and agreed forever. Threshold is a
    project-relative output path of ~93 chars — ordinary for a modern
    bundler. Fixed by reading `prefix` (gated on the POSIX magic, since
    GNU headers reuse those bytes for atime) AND by packing
    `--format=gnu`, which carries long names in an `L` record.

  The format switch also fixes a working build being reported as
  FAILED: ustar cannot split a single path COMPONENT over 100 bytes and
  exits non-zero ("file name is too long (cannot be split)"), which
  `packArtifact` raised _after_ the task had already succeeded. 120-char
  filenames are legal everywhere and routine in snapshot/fixture trees.

  Shipped with three defence-in-depth fixes that needed no bump of their
  own: `restoreOutputs` now throws instead of returning quietly when the
  artifact is gone or cannot produce an output the index recorded (the
  caller has already wiped the declared outputs by then, so a quiet
  return reported a green hit over an emptied tree — reachable via a
  concurrent `vx cache prune`); the tar reader rejects an entry whose
  declared size runs past the end of the archive (`subarray` clamps, so
  it used to install short, NUL-padded content as a cache hit instead of
  degrading to a miss); and directory entries now get the same
  containment + realpath checks as file entries (`mkdir` follows a
  pre-existing symlink, so directories could be created outside the
  destination). No `SCHEMA_VERSION` bump — no table changed.

- **SCHEMA v23 → v24 (no `CACHE_VERSION` bump)**: `file_hashes` gains
  `ctime_ms` + `ino`. The memo keyed on `(mtime, size)` alone, and its
  row persists across runs, so any producer that preserves mtime —
  `tar -x`, `unzip`, `cp -p`, `rsync --times`, a `SOURCE_DATE_EPOCH`
  generator — got the previous run's digest for genuinely different
  bytes: a stale cache hit. `utimes` cannot suppress ctime
  unprivileged and an atomic write-then-rename changes the inode, so
  the two together close it (git's index keys on ctime+ino+dev for the
  same reason); both come free from the stat already taken. The key
  DERIVATION is unchanged — the memo simply stops answering wrongly —
  so an affected task's key moves from a wrong value to the right one:
  it misses once, re-runs, re-caches. Self-healing, never a wrong hit.
  Landed alongside two other stale-hit fixes that needed no schema
  change: the cache-miss path now marks the outputs `cleanOutputs`
  wiped (it was the only one of four sibling call sites that dropped
  the return, so a deleted output kept a live index OID and stayed in
  a consumer's input set), and `skip-worktree` / `assume-unchanged`
  entries no longer keep a trusted OID (they sit at stage 0 and
  `git status` reports nothing for them, so a sparse-checkout path
  that was absent from disk still counted as an input). The schema
  gate drops + recreates on the version mismatch (pre-alpha, no
  migration), so this costs one cold rebuild.
- **SCHEMA v21 → v22 (no `CACHE_VERSION` bump)**: Tier-3 dashboard
  tables — `invocations` (one header row per `vx run` with command,
  git/CI/host context, tags, and run-level counts, recorded with `runs`
  via `Cache.recordRunBundle`) and `entry_inputs` (one row per cache-key
  component, keyed by the cache-ENTRY hash — the input-fingerprint
  moat). `entry_inputs` is written **inside the entry-save transaction,
  only on a cache miss** (`INSERT OR IGNORE`), so a warm all-cache-hit
  run writes nothing for the moat — Tier 3 has **zero warm-run cost**.
  The cache KEY derivation is unchanged: these tables persist components
  already fed to `Cache.key()` (captured via a pure side-channel,
  `CacheKeyInput.captureInto`, at the same fold sites — only on a miss),
  so existing artifacts stay valid and `CACHE_VERSION` stays `v24`. The
  schema gate drops + recreates on the version mismatch (pre-alpha, no
  migration).
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

- **v21 → v22: pure-input transitive** (+ SCHEMA v21): reverted the v21
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

- **v20 → v21: early cutoff** (+ SCHEMA v19, **reverted in v22**):
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
  `wallclock_start_ns` / `wallclock_end_ns`, `cache_hit`. All
  nullable; directly queryable via `sqlite3 cache.db`. The on-disk
  `<hash>/` layout itself was unchanged.
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
--others --exclude-standard`. Matches what Turborepo and Nx both do
  at the bottom of their hash pipelines. Side-effects user-visible:
  (a) nested `.gitignore` patterns are anchored to the gitignore's own
  directory, fixing the v13 footgun where `pkg/.gitignore: src/skip.ts`
  was misinterpreted as `<workspaceRoot>/src/skip.ts`; (b)
  `.git/info/exclude` and global excludes participate; (c)
  untracked-but-not-ignored files enter inputs immediately (no
  `git add` required). (The non-git fallback walker was later removed
  entirely — vx hard-requires git; a non-repo workspace gets a clean
  `UserError` telling the user to `git init`.)
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
