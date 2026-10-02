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

- **B:** `runner.test.ts` › "keeps a ready server alive past its
  readyWhen timeout" failed on #2054's Linux CI: `echo up` missed its
  150 ms readiness bound under load (`PersistentReadyError … within
150ms`). The bound is a claim about the box; a wider timeout with the
  sleep past it keeps the row's point.
- **F:** a kept server's crash after the summary exits 1, but the
  telemetry summary (`exitOk`) is emitted and flushed before the
  keep-alive wait, so a sink (the GitHub check run) reports success.

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
