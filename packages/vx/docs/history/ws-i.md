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

## Leads for other streams

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
- **F: `wedged.test.ts` › "RST_STREAM(INTERNAL_ERROR) reads as INTERNAL
  and is retried" failed once in a local gate (I-3): `sent` 3 where 4
  is expected, 2,199 ms, on c2f0fa79; green on the next gate at
  233e6e59. The retry count reads as time-bounded under load. Not
  root-caused.
