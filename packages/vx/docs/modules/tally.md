# `src/orchestrator/tally.ts` — outcome tally

## Purpose

The per-run counts the end-of-run footer (`summary.ts:formatRunSummary`)
is built from, group tasks excluded.

## Public surface

```ts
export interface Tally {
  successful: number
  failed: number
  skipped: number
  cachedLocal: number // every local hit
  restoredLocal: number // …that wrote the tree
  restoredRemote: number
  upToDate: number // a hit of either layer that found the tree current
  cachedRemote: number
  aborted: number // outside `total`: the task never ran
  /** Group tasks are excluded from `total`. */
  total: number
}
export function tallyOutcomes(outcomes: readonly TaskOutcome[]): Tally
```

## Rules

- **Group tasks** (`isGroupTask(node)` true) are skipped — they aren't
  real work; counting them in "N total" would mislead the user.
- **`aborted`** → +aborted, and NOT +total: a task a shutdown signal
  took down never ran.
- **`success`** → +successful.
- **`cache-hit`** → +successful, +cachedLocal, then +restoredLocal when
  it wrote the tree or +upToDate when the tree was already current.
- **`cache-hit-remote`** → +successful, +cachedRemote, then
  +restoredRemote or +upToDate the same way.
- **`failed`** → +failed.
- **`skipped`** → +skipped.

The implementation is intentionally simple — one fold, one counter
record. Adding a new outcome status means adding one branch here and
every consumer stays in sync.

## Why this lives in `orchestrator/` and not `graph/`

`TaskOutcome` (and the scheduler that produces it) live in `graph/`,
but the tally is a presentation-layer concern — the footer consumes it. Keeping it under `orchestrator/` keeps the
graph layer scheduler-only.

## Tests

`tests/tally.test.ts` pins the bucket rules; `tests/summary.test.ts`
(formatRunSummary) exercises every status branch + group-task
exclusion.
