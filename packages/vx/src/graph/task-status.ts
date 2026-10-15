// A task's terminal status and what each one means: a pass, a hit, where
// its result came from. One vocabulary every reader (the run verdict, the
// logger, the history queries, telemetry, plugins) asks, so none re-lists
// the statuses.

export type TaskStatus =
  | 'success'
  | 'cache-hit'
  | 'cache-hit-remote'
  | 'failed'
  | 'skipped'
  // A child killed by a shutdown signal (SIGINT/SIGTERM — e.g. Ctrl-C):
  // the task never finished on its own terms, so it reverts to aborted —
  // excluded from the tally and the run history. It still PROPAGATES like
  // a failure (see `willSkip`): the child died mid-write, so its outputs
  // are partial.
  | 'aborted'

/** Where a task's result came from, derived ONCE in core from the status. */
export type CacheSource = 'miss' | 'local' | 'remote' | 'none'

/**
 * Map a task outcome status to its cache source. `success`/`failed` ran
 * (a miss as far as the cache read is concerned); the two cache-hit
 * statuses restored from local/remote; `skipped`/`aborted` never engaged
 * the cache. Pure function — the single place this mapping is decided;
 * `isCacheHit` below is derived from it rather than re-listing the two
 * hit statuses, so there is one decision, not two that can disagree.
 */
export function deriveCacheSource(status: TaskStatus): CacheSource {
  switch (status) {
    case 'cache-hit':
      return 'local'
    case 'cache-hit-remote':
      return 'remote'
    case 'success':
    case 'failed':
      return 'miss'
    case 'skipped':
    case 'aborted':
      return 'none'
  }
}

/**
 * Whether each status counts as a PASS. Written as a `Record<TaskStatus, …>`
 * rather than a `new Set([...])` on purpose: a Record must name every member,
 * so adding a status to the union is a COMPILE error HERE and the omission
 * cannot ship. A Set of string literals has no such tripwire — it silently
 * answers `false` for the new member, which is how ten hand-rolled copies of
 * this vocabulary accumulated across core, cloud and the dashboard.
 */
const PASSES: Record<TaskStatus, boolean> = {
  success: true,
  'cache-hit': true,
  'cache-hit-remote': true,
  failed: false,
  skipped: false,
  aborted: false,
}

/**
 * Every `TaskStatus`, at runtime. Read off `PASSES`'s keys, which the
 * `Record<TaskStatus, …>` type guarantees is exactly the union — so this is
 * derived, not a second list that can fall behind. Exported so a consumer that
 * cannot import the type (a test asserting a copy of this vocabulary in
 * another package agrees) can still enumerate the real set.
 */
export const TASK_STATUSES: readonly TaskStatus[] = Object.keys(PASSES) as TaskStatus[]

/**
 * Did the task pass? A cache hit counts — it produced the same result without
 * spending the time, which is the whole point. `skipped` and `aborted` do NOT:
 * neither finished on its own terms, so neither can vouch for anything.
 *
 * Takes `string`, not `TaskStatus`, because most callers hold a status that
 * arrived over a wire or out of a database column. An unrecognised string
 * reads as NOT passing — the safe direction, since the alternative is calling
 * a run green on a status this build has never heard of.
 */
export function isPassStatus(status: string): boolean {
  return PASSES[status as TaskStatus] === true
}

/**
 * Did the task's result come out of the cache (either layer)? Derived from
 * `deriveCacheSource` rather than re-listing the two hit statuses, so the two
 * cannot disagree about what a hit is. Unknown strings read as not-a-hit.
 */
export function isCacheHit(status: string): boolean {
  // No known-status guard: an unknown string falls through the switch to
  // undefined, which is neither hit source (the guard survived item 654).
  const source = deriveCacheSource(status as TaskStatus)
  return source === 'local' || source === 'remote'
}
