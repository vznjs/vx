// Shared outcome-tally helper. Both `summary.ts` (end-of-run terminal
// block) and `run-artifacts.ts` (`--summarize` JSON) count the same
// numbers; centralising it keeps the two surfaces consistent.

import type { TaskOutcome } from '../graph/scheduler.js'
import { isGroupTask } from '../graph/task-graph.js'

export interface Tally {
  successful: number
  failed: number
  skipped: number
  cachedLocal: number
  cachedRemote: number
  /** Tasks counted toward `total`. Group tasks are excluded by default. */
  total: number
}

/**
 * Walk the outcome list and return a `Tally`. Group tasks (no `exec`)
 * are filtered out — they aren't real work, and including them
 * inflates the per-run "N total" count in ways that mislead the user
 * ("3 of 4 cached" when one was a group that ran nothing).
 *
 * Status bucket rules:
 *   `success`            → +successful
 *   `cache-hit`          → +successful, +cachedLocal
 *   `cache-hit-remote`   → +successful, +cachedRemote
 *   `failed`             → +failed
 *   `skipped`            → +skipped
 */
export function tallyOutcomes(outcomes: readonly TaskOutcome[]): Tally {
  const t: Tally = {
    successful: 0,
    failed: 0,
    skipped: 0,
    cachedLocal: 0,
    cachedRemote: 0,
    total: 0,
  }
  for (const o of outcomes) {
    if (isGroupTask(o.node)) continue
    t.total++
    if (o.status === 'success') t.successful++
    else if (o.status === 'cache-hit') {
      t.successful++
      t.cachedLocal++
    } else if (o.status === 'cache-hit-remote') {
      t.successful++
      t.cachedRemote++
    } else if (o.status === 'failed') t.failed++
    else if (o.status === 'skipped') t.skipped++
  }
  return t
}
