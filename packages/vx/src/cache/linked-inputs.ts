// A symlinked input keys the content behind it, as Nx reads a linked file where
// it points. Its own fold stays the blob of its target STRING (file-hashes.ts),
// so a retarget to equal bytes moves the key; this is what follows it. The
// target string alone let an edit behind the link replay the old output
// wherever the target lies: in the project, elsewhere in the
// workspace, outside it. A directory link keys every file beneath it, tracked
// or not, where Nx does not enter one: an edit there is an edit to what the
// task reads. `--affected` (workspace/affected.ts) and `vx watch`
// (cli/watch.ts) read the same targets.
//
// Never into another project (principle 6): a link there keys its target
// string alone, and a nested project's directory is not walked. Followed,
// `b/src/a -> ../../a` keyed a's gitignored dist, so a's restore between b's
// up-front key and its run re-keyed b, which was never saved. What b reads
// of a reaches its key through `dependsOn`, as a's input key.

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

/** Each workspace's project directories, made real (deepest first) at the first link. */
const projectDirsOf = new Map<string, { readonly raw: readonly string[]; real?: string[] }>()

/**
 * Set as a run loads its projects: the directories a link never keys into
 * but its own. Nothing is resolved until a link input asks (links are rare).
 */
export function setProjectDirs(workspaceRoot: string, dirs: readonly string[]): void {
  projectDirsOf.set(workspaceRoot, { raw: dirs })
}

function realOr(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

const within = (dir: string, p: string): boolean => p === dir || p.startsWith(dir + path.sep)

/** The project a link sits in, and every project of its workspace. */
interface LinkBounds {
  readonly dirs: readonly string[]
  readonly own: string | undefined
}

function boundsOf(link: string): LinkBounds | undefined {
  if (projectDirsOf.size === 0) return undefined
  const at = realOr(path.dirname(link))
  for (const [root, entry] of projectDirsOf) {
    if (!within(realOr(root), at)) continue
    const dirs = (entry.real ??= entry.raw.map(realOr).sort((a, b) => b.length - a.length))
    return { dirs, own: dirs.find((d) => within(d, at)) }
  }
  return undefined
}

/** `real` lies in a project other than the link's own. */
function otherProject(bounds: LinkBounds | undefined, real: string): boolean {
  if (bounds === undefined) return false
  const owner = bounds.dirs.find((d) => within(d, real))
  return owner !== undefined && owner !== bounds.own
}

/**
 * The files under `dir` a linked directory keys, relative and `/`-separated,
 * sorted: every regular file and link at any depth. A link is listed, never
 * entered (`behindLink` follows it), so a loop of directories ends. Under
 * a link's bounds a directory of another project is not entered.
 */
export function filesBehind(dir: string): string[] {
  return walkBehind(dir, undefined)
}

function walkBehind(dir: string, bounds: LinkBounds | undefined): string[] {
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
        const child = path.join(abs, e.name)
        if (!skipped(childRel) && !otherProject(bounds, child)) walk(child, childRel)
      } else if (e.isFile() || e.isSymbolicLink()) out.push(childRel)
    }
  }
  walk(dir, '')
  return out.sort()
}

/**
 * The content behind the symlink at `link`, as one string: a file's identity
 * (`hashFile` of its real path), a directory's files and theirs, or
 * `NOTHING_BEHIND` for a dangling link, a loop or a target in another project. A special file (a FIFO, a
 * device) is named, never read: a read can block. Never memoized: an upstream
 * task may write behind the link between two keys.
 */
export function behindLink(
  link: string,
  hashFile: (file: string) => Promise<string>,
): Promise<string> {
  return follow(link, hashFile, new Set(), boundsOf(link))
}

async function follow(
  link: string,
  hashFile: (file: string) => Promise<string>,
  seen: ReadonlySet<string>,
  bounds: LinkBounds | undefined,
): Promise<string> {
  let real: string
  let st
  try {
    real = realpathSync(link)
    st = statSync(real)
  } catch {
    return NOTHING_BEHIND
  }
  if (seen.has(real) || otherProject(bounds, real)) return NOTHING_BEHIND
  // A repository's own store, as a `.git/**` input names nothing: walked,
  // every commit and index write re-keyed the task. Its target string keys.
  if (real.split(path.sep).includes('.git')) return NOTHING_BEHIND
  if (st.isFile()) return `file\0${await hashFile(real).catch(absentOr)}`
  if (!st.isDirectory()) return 'special'
  const inner = new Set(seen).add(real)
  const parts = await Promise.all(
    walkBehind(real, bounds).map(async (rel) => {
      const abs = path.join(real, rel)
      const id = await hashFile(abs).catch(absentOr)
      return id.startsWith('120000:')
        ? `${rel}\0${id}\0${await follow(abs, hashFile, inner, bounds)}`
        : `${rel}\0${id}`
    }),
  )
  return `dir\0${xxh3hex(parts.join('\n'))}`
}
