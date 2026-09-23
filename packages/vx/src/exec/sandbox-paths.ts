// Path helpers the sandbox modules share: canonical forms (the policy
// matches real paths), the task-relative absolutizer the strace pass uses,
// and the prefix test.

import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * The wildcard alphabet of a GRANT — what decides whether a declared read or
 * write path is scanned for its matches or mounted as the path it names.
 * Deliberately smaller than `BUN_GLOB_WILDCARDS` (util/paths.ts, `Bun.Glob`'s
 * own set), which also counts `{}`: `write: ['g/{a,b}.txt']` is a
 * LITERAL to the sandbox, gets a placeholder file, and is widened to its
 * directory like any other file-shaped grant — measured ok, and pinned in
 * `tests/sandbox-runtime.unsafe.test.ts`. Counting the brace here would
 * move that spelling into the scan, which finds nothing before the task has
 * written, and turn a working grant into `Read-only file system`. The two
 * predicates answer different questions: whether a declaration must be
 * MATCHED against other declarations (495; `GLOB_WILDCARDS`, where a bracket
 * is literal since item 667), and whether a grant can be mounted (here).
 * Item 577 gave each question one spelling.
 */
export const MOUNT_WILDCARDS = /[*?[\]]/

/** True when a grant names one path the sandbox can mount, rather than a pattern to scan. */
export function isMountableLiteral(grant: string): boolean {
  return !MOUNT_WILDCARDS.test(grant)
}

/**
 * Canonicalize a path with realpath, tolerating paths that don't exist
 * yet: resolve the longest existing ancestor and re-append the rest.
 *
 * Why: the sandbox policy matches on canonical paths (macOS seatbelt
 * evaluates real vnode paths), and SRT's own normalization refuses to
 * canonicalize bare symlinked roots like `/tmp` → `/private/tmp` (its
 * boundary check only whitelists `/tmp/<child>` forms). Without this,
 * `allowWrite: ['/tmp']` silently never matches on macOS.
 */
export function toRealPath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    const parent = path.dirname(p)
    if (parent === p) return p
    return path.join(toRealPath(parent), path.basename(p))
  }
}

export function absolutize(p: string, cwd?: string): string {
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1))
  if (path.isAbsolute(p)) return p
  return path.resolve(cwd ?? process.cwd(), p)
}

export function isUnderAny(abs: string, allow: Set<string>): boolean {
  if (allow.has(abs)) return true
  for (const a of allow) {
    if (abs === a || abs.startsWith(a + path.sep)) return true
  }
  return false
}

export function unique(arr: readonly string[]): string[] {
  return [...new Set(arr)]
}

/** `allow.localBinding` grants loopback: `true`, or a non-empty port list. */
export function localBindingOn(c: { localBinding?: boolean | readonly number[] }): boolean {
  return c.localBinding === true || (Array.isArray(c.localBinding) && c.localBinding.length > 0)
}
