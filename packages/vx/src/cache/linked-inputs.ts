// A symlinked input keys the content behind it, as Nx reads a linked file
// where it points (owner, 2026-10-16: "Do like nx"). Its own fold stays the
// blob of its target STRING (file-hashes.ts), so a retarget to equal bytes
// moves the key; this is what follows it. The target string alone let an
// edit behind the link replay the old output (Growth, 2026-10-16), wherever
// the target lies: in the project, elsewhere in the workspace, outside it.
// A directory link keys every file beneath it, tracked or not, where Nx
// does not enter one: an edit there is an edit to what the task reads.
// `--affected` (workspace/affected.ts) and `vx watch` (cli/watch.ts) read
// the same targets.

import { readdirSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { xxh3hex } from '../util/index.js'
import { absentOr } from './key-fold.js'

/** What a dangling link, or a loop of links, holds behind it: nothing to read. */
const NOTHING_BEHIND = ''

/**
 * Directories a linked directory's walk never enters, as Nx's walker never
 * does (its HARDCODED_IGNORE_PATTERNS): a link to a workspace would
 * otherwise key the cache each run writes.
 */
const SKIPPED = ['.git', 'node_modules', '.vx/cache', '.yarn/cache']
const skipped = (rel: string): boolean => SKIPPED.some((s) => rel === s || rel.endsWith(`/${s}`))

/**
 * The files under `dir` a linked directory keys, relative and `/`-separated,
 * sorted: every regular file and link at any depth. A link is listed, never
 * entered (`behindLink` follows it), so a loop of directories ends.
 */
export function filesBehind(dir: string): string[] {
  const out: string[] = []
  const walk = (abs: string, rel: string): void => {
    let entries
    try {
      entries = readdirSync(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isDirectory()) {
        if (!skipped(childRel)) walk(path.join(abs, e.name), childRel)
      } else if (e.isFile() || e.isSymbolicLink()) out.push(childRel)
    }
  }
  walk(dir, '')
  return out.sort()
}

/**
 * The content behind the symlink at `link`, as one string: a file's identity
 * (`hashFile` of its real path), a directory's files and theirs, or
 * `NOTHING_BEHIND` for a dangling link or a loop. A special file (a FIFO, a
 * device) is named, never read: a read can block. Never memoized: an upstream
 * task may write behind the link between two keys.
 */
export async function behindLink(
  link: string,
  hashFile: (file: string) => Promise<string>,
  seen: ReadonlySet<string> = new Set(),
): Promise<string> {
  let real: string
  let st
  try {
    real = realpathSync(link)
    st = statSync(real)
  } catch {
    return NOTHING_BEHIND
  }
  if (seen.has(real)) return NOTHING_BEHIND
  if (st.isFile()) return `file\0${await hashFile(real).catch(absentOr)}`
  if (!st.isDirectory()) return 'special'
  const inner = new Set(seen).add(real)
  const parts = await Promise.all(
    filesBehind(real).map(async (rel) => {
      const abs = path.join(real, rel)
      const id = await hashFile(abs).catch(absentOr)
      return id.startsWith('120000:')
        ? `${rel}\0${id}\0${await behindLink(abs, hashFile, inner)}`
        : `${rel}\0${id}`
    }),
  )
  return `dir\0${xxh3hex(parts.join('\n'))}`
}
