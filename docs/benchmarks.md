# Benchmarks

Empirical overhead numbers vs. Turborepo and Nx on a synthetic
workspace. Updated as the runners evolve.

## Reproducible head-to-head (vx vs Turborepo vs Nx)

`bench/compare.ts` scaffolds **one** shared monorepo (packages × layers,
a `build` + `test` task per package with the **identical** shell command
for every runner), then runs vx, Turbo, and Nx across three cache states.
Fairness is deliberate: vx runs as the **compiled binary** real users
install (not TS source); the workspace is git-committed with
`node_modules`/`.turbo`/`.nx` ignored; and **every runner is pinned to
the same max concurrency** so no tool is advantaged by a different default
(vx defaults to CPU cores, Turbo to 10, Nx to 3). The `build` task
`sleep`s 1 s to simulate real work, so a warm cache hit visibly skips it.

```bash
bun bench/compare.ts 60 10 1                 # 60 packages, 10 layers, sleep 1 s
CONCURRENCY=16 bun bench/compare.ts 60 10 1  # pin a different concurrency
BUILD_SLEEP=0 bun bench/compare.ts 1000 10   # 1000 pkgs, pure framework overhead
```

It writes [`bench/RESULTS.md`](https://github.com/vznjs/vx/blob/main/bench/RESULTS.md)
(committed, so the numbers can be referenced from a commit). A
representative run — 60 packages, 1 s builds, concurrency 10 for all:

| Runner | Fresh (cold)      | Warm (no restore) | Warm (restore)   |
| ------ | ----------------- | ----------------- | ---------------- |
| **vx** | **10.38 s**       | **121 ms**        | **135 ms**       |
| turbo  | 10.37 s (1.0× vx) | 116 ms (1.0× vx)  | 140 ms (1.0× vx) |
| nx     | 11.16 s (1.1× vx) | 750 ms (6.2× vx)  | 983 ms (7.3× vx) |

**Reading it honestly.** With equal concurrency and realistic per-task
work, **cold is a dead heat with Turbo** — cold time is dominated by your
actual build commands, which every runner pays equally — while vx beats
Nx. **Warm** runs (cache hits — the steady-state dev loop and CI, what you
do all day) are where the cache design shows: vx ties Turbo and is **6–7×
faster than Nx**, because a warm hit restores in milliseconds instead of
re-running the work. One caveat worth stating: out of the box vx caps
concurrency at CPU cores while Turbo uses 10, so on a many-core-light,
I/O-heavy workload you may want to pass `--concurrency` explicitly.

**`vx lock` + `--frozen`.** The benchmark also measures a `vx (frozen)`
variant: `vx lock` freezes the resolved task graph into `vx-lock.json`,
and `vx run --frozen` executes from it with **zero per-run config
evaluation**. Skipping the re-parse of every `vx.config.ts` makes warm
runs **~12–21% faster** (e.g. 339 ms → 298 ms at 300 packages), so frozen
warm edges out both live vx and Turbo. It's the recommended CI path —
deterministic and eval-free. Generate it in the benchmark automatically;
in your repo, run `vx lock` and commit `vx-lock.json`.

## Workspace shape

- **100 projects**, each with three tasks:
  - `build` — leaf
  - `test` — depends on the project's own `build`
  - `install` — group task that depends on `^build` (every workspace
    dep's `build`)
- Single run invokes all three across all 100 projects → **~300 task
  evaluations per run**.

## 2026-06 — dense-graph stress repo (1090 packages, 100 layers)

The regenerated comparison repo (1090 packages, 100 layers, 30 deps
per package, build+test+installDeps = 3270 graph nodes) exposed three
quadratic hot spots in sequence. Wall-clock for `vx run build test
--all`, fully cached:

| Stage                                                | No-restore | Restore    |
| ---------------------------------------------------- | ---------- | ---------- |
| Before (Set-closure scheduler priority)              | 10.2 s     | —          |
| + bitset scheduler closure                           | 1.27 s     | 1.59 s     |
| + discovery/partition/package-graph fixes            | 1.03 s     | 1.34 s     |
| + frontier `^task` expansion (v19, 8.5× fewer edges) | **0.62 s** | **0.87 s** |

Run-phase self-time at the end state: 262 ms / 520 ms. Remaining
floor: 1090 config imports (~120 ms), one bulk git spawn (~73 ms),
process boot. Next queued lever: git blob OIDs as file hashes
(Turbo's `ls-files -s` technique — zero reads/stats for clean files).

## 2026-06 — git blob OIDs as file hashes (v20)

Input-file hashes now come from git's index (`ls-files -s`) for clean
files; dirty/untracked files get byte-identical blob OIDs computed
in-process behind the mtime memo. The two git spawns run
concurrently. The win scales with file count:

| Fixture                       | v19 warm run-phase | v20                                    |
| ----------------------------- | ------------------ | -------------------------------------- |
| 1000 projects × 3 files (6k)  | ~393 ms            | ~426 ms (noise-level; degenerate case) |
| 500 projects × 30 files (15k) | ~245 ms            | **~76 ms (3.2×)**                      |

Cold first runs additionally never read committed file contents at
all. Real-world repos sit far closer to the 30-files-per-project
shape than the 3-file one.

## 2026-06 — warm paths, three-way on the comparison repo

100 projects x (build + test + installDeps), 300 task evaluations,
direct binaries (no pnpm exec wrapper), median-ish of repeated runs,
after the restore-path git-respawn fix:

| Runner | Warm, intact tree | Warm, outputs wiped (restore) |
| ------ | ----------------- | ----------------------------- |
| **vx** | **144 ms**        | **137 ms**                    |
| Turbo  | 279 ms            | 287 ms                        |
| Nx     | 583-934 ms        | 583 ms                        |

vx's restore now costs the same as an intact-tree run — the fix
eliminated the 81 per-project `git ls-files` re-spawns that made the
same scenario take 920 ms (8x the intact run). Nx numbers vary with
daemon state; Nx requires a pnpm-installed node_modules to parse
pnpm-lock.yaml (it hard-fails on a Bun-installed tree).

## 2026-05

| Runner | No cache    | Cache (no restore) | Cache (full restore) |
| ------ | ----------- | ------------------ | -------------------- |
| BASE¹  | 1:20.00     | —                  | —                    |
| **vx** | **1:22.95** | **137 ms**         | **159 ms**           |
| Turbo  | 1:31.38     | 569 ms             | 589 ms               |
| Nx     | 1:40.62     | 848 ms             | 858 ms               |

¹ `BASE` = running every task command directly via shell with no
runner. Establishes the irreducible floor; anything above it is
runner overhead.

### Read

| Path                                    | vx      | Turbo   | Nx      |
| --------------------------------------- | ------- | ------- | ------- |
| Overhead vs BASE, no cache              | +2.95s  | +11.38s | +20.62s |
| Per-task overhead, cache (no restore)   | 0.46 ms | 1.90 ms | 2.83 ms |
| Per-task overhead, cache (full restore) | 0.53 ms | 1.96 ms | 2.86 ms |
| Cache-restore cost (full − no-restore)  | 22 ms   | 20 ms   | 10 ms   |

vx is **~3.9× faster than Turbo** and **~5.4× faster than Nx** on the
all-hits restore path. The no-cache run lands within 4% of the BASE
floor — runner-side scheduling, discovery, hashing, and graph build
add ~3 s across 300 tasks.

## Why vx is fast here

The patterns we share with Turbo and Nx are documented in
[`patterns.md`](./patterns.md). The pieces that move the benchmark
numbers:

- **No daemon.** Cold start every run; nothing to reattach.
  Re-discovery on Bun lands in single-digit ms even at 100 projects.
- **xxHash3 everywhere.** Cache keys are 16 hex chars, derivation
  ~5× faster than the previous SHA-256 path (see CLAUDE.md decision
  log, 2026-05 `CACHE_VERSION → v15`).
- **`git ls-files` for input enumeration.** Same pattern Turbo and Nx
  use; cheaper than walking the tree and consulting nested
  `.gitignore` files in JS.
- **Stat-check restore skip.** When every declared output already
  matches the cached size/mode/mtime fingerprint (`output_files`
  rows), restore is N stats and zero writes — no decompress, no
  extraction (`src/cache/cache.ts:isOutputsCurrent`).
- **In-process tar parser.** No `tar` subprocess on the restore path
  (`src/cache/tar.ts`); saves the fork+exec per cache hit.
- **SQLite for metadata.** One open DB handle per run; lookups are a
  single indexed query (`src/cache/cache.ts`).
- **Bun-native I/O.** `Bun.write`, `Bun.file`, `bun:sqlite`,
  `Bun.hash.xxHash3`, `Bun.spawn` (with `resourceUsage()` for child
  cpu/RSS) — no FFI bridge, no JSON marshaling for the hot paths.

## Why vx is not even faster

Headroom we know about:

- **Group-task evaluation.** The `install` umbrella task fans out to
  100 `^build` edges; we re-resolve them per project. A pre-computed
  reverse index would shave a few ms.
- **Cache-key serialization.** `taskConfigHash` JSON-stringifies the
  resolved config per task. For projects sharing config (presets),
  we could memoize on the resolved-config object identity.
- **Path normalization.** `relPosix` is called in tight loops during
  input enumeration. A specialized fast-path for ASCII-only
  workspace-root prefixes would help.
- **Config evaluation (measured 2026-06, 1000 projects):**
  `loadProjectConfig` ×1000 = 199 ms of a 517 ms warm wall; discovery
  82 ms; package graph 1 ms. A resolved-config eval cache was designed
  (cache pure-literal configs on content hash) and **rejected by the
  owner**: soundness requires a static purity gate (no imports, no
  `process.env`, no dynamic tokens), and a correctness-critical
  heuristic is too much machinery for ~200 ms at 1000 projects.
  Configs are programs; their evaluation only re-runs, never caches.
  Don't re-propose without a sound, non-heuristic dependency story.

None of these would close the gap to BASE; the ~3 s no-cache
overhead is dominated by `vx.config.ts` evaluation (300 task configs
across 100 projects) + graph build + filesystem stat.

## Methodology

- Synthetic workspace generator (TODO: vendor under
  `bench/fixtures/`).
- Each runner installed at its current release; `vx` built from
  `main`.
- Three runs per condition; median reported.
- Cache cleared between runs for "No cache"; warmed once and
  invoked twice for "Cache (no restore)"; cache cleared from disk
  but kept in metadata for "Cache (full restore)".

If you re-run the benchmark and the numbers shift materially in
either direction, edit this file in the same PR that introduces the
regression / improvement so the log stays accurate.
