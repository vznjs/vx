# `src/report/logger.ts` — pluggable logging surface

## Purpose

Provide a small `Logger` interface that the orchestrator + scheduler
call through, and a `defaultLogger()` implementation that applies the
flow-aware output policy (focused / broad / full) on top of the
framed-block renderer. Programmatic embedders can pass their own
`Logger` to capture machine-readable output.

## Public surface

```ts
export interface Logger {
  status(line: string): void // header / summary / status lines
  warn?(line: string): void // a warning; the default logger writes it to stderr, a logger without it gets it through status
  taskStdout(node: TaskNode, chunk: string): void // streamed stdout chunk
  taskStderr(node: TaskNode, chunk: string): void // streamed stderr chunk
  taskComplete(node: TaskNode, outcome: TaskOutcome): void // flush block
  // Optional lifecycle hooks — drive the default logger's live status
  // region; custom loggers may omit them.
  runStart?(info: {
    total: number
    concurrency?: number // one worker row per slot
    requestedCount?: number
    context?: RunContext // the live summary section's context
    startedAtMs?: number
  }): void
  taskStart?(node: TaskNode, info?: { waitedMs?: number }): void // waitedMs: how long it sat ready for a slot, when it did
  runEnd?(): void // the graph is done; vx's closing steps follow
  stepStart?(id: string): void // one of vx's own steps (`vx:keys`) began; never a task
  stepEnd?(id: string, info: { durationMs: number; ok: boolean }): void
  runDone?(): void // the run's work is done; the footer follows
  runStop?(): void // the run was stopped (a signal, an abort); idempotent
}

export interface OutputView {
  mode: 'full' | 'errors-only' | 'none' | 'focused' | 'broad' | 'hash-only'
  gha?: boolean // GitHub Actions: fence task text; in full mode, ::group:: blocks
  ci?: boolean // truthy CI env — suppresses the status line
}

export function resolveOutputView(
  options: {
    outputLogs?: 'full' | 'errors-only' | 'none' | 'hash-only'
    flow?: 'focused' | 'broad'
  },
  env?: Record<string, string | undefined>,
): OutputView

// What run() builds when no logger is passed.
export interface DefaultLogger extends Logger {
  settle(): void // hand over coalesced output; write straight through from now on
  readonly showsSteps: boolean // only where the live region draws; else run() times no step
  forecast(graph: () => Forecast, load: () => Promise<Forecast | undefined>): void // `graph` (no history) at the first free row; `load` only if the live region is still up 1 s in
  holdStatus(): () => void // no live region until the release: a secret prompt waits on the terminal
}

export function defaultLogger(
  colors?: ColorSupport,
  view?: OutputView, // default { mode: 'full' }
  out?: StatusStream, // default process.stdout
  // forwardArgs: the args after `--`, shown on a requested task's `$` line
  opts?: {
    forceFloorMs?: number
    coalesce?: boolean
    tty?: boolean
    env?: Record<string, string | undefined> // names the terminal for OSC 9 / 9;4 / 8; default process.env
    forwardArgs?: readonly string[]
    err?: StatusStream // where warnings go; default process.stderr
  },
): DefaultLogger

// log.warn, or log.status for a logger without it
export function warnOf(log: Logger): (line: string) => void

// path-links.ts: the path pattern both share
export function linkPaths(text: string, dir: string, isFile: (abs: string) => boolean): string
export interface OutputLocation {
  file: string // absolute
  line?: number
  col?: number
}
// the existing files a text names, { file (absolute), line?, col? }, unique, first 50
export function fileLocations(
  text: string,
  dir: string,
  isFile: (abs: string) => boolean,
): OutputLocation[]
export function fileMemo(): (abs: string) => boolean

// forecast.ts: the live ETA from history p50s (none: the graph alone,
// what is blocked and by what, no ETA); the later of the longest
// unfinished chain and the unfinished work spread over the workers. The
// same pass lists `blocked`: up to one task per worker that an unfinished
// dependency holds back, ranked as the scheduler ranks
// (the run's dependents count, read back with the graph), each `by` the running task its
// longest chain waits on, else that dependency; `blockedBy`, per running
// task, the tasks not started that depend on it directly. A running task
// past its p50 costs zero: an ETA of zero with tasks running is the region's
// `+Ns over`, counted from when it reached zero.
export interface BlockedTask {
  id: string
  by: string
}
export function createForecast(
  nodes: ReadonlyMap<string, TaskNode>,
  p50s: ReadonlyMap<string, number>,
  concurrency: number,
  rank?: ReadonlyMap<string, number>, // the scheduler's baseline and each row's `blocks`; `computeReverseDepCount(nodes)` by default
): Forecast
```

## View resolution (priority order)

1. Explicit `--output-logs` → that mode.
2. Truthy `CI` env (`CI=0` and `CI=false`, in any case, excluded) → `full`.
3. CLI-detected flow (`RunOptions.flow`) → `focused` or `broad`.
4. Nothing (programmatic callers) → `full`.

`gha: true` is attached whenever `GITHUB_ACTIONS` is truthy, whatever
the mode; `ci: true` whenever `CI` is truthy.

## Default logger behavior by mode

- **`full`** — frames for executed work / failures,
  one-liners for skips and quiet cache hits, frames for hits with replayed
  stdout. With `gha`, non-failed blocks are wrapped in
  `::group::<id> (<outcome word> <duration>)` … `::endgroup::`;
  failed blocks stay ungrouped and are preceded by
  `::error title=<id>::failed (exit N)` (`failedLabel`: above 128 the
  signal is named, `failed (exit 137, 128 + SIGKILL)`; a timeout its
  reason, `failed (timed out, exit 143)`; a persistent task that never
  became ready, `never ready: …`; a sandboxed task its violation count).
- **`focused`** — requested non-group nodes stream stdout/stderr raw
  and live (cache-hit replay included); a quiet hit prints a full
  frame; a skipped requested task prints the skipped one-liner
  with its blocker (`• blocked by lib#build`). Dependency-pulled
  nodes are silent on success/hit and fully framed on failure.
- **`broad`** — executed tasks print one
  ` ⏺ <time> success miss <id>` row (`no-cache` for a task no cache
  answered for, `ranNoCache`); failures get full frames;
  hits / up-to-date / skipped are silent (buffers dropped).
- **`errors-only`** — only failed tasks print.
- **`hash-only`** — one line per task with its key, no output.
- **`none`** — no per-task output.

A task handed the terminal (`exec.interactive`, with `defaultLogger`'s
`tty` option, which `run()` sets from `RunOptions.tty`) writes to it
directly. Its start removes the status region for the rest of the run
and settles the coalesced writes; in `full`, `focused` and `broad` a
live frame opens before it and closes after, and what vx says about it
(a timeout, a shell verdict) streams inside.

`status()` lines (header, summary) always print. Group tasks never
print in any mode. A ready persistent task the run keeps (`vx run dev`)
is held to a bounded tail until `runEnd`, which flushes it before the
summary; from there its output streams below the summary a line at a
time under its id (`app#dev │ …`), fenced on Actions, and not at all
under `errors-only`, `hash-only` or `none` (#2054). A line that redraws
itself (`\r`, `CSI 2K`, `CSI 1G`) prints as its last redraw, so the id
prefix stays on screen.

## Status region

The default logger owns a `createOutputWriter` from `status-line.ts`
wrapping its output stream. Enabled only when the stream is a TTY and
`view.ci` is not set. The optional `runStart` / `taskStart` / `runEnd` /
`stepStart` / `stepEnd` / `runDone`
hooks (wired by `run()`) drive a live region at the bottom
(`formatStatusRegion`): a blank line separating it from the completed
list above; one row per ready persistent task (`▸`, `running`, the id,
no elapsed); one row per worker slot that has been busy — the ticking
elapsed time leads, then `running` and the full id, a task keeping its
slot for its whole life so names never jump, a slot whose task ended
holding its place dim, and a row after them for each task running
beyond the slots; then the live
summary section, the same meters the final footer prints, filling in
as the run proceeds so the region becomes the summary when the run
ends. A failure logs a permanent one-liner the moment it lands
(`formatFailureLine`) and the full frame replays at `runEnd`. The
region is rewritten in place, throttled with forced redraws on task
events, and built (forecast pass, summary, rows) only when the writer
draws it, from the state then. At `runEnd` (the graph is done) its worker rows go and it
keeps the footer and vx's own step rows (`tail`) until `runDone`, just
before the final footer prints, removes it for good. A stop
(`runStop`) keeps the region: running rows read `aborting` with their
timers, blocked rows and the forecast go, each task that exits lists as
an `aborted` (or `not run`) row, and the live footer counts them, so a
slow stop never shows a blank screen (2026-10-17); the first
requested-task start in focused mode removes it too. A step
(`stepStart` / `stepEnd`, ids `<owner>:<step>`) shows as a row below
the worker rows once it has run `STEP_SHOWN_MS` (150 ms), bounded by
no worker slot, and ends as a list row (`formatStepLine`), `internal`
in the cache column; a step can draw the region before `runStart`,
with no footer. No step touches a counter. Only a step the run waits
on is one: a background step (`vx:prefetch`) never reaches the logger
and is kept for `vx last` (2026-10-16). `showsSteps` is true only
where the region can draw, and `run()` times no step otherwise (2026-10-15;
`tests/run-tail.test.ts`, `tests/steps.test.ts`). Every ordinary write
clears it first, writes, then redraws, so it never interleaves with content.

## Programmatic logger

A custom logger receives plain-text bodies (the orchestrator passes
`{ enabled: false }` for colors). Useful for:

- **JSON-line emission** — push each task's stdout/stderr to a
  structured pipeline.
- **OTLP / observability sink** — wrap each call to emit a span.
- **Silent test runner** — return functions that buffer to arrays
  the test inspects.

`run()` never calls a `Logger` directly: it emits `RunEvent`s through
the run event bus (`events.ts`), and the logger is the default
subscriber (`terminalSubscriber`). Other surfaces subscribe the same
way (`RunOptions.bus`, a plugin's `setup`).

## Tests

`tests/output-flow.test.ts` — flow detection, view resolution, the
per-mode visibility matrix, GHA grouping, and flow e2e through the
CLI. `tests/status-line.test.ts` — writer serialization, throttling,
permanent clear, and the logger's lifecycle integration.
`tests/framed-output.test.ts` tests the format functions directly;
`tests/orchestrator.test.ts` covers the custom-logger path.

## Replacing this module

Implement `Logger` and pass it via `RunOptions.log`. The four
required method names are wired by reference; the lifecycle hooks are
optional. To add new event types, extend the interface and the
orchestrator simultaneously.
