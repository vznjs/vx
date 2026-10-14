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
  'docs',
  'completions',
  'help',
  'version',
] as const
