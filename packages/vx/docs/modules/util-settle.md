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
```

- `teardownTimeoutMs` reads `VX_TEARDOWN_TIMEOUT_MS` per call (a test
  drives the deadline instead of waiting it out). Out-of-range falls
  back to the default rather than clamping: this is a BOUND, not a
  duration — clamping to `MAX_TIMEOUT_MS` would honour "wait 24.8
  days", which defeats it, and past the ceiling the delay becomes 1 ms
  and every flush times out.
- `settleWithin` returns whether `p` settled before the deadline; the
  caller decides whether a lost result is worth a warning. A rejection
  landing after the deadline won is swallowed rather than surfacing as
  an unhandled-rejection crash.

- `killGraceMs` is the SIGTERM→SIGKILL grace a run grants a child that
  ignores SIGTERM — the one-shot timeout escalation (`exec/runner.ts`,
  2 s) and the end-of-run persistent shutdown
  (`orchestrator/persistent.ts`, 2 s) share it. `VX_KILL_GRACE_MS`
  overrides both, read per call and bounded the same way (zero,
  garbage and a value past the timer ceiling fall back). It exists for
  the tests that prove the escalation: each used to wait the full two
  seconds, a third of the suite's wall time, for a claim 200 ms proves.

## Tests

`tests/util-settle.test.ts` (both deadlines and the grace knob);
`tests/timeout-bounds.test.ts`.
