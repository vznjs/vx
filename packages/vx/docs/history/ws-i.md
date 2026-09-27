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
