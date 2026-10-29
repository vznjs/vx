// A directory at where it leads, spelled under the workspace root: its own
// module, as discovery and the filters both ask it and filter.ts is one
// discovery imports.

import path from 'node:path'
import { isOutOfFds, realPath } from '../util/index.js'

const realRoots = new Map<string, string>()

/**
 * `dir` at the directory it leads to, spelled under `root` as given (a
 * root reached through a link, as macOS's temp dir is, keeps its
 * spelling); `dir` itself when that directory lies outside the root; null
 * when `dir` is not there. A workspace glob over linked packages (pnpm's
 * `widgets/**`, `widgets/a -> ../submodules/a`) names the link, and git
 * lists the config at the real directory: matched by spelling, one
 * directory was two projects, the config-less twin at the link taking
 * every edge.
 */
export function canonicalDir(root: string, dir: string): string | null {
  const real = realOrNull(dir)
  if (real === null) return null
  let realRoot = realRoots.get(root)
  if (realRoot === undefined) realRoots.set(root, (realRoot = realOrNull(root) ?? root))
  const rel = path.relative(realRoot, real)
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return dir
  return path.join(root, rel)
}

function realOrNull(p: string): string | null {
  try {
    return realPath(p)
  } catch (err) {
    if (isOutOfFds(err)) throw err
    return null
  }
}
