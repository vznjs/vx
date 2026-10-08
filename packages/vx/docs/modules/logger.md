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
    forwardArgs?: readonly string[]
  },
): DefaultLogger
```

## View resolution (priority order)

1. Explicit `--output-logs` → that mode.
2. Truthy `CI` env (`CI=0` / `CI=false` excluded) → `full`.
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
under `errors-only`, `hash-only` or `none` (#2054).

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
