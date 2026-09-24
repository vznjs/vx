# `src/orchestrator/colors.ts` — ANSI color gate

## Purpose

Decide whether to emit color and provide a single `paint(color,
text, colors, opts)` helper everyone else uses. Centralizing the
gate means a programmatic logger passing `{ enabled: false }` always
gets plain text, regardless of TTY / env.

## Public surface

```ts
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
to a task as set.

`orchestrator.run()` always passes `{ enabled: false }` when the
caller provides a custom `log` — programmatic embedders see plain
text, which keeps test assertions clean.

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

## Tests

`tests/colors.test.ts`:

- `detectColors` precedence (NO_COLOR > FORCE_COLOR > TTY), and the
  exact decision for `FORCE_COLOR` `0`, `false`, `1`, `true`, empty and
  unset, each on a TTY and piped, with and without `NO_COLOR`.
- `paint` no-op when disabled.
- `paint` emits sequences when enabled.

`tests/ci-output.test.ts`: a piped run with `FORCE_COLOR=0` or `=false`
carries no escape sequence, and the task still sees the value as set.
