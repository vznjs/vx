/**
 * The verbs the CLI dispatcher (`cli/index.ts`) owns; `stats` is a
 * deprecated alias of `info` and stays out of hints but is still matched
 * first. Lives in util rather than cli because the workspace VALIDATOR
 * refuses a plugin verb that names one of these — a verb core matches
 * first could never run — and the workspace module cannot import cli.
 */
export const CORE_VERBS = [
  'run',
  'watch',
  'cache',
  'lock',
  'init',
  'upgrade',
  'show',
  'info',
  'why',
  'last',
  'completions',
  'help',
  'version',
] as const

/** Every word the dispatcher matches before consulting plugins. */
export const DISPATCHED_VERBS: readonly string[] = [...CORE_VERBS, 'stats']

/**
 * Verbs core owned once and a package owns now. Not core verbs: a plugin
 * may declare them (`@vzn/vx-prune` does), and the dispatcher prints the
 * pointer only when no declared plugin claimed the name.
 */
export const MOVED_VERBS: Readonly<Record<string, string>> = {
  migrate:
    'vx migrate moved to @vzn/vx-migrate: run `bunx @vzn/vx-migrate` (turbo.json or an Nx ' +
    'project graph → vx.config.ts); `vx init` reads package.json scripts',
  prune:
    'vx prune moved to @vzn/vx-prune: run `bunx @vzn/vx-prune <project>`, or declare `prune()` ' +
    'from @vzn/vx-prune in vx.workspace.ts to keep the verb',
}
