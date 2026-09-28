/**
 * The verbs the CLI dispatcher (`cli/index.ts`) owns. Lives in util rather than cli because the workspace VALIDATOR
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

/**
 * Verbs core owned once and a package owns now. Not core verbs: a plugin
 * may declare them, and the dispatcher prints the
 * pointer only when no declared plugin claimed the name.
 */
export const MOVED_VERBS: Readonly<Record<string, string>> = {
  migrate:
    'vx migrate moved to @vzn/vx-migrate: run `bunx @vzn/vx-migrate` (turbo.json or an Nx ' +
    'project graph → vx.config.ts); `vx init` reads package.json scripts',
  prune:
    'vx prune was removed (2026-09-11): the Docker-subset verb is not shipped; copy the ' +
    'workspace and `--filter` the build instead',
  stats: 'vx stats was removed (H-19): run `vx info`, which prints the same report',
}
