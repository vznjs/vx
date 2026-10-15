# `src/orchestrator/run-artifacts.ts` — `--profile` writer

## Purpose

Write the optional `--profile[=<path>]` artifact: Chrome-trace JSON for
`chrome://tracing` / Perfetto. A no-op when `RunOptions.profile` is
undefined.

## Public surface

```ts
export interface ProfileArgs {
  target: string // 'profile.json' default chosen by CLI parser
  cwd: string
  outcomes: readonly TaskOutcome[]
}

export function writeRunProfile(args: ProfileArgs): Promise<string> // returns final path
```

It returns the absolute path written; the orchestrator prints it above
the footer.

## `writeRunProfile`

Chrome-trace format. One `ph: 'X'` event per task with `ts` and
`dur` in microseconds derived from `wallclockStartNs` /
`wallclockEndNs`. Tasks with missing hrtime data (group tasks) are
skipped.

Each project gets its own `tid` so overlapping tasks across packages
render on distinct lanes. The shared `pid: 1` is arbitrary.

`cat` carries the task's final status (e.g. `cache-hit`, `failed`)
so trace viewers can color-code.

## Errors

The writer throws on FS failure. The orchestrator catches and surfaces
it but does NOT fail the run — the work already happened.

## Tests

`tests/run-artifacts.test.ts` (profile written and parseable, tasks
without hrtime spans skipped) and `tests/contract-profile-wire.test.ts`
(the trace's shape).
