# `src/orchestrator/logger.ts` — pluggable logging surface

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
  taskStart?(node: TaskNode): void
  runEnd?(): void
}

export interface OutputView {
  mode: 'full' | 'errors-only' | 'none' | 'focused' | 'broad' | 'hash-only'
  gha?: boolean // wrap blocks in ::group:: (GitHub Actions)
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
  failureRecap(): string[] // the run's last block; [] when nothing failed
}

export function defaultLogger(
  colors?: ColorSupport,
  view?: OutputView, // default { mode: 'full' }
  out?: StatusStream, // default process.stdout
): DefaultLogger
```

## View resolution (priority order)

1. Explicit `--output-logs` → that mode.
2. Truthy `CI` env (`CI=0` / `CI=false` excluded) → `full`.
3. CLI-detected flow (`RunOptions.flow`) → `focused` or `broad`.
4. Nothing (programmatic callers) → `full`.

`gha: true` is attached whenever the resolved mode is `full` and
`GITHUB_ACTIONS` is truthy; `ci: true` whenever `CI` is truthy.

## Default logger behavior by mode

- **`full`** — frames for executed work / failures / skips,
  one-liners for quiet cache hits, frames for hits with replayed
  stdout. With `gha`, non-failed blocks are wrapped in
  `::group::<id> (<outcome word> <duration>)` … `::endgroup::`;
  failed blocks stay ungrouped and are preceded by
  `::error title=<id>::failed (exit N)` (`failedLabel`: above 128 the
  signal is named, `failed (exit 137, 128 + SIGKILL)`; a timeout its
  reason, `failed (timed out, exit 143)`; a persistent task that never
  became ready, `never ready: …`; a sandboxed task its violation count).
- **`focused`** — requested non-group nodes stream stdout/stderr raw
  and live (cache-hit replay included); a quiet hit prints the hit
  one-liner; a skipped requested task prints the skipped one-liner
  with its blocker (`• blocked by lib#build`). Dependency-pulled
  nodes are silent on success/hit and fully framed on failure.
- **`broad`** — executed tasks print one
  `● id ── executed • <duration>` line; failures get full frames;
  hits / up-to-date / skipped are silent (buffers dropped).
- **`errors-only`** — only failed tasks print.
- **`hash-only`** — one line per task with its key, no output.
- **`none`** — no per-task output.

`status()` lines (header, summary) always print. Group tasks never
print in any mode.

## Failure recap

`failureRecap()` returns the block `run()` prints last, after the
summary and its Aborted / Skipped / Flaky / Deferred sections, through
`status()`: each failed task's last 30 lines, 8 KiB at most, for the
first five failures, then the rest by id (item 706; the capture and
its caps are [`failure-recap.md`](./failure-recap.md), the rendering
[`framed-output.md`](./framed-output.md)). It exists because a
failure's frame prints when the task ends, and in a long log that is
far from the end, where the reader looks.

- The tail is decided at the failure, from what the logger already
  holds: a buffered task's stdout and stderr (the frame's order), or,
  for the one live-streamed task, a bounded ring fed as its chunks are
  written, created at its frame-open and dropped at its outcome. A task
  that passes leaves nothing behind.
- Every view that prints task output recaps (`full`, `errors-only`,
  `broad`, `focused`), on a terminal, in CI, and on Actions; `none` and
  `hash-only` promise no task output and print none.
- With `gha`, each tail is fenced in `::stop-commands::` as a frame
  body is, and the block is never in a `::group::`, so it reads with
  every group collapsed.
- A custom logger gets no recap: `run()` asks only the logger it built.
  The recap touches no exit code, no `--summarize` or `--dry=json`
  output, no telemetry (`run:status` is not telemetry), and no cache.

## Status region

The default logger owns a `createOutputWriter` from `status-line.ts`
wrapping its output stream. Enabled only when the stream is a TTY and
`view.ci` is not set. The optional `runStart` / `taskStart` / `runEnd`
hooks (wired by `run()`) drive a live region at the bottom
(`formatStatusRegion`): a blank line separating it from the completed
list above; one row per ready persistent task (`▸`, `running`, the id,
no elapsed); one row per worker slot — the ticking elapsed time leads,
then `running` and the full id, a task keeping its slot for its whole
life so names never jump, an idle slot holding its place dim; a
`… +N more running` line when tasks outnumber slots; then the live
summary section, the same meters the final footer prints, filling in
as the run proceeds so the region becomes the summary when the run
ends. A failure logs a permanent one-liner the moment it lands
(`formatFailureLine`) and the full frame replays at `runEnd`. The
region is rewritten in place, throttled with forced redraws on task
events, and removed permanently at `runEnd` (and on the first
requested-task start in focused mode). Every ordinary write clears it
first, writes, then redraws, so it never interleaves with content.

## Programmatic logger

A custom logger receives plain-text bodies (the orchestrator passes
`{ enabled: false }` for colors). Useful for:

- **JSON-line emission** — push each task's stdout/stderr to a
  structured pipeline.
- **OTLP / observability sink** — wrap each call to emit a span.
- **Silent test runner** — return functions that buffer to arrays
  the test inspects.

The orchestrator + scheduler don't otherwise communicate task
progress out-of-band — `Logger` is the only event bus.

## Tests

`tests/output-flow.test.ts` — flow detection, view resolution, the
per-mode visibility matrix, GHA grouping, and flow e2e through the
CLI. `tests/status-line.test.ts` — writer serialization, throttling,
permanent clear, and the logger's lifecycle integration.
`tests/failure-recap.test.ts` holds the recap end to end and per mode.
`tests/framed-output.test.ts` tests the format functions directly;
`tests/orchestrator.test.ts` covers the custom-logger path.

## Replacing this module

Implement `Logger` and pass it via `RunOptions.log`. The four
required method names are wired by reference; the lifecycle hooks are
optional. To add new event types, extend the interface and the
orchestrator simultaneously.
