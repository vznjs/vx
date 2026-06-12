# `src/orchestrator/framed-output.ts` — Turbo-style framed blocks

## Purpose

Format the run-header banner, the per-task framed output block, and
the two compact one-liners (quiet cache hit, broad-mode executed).
Pure functions; the logger calls them at the right moments.

## Public surface

```ts
export interface HeaderInput {
  version: string
  packageCount: number
  tasks: readonly string[]
  taskCount: number
  remoteCacheEnabled: boolean
}

export function formatHeader(input: HeaderInput, colors?: ColorSupport): string[]

export interface TaskBlockBody {
  stdout?: string
  stderr?: string // rendered under an `├─ Error` section
}

export function formatTaskBlock(
  node: TaskNode,
  outcome: TaskOutcome,
  body: TaskBlockBody,
  colors?: ColorSupport,
): string

// `◌ <id> ── restored-local • <hash8>` — quiet cache hit
export function formatTaskHitLine(node, outcome, colors?): string

// `● <id> ── executed • <duration>` — broad-mode executed task
export function formatTaskExecutedLine(node, outcome, colors?): string
```

## Header shape

```
• vx 0.0.0

   • Running ci in 2 packages (3 tasks)
   • Remote caching disabled
```

Bullets are tinted with the accent color (`#06b6d4` cyan); the
`vx <version>` line is bold.

## Task block shape

```
┌─ @vzn/vx#lint > restored-local • 7da42dfe
│   Found 0 warnings and 0 errors.
└─ @vzn/vx#lint ── (4ms) restored-local
```

The block format is:

- **Top line:** `┌─ <task-id> > <status header>`
- **Optional command echo:** `$ <command>` (success path only —
  cache hits already have the body)
- **Body:** captured stdout (bar-prefixed), then stderr under an
  `├─ Error` section, then any `├─ Sandbox Violations (n)` section
- **Bottom line:** `└─ <task-id> ── (<duration>) <status tag>`

Group tasks (no `exec`) render empty string — they aren't real tasks.

## Outcome vocabulary + colors

One vocabulary across every surface (one-liners, frames, summary,
verbose table): `executed` / `restored-local` / `restored-remote` /
`up-to-date` / `failed` / `skipped`.

| Status                            | Header                          | Footer tag                 |
| --------------------------------- | ------------------------------- | -------------------------- |
| `success`                         | dim `executed`                  | dim `executed`             |
| `cache-hit` (restored)            | green `restored-local • <hash>` | dim `restored-local`       |
| `cache-hit-remote` (restored)     | cyan `restored-remote • <hash>` | dim `restored-remote`      |
| either hit with `restored: false` | green `up-to-date • <hash>`     | dim `up-to-date`           |
| `failed`                          | `$ <command>`                   | bold red `failed (exit N)` |
| `skipped`                         | yellow `skipped (upstream …)`   | yellow `skipped`           |

Duration formats: `<1s` → `Nms`, ≥1s → `N.NNs`.

## Tests

`tests/framed-output.test.ts`:

- Header pluralization ("1 package" vs "N packages").
- Block shape per status (cache-hit, success, failed, skipped, remote,
  up-to-date, sandbox violations).
- Group task elision.
- Color on/off (assertions strip ANSI when colors off).
