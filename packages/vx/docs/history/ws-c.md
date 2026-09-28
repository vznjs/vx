# Stream C — scheduler and run lifecycle (plan-2026-09-27): merged items, one entry per PR

## C-1: carry the `--continue=always` taint through a restore-tier hit

A stale hit. Under `--continue=always` a task behind a failure runs but is
never saved, and the taint passes to everything built on it. The tracker
judged each task at dispatch, from the upstream outcomes it saw, and a
dependent asked whether its upstream had been tainted. A confirmed local
hit runs on the restore tier, ahead of its deps, so it was judged against
holes and recorded clean: `gen` (failed) → `pack` (a hit) → `ship`
(executed) saved `ship` over `gen`'s partial output on its healthy key,
and the next healthy run restored it. The same graph with `pack`
executing never saved `ship`. The tracker now learns every settled
outcome (`onFinish`) and reads a task's taint from its deps' settled
outcomes, iteratively and memoized once they have all settled. A
restore-tier task's dependents are released only once its own deps have
settled (item 963), so the answer is complete when asked. Rows:
`continue-taint.test.ts` (red on main: `ship` read `cache-hit` in the
healthy run) and `taint-tracker.test.ts` (the early judgment, its
control, and a 50,000-deep chain of hits; each red with `settled` a
no-op).
A mutation sweep of `scheduler.ts` found the item-963 block held for
one hop only; `scheduler.test.ts` now holds it through a skipped task,
through a second hit and from an `aborted` dep (each row red under its
mutant).

## C-2: run a task whose key folds a runtime probe on this machine

A stale hit (F's vx-reapi probe P2). `cache.inputs.runtime` and
`workspaceRuntime` are answered by the submitter (`node -v`) and folded
into the key, but a remote worker ran its own runtime: a Node 20 worker's
output was saved under a Node 22 key. No executor can prove its worker
matches, so `pinnedLocalSet` pins such a task. Its dependants stay free:
they fold the probe through its input key, and their output does not
depend on this machine's runtime. Core-side for every executor, so the
`vx-reapi` plugin needs no change. Row: `placement.test.ts` (red without
the change).

## C-3: judge an `--affected` task name by every loaded project

Under a diff-chosen scope a bare name only unaffected projects declare is
not a typo (item 1024). The guard asked the whole workspace only when
the load was partial: `b` depending on `a` loaded `a` for the closure,
the load was whole, the check was skipped, and `vx run dev
--affected` said "No projects declare task(s): dev" and exited 1 though
`a` declares it. Names a loaded project declares now drop first; the
rest of the workspace is loaded only for names still unjudged. Row:
`affected-sparse-tasks.test.ts` (red without the change).

## C-4: tear the plugins down when a cache factory fails

The cache factory runs inside `prepareRun` before the span that tears
down on a throw, and its catch closed the local cache alone: a `cache()`
that threw or returned something off-contract left every plugin's
teardown unrun, leaking what other factories opened, once per `vx watch`
cycle (`plugin.md` and item 1029 promise it). Also de-claims two
comments: frozen mode checks no config bytes on the run path (`vx lock
--check` does), and a graph hook has no resources to adjust. Rows:
`plugin-teardown.test.ts`, a throwing and an off-contract factory (red
without the change).

## C-5: open the index read-only when loading resolved projects

`loadResolvedProjects`, what `vx show` and `vx mcp`'s `listTasks` read,
opened the cache as a run does: it created `.vx/cache/` where none
existed and reset an earlier schema's index, run history included. It
opens it as `vx last` does now (`Cache.inspect`); an index it refuses
serves nothing and the configs evaluate live. Row:
`scoped-config-loading.test.ts` (red without the change).

## C-6: keep a plan's stage warnings off `--dry=json` stdout

`planRun`'s default logger wrote status lines to stdout, so a `project`
stage's warning (turbo() warns there) landed ahead of the JSON and
`vx run --dry=json` did not parse. The plan is the product on stdout;
its warnings go to stderr. A run keeps its status on stdout, where its
tasks' output goes. Also restates `run-lock.ts`'s cache-safety claim on
what makes it true since A-3 (an artifact lands by rename inside its
rows' transaction, across workspaces sharing one `--cache-dir` too).
Row: `dry-json-stdout.test.ts` (red without the change).

## C-7: hold the scheduler's lanes, settles and refusal hint

A mutation sweep of `scheduler.ts` and `admission.ts` (80 mutants, 55
caught) left five scheduler paths no row held, each red under its
mutant now: the local lane past its concurrency under an `admit`
policy (at two slots: at one the serial lane answers first), a pooled
task waiting behind a full local lane, pooled ids in `admit`'s running
set, a rejected settle promise hanging `runGraph`, and a file-system
refusal from `execute` printed as an internal error. The sweep's
restore-tier findings are C-1's rows; admission's taint and dedup held.

## C-8: fire a plugin's `onRunEnd` once per run

`run()` calls `runEnd` on its success path and in its `finally`, and a
signal calls it a third time; `busLogger` emitted `run:end` for each, so
`ctx.on('onRunEnd')` ran two or three times. `busLogger` now emits it
once. The private dedupes in `wireForwarder` and the telemetry source
went with it. Rows: `plugin-e2e.test.ts` (one `run:end`),
`events.test.ts` (`runEnd` emits once).

## C-9: state the process's exit in `--summarize`

The summary said `exitCode: 1` on a Ctrl-C (the process exits 130) and
`ok: true` when a kept server later crashed (exit 1): it was written
before the keep-alive wait and derived its code from `ok`. It now takes a
stopping signal's code and is written again when the kept server ends.
Rows: `keep-alive.test.ts` (a server exiting 1, a Ctrl-C after the
summary).

## C-10: say a refusal every task meets once

A corrupt cache index (A-8) reaches every task's lookup as one
`UserError`, and the scheduler printed it per task: 40 times for 40
tasks. A repeat of a refusal's text now says `as <id> above`. Row:
`scheduler.test.ts` (red without the change).

A's lead 4 (the run-end snapshot vouching for a stray) did not
reproduce: a stray a dependant writes into an upstream's output
directory is cleaned by the next hit. It does survive when a dependant's
additive glob covers the path, and survives a forced walk too, so the
cause is the additive rule (`caching.md` § Additive outputs), not the
snapshot.

## C-11: isolate an async plugin hook's rejection

`ctx.on` called each handler as `void handler()` inside a sync `try`,
so an async hook's rejection escaped: Bun printed a stack per event and
a green run exited 1, with the plugin never disabled. A rejection now
disables the plugin and warns once, as a throw does; the bus drops an
async subscriber's rejection as it drops a throw. Row:
`plugin.test.ts` (red under either half removed).

## C-12: refuse an executor capacity that is not a positive integer

A pooled task has room while `active < capacity`, so a `capacity` of 0,
NaN or a negative number parked every task placed on that executor, and
the run hung with no output (or, with no handle open, died with no
summary and no teardown). `resolveExecutors` now refuses such a value by
plugin and executor name. Row: `plugin-capabilities.test.ts`.

## C-13: keep a restore on the restore lane when its task is pooled

`hasRoom` and `admit` asked the pool first, so a restore-tier hit placed
on an executor with a `capacity` (every task, with a local-only cache)
took the pool's arm: every restore ran at once, past the restore lane's
cap and `--concurrency 1`, and the pool counted them over its capacity.
The restore tier is now judged first, as `modules/scheduler.md` says
("restore-tier nodes are always local"). Row: `scheduler.test.ts` (six
restores at `--concurrency 1`: six at once without the change, one
with).

## C-14: carry a rejected task's reason into its frame and the recap

The scheduler wrote the line naming a rejected `execute` (an executor's
throw, a corrupt index) to `process.stderr` past the logger, after the
outcome had landed, so the task's frame was empty and the failure recap
said "(no output)" for a reason vx had printed above. `runGraph` now
hands the line to `onError` before the outcome, and a run routes it to
the task's own stderr. Row: `plugin-capabilities.test.ts` (red without
the wiring, and with the line after the outcome).

## C-15: fence task text on GitHub Actions in every output mode

`resolveOutputView` set `gha` only in `full` mode, and the fence rode
on it, so under `--output-logs=errors-only` a failed task's
`::error::`/`::endgroup::` lines printed raw in its frame and its recap,
and in any mode a server's output since ready printed raw at the end
(forged annotations, an early `::endgroup::`). `gha` now means "on
GitHub Actions"; every deferred frame and server tail is fenced; groups
stay in the `full` branch. Rows: `output-flow.test.ts`.

## C-16: count an uncached task a cached one folds as a reader

The deferral gate skipped tasks with no `cache` block, but such a task's
key folds every file in its project and a cached dependant folds that
key: under `--download=none` a same-project producer was deferred, its
outputs absent when that key was taken, and the dependant's key moved
with the transfer flag (cli.md: "Never affects cache keys"). Such a task
now reads its whole project in the gate; one nothing cached depends on
does not. Row: `download-policy.test.ts`.

## C-18: drop `listInvocations`' unused filters

Its branch, ci and tag filters had no caller (`vx last` passes a limit
alone) and the tag one matched by `LIKE`: case-insensitive, and `%`/`_`
in a value were wildcards. Removed with the bare-number signature; the
limit stays. Also measured, no change: the warm `run graph` stage at
5,000 projects is 290 ms here, the scheduler's own share 25–50 ms, the
rest the per-hit output stats and the execute path (the one repeat,
`wholeSubtreePrefixes`, is 4–6 ms, inside noise); a server gives its
slot back at ready, so one-shot tasks never starve behind it; `run.ts`'s
only clean seam is the ~40-line footer, which removes no duplication.

## C-17: hold `plugin-host.ts`'s surviving mutants

A sweep of 110 mutants: 75 caught, 4 inconclusive, 31 survived, of which
7 are equivalent (the key's part sort, a second fingerprint claimant the
schema refuses, `Number.isFinite` on a non-number, …). The other 24 are
held now by rows in `plugin-pipeline.test.ts` (stages skipped by a plugin
without them, graph blame, key-part numbering, schedule refusals, every
admit policy asked, a silent or throwing policy), `chained-cache.test.ts`
(a layer failing twice, the local floor named, a shared layer's owner),
`plugin-capabilities.test.ts` (an empty executor name) and
`plugin-teardown.test.ts` (a throwing teardown's message, the next still
torn down). No defect in the file. Harness note: a per-mutant `TMPDIR`
under the scratchpad pushed the sandbox socket past `sun_path`.

## C-19: hold `signals.ts`'s surviving mutants

A sweep of 48 mutants: 31 caught, 17 survived, 2 of them equivalent
(`forwardedSignal`'s `undefined` arm, which `abort()` never reaches; the
survivors' dedup). The other 15 are held now: `terminateChildren` reaps
every survivor, SIGKILLs a group whose shell left the live list, keeps
the grace at `VX_KILL_GRACE_MS` or 2 s and releases the groups it holds;
`forwardSignals`, driven in a process of its own (the group guard hid
it in the e2e rows), clears the live region, stops the run, SIGKILLs
every child and closes the cache, exit 130; the listener row covers
SIGHUP; a kept server's stop and an embedder's abort arrive as SIGTERM.
No defect in the file.

## C-21: send the second signal once vx has heard the first

The two second-signal rows in `signal-handling.test.ts` slept 100 ms
between the signals, and two sent back to back can land as one (then
the row drives the first-signal path, items 862, 863). The task now
traps each signal with a `heard` marker, and the second goes once vx has
forwarded the first. Both rows still fail under their mutants (no
second-signal path; the second's exit code).

## C-23: keep a clean taint answer only once the chain below has settled

`taintTracker` kept a clean answer once a node's direct deps had
settled, while a dep further down still ran. Under `--continue=always`
a late restore-tier hit asked about `h3` (hit ← `h2` ← `h1` ← a slow
`gen`) before `gen` failed; `h3` stayed clean, `ship` on it saved the
partial tree on its healthy key, and the next healthy run replayed
`PARTIAL` as a hit (3/3). A clean answer is now kept only when every dep
has settled and its own answer is kept; taint stays final at once. Found
by the `admission.ts` sweep (C-20). Row: `taint-tracker.test.ts` (red
without the change); the run above gives `success GOOD` with it.

## C-20: hold `admission.ts`'s surviving mutants

A sweep of 48 mutants: 25 caught, 22 survived, 1 inconclusive; 8 of the
23 are equivalent (the root memo shortcut, a group or persistent task the
schema already refuses a `cache` on, a per-run map's delete, …). The
other 15 are held now: a clean answer given while a dep runs is not
kept, a settled chain is walked once and a failed dep not at all, a seed
and a disabled tracker never walk (`taint-tracker.test.ts`); a
write-only or read-only run does not join a sibling, and a finished
barrier leaves the registry (`inflight.test.ts`); a vanished artifact
kept out of the tier runs in its own slot (`vanished-artifact.test.ts`).
The sweep found C-23's stale hit.

## C-26: hold the Ctrl-C control until vx has reaped the server

`keep-alive.test.ts`'s "a server that died before the Ctrl-C is still
named" turned main red: the server touched `gone` and then exited, and
the dependant's go-ahead let the test send SIGINT before vx had reaped
it, so vx judged it stopped by the run (`said: []`). The server now
writes its pid and the dependant waits until `kill -0` fails. The row's
server sleeps 0.3 s between `gone` and its exit, so the old wait fails
it every time.

## C-22: hold placement.ts's surviving mutants

Swept `orchestrator/placement.ts` (56 mutants, 114 files; cut short at
40): 32 caught, 5 survived, 2 inconclusive (caught only by the
scheduler's timing row: the walk's seen check, the plan's
`concurrency`), 1 equivalent (the `pinned.size === 0` early return: the
walk of an empty stack changes nothing). Not run: the `planExecutorOf`
download / label mutants, `UNPLACED_EXECUTOR`, `hasPooledExecutor`,
`poolOfPlacement` (the new pool rows kill the last two's six in
isolation). New rows: every dependant of a pinned task is pinned; a
40-diamond ladder is walked once per task (a child with a deadline);
`accepts()` sees the exact placement; first taker in declaration order;
`'only'` lands in `remoteOnly` / `remoteOnlyNoop`; pooled lists and
pool lookup; `--dry` hands the executor factory `warn` and the machine's
`concurrency`. Each fails under its mutant.

## C-25: hold `priorities.ts`'s surviving mutants

A sweep of 39 mutants: 22 caught, 17 survived, of which 5 are equivalent
(`1 << r` for `1 << (r & 31)`, a shift already taken mod 32; the tier
guards `nodes.has(dep)` and `nodes.has(id)`, since the restore tier is
built from the same nodes; the cycle default, since the graph builder
refuses a cycle; an override's `?? 0` for a task not in the graph). The
other 12 are held now by three rows in `scheduler.test.ts`: counts on a
65-node graph (three closure words: word count, word index, fold and
popcount past the first word), counts on a graph inserted dependents
first (the topo pass), and an override of 1 above a baseline of
2^20 - 1 (the scale). No defect in the file.

## C-24: hold `hit-restore.ts`'s surviving mutants

A sweep of 92 mutants over the 74 files that name the restore's outputs
(the other 47 cache-hit files not run): 62 caught, 30 survived, 15 of
them equivalent (`covers`, item 638; `path.sep` on POSIX; the set-size,
rows-present and root-anchored conjuncts, each redundant with
`isOutputsCurrent`'s stat of every row; the rows-empty and no-output
guards; the empty-output clean guards; the additive clean by rows, whose
files the extract renames over anyway, and a directory there fails
either way). The other 15 are held now: `execute-task.test.ts` drives
`restoreHit` for the rows a layer hands over or leaves to load, the
trusted directories (no walk, no re-record), the snapshot left to run
end, and the duration and wallclock window; `overlapping-outputs.test.ts`
(a root-anchored upstream keeps its own rows under a project dependant),
`cache-declaration-warnings.test.ts` (a root-anchored stray on an empty
entry) and `stale-hit.test.ts` (a root-anchored file the hit restores is
marked). No defect in the file.

## C-27: hold run-lock.ts's surviving mutants

Swept `orchestrator/run-lock.ts` (68 mutants, 8 files): 39 caught, 29
survived. 6 are equivalent: the `pid` presence check before its read
(the read fails the same way), `Number.isInteger` beside `pid > 0`
(NaN fails both), the `continue` after a reclaim, either kind, and a
legacy reclaim by unlink instead of `rm -r` (one more poll, same end),
`?? 1` as `?? 0` in the release (a keep-alive row failed once under it
and passed on re-run: a flake). New rows hold the other 23, each
failing under its mutant: one exit hook per process;
an entry that only contains a holder name, a pid file of `0` or one
that cannot be read are reclaimed; a live `x` entry is waited for; a
legacy pid file's start time is checked, and again when rewritten
mid-wait; comm holding `) `; one procfs read per holder per wait. A new
`run-lock-fs.test.ts` mocks `node:fs/promises` for the refusals root
cannot provoke (EACCES on readdir and unlink, EEXIST on rename, EPERM
from kill), the wait's poll count, the pid-file grace under a stopped
clock, procfs of another namespace, and a taking landing inside a held
release unlink (its own entry, its exit cleanup). No defect.

## C-29: an out-of-descriptors error in a task is a refusal, not an internal error

The scheduler asked only `isUserError` and `isFsRefusal`, so a task
that threw `EMFILE` or `ENFILE` printed `[vx] internal error in <id>`.
It now prints the one line `bin.ts` prints (E-50): the message and
`OUT_OF_FDS_HINT`. Rows in `scheduler.test.ts`, one per code, red
without the change. A run under `ulimit -n 30` did not reach this path:
the spawn failed first (the lead for A and B below).

## Leads for other streams

- **E:** a plugin command's plain `throw` (`commands.probe.run` throwing
  `new Error('boom')`) prints `vx: Error: boom` and a stack, and names
  no plugin (`src/cli/index.ts`), where every other stage says
  `plugin '<name>' failed in <stage>: boom`.
- **E:** `docs/cli.md`'s exit-code table omits nothing-affected (0), an
  unknown task (1) and a persistent task crashing after ready (1); each
  is documented only in prose.
- **A:** the `local-shortcircuit.ts` sweep's survivors (2026-09-27):
  per-task path lets a stable MISS into the restore tier (no row), one
  throwing `cache.get` or `gitFilesCache` rejects the whole classify,
  the "workspaceFiles INPUTS" row is disarmed (its reader misses on the
  warm run), and the reach/propagation exclusions (equal prefix,
  ancestor prefix, root project, every dependant, transitive dependants)
  hold no row.
- **B:** `sandbox-usage.unsafe.test.ts` › "is not reported, since what
  bwrap's namespace used never reaches the wait" failed three of three full
  gates on a timing floor (`>= 300`, got 246 ms), green alone.
- **F:** `wedged.test.ts` RST_STREAM rows raced (`sent: 0`) under gate
  load twice.
- **G:** `vx-migrate/src/nx/index.ts` imports `type Gaps` and never uses
  it (a lint warning).
- **B:** the SIGKILL leak in `keep-alive.test.ts` (the "backgrounded
  server/child" rows, macOS CI and 4 of 40 local runs at 10-way load)
  is a real window, not a flake: `spawnGuarded` lists a task's group
  with the guard only after `spawn()` returns, the child runs first
  under load, and a `kill -9` before that pipe write leaves the group
  unlisted (the guard logged an empty list at EOF in every leaked run).
  Proposed fix: the child lists itself before it runs anything (the
  guard pipe passed as an extra fd; the task shell writes `+$$`, closes
  the fd, then runs the command), and the guard dedupes ids.
- **A:** a persistent upstream folds nothing into a dependant's key
  (`upstream.ts`, by design), while an uncached one folds its whole
  project (`caching.md`). A cached e2e task behind a dev server does not
  re-key when the server's sources change unless it declares them. Worth
  a line in `caching.md` or the uncached rule.
- **E:** `--report` / `--report-file` are never written on a Ctrl-C:
  `cli/run.ts` renders them after `run()` returns, and the signal
  handler exits once `run()` has left (`signals.ts`), before that code
  (no report in 3 of 3 Ctrl-C probes).
- **D:** an edit to a patch file bun.lock names (`patches/*.patch`)
  moves every key (`vx-lockfile` folds it through `lockfile-claim.ts`)
  but `--affected` selects nothing: `affected.ts` asks a claim only
  about changed ROOT names, and the claim lists `[file]` alone. Probed
  (all three tasks moved, `affectedIds` `[]`). Proposed: the claim
  names the extra files it read (`lockfile-claim.ts` has them), and
  `affected.ts` treats a change to one as a change to the lockfile.
- **B:** `sandbox-runtime.unsafe.test.ts` › "a SIGKILLed task's port
  bridge leaves no socket behind" failed on #1413's CI with `ENOENT`
  scanning `/tmp/claude/vx-tasks/vx-task-<pid>-x`: the row reads the
  bridge socket's directory after the task went, and the directory can
  be gone by then. Green in the same PR's local gate.
- **A:** an ADDITIVE task's miss still cleans its `workspaceFiles` by
  glob (`execute-task.ts`, the `wsOutputs` clean after the stamp): in a
  same-tree root-anchored pair (`build` and `individual` both on `gen`)
  it deleted `build`'s `gen/a.txt` before `individual` ran (probed: the
  dependant's `cp` into `gen/` failed). Only project outputs are stamped.
  And `cleanOutputPaths` refuses a directory at an additive task's
  recorded path (`ERR_FS_EISDIR`, the task fails, named), where the glob
  clean replaces one.
- **A, B:** under a low `ulimit -n` a task whose spawn fails with
  `EMFILE` (`socketpair`) exits 127 (`runner.ts`), and `execute-task.ts`
  then adds `shellVerdict`'s "command not found … not on this task's
  PATH" line: 17 of 21 tasks at `ulimit -n 30`, each told to install a
  command that exists. The spawn failure should carry a flag the verdict
  skips, and `spawnFailureText` could name `OUT_OF_FDS_HINT`.
