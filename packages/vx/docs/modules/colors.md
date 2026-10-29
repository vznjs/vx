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
  // The terminal's width, read live (detectColors); none off a terminal.
  readonly columns?: number | undefined
}

export interface PaintOptions {
  bold?: boolean
  dim?: boolean
  underline?: boolean
}

export function detectColors(stream?: NodeJS.WriteStream): ColorSupport
// `TERM=dumb`: no colour (unless FORCE_COLOR) and no live region (status-line.ts).
export function dumbTerminal(): boolean
export function paint(
  color: string,
  text: string,
  colors: ColorSupport,
  opts?: PaintOptions,
): string
// A project's or a target's identity hue: the name folded into one palette
// that shares no hue with a status colour (tests/framed-output.test.ts).
export function identityColor(name: string): string

// util/report.ts: a meter is 50 cells, fewer to fit a narrower terminal;
// the rules (the footer's, a task frame's sections) end flush with it.
export function barWidth(colors: ColorSupport): number
export function ruleWidth(colors: ColorSupport): number
export function gradientRule(colors: ColorSupport, mark?: string): string

// report/plain-output.ts: `sink` with terminal escapes stripped from task
// output, for a pipe, CI or `NO_COLOR` (tasks run with `FORCE_COLOR`).
export function plainOutput(sink: Logger): Logger
```

## Detection rules

Standard env precedence:

| Env                                                               | Result                                                   |
| ----------------------------------------------------------------- | -------------------------------------------------------- |
| `NO_COLOR=<non-empty>`                                            | off — overrides `FORCE_COLOR`                            |
| `FORCE_COLOR=0` / `false`                                         | off, even on a TTY                                       |
| `FORCE_COLOR=<any other>` or `=`                                  | on                                                       |
| `GITHUB_ACTIONS`, `GITLAB_CI`, `BUILDKITE` or `CIRCLECI` = `true` | on: their log renders colour though the output is a pipe |
| neither                                                           | on iff `stream.isTTY === true` and `TERM` is not `dumb`  |

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

Reports and notices are built from these by [`ui`](ui.md).

## Tests

`tests/colors.test.ts`:

- `detectColors` precedence (NO_COLOR > FORCE_COLOR > TTY), and the
  exact decision for `FORCE_COLOR` `0`, `false`, `1`, `true`, empty and
  unset, each on a TTY and piped, with and without `NO_COLOR`.
- `paint` no-op when disabled.
- `paint` emits sequences when enabled.

`tests/term-dumb.test.ts`: `TERM=dumb` gets no colour unless
`FORCE_COLOR` asks, and `createOutputWriter` draws no live region on it.

`tests/ci-output.test.ts`: a piped run with `FORCE_COLOR=0` or `=false`
carries no escape sequence, and the task still sees the value as set.
