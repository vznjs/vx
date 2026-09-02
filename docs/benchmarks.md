# Benchmarks

Empirical overhead numbers vs. Turborepo and Nx on synthetic workspaces.
Updated as the runners evolve.

## Warm-run overhead (2026-09-02)

The number that matters most to a developer is the warm no-op run: every
task a cache hit, nothing to restore. `bench/generate.ts` workspaces,
`vx run build --all`, this machine (macOS arm64, Bun 1.4.0), best of 5:

| Projects | Before (2026-09-02 morning) | After   | What changed                                      |
| -------- | --------------------------- | ------- | ------------------------------------------------- |
| 100      | 105 ms                      | 92 ms   | git enumeration overlaps config evaluation        |
| 1000     | 380–450 ms                  | 270 ms  | + cached evaluations of pure configs              |

Where the remaining 270 ms at 1000 projects goes (from `bun --cpu-prof`
+ `bench/profile-summary.ts`): git's untracked-file walk (~55 ms, now
concurrent with config loading), the cache probes + restore stat-checks
for 1000 tasks, hashing, and ~25 ms of process + module start-up. The
1.7 s cold run is the 1000 `cp` commands.

Reproduce: `bun bench/run.ts 1000 5`, or profile one run with
`bun --cpu-prof --cpu-prof-dir=/tmp/prof packages/vx/src/bin.ts run build --all`
and `bun bench/profile-summary.ts /tmp/prof/*.cpuprofile`.

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
committed file contents at all. The full decision log lives in CLAUDE.md;
the shipped-optimization catalog with invariants is
[`optimizations.md`](./optimizations.md), and the engineering tour is
[`differentiators.md`](./differentiators.md).

## Known headroom

The remaining no-cache floor is dominated by **config evaluation**:
`loadProjectConfig` is ~199 ms of a ~517 ms warm wall at 1000 projects
(discovery ~82 ms, package graph ~1 ms). A resolved-config eval cache was
designed and **rejected** — soundness would need a static purity gate (no
imports, no `process.env`), and a correctness-critical heuristic isn't
worth ~200 ms. Configs are programs: they re-run, they don't cache.
`vx run --frozen` is the sound version of that win for CI — it loads the
committed `vx-lock.json` with zero evaluation (~10–21% off the warm path).
