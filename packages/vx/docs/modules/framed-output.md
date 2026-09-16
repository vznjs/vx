# `src/orchestrator/framed-output.ts` — Turbo-style framed blocks

## Purpose

Format the per-task framed output block and the two compact one-liners
(quiet cache hit, broad-mode executed). Pure functions; the logger
calls them at the right moments.

There is no top-of-run header. The run banner — version, the
affected-projects bar, worker pool, cache mode — lives in the
**footer** (`summary.ts`'s `RunContext`), printed once at the end
where the eye lands. See `docs/modules/summary.md`.

## Public surface

```ts
export interface TaskBlockBody {
  stdout?: string // rendered under `├─ STDOUT ──…`
  stderr?: string // rendered under `├─ STDERR ──…`
}

export function formatTaskBlock(
  node: TaskNode,
  outcome: TaskOutcome,
  body: TaskBlockBody,
  colors?: ColorSupport,
): string

// ` ⇢ <time> success local <id>` — quiet cache hit
export function formatTaskHitLine(node, outcome, colors?): string

// ` ⏺ <time> success miss <id>` — broad-mode executed task
export function formatTaskExecutedLine(node, outcome, colors?): string
```

## Task block shape

```
┌─ @vzn/vx#lint > success

$ oxlint --type-aware --type-check

├─ STDOUT ──────────────────────────────────────────────────

Found 0 warnings and 0 errors.

└─ @vzn/vx#lint ── (327ms) success
```

The block format is:

- **Top line:** `┌─ <task-id> > <status header>`
- **`$ <command>` line:** executed tasks only (success and failed),
  dim, between blank lines, with no section label (the owner cut it);
  cache hits replay stored output and skip it, skips never ran
- **`├─ STDOUT ──…` / `├─ STDERR ──…` sections:** present only when the
  stream is non-empty after trim; a blank line above and below the
  content, and a head-dropped notice when the capture was bounded
- **`├─ SANDBOX VIOLATIONS (n)` section:** when present — unique
  lines, verbatim, with the header in error red. The buffered renderer
  and the live frame share one builder, so a focused run shows it too
- **Bottom line:** `└─ <task-id> ── (<duration>) <status tag>`

Section headers and corners render dim; ids keep identity coloring.
Content lines are **raw** — no `│` border, no indent — so terminal
wrapping never collides with frame glyphs and copy/paste is clean
(owner feedback, 2026-06). The logger blank-line-delimits blocks on
both sides (the formatter stays pure — no trailing blank inside the
returned string beyond the final newline).

Group tasks (no `exec`) render empty string — they aren't real tasks.

## Outcome vocabulary + colors

One vocabulary across every surface (one-liners, frames, summary,
verbose table): `executed` / `restored-local` / `restored-remote` /
`up-to-date` / `failed` / `skipped`.

| Status                            | Header                                                                                                                                                                                                                                       | Footer tag            |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `success`                         | dim `success`                                                                                                                                                                                                                                | dim `success`         |
| `cache-hit` (restored)            | green `restored-local • <hash>`                                                                                                                                                                                                              | dim `restored-local`  |
| `cache-hit-remote` (restored)     | cyan `restored-remote • <hash>`                                                                                                                                                                                                              | dim `restored-remote` |
| either hit with `restored: false` | green `up-to-date • <hash>`                                                                                                                                                                                                                  | dim `up-to-date`      |
| `failed`                          | bold red `failed (exit N)`, `failedLabel` (+ `, 128 + SIGKILL` above 128; a timeout reads `failed (timed out, exit 143)`; a persistent task that never became ready reads `never ready: …`; a sandboxed task's violations are counted after) | same                  |
| `skipped`                         | yellow `skipped (blocked by <id>)`, `skippedLabel`; bare `skipped` for a fail-fast skip                                                                                                                                                      | same                  |

Duration formats: `<1s` → `Nms`, ≥1s → `N.NNs`.

## Tests

`tests/framed-output.test.ts`:

- Block shape per status (cache-hit, success, failed, skipped, remote,
  up-to-date, sandbox violations).
- Group task elision.
- Color on/off (assertions strip ANSI when colors off).
