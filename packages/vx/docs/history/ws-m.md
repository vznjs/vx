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
  macOS.
