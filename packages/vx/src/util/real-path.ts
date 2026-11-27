import { lstatSync, readlinkSync, realpathSync, statSync, type Stats } from 'node:fs'
import path from 'node:path'

/**
 * `lstat`, or undefined for a path that is not there, a parent that is a
 * file included: Bun's `throwIfNoEntry: false` passes over ENOENT alone
 * (Node's over ENOTDIR too), and the ENOTDIR of `conf/b.txt` under a file
 * `conf` failed a key (2026-11-10), `--profile=<file>/p.json` and an output
 * under a file a past run left (2026-11-27).
 */
export function lstatOrAbsent(p: string): Stats | undefined {
  try {
    return lstatSync(p, { throwIfNoEntry: false })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOTDIR') return undefined
    throw err
  }
}

/** `stat` as `lstatOrAbsent` is `lstat`: a link to nothing is absent too. */
export function statOrAbsent(p: string): Stats | undefined {
  try {
    return statSync(p, { throwIfNoEntry: false })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOTDIR') return undefined
    throw err
  }
}

/**
 * A path's canonical spelling: the OS's own answer for the final path, so a key
 * or a comparison that folds the path sees one spelling.
 */
export function realPath(p: string): string {
  return realpathSync.native(p)
}

/**
 * Whether `a` and `b` are one directory: two spellings a disk folds
 * together (APFS's NFC and NFD), not two that merely compare equal.
 */
export function sameDir(a: string, b: string): boolean {
  const sa = statOrAbsent(a)
  const sb = sa === undefined ? undefined : statOrAbsent(b)
  return sb !== undefined && sa!.ino === sb.ino && sa!.dev === sb.dev
}

/**
 * `realpathSync`, for a path holding a backslash too: Bun's answers ENOENT
 * for any such path (1.4.2), so an output under `dist/a\b/` was dropped
 * from its artifact. Such a path's links are read one by one. Throws as
 * `realpathSync` does when the path is not there.
 */
export function realpathOf(p: string): string {
  try {
    return realpathSync(p)
  } catch (err) {
    if (!p.includes('\\')) throw err
    return resolveLinks(p)
  }
}

function resolveLinks(p: string): string {
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
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EINVAL') throw err
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
