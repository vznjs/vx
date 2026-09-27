# Workstream A — cache and keys (plan 2026-09-27): the record

## Leads (the 2026-09-27 review, ranked by harm; each proven by a repro)

1. DONE (A-1). A nested git repository inside a project (a vendored submodule, an
   embedded repository) is one listing entry and no files: its files never
   reach the key, and an edit there is a stale hit. A-1.
2. DONE (A-2). On a file system with whole-second timestamps (ext3, HFS+, FAT/exFAT,
   some NFS) the per-file hash memo stores a digest for a file rewritten
   later in the same second at the same size: a stale hit
   (`FILE_HASH_RACY_MS` is 50 ms, the clock's tick is 1 s). `movedInput`
   shares the assumption.
3. DONE (A-3). A save renames the artifact into place before its rows commit: a commit
   that fails (`SQLITE_BUSY` past the busy timeout, `SQLITE_FULL`) leaves
   one save's bytes beside another's rows, and every later hit on the key
   fails the task as a corrupt artifact until a prune.
4. The run-end directory snapshot vouches for a stray a dependant wrote
   into an output directory after the save or restore; later hits skip the
   walk and the stray survives under a green run.
5. DONE (A-5). A zstd artifact of several frames passes the first-frame size check and
   is decoded whole before the ceiling applies (2 GiB of memory from a
   32 KB remote body); the comment calls that check unreachable.
6. DONE (A-4). An output of mode 000 or mtime 0 (`SOURCE_DATE_EPOCH=0`) restores with
   the wrong metadata and is restored again on every hit; one with an
   mtime before 1970 is never cached ("corrupt artifact").
7. DONE (A-8). A `cache.db` corrupt past its first pages fails every task as an
   internal error, and `vx cache prune` prints a stack.
8. DONE (A-7). `cacheRetention` never runs under a local-read-only policy while
   remote hits are still ingested locally.
9. A gitignored `.gitattributes` below a project escapes the clean-filter
   gate: the LF index blob of a CRLF file is trusted.
10. DONE (A-6). `core.trustctime=false` / `core.checkStat=minimal` weaken `git status`,
    and the index-OID shortcut inherits it (a same-size, mtime-restoring
    rewrite keeps the key).

## Leads for other streams

- D: the workspace fingerprint folds lockfiles, `pnpm-workspace.yaml` and
  `.yarnrc.yml`, not `.npmrc` / `bunfig.toml`, which change what an
  install lays down under an unchanged lockfile. Unprobed.
- C: `run-lock.ts` says "the cache itself is safe (SQLite waits,
  artifacts land by rename)"; lead 3 shows otherwise across two
  workspaces sharing one `--cache-dir`.
- B/C: `signal-handling.test.ts` › "at the moment vx exits on a signal
  every task process is gone" failed once in two gates on this container
  (a child `gone within 21 ms` after the exit, procfs of another pid
  namespace), green on the re-run with no change.
- F: `vx-reapi` `wedged.test.ts` › "RST_STREAM(CANCEL) reads as CANCELLED
  and is not retried" failed once in a gate (`sent: 0` for 1), green in
  three runs after with no change: the probe's count races the cut.

- C: a corrupt cache index (A-8) now reaches each task as the same `UserError`, and a 40-task run prints the line 40 times; the scheduler could say a run-wide refusal once.
- C: the run-end output-directory snapshot (lead 4) vouches for a stray an unsandboxed dependant writes into an upstream's output directory after its save or restore, so later hits skip the walk and the stray survives, green. The fix needs `run.ts` (the snapshot call) and `hit-restore.ts` (its direct call) to pass the task's additions predicate, so the snapshot can refuse a file outside the entry's rows and outside the additions; `OutputIndex.recordOutputDirs` can take the predicate.

## Record

### A-1 (2026-09-27, lead 1)

A nested repository inside a project is one entry of git's listing (a mode-160000 gitlink, or `dir/` when untracked) and none of its files, and a directory is no input: a task reading `vendor/lib/x.txt` under `**` folded nothing of it, and after an edit there the next run was `1 up-to-date` with the old output while `git status` named the path.

- Fix (`git-inputs.ts`): `expandNestedRepos` replaces each such entry with what its own `git ls-files` lists, recursively, in the workspace-wide enumeration and in `runGitLsFiles`; the files carry no index OID and hash by content. A submodule never initialised (no `.git`) folds nothing. `workspaceFiles` globs now reach into a nested repository too. `caching.md`, `modules/git-inputs.md` and `modules/inputs.md` say so.
- Rows: `nested-repo-inputs.test.ts` › a nested repository inside a project (the listing, scoped and workspace-wide, and the per-project spawn) and › an edit inside it is a miss (gitlink and untracked). Red without the fix.

### A-2 (2026-09-27, lead 2)

A file system that keeps whole seconds (ext3, HFS+, FAT/exFAT, some NFS) stamps a write at 12:00:00.900 as 12:00:00, and the racy windows were 50 ms: a file written and hashed 120 ms apart was memoised, and a same-size rewrite later in that second kept every field the memo keys on. On an ext2 mount the next run was `up-to-date` with `src=BBBB dist=AAAA`. The pre-save re-check and the output-directory snapshot shared the assumption.

- Fix (`layer.ts` `racyWindowMs`, used by `file-hashes.ts`, `output-index.ts`, `task-hash.ts`): a stamp with no sub-second part widens its window by a second. Off the warm path (a memo write, a miss's re-check, the run-end snapshot). `caching.md`, `modules/cache.md`, `modules/task-hash.md` say so.
- Rows: `whole-second-stamps.test.ts` (simulated stamps: `spyOn` of `lstatSync`, `setSystemTime`, `utimes`): the memo, the batch, the re-check against its fact and against the command's start, the directory snapshot, each with a sub-second control. Red without the fix.
- Lead for C: `fingerprint-watch.ts` judges the lockfile's ctime against the same 50 ms window.

### A-3 (2026-09-27, lead 3)

A save renamed its artifact into place before the transaction that writes its rows. With the write lock held past the busy timeout by another process on the cache directory, a `--force` re-save that named its chunk differently threw `SQLITE_BUSY` after the rename: the new bytes sat beside the old rows, and every later restore of the key failed the task ("artifact is missing 1 recorded output(s)"). `SQLITE_FULL` at the commit, and two workspaces saving one key on a shared `--cache-dir`, did the same.

- Fix (`cache.ts` `writeArtifactAndIndex`): the rename runs inside the transaction, taken IMMEDIATE, so it waits for the lock and commits with the rows; a commit that fails after it unlinks the artifact (the key misses). The save path's steps in `modules/cache.md` described a temp DIRECTORY unused since v17; they now describe the pack, scan and transaction. `caching.md` says so; `save: rename` left `modules/timing.md` with its span.
- Rows: `cache-save-lock.test.ts` › a save that cannot take the lock leaves the previous entry whole (bytes, rows, no temp); one whose insert fails after the rename leaves the key a miss; control, a free lock replaces both. Red without the fix (the first with the reported `CorruptArtifactError`, the second under the tmp-only unlink mutant).

### A-4 (2026-09-27, lead 6)

The restore skipped a sidecar mode of 0 and an mtime of 0 or less: a mode-000 output came back 0644 and a `SOURCE_DATE_EPOCH=0` output came back stamped now, under a green hit, and every later hit restored them again (the skip-restore check could never match). An mtime before 1970 wrote a negative octal into the tar header, which the reader refused: the task's save failed as a "corrupt artifact" on every run.

- Fix (`archive.ts`): the sidecar's stat is applied whole (a bare tar's header mtime of 0 stays unknown); the header clamps a negative mtime to 0; the restore stamps with a `Date`, since Bun's `utimesSync` reads a negative number of seconds as now (probed on 1.4.2). `caching.md` says so.
- Rows: `archive-extract-meta.test.ts` › the sidecar at its edges: mode 000, mtime 0, mtime 1960, and an ordinary control. The first three red without the fix.

### A-5 (2026-09-27, lead 5)

The decompression gate read the first zstd frame's declared size, and `Bun.zstdDecompress` decodes every frame there is: a 100-byte frame with a large one appended passed the ceiling and expanded whole in memory before the result's length was checked (2,089 MiB peak from a 32 KB body under a 64 MiB cap). An ingest from a remote and a restore both take that path for artifacts of 4 MiB or less; the check that fired was the one its comment called unreachable.

- Fix (`zstd.ts` `isOneFrame`): the one-call decode is taken only for exactly one whole frame (header, blocks walked by their own sizes, checksum, nothing after); anything else decodes as a stream under the running count. vx's own artifacts are single frames and keep the one call. `caching.md` says so.
- Rows: `zstd-frames.test.ts` › two frames are refused by the running count and never reach `Bun.zstdDecompress` (bytes and a file), decode whole as a stream under the cap; control, one frame small or of many blocks takes the one call. Red without the fix.

### A-6 (2026-09-27, lead 10)

Under `core.trustctime=false` or `core.checkStat=minimal` git judges a file by mtime and size (whole seconds, with minimal), so a same-size rewrite that restores its mtime (`cp -p`, `tar -x`) reads clean, and its index OID keyed the old bytes: the next run was `up-to-date` with `src=BBBB dist=AAAA`. This container's global git config sets both.

- Fix (`git-inputs.ts` `gitStatWeakened`, over the `git var -l` the enumeration already spawns): either setting drops every index OID, and files hash through the memo, which keys on ctime and inode. `caching.md` and `modules/git-inputs.md` say so. The core test tasks define `GIT_CONFIG_GLOBAL=/dev/null` (`vx.config.ts`): the suite's fixtures assume git's defaults, and a host's global config (this one's: both settings, and signed commits) is not the code under test.
- Rows: `stale-hit.test.ts` › each setting with a same-size, mtime-kept rewrite is a miss (red without the gate); the OIDs are kept under a pinned default stat and dropped under a minimal one; the settings' spellings, the last value winning.

### A-7 (2026-09-27, lead 8)

`evictIfDue` returned early on a handle with the local WRITE axis off, while `ingest` is not gated on it: under `--cache=local:r,remote:rw` every remote hit still lands in the local store, and the workspace's `cacheRetention` never ran, so that store grew hit by hit past its `maxSize`. `schema.md` says retention applies to every run that writes the local cache, and `policy.ts` that prune is never affected by the policy; the code said otherwise.

- Fix (`cache.ts`): retention is gated on the directory being this handle's to write (`writeBlocked`) and on the handle not being a reading verb's (`inspect`), not on the write axis.
- Rows: `cache-retention.test.ts` › applies under a local-read-only policy, whose run still ingests remote hits (red without the fix); the old row "a handle that does not write evicts nothing" pinned the defect and now holds the real line: a reading verb's handle evicts nothing with an entry due (red with the `inspect` guard removed).

### A-8 (2026-09-27, lead 7)

The open reads the index's header and `schema_meta` alone (item 1005), so a `cache.db` corrupt deeper answered the first lookup that reached the bad page: on a 40-project workspace with the `entries` root page garbled, every task failed as `[vx] internal error in pN#build: SQLiteError: database disk image is malformed`, and `vx cache prune` printed the error with a stack.

- Fix (`cache.ts` `guard`): every public entry point that reads or writes the index (lookups, saves and ingests, prune, retention, stats, run records, config evaluations, the file-hash memo, the output rows) maps SQLite's corrupt and not-a-database codes to the open's own `UserError`, naming the file and the remedy; every other error passes through. `modules/cache.md` says so.
- Folded: two comments that claimed what the code lacks (`entries` holds stdout; the miss capture is `describeTaskInputs` before the spawn). Coordinator's DROP-list question: `output_dirs` is cleared by the FK cascade, `config_closures` kept by design (item 488, pinned in `cache.test.ts`); no change.
- Rows: `cache-unreadable.test.ts` › an index corrupt past the pages the open reads (the `entries` root page garbled after a checkpoint): get, getIngested, getMany, has, stats, prune, evictIfDue and save each refuse by name (red without the fix: the raw `SQLiteError`); control, the same index whole answers each.

### A-9 (2026-09-27, the next failure class: a leaked process)

A `cache.inputs.runtime` probe ran in vx's own process group with nothing listing it. A Ctrl-C during key derivation, while the probe still ran (`sleep 300` standing for a hung `git` or `node -e …`), ended vx and left the probe's shell and its child to init.

- Fix (`inputs.ts` `runRuntimeCommand`): each probe is spawned `detached`, its own group; the probes still running when vx exits are SIGKILLed with their trees (a `process.on('exit')` hook, as `sandbox-runtime.ts` does for its temp files). A `kill -9` of vx still leaves one: the task groups' guard (`exec/kill-tree.ts`) is B's, and probes are not on it. `caching.md` says so.
- Rows: `runtime-probe-exit.test.ts` › a probe running when vx exits on SIGINT is gone with its tree (the shell and its child, both proven alive first). Red without the fix.

### A-10 (2026-09-27, coordinator lead from D)

`cache.outputs.files: ['{dist,lib/esm}/**']`: `Bun.Glob`'s scan skips a brace holding `/`, so the save packed nothing and a hit cleaned the outputs and restored nothing, green. `schema.md` promised brace sets in every task glob.

- Fix: `scanUnion` (`inputs.ts`) expands slash braces with `slashBraceExpansions` (moved from `workspace.ts` to `util/paths.ts`, one helper for both).
- Row: `brace-outputs.test.ts` (save, wipe, hit restores both dirs). Red without the fix.

### A-11 (2026-09-27, I's lead)

Nested-project boundaries were one `<nested>/**` glob each: O(files × nested), 38 % of astro's warm no-op (I measured 834 → 521 ms median with this patch, neutral with no nested project). The glob also read `*` in a nested dir's name as a wildcard: a project at `pkg*` dropped sibling `pkg-b` from the parent's key.

- Fix (`inputs.ts` `inNestedProject`): an ancestor-directory set lookup in `resolveFiles` and the output scan.
- Row: `nested-boundary.test.ts`, inputs and outputs: the nested project out, `pkg-b` and `a/bc` in. Red without the fix.
- Sweep of `key-fold.ts` (50 mutants, 49 caught, 1 a no-op): the `workspaceRuntime` and plugin-part folds were held only by the golden digest, which each `CACHE_VERSION` bump re-records. Two rows in `task-hash-derive.test.ts` pin them by behaviour; each fails with its loop deleted.

### A-12 (2026-09-27, F's lead, narrowed)

F asked about an upstream whose recorded outputs are partly on disk. Locally, a deterministic hit or save never leaves that state. The core case found: `gen`'s input edited while it ran, so `gen` withheld its save (item 1015) but kept its key K. `use` saved what it built from the edit under a key folding K, and once the input was put back `use` hit the edit's output.

- Fix (`execute-task.ts`, `TaskOutcome.unkeyed`): a task whose key no longer held carries `unkeyed`; a dependant whose key folds one (per its `cache.inputs.tasks`; one reading it by content is judged by its bytes) saves nothing and carries it on. The public `TaskOutcome` gains the optional field (contract regenerated). `caching.md` says so.
- Row: `unkeyed-upstream.test.ts` (gen → use → pack, the edit on a marker): neither dependant saves; the next run rebuilds. Red without the fix (both hit).

### A-13 (2026-09-27, coordinator lead from H)

An output glob `**/*.js` reached `node_modules`, so the clean before each run deleted installed files; a `workspaceFiles` output glob reached `.git`.

- Fix (`inputs.ts` `outputExcludes`): `node_modules` is excluded unless a glob names it; workspace outputs take `OUTPUT_NEVER` too. `caching.md` says so.
- Row: `output-reach.test.ts` (the clean itself; an install task's `node_modules/**` as control). Red without the fix.
