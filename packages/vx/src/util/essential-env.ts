import path from 'node:path'

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
  // The XDG base directories, machine paths as HOME is. Stripped, a task
  // resolved other homes than the shell did: pnpm used another store, and
  // a CLI keeping its login there ran signed out (vercel/turborepo#13145).
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
]

/**
 * `PATH` less each `node_modules/.bin` inside `workspaceRoot`. `npm run`
 * in a member puts that member's bins, its parents' and the root's on the
 * PATH vx inherits; a task that kept them ran a sibling's bin, which no
 * key sees. A task gets back the two it may see (`taskBinDirs`).
 */
export function withoutWorkspaceBins(PATH: string, workspaceRoot: string): string {
  const inside = workspaceRoot.endsWith(path.sep) ? workspaceRoot : workspaceRoot + path.sep
  const bin = `${path.sep}node_modules${path.sep}.bin`
  return PATH.split(path.delimiter)
    .filter((entry) => {
      const dir = entry.endsWith(path.sep) ? entry.slice(0, -1) : entry
      return !(dir.startsWith(inside) && dir.endsWith(bin))
    })
    .join(path.delimiter)
}
