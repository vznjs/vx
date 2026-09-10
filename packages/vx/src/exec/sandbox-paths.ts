// Path helpers the sandbox modules share: canonical forms (the policy
// matches real paths), the task-relative absolutizer the strace pass uses,
// and the prefix test.

import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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
