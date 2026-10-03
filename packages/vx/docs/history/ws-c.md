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

## C-28: hold `upstream.ts`'s surviving mutants

A sweep of 37 mutants: 32 caught, 5 survived, of which 2 are equivalent
(wrapping every parse error, since `parseDependencySpec` throws only
`DependencySpecError`; globbing an exact name, since `compileTaskPattern`
escapes every character but `*`). The other 3 are held now by two rows
in `upstream.test.ts`: an exact name in `cache.inputs.tasks` does not
select a name it prefixes (task or project half), and a group expands
in its members' order while an empty group expands to nothing. None
could give a stale hit. No defect in the file.

## C-32: hold `dependency-spec.ts`'s surviving mutants

A sweep of 54 mutants over 16 files: 38 caught, 16 survived, 1 of them
equivalent (a lazy `.*?` for `.*`, the same set under `^…$`). The other
15 are held now by rows in `dependency-spec.test.ts`: each character
`compileTaskPattern` escapes (`+ ? ^ $ { } ( ) | \`, and every `.`, not
the first) is matched literally, since a task name may hold one and a
regex reading is a wrong edge; `*` matches the empty run and every `*`
expands; a `*` inside a name makes a pattern; the error message is
compared whole, raw spec included. Seven follow-up mutants, run after
the rows: 3 caught, 4 survived: dropping only `{`, `}` or `]` from the
escape set is equivalent (a lone one is literal in a non-unicode
regex), and `DependencySpecError.raw` is read by nothing (dead). No
defect in the file.
`DependencySpecError.raw` is dropped: nothing read it.

## C-34: take the foreign-procfs lock row in a child process

C-27's "where procfs is not this namespace, an entry names no start
time" failed on CI shard 10: `run-lock.ts` names its entries once per
process, and a file that took a lock earlier in the same process had
fixed the name with a real start time, which no mock reaches after.
Red 1 of 1 after `run-lock.test.ts` in one process, green alone. The
row now takes the lock in a child whose preload swaps `procfs.ts` for a
foreign one; green in both orders, and red with `startTime`'s procfs
guard removed.

## C-31: hold `remote-prefetch.ts`'s surviving mutants

Swept `orchestrator/remote-prefetch.ts` (32 mutants, 11 files): 19
caught, 13 survived. 4 are equivalent: the hash `Set` (core's key folds
the task id, so no two stable keys share a hash), the empty-pool return
(one pump finds nothing), the worker floor (every boundary refuses a
concurrency below 1) and `args.concurrency` for the capped count (an
extra pump exits at once). The e2e rows saw the pass only through the
wire, where execute-task's own GETs and context race it, so a new
`remote-prefetch.test.ts` drives `startRemotePrefetch` over a prepared
run with a recording layer and holds the other 9: pulls in flight equal
the workers (not 1, not every key), the context's task id, command and
`workspaceFiles` (emptied, a remote hit of a task declaring one is a
refused miss), no batch probe with no stable key, and a handle that
resolves when key derivation throws. No defect.

## C-30: hold task-graph.ts's surviving mutants

Swept `graph/task-graph.ts`: 145 mutants over the five graph files
(task-graph, wildcard-depends, output-collision, plan-predict,
project-loader), plus 6 respelled where the first spelling did not
compile or only tripped lint. 101 caught by the suite, 1 by the
type-check (`every` → `some` in the across-namespace own-glob test), 5
held only by a hang in the row named for them (the surface walk's
visited set, the cycle walk's BLACK skip and GRAY test, the literal
`continue` in the path index under the 4,000-task row, the dep check
under a graph plugin). 14 are equivalent: `held` and the own-project
short cut beside `declaredAnywhere` (a holder declares the name), the
Frame's `added`/`pending` resets and the pending `nodes.has` (same
order, same deps), the literal-literal arm (each literal's `/**` twin
answers), the reach walk's seen check and memo, the one-task bucket
and no-root-output gates, the mixed-pair swap (root-anchored entries
come first), the cycle walk's BLACK start skip and unknown-dep skip
(`checkGraph` refuses one first). New rows hold the other 24, each
failing under its mutant: `task-graph.test.ts` (an unrequested group
surfaces nothing, an anchored request is not also a bare name, an
empty scope reports nothing, depth-first node order, a malformed entry
named with its task, a pattern in the project half of `pkg#task`, the
cycle named without its lead-in, and `excludeDependencies`: no
order-only edge a kept edge gives, only the nearest scheduled tasks,
sorted, and each walk once per node, counted by `get`s on twelve
diamonds); `output-collision.test.ts` (remote-only on either side,
both namespaces; a root-anchored literal beside a project glob; a task
against itself across namespaces; a project at the workspace root;
identical globs, and `dist/**` against `distx/*.js`). Not run: the
survivors against the other 25 files that name the region (rows added
regardless), error wording beyond the rows above. No defect.

## C-33: hold `shell-verdict.ts`'s surviving mutants, read `#!` as UTF-8

A sweep of 57 mutants over 4 files (`shell-verdict`, `signal-death`,
`tool-not-on-path`, `execute-task`): 33 caught, 24 survived. Defect:
`fileVerdict` read the file as latin1, so a `#!` interpreter at a
non-ASCII path that exists was named missing (`interp-Ã©`); it now reads
bytes, keeps the first 256 (the kernel's), and decodes UTF-8. Rows in
`shell-verdict.test.ts` hold the rest: a `#!` line with no newline, a
tab or a leading space around the interpreter, a relative interpreter
(the kernel resolves it from the task's directory, so no lookup), `#`
without `!`, the 256-byte cap (in bytes, not characters), a read refused (a `0o111` file, non-root only: a sandboxed shard refuses a socket's listen), every `SIGNAL_WHY` line whole, the
fallback reason (SIGUSR1), and a signal name the platform lacks. Re-run
(58, one more for the new read): 56 caught, 2 left. Equivalent: `signal
!== undefined &&` before `signal === 'SIGINT'`. Second defect: the mode
test asked for any execute bit (`0o111`), root's rule, so a `0o654` file
the task's user owns was named executable; it now asks `accessSync(file,
X_OK)`. Its row runs only as non-root: red without the fix and green with
it, run as a `probe` user.

## C-38: hold vx in the Ctrl-C grace until its kill -9 lands

`keep-alive.test.ts`'s "a kill -9 in a Ctrl-C's grace takes the child
of a shell that died on the signal" failed on main shard 1 with ESRCH:
the child it waits on slept 1 s, so vx ended in its grace when the child
did, and a loaded runner's SIGKILL 200 ms after the SIGINT found no vx.
A 1 s pause before the SIGINT reproduces it every time. The child now
marks its trap and then waits on a `go` file the row writes only after
the kill; green with the pause, and red on `late.txt` with the group
guard's SIGKILL removed.

## C-35: hold save-lane.ts's surviving mutants

Swept `orchestrator/save-lane.ts` (15 mutants, 10 files): 12 caught,
3 survived. 2 are equivalent: settling before or after starting the
next queued save, and dropping the running entry before or after it
(`start` is synchronous and reads no count; a settle's reaction runs a
microtask later either way). The third, `running.delete(p)` gone, kept
a settled save's slot: once the lane filled, every later save queued
behind nothing and the scheduler, which waits on each save, never
ended the run. The suite never deferred after the lane drained; a
`save-lane.test.ts` row does, and asserts the save starts at once. No
defect.

## C-39: a restore-tier hit with an order-only edge no longer throws

Under `--exclude-dependencies`, a task left an order-only edge (`test`
after the excluded `gen`) that hit the cache dispatched in the restore
tier before `gen` settled; the scheduler handed it the outcomes so far,
holes included, and `keyUpstream`'s order-only filter read `.node` of a
hole: `TypeError: undefined is not an object` and a failed run, on the
second `vx run` of a saved task (C-36's probe). A hole now stays a hole,
as it does with no order-only edge. Rows in `upstream.test.ts`, the unit
and the run, both red without the change.

## C-37: hold `deferred-outputs.ts`'s surviving mutants

A sweep of 54 mutants over `tally.ts` (26, 16 files that assert its
counts or the lines built from them) and `deferred-outputs.ts` (28, 7
files): every `tally.ts` mutant caught (one did not compile, re-spelled
and caught). In `deferred-outputs.ts` 12 survived. Rows in
`download-policy.test.ts` (`DeferredOutputs`, the registry without a
run) hold 7: `pending()` sorted, not in registration order; the
producers of one consumer fetched concurrently (each starts before any
ends); a 20-rung diamond closure walked once per task (without `seen`
it is 2^20 lookups, counted by `get`s); and a fetch that stays in its
project (a nested project's file survives the wipe, and the saved
entry holds exactly the fetched file, under its hash). The `size`
getter had no caller; removed. Equivalent: the `needed.length === 0`
return (`Promise.all([])`), the first stack frame read from the map
rather than `node.deps` (the same node), and both git-snapshot marks
(item 643: no reader of a deferred producer's outputs is in the run).
No defect.

## C-36: hold `keyed-projects.ts`' and `excluded-keys.ts`' surviving mutants

Swept both files (14 + 27 mutants over 9 files): 22 caught, 19
survived. 8 are equivalent: the set's add order, the push-time memo
check (the pop-time one answers), `keyOnly` before `nodes` (disjoint),
the empty-seed return, the group arm of `foldsExcludedKey` (a group
has no `cache`, and a derived key always has a hash), the derive
memos at pop and push (a repeat derives the same key, at most once per
edge), and walking the taint through `keyedDeps` (a count question,
below). The other 11 are held now: `keyed-projects.test.ts` (a shared
subgraph walked once, counted by `get`s; groups whose members a
`graph` plugin left in another order share one hash; a group carrying
`cache.inputs.tasks` still folds all); `stale-hit.test.ts` (every
skipped dependency of every dependant keyed, one losing two edges;
under `--continue=always` a task folding no skipped key saves, so the
synthetic outcome is a success; and the forwarded-arguments row, empty
since item 980 kept a requested dependency's edge, now requests a task
beneath the skipped one); `taint-tracker.test.ts` (a 64-diamond ladder,
whose mutant never finishes: held by a hang, not a failing row). No
defect in either file; two found beside them, both in this slice. A
restore-tier hit with an order-only edge threw in `keyUpstream` (fixed
in C-39). Open: under `--exclude-dependencies`, `keyedProjects` walks
`node.deps`, counting an order-only edge the key never folds and missing
the dropped ones it does (probed: `app#test`'s keyed set held `ui`,
whose edit left the key unchanged), so with `cache.inputs.tasks:
['^*']` the sandbox grants a link the key does not answer for; the fix
walks `keyedDeps` plus each `excludedUpstream` node's deps.

## C-40: under --exclude-dependencies, K(T) is what the key folds

`keyedProjects` walked `node.deps`: it counted an order-only edge the key
never folds and missed the dropped dependencies it does (C-36's probe:
`app#test` with `gen` excluded listed `ui`, whose edit leaves its key
unchanged), so a sandboxed task that saves was granted a sibling link the
key does not answer for. It now walks `keyedDeps` plus
`excludedUpstream`, and below a dropped task the run's `keyOnly` map,
which `PreparedRun` carries now (contract pin regenerated). Rows in
`keyed-projects.test.ts`, one per half, red with the old walk.

## C-42: `escapeMarkdownCell` freed an escaped pipe and kept a lone CR

Swept `run-report.ts` (50 mutants over 14 files): 43 caught, 7
survived. 2 are equivalent (the `success` status arm, which the default
answers; `cell` on the cache word, a fixed vocabulary). The other 5 are
held in `run-report.test.ts`: the whole document by `toBe` (headline
separator, both blank lines, `success` counted apart from the total),
a `|` in the blocking task a status cell names, and every line break
flattened. Probing the escape with two GFM parsers (micromark, marked)
found two defects: `a\|b` became `a\\|b`, an escaped backslash then a
free pipe, so the row gained a cell; and a lone `\r` split the row. The
escape now adds a backslash only to a pipe after an even run, and
flattens `\r` too. `vx-github`'s ids are unchanged (its inline escape
doubles every backslash first). HTML in a name still renders as HTML;
GitHub sanitises it and the table holds.

## C-41: hold `failure-mode.ts`'s surviving mutants

Swept `orchestrator/failure-mode.ts` (55 mutants, 10 files): 46
caught, 9 survived. 2 are equivalent: `detectFlaky`'s two empty-list
early returns (the rest of the function asks nothing and returns `[]`
on an empty list). A third survives only by SQLite's current sorter:
`flakyTasks` ordering without its last `task` key, since the grouped
subquery emits in project, task order and the sorter keeps it. SQL
does not promise that, so the key stays. Four `failure-mode.test.ts` rows hold the
other 6: the chunk row also fails the last key of the first chunk (a
slice one short dropped it); two tasks of one project sharing a key
string stay apart (the key without `task` mixed them); a failure and a
retried pass cost one query, the scan, not a probe first (two guards on
the probe list); a failure tie breaks by passes, then project, then
task. No defect.

## C-44: hold `later` behind selfkill's third attempt, not a flat 0.3 s

`aborted-outcome.test.ts` › "a task killed by a signal vx did not send
is a failure" failed in C-42's gate: `later.txt` existed. `later`
waited on `slow` (`sleep 0.3`), and selfkill's three attempts had to
fail inside that window for fail-fast to trip first; fail-fast lets
in-flight tasks finish, so a loaded box lost the race. `slow` now
waits for the third `x` in `attempts` (bounded at 10 s), then 0.3 s.
Proven with each attempt slowed by 0.15 s: red on the old `slow`,
green on the new.

## C-43: a tail cut split a surrogate pair (`task-log-buffer.ts`)

Slicing one over-cap chunk to its last `TASK_LOG_TAIL_CHARS` could keep
the low half of a pair, so the tail opened on a lone surrogate a sink
encodes as U+FFFD. The cut now skips it. Sweep: 56 mutants, 42 caught,
14 survived; six equivalent (`>=` on an exact-cap slice, the wire
version's value and its literal, the early budget return and its `<`,
the stub skip) and
eight held by new rows in `task-log-buffer.test.ts`: exact budget
charges (per-chunk overhead, a sliced chunk, an empty chunk), the whole
`takeEntry` shape, drain order after a replaced retention, `size()`,
and eviction stopping at exactly the budget. CRLF and a pair split
across chunks pass through verbatim.

## C-45: hold `plan.ts`'s surviving mutants

Swept `orchestrator/plan.ts` (40 mutants, 44 files): 37 caught (one by
the type-check alone), 3 survived. `concurrency: 1` → 8 is equivalent
(the plan's work is order-free). `predictPlan`'s `byId.has` dep filter
was dead: the task graph refuses an unknown dep, so every dep of a
planned task is planned; it is gone. A row in `plan-predict.test.ts`
holds the last: `--cache=local:w` and `remote:w` each plan a miss with no
probe (`--force` holds both write axes, so either could go).

Open defect, not fixed (it needs a plan vocabulary decision): an
`exec.remote: 'only'` task no remote executor takes plans as
`miss — would exec`, and the run then does nothing. With one executor
the plan carries no `@noop` label either, and the task counts in
"would run" and the time prediction.

## C-48: a `noop` remote-only task plans as `@noop` and costs nothing

C-45 found the plan and the run disagree on an `exec.remote: 'only'`
task no remote executor takes: the run skips it ("nothing ran"), the
plan said `miss — would exec`, with no label under one executor, and
counted its p50 in the prediction. `planExecutorOf` now labels it
`noop` whatever the executor count, and `plan()`'s would-run test
excludes a `noop` task. A unit row (prediction) and an e2e row (one
executor) are red without the fix. The status word itself is E's
formatter (lead below).

## C-46: a kept server's persistent dependencies were stopped under it

`vx run dev --filter app`, and `--affected` with only app changed, kept
app#dev and SIGTERMed the api#dev it depends on (`^dev`) at the end of
the graph: the kept server ran against a dead API. `selectKeepAlive`
now also keeps every persistent task a kept one depends on, directly or
through groups; a one-shot's servers still stop. Rows:
`persistent-shutdown.test.ts` (the walk: groups, one-shots, order) and
`keep-alive.test.ts` › "--filter keeps the persistent task a kept one
depends on"; both red without the fix.

Swept `orchestrator/persistent.ts` and its caller's keep-alive block
(46 mutants, 25 files): 38 caught, 8 survived. 3 are equivalent:
`signalCode ?? exitCode` (Bun sets one or the other), and both edits of
the empty `dying` return (`crashed` is a subset of `dying`). Rows hold
the other 5: `VX_KILL_GRACE_MS` shortens the default grace; the hold is
let go once, after the SIGKILL sweep (a spy: only a reused pid shows it
otherwise); a stopped `holdPersistent` run hands back no server
(`abort.test.ts`); a requested server that exits 0 mid-run leaves the
run green; a Ctrl-C does not fail the requested server it stopped (the
Ctrl-C rows now pin the tally). On the fixed walk, dropping its
`reached` check is equivalent in a DAG (cost only).

## C-47: hold `run-records.ts`'s surviving mutants

Swept `orchestrator/run-records.ts` (65 mutants, 35 files): 35
caught, 30 survived the suite (3 of those fail only the lint, as
constant conditions). One is equivalent: `timedOut === true` loosened to `!== undefined`
(the outcome's type is `true | undefined`). New
`tests/run-records.test.ts` holds the rest by exact value: the
timeline anchors (both arms, unit, rounding, the untimed fallback),
the wall-clock, attempts and sandbox-violation fields, forwarded args,
the whole header row (remote hit count, `hitCount`, duration, times,
concurrency, git, CI and host columns), and the telemetry gate. The
header's claim that `task_count`, "N total" and telemetry agree by
construction held for groups, aborted tasks and restored hits, but
the terminal's half is a second copy of the filter: the comment now
says so and a row holds all three equal. No defect.

## C-49: `history.ts` read a warm task's success rate as 0

Swept `orchestrator/history.ts` (56 mutants, 13 files): 41 caught (five
by the type-check alone), 15 survived. Defect: `successRate` counted
only `status = 'success'`, but the recorder writes a hit as `cache-hit`
/ `cache-hit-remote`, so an always-warm task read 0 (the MCP history
tool shows it). It now counts the pass statuses, derived from
`isPassStatus`. Dead guards went: the empty-percentile return, its
`Math.min`, the `total > 0` rates and the `|| 0` sums (a group holds a
row). New rows in `history.test.ts` hold the rest: exact rates and
fatal/recoverable verdicts with hits, a NULL `cache_hit` row as an
execution, p50 for odd and even counts, the window from the first row
of its oldest invocation, the default window of 50, and a query spy for
the two cost gates (no ids, the key pass). Equivalent: the `> 0`
division guards (SQLite `x/0` is NULL), the entries join's hit filter,
and `<> 'failed'` for the pass list (no other status is recorded). A
corrupt cache.db is refused at open by `Cache`; a missing one plans
with no prediction; a history read error fails open in both callers.

## Leads for other streams

- **F:** `vx-reapi` `materialise-concurrency.test.ts` › "output files are
  fetched and written at once" read a peak of 3 reads in flight for an
  expected 5 in a full local gate (3/3 alone): each read holds 2 ms, so
  under load the first ones finish before the last start. Hold the reads
  until all have started (a latch), not for a fixed 2 ms.

- **D:** a persistent task with `exec.remote: 'only'` is refused for
  lacking `cache` ("needs `cache`: its inputs are what a worker
  reproduces"), and adding `cache` is refused next ("`cache` is not
  allowed on a persistent task"): a circular hint. A persistent task
  runs on this machine; refuse `remote: 'only'` on it by that reason.
- **E:** a dependency server that crashed mid-run still closes its
  "since ready" block `(3ms) running`: the block is drawn at `runEnd`
  from the outcome stored at ready, before run.ts marks the crash
  failed. The footer, the `vx: … exited` lines and `--summarize` say
  failed.

- **B:** `runner.test.ts` › "keeps a ready server alive past its
  readyWhen timeout" failed on #2054's Linux CI: `echo up` missed its
  150 ms readiness bound under load (`PersistentReadyError … within
150ms`). The bound is a claim about the box; a wider timeout with the
  sleep past it keeps the row's point.
- **F:** a kept server's crash after the summary exits 1, but the
  telemetry summary (`exitOk`) is emitted and flushed before the
  keep-alive wait, so a sink (the GitHub check run) reports success.
- **B:** the sandbox probe's first `initSandbox` is ~110 ms of the
  ~220 ms a run's first arm costs on Linux (SRT's `initialize`: an async
  dependency check, the proxies, the seccomp monitor), and the SRT import
  70–280 ms on the main thread; measured in isolation for C-76. Both are
  paid once per process.

- **A:** a kept server that crashes after the summary (`vx run dev`,
  the server exits 4, vx exits 1) is recorded `ok` with the server
  `success` in the run history: `recordRunBundle` runs before the
  keep-alive wait and the cache is closed by the time the wait ends, so
  `vx last` says `ok`. C-53 fixed the summary and the report; the
  history needs an update path (reopen, mark the invocation and that
  row failed).

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

- **A, E (and C):** a failed task's output is not kept, so `vx last`
  and `vx why` name the failure but cannot show its lines (E's lead).
  The run history is where both read, so the tail belongs there: A adds
  a `runs.output_tail` column (a stored shape, so `SCHEMA_VERSION`), C
  hands `RunRecord` the failed task's `recapTail` (the ring the
  end-of-run recap already keeps, `failure-recap.ts`), and E prints it
  in the replay. One PR across the three slices, or A's column first.
- **A:** `output-dirs-snapshot.test.ts` › "a cold build records its
  output directories by run end, so the next hit skips the walk" read
  `outputDirRows` as `[]` once in a full gate under load (two sweeps
  beside it); 3 of 3 alone and its shard alone pass. Cause not found.
- **D:** `config-eval.test.ts` › "a REJECTED evaluation does not poison
  a later one" failed on #1618's macOS job: `config worker did not
answer within 250ms` where the config's own error was due. The row
  gives the worker a 250 ms budget; the same content passed that job a
  rebase earlier.
- **E:** `ci-output.test.ts` › "a CI log receives the CLI plain" runs
  eleven vx verbs under bun's 5 s default. In C-42's gate it took
  5.33 s, the harness killed the in-flight `vx why`, and the row read
  its exit as 1. Alone it passes (4/4). A per-row timeout would fit.
- **E:** `cli/plan-format.ts` counts a task `executes` by its
  `cacheStatus` alone, so a `@noop` task (C-48) still reads
  `miss — would exec @noop` and counts in "would run". It should read
  as skipped: `t.executor === 'noop'` is the test `plan.ts` uses.
- **F:** `vx-github` `github.test.ts` › "a deadline during the wait ends
  the retries and warns the 502" asserts the call returns within 150 ms
  of a 50 ms deadline; C-48's gate measured 170 ms under load (3/3 green
  alone). The bound is a claim about the box, not the code.

## C-50: Turbo's `//#task` names the root project

D's lead: `dependsOn: ['//#lint']`, Turbo's spelling of a root task,
refused "no such project or task is declared" though the root was a
project (D-39); `--filter //` has read `//` as the root since D-46. The
staged load now spells `//#` as the root project's name in `dependsOn`
and `cache.inputs.tasks`, once, so the scoped closure, the graph and the
upstream fold all see it; with no root project the graph says the root
is no project. `schema.md` says so. Row (`root-project.test.ts` › takes
Turbo's //#task as the root project's task: the refusal, a scoped run
that pulls the root in, and the `cache.inputs.tasks` spelling): red with
either site reverted, and with the `cache.inputs.tasks` rewrite alone
mutated.

## C-52: a requested group keeps the servers it stands for

`vx run app#dev` over `dev: { dependsOn: ['^dev'] }` (a group, the
Turbo-style fan-out) started every server, stopped them all at the end
of the graph and exited 0. `selectKeepAlive` seeded its walk from
requested (or surfaced) persistent tasks only, and a cross-project
group's deps are not surfaced (that marking stays inside the project).
The walk now also starts from each requested group, through nested
groups to the persistent tasks below; a one-shot under it keeps none.
Row (`persistent-shutdown.test.ts` › keeps the persistent tasks a
requested group stands for): red without the seed; probed end to end
(held until Ctrl-C, exit 130). `execution.md` says so.

## C-51: a restore under another restore ranks by what that one blocks

`tieredReverseDepCount` ranked a restore by its direct exec-tier
dependents only. A restore's dependents are released once its own deps
have settled (item 963), so in `r1 → r2 → e` (two hits, one miss) `r1`
blocks `e` too, yet ranked 0 and restored after every idle hit before
`e` could start. Each restore now hands its rank to its restore deps, in
one Kahn pass over the restore tier's reversed edges, skipped when no
restore feeds an exec task. Cost (1,000 projects, 3,000 nodes, min of
50): a run whose `test` tasks miss, 0.50 → 1.4 ms; all hits, 0.17 →
0.21–0.28 ms (noise). Rows (`scheduler.test.ts` › the rank table and the
dispatch order `r1, r2, e` ahead of three idle restores): red without
the pass. `modules/scheduler.md` says so.

## C-56: a kept server's output streams after the summary

`vx run dev --all` (or two requested servers) showed nothing its servers
wrote while vx held them: a persistent task's output after ready goes
to a bounded tail, flushed once at `runEnd`, which runs before the
summary, and the keep-alive wait after it printed none of what followed.
After that flush a kept server's output now streams, a line at a time
under its id (`app#dev │ …`), its last partial line at `settle` (the
bus delivers one `run:end`), a line that never ends (a `\r` progress
bar) at 64 KiB rather than held without bound, fenced on GitHub Actions, silent under `errors-only`. Rows
(`output-flow.test.ts`): the stream in broad and full (red without it),
the partial line at `settle`,
errors-only silent (red with its guard removed), and the fence (red with
either fence removed). `cli.md` says so.

## C-55: a fail-fast skip is not "blocked upstream"

`--continue=never`'s footer read `Skipped: 2 tasks never started —
blocked upstream` over `⊘ after the run stopped (fail-fast): …`: the
header claimed a blocker the cause line beneath it denied. It says
`blocked upstream` only when every skip has a blocker. Rows
(`summary.test.ts`): a fail-fast skip alone, and the mixed row; both
red on the old header. `cli.md` says so.

## C-53: a kept server's crash reads `failed` in the summary and report

`vx run dev` whose server exited 4 after the summary exited 1, and the
rewritten `--summarize` said `ok: false` with every task `success` and
`failed: 0`; the outcomes `--report` renders said the same. The server
that ended the session on its own, not cleanly, is now failed with its
own exit, as item 1071 does for one that crashed before the stop; one a
Ctrl-C stopped is not. Rows (`keep-alive.test.ts`): the exit-1 row reads
`app#other` failed with exit 1 and `failed: 1` (red without the fix);
the Ctrl-C row reads `success` (red with the abort guard removed). The
run history still says `ok` (lead for A). `execution.md` says so.

## C-54: a plugin whose `setup` throws is named with the hook

Every stage's throw reads `plugin '<name>' failed in <stage>: …`, and
`modules/plugin.md` promises one line naming the plugin and the hook;
`setup` alone said `failed to load`, though the plugin had loaded and
its `setup` threw (an unknown `ctx.on` hook name included). It now says
`failed in setup`. Rows (`plugin.test.ts`, `plugin-teardown.test.ts`)
pin the text; red on the old message.

## C-60: a run that failed holds no server

`vx run dev --all` with one server that never became ready (or a
dependency-only server that crashed, or any task failed) still held its
healthy servers: a script's `vx run dev` hung for good, and the Ctrl-C
that ended it read 130 over the failure. A run with a failure elsewhere
now stops its servers and exits 1; a kept server's own crash ends the
wait as before; `--continue=always` holds as before, and so does the
watch loop (`holdPersistent`), whose next change restarts the server
anyway (`held-persistent.test.ts`, red without that exception). Rows
(`keep-alive.test.ts`): a server never ready and a dependency-only crash
each exit 1 with the healthy server dead (both hang without the fix,
the crash row with its clause removed), and the `--continue=always`
control holds (red with that exception removed). `cli.md` and
`execution.md` say so.

## C-59: the fingerprint watch reads a whole-second lockfile stamp

A's lead (A-2). The watch over the fingerprinted files skipped a file
whose ctime was more than `FILE_HASH_RACY_MS` (50 ms) older than the
run's read. On a file system that keeps whole seconds, a lockfile a
task rewrote 400 ms after the read is stamped to the second before it,
read as untouched, and every key after it kept the old lockfile's bytes:
a stale hit. The window now widens by A-2's `racyWindowMs`. Row
(`whole-second-stamps.test.ts` › the fingerprint watch's whole-second
stamp, simulated ctime): red without the fix; a sub-second stamp 499 ms
before the read stays trusted. `modules/fingerprint-watch.md` says so.

## C-57: a server watch holds keeps printing while watch idles

`vx watch dev` showed its server's log only until the cycle's run
returned: run() unsubscribed its renderer from the bus on the way out,
while the `holdPersistent` servers it handed back kept writing into it.
A run that hands servers back now keeps its renderer until the caller's
`stop` lands, and leaves the bus then. Row (`held-persistent.test.ts`):
a held server's line after the return reaches the logger (red without
the fix), and after `stop` the bus reaches it no more (red with the
detach removed); probed end to end (9 lines in 2.5 s, 2 before).
`cli.md` says so.

## C-58: two comments that claimed what the code does not

J's leads (J-65, J-78). `resolveCache` said one plugin layer "is used as
is", but a layer that does not wrap the local store is chained with it
at the tail; it now says only a single layer left is used as is.
`RunOptions.holdPersistent` said only the requested servers are handed
back; it names the ones a requested group stands for (C-52) and their
persistent dependencies (C-46). Comments only.

## C-61: run() refuses the numbers the CLI refuses

The CLI and the workspace config refuse a `concurrency` that is not a
positive integer, a `retries` that is not a non-negative integer and a
`timeout` outside 1..2^31-1 ms; the façade took any. `run({
concurrency: 0 })`, a negative or `NaN` left no worker slot open and the
run waited for good; `retries: NaN` retried a failing task without end
(3,745 attempts in 6 s); a bad `timeout` killed every task at once,
failed 143; and `tasks: []` read `No projects declare task(s): .`.
run() now refuses each up front, naming the value. Rows
(`run-concurrency.test.ts`): each refused with the exact message, the
edges run; red without the checks. The options' doc comments say so.

## C-65: the stop kills a running `cache.inputs.runtime` probe

A Ctrl-C while a task's `cache.inputs.runtime` probe ran (a slow
`docker version`, a hung `git`) waited for the probe: vx exited only at
the signal handler's bound, ~7 s (8,017 ms with a 30 s probe), and an
embedder's `RunOptions.signal` waited the probe out in full. The probes
are their own groups, killed at process exit (A-9) but not by the stop.
The run's stop now kills them (`stopRuntimeProbes`, cache/inputs.ts),
and a task whose `execute` rejects after the stop is `aborted`, with no
error line, where it read failed for the probe the stop cut short.
Measured: 1,021 ms. The kill is the stopping run's: probes are kept
per run (by its memo), so a second run in the process (an embedder's
`inflight` case) keeps its own (`abort.test.ts` › one run's stop leaves
another run's probe alone, red with the kill process-wide). Rows: `abort.test.ts` › the stop kills a running
probe (the run waits out the 30 s probe without the kill) and
`scheduler.test.ts` › a rejected execute after the stop (red without the
rejection arm's check; its control stays failed). `modules/scheduler.md`
says so.

## C-63: a plugin executor's throw from `execute` names the plugin

Every plugin hook's throw names the plugin and the hook (`accepts`,
`demand`, the factories; C-54 for `setup`); a throw from a plugin
executor's `execute` read `[vx] internal error in pkg-a#hello: pool
down`, naming neither. Its message now reads `plugin 'org/down'
(executor 'down') failed in execute: pool down`, in the frame and the
scheduler's line. The error object is kept (its class, cause and code),
so a refusal still prints plainly and a bug as an internal error.
Row (`plugin-capabilities.test.ts` › an executor's throw reaches the
task's own stderr): red without the fix. `modules/executor.md` says so.

## C-72: `--continue` rides no wire

`cli.md` § Failure propagation ended "The mode rides the wire, so
distributed runs honor it": the whole-run backend seam that carried it
went with vx cloud. The mode is the local scheduler's; a task a plugin
executor runs elsewhere is one dispatch like any other. Docs only.

## C-71: `--exclude-dependencies`' orders over random graphs, as a test

A probe over 60,000 random graphs found `excludeDependencies` sound;
it is now `exclude-dependencies-properties.test.ts` (2,000 seeded
graphs): every order between two scheduled tasks survives (item 1019),
a direct edge to a task still scheduled stays a real edge (item 980),
no edge names a task that left. The two rules mask each other on order
alone (item 980's mutant survived the first draft: the order-only walk
re-adds the edge), so the row checks the edge's kind too; each mutant
reddens it. `modules/task-graph.md` says so.

## C-67: an embedder's `command` reaches telemetry redacted

Item 1057 kept what follows `--` (often a token) out of the command line
telemetry sinks receive, but only for the argv fallback: an embedder's
`RunOptions.command` (`vx run deploy -- --token=…`) went to every sink
verbatim. It is now counted, not quoted, the same way. Row
(`telemetry.test.ts` › a sink never receives what follows `--`): red
without the fix. The option's doc comment says so.

## C-75: signals.md says the stop kills the run's probes

`modules/signals.md` described the stop's teardown as `terminateChildren`
alone; since C-65 it also kills the run's running `cache.inputs.runtime`
probes. Docs only.

## C-74: an executor's shared error is named once

C-63 names a plugin executor's throw by prefixing the error's own
message, so one error object an executor rejects several tasks with (a
failed connection it memoized) was prefixed once per task: the second
read `failed in execute: plugin 'org/down' (executor 'down') failed in
execute: pool down`. The prefix is now added once. Row
(`plugin-capabilities.test.ts` › one error an executor rejects two tasks
with is named once in each): red without the fix.

## C-73: architecture.md's end of run names the servers it keeps

`architecture.md`'s run walk-through kept "persistent tasks the user
REQUESTED, and the persistent tasks they depend on": it now also names
those a requested group stands for (C-52), that a run which failed
elsewhere keeps none unless `--continue=always` (C-60), and that what
they write streams through the wait (C-56). Docs only.

## C-77: a subscriber that leaves mid-emit no longer hides the event

`createEventBus` walked its subscriber array while a disposer spliced
it, so a subscriber that unsubscribed during an emit shifted the next
one into the slot the walk had passed. An embedder that subscribes
before the run and calls `off()` on `run:end` took `run:end` from the
terminal renderer behind it. The list is now replaced on subscribe and
unsubscribe, never mutated, so an emit walks the list it began with at
no per-emit cost; a subscriber added during an emit hears the next
event. Rows (`events.test.ts` › createEventBus): both red without the
fix. `modules/events.md` says so.

## C-76: the sandbox probe starts when a sandboxed task is sure to run

The probe (~220 ms of spawns on Linux) started on the first sandboxed
task to execute, so it sat on the critical path after the classify and
any upstream work. `run()` now starts it as soon as a sandboxed task is
sure to execute: one no cache can answer (no `cache`, reads off,
persistent) before the classify, a confirmed miss right after it. A run
whose sandboxed tasks all hit still never probes. The end of the run
waits for a probe still in flight before its reset: one that landed
after it left the runtime's proxies up, and an embedder hung (the CLI's
failure exit hid it). This repo's warm `vx run lint --all` (one
uncached sandboxed task): min 453 → 377 ms, median ~495 → ~440 over 12
interleaved runs per arm. Rows: `sandbox-prewarm.unsafe.test.ts`; each
half and the wait fail their row without themselves, and the control
fails an unconditional prewarm.

## C-80: no partial tree survives a failing run, over random graphs

`tests/continue-cache-properties.test.ts` runs 24 seeded random graphs
end to end, three runs each: a healthy run warms every entry; some
inputs change and some tasks fail (a flag outside every key) under one
`--continue` mode; a healthy run with the same keys. That run must
execute exactly the changed tasks the failing run did not save, and
every output must hold its healthy bytes: an output is its input plus
its deps' outputs, and a failure writes PARTIAL. `g`'s tasks have no
cache, so a hit above one restores ahead of its failure (C-1's shape).
Red when the taint is disabled (`out/t2.txt` replays PARTIAL) and when a
restore-tier hit releases its dependants before its deps settle (item
963's hold). Test only.

## C-85: a plugin executor's throw is the plugin's, not vx's internal error

Every pipeline stage turns a plugin's throw into a refusal naming the
plugin (`safe()`); a plugin executor's throw from `execute` kept its
class, so a plain `Error` printed `[vx] internal error in a#build:
plugin 'p' (executor 'e') failed in execute: boom`, calling the plugin's
failure vx's bug. `nameExecutorFailure` now returns a `UserError` with
that message and the plugin's error as its `cause`: printed plainly,
and a second task rejected with the same reason says `as <id> above`.
The plugin's own error is no longer renamed in place, so the C-74 guard
went with it. Rows (`plugin-capabilities.test.ts` › an executor's throw
reaches the task's own stderr; one error an executor rejects two tasks
with is named once in each, now read from each task's frame line): the
first red without the change, both red on the old rename without its
guard. `modules/executor.md`, `modules/plugin-host.md` and
`execution.md` say so.

## C-86: run() refuses a word or a shape the CLI would not pass

C-61 refused the façade's bad numbers; its words and shapes went
through. A probe of `run()` with what a JS embedder can pass: a
`continueMode` of `'sometimes'` ran as `deps-ok`, so a typo lost
fail-fast without a word; `outputLogs`, `download` and `flow` took any
string; a string `excludeDependencies` dropped nothing; a `projects`
string and a `signal` that is no `AbortSignal` died a `TypeError` inside
the run. `run()` and `planRun()` (which checked nothing) now refuse
each as a `UserError` naming the option, what it is and what it must be.
Row (`run-option-shapes.test.ts` › refuses a word or a shape the CLI would
not pass, at run() and planRun()): red without the change; its control
runs each word the CLI passes. `modules/orchestrator.md` says so.

## C-87: `--retry` says it never retries a server

`schema.md` said the run-level `--retry` "applies to tasks that don't
declare their own `retries`", and `cli.md` that it re-runs a failed
task; a persistent task declares none, and a probe with `retries: 2`
on a server that exited before it was ready ran it once and failed it,
as `exec.retries` on a persistent task is refused. Both now say it never
retries a persistent one. Docs only.

- **H:** `wireForwarder`, `toWireEvent`, `WireEvent` and `projectNode`
  (`orchestrator/events.ts`) have no caller but `tests/dev.test.ts`: the
  façade exports none of them, so the "serializable `WireEvent`" that
  `RunOptions.bus`'s comment says core ships reaches no embedder, and
  their comment cites a `createWireRenderer` removed with vx cloud.
  `TaskView` stays on the façade with nothing producing it. Export the
  wire form or remove it with `TaskView`: a contract call.

## C-64: say who hears `runEnd` twice

The logger's tail flush and three test comments said run() calls
`runEnd` twice so the renderer hears both; `busLogger` delivers
`run:end` once, so in the CLI the renderer hears one (C-56 met this: a
kept server's last partial line waited on a second call that never
came). The comments now say a renderer an embedder drives directly may
hear both. Comments and a row title only.

## C-66: a plugin hears nothing after its teardown

The normal path tore the plugins down before the keep-alive wait but
released their bus subscriptions (`ctx.on` handlers, telemetry sinks)
only in run()'s finally, after it: through a whole `vx run dev`
session a plugin's `onTaskStdout` heard the server after its own
`teardown()` had closed what it writes to. The subscriptions are now
released just before the teardown. Row (`keep-alive.test.ts` › a plugin
hears nothing after its teardown while vx holds a server): red without
the fix (`torn:AFTER`). `modules/plugin.md` says so.

## C-68: schema.md says which servers the end of the graph keeps

`schema.md`'s persistent semantics said the end of the graph SIGTERMs
every persistent subprocess; the foreground keeps the requested ones,
those a requested group stands for (C-52) and their persistent
dependencies (C-46), unless the run failed elsewhere (C-60). The bullet
now says so. Docs only.

## C-78: the taint rule holds over random graphs

`tests/taint-properties.test.ts` drives `taintTracker` over 3,000 seeded
random graphs, settling outcomes in any order (a restore-tier hit
settles before its deps) with partial asks between, and holds every ask
made once a task's ancestors have settled to a brute-force reference,
in both modes: `--continue=always` and seeds alone
(`--exclude-dependencies`), on the full-period PRNG of C-79. Mutants
caught: a clean answer memoized before its deps' answers were final
(C-23's rule), the memo kept unconditionally, `skipped` dropped from the poison set, the
seed check dropped from `judge`, and the tracker disabled when only
seeds are set. Survivors are equivalent (a seed's deps; the memo's
timing for a taint). Test only.

## C-79: the task graph over random workspaces, on a PRNG that does not cycle

`tests/task-graph-properties.test.ts` builds 2,000 seeded random
workspaces (package-graph cycles, sparse holders, `name`, `^name`,
`pkg#name`, `build.*`, `^build.*`, the odd typo and back edge) and holds
`buildTaskGraph` to a recursive reference: the same tasks, edges and
requested flags, and a refusal exactly where the reference refuses
(43%: cycles and missing tasks). Mutants caught: the declaring project
not seeding the `^` walk, a holder that does not stop it, the edge
dedupe, a pattern matching its own task, requested promotion, a pattern
holder's later matches, the pending list, and the undeclared-`^name`
refusal. Re-adding a pending node already added survives; it builds the
same graph.
Writing it found the PRNG the property files shared,
`(s * 1103515245 + 12345) % 2 ** 31` in floats, losing the product's
low bits past 2 ** 53 and cycling: seed 298 after 71 draws, 1019 within
11,079, so C-71's 2,000 graphs repeated. `tests/helpers/rng.ts`
(mulberry32, `Math.imul`) replaces it there, here and in
`summary-meters.test.ts` (whose `& 0x7fffffff` variant cycles after
10,726, past the 8,000 draws its sweep takes); `tests/rng.test.ts` holds
it to no cycle in a million draws and an even spread, both red on the
old one. C-71 still passes on the full-period stream. Test only.

## C-81: scheduler.md's restore-rank sentence reads

`modules/scheduler.md` said "A rank that can count a diamond twice which
only reorders restores among themselves", a clause with no verb (C-51's
note). It now says the rank can count a diamond twice and that this
only reorders restores among themselves. Docs only.

## C-82: a run with servers in it always ends and leaves no child

Probes of 190 and 120 seeded random graphs mixed one-shots that pass,
fail or take a while with servers that get ready, crash before or after
it, never get ready inside their timeout, or trap SIGTERM, under each
`--continue` mode, with and without `holdPersistent`, run to the end or
stopped by `RunOptions.signal` (SIGINT or SIGTERM) at a random moment:
every run ended and no child outlived it (or its held servers'
`stop()`). They are now `tests/persistent-lifecycle-properties.unsafe.test.ts`
(12 graphs each, ~9 s): red when the end of the graph does not SIGKILL
what outlives the grace, and both rows hang when the stop's teardown
does not. A dropped SIGTERM or a leader-only one survives: the SIGKILL
sweep still ends the groups, and graceful stops are not what these rows
hold. Unsafe for the liveness check. Test only.

## C-83: twenty runs in one process give back what they took

An embedder (`vx watch`, a daemon) runs many runs in one process. A
probe of 200 runs of a graph with a cached task, a server, a task on it
and a sandboxed task, alternating `handleSignals` and `holdPersistent`,
found the open descriptors and the signal and exit listeners steady
after the first runs and RSS flat at ~108 MB. `tests/repeated-runs.unsafe.test.ts`
holds twenty such runs to the fifth's counts: red without the cache
close (21 → 28 descriptors) and without the signal handlers' removal.
A run that skips the sandbox reset leaks none of these, so the row says
nothing about it. Test only.

## C-84: a teardown's throw is named as every stage's is

A probe threw from each plugin hook through `vx run`: every stage said
`plugin '<p>' failed in <stage>: <reason>` (C-54 for setup), and no
stack reached the user, except teardown, which said `plugin '<p>'
teardown failed: boom`. It now says `failed in teardown`; the run's
verdict still stands. Row (`plugin-teardown.test.ts` › a teardown that
throws is told by its message): red without the change.
`modules/plugin-host.md` says so.

## Probes and leads (2026-10-02)

Probe, not fixed (2026-10-02): a dependency server that exits non-zero in
the same instant the graph ends can read as the end-of-graph stop's kill:
`shutdownPersistent` judges "ended" before Bun has reaped it. 15 of 40
runs read green when the server exited 3 as its last dependant finished;
with 200 ms between them 40 of 40 failed it. One event-loop yield before
the check did not separate the cases (the stop's SIGTERM and the
server's own exit race), so the window stays; its dependants had passed.

Lead for E (watch): `watch-loop.test.ts` › "a server that rewrites a file
in its project is named after three restarts (item 948)" timed out once
on macOS (#2247, run 37056783434) and passed on its re-run; no output
was captured past the timeout.

## C-62: a server a Ctrl-C killed while it started is aborted

A Ctrl-C while a dev server was still starting read `failed (never
ready: exited, exit 130)`, with a failure recap and a "failed to become
ready" line, where every other task the stop kills is `aborted` (item
962). A readiness failure after the run's stop now returns `aborted`.
Row (`abort.test.ts` › a server still starting when the run stops is
aborted, not failed): red without the fix; probed through the CLI
(3/3 aborted). `cli.md` says so.

## C-70: the scheduler's promises over random graphs, as a test

Three probes this stream ran (C-51 to C-69) checked the scheduler and
the taint tracker over thousands of random graphs and found nothing;
a probe that confirms a thesis becomes a test. `scheduler-properties.
test.ts` runs 450 seeded graphs (restores, demotions, groups, pools, an
admission policy, failures, a stop, each `--continue` mode) against
what `modules/scheduler.md` promises, and 300 against the taint
tracker's definition. Each of three scheduler mutations reddens it:
the item-963 hold, the skipped-upstream skip, the stop's skip. It
draws from the full-period PRNG of C-79: the float LCG it first used
cycled within 15,000 draws, so most graphs repeated.

## C-88: what waits on a server that died mid-run no longer runs

A ready server that exited non-zero while the graph ran was failed only
at the run's end: its dependants not yet started ran against it, and
`--continue=never` kept dispatching. The scheduler takes
`serverDied(id)`, answered by run() from the persistent registry: a
dependant of a dead server skips, `blockedBy` the server, and under
`never` dispatch stops. Rows (`server-crash-fail-fast.test.ts`): the
`never` row red without the change, the `deps-ok` row red without its
half; `b`, which does not depend on the server, still runs under
`deps-ok`. `cli.md` and `modules/scheduler.md` say so.

## C-89: a task behind a group skips when the group's server dies

C-88 skipped a dead server's direct dependants not yet started. A group
finishes the moment its server is ready, so a task depending on the
group ran against a server that died mid-run. The scheduler's check now
follows groups to the server (`deadServerVia`), and the skip names it.
Row: `server-crash-through-group.test.ts` (a group over a group), red
without the change.

## C-69: a server that dies mid-run is said when it dies

A dependency server that crashed while its dependants ran (an `e2e`
against an `api#dev` that fell over) was named only at the end of the
run, `vx: api#dev exited with code 1 before the run stopped it`, while
the dependant's failures scrolled past with no word of why. vx now says
`vx: <id> exited with code <n> while the run went on` when it happens;
not once the graph is done (the end of the run and the keep-alive wait
say it), not under a stop, not for an exit 0. Rows
(`keep-alive.test.ts` › a persistent server that dies before the run
stops it): the crash rows read the new line first; each of the three
guards removed reddens a row. `schema.md` says so.

Open lead (2026-10-02): under `--continue=always` a task dispatched after its
server died (C-88) still saves: the taint reads settled outcomes, and a
ready server's says `success` until the run ends. A fix must record
whether the server was dead at the task's dispatch, so a grand-dependant
inherits it; not done.

## C-90: nothing built after a server died is saved under `--continue=always`

The lead filed with C-69's record. Under `always` a task downstream of a
failure runs but is never saved; a server that died mid-run is such a
failure (C-88), but its outcome said `success` until the run ended, so a
task dispatched after the death, and every task built on it, saved under
healthy keys, and the next healthy run replayed them as hits. `run()`
now seeds the taint at such a task's dispatch (`deadServerBehind`, now
shared with the scheduler), and the tracker carries it on. Row:
`always-dead-server-taint.test.ts`, red without the change (both the
dependant and its grand-dependant replayed). `cli.md` and
`modules/admission.md` say so.

Probe (2026-10-03, the supervisor's ask from E2's profile): the warm
no-op run's `record history` (~4 ms) and `close` (~3 ms), 20 hits.
Record history: the bundle's 21 inserts 0.85 ms (cold-process first
calls, index upkeep) and its commit 0.7 ms. Close: `closeDb` 1.1 ms is
the last connection's WAL checkpoint (0.03 ms with a second handle
open); `bun:sqlite` has no `db_config`, so `NO_CKPT_ON_CLOSE` is out
of reach, and holding a handle leaks a descriptor (O-10). The run
lock's release 0.6 ms (two async fs calls; a sync release would close
the window `run-lock-fs.test.ts` drives, a rewrite for 0.5 ms). Retention
plus flushes 0.6 ms; one transaction for them measured no gain (close
min 2.6 vs 2.6 ms, 15 interleaved runs per arm). Nothing shipped.

## C-91: a server's death held over random graphs

`tests/server-death-properties.test.ts`: 600 seeded graphs with groups
and servers that die at random points, all three modes. After a death
nothing depending on the server starts under `deps-ok`, nothing starts
under `never`, a skip charged to a server names a dead one, and every
task ends. Red when the `deps-ok` check or the `never` trip is removed.
The group walk survived here (a group finishes when its server is
ready, so the shape that needs it is rare in these graphs) and stays
held by C-89's row. Test only. The sync run-lock release (~0.5 ms) was
dropped: a sync call cannot be held pending, so the race row could not
be rewritten as asked, and the refusal rows inject through
`node:fs/promises`.

## C-92: a held server that dies after the run is said

`vx watch` sat on "watching" over a dev server that had exited 3: a run
that hands its servers back (`holdPersistent`) said nothing of a death
after it returned, while `vx run`'s keep-alive says
`vx: <id> exited with code <n>`. `run()` now watches each held server
and says a non-zero exit, but not one the holder's `stop()` caused, nor
again one that died during the graph. Rows
(`held-server-exit.test.ts`): the death row red without the change;
the stop() control red when the stop is not told apart. `cli.md` and
`execution.md` say so.

Probes (2026-10-03), `vx watch` edge cases, all clean: a server that
exits before it is ready fails the cycle, watch keeps watching and the
next change starts it; Ctrl-C while a held server traps TERM and INT
ends watch 0 after the kill grace with the server gone.

## C-93: a server slow to match `readyWhen` is said

A dependency server whose `readyWhen` never matched held its dependants
in silence: its output is hidden unless it fails, and with no
`exec.timeout` the wait never ends (a probe: 5.6 s and not one line). vx
now says once, after 10 s (`VX_READY_NOTICE_MS`), `vx: <id> not ready
after 10 s: waiting for a line matching /<re>/ (readyWhen)`, adding
`, with no exec.timeout` when nothing bounds it; not under a stop.
Rows (`ready-wait-notice.test.ts`): bounded and unbounded, red without
the change; a server ready in time says nothing. `schema.md`, the env
table in `cli.md` and the CLI-surface contract carry the variable.

Probes (2026-10-03), clean: a `readyWhen` that is no regex is refused at
load; the lifecycle property row widened to 240 seeds (120 run to the
end, 120 stopped at a random moment, every kind of server) found no run
that hung and no child that outlived its run.

## C-94: a watch cycle is named by a path that still exists

`sed -i` (and an editor that saves through a temporary file) fires the
temporary file's event first, so `vx watch` announced
`app sedzCKbWc; re-running...`, a name already renamed away, never the
`vx.config.mjs` the user edited. The judgement now lets a changed path
that still exists name the cycle before a gone one; a deletion names it
when nothing else changed. Rows (`watch-label-live-path.test.ts`, the
judge driven directly): red without the change; the deletion control
passes both ways. `cli.md` says so.

A temporary file created and removed with nothing else changed (vim's
`4913` write probe) still started a cycle; C-95 (#2502) takes it.

Lead for E (2026-10-03): a dependency server that dies mid-run is
counted failed at the run's end (`failServer`, item 1071, C-88), but
the failure recap never shows its last lines: the terminal logger keeps
a recap ring only for an outcome that completes `failed`, and a server
completes `success` when it becomes ready. The footer says `1 failed`
and `vx: <id> exited with code <n> before the run stopped it`, and the
"Failed:" section is absent, so why it crashed is nowhere in a broad
or CI log. The logger needs to keep a running server's ring until the
run ends and take the late verdict (a `taskFailedLate`-shaped call from
`run.ts`).

Probes (2026-10-03), clean: `vx watch` with a project added, deleted,
or moved away and back mid-watch; one added while another's config is
broken; a held server that crashes while the loop idles, or ignores
SIGTERM for 1.5 s (the next cycle's server still binds the port); a
dependency cycle and a self-dependency; two servers and their dependant
under `--concurrency 1`.

## C-96: one `VX_TIMING` table per watch cycle

Under `vx watch` the marks lived for the process: each cycle's table
reprinted every earlier cycle's rows, and its `startup` row ran from the
previous cycle's last mark, the idle wait included (1.4 s and 3.4 s for
a 10 ms cycle). `restartTimings()` (util/timing.ts) starts each cycle's
table. Row (`watch-timing.test.ts`): one `startup` row per table, timed
below the idle wait; red without the change. `modules/timing.md` and
the `VX_TIMING` row in `cli.md` say so.

Probes (2026-10-03), clean: a dependency that breaks and is fixed
mid-watch under `--filter`; a held dev server does not hold the run
lock; `--concurrency` refuses 0, negatives, fractions and words. By
design, not changed: under a `--filter` glob a new matching package
does not join a running watch (`cli.md` says the scope is resolved at
start); a server that exits 0 after ready is fine (`schema.md`);
`computeReverseDepCount` is O(E·N/32), 11.5 µs a task at 20,000 tasks
against 4.3 at 1,000, and runs only without history priorities.

## C-95: no watch cycle for a file born and gone since the arm

vim's `4913` write probe, or a tool's lock file, created and removed
after watch armed, read as a deletion and started a cycle with nothing
changed. `gitFiles()` (one `git ls-files` at the arm) lists what existed,
with every directory above a listed file (a first cut missed directories:
a project moved away whole is one event on its directory, and the cycle
dropping it never ran; caught by probe before merge). An ignored path,
or no inventory, is a deletion as before. Blind spot, said in the
source: a file born between a judgement and that cycle's keys, and gone
by the next judgement. Rows (`watch-transient-file.test.ts`): the born-
and-gone file and the gone directory, red without the change; controls
for a listed file, no inventory, and a new file still present.
A property row (`watch-judge-properties.test.ts`, 60 seeded sequences of creates, edits and deletes against a model of what the loop last saw) holds C-94 and C-95 together; the inventory rule's removal fails it.

## C-97: a submodule path no longer unignores a watch batch

`git check-ignore --stdin` refuses a whole batch (exit 128, "is in
submodule") when one path sits inside a submodule, and `gitIgnored` read
the refusal as nothing ignored: a pid file judged in the same window as
a write under the submodule started cycles again. It now asks with
`-v -n` (one record per path; a `!` match is not ignored), skips the
refused path by the record count and asks the rest; a refusal before
any record checks once for a work tree, outside one nothing is ignored
as before. Rows (`watch-ignore-submodule.test.ts`): the submodule path
first, two first, last, red without the change; controls without it and
outside a repository. `modules/cli-watch.md` says so.

Lead for the migrate stream (2026-10-03): `@vzn/vx-migrate`'s
`gitIgnored` (`src/tracked-outputs.ts`) has C-97's class: one path inside
a submodule makes `git check-ignore --stdin` exit 128 and the whole batch
reads as nothing ignored. Core's watch copy now skips the refused path
by `-v -n` record count (C-97, #2534); the same shape fits there.

Lead for the reapi stream (2026-10-03): `vx-reapi`'s
`materialise-concurrency.test.ts` › "output files are fetched and written
at once, each with its own bytes" saw a peak of 4 against 5 in one local
gate and passed on the re-run (a timing claim on concurrency, unproven).

## C-98: plugin-claimed root files are re-read when watch re-arms

The root files fingerprint plugins claim (item 971's set) were read once
at start: a plugin added to the workspace config mid-watch claimed its
file, the cycle ran under it, and an edit to that file started nothing
until a restart. `rediscover` now recomputes the set from the reloaded
workspace, and the loop reads it through a variable `rearm` replaces.
Rows (`watch-claimed-files.test.ts`): the mid-watch plugin, red without
the change (timed out); the file claimed at start, both ways. `cli.md`
says so.

## C-100: the admit stage's warnings say `[vx]` first

A plugin hook made to throw at each stage in turn (config, discover,
project, graph, key, schedule, admit, cache, executor, telemetry,
setup, teardown): every one names the plugin and the stage, no stack,
exit 1 where the stage is required and 0 where it fails open. Every
warning on the status line says `[vx]` first except admit's two, so a
plugin's failure read as task output in a CI log. Both now do. Rows
(`admit-warning-prefix.test.ts`, `buildAdmission` driven directly):
both lines pinned with `toEqual`, red without the change.
`modules/plugin-host.md` says so.

Probes (2026-10-03), clean: persistent tasks under `--affected` (a
server in an unaffected project joins as a dependency; a kept dev
server stays up); a held server's exit codes (0 → 0; 3, a SIGTERM, a
SIGKILL → 1, each named); watch keeps its server through a failed
initial cycle; random edit storms against a cached task, fast and with
edits mid-cycle, 22 rounds, the output always the final input; config
imports, direct and transitive.
More, clean: exit codes under each `--continue` mode, an unknown task
and a filter matching nothing (1 each); a 1,000-task workspace plans in
124 ms and restores warm in 27 ms of `run graph`; a workspace config
that breaks and is fixed mid-watch.

## C-99: a file gone from a nested repository is a watch deletion

C-95 (#2502) merged before its last commit: `git ls-files` lists a
nested repository (a submodule, a vendored clone) as one entry and never
the files inside, which keys read, so a file there that existed at the
arm and is gone read as born-and-gone and started nothing. Under a
nested repository (`inNestedRepo`) a gone path is a deletion; an
untracked one's `dir/` entry is stored without its slash. Row
(`watch-transient-file.test.ts` › "a file gone from inside a nested
repository starts one"): red without the change. `modules/cli-watch.md`
says so. Learned: the PR first carried a port of #2541 while main was red on
`plugin-exports-documented`; the port changed a plugin-api contract
record, and `api-break.unsafe.test.ts` failed the PR for a title with no
`!`. A ported fix that moves a contract record carries its `!`, or the
base is merged once the fix lands (done here).

## C-101: async plugin hints and sinks never crash a run

`demand` and `accepts` are synchronous executor hints. An `async
demand()` that rejected was an unhandled rejection: a stack of vx's own
frames and the run killed, exit 1 (reproduced). An `async accepts()`
answered a Promise, truthy, so the executor took every task and its
rejection went unheard (H-16's admit shape). `tellDemand` routes a
returned Promise's rejection through the throw path (named once, asked
no more); `selectExecutor` refuses a Promise from `accepts` by name. A
telemetry sink's `async onRecord` / `onRunSummary` had the same hole
(exit 1, a stack: observability breaking the run); a rejection now
disables the sink as a throw does, said once (`disable` gained a guard,
held by a row whose rejections are in flight together). A grep of
every plugin hook called without `await` leaves those five, all guarded. Rows (`placement-async-hints.test.ts`, `telemetry-async-hooks.test.ts`):
async demand and async accepts, red without the change; a sync-throw
demand control both ways. `modules/executor.md` and `modules/telemetry.md` say so.

Probes (2026-10-03), clean: Ctrl-C while a plugin's `setup` never
settles exits 130 in 0.1 s, and a settle that nothing can drive is named
("can never settle"); two `vx watch` loops in one workspace do not wake
each other. Refuted: a "leftover server" after `vx run … | head -1` was
the probe shell itself, its command line holding the marker it grepped
for (CLAUDE.md's `pgrep -f` rule); none outlived its run in 10 tries.

## C-102: the Linux watch tree skips `node_modules`, `.git` and `.vx`

Bun's recursive `fs.watch` on Linux is one inotify watch per directory
and descended into the trees the loop drops by name: this repo's root
arm held 4,657 watches where 435 matter, and a big `node_modules` meets
the OS limit (8,192 on many distros) and polls. On Linux the recursive
arm is now a tree of non-recursive watches (`treeWatcher`) that never
enters them; a directory that appears is watched and its contents
reported, one that goes or moves is dropped (an inotify watch follows
the inode); the arming walk throws at the watch limit so the pool still
polls. Arm 75 → 43 ms, min of 6 interleaved. Rows
(`watch-tree-linux.test.ts`): the ignored trees and the limit, red
without the change; a new directory and a move, both ways. The fake
`fs.watch` in `watch-rules.test.ts` gained `on`. `modules/cli-watch.md`
says so.
Checked: Bun's recursive form did not follow a symlinked directory either (an edit under the link's target: no event), so not following one is no change.

Probes (2026-10-03), clean at 20× their committed seeds on fresh seeds
(local only): the scheduler properties (3,000 graphs per `--continue`
mode, 6,000 taint graphs), the server-death properties (1,800 seeds,
the row's 60 s bound caps it there), the watch judgement (1,200
sequences).
C-103 (#2594), split out after #2578 merged at its first commit: dropping a gone path's watches walked every watch per
deleted path; a directory is watched before anything under it, so a
path with no watch has none below and costs one lookup (10,000
deletions under 400 watched directories: 432 → 164 ms CPU, min of 3,
interleaved).

## C-104: watches whose directory was removed and made again are re-armed

An OS watch holds an inode: after `rm -rf packages` and a restore, the
base's watch sat on the deleted directory and the root arm drops every
name but its own files, so watch said `watching 0 project(s)` and ran
no edit until a restart (CLI: output `ok3` after an `ok4` edit). Made
again inside one window, the re-read kept the dead project watches.
Each base is now watched from its nearest existing directory for the
next name down, and a re-arm replaces project, base and parent watches
whose directory changed, named by dev, inode and birth time (a freed
inode number went straight to the next directory: the same `ino`
twice, measured). Rows (`watch-recreated-dirs.test.ts`, five): each
guard's removal fails its row. `cli.md` says so. Probes the same hour,
clean: fail-then-fix with a cached task; `packages/` moved away and
back (the watch follows the inode).

Probes (2026-10-03), clean: random storms of directory trees made,
moved and removed, file edits and born-and-gone probe files against a
cached `src/**` task, 15 rounds on the native Linux tree (C-102) and 10
on the poller (`VX_WATCH_POLL=1`): the output always the final input.
The day's new timing-sensitive rows (claimed files, per-cycle timing, the Linux tree, async sinks and hints, submodule ignores, transient files, the judge property) ran 8 times idle and 4 beside six CPU burners: no failure.
Ctrl-C while a cycle stops a held server that takes 1.5 s to exit on SIGTERM: watch waits for it, exits 0 in 1.2 s, nothing left on the port.
Storm on the C-104 branch with whole-`packages/` restores (in one window and 2.5 s apart) mixed in, each round ending in an edit: 12 rounds, the output always the final input (before C-104 the first slow restore left watch at `watching 0 project(s)`).

## C-105: import and pending directories made again are re-armed

C-105 (#2634, split out after #2620 merged at its first commit), same class: a config import directory (a shared preset
outside the projects, item 949) restored after a removal kept its dead
watch; import directories joined the ancestor arms and the re-arm's
directory check (a sixth row); and a pending package directory (no package.json yet) replaced
kept its dead watch too; the base's names never change, so its watch
now re-arms when a pending entry's directory changed. First cut tried a
removal and a make: it passed locally (the two reached the base as
separate member changes) and failed in the gate (seen together), so the
row replaces the directory with one rename (POSIX renames onto an empty
directory), which no member change can catch; each guard's removal
fails it.

Probes (2026-10-03), clean, against `cli.md` and `caching.md`: a
Ctrl-C while a cached task has half-written its outputs leaves no
entry (the next run is a miss and rebuilds); two `vx run` at once take
turns on the run lock, the waiter says whom it waits for and is then a
hit, and a Ctrl-C'd run releases the lock at once; the three
`--continue` modes over a failing task, an in-flight sibling, a queued
sibling and a cached dependant at `--concurrency 2` give exactly the
documented outcomes, `always` saves nothing built on the failure (the
second run is a miss), and `never` skips a pending cache restore.

Probes (2026-10-03), clean: under `--continue=never` a failure while a
server is still starting lets the server reach ready (in flight), skips
its dependant as fail-fast and leaves no server process; `--affected`
marks both projects for a file `git mv`ed between them, the project of a
deleted file staged or not, and a branch's own project against `main`;
`vx watch --affected=main` across two branch switches runs one cycle
each and keeps the scope it resolved at start, as `cli.md` says.
