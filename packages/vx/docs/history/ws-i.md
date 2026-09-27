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
- **F: `wedged.test.ts` › "RST_STREAM(INTERNAL_ERROR) reads as INTERNAL
  and is retried" failed once in a local gate (I-3): `sent` 3 where 4
  is expected, 2,199 ms, on c2f0fa79; green on the next gate at
  233e6e59. The retry count reads as time-bounded under load. Not
  root-caused.
