// Shared outcome-tally helper. Both `summary.ts` (end-of-run terminal
// block) and `run-artifacts.ts` (`--summarize` JSON) count the same
// numbers; centralising it keeps the two surfaces consistent.

import { isGroupTask, type TaskOutcome } from '../graph/index.js'

export interface Tally {
  successful: number
  failed: number
  skipped: number
  cachedLocal: number
  /** Hits that materialized files from the local artifact. */
  restoredLocal: number
  /** Hits that materialized files pulled from the remote layer. */
  restoredRemote: number
  /** Cache hits whose tree already matched — nothing was written. */
  upToDate: number
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
    restoredLocal: 0,
    restoredRemote: 0,
    upToDate: 0,
    cachedRemote: 0,
    total: 0,
  }
  for (const o of outcomes) {
    if (isGroupTask(o.node)) continue
    // aborted (killed by a shutdown signal) is no work — excluded
    // from totals and every bucket, exactly like a group task.
    if (o.status === 'aborted') continue
    t.total++
    if (o.status === 'success') t.successful++
    else if (o.status === 'cache-hit') {
      t.successful++
      t.cachedLocal++
      if (o.restored === true) t.restoredLocal++
      else t.upToDate++
    } else if (o.status === 'cache-hit-remote') {
      t.successful++
      t.cachedRemote++
      if (o.restored === true) t.restoredRemote++
      else t.upToDate++
    } else if (o.status === 'failed') t.failed++
    else if (o.status === 'skipped') t.skipped++
  }
  return t
}
