# Benchmarks

Empirical overhead numbers vs. Turborepo and Nx on synthetic workspaces.
Updated as the runners evolve.

## Warm-run overhead (2026-09-02)

The number that matters most to a developer is the warm no-op run: every
task a cache hit, nothing to restore. `packages/vx-bench/generate.ts` workspaces,
`vx run build --all`, this machine (macOS arm64, Bun 1.4.0), best of 5:

| Projects | Before (2026-09-02 morning) | Wave 1 | Wave 2 | Wave 5 | Wave 6 | Wave 7 | What changed                                                                                               |
| -------- | --------------------------- | ------ | ------ | ------ | ------ | ------ | ---------------------------------------------------------------------------------------------------------- |
| 100      | 105 ms                      | 92 ms  | 79 ms  | 78 ms  | 77 ms  | 74 ms  | git overlaps config load; `.git/HEAD` read replaces a git spawn; batched probe; no output walk; git first  |
| 1000     | 380–450 ms                  | 270 ms | 242 ms | 237 ms | 204 ms | 172 ms | + cached pure-config evals; one worktree walk; readdir discovery; batched probe; no output walk; git first |

Wave 7 (2026-09-03) starts the unscoped git enumeration the moment the
workspace root is known — ahead of the workspace config, discovery and
the cache open, ~25 ms earlier than before — so the `status` walk that is
the warm run's wall floor overlaps everything. Interleaved A/B against a
worktree at the previous commit, three rounds of three: 1000 projects
min 195 → 172 ms.

Wave 6 (2026-09-03) removed the per-hit output walk: for `dist/**`-shaped
globs, the mtimes of every directory under the prefix, recorded at the
last save or restore, prove the output set unchanged (`docs/caching.md`
§ A current tree). Interleaved A/B against a worktree at the previous
commit, three rounds of three: 1000 projects min 224 → 204 ms.

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

Reproduce: `bun packages/vx-bench/run.ts 1000 5`.

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
  then `bun packages/vx-bench/profile-summary.ts /tmp/prof/*.cpuprofile` gives self
  time by function and by file. Good for finding a hot loop; unreliable
  about where an `await` waited (it attributes the wait to whatever frame
  was on the stack).

Three measurement lessons from this wave, recorded so they are not
re-learned. A compiled Bun 1.4.0 binary resolves on-disk packages by
`<pkg>/index.ts` only and ignores `exports`, so `packages/vx-bench/compare.ts`
measured nothing ("vx skipped") until the packages gained root shims —
if the vx row ever reads `n/a` again, read the skip line first. a micro-benchmark of a sync call in isolation (`statSync`
2 µs vs `stat` 13 µs) does not predict the run — the async forms run in
parallel on the thread pool under the scheduler's concurrency, and
switching the warm-hit path to sync calls made the 1000-project run
40 ms SLOWER. And Bun 1.4.0's `--compile` binaries carry a signature this
macOS rejects (SIGKILL on launch); an ad-hoc `codesign -s - --force`
repairs it, which the release workflow now does on a macOS runner.

## Head-to-head, 2026-09-03 (46 packages, `packages/vx-bench/compare.ts 10 5 1`)

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
(`packages/vx-bench/compare.ts 20 25 1`, 2026-09-02, same machine; a mid-size data
point — the committed `packages/vx-bench/RESULTS.md` is the 3,270-task run below):

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

## A real monorepo: 3,270 tasks, 100 layers (2026-09-03)

The shape that actually stresses a task runner: **100 dependency layers**,
~11 packages per layer, ~30 deps per package, three tasks each
(`build` + `installDeps` + `test`, `sleep 1` for build and test) — **3,270
task nodes**, 1,090 packages. Same repo, same hardware, same task commands;
every runner pinned to concurrency 10. `bun packages/vx-bench/compare.ts 100 11 1`,
this machine (macOS arm64, 10 cores), Turbo 2.10.12, Nx 23.2.0.
The committed `packages/vx-bench/RESULTS.md` / `packages/vx-bench/results.json` are this run.

|                                 | vx                                                         | Turborepo     | Nx                |
| ------------------------------- | ---------------------------------------------------------- | ------------- | ----------------- |
| **Cold** (nothing cached)       | **3m 46s**                                                 | 5m 13s (1.4×) | 34m 44s (9.2×)    |
| **Warm**, nothing to rebuild    | **510ms**                                                  | 760ms (1.5×)  | 3.59s (7.0×)      |
| **Warm**, restore outputs       | **777ms**                                                  | 1.17s (1.5×)  | 4.15s (5.3×)      |
| **CPU burned**, cold (user+sys) | **34.61s**                                                 | 1m 13s (2.1×) | 114m 06s (197.8×) |
| **CPU burned**, warm (user+sys) | **1.34s**                                                  | 4.40s (3.3×)  | 5.54s (4.1×)      |
| _Baseline_ (theoretical best)   | 3m 38s cold; 0 warm, restore, CPU                          | —             | —                 |
| _Measured floors_ (context)     | git walk 67ms · walk + raw copy 352ms · task shells 33.15s | —             | —                 |

**Baseline** is the theoretical best case, so each row shows its overhead:
cold is the tasks' own durations list-scheduled on 10 workers along the
exact dependency graph (critical path 1m 40s, total work ÷
workers 3m 38s); a cached run, a restore and the CPU a
runner burns are 0 in theory, so every measured number in those rows is
the runner. vx's cold overhead over the ideal schedule is
8.45s on 3,270 tasks (8 ms per package); Turborepo's is
1m 35s (88 ms per package) and Nx's 31m 06s
(1,712 ms per package) — the number to read first, in one unit for every
runner: a runner that adds seconds to a three-minute build is a
different tool from one that adds half an hour. For context, the
**measured floors** row gives what the cheapest possible implementation
of each step costs on this machine: one `git status -uall` walk (the
cost of asking what changed), that walk plus a raw copy of every output
file, and the task shells themselves under `xargs -P 10` (which vary by
about two seconds between runs; vx's cold CPU sits within that noise).

**CPU** is user + system time of the invocation and every child it
waited for. The tasks are `sleep`, so this is the runner's own work; a
daemon that outlives the invocation (Turbo's, Nx's) is not counted, so
their CPU is a floor.

> Methodology note: a synthetic graph with `sleep`-based tasks isolates
> _runner_ overhead from real compilation. All three runners are
> configured **identically** — same commands, the same `src/**` inputs and
> `dist/**` outputs, the same concurrency. (Hashing `**/*` instead would
> include each task's own output in its inputs and break caching for
> everyone.) An earlier run of this shape (June 2026, a 4-core Linux box)
> read cold 3m 48s / 8m 18s / 8m 27s and CPU 22.7 s / 1,250 s / 2,038 s;
> cold wall time depends on how many cores the runners' overhead competes
> with the tasks for, which is why the CPU row is the one that travels.

## Reproducible head-to-head (vx vs Turborepo vs Nx)

`packages/vx-bench/compare.ts` scaffolds **one** shared monorepo matching the shape
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
bun packages/vx-bench/compare.ts                 # 100 layers × 11 (3,270 nodes) — the full shape (slow)
bun packages/vx-bench/compare.ts 10 5 1          # 46 packages, 10 layers — quick
BASELINE_ONLY=1 bun packages/vx-bench/compare.ts # recompute only the baseline floors against the committed rows (~9 min)
bun packages/vx-bench/update-site.ts             # rewrite the landing page and this doc's stress section from results.json (--check to verify)
BUILD_SLEEP=0 bun packages/vx-bench/compare.ts 20 11 2   # deep graph, pure framework overhead
```

It writes [`packages/vx-bench/RESULTS.md`](https://github.com/vznjs/vx/blob/main/packages/vx-bench/RESULTS.md)
(committed, so the numbers can be referenced from a commit). A quick run —
46 packages, 10 layers, 1 s tasks, concurrency 10 for all:

Since 2026-09-03 the table also carries **CPU** columns and a **baseline**
row — the theoretical best case (an ideal schedule of the tasks, one git
walk, a raw copy of the outputs, the commands under `xargs`), so each
runner's row reads as overhead above it. The definitions live in the
generated `packages/vx-bench/RESULTS.md`. The quick 46-package run below predates both.

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

## How the overhead scales with the workspace (2026-09-10)

The per-package figure above is one size. This is vx alone at three
sizes of the same synthetic shape (`packages/vx-bench/run.ts`, the
generator's workspace, one `build` per package whose command is a
`mkdir` and a `cp`, so the clock is the runner and almost nothing else),
the compiled Linux binary at commit 1a35ec3, median of 3 on a 4-core
Intel Xeon container:

| Packages | Cold (nothing cached) | per package | Warm, nothing to rebuild | per package | Warm, restore outputs | per package |
| -------- | --------------------- | ----------- | ------------------------ | ----------- | --------------------- | ----------- |
| 100      | 310 ms                | 3.1 ms      | 56 ms                    | 0.56 ms     | 126 ms                | 1.26 ms     |
| 300      | 762 ms                | 2.5 ms      | 100 ms                   | 0.33 ms     | 269 ms                | 0.90 ms     |
| 1,000    | 2,091 ms              | 2.1 ms      | 178 ms                   | 0.18 ms     | 808 ms                | 0.81 ms     |

Ten times the packages costs 6.7× the cold time and 3.2× the warm time:
the per-package cost falls as the fixed cost (process start, the
workspace read, the cache open) is spread over more of them, and nothing
in the run grows faster than the graph. A cold run at 1,000 packages is
two seconds; a warm one is under two hundred milliseconds. These are the
runner's own costs on a trivial task; the 3,270-task table at the top,
where each task sleeps a second and every runner is scheduled the same
way, is where the same shape is compared against Turborepo and Nx.

## A real Turbo repo: solidjs/solid (2026-09-10)

Not a synthetic workspace: `solidjs/solid` at b25c557 (5 packages,
pnpm 9, Turbo 2.10.10 as the repo's own devDependency, Node 22), with
vx put on top of the repo's own `turbo.json` through `turbo()` (then `@vzn/vx-turbo`, now `@vzn/vx-migrate`) —
a two-line `vx.workspace.mjs`, no config rewritten. Both tools see the
same graph: `build` is four executed tasks (`solid-js#types`, `#link`,
`#build`, `solid-element#build`; Turbo lists three more `build` nodes
for packages with no such script and runs nothing for them), and
`test test-types` is seven. Both restore the identical 64 output files.
vx as its compiled binary, Turbo without its daemon (`--no-daemon`, so
every run pays its own discovery — the same footing vx is on), four
cores, Linux, arms interleaved. Medians (3 reps for `build`, 2 for
`test`); the script is `packages/vx-bench/real/turbo-repo.sh`.

| `build` (4 tasks)             | vx         | Turbo 2.10.10  |
| ----------------------------- | ---------- | -------------- |
| cold (caches + outputs wiped) | **40.6 s** | 45.5 s (1.12×) |
| warm, outputs wiped (restore) | **66 ms**  | 127 ms (1.9×)  |
| warm, nothing wiped (no-op)   | **51 ms**  | 95 ms (1.9×)   |

| `test test-types` (7 tasks) | vx         | Turbo 2.10.10  |
| --------------------------- | ---------- | -------------- |
| cold                        | **53.6 s** | 58.2 s (1.09×) |
| warm, restore               | **80 ms**  | 166 ms (2.1×)  |
| warm, no-op                 | **59 ms**  | 93 ms (1.6×)   |

Read it honestly: the cold rows are rollup, tsc and vitest — the
runner is a few percent of them, and the 4–5 s gap is Turbo's per-task
work around the same commands (its `**` default inputs hashed per
package, its log capture, its cache write), not measured to the frame
here. The warm rows are the product: with everything cached, vx
answers in 50–80 ms where Turbo takes 95–170 ms, and the restore case
— what a CI job or a fresh checkout does — is where the ratio is
widest. Turbo with its daemon on would close part of the no-op gap
(the daemon answers "what changed" without a walk); vx has no daemon
to turn on.

## Five real Turbo repos (2026-09-11)

The same footing as the solid run, on the largest Turbo repos on GitHub:
the repo's own `turbo.json`, vx on top through `@vzn/vx-migrate`'s `turbo()` with a
two-line `vx.workspace.mjs`, both tools scoped by the repo's own
filters, four cores, Linux, arms interleaved, medians of three reps.
Both tools at Turbo's default of 10 workers (vx's default is the core
count; medusa's own script says `--concurrency=100%` and both get it).
Turbo's dry-run and vx's `--dry` plan the same `pkg#task` set on every
repo. One binary for all five (the restore and warm-hit fixes of
STATUS 141 are in it). The script is `packages/vx-bench/real/turbo-repo.sh`;
`noop2` is a second consecutive no-op. Every repo's revision, toolchain,
scope and bench-side adjustment is in `packages/vx-bench/real/REPOS.md`.

What the harness does that the first attempt did not, all of it for
Turbo's benefit as much as vx's: every git-ignored artifact outside the
installs and the two caches is cleaned before a cold and a restore arm
(Turbo does not clean outputs; the first run leaked `.turbo` logs,
prebuilt files and 42 stale `tsconfig.tsbuildinfo` files between
arms); the repo's root `node_modules/.bin` is on PATH as the repo's own
`yarn build` would have it (bare, Turbo lost medusa's `rollup`); npm
trusts this container's proxy CA (cal.com's embed build runs `npx`);
and astro's `build` inputs exclude its own outputs (below).

Two tasks needed a bench-side output list, declared in the repo's
`vx.workspace.mjs` as a ten-line project-stage plugin and named here so
nobody reads them as the plugin's own mapping: medusa's `build` outputs
are `*/**` minus `!src/**` in turbo.json, which vx (no output negation)
runs uncached, so the bench names `dist/**` and `.medusa/**`; and
cal.com's `@calcom/web#build` writes 110 symlinks to `node_modules`
directories under `.next/node_modules`, which vx's artifact format does
not store, so the bench names the rest of `.next` — everything
`next start` reads — and Turbo's artifact carries the 110 links too.
Directory symlinks in artifacts are STATUS Next.

### withastro/astro (32 `build` tasks, pnpm 10, Turbo 2.10.2)

astro's `build` declares `inputs: ["**/*", …]`, and an explicit Turbo
input glob matches the filesystem, gitignored or not — so as shipped,
each package's own `dist/**` is in its hash. Turbo's first run after a
restore then rebuilds the whole graph (59.6 s on the first harness),
and because 19 of the 32 builds are not byte-reproducible the run after
that rebuilds those 19 again (48.8 s, 13 cached), forever. Probed with
`--dry=json`: appending one byte to a gitignored `dist/index.js` changes
the task hash. vx excludes a task's declared outputs from its inputs on
the same config. The table is on the fixed config — `!dist/**/*` and
`!src/**/*.prebuilt*` added to the `build`, `build:ci` and `prebuild`
inputs — so Turbo is measured at its best.

| `build`                       | vx         | Turbo 2.10.2   |
| ----------------------------- | ---------- | -------------- |
| cold (caches + outputs wiped) | **52.0 s** | 62.9 s (1.21×) |
| warm, outputs wiped (restore) | **887 ms** | 1.58 s (1.78×) |
| warm, nothing wiped (no-op)   | **627 ms** | 1.17 s (1.86×) |
| second no-op                  | **632 ms** | 1.18 s (1.86×) |

### payloadcms/payload (45 `build` tasks, pnpm 10, Turbo 2.10.4)

Scoped as the repo's own `build:all` (the four templates excluded).
Turbo's default inputs (the git-tracked files), no explicit glob.

| `build`                       | vx          | Turbo 2.10.4       |
| ----------------------------- | ----------- | ------------------ |
| cold (caches + outputs wiped) | **126.9 s** | 127.5 s (1.00×)    |
| warm, outputs wiped (restore) | **3.44 s**  | 3.46 s (1.01×)     |
| warm, nothing wiped (no-op)   | 256 ms      | **237 ms** (0.93×) |
| second no-op                  | 275 ms      | **267 ms** (0.97×) |

Parity, and the doc says so: the no-op rows are within noise of each
other and Turbo takes both. The difference in what the two runs DO is
not noise: on every hit vx loads the 14,430 recorded output rows and
stats every file (~36 ms) to prove the outputs are intact, Turbo checks
nothing on disk — delete a file under `dist` and `turbo run build` still
prints a hit. Before STATUS 141 this repo read 129 s / 6.3 s / 372 ms /
325 ms for vx.

### medusajs/medusa (83 `build` + `build:plugin` tasks, yarn 3, Turbo 1.13.4)

The repo's own `--concurrency=100%` for both. 24k tracked files.

| `build build:plugin`          | vx         | Turbo 1.13.4   |
| ----------------------------- | ---------- | -------------- |
| cold (caches + outputs wiped) | **308 s**  | 315 s (1.02×)  |
| warm, outputs wiped (restore) | **3.86 s** | 7.16 s (1.85×) |
| warm, nothing wiped (no-op)   | **947 ms** | 3.29 s (3.5×)  |
| second no-op                  | **953 ms** | 3.12 s (3.3×)  |

Before STATUS 141 vx's no-op here was 2.5 s: every task carried the
same `globalDependencies` literal and resolved it against the whole
enumeration, 76 of 83 were hashed twice, and the absent `.medusa/**`
prefix refused every directory snapshot.

### n8n-io/n8n (70 `build` tasks, pnpm 12, Turbo 2.9.18, Node 24)

| `build`                       | vx         | Turbo 2.9.18        |
| ----------------------------- | ---------- | ------------------- |
| cold (caches + outputs wiped) | 137.2 s    | **133.7 s** (0.97×) |
| warm, outputs wiped (restore) | **8.27 s** | 12.5 s (1.52×)      |
| warm, nothing wiped (no-op)   | **842 ms** | 1.36 s (1.62×)      |
| second no-op                  | **839 ms** | 1.34 s (1.60×)      |

The cold row is `n8n-nodes-base#build` (55 s alone) plus what fits
around it; a first vx rep read 193 s in the disk's slow phase and the
median absorbed it.

### calcom/cal.com (13 `build` tasks, yarn 3, Turbo 2.7.1, scope `@calcom/web...`)

Three of the thirteen are `cache: false` in turbo.json (prisma's
generate among them, ~12 s together) and run on every arm under both
tools, so the warm rows have a 12 s floor. `.env` from the example with
the two empty secrets filled, `SKIP_DB_MIGRATIONS=1`, no database.

| `build`                       | vx          | Turbo 2.7.1     |
| ----------------------------- | ----------- | --------------- |
| cold (caches + outputs wiped) | **245.7 s** | 250.7 s (1.02×) |
| warm, outputs wiped (restore) | **17.4 s**  | 19.9 s (1.14×)  |
| warm, nothing wiped (no-op)   | **14.7 s**  | 18.5 s (1.26×)  |
| second no-op                  | **14.5 s**  | 17.8 s (1.22×)  |

### Wide graphs (2026-09-11, one rep, 3 workers)

Each repo's whole task set, not only `build`: the graph a team actually
runs. One rep per arm and both tools at 3 workers, because the session's
memory cgroup allows 13.3 GiB and the wide sets' typecheck and lint
processes run at 3.6–5.7 GB resident each (n8n's `build typecheck lint`
set was OOM-killed at 4 workers and thrashed at 3, and the owner dropped
it). Same harness, same cleanup, same scope as the build tables.

**payloadcms/payload — `build lint`, 89 tasks.** payload's `lint` is
`cache: false` in its own turbo.json, so the 44 lint tasks run on every
arm under both tools (~225 s at 3 workers); the three warm rows are
that floor, and the cold row is the floor plus the 45 builds.

| `build lint`                  | vx        | Turbo 2.10.4       |
| ----------------------------- | --------- | ------------------ |
| cold (caches + outputs wiped) | **318 s** | 334 s (1.05×)      |
| warm, outputs wiped (restore) | 229 s     | **223 s** (0.97×)  |
| warm, nothing wiped (no-op)   | **227 s** | 228 s (1.01×)      |
| second no-op                  | **226 s** | 226 s (1.00×)      |

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

**Source vs binary.** The runner invokes `bun packages/vx/src/bin.ts` by default, which pays ~40 ms of transpile per run that the `--bytecode` release binary does not (2026-09-09: 114 vs 71 ms on a two-package workspace; 20 projects warm 109 vs 64 ms). Set `VX_BIN=<path>` to time the shipped binary instead.
