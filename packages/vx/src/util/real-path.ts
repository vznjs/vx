import { readlinkSync, realpathSync } from 'node:fs'
import path from 'node:path'

/**
 * A path's canonical spelling: the OS's own answer for the final path,
 * so a key or a comparison that folds the path sees one spelling (O-16).
 */
export function realPath(p: string): string {
  return realpathSync.native(p)
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
