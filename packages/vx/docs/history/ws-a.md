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
- D: under a low `ulimit -n` (20 on a 20-project fixture) discovery reads
  `EMFILE` as an empty workspace: `No projects declare task(s): build. No
package matched the workspace's package globs`. Found while reproducing
  A-41; not traced.
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

### A-34 (2026-09-28, sweep: core `cache.ts`)

49 mutants over the 26 files that reach it: 36 caught, 13 survived. No defect.

- Rows: `cache-get-many.test.ts`: `getMany` past a 900-hash chunk; `has()` with its artifact gone; a write-disabled cache saves nothing. `cache.test.ts`: a size prune passes over an older row whose artifact is gone. `remote-artifact-names.test.ts`: an undeclared project output and an undeclared workspace output are each refused alone (the mixed row masked either half). Each red under its mutant.
- Equivalent: the row mode's `& 0o777` (the sidecar already holds permission bits only).
- Held as non-root, so not a survivor: a restore's `EACCES` (`cache.test.ts` skips it as root; driven as `probe` it is red under its mutant, A-37). Held by A-37: eviction on a read-only cache, the prune retry and the access flush on `SQLITE_FULL`. A foreign artifact's bare `outputs/` directory entry is not a gap (corrected A-38): `scanArtifact` skips every non-regular entry and the tar reader strips a regular entry's trailing slash, so no entry reaches the row code as `outputs/`; C29/C30 are equivalent.

### A-35 (2026-09-28, sweep: `upstream.ts`)

19 mutants over the eleven files that reach it: 17 caught, 2 survived. No defect.

- Row (`upstream.test.ts`): `^*` alone takes the dep-workspace upstreams and leaves the same-project one; every row that used it also held `*`. Red under its mutant.
- `excluded-keys.ts` and `keyed-projects.ts` swept too: 17 mutants, 13 caught. Row (`taint-tracker.test.ts`): a cached persistent task building on a skipped key is not counted as unsaved (it saves nothing). Red under its mutant.
- Equivalent: the member order of a group's expansion (the key sorts its graft by hash, and the other caller asks only whether any member is unkeyed); a group's fold filter and excluded-key seed (a group has no filter, so every member folds); the keyed-projects memo (a repeated walk, same answer).

### A-37 (2026-09-28, left by A-34)

A-34 logged four `cache.ts` survivors as out of reach on this box. One was held all along: the restore `EACCES` row skips as root, and run as `probe` it is red under its mutant (the sweep method's rule for a root-run sweep).

- Rows: `cache-disk-full.test.ts`: prune retries its row delete once on a full index (the row there freed the space before the delete, so the retry never ran); the access-time flush gives way to a full index through `stats()`. `cache-retention.test.ts`: a cache this user cannot write evicts nothing (non-root; driven as `probe`). Each red under its mutant.

### A-36 (2026-09-28, sweep: `execute-task.ts`)

39 mutants over the twelve files that reach it: 27 caught, 12 survived. No defect.

- Rows (`execute-task.test.ts` › "execute-task edges"): no save over a folded upstream marked unkeyed (with a keyed control); a command that rewrites its own input comes out unkeyed and unsaved, and the run forgets its project, or every partition with workspace outputs; a rewritten lockfile marks the outcome unkeyed; forwarded args reach the requested task only; a step's own timeout and retries win over the run's; retrying stops at the first success; a run that writes no cache leaves workspace outputs alone; an executor that exits non-zero on the timeout reads as timed out; a restore failing for any reason but a vanished artifact is not retried as a miss. Each red under its mutant.
- A masking pair: the save's key check and the unsaved branch after it both forget the project, so neither half was held. The rows run with `noDependants`, where the check is the only forget.

### A-38 — an even-second stamp widens the racy window by two (2026-09-28)

FAT32 keeps even seconds. A file stamped 12:00:00, hashed at 12:00:01.2, passed A-2's one-second widening and was memoised; a same-size rewrite at 12:00:01.8 kept every stat field, so the memo served the first bytes' digest. `racyWindowMs` now adds 2 s to a stamp on an even second. Cost: an ext3 file on an even second is re-hashed for one more second.

- Row (`whole-second-stamps.test.ts`): single and batched hash, red without the fix; control on an odd second at the same age stays memoised. No FAT mount here (no `vfat` in the kernel), so the stamp is simulated as A-2's rows do.
- Refuted lead: a warm-run CPU profile at 1,000 projects put 41 ms of native `get` under `getConfigEval`. A counter showed all 1,000 configs took the batched fast key and none the single-key path; the attribution was the profile's, not a cost.

### A-39 — out of file descriptors is named, not a corrupt artifact (2026-09-28)

Lead from E. Under a full fd table a restore threw `CorruptArtifactError` (the artifact was fine) and a save threw the bare `EMFILE` naming an output. Both now throw a `UserError` with `OUT_OF_FDS_HINT`. The scheduler side (`isFsRefusal` only) is C's.

- Rows (`cache-out-of-fds.test.ts`): a child under `ulimit -n 128` holds every descriptor, then saves or restores; exact messages, each red without the fix.

### A-40 — an unreadable artifact names the cache, not the outputs (2026-09-28)

A restore refused on the artifact itself (`EACCES` on `<hash>.tar.zst`) said "could not write its outputs" and told the reader to make the output paths writable. The refusal's path is the artifact, so it now names the cache directory and `cacheDir` / `--cache-dir`.

- Row (`cache.test.ts`, skipAsRoot, driven as `probe`): exact message, red without the fix.

### A-41 — a spawn that fails for want of descriptors names the limit (2026-09-28)

Lead from C. Under `ulimit -n 30`, 16 of 20 `echo hi` tasks failed to spawn (`EMFILE`, `socketpair`), exited 127, and `execute-task` added the shell's "command not found … install it" line under each. `RunResult.spawnFailed` now marks a spawn that threw (runner and sandbox), the verdict skips it, and `spawnFailureText` names `OUT_OF_FDS_HINT` for `EMFILE`/`ENFILE`.

- Row (`execute-task.test.ts` › "execute-task edges"): `Bun.spawn` throwing `EMFILE`; exact stderr, red without either half; control: a word the shell did not find keeps its line. `sandbox-runtime.unsafe.test.ts`'s spawn row asserts the flag, red without it. `spawnFailed?: true` is additive on the plugin API's `RunResult` (`tests/contract/package-api.txt` regenerated; 0.x).

### A-42 — A-38's row holds the even-second rule it names (2026-09-28)

A-38's row stamped a multiple of four seconds and hashed 1.2 s in, so a rule of `% 4000` and a widening down to 1.15 s both passed it. The row now stamps an even second that is not a multiple of four and hashes at 1.99 s; `% 4000`, `+ 1900` and a dropped rule are each red.

- Sweep of A-39/A-40's refusal branches (`cache.ts`): four mutants, four caught — the artifact-read gate's `err.path === src` (the "cannot write" row, driven as `probe`) and its `isFsRefusal` (the fd row), the save wrapper's rethrow (`artifact-ceiling.test.ts`), the EMFILE branches (A-39's rows). A `probe` run needs a `TMPDIR` outside `/tmp/claude-0` (mode 0700).

### A-43 — a root-anchored addition is stamped, not cleaned (2026-09-28)

Lead from C. An additive task (item 588) stamped its project outputs before a run and saved what it added, but still cleaned its `workspaceFiles` by glob: with `build` and `individual` both on `gen`, `individual`'s miss deleted `build`'s `gen/a.txt` before reading it, and failed (reproduced with two projects). Its workspace outputs are now stamped (`stampWorkspaceOutputs`) and its entry holds what it added (`ownWorkspaceOutputsSince`, `ownWsOutputFiles`); the hit path already cleaned its workspace rows by row.

- Row (`overlapping-outputs.test.ts` › "same tree at the workspace root"): the dependant succeeds and its entry holds only `gen/b.txt`; red without the stamp (it fails) and without the own set (the entry holds `gen/a.txt` too).

### A-44 — negated output globs (2026-09-28)

Supervisor, from N's lit dogfood (#1603): core refused `!` in `cache.outputs`, so 12 of lit's wireit tasks ran uncached (dropping the `!` would clean a tracked fixture). A `!` entry now takes a path back: the resolvers (`resolveOutputs`, `resolveWorkspaceOutputs`) leave it out of the clean, the save, the stamp and the restore's walk; the input resolvers exclude a task's own outputs through `outputMatcher`, so a taken-back path stays an input; the remote-ingest name check, `vx watch`'s output filter and the task graph's overlap refusal and addition marks read positive globs or the matcher, never a `!` glob as-is (`Bun.Glob('!x')` is true of every other path). The schema refuses a list of only `!` entries, `!!x` and `!/x`. The key sees the entries through the resolved config. A task with a `!` keeps the walk on a warm hit (the directory short-circuit wants whole subtrees; not measured, so not widened).

- Rows (`negated-outputs.test.ts`): a miss leaves the taken-back files and keeps them out of the entry; a hit restores the rest and leaves them; an edit to one runs the task again; the addition shape keeps a dependant's scratch out of its entry; the workspace twin; a remote artifact carrying one is refused; `vx watch` sees an edit to one; two disjoint tasks with `!` entries both run; a narrower dependant's `!` is no addition of its upstream. Nine mutants (each resolver's `!`, each own-output matcher, the ingest check, the watch filter, the graph's two reads, the matcher's negative half), nine caught. `stable-keys`, `download-policy` and `local-shortcircuit` read a `!` entry's literal prefix (`!gen`), which names no directory: equivalent, left as they were.
- `watch-filter.ts` is E's file; the change there is the one line that keeps a `!` glob from hiding every edit.
- Probes with no defect (2026-09-28): a config reading `process.env` at load re-evaluates per value; a SIGKILLed restore's `.vx-tmp-*` stays out of every artifact; A-43's `additive` gate is held by three `stale-hit` rows.
- Refuted lead (C): "a persistent upstream folds nothing into a dependant's key" — a cached e2e behind a dev server hit on its second run and re-ran after the server's source changed; `caching.md` is right. N's flaky `execute-task` row was fixed by cb71c40.
- Lead for C and E: the failed-task output tail needs `RunRecord` to carry it before `run-history.ts` can store it; a column nothing writes is dead code, so C's half lands first or one stream takes all three with the coordinator's leave.

### A-45 — the cold-snapshot row orders its keep-alive after the build (2026-09-28)

Lead from C: `output-dirs-snapshot.test.ts` › "a cold build records its output directories by run end…" read no directory rows once in a loaded gate. Its keep-alive (`b`, `sleep 0.15`) ran beside `a`; a late `a` ended the run inside the racy window and the run-end snapshot was refused. A delayed `a` (`sleep 0.3 &&`) reproduces it; `b` now depends on `a`, and the row passes with the delay. Not reproduced by CPU load alone (15 runs at 2× cores).

### A-46 — a task with a `!` output keeps the warm hit's directory snapshot (2026-09-28)

A-44 left a task with a `!` output entry on the per-hit walk (`wholeSubtreePrefixes` refuses a `!` glob), unmeasured. Measured on 300 projects, warm no-op, `['dist/**', '!dist/keep.txt']`, main against the patch on two pre-warmed copies, 8 interleaved rounds: min 227 → 192 ms, median ~267 → 226 ms. `hit-restore` now takes the prefixes from the positive globs; the snapshot stays sound, since a file added or removed under a `!` path still bumps a recorded directory and the walk that follows applies the `!`.

- Row (`negated-outputs.test.ts` › "keeps the warm hit's directory snapshot…"): an aged hit records `dist` and `dist/sub`, red without the change; a stray still forces the restore and the `!` file is kept. The run-end snapshot of a cold miss (`miss-save`) keeps the old prefixes: the first aged hit records them either way, and no row would hold it.
