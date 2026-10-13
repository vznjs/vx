# `src/util/settle.ts` — the end-of-run settle bound

## Purpose

A plugin's flush or teardown is I/O a third party wrote; it must not
hold the run's exit hostage. This is the deadline every end-of-run
await goes through (`plugin-host.ts`, `telemetry-host.ts`), and a
plugin's `telemetry()` consultation before the run too (item 921).

```ts
interface SettleBound { ms: number; from: 'flag' | 'workspace' }
setSettleBounds(b: { teardown?: SettleBound; killGrace?: SettleBound }): void
teardownTimeoutMs(): number                       // default 3000
settleWithin(p: Promise<unknown>, ms): Promise<boolean>
killGraceMs(defaultMs: number): number            // run.killGrace, else defaultMs
claimExitForSignal(): void                        // a signal's handler will end the process
exitClaimedBySignal(): boolean
```

- `setSettleBounds` takes the run's `run.teardownTimeout` and
  `run.killGrace` from its flag or `vx.workspace`, resolved by the
  orchestrator (`run-settings.ts`): util sits below `settings.ts`. The
  flag beats the variable, which beats the workspace.
- `teardownTimeoutMs` reads `VX_RUN_TEARDOWN_TIMEOUT` per call (a test
  drives the deadline instead of waiting it out); `0ms` waits for
  nothing not already done. Out-of-range falls
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
  `run.killGrace` (`VX_RUN_KILL_GRACE`, `--kill-grace`) overrides all three, read per call and bounded the same way (zero,
  garbage and a value past the timer ceiling fall back). It exists for
  the tests that prove the escalation: each used to wait the full two
  seconds, a third of the suite's wall time, for a claim 200 ms proves.

- `claimExitForSignal` / `exitClaimedBySignal`: bin.ts exits once its
  verb has settled and both streams have ended, so a timer a config left
  cannot hold vx open. A signal's handler (`orchestrator/signals.ts`)
  exits by itself with the signal's code after the run it stopped is
  done, and the verb settles first with the run's verdict; the claim
  keeps bin.ts from exiting 1 ahead of it.

## Tests

`tests/util-settle.test.ts` (both deadlines and the grace knob);
`tests/timeout-bounds.test.ts`; `tests/exit-held-loop.test.ts` and
`tests/signal-handling.test.ts` (the exit claim).
