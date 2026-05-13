# `src/orchestrator/run-artifacts.ts` — `--summarize` + `--profile` writers

## Purpose

Write the two optional run artifacts:

- **`--summarize[=<path>]`** — per-run JSON describing every task's
  outcome.
- **`--profile[=<path>]`** — Chrome-trace JSON for `chrome://tracing`
  / Perfetto visualization.

Both are no-ops when the corresponding `RunOptions` field is
undefined.

## Public surface

```ts
export interface SummarizeArgs {
  target: string // '' = default; else absolute or cwd-relative
  cacheDir: string
  cwd: string
  runId: string
  startedAtMs: number
  endedAtMs: number
  totalMs: number
  outcomes: readonly TaskOutcome[]
}

export interface ProfileArgs {
  target: string // 'profile.json' default chosen by CLI parser
  cwd: string
  outcomes: readonly TaskOutcome[]
}

export function writeRunSummary(args: SummarizeArgs): Promise<string> // returns final path
export function writeRunProfile(args: ProfileArgs): Promise<string> // returns final path
```

Both writers return the absolute path actually written; the
orchestrator surfaces it via `log.status(`vx: summary written to ${p}`)`.

## `writeRunSummary`

Default path: `<cacheDir>/runs/<runId>.json`. Explicit path is
resolved against `cwd` (so a relative `--summarize=./summary.json`
DTRT).

Output shape — see [`cli.md` § `--summarize`](../cli.md#--summarize-path).
hrtime fields are stringified bigints (preserves ns precision through
JSON). `summary` block aggregates totals (successful / failed /
skipped / cachedLocal / cachedRemote / total).

## `writeRunProfile`

Chrome-trace format. One `ph: 'X'` event per task with `ts` and
`dur` in microseconds derived from `wallclockStartNs` /
`wallclockEndNs`. Tasks with missing hrtime data (legacy outcomes,
group tasks) are skipped.

Each project gets its own `tid` so overlapping tasks across packages
render on distinct lanes. The shared `pid: 1` is arbitrary.

`cat` carries the task's final status (e.g. `cache-hit`, `failed`)
so trace viewers can color-code.

## Errors

Both writers throw on FS failure. The orchestrator catches and surfaces
via `log.status` but does NOT fail the run — the work already
happened; an inability to write an audit artifact shouldn't change
the exit code.

## Tests

`tests/orchestrator.test.ts` covers:

- Summary written to default path when `--summarize` has no value.
- Summary written to explicit path when `--summarize=foo.json`.
- Profile written, parseable as JSON, tasks have monotonic `ts`.
- Hrtime bigints preserved as strings.
- Profile writers skip tasks without hrtime spans.
- Group tasks excluded from both outputs.

## Replacing this module

The two writers are independent. To replace `--profile` output (e.g.
emit OpenTelemetry instead), swap `writeRunProfile` and keep
`SummarizeArgs` / `ProfileArgs` shapes. The orchestrator only knows
about the two `target` fields.
