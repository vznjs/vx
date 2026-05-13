# `src/orchestrator/logger.ts` — pluggable logging surface

## Purpose

Provide a small `Logger` interface that the orchestrator + scheduler
call through, and a `defaultLogger()` implementation that emits the
Turbo-style framed blocks. Programmatic embedders can pass their own
`Logger` to capture machine-readable output.

## Public surface

```ts
export interface Logger {
  status(line: string): void // header / summary / status lines
  taskStdout(node: TaskNode, chunk: string): void // streamed stdout chunk (buffered)
  taskStderr(node: TaskNode, chunk: string): void // streamed stderr chunk (buffered)
  taskComplete(node: TaskNode, outcome: TaskOutcome): void // flush block
}

export function defaultLogger(colors?: ColorSupport): Logger
```

## Default logger behavior

- **`status(line)`** — writes `line\n` to stdout.
- **`taskStdout` / `taskStderr`** — appends to a per-task buffer.
  Stdout and stderr aren't distinguished in the rendered output; they
  appear interleaved in arrival order (matches Turbo).
- **`taskComplete`** — flushes the buffer through
  `framed-output.ts:formatTaskBlock` and writes to stdout. A blank
  line is prefixed for the second and later blocks for visual
  separation (the header already ends with a blank line).
- **Group tasks** (`node.config.exec === undefined`) — `formatTaskBlock`
  returns `''`; the logger writes nothing.

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

Indirect coverage via `tests/orchestrator.test.ts` (every e2e case
uses a `silentLogger` that records into arrays for assertions).
`tests/framed-output.test.ts` tests the format functions directly.

## Replacing this module

Implement `Logger` and pass it via `RunOptions.log`. Keep the four
method names; the orchestrator wires them by reference. To add
new event types (e.g. `runStart`, `runEnd`), extend the interface
and the orchestrator simultaneously.
