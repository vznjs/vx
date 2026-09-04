// The one rule every migrator uses for "this task never exits", in a leaf
// module: `migrate.ts` imports the three migrators, so anything they import
// back from it is a cycle.

/**
 * Task names that conventionally never exit. All three migrators guess the
 * same way from a name — a source that SAYS a task is long-running (turbo's
 * `persistent: true`, an Nx dev-server executor) is believed instead.
 */
export const PERSISTENT_TASK_NAMES: ReadonlySet<string> = new Set([
  'dev',
  'start',
  'serve',
  'watch',
  'preview',
])

/** The one wording every migrator emits for a task it made persistent. */
export const PERSISTENT_TODO =
  'persistent task — set persistent.readyWhen (regex matched against output) so ' +
  'dependents unblock on readiness, and consider exec.timeout to bound the wait'
