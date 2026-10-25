# @vzn/vx-history

Website: <https://vznjs.github.io/vx/> · this plugin: <https://vznjs.github.io/vx/plugins/vx-history/> · source: <https://github.com/vznjs/vx>

History-based scheduling for [`@vzn/vx`](https://vznjs.github.io/vx/): a `schedule` plugin that orders ready tasks by their expected REMAINING critical-path duration — a task's own p50 plus the longest chain of dependents behind it — learned from the workspace's local run history. Zero dependencies.

A task's p50 is the median of its last five timings on the current branch, else on any branch, else unknown. The timings are shared by every worktree of the repo, so a new worktree orders by them on its first run.

## Usage

```sh
bun add -d @vzn/vx @vzn/vx-history
```

```ts
// .vx/workspace.ts
import { vxHistory } from '@vzn/vx-history'

export default { plugins: [vxHistory()] }
```

`vxHistory({ window?, assume?, file?, defaultBranch?, server?, resources?, memory?, reservations? })` learns from the last `window` invocations (default 20) through core's `LocalHistoryProvider` over the cache's own SQLite handle. With one worker and two chains of identical shape, the chain history says is slow starts first; with no history yet, the scheduler's structural order stands.

`assume` is for the run that has no history: a fresh CI runner. It names durations (task id → ms) for tasks the history has not seen, so a long leaf task — a docs build, a cross-compile — starts first instead of last:

```ts
export default {
  plugins: [vxHistory({ assume: { '@vzn/vx-docs#build': 30_000 } })],
}
```

A recorded p50 always wins over an assumption, and assumptions never feed the workspace median: they are a hint for the cold run, not evidence. A duration that is not a finite non-negative number (`Number()` of an unset variable is NaN) is dropped with one warning naming its task ids; the rest still order the run. vx's own CI declares four, this one among them — its docs build was the 29 s tail of a 99 s cold gate, ready from the second second and started last (2026-09-10).

## Timings from a history server

`server` (or `VX_HISTORY_URL`) names a
[`@vzn/vx-history-server`](https://github.com/vznjs/vx/tree/main/packages/vx-history-server).
On a CI job with a token (GitHub's OIDC token, which needs
`permissions: id-token: write`, or a GitLab `id_tokens` entry
`VX_HISTORY_TOKEN` with the server's origin as `aud`), each run asks it
for its tasks' numbers, by task definition, its branch's then the
default branch's.
The run starts on its local history and re-ranks the tasks not yet
started when they land; it never waits for them. At its end it sends the
timings of the tasks it ran, once: under DTE that is the orchestrator,
with each worker's measurements. A refusal is said with the server's
words, and a CI job with no token says so once (on GitHub Actions,
`GITHUB_ACTIONS`, naming the permission). With a server the cache blobs below are neither read nor written;
off CI there is no token, and the run orders by local history alone.
`serverHeaders` are sent on every request to the server, for a proxy in
front of it (a Cloudflare Access service token:
`{ 'CF-Access-Client-Id': process.env.CF_ACCESS_CLIENT_ID, … }`); an
unset value is left out, and `authorization` stays the CI token's.

```ts
export default { plugins: [vxHistory({ server: 'https://history.example.com' })] }
```

## Timings through the cache

A fresh CI runner or a new branch has no timings of its own. With a
remote cache declared, the plugin carries them there, with nothing to
configure:

- **Write.** A CI run writes each task's p50 under its commit after the
  run; on a branch that lands under the branch's cache scope. A task the
  run only restored, never timed here, is written at the time the run
  that made its cache entry took. A commit's
  timings are written once and never replaced; a read-only cache policy
  keeps them local. A local run never writes.
- **Parallel runs.** Each of up to 8 runs of one commit and task graph
  (a rerun, a push and its PR, two workflows) writes its own blob, and
  each blob names the runs it holds and keeps its run's own times. A
  write folds in every blob of its last 5 commits the newest one lacks,
  so a parent's run that finishes after its child's is not lost. With no
  race this costs no extra request. Two runs of one commit whose writes
  land within one cache round trip of each other pick the same blob, and
  one is lost: a cache entry is written once and has no compare-and-swap.
- **Read.** When some task has no timing on this branch, the plugin
  takes the merge-base of HEAD with `defaultBranch` (or
  `origin/<defaultBranch>`) and imports the newest timings at it or its
  4 first-parent ancestors, once per merge-base for all its worktrees.
  A shallow clone (CI's one-commit checkout) fetches that merge-base from
  origin, as `--affected` does: no `fetch-depth: 0`.
  On a branch it then reads HEAD's parent's timings from the branch's
  scope, once per commit: a task there overrides the default branch's,
  and a task missing there keeps it. The run never waits for them: it starts in the order local history
  gives, and when the timings land (within 5 s) the tasks not yet
  started re-rank; a run that ends first stops the import. Only a plugin
  that sizes the run by them (`@vzn/vx-dte`) waits for them. A run whose tasks all have timings on its branch
  spawns no git and asks no cache.
- **Order.** A forecast reads this branch's last five timings first,
  then the newest imported one, then any branch's, then
  `assume`.
- **Per definition.** Each timing is of the task as it was: its command
  and `env.define` (`taskDefinitions`). A task whose command changed reads
  none of its old timings; editing its inputs, outputs or deps keeps them.
- **Untrusted.** A blob over 1 MiB, not `{ version: 4, tasks }` (an older blob's timings are read,
  its needs, learned wrong on a crowded or macOS worker, are not), with
  more than 50 000 tasks, or with a time outside 0 to 24 h, is dropped,
  silently; ids not in the run's graph are dropped. It can only order a
  run, never change what runs. The first write of a commit's blob stays,
  so the cache's write credential is the boundary: give PR jobs a
  read-only token.
- **Averaged times and needs.** A CI run measures each task once, so the
  time and need it writes are each the mean of its own and the carried
  one (a task whose definition changed carries none), and a task fills its
  machine only while that mean does (or both did).

## Timings between CI runners, without a remote cache

A fresh CI runner has no history. `file` names a JSON file, from the
workspace root, that carries it: read before ordering, rewritten after
each run with every task's p50 (its directory made if absent), so a
CI cache keeps one file. Git-ignore it: a task whose inputs cover it (a
root project's `**`) would re-key on every rewrite, and a rewrite of a
file git does not ignore warns.

```ts
export default {
  plugins: [vxHistory({ file: '.vx-timings.json' })],
}
```

```yaml
# GitHub Actions
- uses: actions/cache@v4
  with:
    path: .vx-timings.json
    key: vx-timings-${{ github.run_id }}
    restore-keys: vx-timings-
```

The file is `{ "version": 1, "tasks": { "<task id>": <ms> } }`, keys
sorted. A p50 recorded on this machine wins over it, and it wins over
`assume`; like `assume`, it never feeds the workspace median. A task the
run did not see keeps its time. A file that is not one warns and is read
as empty; `--dry` writes nothing.

## Reservations learned from history

The same history answers what each task used: the runner records every
execution's CPU time and peak RSS. Core's only gate is the worker count;
this plugin's `admit` hook packs the finer numbers, and core never
learns them. Each task's reservation is the largest peak RSS in the
window times a headroom (1.25), rounded up to 64 MB; cores are never
learned (the parallelism a build shows is what the machine let it have,
and reserving the solo reading packed 92 real builds two wide on four
cores for a 21% longer run, 2026-09-15), only declared. A task is
admitted while its reservation and those of everything running beside
it fit the budgets —
cores are the run's worker count, memory is what this process may use
(the machine's total, capped by the cgroup limit a container runs
under) — and a task over a whole budget runs alone. A task with no execution in the
window reserves nothing and runs freely, as it would with no plugin; a
spike or a refactor ages out with the window. A cache hit counts too:
the producing execution's usage rides the artifact, so a fresh CI runner
that restored a task from a remote cache has its reservation on the
next run without ever having executed it.

```ts
plugins: [
  vxHistory({
    // MB. The default is the machine's total capped by the cgroup limit; set it to budget below either.
    memory: 8192,
    resources: { headroom: 1.5 },
    // Declared by hand for what history cannot size (a first run); a declaration wins.
    reservations: { 'app#e2e': { cpus: 2, memory: 4096 } },
  }),
]
```

`window`, `memory` and `headroom` must each be a finite number above 0 (`window` a whole one). One that is not — `Number(process.env.X)` with `X` unset is NaN, and no reservation fits a NaN budget, so every task that reserved memory would wait for an idle machine — runs on its default, named in one warning per run and in `vx history`. So does a declared `reservations` axis (`cpus`, `memory`): one that is not a number above 0 reserves nothing on that axis (a NaN held its task alone and every reserving task beside it waited); `0` is taken as nothing, silently. An entry that is not an object (`{ "app#build": 2048 }`) reserves nothing and is named the same way.

`vx history [--format pretty|json]` (a verb this plugin adds; `--help`
prints its usage) shows what it learned per task and the reservation it
will pack, with the budgets it packs into:

```
$ vx history
history: last 20 runs · budgets 4 cores (the default worker count; --concurrency changes it per run) · 13567 MB (what this process may use)
  task       runs      p50  peak rss    cpu  reserves
  app#build    12    8.41s    612 MB   1.9×  768 MB
  app#e2e       3   41.20s    1.4 GB   1.1×  4096 MB · 2 cores (declared)
  lib#test     12    1.02s         —   1.0×  —
  3 tasks with no execution in the window reserve nothing
```

`--format json` emits `{ window, budgets, tasks }` with every task's
`runs`, `p50DurationMs`, `maxPeakRssBytes`, `maxCpuParallelism`,
`reservation` and `declared`; `schemas/history.json` (shipped) is its
JSON Schema, held to the output by core's
`tests/plugin-json-schemas.unsafe.test.ts`. A cache hit's row carries the producing
execution's usage, so a task restored from a remote cache shows a
reservation on a machine that never executed it. A task lighter than
vx itself has no peak on record (the runner reports one only above its
own footprint, since Linux hands a lighter child the parent's figure)
and reserves nothing — what a task under vx's own footprint needs.

`resources: false` turns the learning off (declared `reservations` are
still packed). Admission control, not enforcement: nothing is
cgroup-limited or reniced, and a task that exceeds its reservation is
the job of `exec.timeout` and the OS. Design:
`docs/design/resource-estimates-2026-09.md` in `@vzn/vx`.

## What it does and does not do

- It is an ORDERING hint over the scheduler's structural baseline (how many tasks wait on each one, directly or through others), merged as `VxPlugin.schedule` returns it: task id → weight. It never changes what runs, only which ready task runs first.
- Cache hits are not modelled as zero-cost: predicting cache state needs the key and a probe, which the scheduler handles at run time (a confirmed hit is backfill, never a critical-path task). The estimate is "what if everything ran", which is exactly the case where order matters.
- It fails open: a broken history read warns (`[vx] vx-history: ordering falls back to the baseline`) and leaves the baseline order and only the declared reservations. Observability never breaks a run.
- Cost: one history read per run, serving both hooks, paid only by workspaces that declare the plugin. Core applies no plugin by default.

The score is core's `criticalPath(nodes, history, assume?)` (`@vzn/vx`), which any `schedule` plugin may call. `resourceEstimates(nodes, history, headroom)`, `withDeclared(learned, declared)` and `admits(id, running, reservations, budgets)` are exported for tests and for policies that want the same scoring over another history source, with the types `VxHistoryOptions`, `ResourceEstimate` and `Budgets`.

## History

Core's opt-in `predictive` mode until 2026-09-02, then core's one bundled plugin (`@vzn/vx/plugins/schedule-history`) until 2026-09-10, when it moved here so core ships no plugin at all.
