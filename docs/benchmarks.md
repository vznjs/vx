# Benchmarks

Empirical overhead numbers vs. Turborepo and Nx on synthetic workspaces.
Updated as the runners evolve.

## Warm-run overhead (2026-09-02)

The number that matters most to a developer is the warm no-op run: every
task a cache hit, nothing to restore. `bench/generate.ts` workspaces,
`vx run build --all`, this machine (macOS arm64, Bun 1.4.0), best of 5:

| Projects | Before (2026-09-02 morning) | Wave 1 | Wave 2 | Wave 5 | What changed                                                                    |
| -------- | --------------------------- | ------ | ------ | ------ | ------------------------------------------------------------------------------- |
| 100      | 105 ms                      | 92 ms  | 79 ms  | 78 ms  | git overlaps config load; `.git/HEAD` read replaces a git spawn; batched probe  |
| 1000     | 380–450 ms                  | 270 ms | 242 ms | 237 ms | + cached pure-config evals; one worktree walk; readdir discovery; batched probe |

Wave 3 (batched short-circuit probe, output rows carried on the entry,
memoised `Bun.Glob`s) measured on the graph WITH dependencies —
`vx run test --all`, 2000 tasks, interleaved arms against an immutable
worktree of the previous commit: 327–329 ms → 308–314 ms.

Where the remaining 242 ms at 1000 projects goes (`VX_TIMING=1`, see
below): discovery 22 ms, config load 31 ms (all cache hits) overlapped
with git's one worktree walk (`status -uall`, ~57 ms, the critical
path), the run-graph phase 78 ms (1000 hits: probe, output glob, stat
check), history recording 12 ms, cache open 9 ms, and ~50 ms of process
start + module load + exit outside the table. The 1.7 s cold run is the
1000 `cp` commands.

Reproduce: `bun bench/run.ts 1000 5`.

### Profiling a run

Two tools, and they answer different questions:

- **`VX_TIMING=1 vx run …`** prints a stage table to stderr at the end of
  the run — discovery, cache open, config load, git enumeration, graph,
  classify/probe, run graph, history, close — with each stage's own and
  cumulative time, plus accumulated per-task spans (`cache.get`,
  `output glob`, `output stat`, `task hash`). This is the first thing to
  read: it says WHICH stage moved. The per-task spans run under the
  scheduler's concurrency, so they over-count (a span's wall includes
  time yielded to other tasks); compare them to each other, not to the
  stage total.
- **`bun --cpu-prof --cpu-prof-dir=/tmp/prof packages/vx/src/bin.ts run …`**
  then `bun bench/profile-summary.ts /tmp/prof/*.cpuprofile` gives self
  time by function and by file. Good for finding a hot loop; unreliable
  about where an `await` waited (it attributes the wait to whatever frame
  was on the stack).

Three measurement lessons from this wave, recorded so they are not
re-learned. A compiled Bun 1.4.0 binary resolves on-disk packages by
`<pkg>/index.ts` only and ignores `exports`, so `bench/compare.ts`
measured nothing ("vx skipped") until the packages gained root shims —
if the vx row ever reads `n/a` again, read the skip line first. a micro-benchmark of a sync call in isolation (`statSync`
2 µs vs `stat` 13 µs) does not predict the run — the async forms run in
parallel on the thread pool under the scheduler's concurrency, and
switching the warm-hit path to sync calls made the 1000-project run
40 ms SLOWER. And Bun 1.4.0's `--compile` binaries carry a signature this
macOS rejects (SIGKILL on launch); an ad-hoc `codesign -s - --force`
repairs it, which the release workflow now does on a macOS runner.

## Head-to-head, 2026-09-03 (46 packages, `bench/compare.ts 10 5 1`)

Same workspace, identical commands, every runner pinned to concurrency
10, daemons on for Turbo/Nx, vx as its compiled binary. Median of 1,
this machine (macOS arm64, Bun 1.4.0):

| Runner      | Version | Fresh (cold) | Warm (no restore) | Warm (restore) |
| ----------- | ------- | ------------ | ----------------- | -------------- |
| vx          | 0.0.0   | 10.45 s      | 76 ms             | 83 ms          |
| vx (frozen) | 0.0.0   | 10.49 s      | 83 ms             | 88 ms          |
| turbo       | 2.10.12 | 10.58 s      | **71 ms**         | 97 ms          |
| nx          | 23.2.0  | 19.66 s      | 540 ms            | 531 ms         |

Read it honestly: at 46 packages Turborepo 2.10 and vx are within a few
milliseconds of each other on a fully-cached run — Turbo's daemon
answers "what changed" without a walk, vx pays one `git status`. vx wins
the restore case and ties the cold one; Nx is 7× off. The remaining
fixed cost at this size is process start + git, not the pipeline.

The same harness at **476 packages / 1,428 graph nodes**
(`bench/compare.ts 20 25 1`, same day, same machine — the committed
`bench/RESULTS.md`):

| Runner      | Fresh (cold) | Warm (no restore) | Warm (restore) |
| ----------- | ------------ | ----------------- | -------------- |
| vx          | 1m 40s       | **297 ms**        | **416 ms**     |
| vx (frozen) | 1m 40s       | 285 ms            | 399 ms         |
| turbo       | 1m 40s       | 342 ms (1.2×)     | 612 ms (1.5×)  |
| nx          | 3m 23s       | 1.38 s (4.7×)     | 1.33 s (3.2×)  |

This is the shape vx is built for: the gap opens with the graph, and
opens fastest on the restore path, where vx's per-hit work (one batched
probe, a stat check, no extraction when the tree is already current) is
what the others do not do.

## A real monorepo: 3,270 tasks, 100 layers

The shape that actually stresses a task runner: **100 dependency layers**,
~11 packages per layer, ~30 deps per package, three tasks each
(`build` + `installDeps` + `test`, `sleep 1` for build and test) — **3,270
task nodes**. Same repo, same hardware, same task commands; Turbo and Nx
pinned to `--concurrency=10` / `parallel: 10`.

|                              | vx         | Turborepo | Nx       |
| ---------------------------- | ---------- | --------- | -------- |
| **Cold** (nothing cached)    | **3m 48s** | 8m 18s    | 8m 27s   |
| **Warm**, nothing to rebuild | **0.55s**  | 1.60s     | 9.86s    |
| **Warm**, restore outputs    | **0.89s**  | 2.00s     | 10.44s   |
| **Total CPU burned** (user)  | **22.7s**  | 1,250.4s  | 2,037.5s |

Read it: vx runs the cold build in **under 4 minutes** where both others
take **over 8** (2.2× faster), and a fully-cached run in **0.55s** — 2.9×
faster than Turbo and **17.8× faster than Nx**.

Add `vx lock` + `vx run --frozen` (the CI path — execute the frozen graph
with **zero per-run config evaluation**) and the warm runs drop further
still: **0.49s** with nothing to rebuild and **0.80s** restoring outputs,
another ~10–12% off — at which point a fully-cached check of 3,270 tasks
is faster than most single test files.

The last row is the foundation. For the _same 3,270 tasks_, vx spent
**~23 seconds of CPU**; Turborepo spent **~1,250**; Nx spent **~2,037**.
That's roughly **50× less work per task** — and it's why the gap _widens_
as the graph grows: vx's overhead barely registers, so wall-clock tracks
the actual work, while the others spend most of their time being a task
runner. vx doesn't chase speed as a feature; low overhead is structural
(no daemon, git-OID hashing, an O(N+E) bitset scheduler).

> Methodology note: a synthetic graph with `sleep`-based tasks isolates
> _runner_ overhead from real compilation. All three runners are
> configured **identically** — same commands, the same `src/**` inputs and
> `dist/**` outputs, the same concurrency. (Hashing `**/*` instead would
> include each task's own output in its inputs and break caching for
> everyone.) The smaller head-to-head below is fully reproducible here.

## Reproducible head-to-head (vx vs Turborepo vs Nx)

`bench/compare.ts` scaffolds **one** shared monorepo matching the shape
above — `layers` × `perLayer` packages, ~30 deps each, three tasks
(`build` + `installDeps` + `test`) with the **identical** shell command,
`src/**` inputs, and `dist/**` outputs for every runner — then runs vx,
Turbo, and Nx across three cache states. Fairness is deliberate: vx runs
as the **compiled binary** real users install (not TS source); the
workspace is git-committed with `node_modules`/`.turbo`/`.nx` ignored;
**every runner is pinned to the same concurrency**; and runners are
measured **strictly one at a time**, daemons stopped between them, so they
never fight for CPU. `build`/`test` `sleep 1 s` so a warm hit visibly
skips the work.

```bash
bun bench/compare.ts                 # 100 layers × 11 (3,270 nodes) — the full shape (slow)
bun bench/compare.ts 10 5 1          # 46 packages, 10 layers — quick
BUILD_SLEEP=0 bun bench/compare.ts 20 11 2   # deep graph, pure framework overhead
```

It writes [`bench/RESULTS.md`](https://github.com/vznjs/vx/blob/main/bench/RESULTS.md)
(committed, so the numbers can be referenced from a commit). A quick run —
46 packages, 10 layers, 1 s tasks, concurrency 10 for all:

| Runner      | Fresh (cold)      | Warm (no restore) | Warm (restore)   |
| ----------- | ----------------- | ----------------- | ---------------- |
| **vx**      | **10.47 s**       | **127 ms**        | **151 ms**       |
| vx (frozen) | 10.50 s (1.0× vx) | **117 ms (0.9×)** | 148 ms (1.0× vx) |
| turbo       | 10.66 s (1.0× vx) | 245 ms (1.9× vx)  | 283 ms (1.9× vx) |
| nx          | 29.28 s (2.8× vx) | 879 ms (6.9× vx)  | 872 ms (5.8× vx) |

**Reading it honestly.** At this small scale the cold run is dominated by
the `sleep` work every runner pays equally, so vx **ties Turbo on cold**
and is already 2.8× faster than Nx. **Warm** is where the design shows: vx
is **1.9× faster than Turbo and ~7× faster than Nx**, because a cache hit
restores in milliseconds instead of re-running. The deep 3,270-task graph
at the top is the same comparison at scale, where vx's far lower per-task
overhead pulls it ~2× ahead on cold, too.

**`vx lock` + `--frozen`** is measured as its own row: it executes the
frozen `vx-lock.json` graph with **zero per-run config evaluation**, which
trims another ~10% off the warm path (117 ms here) and is the recommended
CI configuration. In your repo: `vx lock`, then commit `vx-lock.json`.

## Performance history

Where vx's own headroom went, on the same 1090-package / 3,270-node graph,
fully cached (`vx run build test --all`):

| Milestone                                            | No-restore | Restore |
| ---------------------------------------------------- | ---------- | ------- |
| Set-closure scheduler priority (before)              | 10.2 s     | —       |
| + bitset scheduler closure                           | 1.27 s     | 1.59 s  |
| + discovery / package-graph fixes                    | 1.03 s     | 1.34 s  |
| + frontier `^task` expansion (v19, 8.5× fewer edges) | 0.62 s     | 0.87 s  |

Input hashing then moved to git blob OIDs (v20, `git ls-files -s`): clean
files cost zero reads/stats, dropping the warm run-phase from ~245 ms to
**~76 ms (3.2×)** at 500 projects × 30 files, and cold runs never read
committed file contents at all. The decision history lives in git (the log was retired 2026-09-02);
the shipped-optimization catalog with invariants is
[`optimizations.md`](./optimizations.md), and the engineering tour is
[`comparison.md` § Where vx is ahead](./comparison.md#where-vx-is-ahead).

## Known headroom

The remaining no-cache floor is dominated by **config evaluation**:
`loadProjectConfig` is ~199 ms of a ~517 ms warm wall at 1000 projects
(discovery ~82 ms, package graph ~1 ms). A resolved-config eval cache was
designed and **rejected** — soundness would need a static purity gate (no
imports, no `process.env`), and a correctness-critical heuristic isn't
worth ~200 ms. Configs are programs: they re-run, they don't cache.
`vx run --frozen` is the sound version of that win for CI — it loads the
committed `vx-lock.json` with zero evaluation (~10–21% off the warm path).
