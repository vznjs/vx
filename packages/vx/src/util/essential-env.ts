import { existsSync, realpathSync } from 'node:fs'
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
 * key sees. A task gets back the two it may see (`taskBinDirs`). Inside
 * by spelling, or by canonical path: an entry spelled through a symlink
 * (macOS's `/tmp`, a linked home, a shell's `$PWD`) kept a sibling's bin
 * beside a canonical root.
 */
export function withoutWorkspaceBins(PATH: string, workspaceRoot: string): string {
  const bin = `${path.sep}node_modules${path.sep}.bin`
  const within = (dir: string, root: string): boolean =>
    dir.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
  let root: string | undefined
  return PATH.split(path.delimiter)
    .filter((entry) => {
      const dir = entry.endsWith(path.sep) ? entry.slice(0, -1) : entry
      if (!dir.endsWith(bin)) return true
      if (within(dir, workspaceRoot)) return false
      // Relative, it is the task's cwd's: not a place this check can name.
      if (!path.isAbsolute(dir)) return true
      const real = canonical(dir)
      if (real === undefined) return true
      root ??= canonical(workspaceRoot) ?? workspaceRoot
      return !within(real, root)
    })
    .join(path.delimiter)
}

/**
 * `p`'s canonical spelling; undefined when it is not there, and a missing
 * directory on PATH resolves nothing. Asked per call, never memoized: a
 * task may create the bin directory (an install) or a link above it, and a
 * fact about a file a task can write is not reused across tasks.
 */
function canonical(p: string): string | undefined {
  // A stat, not a throw: most such entries are npm's ancestors of the
  // root, and an ENOENT thrown per entry was 3 µs a spawn each.
  if (!existsSync(p)) return undefined
  try {
    return realpathSync.native(p)
  } catch {
    return undefined
  }
}
