# `src/util/settle.ts` — the end-of-run settle bound

## Purpose

A plugin's flush or teardown is I/O a third party wrote; it must not
hold the run's exit hostage. This is the deadline every end-of-run
await goes through (`plugin-host.ts`, `telemetry-host.ts`), and a
plugin's `telemetry()` consultation before the run too (item 921).

```ts
testTimerMs(name, defaultMs, zero = false): number // VX_TEST_<name>, else defaultMs
teardownTimeoutMs(): number                       // default 3000
settleWithin(p: Promise<unknown>, ms): Promise<boolean>
killGraceMs(defaultMs: number): number            // defaultMs
claimExitForSignal(): void                        // a signal's handler will end the process
exitClaimedBySignal(): boolean
dieOf(signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP'): void // die of it, waiting (1 s bound) for it to land
```

- `testTimerMs` is the one way a test shortens a run's timer:
  `VX_TEST_<name>`, a duration, read per call. It is undocumented and in
  no settings table (the kill grace, teardown bound and ready notice are
  fixed, 0.0.639); the suites that prove a deadline drive it instead of
  waiting the real one out. Zero is taken only where `zero` allows it;
  garbage, zero elsewhere and a value past `MAX_TIMEOUT_MS` fall back to
  the default rather than clamping: this is a BOUND, not a duration —
  clamping would honour "wait 24.8 days", and past the ceiling the delay
  becomes 1 ms and every flush times out.
- `teardownTimeoutMs` is 3 s (`VX_TEST_TEARDOWN_TIMEOUT`; `0ms` waits
  for nothing not already done).
- `settleWithin` returns true when `p` fulfilled before the deadline,
  false when the deadline won; the caller decides whether a lost result
  is worth a warning. A rejection before the deadline is not a timeout:
  it throws, so the caller reports the failure rather than a hang. One
  landing after the deadline won is swallowed rather than surfacing as
  an unhandled-rejection crash.

- `killGraceMs` is the SIGTERM→SIGKILL grace a run grants a child that
  ignores SIGTERM — the one-shot timeout escalation (`exec/runner.ts`),
  the signal teardown (`orchestrator/signals.ts`) and the end-of-run
  persistent shutdown (`orchestrator/persistent.ts`) share it, 2 s each.
  `VX_TEST_KILL_GRACE` shortens all three: each escalation test used to
  wait the full two seconds, a third of the suite's wall time, for a
  claim 200 ms proves.

- `claimExitForSignal` / `exitClaimedBySignal`: bin.ts exits once its
  verb has settled and both streams have ended, so a timer a config left
  cannot hold vx open. A signal's handler (`orchestrator/signals.ts`)
  exits by itself with the signal's code after the run it stopped is
  done, and the verb settles first with the run's verdict; the claim
  keeps bin.ts from exiting 1 ahead of it.

- `dieOf` is how vx and its hand-off die of a stop signal: listeners
  off, the signal sent to itself, then a synchronous wait until it lands
  (1 s bound, the caller's exit code the fallback). A kill can land after
  it returns (another thread took it, a tracer held it), and the
  `process.exit` right after it exited 130 instead (CI, PR #4867).
  `VX_TEST_SELF_SIGNAL_DELAY` sends it from a helper that late, the
  window `tests/signal-handling.test.ts` widens.

## Tests

`tests/util-settle.test.ts` (both deadlines and the grace knob);
`tests/timeout-bounds.test.ts`; `tests/exit-held-loop.test.ts` and
`tests/signal-handling.test.ts` (the exit claim).
