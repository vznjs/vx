# Workstream M — CI reliability (plan-2026-09-27)

## Survey, 2026-09-27

500 ci.yml runs (08:30–22:50 UTC): 397 green, 68 cancelled, 34 red.
Most reds were the PR's own diff, fixed before merge. Recurring on code
already on main: `strace: ptrace(PTRACE_LISTEN…)` (4 jobs; B's Next 24),
item 948's watch row (3, Linux shard-2, all before E-26), macOS keep-alive
and guard rows (4; B-9, B-10).

## Items

M-1. A red shard's cause never reached a reader. Every `bun test` printed
each passing row, so a job log ran ~9,500 lines; the failed task's recap
keeps its last 30, which were Bun's summary, and the error sat 300 lines
above it — past the last 5,000 lines a log reader (the GitHub MCP) fetches.
Item 948's three reds (runs 36336433473, 36339799487, 36344775273) have
their test name on record and nothing else. E-26's "the error body never
reached the log" is this: it did, above the window.

- All three reds precede B-9 (20:41 UTC), which closed a window where a
  SIGKILLed vx left a just-spawned group unlisted and alive — and the
  row's teardown then SIGKILLed vx mid-restart-storm. None in the 75 runs
  after it. A lead, not a proven cause; the next red will say.
- Fix: every task that launches `bun test` passes `--only-failures`; the
  recap now ends on the failing row's error.
- Row: `suite-coverage.unsafe.test.ts` › every task that launches bun
  test prints only its failures (red with any one launcher reverted).

M-2. `runner.test.ts` › the peak is the child's own: its heavy child
allocated a fixed 600 MB, and the floor withholds any peak under the
parent's own mark, which the shard's earlier files set. On macOS it read
as no peak (run 36356486722, `peakRssBytes` undefined). Reproduced on
Linux with a 700 MB parent hold; the child is now sized mark + 300 MB, as
its sibling row already was.

M-3. `undeclared-writes.test.ts` › control: the cached case dropped its
project and the workspace partition on macOS CI twice (runs 36326699119,
36336505992): `movedSinceKey` judged something moved, 38 ms in, with no
word of what. The row now carries what the task said, so the next red
names the input (proven with a mutant that moves `package.json`).
Unproven lead: `movedInput`'s item-1015 test compares a ctime against
`Date.now()`, two clocks; on Linux 1 of 3,000 writes after a `Date.now()`
stamped 3 ms before it (`fsClockNow` in watch.ts documents the same).

M-4. `task-glob-brackets.test.ts` › an upstream's hit sets aside the
route (escaped): on macOS CI (run 36358110806, `ws-f/otel-std-env`) the
second run read `p#build failed` where a hit was due, and the row's quiet
logger kept the reason. Thirty local runs stayed green. A failed outcome
now carries what vx said and the task's stderr (proven with a mutant that
breaks build's input).

M-5. A-20 let a same-project dependant into the restore tier when its
inputs missed the producer's outputs, ignoring where it WRITES: a
`route` writing `app/[id]/page.js` restored ahead of a `build` owning
`app/**`, beside that build's clean and extract. Under load (6 CPU
burners) 5 of 60 runs of M-4's row failed two ways: build's
`.vx-tmp-*` vanished (a hit read `failed`, the macOS red), or both hit
green and `app/[id]/page.js` was gone. Invariant 2 of
`overlapping-outputs-2026-09.md`, broken since A-20.

- Fix (`stable-keys.ts` `dependsOnSiblingOutputs`): a task whose own
  `outputs.files` meet another same-project task's stays unstable.
  `caching.md`, `modules/stable-keys.md`.
- Row: `stable-keys.test.ts` › stays unstable when its own outputs meet
  another task's (red without the fix). The stress: 0 of 60 with it.

M-6. M-2's row went red on macOS (run 36362997599): the heavy child
allocated 713 MB and read a 690 MB peak. The full allocation was a
platform claim the row did not need: its subject is that the child's own
peak is reported above the parent's mark (the sibling row pins the unit).
It now asserts a peak above that mark plus the slack. Still red with the
pre-M-2 fixed 600 MB under a 700 MB parent.

M-7. `util-settle.test.ts` › runs three concurrent deadlines in parallel
turned main red (run 36374404433, shard-11): three 60 ms budgets took
152 ms against a 150 ms bound. M-1's recap named it. A total is a claim
about the machine; a stalled loop delays all three timers alike. The row
now bounds the spread between the three settles (< 60 ms; serial is 120).
Red under a mutant that chains the calls; 0 of 40 under 6 CPU burners.

M-8. A sweep after M-7: 53 upper bounds on wall time under
`packages/*/tests/`. M-7's red had 90 ms of slack; one other row had
under 500: vx-reapi `executor-sweep.test.ts` › a stall that fires during
the re-attach backoff (honest ~200 ms, bound 350, broken ~500). Its stall
now lands in the third backoff (honest ~700, bound 1,400, broken ~2,100).
Red with the backoff deaf to the abort; 0 of 20 under 6 CPU burners. The
next tightest (`wedged.test.ts` 159 and 260, and
`signal-handling.test.ts` 984) keep 500 ms or more and never went red in
the survey.

M-9. `keep-alive.test.ts` › a server exiting 1 tears the other down: red
on macOS (run 36381538775, N-7's PR, a vx-migrate diff), the family the
survey counted four times. `other` exited 0.3 s after it started and vx
stopped `dev` within its 200 ms grace; the row checked `dev` alive only
after polling for its pid, and a loaded runner read it after the
teardown. `other` now exits once the row, having seen `dev` alive,
writes `go`. A 600 ms stall before the check reddened both rows without
it and passes with it.

M-10. `config-eval.test.ts` › a REJECTED evaluation does not poison a
later one: red on macOS (run 36390341211, C-35's PR, a save-lane diff),
"config worker did not answer within 250ms" on the first round, whose
budget also covers the worker's spawn. Linux reads that round at 5 ms
idle and ~40 ms under 8 CPU burners; the macOS figure is unproven. The
250 had to be shorter than the second round's sleep and nothing else:
now 1,000 against 1,200. Red with the clear moved out of the `finally`.

Main went red twice from two green PRs landing close together, each
tested against the main it branched from: B-15 × L-10 (a socket-dir
row, fixed by L) and F-42 × H-25 (a plugin API record without F-42's
new option, fixed in a81149e).

M-11. `execute-task.test.ts` › trusts recorded directories without
re-recording them: `recordOutputDirs` recorded `[]` on CI (#1662, run
36395618238, shard 10). The row stamped `dist` 501 ms back from now; a
stamp on a whole second widens the racy window by 1 s (2 s on an even
one, A-38), so one run in a thousand read `dist` as racy. The product
rule is right. The row now stamps an even second 4-6 s back. Reproduced
with the clock pinned so the old stamp fell on a whole second; red with
an even-second stamp 0-2 s old. `output-dirs.test.ts`'s `age()` already
steps off whole seconds.

M-12. `util-procfs.test.ts` › says yes exactly when /proc's own record
of this process carries our pid: `procfsIsOwn()` read false on main (run
36404065979, shard 2). `run-lock-fs.test.ts` mocks the util barrel with
`procfsIsOwn: () => false`; Bun rebinds that export in `procfs.ts`
itself for the rest of the process, and a second `mock.module` does not
undo it. Every later file in the shard, `helpers/alive.ts` included, saw
a foreign procfs. The mock now answers false only while its file runs.
Red running the two files in one process before; green after. It is the
only `mock.module` of a vx module.

M-13. `config-eval.test.ts` › a deadline inside a held round retires
the wedged worker (D-17): the load after the deadline spawns a fresh
worker under the 250 ms budget set for the wedge, the shape A-51 fixed
in its sibling row (red twice on macOS). A probe on that path, pinned
to one loaded CPU, took 233-5289 ms and missed 250 ms 14 times in 15
(idle: 23-39 ms). That load now runs under 4000 ms. A kept wedged
worker (the timer's terminate dropped) still fails the row, rejected
at 4000 ms. No other row expects a success under a small budget.

M-14. `keep-alive.test.ts` › a kill -9 in the persistent shutdown's
grace takes the server a dead shell left, and its twin (a never-ready
server … exits inside the grace). Cause, not flake: each server wrote
`late.txt` on a 1 s timer after its SIGTERM mark, and the row read the
file as "the server survived". The first row's kill comes after up to
1 s for the shell's pid, up to 2 s for its reap and 100 ms, so on a
loaded box the timer fired before the kill and a correct vx went red
(the lead below: a 1 s gap turns it red). The servers now trap SIGTERM
and live on, so only a SIGKILL ends them, and each row asserts the
server's pid dead within 5 s, with no timer in the claim. Both red with
`holdGroups` made a no-op (item 865's hold); 15 of 15 green with two
busy loops per core.

M-15. `sandbox-bridge-socket.unsafe.test.ts` › is removed when the task
ends: not root-caused; what was refuted, so the next probe starts past
it. The one recorded text (J-69, and D's gate) is SRT's, not the row's:
"Linux HTTP bridge socket does not exist: /tmp/claude-http-*.sock …
the bridge process may have died", thrown by SRT's wrap before the task
ran. SRT's host socat removes that socket when it exits, and it is a
plain child of the test process. Refuted here: the row's positive
racing its task (a task of `true` still sees the socket; bind is
47-55 ms idle, 150-254 ms with four busy loops per core, 4 of 4 green
pinned to one loaded CPU), SRT's start eating the poll (`initSandbox`
in `beforeEach` starts it), and a deferred `resetSandbox()` (a server
alive at reset) fired by the server's release after the next
`initSandbox`: 20 bridged tasks started 0-100 ms after that release,
twice, all ran, and a task after the reset was still sandboxed. No
test signals the test process's group or kills socat by name. SRT
throws this text only while a context holds a bridge whose socket is
gone: inside a `reset()` between its `rmSync` and clearing the context.
One such reset runs outside vx's `resetting`: `sandbox-trace-exit`
emits `exit` in the suite's process, and SRT's once-`exit` hook resets
unawaited. Refuted as the cause: that emit, or a bare unawaited
`SandboxManager.reset()`, followed by the next row's reset, init and a
bridged run, failed 0 of 100 (five processes, 2026-09-30). Left:
what killed SRT's socat, or unlinked its socket, in a loaded gate.

M-16. M-15's open question, one probe further: does anything but SRT's
own `reset()` end SRT's host bridge in the suite's process? The whole
unsafe suite under `SRT_DEBUG=1` (Bun 1.4.2, sandbox required): 149
bridge exits, every one `code 143` right after SRT's own "Sent SIGTERM
to HTTP bridge process", none unasked. Also refuted: a failed shard
signalling the suite. No `--continue` mode signals an in-flight task
(`graph/scheduler.ts`: even `never` lets in-flight tasks finish), so
the keep-alive shard failing in the same ~17:50 gate (M-14) sent the
unsafe suite's group nothing. Left as before: a reset racing
a wrap, or a signal from outside the gate.

M-17. The keep-alive grace rows, the class grepped after M-14: its two
rows are fixed on main, and a third, `keep-alive.test.ts` › a terminal's
Ctrl-C leaves the guard, so a kill -9 in the teardown still takes the
task, still carried the same fuse (`(sleep 1; echo late > late.txt) &`,
started before the row sees `pid.txt`). No failure of it is on record,
and it did not fail here: through vx's sandbox (the gate's shard, bwrap
under strace) the row's kill lands 208-224 ms after the fuse starts,
idle or beside four busy loops per core, and bare it passed 6 of 6
beside four per core. So its failure is not claimed; the timed claim
is removed. The task lives until a SIGKILL and the row asserts the
shell's and the child's deaths within 5 s. Red with the guard started
in vx's group (`detached: false`); 20 of 20 green with the other grace
rows beside two busy loops per core.

M-18. CI's `@vzn/vx-docs#build` died 137 after astro finished (run
36924217607, the item-925 class), and the tracer retry never fired: strace
names itself by its argv[0], the absolute path vx runs it by, so CI's
line reads `/usr/bin/strace: ptrace(PTRACE_LISTEN,…)` and
`STRACE_OWN_ERROR` (`/^strace: /`) missed it. The test's fake printed a
bare `strace: `. Also proven: under `--seccomp-bpf` strace 6.8 implies
`--kill-on-exit`, so a SIGKILLed strace takes the task (exit 137) despite
`-DD`, and B-11's "a tracer that dies leaves the command running" was
false. Fixed: the key takes a path prefix; the fake prints `$0: `. Four
retry rows red on the old key.

M-19. Two teardown hooks on bun's 5 s default timed out in a local
run of every test task beside four busy loops per core.
`output-dirs.test.ts` › nothing over the cap: the row (30 s bound) makes
8,193 directories and its afterEach removed them: 7.4 s and red under
that load, 51 ms once the row removes them itself. `scale-graph.test.ts`:
the afterAll's rm of the 2000-project tree took 4.2 s under load; it now
has a bound matched to that work, as its beforeAll does. No other
fixture of that size in the suites.

M-22. Under I/O load (as M-21) the unsafe suite's held-server row,
`sandbox-runtime.unsafe.test.ts` › a held server keeps its port through
its run's reset, met a refusal on the server's host port right after
its ready line, and every later row of the file timed out. Cause of the
first: the host side of a `localBinding` bridge is a socat vx spawned
and never waited for, so the task, and its ready line, could come first:
a product race. Fixed: the task starts once each host socat listens
(`/proc/net/tcp`, 5 s bound, skipped where /proc is not vx's), and the
host socat is resolved on vx's PATH like every tool vx runs (it was a
bare name, so the startup PATH's). `sandbox-port-bridge-ready.unsafe.test.ts`:
a fake `socat` starts the host listener 1 s late and a shell task marks
itself started at once; red 3 of 3 without the wait. The row's
`SandboxManager.reset` spy was restored only past its asserts, so the
red left it on for the rest of the file; it is restored in a `finally`
now (the file's other nine spies already were). Whether that spy made
the later rows time out is not proven.
M-23. `runner.test.ts` › keeps a ready server alive past its readyWhen
timeout failed on CI (run 37011271243, a PR touching no runner code):
`persistent task not ready within 150ms`. The row, and its twin › a
server ready before the deadline outlives it, need the child's first
line inside a 150 ms window, and a loaded sandboxed shard missed it, so
the row failed on its premise, not its claim. Both now use a 1 s window
and wait from the spawn to 250 ms past it. With the first line delayed
300 ms (the loaded box) the old rows fail 2 of 2 and the new pass; with
both of the timer's guards removed the new rows still fail 2 of 2.
Same class, same file: › a readyWhen timeout sends SIGTERM first set
each shell's TERM trap against a 100 ms window. A 200 ms start failed
the polite half; the deaf half passed by dying of the TERM it was meant
to ignore (nothing asserted the SIGKILL). Now the 1 s window, and the
deaf child's `signalCode` must be `SIGKILL`: with its trap removed the
row fails (`SIGTERM`), where it passed before. The class, grepped (a
trap or first write in a fresh shell against a deadline of 100-300 ms):
`runner.test.ts` › a timed-out command returns only once its group is
gone (106 ms with a 300 ms start), `task-timeout.test.ts`'s two trap
rows, `persistent-ready-timeout.test.ts` › a never-ready server that
ignores SIGTERM, `keep-alive.test.ts` › a never-ready server a dead
shell left: each red with a 300 ms shell start, green on a 1 s
deadline. The trap-and-exit-0 row passed red-forced, by 143, without
its case; it now asserts the trap's own line in `out.txt`.
M-20. `sandbox-runtime.unsafe.test.ts` › the proxy refuses a denied
domain the allow glob covers read curl's `000` for the first host, not
the proxy's 403, in a local run of every test task beside four busy
loops per core. SRT starts its in-sandbox bridges (`socat
TCP-LISTEN:3128` / `:1080`) in the background and evals the command at
once, so a networked task's first dial raced the listen: a product bug
any loaded run could meet. Fixed: a networked task's command waits until
both listen (`/proc/net/tcp{,6}`, ~5 s bound).
`sandbox-proxy-ready.unsafe.test.ts`: a fake `socat` starts the 3128
listener 500 ms late; red without the wait; a task with no network is not
held (control). Cost within noise: a networked `true`, min of 15
interleaved, 86 ms with the wait against 90 without, under load.
M-21. M-19's class under I/O load (two `dd … conv=fsync` loops beside
four busy loops): `affected.test.ts` › six thousand changed files timed
out its afterEach (bun's 5 s default), which removed the row's 6,000
files and their git objects; 11.1 s for the row and its hooks. The row
(30 s bound) now removes its root itself: the hook took 2.4 s before,
11 ms after, under the same load. No other row of the suites makes a
fixture past 1,500 files.

M-25. `watch-rules.test.ts` › fsClockNow — a write made right after it
is never "modified before" it timed out at 5 s on macOS CI (run
36794690005). The row samples 2,000 writes at five syscalls each: 0.36 s
here, 2.3 s under `strace -f`, past 5 s with load beside that (all
twelve shards under strace beside four busy loops), the shape a slow
sandbox gives every syscall. It now samples 2,000 writes or as many as
2 s holds, at least 100. With 400 µs injected per file syscall
(`strace -e inject=…:delay_enter=400`) the old row fails (6.8 s), the
new passes (2.2 s).
M-26. M-25's sweep (all twelve shards under `strace -f` beside four busy
loops) also timed out `foreign-flags.test.ts` › a Turbo or Nx verb names
what does it in vx: 22 `vx` starts in series, 1.6 s idle and past bun's
5 s there. They are independent, so they now run at once and the row
asserts the whole result set: 0.5 s idle; under the same strace and load
the old row fails (5.0 s) and the new passes (3.6 s). The sweep's other
5 s timeout, `ci-output.test.ts` › no escape sequence …, runs its verbs
in an order the state needs (miss, hit, failure, readers), so it is left;
`show-info.test.ts`'s sandbox line failed only because strace cannot
nest under strace.
M-24. M-23's class, the rest of it (a first write in a fresh shell
against a 300 ms deadline): `persistent-ready-timeout.test.ts` › a task
that overruns is SIGTERMed and › never-matching readyWhen + timeout
(`echo $$ > pid.txt`), and `execute-task.test.ts` › a TIMEOUT kill is a
real failure and IS retried (`echo x >> tries.txt`, once per attempt).
Each red with a 600 ms shell start, green on a 1 s deadline.

M-25. `sandbox-bridge-socket.unsafe.test.ts` › is removed when the task
ends, root-caused (M-15, M-16 left it open). A run whose server outlives
it defers SRT's reset to that server's release. A later run's
`initSandbox` found SRT up and kept it, so the release, landing during
the later run, reset SRT under it: its next wrap threw the gate's text,
"Linux HTTP bridge socket does not exist", or bwrap could not find the
socket (a release 20 ms into a bridged run, 3 of 3). An init now cancels
the deferred reset; the later run's own end resets. Row: a server
released after a later run's init leaves that run's sandbox up (red 3 of
3 without the fix). Not reproduced in the gate itself: a forced gate
beside 161 runs of the file was clean, and which earlier row's release
landed in it is not proven. The keep-alive grace rows (M-14, M-17) did
not fail again: 12 of 12 runs of the file beside a forced gate.

M-26. Probes, nothing shipped. macOS CI, 2026-10-02: of the last 200
completed CI runs, 7 were red: 6 on a commit or PR title the
Conventional Commits check refused, and 1 on a quoted-`exec` row that
macOS `sh` answers 1 where dash answers 127 (its PR's own, not on main).
None was a timing failure. `npm-launcher.test.ts` › a signal sent
to the launcher alone (macOS, run 36365513736): the launcher exits only
on its child's exit, so 130 with no `heard` means the binary's `sh` died
of the SIGINT without running its INT trap while waiting on a foreground
`sleep`. Not reproduced: the same script under `bash --posix` and dash
ran the trap 100 of 100 with the SIGINT landing anywhere in the loop.
macOS's `/bin/sh` is bash 3.2, not testable here; that it differs is the
open suspicion, not a cause.

M-27. `npm-pack.unsafe.test.ts` (ws-p's lead: `JSON Parse error` once in
a gate, npm 10.9.4). The helper parsed stdout and stderr joined, from
the first `[`. npm prints its update notice to stderr at exit when its
background registry check finishes before the command, a race a loaded
gate's slower pack loses: a `prepack` of `sleep 4` and no
`_update-notifier-last-checked` printed "New major version of npm
available! 10.9.4 -> 12.2.0" after the JSON, and the joined parse threw.
The JSON is now stdout's alone. Row: a fake npm whose stderr holds the
notice (red without the fix, the gate's error).

M-28. `sandbox-runtime.unsafe.test.ts` › a traced sandboxed one-shot
task's children die with vx that is descheduled after the spawn (I-9's
lead: ENOENT reading `/proc/<pid>/stat` after `isAlive`). `isAlive` sent
signal 0, then read the state, and took the read's ENOENT for "no
procfs, so alive"; but it reads only where procfs is this process's own,
so ENOENT there is a pid reaped between the two calls, and a dying child
read alive and then threw at the row's next read. Gone now reads dead,
and the row's session-leader read counts a vanished pid as no leader.
Row (`alive-helper.unsafe`): signal 0 held to "lands" for a pid with no
entry (red without the fix). macOS is unchanged: there
`procfsIsOwn()` is false and nothing is read. Also probed, nothing to
fix: both `wedged.test.ts` leads (`sent` 3 for 4, 0 for 1) counted RSTs
sent, which F-9 replaced with the peer's count of HEADERS.

M-29. `runner.test.ts` › an exec-wrapped process is the direct child
(E's lead: it read `JITWorker` at load 6.6). The row slept a fixed 50 ms
and read `/proc/<pid>/comm` once: until `sh` execs, comm is the forking
Bun thread's name or `sh` (an immediate read, 20 of 20: `sh`). The
poll that replaced it landed as #2302; a command with no exec still
reads `sh` at its deadline, so the claim holds without a time in it.

M-30. `output-memory.unsafe.test.ts` › stays flat while a never-ready
task floods stdout (D's lead: `long - short` read 140 MiB against 64,
`\r`). The rows read RSS, which holds what the allocator kept, not what
the runner retains: beside eight busy loops a 1 s probe read 81 MiB (41
idle), and a 3 s one grew 82 MiB in 1 of 3 runs with nothing retained.
The probe now reads the JS heap after a full GC: 1-2 MiB at either
duration, 8 of 8 runs clean beside eight busy loops, and 180-1,290 MiB
with a mutant that keeps every chunk (all three rows red).

M-31. Probes, nothing shipped. `watch-loop-members.test.ts` › a root
package.json's workspaces that add a glob watch the packages they name
(D's lead: an `until` past its 15 s once, 17 s): refuted that a new
member's `package.json` landing after its directory goes unseen (2 s
between them, green); both glob rows 6 of 6 beside eight busy loops.
Which `until` timed out was not recorded. `task-glob-brackets.test.ts` ›
an upstream's hit sets aside the route (F's macOS lead) is M-4 and M-5.

M-32. `runner.test.ts` › a readyWhen timeout sends SIGTERM first, and
SIGKILL to what ignores it: red on a docs-only PR's CI (run 37052235753,
`signalCode` null). The row read `child.signalCode` right after
`waitForDead`, which answers from the kernel (a zombie is dead); Bun sets
`signalCode` only when it reaps the child on its loop. A SIGKILLed
`sleep` read null there 4 times in 50, and SIGKILL 50 of 50 after
`exited`. The row now reads it after `exited`, bounded at 3 s; the only
site of the pattern.

M-33. `vx-reapi` `executor-sweep.test.ts` › the run stopping cancels the
Execute stream: found by a scan for fixed sleeps before an assertion,
not by a failure on record. The row stopped the run on a 200 ms timer
and read the server's cancel count 50 ms after; beside twelve busy
loops it failed 6 of 20 with `executes` 0 (the stop came before the
Execute was sent, so nothing was there to cancel). The fake's
`onExecute` now stops the run once it holds the call, the cancel count
is polled as its sibling rows do, and the unheard-stop bound is 5 s:
0 of 20 under the same load. The same scan's other timer-aborted rows
(`vx-github` 502 wait, `vx-otel` 503 wait) were 0 of 20 there.

M-34. `keep-alive.test.ts` › a SIGKILLed vx takes …'s backgrounded
server / child with it, and › a kill -9 while vx is descheduled: the
last keep-alive grace rows on M-14's fuse. Each grandchild wrote
`late.txt` one second after it started, and the row read the file as
"survived vx's kill -9"; the kill comes after the pid poll, so a slow
poll or kill on a loaded gate turned a correct vx red. With 1.2 s
before the kill the old rows fail 3 of 3; the grandchild now waits on
`go`, written once the row has seen it die (5 s bound, a zombie under
a sandbox's procfs), and the new rows pass 3 of 3 there and fail 3 of 3
with the guard's kill line made a no-op. The other gate row named with
it, `sandbox-bridge-socket.unsafe.test.ts` › is removed when the task
ends, is M-25's (#2255), with no failure on record since: 12 of 12 runs
of both files beside eight busy loops on four cores, current main.

M-35. `sandbox-bridge-socket.unsafe.test.ts` › is removed when the task
ends: the gate's text, "Linux HTTP bridge socket does not exist", has a
second cause, and M-25's cannot have been the gate's: no unsafe file
that runs before this one leaves a sandboxed server (bun runs them in
glob order; `repeated-runs`' server is unsandboxed). SRT's first
`initialize` registers once-only `exit`, SIGINT and SIGTERM listeners,
each an unawaited `reset()` that kills the bridges at once but clears
SRT's init promise only after its proxies close; an `initSandbox` in
between had `initialize` return early on the dying session, and the
next bridged run threw that text. A `process.emit('exit')` or
`('SIGINT')`, then an init and a bridged run, fails every time on
main. vx now takes the listeners over at that init and tracks the
reset each starts, which `initSandbox` already waits for. Rows (in a
child, as the emit takes the listener): red on main, the SIGINT row
with the gate's text; green with the fix. What sent the gate's suite
an `exit` or a signal before this file is not proven.

M-36. `util-settle.test.ts` › returns false for a promise that settles
just past the budget: CI read `true` after 97 ms (#2415). Not a stalled
loop (Bun fires expired timers in deadline order: 0 of 20 `true` with
the loop held 200 ms). The row armed the 80 ms resolve BEFORE
`settleWithin` armed its 20 ms deadline, so 60 ms off the CPU between
the two arms moved the deadline past it: with 70 ms spun there, 20 of
20 `true`. `pastDeadline` arms the late settle after the call, so it
always expires later: 0 of 20 with the same gap. Its three siblings of
the shape (a late rejection, a neighbour's timeout, `ms = 0`) take it
too; all four are red with the deadline made ten times late.

M-37. Probes, nothing shipped. `select.test.ts` › only an INCLUDED diff
makes the selection diff-chosen timed out at 5 s on #2412's CI
(shard-12, "killed 1 dangling process"). Not slowness: the row takes
0.15-0.41 s under `strace -f` beside eight busy loops (junit, 5 runs),
the file 211 ms bare. A child outlived it. Not reproduced: 100 bare
runs and 60 under `strace -f` beside eight busy loops, and 8 forced
sandboxed runs of its shard (now 11) beside four. The row spawns
`rev-parse`, `merge-base`, `diff`, and the enumeration's `ls-files`
and `status`; none read stdin. Bun closes a spawn's stdin for an empty
buffer too (`cat` exits). Refuted too: `affected.ts`'s `gitPaths`
reading stdout to its end before stderr, and `mergeBase` never reading
its piped stderr, as a pipe deadlock. Bun drains a piped stderr on its
own: a fake git that wrote 200 KB of stderr before its diff settled
on main. The child's name is what the next sighting needs.
Also seen once, in this entry's own gate on main:
`repeated-runs.unsafe.test.ts` › twenty runs … hold their descriptors
read 18 open descriptors after run five and 17 at the end (listeners
steady). Not reproduced: 30 runs of the file beside eight busy loops,
3 of the 34 unsafe files up to it, 2 of the whole unsafe suite with
each descriptor named. Refuted: a killed child's pidfd still open at
the snapshot (each run's reset SIGTERMs SRT's socat and does not await
its exit). Six sandboxed runs read the same pidfd, socket and pipe count
right after `run()` returned and 300 ms later.

M-38. Probes, nothing shipped. The one other first-attempt CI failure
in the last 120 runs (2026-10-03, to 02:05): `runner.test.ts` ›
settle() lets a grandchild that traps the SIGTERM finish inside the
grace, macOS only (#2405, D's lead), `settle()` back at 133 ms with
no marker, so the trapping shell was gone within the 600 ms grace.
Refuted: a memoized grace (`killGraceMs` reads the env each call) and
`goneGroups` (nothing here marks the group). Not reproduced: 30 runs
on Linux with `sh` as `bash --posix` beside eight busy loops. macOS's
`sh` is bash 3.2 and is not here to probe.

M-39. The plugin suites' timed waits (vx-otel, vx-github, vx-mcp,
vx-lockfile, vx-migrate), swept for a timer standing in for a state.
Three rows claimed "a deadline during the retry wait ends it" with an
abort on a 50 ms timer from the call's start and a 150 ms bound on the
whole call: `collector.test.ts` › a deadline during the wait ends the
retries and warns the 503, and `github.test.ts` › … warns the 502 and
› a drop, then the deadline during the wait. The timer could beat the
first POST, and the bound counted the POST and any stall. The abort is
now armed by the first POST (vx-otel's from its fake collector, behind
a 2 s Retry-After), and the bound runs from the abort. With an 80 ms
collector or a 160 ms stall in the first POST the old rows fail and
the new pass; each new row fails with the sink or check-run posting
again after the abort, or with the abort not heard in the wait. The
rest hold: the other waits are polls on a state or a hang a client
abort releases.

## Leads for other streams

- A: A-20 let a same-project dependant restore ahead of a producer whose
  output tree holds its outputs; M-5 closed it in `dependsOnSiblingOutputs`.
  Any further narrowing of that gate keeps the write overlap in view.
- L: the L-6 row (`sandbox-runtime.unsafe.test.ts`, one task's unixSockets
  grant) ran `socat` on macOS CI and failed "command not found" (run
  36359822591); it needs the sandbox availability gate the other rows use.
- J: `npm-launcher.test.ts` › a signal sent to the launcher alone reaches
  the binary: macOS CI, run 36365513736 (`ws-l/sandbox-private-tmp`, a diff
  that does not touch the launcher). The launcher exited 130 and the fake
  binary's INT trap never wrote `heard` (ENOENT). Once in the survey; cause
  unproven. The forward is gated on `inForeground()`, which reads `ps` on
  macOS. Twice more on main's macOS job (runs 36767290231, 36785326912,
  2026-09-30), both before the launcher moved to CommonJS and `execve`
  (#1979, #1981, 2026-10-01); none in the CI runs surveyed after them
  (2026-10-01 06:00 to 2026-10-02 15:30).
- B (done, M-14): `keep-alive.test.ts` › a kill -9 in the persistent shutdown's grace
  takes the server a dead shell left. The server writes `late.txt` 1 s
  after its SIGTERM mark, a timed fuse, and the row's kill comes after
  the shell's reap plus 100 ms: a gap of 1 s before the kill turns it
  red (`late.txt` exists), 100 ms passes. B-38 gated row 620's child on
  a `go` file written after its death; this row needs the same. E's
  sandboxed gate saw a keep-alive grace row fail once at ~17:50.
- B (root-caused, M-25): `sandbox-bridge-socket.unsafe.test.ts` failed once in E's gate
  (~17:50), error not recorded. Not reproduced: 2 full sandboxed gates
  and 5 runs under 16 CPU hogs. The bridge socket binds 30-60 ms after
  the run starts (120-350 ms under load) against the row's 1 s task
  and 2 s wait. The failure text is needed to go further.
