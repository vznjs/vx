// What packages.ts needs of the file system and of globs, as core has
// them: core's copies are not on the façade, and these left core with the
// package-manager discovery (2026-10-14).

import { readlinkSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { UserError } from '@vzn/vx'

/** An `EACCES`, `EPERM` or `EROFS`: not this user's to read or write. */
export function isPermissionError(err: unknown): err is NodeJS.ErrnoException {
  if (!(err instanceof Error)) return false
  const code = (err as NodeJS.ErrnoException).code
  return code === 'EACCES' || code === 'EPERM' || code === 'EROFS'
}

/** `EMFILE` or `ENFILE`: out of file descriptors, never "no file here". */
export function isOutOfFds(err: unknown): err is NodeJS.ErrnoException {
  if (!(err instanceof Error)) return false
  const code = (err as NodeJS.ErrnoException).code
  return code === 'EMFILE' || code === 'ENFILE'
}

/** `Bun.Glob`'s own alphabet, the class included: member globs follow npm/pnpm. */
export const BUN_GLOB_WILDCARDS = /[*?[\]{}]/

/** An extglob group (`!(…)`, `@(…)`, …), which `Bun.Glob` does not read. */
export const EXTGLOB = /[!@+*?]\(/

/**
 * The spellings npm and pnpm accept that a matcher fed the raw string
 * turns into nothing: a leading `./`, an inner `/./`, a doubled `//`, and a
 * trailing `/` on a pattern. Applied after an optional `!`.
 */
export function normalizeBunGlob(glob: string): string {
  const neg = glob.startsWith('!')
  let g = neg ? glob.slice(1) : glob
  g = g.replace(/\/{2,}/g, '/').replace(/(^|\/)(\.\/)+/g, '$1')
  if (g === '.') g = ''
  if (BUN_GLOB_WILDCARDS.test(g) && g.endsWith('/')) g = `${g.replace(/\/+$/, '')}/**`
  return neg ? `!${g}` : g
}

/**
 * `pattern` with its first brace group expanded, recursively, while that
 * group holds a `/`: `Bun.Glob`'s scan finds nothing for one.
 */
export function slashBraceExpansions(pattern: string): string[] {
  if (pattern.includes('\\')) return [pattern]
  for (let open = pattern.indexOf('{'); open !== -1; open = pattern.indexOf('{', open + 1)) {
    let depth = 0
    const cuts: number[] = []
    let close = -1
    for (let i = open; i < pattern.length && close === -1; i++) {
      const c = pattern[i]
      if (c === '{') depth++
      else if (c === '}' && --depth === 0) close = i
      else if (c === ',' && depth === 1) cuts.push(i)
    }
    if (close === -1) return [pattern]
    if (cuts.length === 0 || !pattern.slice(open + 1, close).includes('/')) continue
    const head = pattern.slice(0, open)
    const tail = pattern.slice(close + 1)
    const bounds = [open, ...cuts, close]
    const out: string[] = []
    for (let k = 0; k + 1 < bounds.length; k++) {
      out.push(...slashBraceExpansions(head + pattern.slice(bounds[k]! + 1, bounds[k + 1]) + tail))
    }
    return [...new Set(out)]
  }
  return [pattern]
}

/**
 * `realpathSync`, for a path holding a backslash too: Bun's answers ENOENT
 * for any such path (1.4.2), so its links are read one by one.
 */
export function realpathOf(p: string): string {
  try {
    return realpathSync(p)
  } catch (err) {
    if (!p.includes('\\')) throw err
    // Not `path.resolve`: it folds `link/..` lexically, and the kernel
    // takes `..` from where the link leads.
    const abs = path.isAbsolute(p) ? p : `${process.cwd()}${path.sep}${p}`
    let at = path.parse(abs).root
    const pending = abs.slice(at.length).split(path.sep).filter(Boolean).reverse()
    let hops = 0
    while (pending.length > 0) {
      const next = path.join(at, pending.pop()!)
      let link: string
      try {
        link = readlinkSync(next)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EINVAL') throw e
        at = next
        continue
      }
      // Linux's own bound on links followed in one lookup (MAXSYMLINKS).
      if (++hops > 40) {
        throw Object.assign(
          new Error(`ELOOP: too many symbolic links encountered, realpath '${p}'`),
          {
            code: 'ELOOP',
          },
        )
      }
      if (path.isAbsolute(link)) at = path.parse(link).root
      pending.push(...link.split('/').filter(Boolean).reverse())
    }
    return at
  }
}

/**
 * The git top-level holding `dir`, or null outside git: the nearest `.git`
 * up from it. A submodule's `.git` file points into its superproject's
 * `.git/modules`, so the walk goes on to the superproject's.
 */
export async function gitTop(dir: string): Promise<string | null> {
  for (let d = dir; ; d = d.slice(0, d.lastIndexOf('/'))) {
    if (await Bun.file(`${d}/.git/HEAD`).exists()) return d || '/'
    const file = Bun.file(`${d}/.git`)
    if (await file.exists()) {
      const gitdir = await file.text().catch(() => '')
      if (!/(^|[\s/])\.git\/modules\//.test(gitdir)) return d || '/'
      // A submodule's own worktree points there too, and is a top-level:
      // git writes `commondir` in a worktree's gitdir alone.
      const to = gitdir.replace(/^gitdir:\s*/, '').trim()
      if (await Bun.file(`${to.startsWith('/') ? '' : `${d}/`}${to}/commondir`).exists())
        return d || '/'
    }
    if (d === '') return null
  }
}

/** The files one discovery has read, by absolute path: the bytes, or null when none is there. */
export type LoadReads = Map<string, Promise<Uint8Array | null>>

/** `file`'s bytes, read at most once per `reads`; null when there is no file there. */
export function readOnce(reads: LoadReads | undefined, file: string): Promise<Uint8Array | null> {
  const held = reads?.get(file)
  if (held !== undefined) return held
  const f = Bun.file(file)
  const pending = f
    .exists()
    .then((there) => (there ? f.bytes().catch((err: unknown) => unreadable(err, file)) : null))
  reads?.set(file, pending)
  return pending
}

/** A read the file system refused, named as a read; anything else rethrown. */
export function unreadable(err: unknown, file: string): never {
  if (isPermissionError(err)) {
    throw new UserError(`${file}: not readable by this user (${err.code})`)
  }
  throw err
}
