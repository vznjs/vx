# `src/util/settle.ts` — the end-of-run settle bound

## Purpose

A plugin's flush or teardown is I/O a third party wrote; it must not
hold the run's exit hostage. This is the deadline every end-of-run
await goes through (`plugin-host.ts`, `telemetry-host.ts`), and a
plugin's `telemetry()` consultation before the run too (item 921).

```ts
teardownTimeoutMs(): number                       // default 3000
settleWithin(p: Promise<unknown>, ms): Promise<boolean>
killGraceMs(defaultMs: number): number            // VX_KILL_GRACE_MS, else defaultMs
claimExitForSignal(): void                        // a signal's handler will end the process
exitClaimedBySignal(): boolean
noteStopping(): void                              // a Ctrl-Z's stop begins (SIGTSTP handler)
noteResumed(): void                               // and ends (SIGCONT handler)
runningTimeout(fn, ms): { clear(): void }         // setTimeout that counts no stop
```

- `teardownTimeoutMs` reads `VX_TEARDOWN_TIMEOUT_MS` per call (a test
  drives the deadline instead of waiting it out). Out-of-range falls
  back to the default rather than clamping: this is a BOUND, not a
  duration — clamping to `MAX_TIMEOUT_MS` would honour "wait 24.8
  days", which defeats it, and past the ceiling the delay becomes 1 ms
  and every flush times out.
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
  `VX_KILL_GRACE_MS` overrides all three, read per call and bounded the same way (zero,
  garbage and a value past the timer ceiling fall back). It exists for
  the tests that prove the escalation: each used to wait the full two
  seconds, a third of the suite's wall time, for a claim 200 ms proves.

- `claimExitForSignal` / `exitClaimedBySignal`: bin.ts exits once its
  verb has settled and both streams have ended, so a timer a config left
  cannot hold vx open. A signal's handler (`orchestrator/signals.ts`)
  exits by itself with the signal's code after the run it stopped is
  done, and the verb settles first with the run's verdict; the claim
  keeps bin.ts from exiting 1 ahead of it.

- `noteStopping` / `noteResumed` / `runningTimeout`: a Ctrl-Z stops a
  run's tasks with vx (`signals.md`), so a task's `exec.timeout` and a
  persistent task's readiness deadline (`exec/runner.ts`) count only the
  time vx ran. A wall-clock timer that came due during the stop fired the
  moment vx resumed; this one, when it fires, re-arms for the stopped
  time noted since it was armed. One that fires between the two notes is
  parked until the resume: on the resume a due timer runs ahead of the
  SIGCONT handler. The stop is not measured around vx's own SIGSTOP:
  that return is no proof the stop landed, and on macOS such a stop
  counted nothing (CI, 2026-10-08).

## Tests

`tests/util-settle.test.ts` (both deadlines and the grace knob; a timer
due during a stop waits for the resume);
`tests/timeout-bounds.test.ts`; `tests/exit-held-loop.test.ts` and
`tests/signal-handling.test.ts` (the exit claim; a stop longer than
the timeout fails neither a one-shot task nor a readiness wait).
