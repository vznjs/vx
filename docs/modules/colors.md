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

| Env                 | Result                         |
| ------------------- | ------------------------------ |
| `NO_COLOR=<any>`    | off — overrides `FORCE_COLOR`  |
| `FORCE_COLOR=<any>` | on                             |
| neither             | on iff `stream.isTTY === true` |

`orchestrator.run()` always passes `{ enabled: false }` when the
caller provides a custom `log` — programmatic embedders see plain
text, which keeps test assertions clean.

## `paint(color, text, colors, opts)`

- `colors.enabled === false` → returns `text` unchanged.
- Otherwise wraps `text` in:
  - `\x1b[1m` (bold) when `opts.bold`
  - `\x1b[2m` (dim) when `opts.dim`
  - `Bun.color(color, 'ansi-16m')` truecolor sequence
  - `\x1b[0m` reset

`color` accepts the same strings as `Bun.color` (`'red'`, `'sky-blue'`,
hex codes, etc.). We use `'ansi-16m'` (24-bit truecolor) deliberately:
`'ansi'` is broken in current Bun versions (emits raw bytes), and every
modern terminal supports truecolor. We don't downgrade for legacy
terminals — accents are the only UI use case, and "no color" is the
safe fallback.

## Tests

`tests/colors.test.ts`:

- `detectColors` precedence (NO_COLOR > FORCE_COLOR > TTY).
- `paint` no-op when disabled.
- `paint` emits sequences when enabled.
