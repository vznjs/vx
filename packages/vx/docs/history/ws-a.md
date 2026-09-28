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
4. DONE (item 1087, another stream). The run-end directory snapshot vouches for a stray a dependant wrote
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
9. DONE (A-19). A gitignored `.gitattributes` below a project escapes the clean-filter
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

### A-14 (2026-09-27)

On a full disk the cache's side writes threw: the file-hash memo, the output stamps and the access-time flush failed the task on `SQLITE_FULL`; prune deleted rows before unlinking, so its delete could not get room; a save whose temp write failed left the temp.

- Fix (`layer.ts` `isIndexFull`): the memo, stamp and access writes skip on a full index; prune unlinks first and retries its row delete once; the temp is unlinked on a failed write; the orphan sweep stamp is best-effort. `caching.md` says so.
- Rows: `cache-disk-full.test.ts`, each red without the fix.

### A-15 (2026-09-27, coordinator lead)

`cache.inputs.files: ['src/{b}.ts']` matched `src/b.ts` (Bun.Glob reads a one-alternative brace) and never the file named `src/{b}.ts`, so an edit to it was a hit.

- Fix (`inputs.ts` `refuseOneAlternativeBrace`): such an entry in `files` or `workspaceFiles` is refused, naming both spellings. `schema.md` says so.
- Rows: `one-alternative-brace.test.ts`, three red without the fix; control: the escaped form and a two-way brace.

### A-16 (2026-09-27, coordinator lead)

The `local-shortcircuit.ts` sweep left survivors; the code was right, but nothing held it.

- Rows (`local-shortcircuit.test.ts`): the per-task pool keeps a stable miss out of the tier; one throwing probe leaves only its own task unprobed; a throwing key derivation degrades to no short-circuit. Each is red under its own mutation and no other.
- The "workspaceFiles INPUTS" row was disarmed: the cold run withholds rdr's save (`shared/g.txt` changed after its key was taken), so its reader missed and a miss never enters the tier. A second run saves it; the row now asserts the hit, and removing the `workspaceInputsReach` term reddens it.
- Left: the reach and propagation exclusions (equal and ancestor prefix, root project, transitive dependants) still hold no row each.

### A-17 (2026-09-27, coordinator lead)

A persistent task had no key on any path, so a cached dependant folded nothing of it: a cached e2e behind a dev server stayed `up-to-date` after the server's sources changed (repro: `web#e2e` → `api#dev`, edit `api/src/server.js`).

- Fix: a persistent task is keyed as a task with no `cache` (its whole project), on every key path: the live one (`executePersistentTask`, skipped when nothing depends on it), stable keys, the plan, excluded keys and the sandbox's keyed projects. Chosen over a refusal: it is the rule an uncached upstream already follows, and `cache.inputs.tasks` opts out. Docs: `caching.md`, `modules/{keyed-projects,plan,stable-keys,excluded-keys,cache}.md`.
- Rows: `stale-hit.test.ts` › "a cached dependant of a persistent task re-runs when the server's sources change", red without the fix. Three rows that pinned the old rule flipped (`keyed-projects` R3 and R4, `in-run-writes` › through a persistent task).
- Folded in (coordinator lead): three `workspace-files.test.ts` partition rows went red outside the sandbox under a global `core.checkStat=minimal` or `core.trustctime=false` (A-6 drops OIDs there). The fixture sets both locally; `process.env.GIT_CONFIG_GLOBAL` would not reach a git spawned without `env`.

### A-18 (2026-09-27, coordinator lead)

A host git config with `core.checkStat=minimal` or `core.trustctime=false` turned trusted-OID fixture rows red outside the gate (`workspace-files`, `git-subdir-workspace`). Pinning `GIT_CONFIG_GLOBAL` in a helper cannot fix the class: a spawned git reads the process's startup environment, so `process.env` set in a preload or a test reaches no child (probed on Bun 1.4.2), and 79 files run `git init` in a dozen spellings.

- Fix: `bunfig.toml` preloads `tests/helpers/git-hermetic.ts`, which refuses a bare `bun test` under such a config and names the env to run with. The gate's test tasks add `GIT_CONFIG_NOSYSTEM=1` to `GIT_CONFIG_GLOBAL=/dev/null`. No git (a sandboxed shard): no check.

### A-19 (2026-09-27, lead 9)

A gitignored `.gitattributes` is applied by git but never listed by the enumeration (`status` omits ignored paths), so the filter gate read "no attributes" and trusted a CRLF file's LF index blob: a CRLF→LF edit replayed the CRLF output. Repro: project `.gitignore` holding `.gitattributes`, `*.txt text`.

- Fix (`git-inputs.ts`): the enumeration's `git status` adds `--ignored=matching`, which names an ignored path without walking an ignored directory; an ignored `.gitattributes` opens the gate. Cost, 1,000-package warm no-op, 15 rounds A/B/A: median 428 ms against 428 and A/A 443, min 394 against 385 and 387. Docs: `caching.md`, `modules/git-inputs.md`.
- Row: `git-trust.test.ts` › "an ignored one does too", red without the fix.
- Also recorded here: lead 4 was fixed by item 1087.

- Cold-save lead (I-6), probed on the 1,000-package bench (test command `true`), cold runs, A/B/A interleaved, 18 rounds unless noted. Neither ships.

- Async `scan` + `lstat` in `scanUnion` (6 rounds): wall median 5.37 s against 5.22 and A/A 5.19; CPU even. Refuted.
- `WITHOUT ROWID` on `output_files`, `output_dirs`, `entry_inputs` (needs a `SCHEMA_VERSION` bump): wall median 5.01 s against 5.09 and A/A 5.11, but min 4.78 against 4.74 and 4.71; CPU median 11.57 against 11.74 and 11.65. Not resolved, and it is not worth forcing every cache cold.

### A-20 (2026-09-27, backlog: warm classify at 5,000 projects)

The stability gate called any same-project reader of an `outputs.files` producer unstable, so every `test` behind its `build` was keyed three times (classify, admission's dedup, execute) and never probed in the batch. At 5,000 projects that was all 5,000 tests.

- Fix (`stable-keys.ts`): a declared-output producer reaches a same-project reader only where their globs can meet (literal prefixes, ancestor or equal); undeclared writers, and rewriters the key does not fold, stay project-wide. `caching.md` already said so; `modules/stable-keys.md` does now.
- Cost, 5,000-package warm no-op (10,000 up-to-date), 12 rounds A/B/A, a copy per arm: median 1.236 s against 1.471 and A/A 1.438; min 1.149 against 1.296 and 1.339; CPU median 2.44 s against 2.71 and 2.68.
- Rows: `stable-keys.test.ts` › the gate's glob cases; `local-shortcircuit.test.ts` › "a same-project reader whose globs miss…", red without the fix.

### A-21 (2026-09-27, backlog: split cache.ts)

`cache.ts` (2,049 lines) declared every table inline in the `Cache` constructor. The DDL is the one seam that touches nothing but the handle: it moves to `schema.ts` (`createTables`, 215 lines); the version check, reset and statements stay. Retention was the other candidate and is not a seam: it reads seven private fields and interlocks with the access flush and the write gates. No behaviour change; `modules/cache.md` and the module index name the file.

### A-22 (2026-09-27, left by A-16)

The short-circuit's reach test held only its below-the-dir term and first-hop dependants: a mutant of the root-project term, the equal prefix, the prefix above a project's dir, or the transitive walk passed the suite. `dir === '.'` was dead (`path.relative` gives `''` for the root) and is gone.

- Rows (`local-shortcircuit.test.ts`): an equal prefix, a prefix above, the root project, dependants two hops down. Each red under its own mutant.

### A-23 (2026-09-27, sweep: `file-hashes.ts`)

16 mutants over the 15 files that name the memo: 9 caught, 7 survived. The mtime, size and inode compares (both forms) are masked by ctime on a real file, which moves on every write and cannot be set back; `hashFiles`'s exec-bit mode had no row.

- Rows (`cache-hash-files.test.ts`): a planted memo row that disagrees in one field is not trusted, by either form, with an all-agreeing control; an executable keys as 100755 in the batch form. Each survivor red under the new rows.
- Survivor list noted as INCONCLUSIVE by the driver (skips in `cache.test.ts`, `config-cache.test.ts`); none failed anywhere, so read as survived.

### A-24 (2026-09-27, sweep: `miss-save.ts`)

16 mutants over the 15 files that reach it: 7 caught, 9 survived. One was a stale restore: without the snapshot's count check, a walk that saw FEWER files than the entry's rows (a dependant removed one before run end) vouched for the tree, and the next hit skipped the restore and left the file gone.

- Rows: `output-dirs.test.ts` › a run records the saved tree at run end; an entry file removed before run end is not vouched for and the next hit restores it. `sandbox-empty-outputs.unsafe.test.ts` › the sandboxed-no-write hint, with a write-grant control (unsafe: a sandbox cannot nest in a sandboxed shard). The count, the push and the hint are each red under their mutant.
- Still unheld: the additive task's `holds` (S1, S2), the added-strays filter (S3), the workspace-row filter in `expected` (S5), and the workspace marks and partition drop after a save (S13, S14). Each needs an additive or workspace-output fixture; next.

### A-25 (2026-09-27, left by A-24)

The run-end snapshot's rules for the addition shape (item 588) held no row: the additive task's presence check (S1), its branch (S2), and the upstream's filter of what the dependant added (S3).

- Rows (`overlapping-outputs.test.ts` › "the run-end snapshot of each side"): both sides record the shared tree when it holds what each saved; the additive side does not vouch for a tree that lost its file. Each red under its mutant. Still unheld from A-24: the workspace-row filter (S5) and the workspace marks (S13, S14).

### A-26 (2026-09-28, left by A-24)

The last `miss-save.ts` survivors: the workspace-row filter in the snapshot's `expected` (S5), and the marks a save leaves in the run's git snapshot (S13, S14). The marks were a masking trio: the partition drop covered the workspace partition, and each mark covered a project's own snapshot, so no one mutant reddened anything.

- Rows (`miss-save-marks.test.ts`): a same-run `workspaceFiles` reader keys a workspace output and a project output its upstream just wrote; a workspace output landing in another project's dir is keyed by that project's reader; an undeclared write in the saving task's project is keyed by a workspace reader; the run-end snapshot of a task with workspace outputs counts its project rows only. Each red under its mutant.
- `key-fold.ts` swept (2026-09-27): 19 mutants (every fold part, the sorts, path vs content, a partial provided-hash list), all caught by `key-fold.test.ts`. No row needed.
- `task-hash.ts` swept (2026-09-27): 9 mutants (the moved-input checks, the remote strip, the group hash, the requested-only forward args), 8 caught. The survivor drops the workspace-OID merge: those files then hash from disk to the same OID, so it is equivalent for correctness (a read the merge saves).

### A-27 (2026-09-28, sweep: `output-index.ts`)

15 mutants over the 35 files that reach the index: 7 caught, 8 survived. The skip-restore proof's size, mode, mtime and inode compares were masked by ctime (as in A-23), and a stamp for a file that no longer matched its row had no row.

- Rows (`output-dirs.test.ts`): `isOutputsCurrent` trusts a row only when every field agrees (a planted row off by one field); a stamp is taken only for a file that still matches its row, with a control. Five survivors red under them.
- Equivalent, no row: an unstamped row (`ino` undefined never equals a real inode), a dir recorded absent that now exists (its mtime is never −1), and the walk's symlink guard (a symlink's dirent never reports a directory).

### A-28 (2026-09-28, sweep: `archive.ts`)

15 mutants of the restore's safety checks (every name refusal, the three `..` spellings, the destination and link-out containment): 12 caught. Every `..` row carries an inner `/../`, so the leading and trailing clauses of `hasParentSegment` were unheld, even as a pair with the containment check.

- Rows (`archive-security.test.ts`): a trailing `..` (`outputs/x/..`, which names the destination itself) and a leading `..`, each refused by the name clause's own message. Both red under their mutant.
- Unreachable alone: the destination-containment check, which every `..` spelling now meets after the name check (item 486 records the pair as deliberate).

### A-29 (2026-09-28, sweep: `tar-stream.ts`)

42 mutants over the four files that reach it: 26 caught, 16 survived. One was a defect: the prefix read accepted any magic starting `ustar`, so an old GNU header (`ustar  `, atime and ctime at 345, filled by `tar --format=gnu -G`) named its entry `<atime>…/<name>`. The docs already claimed the POSIX gate.

- Fix: the prefix is read under `ustar\0` only.
- Rows (`tar-stream.test.ts`): the GNU header with a POSIX control; lone zero blocks between entries and at the end; a NUL typeflag; a skipped pax `g`; an archive ending after an extended header, and inside padding; a pax size past 2^53; a Blob body that disagrees with its size; a size past the octal field; a stat mode's type bits dropped. Each red under its mutant.
- Equivalent: a pax record with an empty key (never read), a ustar split leaving an empty name (read back the same), the checksum's last space (already written by the fill), an empty chunk pushed.
- `policy.ts` and `config-evals.ts` swept: 24 mutants, 23 caught; the survivor dropped the segment trim, now held by `cache.test.ts` › "reads segments with spaces around them".
- The zero-length pax record (T6) hangs the reader under its mutant, so `bun test` never ends: caught by a timeout, not a row.

### A-30 (2026-09-28, sweep: `zstd.ts`)

25 mutants over the eight files that reach it: 15 caught, 10 survived. No defect; the frame check and the size gate were right but partly unheld.

- Rows: `zstd-frames.test.ts` › RLE blocks, a content checksum and an empty body keep the one-call decode; a file past the stream threshold is refused by its declaration; the stream count refuses past the cap, not at it. `cache.test.ts` › a 4-byte dictionary ID; a header cut inside its size field. Each red under its mutant.
- Equivalent: a reserved block (the decoder refuses it on either path), the result-length backstop (unreachable, as its comment says), and the 4 MiB threshold's `<=` (either path decodes the same bytes).

### A-31 (2026-09-28, sweep: `inputs.ts`)

46 mutants over the 21 files that reach it: 38 caught, 8 survived. No defect.

- Rows (`inputs.test.ts` › "inputs.ts edges"): a tracked file replaced by a directory is not an input, what it holds is; an additive task owns a file it rewrote at the same size, or at the same mtime; a clean never removes the project directory it emptied; an additive clean prunes a parent whose recorded directory is already gone; a workspace-output clean prunes what it emptied. `stale-hit.test.ts` › a `workspaceFiles` input with a non-UTF-8 name is refused. Each red under its mutant.
- Unheld: an output directory whose realpath fails is refused (I18). It needs a directory that the scan listed and that left before the realpath: a race with the task, not a fixture.

### A-32 (2026-09-28, sweep: `stable-keys.ts`)

43 mutants over the eight files that reach it: 35 caught, 8 survived. No defect.

- Rows: `undeclared-writes.test.ts` › "the stability gate reads the reach": an undeclared writer, a cached rewriter two hops up, and a rewriter writing outside its project, each reached through a task that may write nothing, still make the reader unstable (with a control); an uncached task is never probed up front. `stable-keys.test.ts`: a negated `**` reaches nothing; a prefix stops at the first wildcard segment. Each red under its mutant.
- Equivalent: `ProjectSet.or` without a copy only adds producers to sets already stored (more unstable, never less); a dependency missing from the graph never happens, as the graph is closed.

### A-33 (2026-09-28, sweep: `git-inputs.ts`)

55 mutants over the eleven files that reach it: 47 caught, 8 survived. No defect.

- Rows (`stale-hit.test.ts`): an input edited under `--skip-worktree` moves the key (the removal row passed without the `S` flag: the save's moved-input check refused the missing file, masking it); `core.fileMode` read false as `no`, `off` and `0` too; a non-UTF-8 name inside an embedded repository is refused. Each red under its mutant.
- Equivalent: OIDs for conflict stages (the path is dirty, so untrusted), a failed `check-attr` whose output is then parsed (empty), the attributes walk past the repository root and a status path outside the prefix (both only widen distrust), and a trusted file gone at restamp (dirty, so already dropped).
