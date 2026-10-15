# `src/util/colors.ts` — ANSI color gate

## Purpose

Decide whether to emit color and provide a single `paint(color,
text, colors, opts)` helper everyone else uses. Centralizing the
gate means a programmatic logger passing `{ enabled: false }` always
gets plain text, regardless of TTY / env.

## Public surface

```ts
// State hues the run summary and every report share.
export const SUCCESS = '#22c55e'
export const WARN = '#eab308'
export const ERROR = '#ef4444'

export interface ColorSupport {
  enabled: boolean
}

export interface PaintOptions {
  bold?: boolean
  dim?: boolean
}

export function detectColors(stream?: NodeJS.WriteStream): ColorSupport
export function paint(
  color: string,
  text: string,
  colors: ColorSupport,
  opts?: PaintOptions,
): string

// util/report.ts
export function gradientRule(colors: ColorSupport, mark?: string): string
export type ReportRow = readonly [label: string, ...values: string[]] | null
export function formatReport(
  mark: string,
  rows: readonly ReportRow[],
  colors?: ColorSupport,
): string
```

## Detection rules

Standard env precedence:

| Env                              | Result                         |
| -------------------------------- | ------------------------------ |
| `NO_COLOR=<non-empty>`           | off — overrides `FORCE_COLOR`  |
| `FORCE_COLOR=0` / `false`        | off, even on a TTY             |
| `FORCE_COLOR=<any other>` or `=` | on                             |
| neither                          | on iff `stream.isTTY === true` |

`0` and `false` are the convention's "off" (supports-color, chalk,
Node); reading any non-empty `FORCE_COLOR` as on painted a piped CI log
that set `FORCE_COLOR=0` (nx#35292's bug, fixed 2026-09-24). The task
environment is not this module's: `exec/env.ts` passes both variables
to a task as set, and sets `FORCE_COLOR=1` when the task sees neither.

`orchestrator.run()` always passes `{ enabled: false }` when the
caller provides a custom `log` — programmatic embedders see plain
text, which keeps test assertions clean; task output reaches it as
the task wrote it. When the default renderer's colours are off,
`run()` hands it task output through `plainOutput`
(`plain-output.ts`), which strips the escapes a forced task wrote and
holds one cut at a chunk's end until the next chunk.

## `paint(color, text, colors, opts)`

- `colors.enabled === false` → returns `text` unchanged.
- Otherwise wraps `text` in:
  - `\x1b[1m` (bold) when `opts.bold`
  - `\x1b[2m` (dim) when `opts.dim`
  - `Bun.color(color, 'ansi-16m')` truecolor sequence, memoized per
    color string; a color Bun cannot parse paints nothing
  - `\x1b[0m` reset
- An empty `color` with no option is `text` unchanged too — `paint('',
text, colors, { dim: true })` is how a dim run of plain text is
  written.

`color` accepts the same strings as `Bun.color` (`'red'`, `'sky-blue'`,
hex codes, etc.). We use `'ansi-16m'` (24-bit truecolor) deliberately:
`'ansi'` is broken in current Bun versions (emits raw bytes), and every
modern terminal supports truecolor. We don't downgrade for legacy
terminals — accents are the only UI use case, and "no color" is the
safe fallback.

## `formatReport(mark, rows, colors?)` (`util/report.ts`)

A verb's report in the run summary's shape: a blank line, the gradient
rule (`gradientRule`, shared with the summary) naming `mark`, then one
row per `[label, ...values]`: the label dim in an 8-column field, each
value line aligned under the first; `null` is a blank line, and the
`next` row is bold. `vx init` and `@vzn/vx-migrate` print every report
through it (the façade exports it with its `ReportRow` type), so a
migration reads like a run's footer (M, 2026-10-15).

## Tests

`tests/colors.test.ts`:

- `detectColors` precedence (NO_COLOR > FORCE_COLOR > TTY), and the
  exact decision for `FORCE_COLOR` `0`, `false`, `1`, `true`, empty and
  unset, each on a TTY and piped, with and without `NO_COLOR`.
- `paint` no-op when disabled.
- `paint` emits sequences when enabled.

`tests/ci-output.test.ts`: a piped run with `FORCE_COLOR=0` or `=false`
carries no escape sequence, and the task still sees the value as set.
