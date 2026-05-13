# `src/orchestrator/framed-output.ts` — Turbo-style framed blocks

## Purpose

Format the run-header banner and per-task framed output block. Two
pure functions; the logger calls them at the right moments.

## Public surface

```ts
export interface HeaderInput {
  version: string
  packages: readonly string[]
  tasks: readonly string[]
  remoteCacheEnabled: boolean
}

export function formatHeader(input: HeaderInput, colors?: ColorSupport): string[]

export function formatTaskBlock(
  node: TaskNode,
  outcome: TaskOutcome,
  body: string, // captured stdout/stderr text (concatenated)
  colors?: ColorSupport,
): string
```

## Header shape

```
• vx 0.0.0

   • Packages in scope: @vzn/vx, @repo/ui
   • Running ci in 2 packages
   • Remote caching disabled
```

Bullets are tinted with the accent color (`#06b6d4` cyan); the
`vx <version>` line is bold. Packages list is sorted.

## Task block shape

```
┌─ @vzn/vx#lint > cache hit • 7da42dfe
Found 0 warnings and 0 errors.
└─ @vzn/vx#lint ── (4ms) from local cache
```

The block format is:

- **Top line:** `┌─ <task-id> > <status header>`
- **Optional command echo:** `$ <command>` (success path only —
  cache hits already have the body)
- **Body:** captured stdout+stderr, trailing newline trimmed
- **Bottom line:** `└─ <task-id> ── (<duration>) <status tag>`

Group tasks (no `exec`) render empty string — they aren't real tasks.

## Status colors

| Status             | Header                        | Footer tag                 |
| ------------------ | ----------------------------- | -------------------------- |
| `success`          | dim `executed`                | dim `executed`             |
| `cache-hit`        | green `cache hit • <hash>`    | dim `from local cache`     |
| `cache-hit-remote` | cyan `remote cache hit …`     | dim `from remote cache`    |
| `failed`           | `$ <command>`                 | bold red `FAILED (exit N)` |
| `skipped`          | yellow `skipped (upstream …)` | yellow `skipped`           |

Duration formats: `<1s` → `Nms`, ≥1s → `N.NNs`.

## Tests

`tests/framed-output.test.ts`:

- Header pluralization ("1 package" vs "N packages").
- Block shape per status (cache-hit, success, failed, skipped, remote).
- Group task elision.
- Color on/off (assertions strip ANSI when colors off).
