# `src/orchestrator/status-line.ts` — serialized writer + status line

## Purpose

A single bottom status line for interactive runs, plus the
serialization point that makes it safe: every default-logger stdout
write flows through one `OutputWriter`, which clears the line, writes
the content, and redraws. Deliberately NOT a TUI — one `\r` +
`ESC[2K` rewrite, no alternate screen, no cursor addressing.

## Public surface

```ts
export interface StatusStream {
  write(chunk: string): unknown
  isTTY?: boolean
}

export interface OutputWriter {
  readonly enabled: boolean // TTY && not disabled (CI)
  write(chunk: string): void // clear → content → redraw
  setStatus(line: string, opts?: { force?: boolean }): void
  clearStatus(): void // permanent
}

export function createOutputWriter(
  stream: StatusStream,
  opts?: { enabled?: boolean; minRedrawMs?: number; now?: () => number },
): OutputWriter

export interface StatusLineState {
  running: readonly string[]
  done: number
  total: number
  failed: number
  elapsedMs: number
}

export function formatStatusLine(s: StatusLineState, colors?: ColorSupport): string
// ▶ 2 running · 5/12 · one#build, two#build · 4s [· 1 failed]
```

## Behavior

- **Inert off-TTY.** `enabled` is false when `stream.isTTY !== true`
  or the caller disables it (truthy CI). Then `write` is a pure
  passthrough and `setStatus`/`clearStatus` are no-ops — `bun test`
  output stays byte-deterministic.
- **Serialization.** While the status line is shown, any content
  write first emits `ESC[2K\r`, then the content, then redraws the
  line — content and status can never interleave.
- **Throttling.** Unforced `setStatus` redraws at most every
  `minRedrawMs` (100ms default); task start/finish events force.
- **Mid-line hold.** Focused-mode streaming can leave the cursor
  mid-line; redraws hold off until a write ends with `\n` (rewriting
  the line would wipe the partial output).
- **Permanent clear.** `clearStatus()` erases the line and kills the
  writer's status path for good — used at run end (before the
  summary) and on the first requested-task start in the focused flow.

The default logger owns the instance, drives it from the optional
`runStart` / `taskStart` / `runEnd` Logger hooks, and runs a 100ms
unref'd ticker between events so the elapsed counter moves.

## Tests

`tests/status-line.test.ts` — writer serialization order, throttle,
permanent clear, partial-line hold, non-TTY/CI inertness, formatting,
and the defaultLogger lifecycle integration on a fake TTY.
