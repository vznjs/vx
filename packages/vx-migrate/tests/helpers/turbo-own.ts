// Turbo's own env (its `DEFAULT_ENV_VARS` and builtin pass-through) joins
// every mapped task's globals. A row about what turbo.json says leaves
// those names out; "Turbo's builtin env" in turbo-map-sweep.test.ts holds them.
import { TURBO_BUILTIN_PASS_THROUGH, TURBO_DEFAULT_ENV } from '../../src/turbo/turbo-reads.js'

/** `names` without Turbo's own, a builtin wildcard's matches too. */
export const notTurbos = <T>(names: readonly T[]): T[] =>
  names.filter(
    (n) =>
      typeof n !== 'string' ||
      (!TURBO_DEFAULT_ENV.includes(n) &&
        !TURBO_BUILTIN_PASS_THROUGH.some((e) =>
          e.endsWith('*') ? n.startsWith(e.slice(0, -1)) : n === e,
        )),
  )

/** A splice that inlines the globals, Turbo's own names left out. */
export const ownSplice = (_kind: string, values: readonly string[]): string[] => notTurbos(values)

/** The note a written migration carries for Turbo's builtin env. */
export const BUILTIN_FAMILIES_NOTE =
  'Turbo passes its builtin env (HOME, CI, PATH, VERCEL_* and the rest) to each task; vx ' +
  'passes the names a task lists — add the ones a task reads to exec.env.passThrough'
