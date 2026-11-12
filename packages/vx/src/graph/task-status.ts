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
  // A child killed by SIGINT/SIGTERM never finished on its own terms: it
  // reverts to aborted, outside the tally and history. It still propagates like
  // a failure (`willSkip`): its outputs are partial.
  | 'aborted'

/**
 * Where a task's result came from, derived ONCE in core from the status.
 * `none`: it never engaged the cache, or its hit's restore failed (a
 * failed task, in no cache column).
 */
export type CacheSource = 'miss' | 'local' | 'remote' | 'none'

/**
 * A status's cache source: `success`/`failed` ran (a miss), the two hit
 * statuses restored, `skipped`/`aborted` never engaged the cache. The one place
 * this is decided; `isCacheHit` derives from it.
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
 * A `Record<TaskStatus, …>`, not a Set: a new status is a compile error here
 * instead of a silent `false`.
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
 * Every `TaskStatus` at runtime, read off `PASSES`'s keys, which the type pins
 * to the union. For consumers that cannot import the type.
 */
export const TASK_STATUSES: readonly TaskStatus[] = Object.keys(PASSES) as TaskStatus[]

/**
 * Did the task pass? A hit counts; `skipped` and `aborted` do not, as neither
 * finished on its own terms.
 *
 * Takes `string`: most statuses arrive over a wire or from a database. An
 * unknown string does not pass, the safe direction.
 */
export function isPassStatus(status: string): boolean {
  return PASSES[status as TaskStatus] === true
}

/**
 * Did the result come from the cache (either layer)? Derived from
 * `deriveCacheSource`. Unknown strings are not hits.
 */
export function isCacheHit(status: string): boolean {
  // No known-status guard: an unknown string falls through the switch to
  // undefined, which is neither hit source.
  const source = deriveCacheSource(status as TaskStatus)
  return source === 'local' || source === 'remote'
}
