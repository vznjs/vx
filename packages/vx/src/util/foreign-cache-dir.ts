import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { UserError } from './errors.js'

export const OWN_DIR_HINT =
  'Point `cache.dir` in .vx/workspace.ts (or --cache-dir) at a directory of its own, such as .vx/cache.'

/** Cache directories this process already found to be vx's own, with the workspace root asked for. */
const passed = new Set<string>()

/**
 * Refuses a cache directory that resolves to the home directory, the file
 * system root, or a directory holding the workspace or a repository:
 * compared unresolved, a `.vx/cache` linked to `~` or `..` passed, the run
 * wrote its index and config bundle there, and `vx cache clean` deleted
 * every entry (the home directory; the workspace's `.git` and config). The
 * config bundle asks first and the cache's open again: one realpath, as a
 * pass is kept for the process; a refusal is decided afresh each time. A
 * directory not there yet is made as named, by its caller.
 */
export function refuseForeignCacheDir(cacheDir: string, workspaceRoot: string | undefined): void {
  const memo = `${path.resolve(cacheDir)}\0${workspaceRoot ?? ''}`
  if (passed.has(memo)) return
  let real: string
  try {
    real = realpathSync(cacheDir)
  } catch {
    return
  }
  const home = process.env['HOME'] || homedir()
  let what: string | undefined
  if (real === path.parse(real).root) what = 'the file system root'
  else if (sameDir(real, home)) what = 'the home directory'
  else if (
    (workspaceRoot !== undefined && !path.relative(real, workspaceRoot).startsWith('..')) ||
    existsSync(path.join(real, '.git'))
  )
    what = 'a directory holding the workspace or a repository'
  if (what === undefined) {
    passed.add(memo)
    return
  }
  throw new UserError(
    `cache directory ${cacheDir} resolves to ${real}, ${what}: vx would keep its index there and \`vx cache clean\` would delete from it. ${OWN_DIR_HINT}`,
    'VX_E_CONFIG',
  )
}

function sameDir(a: string, b: string): boolean {
  if (a === path.resolve(b)) return true
  // A home named through a link: stats only when the names could agree.
  if (path.basename(a) !== path.basename(b)) return false
  try {
    const [x, y] = [statSync(a), statSync(b)]
    return x.ino === y.ino && x.dev === y.dev
  } catch {
    return false
  }
}
