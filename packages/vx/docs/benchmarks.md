# Benchmarks

Empirical overhead numbers vs. Turborepo, Nx and Vite Task on synthetic
workspaces. The head-to-head is re-measured on every change to vx and
filled in when the site is built (§ Head to head).

Every harness (`compare.ts`, `run.ts`, `ab.ts`, `real/turbo-repo.sh`,
`real/nx-repo.sh`) runs vx from a `vx lock` snapshot, the lock taken
once per workspace before the timed reps, as every run reads one
(2026-09-29). A section dated before that ran vx without a lock,
evaluating every config per run. The harness never re-locks: a config edited after the
lock is re-locked by running `vx lock` again, and `vx lock --check` is
what fails loudly on a stale lock (a run trusts it, 2026-06-13,
`docs/design/config-lock-2026-06.md`); only a project the lock lacks
fails the run itself.

Only the native-config runs (each runner on the same graph from its own
config: the head-to-head, the scaling table) measure
vx. The real-repo runs went through `turbo()` or `nx()` on the repo's
own `turbo.json` or Nx graph, a migration bridge rather than a claim
(2026-10-02), and are removed (§ Real repos). Those repos are to
be rerun on the native config `bunx @vzn/vx-migrate` writes.

## Warm-run overhead (2026-09-02)

The number that matters most to a developer is the warm no-op run: every
task a cache hit, nothing to restore. `private/vx-bench/generate.ts` workspaces,
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

Where Wave 2's 242 ms at 1000 projects went (`VX_DEBUG_TIMING=1`, see
below; Waves 6 and 7 took 70 ms off it, mostly the run-graph phase and
the git overlap): discovery 22 ms, config load 31 ms (all cache hits) overlapped
with git's one worktree walk (`status -uall`, ~57 ms, the critical
path), the run-graph phase 78 ms (1000 hits: probe, output glob, stat
check), history recording 12 ms, cache open 9 ms, and ~50 ms of process
start + module load + exit outside the table. The 1.7 s cold run is the
1000 `cp` commands.

Reproduce: `bun private/vx-bench/run.ts 1000 5` (it prints the median
and every rep; the best is the min). Its last row, `one edited`, changes
one package's source per rep: one miss, every other task a hit.

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

The same container class on 2026-10-29 (Bun 1.4.4, vx at 38ac3be9d),
medians with the full spread, five reps at 1,000 and three at 5,000:

| Projects | Warm             | Restore             | Cold                      |
| -------- | ---------------- | ------------------- | ------------------------- |
| 1000     | 355 ms (298–410) | 938 ms (891–1091)   | 2905 ms (2760–2960)       |
| 5000     | 808 ms (679–836) | 4025 ms (3501–4472) | 11 400 ms (11 132–11 423) |

These rows replace the 2026-09-23 ones (1,000: warm 239, restore 906,
cold 2634 ms; 5,000: warm 711, restore 3253, cold 10 950 ms).

The warm row at 1,000 reads above that run's spread. Runs on a shared
container are not an A/B: whether the warm path slowed needs one against
a worktree of the old commit.

5× the projects costs warm 2.28×, restore 4.29×, cold 3.92×.

### Profiling a run

Two tools, and they answer different questions:

- **`VX_DEBUG_TIMING=1 vx run …`** prints a stage table to stderr at the end of
  the run — `startup`, `workspace config`, `discover projects`,
  `package graph`, `open cache`, `load configs`, `build graph`,
  `git enumeration`, `plugin stages`, `classify + probe`, `schedule`, `run graph`,
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
  then `bun private/vx-bench/profile-summary.ts /tmp/prof/*.cpuprofile` gives self
  time by function and by file. Good for finding a hot loop; unreliable
  about where an `await` waited (it attributes the wait to whatever frame
  was on the stack).
- **`strace -f -o <file>`** around a run, then
  `bun private/vx-bench/strace-vx.ts <file> [<before-file>]`: the count of
  vx's OWN syscalls (the tasks' shells are told apart by PID), as a diff
  against the same run on a `git worktree` of the base. A syscall count
  is deterministic where this container's wall time is not: the restore
  path's three spare round trips per artifact (item 627) were three rows
  of that table — `readlink` 1,003 → 3, `mkdir` 2,002 → 1,002,
  `newfstatat` −2,000 — and the save's two `mkdir`s of the cache
  directory (630) one row, before either was a number. A `write` per
  round trip is the thread pool's wake, so that row counts round trips.
  `bun --preload ./private/vx-bench/sqlite-tally.ts …` is the same idea
  for SQLite statements; `restore-bench.ts` and `save-bench.ts` in the
  same package restore or save every artifact sequentially, where a
  per-artifact change of tens of microseconds shows above the
  four-worker run's noise (and one of a few microseconds does not: 630).

Three measurement lessons from this wave, recorded so they are not
re-learned. A compiled Bun 1.4.0 binary resolves on-disk packages by
`<pkg>/index.ts` only and ignores `exports`, so `private/vx-bench/compare.ts`
measured nothing ("vx skipped") until the packages gained root shims —
if the vx row ever reads `n/a` again, read the skip line first. A micro-benchmark of a sync call in isolation (`statSync`
2 µs vs `stat` 13 µs) does not predict the run — the async forms run in
parallel on the thread pool under the scheduler's concurrency, and
switching the warm-hit path to sync calls made the 1000-project run
40 ms SLOWER. And Bun 1.4.0's `--compile` binaries carry a signature this
macOS rejects (SIGKILL on launch); an ad-hoc `codesign -s - --force`
repairs it, which the release workflow now does on a macOS runner.

### A/B two builds

`private/vx-bench/ab.ts` is the method the numbers here use: one
workspace copy per arm, warmed by that arm, rounds that run every arm
once in a rotated order, min and median per arm, and an A/A arm (the
same vx twice) as the noise floor. Every arm after the first prints its
min against the first arm's as a signed percent. An arm is a compiled binary or a
checkout; the runs see git's defaults and no `BUN_OPTIONS`. A `run` is
timed from a `vx lock` snapshot: each arm runs `vx lock` in its own
copy with its own vx once, before the warm-up.

```bash
bun private/vx-bench/ab.ts 15 base=/tmp/vx-old@/tmp/w1 main=/tmp/vx-new@/tmp/w2 \
  aa=/tmp/vx-new2@/tmp/w3 -- run build --all
```

A real repo's copies each link `node_modules/@vzn/vx-migrate` (or the
plugin under test) to their arm's checkout, so a plugin change is
measured with its own core.

### The per-PR guard

`private/vx-bench/perf-guard.ts` runs in every PR's gate as
`@vzn/vx-bench#check.perf`, in CI's `Perf` job: a runner of its own
beside the DTE run, whose workers are packed for the run's wall
time, not a task's (ci.yml `perf`). It builds a 25- and a 100-package workspace
and drives core in-process through five phases, each from a `vx lock`
taken first: cold run, up-to-date run, restore run, plan, one-edit run. Two kinds of number, against
`private/vx-bench/perf-baseline.json`:

- **Counts**: processes spawned, xxh3 calls, blob-hash updates, SQLite
  statements. The same code does the same work on any box, so a count
  that grows fails; one that shrinks passes. Statements gated by the
  50 ms racy-mtime windows (the directory snapshots) are left out; they
  move with load.
- **Time**, printed only: each timed phase's min over 7 reps at 100
  packages, divided by a calibration loop run between reps, flagged past
  1.5× the baseline. It fails nothing: beside the test shards it read 1.97× on a PR that
  slowed no phase.

Each measure runs in a child with a hermetic environment, since vx
hashes `BUN_OPTIONS`, a HOME bunfig and its parent run's variables.
A change meant to grow a count records it (on a conflict in the file,
take main's and run it again):

```bash
vx run @vzn/vx-bench#perf.update   # then commit perf-baseline.json
```

Run it through `vx run`: the baseline's times are taken under the task
sandbox, as the check is.

### The per-PR bench against Turborepo

`private/vx-bench/pr-bench.ts` runs in every PR's gate after
perf-guard.ts, in the same task (`@vzn/vx-bench#check.perf`), so the
two benchmarks never share a machine; it takes about a minute. One 100-package
workspace (build then test, copy-sized tasks), this checkout's vx
compiled as released against Turborepo 2.11.10 (pinned in
`private/vx-bench/package.json`), both at concurrency 4: cold, restore
and nothing-changed as pairs, vx then Turbo back to back.
Each tool runs in its own copy of the workspace: Turbo rewrites every
output on a warm hit, so in one shared tree vx's nothing-changed run
found them changed and restored all 100, and the case timed a restore
(2026-10-28; the bench now fails if a vx nothing-changed run rewrites
an output). The true nothing-changed ratio is 1.14, not the 0.93 the
shared tree recorded.
Other processes on the machine slow vx more than Turbo (four busy
loops moved the nothing-changed ratio from 0.90 to 1.28; check.perf and
two test shards beside it, from 0.97 to 1.25 on one commit), so each
pair also reads the cores other processes kept busy while it ran
(`/proc/stat`, less the bench's own CPU, its children's and the sandbox's
strace). An arm reps until 7 pairs ran with at most half a core busy
beside them, 30 pairs at most, and takes the min of each tool over its
7 quietest; when none of that many ran quiet it says `BUSY` and holds
the ratio anyway. Under the sandbox, two busy loops for the first 25 s
cost 9 more pairs per arm and left both ratios at or below a quiet run's.
Every case is held, and vx is never slower than Turbo: a case whose
vx min is above Turbo's fails, as does a restore or nothing-changed
ratio vx / turbo grown past 1.3× its value in
`private/vx-bench/pr-bench-baseline.json` (the CI runner's). Cold's
ratio is not held to its record: Turbo's cold read 3047 and 2219 ms on
two CI runners of one day while vx read 2117 and 2088. Cold is held too: it is the overhead the site publishes, and
printed only, from one run (200 spawns on 4 cores read 0.71 and 1.12 in
two CI runs of one commit), it read vx 1.12× Turbo for weeks with every PR
passing. A 60 ms sleep added to vx's startup failed the
nothing-changed case (0.83 → 1.24). Record a change meant to move it
with `vx run @vzn/vx-bench#vs-turbo.update`.

The ratio alone let main grow slower one PR at a time: every step stayed
inside 1.3×. So each held case is also timed against the base commit's
own vx (`VX_BENCH_BASE`: the PR's base, or main before a push), compiled
in the same job from `git archive` of `packages/vx` and run in its own
copy of the workspace, locked by itself. Each pair runs vx, the base,
then Turbo, and a case's min more than 1.15× the base's fails: three checks of one change read restore at 0.96 to 1.09
of its base.

`private/vx-bench/real/nightly.ts` re-runs the repos on
[Real repos](#real-repos) each night against the tool they ship with,
on this checkout's vx, and exits 1 with a `LOSS` line for any case vx
loses.

## Head to head

Every figure in this section is filled in when the site is built, from
main's latest measured run (2026-10-29: no benchmark figure is typed by hand).

On GitHub the page shows the `%bench.…%` tokens instead.

The shape (owner's spec, 2026-10-09): 29 levels of 50 libraries and a
last level of 100 apps; 50 more libraries at level 15 that nothing uses.

One `e2e` project depends on every app and on those 50.

Every project depends on 2–5 others in the five levels below, and five
core libraries at level 1 are each used by about a quarter of the
projects. %bench.projects% projects, 20 source files each.

Tasks: `installDeps` (no command, after the dependencies' `build`),
`build`, `lint` and `test` (after `installDeps`), `publish` (after `build`).

`typecheck` runs after the dependencies' `build`; `e2e` has `lint` and
`test`. %bench.tasks% task nodes.

Each task sleeps: build %bench.task.build%, test and typecheck
%bench.task.test%, lint %bench.task.lint%, publish %bench.task.publish%.

That is long enough that the tasks, not any tool's own work, set the pace.

`build` writes 200 KB of incompressible random bytes plus a file made
from its dependencies' outputs. The bench times what CI runs: a cold
build, a run with nothing changed, and a restore from cache.

No edit row: an edit needs Nx's daemon, which CI does not run, so no
edit row compares fairly (2026-10-09).

Same repo, same commands, every tool at concurrency %bench.concurrency%,
each in its own native config.

Turborepo reads `turbo.json` and runs no daemon (it uses none for
`turbo run` since 2.8.11). Nx runs its own graph (`nx:run-commands` targets, `^` inputs,
`.env` loading off).

Vite Task runs `vp run` over each `vite.config.ts`.

vx runs as the compiled binary from a `vx lock` snapshot, as every vx
run does.

It orders tasks with `vxHistory({ file: 'vx-timings.json' })`; the file
holds each task's own duration, as CI would carry it from an earlier run.

**Time each tool adds over the ideal run:**

|                                       | vx                 | Turborepo             | Nx                 | Vite Task          |
| ------------------------------------- | ------------------ | --------------------- | ------------------ | ------------------ |
| **Nothing changed**                   | %bench.vx.warm%    | %bench.turbo.warm%    | %bench.nx.warm%    | %bench.vt.warm%    |
| **Nothing changed, outputs restored** | %bench.vx.restore% | %bench.turbo.restore% | %bench.nx.restore% | %bench.vt.restore% |
| **Cold build**                        | %bench.vx.cold%    | %bench.turbo.cold%    | %bench.nx.cold%    | %bench.vt.cold%    |
| **Cold build: CPU the runner burns**  | %bench.vx.cpu%     | %bench.turbo.cpu%     | %bench.nx.cpu%     | %bench.vt.cpu%     |

Time each tool adds over the ideal run; lower is better.

%bench.provenance%

**The ideal run** is the theoretical best case, so every row is overhead.
Nothing changed and outputs restored: 0, so all a tool spends there is overhead.

Cold: every task list-scheduled critical-path first (critical path
%bench.ideal.critical%, work ÷ workers %bench.ideal.work%, the ideal run
%bench.ideal.cold%).

**CPU** is user + system of the invocation and the children it waited
for, less what the task commands burn under `xargs -P %bench.concurrency%`
(%bench.ideal.cpu%).

A daemon that outlives the invocation (Turborepo's, Nx's) is not
counted, so their CPU is a lower bound.

> Methodology note: a synthetic graph with `sleep`-based tasks isolates
> _runner_ overhead from real compilation. All four runners are
> configured **identically**: same commands, the same `src/**` inputs and
> `dist/**` outputs, the same concurrency, and each sees a dependency's
> change (Turborepo and vx through upstream keys; Nx through `^` inputs;
> Vite Task through each dependency's output as an input).

### Where the figures come from

Each runner is one task, `@vzn/vx-bench#bench.<runner>` (`vx`, `turbo`,
`nx`, `vite-task`), which runs `compare.ts` for that runner alone and
writes its rows to `private/vx-bench/site/<runner>.json`.

`@vzn/vx-docs#bench.data` gathers the four files into
`measured/bench.json`. The site's build reads its committed copy,
`src/data/bench.json`. A build with no data fails; so does a page naming
an unknown token.

The line under the table names each runner's version, date and machine.

Only CI's Bench job runs them, on main and on a dispatch: `vx run
@vzn/vx-docs#bench.data --concurrency 1 --force` on a 4-core Linux
runner of its own, one runner at a time. `--force` measures all four on
that one machine, never a row cached from another runner's CPU. It
uploads `measured/bench.json` as the `bench-data` artifact.

On main the job then copies that file over `src/data/bench.json` and
runs `@vzn/vx-docs#deploy.pages`, so each main push puts its own numbers
live. The site deploys only from this job: a deploy from main's run would
ship the committed copy, older than the live one (2026-11-01).

No build depends on the
benchmarks, so neither the DTE run, where a worker is packed beside
other tasks and would time its neighbours, nor a fresh clone's `vx run
build` ever runs one. A pull request's build reads the committed copy;
refresh it with a commit of the job's file now and then.

The tasks run outside the sandbox, which on Linux traces every process
they start: under it vx's cold overhead read 55.61 s against 7.01 s
outside (2026-10-29).

A rival measured once keeps its row until its key changes, so the rows
in one table can come from different runners of one machine class.

### Why Nx is slower

Two things, both per task, and both measured on the 46-package workspace
(cold, 138 tasks, min of 3 interleaved arms, 2026-09-24, item 735):

| Arm                                             | Over the 10.00 s ideal | CPU     |
| ----------------------------------------------- | ---------------------- | ------- |
| the old harness: `nx:run-script`, Nx picked npm | 18.82 s                | 69.80 s |
| `nx:run-script` with bun (the fixed harness)    | 11.37 s                | 41.18 s |
| `nx:run-commands`: the same commands, no fork   | 1.65 s                 | 3.05 s  |

1. **A Node process per task.** `nx:run-script` runs every task in a
   freshly forked Node process (`nx/bin/run-executor.js`: 138 of them in
   one cold run, counted with `strace -f -e execve`) that loads Nx before
   it runs the script. That is ~270 ms of CPU per task. On four cores at
   concurrency 10 it saturates the CPU, so every task on the 20-task
   critical path waits for a core: 9.7 s of wall and 38 s of CPU, the
   gap between the last two rows. `nx:run-commands` runs its command
   from the Nx process itself (`NX_RUN_COMMANDS_DIRECTLY`), and with it
   Nx runs 1.65 s over the ideal schedule. A package-based Nx repo
   gets `nx:run-script` for every inferred `package.json` script. Since
   2026-10-04 (owner: "use run commands") the harness gives Nx
   `nx:run-commands` targets, the command line vx runs; the 46-package
   shape then read Nx 1.17 s over the ideal cold and 3.26 s of CPU against
   vx's 0.40 s and 0.91 s (median of 3). `installDeps`, vx's
   group task, is a cached `nx:noop` for Nx and a script-less task for
   Turbo: on one 1,090-package workspace (no sleeps, min of 3) an
   uncached `nx:noop`, or a target with no executor (Nx makes it
   `nx:noop`), held Nx's warm run at 16.5 s against 5.9 s cached.
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

At the 9,603-task shape (2026-10-13: 1,601 projects, Nx 23.3.0,
`nx:run-commands`, `CI=1`, daemon and `.env` loading off, four-core
Linux, 173 environment variables) warm has a cause: Nx's fully cached
run took 21.2 to 23.6 s. A CPU profile of the main process (24.8 s
sampled) puts 6.10 s self in `hashTasksUpfront`, which hands each
task's environment object to the native hasher; 5.55 s in garbage
collection; 3.03 s in `getTaskSpecificEnv`, which copies `process.env`
for every task even with `.env` loading off; 2.89 s in
`copyFilesFromCache`, which rewrites every cached output on each warm
run; and 1.56 s in the native planner. Most of it is a per-task copy
of the environment, so it grows with the environment's size, and no
setting turns it off. Loading `.env` files cost a further 2.7 s.

The npm share grows with the graph. At 1,090 packages (3,270 tasks,
`compare.ts 100 11`, same box, one cold run each) Nx burned 76 min of
CPU with npm and 23 min with bun: npm was two thirds of the old
harness's Nx number there.

Refuted, each within ±0.3 s of the fixed harness's cold run: the
per-task pseudo-terminal (`NX_NATIVE_COMMAND_RUNNER=false`) and the
output style (`NX_TUI=false`, `--outputStyle=stream`). So is the daemon:
the fixed harness read Nx cold at 12.25 s over the ideal with
`NX_DAEMON=true` and 12.08 s without. Parallelism is honoured: with cheap tasks, the
`nx:run-commands` arm sits 1.65 s over the ideal schedule. The ~4 git
probes each forked task runs cost ~8 ms of it. These tables used to say
Nx's daemon was on; `CI=1` had always turned it off, and the harness
keeps it off on purpose: it simulates CI.

### Why Turborepo was slower cold on 100 layers (2026-10-04)

On the earlier 1,090-package, 100-layer shape: the order it starts
ready tasks in, not its CPU (21 s cold against vx's 17 s at 3,270
tasks). Turborepo has no ranking: its walker hands out
tasks as they become ready and each waits for a semaphore slot
(`crates/turborepo-engine/src/execute.rs`). When a layer's builds finish,
the next layer's builds become ready together with that layer's tests,
and in ready order the tests go first, so every build on the 100-layer
critical path waits about a second. `listSchedule(nodes, 10, 'fifo')`
replays that order on the benchmark's graph: 1m 20s over the ideal
schedule, against Turborepo's measured 1m 21s and nothing ranked (`private/vx-bench/tests/ideal.test.ts`).

No `turbo.json` key changes the order. vx ranks ready tasks by remaining
critical path, Nx by how many tasks wait on each.

## Reproducible head-to-head (vx vs Turborepo vs Nx vs Vite Task)

`private/vx-bench/compare.ts` scaffolds **one** monorepo, the shape in
§ Head to head (`private/vx-bench/shape.ts`), with the **identical** shell
commands, `src/**` inputs and `dist/**` outputs for every runner.

It times each runner through the three states CI sees: cold, nothing
changed and outputs restored.

Fairness is deliberate: vx runs as the **compiled binary** real users
install (not TS source), from a `vx lock` taken once before the reps.

The workspace is git-committed with `node_modules`/`.turbo`/`.nx` ignored.

**Every runner is pinned to the same concurrency**, and runners are
measured **strictly one at a time**, daemons stopped between them, so they
never fight for CPU.

Turborepo, Nx and vite-plus are `private/vx-bench`'s pinned
devDependencies, linked into the workspace, so a run needs no registry.
Cold is one run; nothing changed and restore are the median of 3.

```bash
bun private/vx-bench/compare.ts                      # every runner, 3 reps (about 20 min)
RUNNERS=vx,turbo bun private/vx-bench/compare.ts     # a subset of runners
BENCH_BUILD_MS=0 bun private/vx-bench/compare.ts 1   # zero-length tasks: each tool's own cost per task
vx run @vzn/vx-bench#site.numbers --concurrency 1    # the site's rows, one runner at a time
```

It writes the runners' rows to `OUT` (default
`private/vx-bench/site/bench.json`) and prints them as a table.

The table carries **CPU** columns and the **ideal** run, the theoretical
best case, so each row reads as overhead above it.

**`vx lock`** is what the `vx` row runs (since 2026-09-29), as every
run does: it executes the `.vx/projects.lock.json` graph with **zero
per-run config evaluation**.

Measured 2026-09-12 on the 1,000-project bench, compiled binary, 12
interleaved reps: no lock min 154 / median 177 ms, lock 148 / 165, a
tie within the noise.

The `load configs` stage read 20–25 ms with no lock against 6–10 ms of
lock read plus 12–14 ms of load from the lock.

The lock is for what it guarantees — what runs is what was locked,
whatever a config would read from the environment. In your repo:
`vx lock`, then commit `.vx/projects.lock.json`.

## How the overhead scales with the workspace (2026-09-10)

The per-package figure above is one size. This is vx alone at three
sizes of the same synthetic shape (`private/vx-bench/run.ts`, the
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
runner's own costs on a trivial task; § Head to head, where each task
sleeps and every runner gets the same concurrency, is where vx is
compared against Turborepo, Nx and Vite Task.

## Scheduling order (2026-10-09)

Which ready task starts first, measured inside vx: the default order
(most transitive dependents), the `@vzn/vx-history` plugin, and
three other rules written as measurement-only `schedule` plugins. One
cold run per row (`--force`), linux x64, 4 cores, Bun 1.4.2, vx from
source at `main` a85223a. Every task is a `sleep`. Each history arm
starts from an empty history in its own copy of the workspace. The
post: [Which task runs first?](https://vznjs.github.io/vx/blog/scheduling-strategies/).

A slow task with nothing after it: one 60 s task, two chains of a
29.75 s parent and a 0.25 s child, 2 workers.

| Rule                                      | Wall time |
| ----------------------------------------- | --------- |
| Ready order                               | 60.2 s    |
| Most transitive dependents (vx's default) | 90.0 s    |
| Critical path by step count               | 89.9 s    |
| Recorded time, run 1 (no history yet)     | 90.0 s    |

Most direct dependents ties and falls back to ready order (60.2 s);
recorded time runs 2 and 3 take 60.2 s each.

The mirror: 100 independent tasks and a chain A then B, 2 s each, 10
workers.

| Rule                                      | Wall time |
| ----------------------------------------- | --------- |
| Ready order                               | 24.3 s    |
| Most transitive dependents (vx's default) | 22.3 s    |
| Critical path by step count               | 22.4 s    |

Most direct dependents ties and falls back to ready order (24.3 s);
recorded time runs 1 to 3 take 22.3 s, 22.2 s and 22.3 s.

The headline graph: 1,090 packages, 3,270 tasks, 100 layers, 1 s
tasks, 10 workers. The best possible run is 218 s.

| Rule                                      | Wall time |
| ----------------------------------------- | --------- |
| Ready order                               | 301.7 s   |
| Most direct dependents                    | 220.5 s   |
| Most transitive dependents (vx's default) | 220.4 s   |
| Critical path by step count               | 220.6 s   |

Recorded time runs 1 to 3 take 220.6 s, 220.5 s and 220.5 s.

## Time to first task, cold (2026-10-09)

From `vx run` to the first task starting, cold, from a `vx lock`, on the 1,090-package bench, min of interleaved runs, linux
x64, 4 cores, vx from source, Turborepo 2.11.7:

| vx at                                             | First task |
| ------------------------------------------------- | ---------- |
| Before #3378                                      | ~380 ms    |
| #3378: a lock `vx lock` wrote is not re-validated | ~330 ms    |
| #3382: an empty cache skips the up-front probe    | 225–232 ms |
| Turborepo 2.11.7                                  | 276 ms     |

vx now starts its first task about 20% sooner than Turborepo; the rest
of the cold run is unchanged. History: `docs/history/ws-x.md` X-212, X-216.

## CI timings file (2026-10-09)

A fresh runner with no run history, with the history plugin's `file`
carried from the last run, and with this machine's full history.
`bun private/vx-bench/timings-file-bench.ts`: eight packages whose
`build`, `check` and `pack` chain (0.5 s each) unlocks more work, three
10 s `e2e` tasks nothing depends on, 4 workers, every task an uncached
`sleep`, min of 3, linux x64, 4 cores, Bun 1.4.2, vx from source at
`main` d790970. The lower bound is 10.5 s. The post:
[Carry the scheduler's memory between CI runners](https://vznjs.github.io/vx/blog/ci-timings-file/).

| Runner              | Wall time |
| ------------------- | --------- |
| Cold, no file       | 12.09 s   |
| Cold, with the file | 10.68 s   |
| Full local history  | 10.64 s   |

## Step by step against Turborepo and Nx (2026-10-13)

Where each tool's run goes, cold and warm. The synthetic bench, 1,601
projects, 8,002 run tasks (9,603 graph nodes), 4 cores, concurrency 10,
`CI=1`, local cache only, Linux container. Turborepo 2.11.8 with
`--profile`; vx from `9388bad8f` with `VX_DEBUG_TIMING=1`; Nx 23.3.0 with
`nx:run-commands`, daemon off, `.env` loading off, CPU profile of the
main process. The post:
[Where a task run spends its time](https://vznjs.github.io/vx/blog/where-a-run-spends-its-time/).

| Run                     | vx                                                   | Turborepo 2.11.8              |
| ----------------------- | ---------------------------------------------------- | ----------------------------- |
| Cold                    | 120.2 s                                              | 127.3 s                       |
| Warm                    | 892 ms                                               | 2,496 ms first, 909 ms second |
| One source file changed | 100.1 s (6,607 run)                                  | 105.8 s (6,607 run)           |
| That edit reverted      | 3.6 s (1,321 tasks restored, the rest left in place) | 5.2 s (all 8,002 replayed)    |

Nx 23.3.0, warm (21 to 24 s, 9,603 of 9,603 hit), self time:

| Self time | Where                                                                  |
| --------- | ---------------------------------------------------------------------- |
| 6.10 s    | `hashTasksUpfront`: hands each task's environment to the native hasher |
| 5.55 s    | garbage collection                                                     |
| 3.03 s    | `getTaskSpecificEnv`: copies `process.env` for each task               |
| 2.89 s    | `copyFilesFromCache`: writes every cached output back                  |
| 1.56 s    | `plan`, the native planner                                             |

## Real repos

Public repos, each moved to native vx config with `vx init --native`
and timed against the tool it ships with, through
`private/vx-bench/real/nx-repo.sh` (Nx) or `turbo-repo.sh` (Turbo):
both tools run the same tasks with the same worker count, three
interleaved reps per case, best of three. `cold` wipes the outputs and
both caches; `restore` wipes the outputs and keeps both caches; `noop`
wipes nothing. Nx runs with
`NX_DAEMON=false` and no Nx Cloud.

### TanStack/query (2026-10-09)

Commit `817bd02`, scope `build` without examples and integrations: 25
tasks each, 5 workers. vx 0.0.633, Nx 23.2.1, pnpm 12.4.2, linux x64,
4 cores.

| Case        | vx     | Nx     |
| ----------- | ------ | ------ |
| Cold build  | 34.6 s | 39.4 s |
| Restore     | 0.39 s | 1.26 s |
| Nothing new | 0.22 s | 1.43 s |

Cold is the total wall time of the build: a real repo has no ideal
schedule to subtract, so its total is shown (2026-10-09). Restore
and nothing new are runner overhead: every task is a cache hit. Each
rep in order: vx cold 40.16 / 34.99 / 34.61 s, Nx 40.95 / 39.38 /
39.71 s; vx restore 0.39 / 0.50 / 0.50 s, Nx 1.26 / 1.49 / 1.57 s; vx
noop 0.22 / 0.24 / 0.23 s, Nx 1.43 / 1.59 / 1.49 s.

### create-t3-turbo and react-email, against Turbo (2026-10-09)

[t3-oss/create-t3-turbo](https://github.com/t3-oss/create-t3-turbo) at
`8f945b7` (Turbo 2.5.8, 3 tasks) and
[resend/react-email](https://github.com/resend/react-email) at
`1531a39` (Turbo 2.9.14, 7 tasks), filter `./packages/*`, 10 workers
each. vx 0.0.634 configured by `vx init --native`, plus
`vxHistory({ file: '.vx-timings.json' })` fed timings from
one earlier untimed run (the file is the only thing kept across the
cache wipe). Turbo is each repo's own, `--no-daemon`. pnpm 12.4.2,
Node 22.22, linux x64, 4 cores, 16 GB.

| Repo            | Case        | vx      | Turbo   |
| --------------- | ----------- | ------- | ------- |
| create-t3-turbo | Cold build  | 6.23 s  | 7.14 s  |
| create-t3-turbo | Restore     | 0.087 s | 0.519 s |
| create-t3-turbo | Nothing new | 0.081 s | 0.476 s |
| react-email     | Cold build  | 30.21 s | 33.22 s |
| react-email     | Restore     | 0.283 s | 0.382 s |
| react-email     | Nothing new | 0.136 s | 0.252 s |

Cold is the total wall time of the build, as on every real repo;
restore and nothing new are runner overhead: every task is a cache hit.

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
2026-09-02, before the day's work). A config evaluation cache behind a
static purity gate took `load configs` to 16–25 ms per 1,000 configs
the same day; it was removed on 2026-10-14, when every run moved to the
lock and only `vx lock` evaluates.

**Source vs binary.** The runner invokes `bun packages/vx/src/bin.ts` by default, which pays ~40 ms of transpile per run that the `--bytecode` release binary does not (2026-09-09: 114 vs 71 ms on a two-package workspace; 20 projects warm 109 vs 64 ms). Set `VX_BIN=<path>` to time the shipped binary instead.
