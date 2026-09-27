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

## Leads for other streams
