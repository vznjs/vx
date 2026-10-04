# Benchmarks

Empirical overhead numbers vs. Turborepo and Nx on synthetic workspaces.
Updated as the runners evolve.

Every harness (`compare.ts`, `run.ts`, `ab.ts`, `real/turbo-repo.sh`,
`real/nx-repo.sh`) runs vx from a `vx lock` snapshot (`--frozen`), the
lock taken once per workspace before the timed reps, as CI runs vx
(2026-09-29). A section dated before that ran vx without a lock,
evaluating every config per run, except rows marked `(frozen)`; the
2026-09-03 stress run measured both, and its frozen row is now the
headline `vx`. The harness never re-locks: a config edited after the
lock is re-locked by running `vx lock` again, and `vx lock --check` is
what fails loudly on a stale lock (a `--frozen` run trusts it, owner
2026-06-13, `docs/design/config-lock-2026-06.md`); only a project the
lock lacks fails the frozen run itself.

Only the native-config runs (each runner on the same graph from its own
config: the stress run, the head-to-heads, the scaling table) measure
vx. Every real-repo section below ran vx through `turbo()` or `nx()` on
the repo's own `turbo.json` or Nx graph: a migration bridge, kept here
as a record, not a claim (owner, 2026-10-02). Those repos are to be
rerun on the native config `bunx @vzn/vx-migrate` writes.

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

Where Wave 2's 242 ms at 1000 projects went (`VX_TIMING=1`, see
below; Waves 6 and 7 took 70 ms off it, mostly the run-graph phase and
the git overlap): discovery 22 ms, config load 31 ms (all cache hits) overlapped
with git's one worktree walk (`status -uall`, ~57 ms, the critical
path), the run-graph phase 78 ms (1000 hits: probe, output glob, stat
check), history recording 12 ms, cache open 9 ms, and ~50 ms of process
start + module load + exit outside the table. The 1.7 s cold run is the
1000 `cp` commands.

Reproduce: `bun packages/vx-bench/run.ts 1000 5` (it prints the median
and every rep; the best is the min).

### A second machine, same shape (2026-09-20)

The table above is one machine's. A four-core Linux container — sharing
nothing with it — reads, medians with the full spread:

| Projects | Warm             | Restore             | Cold                      |
| -------- | ---------------- | ------------------- | ------------------------- |
| 1000     | 271 ms (243–315) | 1031 ms (1023–1051) | 3147 ms (2905–3388)       |
| 5000     | 807 ms (760–809) | 3931 ms (3462–4172) | 14 181 ms (13 798–14 986) |

Slower in absolute terms, as a shared container should be, and those
numbers are **not** comparable to the ones above — different hardware.
What does compare is the SCALING: 5× the projects costs **2.98×** the
warm run here against **2.97×** on the other machine (restore 3.81×
against 3.97×, cold 4.51× against 4.99×). The sub-linear warm curve is
the code's, not one box's.

One number to take from this before optimising against the harness: the
warm arm spreads ±13 % about its median on identical code, because every
rep is a whole CLI invocation. An A/B here needs an effect bigger than
that, and a control arm beside it.

The same container class on 2026-09-23, after the cold-path work of
items 615 (a config round's evaluations written once per table) and 622
(output-directory snapshots landed in one transaction), medians with the
full spread, five reps at 1,000 and three at 5,000:

| Projects | Warm             | Restore             | Cold                      |
| -------- | ---------------- | ------------------- | ------------------------- |
| 1000     | 239 ms (231–265) | 906 ms (831–1009)   | 2634 ms (2418–2814)       |
| 5000     | 711 ms (702–733) | 3253 ms (2993–3630) | 10 950 ms (10 896–11 547) |

Against the 2026-09-20 rows: cold −16 % at 1,000 and −23 % at 5,000,
restore −12 % and −17 %; the warm rows moved within the ±13 % spread
and claim nothing — the warm path is unchanged since item 589. Scaling
5× the projects: warm 2.97×, restore 3.59×, cold 4.16×.

### Profiling a run

Two tools, and they answer different questions:

- **`VX_TIMING=1 vx run …`** prints a stage table to stderr at the end of
  the run — `startup`, `workspace config`, `discover projects`,
  `package graph`, `open cache`, `load configs`, `build graph`,
  `git enumeration`, `plugin stages`, `classify + probe`, `run graph`,
  `record history`, `output dir snapshots`, `close`, and
  in a dry run `plan` — with
  each stage's own and cumulative time, plus accumulated per-task spans (`cache.get`,
  `output glob`, `output stat` and `task hash` among them;
  [`modules/timing.md`](./modules/timing.md) lists every one). This is the first thing to
  read: it says WHICH stage moved. The per-task spans run under the
  scheduler's concurrency, so they over-count (a span's wall includes
  time yielded to other tasks); compare them to each other, not to the
  stage total.
- **`bun --cpu-prof --cpu-prof-dir=/tmp/prof packages/vx/src/bin.ts run …`**
  then `bun packages/vx-bench/profile-summary.ts /tmp/prof/*.cpuprofile` gives self
  time by function and by file. Good for finding a hot loop; unreliable
  about where an `await` waited (it attributes the wait to whatever frame
  was on the stack).
- **`strace -f -o <file>`** around a run, then
  `bun packages/vx-bench/strace-vx.ts <file> [<before-file>]`: the count of
  vx's OWN syscalls (the tasks' shells are told apart by PID), as a diff
  against the same run on a `git worktree` of the base. A syscall count
  is deterministic where this container's wall time is not: the restore
  path's three spare round trips per artifact (item 627) were three rows
  of that table — `readlink` 1,003 → 3, `mkdir` 2,002 → 1,002,
  `newfstatat` −2,000 — and the save's two `mkdir`s of the cache
  directory (630) one row, before either was a number. A `write` per
  round trip is the thread pool's wake, so that row counts round trips.
  `bun --preload ./packages/vx-bench/sqlite-tally.ts …` is the same idea
  for SQLite statements; `restore-bench.ts` and `save-bench.ts` in the
  same package restore or save every artifact sequentially, where a
  per-artifact change of tens of microseconds shows above the
  four-worker run's noise (and one of a few microseconds does not: 630).

Three measurement lessons from this wave, recorded so they are not
re-learned. A compiled Bun 1.4.0 binary resolves on-disk packages by
`<pkg>/index.ts` only and ignores `exports`, so `packages/vx-bench/compare.ts`
measured nothing ("vx skipped") until the packages gained root shims —
if the vx row ever reads `n/a` again, read the skip line first. A micro-benchmark of a sync call in isolation (`statSync`
2 µs vs `stat` 13 µs) does not predict the run — the async forms run in
parallel on the thread pool under the scheduler's concurrency, and
switching the warm-hit path to sync calls made the 1000-project run
40 ms SLOWER. And Bun 1.4.0's `--compile` binaries carry a signature this
macOS rejects (SIGKILL on launch); an ad-hoc `codesign -s - --force`
repairs it, which the release workflow now does on a macOS runner.

### A/B two builds

`packages/vx-bench/ab.ts` is the method the numbers here use: one
workspace copy per arm, warmed by that arm, rounds that run every arm
once in a rotated order, min and median per arm, and an A/A arm (the
same vx twice) as the noise floor. An arm is a compiled binary or a
checkout; the runs see git's defaults and no `BUN_OPTIONS`. A `run` is
timed `--frozen`: each arm runs `vx lock` in its own copy with its own
vx once, before the warm-up.

```bash
bun packages/vx-bench/ab.ts 15 base=/tmp/vx-old@/tmp/w1 main=/tmp/vx-new@/tmp/w2 \
  aa=/tmp/vx-new2@/tmp/w3 -- run build --all
```

A real repo's copies each link `node_modules/@vzn/vx-migrate` (or the
plugin under test) to their arm's checkout, so a plugin change is
measured with its own core.

## Head-to-head, 2026-09-03 (46 packages, `packages/vx-bench/compare.ts 10 5 1`)

Same workspace, identical commands, every runner pinned to concurrency
10, Turbo with no daemon (it uses none for `turbo run` since 2.8.11), vx as
its compiled binary. Median of 1,
this machine (macOS arm64, Bun 1.4.0). The harness then gave Nx npm
where Turbo had bun (§ Why Nx is slower), so the Nx row is slower than a
fair one. Every runner runs as in CI (`CI=1`), so Nx's daemon is off:

| Runner      | Version | Fresh (cold)              | Warm (no restore)          | Warm (restore)          |
| ----------- | ------- | ------------------------- | -------------------------- | ----------------------- |
| vx          | 0.0.0   | 10.45 s                   | 76 ms                      | 83 ms                   |
| vx (frozen) | 0.0.0   | 10.49 s                   | 83 ms                      | 88 ms                   |
| turbo       | 2.10.12 | 10.58 s (vx 1.01× faster) | **71 ms** (vx 1.1× slower) | 97 ms (vx 1.1× faster)  |
| nx          | 23.2.0  | 19.66 s (vx 1.8× faster)  | 540 ms (vx 7.1× faster)    | 531 ms (vx 6.3× faster) |

Read it honestly: at 46 packages Turborepo 2.10 and vx are within a few
milliseconds of each other on a fully-cached run, and neither keeps a
process between runs: Turbo 2.10 uses no daemon for `turbo run` (its docs
say so from 2.9), so both work out what changed on every invocation. vx wins
the restore case and ties the cold one; vx is 7.1× faster than Nx warm. The remaining
fixed cost at this size is process start + git, not the pipeline.

The same 46-package run on the four-core Linux container (2026-09-24,
item 735, the fixed harness: Nx runs its scripts with bun as Turbo does;
`CI=1`, so Nx's daemon is off; a different machine, so only the ratios compare
with the table above). Turbo 2.11.3 (no daemon for `turbo run`) and Nx
23.2.1, vx as its compiled binary, median of 3. The CPU column is user +
system of the invocation and every child it waited for; a daemon that
outlives the invocation would not be counted, and none runs here:

| Runner      | Version | Fresh (cold)              | Warm (no restore)       | Warm (restore)          | CPU, cold               |
| ----------- | ------- | ------------------------- | ----------------------- | ----------------------- | ----------------------- |
| vx          | 0.0.0   | 10.29 s                   | 79 ms                   | 104 ms                  | 846 ms                  |
| vx (frozen) | 0.0.0   | 10.27 s                   | **74 ms**               | **95 ms**               | 826 ms                  |
| turbo       | 2.11.3  | 10.43 s (vx 1.01× faster) | 86 ms (vx 1.08× faster) | 136 ms (vx 1.3× faster) | 1.33 s (vx 1.5× faster) |
| nx          | 23.2.1  | 22.08 s (vx 2.1× faster)  | 844 ms (vx 10× faster)  | 862 ms (vx 8.2× faster) | 43.79 s (vx 51× faster) |

The ideal schedule is 10.00 s, so vx and Turbo both sit on the critical
path cold, and warm they are within a few milliseconds at this size (the
2026-09-23 run of the old harness read Turbo at 112 ms). The same box
under the old harness read Nx at 27.21 s cold and 1m 2s of CPU.

The same harness at **476 packages / 1,428 graph nodes**
(`packages/vx-bench/compare.ts 20 25 1`, 2026-09-02, same machine; a mid-size data
point — the committed `packages/vx-bench/RESULTS.md` is the 3,270-task run below):

| Runner      | Fresh (cold)          | Warm (no restore)       | Warm (restore)          |
| ----------- | --------------------- | ----------------------- | ----------------------- |
| vx          | 1m 40s                | **297 ms**              | **416 ms**              |
| vx (frozen) | 1m 40s                | 285 ms                  | 399 ms                  |
| turbo       | 1m 40s (vx same)      | 342 ms (vx 1.1× faster) | 612 ms (vx 1.4× faster) |
| nx          | 3m 23s (vx 2× faster) | 1.38 s (vx 4.6× faster) | 1.33 s (vx 3.1× faster) |

The same size on the four-core Linux container (2026-09-25, after items
744, 753 and 754, the fixed harness, median of 1; ideal schedule 1m 36s):

| Runner      | Fresh (cold)             | Warm (no restore)        | Warm (restore)           | CPU, cold                |
| ----------- | ------------------------ | ------------------------ | ------------------------ | ------------------------ |
| vx          | 1m 37s                   | **225 ms**               | **367 ms**               | 7.06 s                   |
| vx (frozen) | 1m 37s                   | 209 ms                   | 377 ms                   | 6.94 s                   |
| turbo       | 1m 39s (vx 1.02× faster) | 247 ms (vx 1.09× faster) | 392 ms (vx 1.06× faster) | 13.84 s (vx 1.9× faster) |
| nx          | 2m 27s (vx 1.5× faster)  | 1.84 s (vx 8.1× faster)  | 1.89 s (vx 5.1× faster)  | 7m 23s (vx 62× faster)   |

Read it honestly: the 2026-09-24 run on this box had Turbo 2.11 winning
both warm columns (303 and 446 ms against vx's 376 and 478). Item 744
found the cost in vx's stable-key pass (a string set copied per task per
dep, now a bitset), item 753 coalesced the 952 task lines into a write
per turn of the event loop, and item 754 ranked a warm run's tasks over
the work that actually waits; vx now leads both warm columns, by 10%
and 7% in one rep each, which this container's noise can close. The
min-of-N interleaved read of the warm no-op on the same workspace, with
compiled binaries, is vx 165–175 ms against Turbo 226 ms (item 753's
profile).

### Why Nx is slower

Two things, both per task, and both measured on the 46-package workspace
(cold, 138 tasks, min of 3 interleaved arms, 2026-09-24, item 735):

| Arm                                             | Wall    | CPU     |
| ----------------------------------------------- | ------- | ------- |
| the old harness: `nx:run-script`, Nx picked npm | 28.82 s | 69.80 s |
| `nx:run-script` with bun (the fixed harness)    | 21.37 s | 41.18 s |
| `nx:run-commands`: the same commands, no fork   | 11.65 s | 3.05 s  |

1. **A Node process per task.** `nx:run-script` runs every task in a
   freshly forked Node process (`nx/bin/run-executor.js`: 138 of them in
   one cold run, counted with `strace -f -e execve`) that loads Nx before
   it runs the script. That is ~270 ms of CPU per task. On four cores at
   concurrency 10 it saturates the CPU, so every task on the 20-task
   critical path waits for a core: 9.7 s of wall and 38 s of CPU, the
   gap between the last two rows. `nx:run-commands` runs its command
   from the Nx process itself (`NX_RUN_COMMANDS_DIRECTLY`), and with it
   Nx lands at 11.65 s against an ideal of 10.00. A package-based Nx repo
   gets `nx:run-script` for every inferred `package.json` script.
2. **npm, which the harness chose by accident.** `nx:run-script` runs
   the script through the package manager Nx detects from a lockfile.
   The generated workspace had none, so Nx fell back to npm, while Turbo
   read `packageManager` and ran `bun run`. `npm run` costs 202 ms of
   CPU per task against `bun run`'s 4 ms (min of 10, one task alone):
   7.5 s of wall and 29 s of CPU, the gap between the first two rows.
   This one was the harness's fault, not Nx's. `nx.json` now says
   `cli.packageManager: 'bun'`.

Warm is spread thin, with no single cause. With no daemon (CI), each
invocation starts three plugin workers to build the project graph
(~280 ms each, in parallel; `nx show projects` alone is 0.56 s), then
hashes and replays the cached tasks. Turning the daemon on moves the
graph into it and saves 40–160 ms (0.81 s against 0.85, min of 5, in a
probe; 682 ms against 844, median of 3, in the harness), a fifth of the
warm gap at most.

The npm share grows with the graph. At 1,090 packages (3,270 tasks,
`compare.ts 100 11`, same box, one cold run each) Nx took 20m 39s and
76 min of CPU with npm, and 7m 22s and 23 min of CPU with bun: npm was
two thirds of the old harness's Nx number there, which is the run the
site quoted. The site's Nx column (34m 44s cold, § A real monorepo, the
macOS machine) paid npm per task and is not a fair one; its vx and Turbo
columns are unaffected. Next 18 re-runs it. The whole 3,270-task shape
on this box with the fixed harness (2026-09-25, after items 744, 753 and
754, median of 1; ideal schedule 3m 38s):

| Runner      | Fresh (cold)            | Warm (no restore)       | Warm (restore)          | CPU, cold               |
| ----------- | ----------------------- | ----------------------- | ----------------------- | ----------------------- |
| vx          | **3m 40s**              | **359 ms**              | **653 ms**              | **16.05 s**             |
| vx (frozen) | 3m 41s                  | 292 ms                  | 651 ms                  | 16.46 s                 |
| turbo       | 5m 4s (vx 1.3× faster)  | 431 ms (vx 1.2× faster) | 722 ms (vx 1.1× faster) | 33.27 s (vx 2× faster)  |
| nx          | 6m 59s (vx 1.9× faster) | 4.50 s (vx 12× faster)  | 4.60 s (vx 7× faster)   | 20m 55s (vx 78× faster) |

The day before, Turbo 2.11 won both warm columns here (496 and 856 ms
against vx's 678 and 971). Item 744 found why: vx's stable-key pass
copied a string set per task per dep, now a bitset; items 753 and 754
then took the per-line stdout writes and the whole-graph priority
closure off the warm path. vx now leads every column at this size, in
one rep each.

Refuted, each within ±0.3 s of the fixed harness's 21.2 s cold: the
per-task pseudo-terminal (`NX_NATIVE_COMMAND_RUNNER=false`) and the
output style (`NX_TUI=false`, `--outputStyle=stream`). So is the daemon:
the fixed harness read Nx cold at 22.25 s with `NX_DAEMON=true` and
22.08 s without. Parallelism is honoured: with cheap tasks, the
`nx:run-commands` arm sits 1.65 s over the ideal schedule. The ~4 git
probes each forked task runs cost ~8 ms of it. These tables used to say
Nx's daemon was on; `CI=1` had always turned it off, and the harness
keeps it off on purpose: it simulates CI.

## A real monorepo: 3,270 tasks, 100 layers (2026-09-03)

The shape that actually stresses a task runner: **100 dependency layers**,
~11 packages per layer, ~30 deps per package, three tasks each
(`build` + `installDeps` + `test`, `sleep 1` for build and test) — **3,270
task nodes**, 1,090 packages. Same repo, same hardware, same task commands;
every runner pinned to concurrency 10. `bun packages/vx-bench/compare.ts 100 11 1`,
this machine (macOS arm64, 10 cores), Turbo 2.10.12, Nx 23.2.0.
vx runs from a `vx lock` snapshot (`--frozen`), taken once before the reps,
as a CI pipeline runs it; _vx, no lock_ is the same run evaluating every
config per run.
The committed `packages/vx-bench/RESULTS.md` / `packages/vx-bench/results.json` are this run.

|                                 | vx                                                         | vx, no lock | Turborepo               | Nx                        |
| ------------------------------- | ---------------------------------------------------------- | ----------- | ----------------------- | ------------------------- |
| **Cold** (nothing cached)       | **3m 47s**                                                 | 3m 46s      | 5m 13s (vx 1.3× faster) | 34m 44s (vx 9.2× faster)  |
| **Warm**, nothing to rebuild    | **476ms**                                                  | 510ms       | 760ms (vx 1.5× faster)  | 3.59s (vx 7.5× faster)    |
| **Warm**, restore outputs       | **743ms**                                                  | 777ms       | 1.17s (vx 1.5× faster)  | 4.15s (vx 5.5× faster)    |
| **CPU burned**, cold (user+sys) | **34.33s**                                                 | 34.61s      | 1m 13s (vx 2.1× faster) | 114m 06s (vx 199× faster) |
| **CPU burned**, warm (user+sys) | **1.33s**                                                  | 1.34s       | 4.40s (vx 3.2× faster)  | 5.54s (vx 4.1× faster)    |
| _Baseline_ (theoretical best)   | 3m 38s cold; 0 warm, restore, CPU                          | —           | —                       | —                         |
| _Measured floors_ (context)     | git walk 67ms · walk + raw copy 352ms · task shells 33.15s | —           | —                       | —                         |

vx N× faster: that tool takes N times as long as vx (theirs ÷ vx); N× slower: vx takes N times as long (vx ÷ theirs).

Nx's column ran every task through npm run (~200 ms of CPU each; Turbo ran bun run), a harness fault since fixed; with bun, on a 4-core Linux box, Nx took 6m 59s cold and 4.50 s fully cached (vx 1.9× and 12× faster).

**Baseline** is the theoretical best case, so each row shows its overhead:
cold is the tasks' own durations list-scheduled on 10 workers along the
exact dependency graph (critical path 1m 40s, total work ÷
workers 3m 38s); a cached run, a restore and the CPU a
runner burns are 0 in theory, so every measured number in those rows is
the runner. vx's cold overhead over the ideal schedule is
8.53s on 3,270 tasks (8 ms per package), 8.45s
with no lock; Turborepo's is
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
daemon that outlives the invocation (Nx's) is not counted, so Nx's CPU
is a floor.

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
as the **compiled binary** real users install (not TS source), from a
`vx lock` taken once before the reps (`--frozen`, as CI runs it); the
workspace is git-committed with `node_modules`/`.turbo`/`.nx` ignored;
**every runner is pinned to the same concurrency**; and runners are
measured **strictly one at a time**, daemons stopped between them, so they
never fight for CPU. `build`/`test` `sleep 1 s` so a warm hit visibly
skips the work.

```bash
bun packages/vx-bench/compare.ts                 # 100 layers × 11 (3,270 nodes) — the full shape (slow)
bun packages/vx-bench/compare.ts 10 5 1          # 46 packages, 10 layers — quick
BASELINE_ONLY=1 bun packages/vx-bench/compare.ts # recompute only the baseline floors against the committed rows (~9 min)
bun packages/vx-bench/update-site.ts             # rewrite the landing page, the README's bench sentence and chart, and this doc's stress section from results.json (--check to verify)
BUILD_SLEEP=0 bun packages/vx-bench/compare.ts 20 11 2   # deep graph, pure framework overhead
```

It writes [`packages/vx-bench/RESULTS.md`](https://github.com/vznjs/vx/blob/main/packages/vx-bench/RESULTS.md)
(committed, so the numbers can be referenced from a commit).

Since 2026-09-03 the table also carries **CPU** columns and a **baseline**
row — the theoretical best case (an ideal schedule of the tasks, one git
walk, a raw copy of the outputs, the commands under `xargs`), so each
runner's row reads as overhead above it. The definitions live in the
generated `packages/vx-bench/RESULTS.md`. The 46-package quick run is
the head-to-head table above (2026-09-03); an earlier run of that shape
used to sit here with a different verdict on the warm row, and one page
carrying both was a contradiction, so it is gone.

**`vx lock` + `--frozen`** is the headline `vx` row (since 2026-09-29;
before, it was its own `vx (frozen)` row): it executes the frozen
`vx-lock.json` graph with **zero per-run config evaluation**, and
`vx (no lock)` keeps the per-run evaluation's cost in view. Read the
difference as a tie, not a win: since the config-evaluation cache
(2026-09-02) the plain warm run evaluates nothing either for a config
the purity gate can prove pure, and it serves the same validated object
from `cache.db` without re-validating it, while `--frozen` parses the
whole lock and re-validates every entry (the lock is hand-editable, so
it is a boundary). What frozen still skips is the per-config identity
stat; what it still pays is the lock's own parse. Measured 2026-09-12
on the 1,000-project bench, compiled binary, 12 interleaved reps:
plain min 154 / median 177 ms, frozen 148 / 165 — ~5%, the identity
stats; the `load configs` stage reads 20–25 ms plain against 6–10 ms
of lock read plus 12–14 ms of load frozen. The 83 vs 76 ms above
(2026-09-03, median of 1) is the same tie under a laptop's noise.
`--frozen` is for what it guarantees — what runs is what was locked,
whatever a config would read from the environment — and for configs
the gate cannot prove pure, which evaluate live on every plain run and
come from the lock under `--frozen`. In your repo: `vx lock`, then
commit `vx-lock.json`.

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

## Real repos

Earlier sections here timed vx on public Turbo and Nx repos through
`@vzn/vx-migrate`'s plugins or the configs it wrote. Those runs measured
the migration bridge, not native vx config, and are removed; a rerun on
native config is pending (STATUS). The record is in git history.

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

Config evaluation was the largest fixed cost of a warm run
(`loadProjectConfig` ~199 ms of a ~517 ms warm wall at 1,000 projects,
2026-09-02, before the day's work). The resolved-config evaluation cache
that was first rejected here shipped the same day behind the static
purity gate it needed (`caching.md` § Config evaluation cache): a config
whose import closure is provably pure is served validated from
`cache.db`, keyed on the blob id of every file in the closure; anything
the gate cannot prove evaluates live. `load configs` is 16–25 ms per
1,000 configs since. `vx run --frozen` is not a faster version of that
path (see the head-to-head above, 2026-09-12): it is the env-independent
one, and the eval-free one for impure configs.

**Source vs binary.** The runner invokes `bun packages/vx/src/bin.ts` by default, which pays ~40 ms of transpile per run that the `--bytecode` release binary does not (2026-09-09: 114 vs 71 ms on a two-package workspace; 20 projects warm 109 vs 64 ms). Set `VX_BIN=<path>` to time the shipped binary instead.
