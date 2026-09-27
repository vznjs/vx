# Workstream I (performance)

I-1. Roadmap 2.5, real repos re-measured through `turbo()` / `nx()`
(benchmarks.md § Real repos re-measured). vx leads every row on astro
and refine. Day-end A/B of main against item 960: a tie.

## Leads for other streams

- **G: `nx()` costs ~100 ms per warm run on refine.** No-op, 15
  interleaved rounds: `nx()` median 396 ms (min 364), A/A copy 393
  (350), same repo with written configs 291 (272). The plugin parses
  and maps all 206 projects of the 468 KB snapshot every run when the
  run asks for 35; self time in `nx-map`, `nx-dotenv`, `nx-upstream`,
  `nx-outputs`, `shared-outputs` ~57 ms. Lever: map only the projects
  the run loads, or cache the mapping keyed on the snapshot's mtime.
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
  388 → 53 ms. Patch (vs f9512c8a), needs a row pinning the nested
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
  runs `loadWorkspaceProjects` and `buildPackageGraph`, then
  `prepareRun` discovers again. `startup` stage, 9 runs: 1,000
  synthetic packages `--filter '*'` 42.5–67.8 ms against `--all`
  7.5–11.9; astro (553 members) 66–91 against 7–11. Lever: hand the
  filter pass's projects to the run as `staged` already is.
