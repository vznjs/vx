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
  // Optional lifecycle hooks — drive the default logger's dynamic
  // status line; custom loggers may omit them.
  runStart?(info: { total: number }): void
  taskStart?(node: TaskNode): void
  runEnd?(): void
}

export interface OutputView {
  mode: 'full' | 'errors-only' | 'none' | 'focused' | 'broad'
  gha?: boolean // wrap blocks in ::group:: (GitHub Actions)
  ci?: boolean // truthy CI env — suppresses the status line
}

export function resolveOutputView(
  options: { outputLogs?: 'full' | 'errors-only' | 'none'; flow?: 'focused' | 'broad' },
  env?: Record<string, string | undefined>,
): OutputView

export function defaultLogger(
  colors?: ColorSupport,
  view?: OutputView, // default { mode: 'full' }
  out?: StatusStream, // default process.stdout
): Logger
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
  `::error title=<id>::failed (exit N)`.
- **`focused`** — requested non-group nodes stream stdout/stderr raw
  and live (cache-hit replay included); a quiet hit prints the hit
  one-liner; a skipped requested task is framed. Dependency-pulled
  nodes are silent on success/hit and fully framed on failure.
- **`broad`** — executed tasks print one
  `● id ── executed • <duration>` line; failures get full frames;
  hits / up-to-date / skipped are silent (buffers dropped).
- **`errors-only`** — only failed tasks print.
- **`none`** — no per-task output.

`status()` lines (header, summary) always print. Group tasks never
print in any mode.

## Status line

The default logger owns a `createOutputWriter` from
[`status-line.ts`](../modules/orchestrator.md) wrapping its output
stream. Enabled only when the stream is a TTY and `view.ci` is not
set. The optional `runStart` / `taskStart` / `runEnd` hooks (wired by
`run()`) drive a single bottom line —
`▶ <running> running · <done>/<total> · <ids> · <elapsed>s
[· n failed]` — rewritten in place (ESC[2K + \r), throttled to 100ms
with forced redraws on task events, and removed permanently at
`runEnd` (and on the first requested-task start in focused mode).
Every ordinary write clears the line first, writes, then redraws, so
the line never interleaves with content.

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
`tests/framed-output.test.ts` tests the format functions directly;
`tests/orchestrator.test.ts` covers the custom-logger path.

## Replacing this module

Implement `Logger` and pass it via `RunOptions.log`. The four
required method names are wired by reference; the lifecycle hooks are
optional. To add new event types, extend the interface and the
orchestrator simultaneously.
