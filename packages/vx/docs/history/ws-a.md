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
3. A save renames the artifact into place before its rows commit: a commit
   that fails (`SQLITE_BUSY` past the busy timeout, `SQLITE_FULL`) leaves
   one save's bytes beside another's rows, and every later hit on the key
   fails the task as a corrupt artifact until a prune.
4. The run-end directory snapshot vouches for a stray a dependant wrote
   into an output directory after the save or restore; later hits skip the
   walk and the stray survives under a green run.
5. A zstd artifact of several frames passes the first-frame size check and
   is decoded whole before the ceiling applies (2 GiB of memory from a
   32 KB remote body); the comment calls that check unreachable.
6. An output of mode 000 or mtime 0 (`SOURCE_DATE_EPOCH=0`) restores with
   the wrong metadata and is restored again on every hit; one with an
   mtime before 1970 is never cached ("corrupt artifact").
7. A `cache.db` corrupt past its first pages fails every task as an
   internal error, and `vx cache prune` prints a stack.
8. `cacheRetention` never runs under a local-read-only policy while
   remote hits are still ingested locally.
9. A gitignored `.gitattributes` below a project escapes the clean-filter
   gate: the LF index blob of a CRLF file is trusted.
10. `core.trustctime=false` / `core.checkStat=minimal` weaken `git status`,
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

## Record

A-1. DONE (2026-09-27, lead 1). A nested repository inside a project is
one entry of git's listing (a mode-160000 gitlink, or `dir/` when
untracked) and none of its files, and a directory is no input: a
task reading `vendor/lib/x.txt` under `**` folded nothing of it, and
after an edit there the next run was `1 up-to-date` with the old
output while `git status` named the path. - Fix (`git-inputs.ts`): `expandNestedRepos` replaces each such entry
with what its own `git ls-files` lists, recursively, in the
workspace-wide enumeration and in `runGitLsFiles`; the files carry
no index OID and hash by content. A submodule never initialised (no
`.git`) folds nothing. `workspaceFiles` globs now reach into a
nested repository too. `caching.md`, `modules/git-inputs.md` and
`modules/inputs.md` say so. - Rows: `nested-repo-inputs.test.ts` › a nested repository inside a
project (the listing, scoped and workspace-wide, and the per-project
spawn) and › an edit inside it is a miss (gitlink and untracked).
Red without the fix.

A-2. DONE (2026-09-27, lead 2). A file system that keeps whole seconds
(ext3, HFS+, FAT/exFAT, some NFS) stamps a write at 12:00:00.900 as
12:00:00, and the racy windows were 50 ms: a file written and hashed
120 ms apart was memoised, and a same-size rewrite later in that
second kept every field the memo keys on. On an ext2 mount the next
run was `up-to-date` with `src=BBBB dist=AAAA`. The pre-save
re-check and the output-directory snapshot shared the assumption. - Fix (`layer.ts` `racyWindowMs`, used by `file-hashes.ts`,
`output-index.ts`, `task-hash.ts`): a stamp with no sub-second part
widens its window by a second. Off the warm path (a memo write, a
miss's re-check, the run-end snapshot). `caching.md`,
`modules/cache.md`, `modules/task-hash.md` say so. - Rows: `whole-second-stamps.test.ts` (simulated stamps: `spyOn` of
`lstatSync`, `setSystemTime`, `utimes`): the memo, the batch, the
re-check against its fact and against the command's start, the
directory snapshot, each with a sub-second control. Red without the
fix. - Lead for C: `fingerprint-watch.ts` judges the lockfile's ctime
against the same 50 ms window.
