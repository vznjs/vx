# Workstream I (performance)

I-1. Roadmap 2.5, real repos re-measured through `turbo()` / `nx()`
(benchmarks.md § Real repos re-measured). vx leads every row on astro
and refine. Day-end A/B of main against item 960: a tie.

I-2. The harnesses time vx without the caller's `BUN_OPTIONS`
(`bench-env.ts`, used by `run.ts` and `compare.ts`; the two real-repo
scripts unset it). `--smol` from this box's shell: 1,000 packages warm,
median 351 ms against 334, A/A 336, 15 rounds. Refuted the same day:

- astro's output shortcut widened: `dist/**` outputs (the shortcut
  taken) 502 ms median against the shipped `dist/**/*` + `mod.js` 493,
  A/A 486. The `output glob` span overlaps other work.
- A member walk pruning `node_modules` for `packages/**/*` on astro:
  26–37 ms against `Bun.Glob`'s 35–38, same 522 members. Noise.
- astro's git enumeration (122 ms) is mostly `git status` itself
  (57–71 ms alone); a restore's extract is the item 193 floor.

I-3. `nx()` and `turbo()`'s per-run mapping cost split by stage (G
leads below): the map, not the read or the parse.

I-4. The cold path. Real repos: a cold run is its commands. astro's
cold `run graph` is 101.6 s of 105.8; vx's own saves and hashing sum
under 2 %, below the ±15 s spread between cold reps, so no vx lever
resolves there. The 3.5 s prelude that one cold run showed (startup
486 ms, workspace config 1,114, git 2,058) is the page cache after the
harness's `git clean`: with only `.vx` wiped it is ~350 ms. 1,000
synthetic packages (compiled, 11 interleaved cold reps, A/A beside):

- Saving is the lever: median 3,737 ms with local writes against 2,620
  with `--cache=local:r`, A/A 3,527 (9 reps). ~1.1 s, 30 %.
- Its SQLite share, bounded by skipping the index transaction: 3,526
  against 3,810, A/A 3,808. ≤280 ms. 11 statements per save
  (`sqlite-tally.ts`), none above noise alone.
- Refuted: scanning the packed raw tar instead of decoding the written
  zstd (3,923 against 3,947, A/A 4,009); one commit per event-loop turn
  with a savepoint per save (4,022 against 4,135, A/A 4,050) — at four
  workers a turn holds about one save.
- The rest (~800 ms) is per-save file I/O: +8 `openat`, +8
  `getdents64`, +6 `statx`, +2 `readlink`, one temp write and a rename
  per artifact (`strace-vx.ts`, save against no-save).

I-5. Re-bench of J-14, G-10 and A-6 (main 3e927f9c against 889a95c,
each arm's own vx-migrate, compiled, 15 interleaved rounds, A/A on a
third copy). astro (`turbo()`, filtered no-op, this box's git config):
763 → 715 ms median (min 723 → 646), A/A 719 (678). refine (`nx()`,
git defaults via `GIT_CONFIG_GLOBAL=/dev/null`): 375 → 396, A/A 410 —
no gain, and `load configs` rose 74 → 113 ms (stage mins, 7 runs; the
G lead below). Under this box's global git config
(`core.checkstat=minimal`, `core.trustctime=false`) refine read
365 → 448: A-6 rightly hashes every input there (`classify + probe`
51 → 121 ms).

I-6. The cold save, attributed. Process-tree CPU, 10 interleaved cold
runs at 1,000 packages: 11,485 ms with local writes against 8,615
without, ~2.9 ms per one-file save. By thread (`/proc` sampled): main
+1.2 s, Bun's pool +0.9 s, JIT +0.25 s. Main thread by function
(profile diff, save against `--cache=local:r`): SQLite 478 ms, of it
BEGIN/COMMIT 262; `Bun.Glob` `scanSync` in `resolveOutputs` 180;
`renameSync` inside the index transaction 164; `writeFile` 88;
`lstatSync` 79; `realpath` 53. Probed:

- Dependents not waiting for their upstream's save (`settledOf` off,
  saves drained before the run ends): 3,836 ms median against 4,026,
  A/A 3,868. Refuted.
- A commit window (saves within 4 ms share one transaction, a
  savepoint each): pass 1 3,825 against 3,969, A/A 3,988; pass 2
  (copies rotated) 4,075 against 4,287, A/A 4,029; CPU 11,309 against
  11,548 median, min a tie. At most ~200 ms, not resolved on this box.
  WAL writes fall only 18,959 → 16,467 `pwrite64`: ~16 pages a save
  stay, because each save's rows land on random leaves of several
  hash-keyed indexes.

I-7. Scale, CI and the day's A/B (main 4b7c396a, compiled, git defaults).

- Day A/B against item 960 (fa419f76), 1,000 packages warm, 15
  rounds: base 184 ms median (min 159), main 196 (166), A/A 186 (173).
  A tie.
- 5,000 packages warm, stage mins of 9 against 1,000: startup 5.6 /
  5.7, discover 72 / 13, package graph 31 / 6.4, load configs 73 / 15,
  git 39 / 8.4, classify + probe 164 / 42, run graph 130 / 35, record
  history 28 / 9.0; total ~566 / ~145 ms (3.9× for 5×). No stage is
  super-linear beyond noise. The profile's native top: the output proof
  (`outputDirsCurrent` lstat 37 ms, `isOutputsCurrent` stat 20),
  SQLite reads (entries, config closures and evals, ~33), history rows
  (20), `hashFiles` lstat (15), an artifact `existsSync` per hit (9,
  how a vanished artifact degrades to a miss). Each is a floor the
  design names; none is a lever alone.
- CI (run 36354970833): Linux `vx run ci` 3:30 and macOS core tests
  3:31 end within 6 s of each other, so cutting one job alone buys
  nothing. Local gate, same 53 tasks on 4 cores: 1,165 s of task time
  over 289 s of wall, so the run is work-bound; shard spread 40–100 s
  matters only at the tail. Every run is cold (52 of 53 miss): CI
  keeps no vx cache between runs (item 687). A push that leaves core
  untouched would skip the core shards (~800 s of work) with the cache
  restored — the owner's call, since the gate would then trust its own
  cache. The 1.6 min before jobs start on main is the concurrency
  group queueing behind the previous main run.
  I-8. Shard weights refreshed (`test-shard.ts --weigh`, 258 files, from
  a JUnit run of all 12 shards, four at a time, git defaults). The table
  dated from 2026-09-22. Fresh runs, four shards at a time, two each:
  the heaviest shard 54 and 57 s under the old table, 32 and 32 under the
  new; all 12 shards 95 and 95 s against 91 and 92 (the suite is
  work-bound, so the tail is what moves).

I-9. Restore and CI's cache, sized.

- refine restore (outputs wiped, 35 artifacts, 6,790 files), 12
  interleaved rounds: `--concurrency 3` 1,148 ms median, 6 1,057, A/A
  (3) 1,183. Not worker-bound; extraction is the item 193 floor. A
  warm restore's `run graph` is 376–510 ms of a 590–641 ms run.
- CI keeping vx's cache (the owner's call, I-7): 131 of main's 321
  commits on 2026-09-27 (41 %) touched no core source (`src/`,
  `index.ts`, `tsconfig.json`), so a restored cache would have skipped
  the core shards on each.

I-10. A-11 re-benched on astro. Filtered no-op, 15 interleaved rounds,
same plugin in every arm: 3e927f9c 449 ms median (min 382), 4b7c396a
263 (227), A/A 260 (226). Full table on 4b7c396a (benchmarks.md):
vx 48.0 s / 478 ms / 249 ms (cold / restore / no-op) against Turbo
57.9 s / 1.43 s / 1.38 s.

I-11. refine's full table on 4b7c396a (benchmarks.md), three
interleaved reps: vx 96.2 s / 1.06 s / 303 ms (cold / restore / no-op)
against Nx 105.9 s / 1.19 s / 1.16 s. CI's runner queue, 119 CI runs
22:37–23:30: the macOS job waits 105 s median before I-8 and 426 after
(max 1,010), runs 253 s either way; Linux jobs wait 2–18 s. So macOS
job-minutes set the queue. A CI cache hits the core shards on 4 of
369 of the day's commits, 52 with `docs/history/**` out of their key
(nothing reads it): not worth a cache step on every macOS job. Refuted on the runner:
twice the cores (`--concurrency 200%`, #1331). Here the 12 shards on 3
pinned cores keep 1.7 busy, and 6 at a time cut 112.3 → 74.2 s; on
macOS CI 6 workers took 189.38 s against 189.37 at 3, each task twice
as long. That runner is CPU-bound; this container's idle cores were
the container's. 6 shards instead of 12: 114.5 s against 113.3, a tie.

I-12. The unsafe suite starts first on a fresh runner (`assume` 46 s
in `vx.workspace.ts`). On macOS CI it is core's longest task (46 s,
shards 31–45) and the structural order started it last, alone for its
final 33 s on 3 workers. macOS wall against the work over 3 workers
(runner speeds differ): 189.37 s for 166 s of work, 88 % packed,
before; 174.13 s for 162 (93 %) and 234.09 s for 216 (92 %) after,
the unsafe suite starting first in both (jobs 108730471028,
108740256876, 108742538229).

I-13. Linux CI's tail, the same way: `@vzn/vx-reapi#test` (38 s)
started at 170 s of a 208 s `vx run ci` and ended it 22 s after the
last shard; 773 s of work over 4 workers is 193 s (job 108742538414).
`assume` now names it and `@vzn/vx-migrate#test` (27 s). After (job
108744590486): 183.09 s for 706 s of work, 97 % packed; the last shard
ends the run.

I-14. The queue after I-12 and I-13, 118 CI runs 00:00–01:00 on
2026-09-28: macOS waits 7:50 median (max 22:32) in the first half
hour and 3:46 in the second, runs 4:06; Linux waits 0:02. About 55
macOS jobs an hour at ~4 min: the queue is job count, not job
length. 15 s off a job frees ~6 %.

I-15. The queue an hour on, 113 CI runs 01:00–02:00 on 2026-09-28:
macOS waits 2:40 median (max 7:19) against 6:41 (22:32) the hour
before, for 64 macOS jobs against 55. The darwin step moved only 3:46
→ 3:40, so the drop is runner supply, not I-12. Day A/B, 1,000
packages warm, 15 rounds, compiled: 4b7c396a 203.9 ms median (min
183.6), main 396a3045 200.6 (181.0), A/A 196.9 (177.5), a tie.

I-17. `packages/vx-bench/ab.ts`: the interleaved A/B every number here
uses, committed (it lived in scratch and was lost once). refine's
warm no-op, main 4bd7e2e5 against 4b7c396a, 15 rounds, each arm its
own `vx-migrate`: 416.2 ms median (min 295.0) against 402.4 (315.4),
A/A 416.9 (318.7), a tie; 749af7ad's fewer `nx()` twins do not show
at this spread. Item 1075's whole-repo `git status` (G lead) is still
on main.

I-18. `ab.ts` reports a failed run's stdout, where vx names the failed
task: stderr alone showed astro's failure as nothing. astro's warm
no-op is not re-measurable on this box now: main moves `astro#build`'s
key, the copy rebuilds, and its `pnpm install` (and the pinned pnpm's
self-install) cannot reach the registry from a task, whose environment
carries no proxy.

I-20. A warm hit's tree check does less JS. The whole-subtree output
prefixes are memoised by the declared list, and a hit whose directory
snapshot proved the set skips mapping each row to a path and back.
1,000 packages warm, compiled, 25 interleaved rounds, `run graph`
stage: main 85.4 ms median (min 68.2), patch 69.0 (49.3), A/A 65.8
(55.0). Wall, 61 rounds: main 411.6 ms median (min 327.1), patch
384.5 (321.3), A/A 398.7 (330.1).
I-19. A `--frozen` run keeps the lock's validation verdict. Every
warm `--frozen` run re-validated every locked config (1,000 projects:
~30 ms of `load configs`, half of it the JSON-data walk). The verdict
now sits beside the config evaluations, keyed by the lock's bytes, the
project, vx's and Bun's versions. 1,000 packages warm, compiled, 41
interleaved rounds: main 401.2 ms median (min 337.2), patch 377.9
(309.2), A/A 373.2 (321.0); `load configs` 41.1 → 14.4 ms (min of 7).

I-24. A config load without the closure builds no package graph. The
CLI's selection pass, `vx info` and the reader's view each built one for
`loadProjects`, which reads it only for the closure they never ask for;
`packageGraph` is now required only with `closure: true`. 1,000
packages, one edited, `run build --affected=HEAD~1`, compiled, 41
interleaved rounds: main 359.0 ms median (min 309.1), patch 350.3
(307.5), A/A 349.5 (296.4).
I-22. An output glob whose static directory is absent is not scanned.
A restore into a tree without its outputs scans each output glob twice
(the check, then the clean), and `Bun.Glob.scanSync` of a missing
`dist` cost ~58 µs a call; one lstat now answers. 1,000 packages, every
`dist` removed before each rep, compiled, 21 interleaved rounds: `run
graph` main 924.7 ms median (min 684.1), patch 864.0 (659.7), A/A 850.6
(677.7); in-process total 1,243.3 (937.7), 1,190.3 (961.8), 1,195.8
(958.3).

I-23. An `--affected --frozen` selection reads the lock once. Its
workspace-glob owners parsed the whole lock only to learn it exists,
which the staged load that follows had already proved (it refuses a
frozen load without one); the check now runs only where that load
failed. Row: `read-once.unsafe.test.ts` counts two opens of
`vx-lock.json` (three before). 1,000 packages, one edited, `run build
--affected=HEAD~1`, compiled, 41 interleaved rounds: main 387.1 ms
median (min 320.5), patch 368.6 (314.4), A/A 368.0 (310.6). The same
run reads the lock in the selection and again in the run, builds the
package graph three times and loads `config-eval.ts` (~30 ms of module
load); those are the next candidates.
I-21. A restore's row reads stop committing. `loadOutputFilesBatch`
flushed the pending output stamps and directory snapshots before every
read, and a restore reads its rows twice, so a 1,000-restore run
committed ~1,000 small transactions the close would have batched (the
profile: ~250 ms of main thread in the flush and the reads). The read now
overlays the pending stamps; a re-save drops the stamps of the rows it
replaces. 1,000 packages, every `dist` removed before each rep,
compiled, 21 interleaved rounds: `run graph` main 962.6 ms median (min
777.4), patch 935.5 (654.0), A/A 949.2 (716.9); in-process total 1,289.0
(1,074.6), 1,247.3 (936.6), 1,235.8 (1,003.9). The second read (inside
`restoreOutputs`) stays: the rows in hand would cross the `CacheLayer`
seam.

I-26. An `--affected` run walks the worktree once. The selection
spawned `git ls-files --others` for its untracked files, and the run then
walked the tree again with `git status -uall`. The discovery's lazy
enumeration is now registered for every discovery (not only with a
`discover` hook); a `[since]` filter starts it, the diff reads its
`untracked` (`GitEnumeration.untracked`, status's `??` set, which equals
`ls-files --others --exclude-standard`'s: a row compares them with an
ignored dir, a deep dir and a nested repo), and the run reuses it with
the discovery. Rows: the equivalence, and a logging git counting one
`status` and no `ls-files --others` for an `--affected` run (red on
main). 1,000 packages, one edited, `run build --affected=HEAD~1`,
compiled, 41 interleaved rounds: main 356.8 ms median (min 293.5),
patch 311.9 (248.5), A/A 313.6 (255.5).

I-31. A key names its input files by slicing the root off. `relFor`
memoised `relPosix` per absolute path, and a Map lookup hashes the whole
path per file per task; every input file is a normalized absolute path
(`resolveInputs`), so under a normalized root its relative name is a
slice, and the memo stays for anything else. Bench as I-30 (900 warm
hits, 12,905 files), compiled, 21 interleaved rounds: `classify + probe`
main 256.9 ms median (min 217.2), patch 241.8 (194.0), A/A 238.9
(193.8); in-process total 600.1 (515.1), 551.6 (490.8), 550.6 (455.2).

## Leads for other streams

- **Owner / coordinator: skip macOS where it cannot differ from
  Linux (I-14).** 135 of 436 commits since 2026-09-27 touch nothing the
  macOS job can see differently: not core's `src/`, `tests/`,
  `scripts/` or manifests, not `vx-schedule-history` or the
  playground (the macOS job runs them), not `ci.yml`, the runner
  action, `bun.lock`, the root manifests or `README.md`. The rest is
  docs, stream history, other plugins and the site, which only text
  laws read, and Linux runs those. That is ~31 % of macOS jobs.
  `--affected` cannot decide it: nearly every PR writes
  `packages/vx/docs/history/`, which makes `@vzn/vx` affected. It
  needs a path rule (a `dorny/paths-filter`-style job output or a
  workflow `paths-ignore` on a split job), and that decides what gates
  a merge.

- **G: `nx()` costs ~100 ms per warm run on refine.** No-op, 15
  interleaved rounds: `nx()` median 396 ms (min 364), A/A copy 393
  (350), same repo with written configs 291 (272). The plugin parses
  and maps all 206 projects of the 468 KB snapshot every run when the
  run asks for 35; self time in `nx-map`, `nx-dotenv`, `nx-upstream`,
  `nx-outputs`, `shared-outputs` ~57 ms. Lever: map only the projects
  the run loads, or cache the mapping keyed on the snapshot's mtime.
  Split (I-3), `parseNxGraph` + `mapNxWorkspace` called on refine's
  snapshot, 6 calls: read 0.6–2.9 ms, parse 1.3–1.6, map 35–66 (the
  first, cold call is what a CLI run pays). The map is the cost.
- **G: `turbo()` has the same shape (I-3).** `mapTurboWorkspace` on
  astro, 6 calls: 43 ms cold, 24–26 warm, for all 553 members when the
  run needs 32. A wall control against written configs failed: the
  written `vx.config.mjs` files fall inside astro's `**/*` inputs, the
  keys moved, and a copied pnpm repo cannot rebuild here (it
  reinstalls, and the registry is out of reach).
- **A: nested-project boundaries matched as one glob each; 38 % of
  astro's warm run.** `resolveFiles` and `scanUnion` test every file
  against one `<nested>/**` glob per nested project: O(files × nested),
  4,003 files × 330 fixture projects under `packages/astro`, 320 ms of
  native `match` (cpuprofile). Patch: an ancestor-directory `Set`
  lookup, O(depth); `a/b/**` does not match `a/b`, nor does the lookup.
  It also stops reading `{`, `*`, `?` in a nested dir's name as glob
  syntax. astro no-op, compiled, 15 interleaved rounds: main median
  834 ms (min 779), patch 521 (462), A/A 803 (748); every run exit 0,
  keys unchanged (all hits on the patched binary). `stable keys` span
  388 → 53 ms. With no nested project (1,000 synthetic packages) it
  is neutral: main 314, patch 306, A/A 305 median. Patch (vs f9512c8a), needs a row pinning the nested
  exclusion both ways:

  ```ts
  // cache/inputs.ts — replace the boundary globs in resolveFiles and
  // resolveOutputs/scanUnion with this test, called before excludeGlobs
  function nestedPrefixTest(projectDir: string, nestedDirs: string[]): (rel: string) => boolean {
    if (nestedDirs.length === 0) return () => false
    const dirs = new Set(boundaryIgnorePatterns(projectDir, nestedDirs).map((g) => g.slice(0, -3)))
    return (rel) => {
      for (let i = rel.indexOf('/'); i !== -1; i = rel.indexOf('/', i + 1)) {
        if (dirs.has(rel.slice(0, i))) return true
      }
      return false
    }
  }
  ```

- **E/C: `--filter` discovers the workspace twice.** `resolveFilters`
  runs `listProjects`, then `prepareRun` runs it again. Patch (vs
  f9512c8a, 12 lines): `FilterResolution` carries
  `discovered: { root, projects }`, `cli/run.ts` passes it as
  `RunOptions.discovered`, and `prepareRun` takes its projects
  instead of calling `listProjects` when its root is the run's. One
  run only, as `staged` is. Compiled, 15 interleaved rounds: 1,000
  synthetic packages `--filter '*'` main median 369 ms (min 341),
  patch 351 (305), A/A 375 (336); astro's filtered no-op main 819
  (752), patch 733 (682), A/A 774 (755); every run exit 0.
- **A: a cold save writes ~16 SQLite pages (I-6).** The lever is rows
  and indexes per save (4 `entry_inputs` rows, an `output_files`
  SELECT + UPDATE for the inode stamp, `output_dirs`), not commit
  count. Second: `renameSync` inside the transaction (164 ms of main
  thread per 1,000 saves) and the sync `scanSync` in `resolveOutputs`
  (180 ms) could move to the pool.
- **G: nx()'s graph key (item 1075) spawns a whole-repo `git status
-uall` every run.** refine, 11,521 tracked files: 80–99 ms alone.
  Bound (the key returning null, mtime fallback), 15 rounds with git
  defaults: main 417 ms median, bound 321, A/A 399. Reuse core's
  enumeration or scope the status to the project roots.
- **B: `sandbox-runtime.unsafe.test.ts:4514` races an exiting pid
  (I-9).** "a traced sandboxed one-shot task's children die with vx that
  is descheduled after the spawn" failed once in a local gate at
  029aa62d: a pid passed `isAlive`, then exited before
  `readFileSync(/proc/<pid>/stat)`, which threw ENOENT. Reading the stat
  should count a vanished pid as dead.
- **B: "runSandboxed, driven directly › a SIGKILLed task's port bridge
  leaves no socket behind" fails on CI** (`sandbox-runtime.unsafe`):
  #1301's run on 2026-09-27 and main at 69923eca (run 36367605356,
  2026-09-28 01:52). Linux job, 1,246 ms.
- **F: `wedged.test.ts` › "RST_STREAM(INTERNAL_ERROR) reads as INTERNAL
  and is retried" failed once in a local gate (I-3): `sent` 3 where 4
  is expected, 2,199 ms, on c2f0fa79; green on the next gate at
  233e6e59. The retry count reads as time-bounded under load. Not
  root-caused.
- **B: `output-dirs.test.ts` › "does not descend a symlinked
  directory, … nothing over the cap" times out in its `afterEach`
  under a full local gate (I-19)**: twice, 9.9 and 14.8 s, the removal
  of `OUTPUT_DIRS_CAP + 1` directories inside the sandbox; green in
  shard-9 run alone on main and on the patch.
