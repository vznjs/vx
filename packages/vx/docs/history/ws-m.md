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
