/**
 * Every task gets these (`exec/env.ts`), so `hideEnvFromTasks` leaves
 * them. Exported so the schema doc's enumeration of it can be PINNED against the
 * real list: a hand-copied allowlist is how the two drift, and a reader
 * asking "what does my build script actually see?" is asking a
 * security-shaped question that a stale list answers wrongly.
 */
export const ESSENTIAL_ENV: readonly string[] = [
  'PATH',
  'HOME',
  'SHELL',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'FORCE_COLOR',
  'NO_COLOR',
  'CI',
  'NODE_OPTIONS',
  // Where corepack and pnpm keep their own binaries, as HOME is: a machine
  // path, never task output. Without them a corepack shim re-downloads its
  // manager (offline or sandboxed: fails) and pnpm loses its global dir.
  'COREPACK_HOME',
  'PNPM_HOME',
]
