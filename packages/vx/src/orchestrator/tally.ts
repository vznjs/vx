// Shared outcome-tally helper. `summary.ts` (end-of-run terminal block) and
// `run-artifacts.ts` (`--summarize` JSON) count the same numbers; one copy of
// the bucket rules keeps them from disagreeing about one run.

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
  /**
   * Killed by a shutdown signal. No work, so it joins no outcome bucket and
   * not `total` — but it is counted, because it makes the run red: a red run
   * whose every counted task succeeded is undiagnosable without this.
   */
  aborted: number
  /** Tasks counted toward `total`. Group tasks are excluded by default. */
  total: number
}

function emptyTally(): Tally {
  return {
    successful: 0,
    failed: 0,
    skipped: 0,
    cachedLocal: 0,
    restoredLocal: 0,
    restoredRemote: 0,
    upToDate: 0,
    cachedRemote: 0,
    aborted: 0,
    total: 0,
  }
}

/**
 * Walk live outcomes and return a `Tally` — the single owner of the bucket
 * rules.
 *
 * Group tasks (no `exec`) aren't real work; including them inflates the
 * per-run "N total" count in ways that mislead ("3 of 4 cached" when one was
 * a group that ran nothing).
 *
 * Status bucket rules:
 *   `success`            → +successful
 *   `cache-hit`          → +successful, +cachedLocal
 *   `cache-hit-remote`   → +successful, +cachedRemote
 *   `failed`             → +failed
 *   `skipped`            → +skipped
 *   `aborted`            → +aborted only (no bucket, no total)
 */
export function tallyOutcomes(outcomes: readonly TaskOutcome[]): Tally {
  const t = emptyTally()
  for (const o of outcomes) {
    if (isGroupTask(o.node)) continue
    if (o.status === 'aborted') {
      t.aborted++
      continue
    }
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
