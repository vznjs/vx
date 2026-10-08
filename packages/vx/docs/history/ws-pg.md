# Workstream PG — per-PR perf guard (2026-10-08)

- **PG-1.** Nothing held vx's hot paths on a PR: the benches are manual
  and too slow and noisy for CI. `@vzn/vx-bench#check.perf` (in its
  `ci`) runs `perf-guard.ts`: a 25- and a 100-package synthetic
  workspace through cold, up-to-date, restore, plan and one-edit
  phases. Counts (spawns, xxh3 calls, blob-hash updates, SQLite
  statements) must equal `perf-baseline.json` exactly; times at 100
  packages, normalized by a calibration loop, fail past 1.5× after
  three attempts. Proven: counts identical over 8 runs, 8 concurrent
  runs and in and out of `vx run`; a doubled xxh3 call fails 10 count
  rows; a ~30 µs CPU cost per hash fails every timed row (2.2–4.2×).
