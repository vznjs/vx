// The sandbox runtime's mandatory-deny scan, scoped to what a task can
// write (B-40). SRT walks `process.cwd()` (the workspace root) with
// `rg --max-depth 3` on every wrap and keeps a hit only when it lies in
// an allowed write path: anything else is already read-only under
// `--ro-bind / /`. A deny is the hit or one of its ancestors, so every
// hit that counts lies under a write path, and walking the write paths
// finds them all. On 1,090 packages the whole-root walk was half of a
// sandboxed run's wall time (25.5 s → 14.0 s without it). SRT keeps its
// own scan at depth 1 for the root's entries; this supplies the rest,
// per task and never from a memo (a refusal is decided by it).
//
// It is a superset of rg's hits, never a subset: it does not read
// `.gitignore`, walks into `node_modules`, and counts a symlink by its
// name. Each can only add a deny where rg would have skipped the path.

import { lstatSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { relPosix, UserError } from '../util/index.js'
import { atOrUnder, MOUNT_WILDCARDS } from './sandbox-paths.js'

/** SRT's `rg --max-depth` for the scan (`DEFAULT_MANDATORY_DENY_SEARCH_DEPTH`). */
const SEARCH_DEPTH = 3

/** SRT's `DANGEROUS_FILES`: matched by name, case-insensitively, at any depth. */
const DANGEROUS_FILES = new Set([
  '.gitconfig',
  '.gitmodules',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.ripgreprc',
  '.mcp.json',
])

/** SRT's `getDangerousDirectories()`: a hit is any file below one. */
const DANGEROUS_DIRS = ['.vscode', '.idea', '.claude/commands', '.claude/agents']

/** The write paths SRT adds to every wrap (`getDefaultWritePaths`); `/dev` never holds a hit. */
export function srtDefaultWritePaths(): string[] {
  const home = homedir()
  return [
    '/tmp/claude',
    '/private/tmp/claude',
    path.join(home, '.npm/_logs'),
    path.join(home, '.claude/debug'),
  ]
}

const lower = (s: string): string => s.toLowerCase()

/** Whether `rel` (from the scan root, `/`-separated) is one of rg's hits for SRT's patterns. */
function isHit(rel: string, gitConfig: boolean): boolean {
  const segs = rel.split('/').map(lower)
  if (DANGEROUS_FILES.has(segs[segs.length - 1]!)) return true
  const inside = (dir: string): boolean => {
    const d = dir.split('/')
    for (let i = 0; i + d.length < segs.length; i++) {
      if (d.every((s, j) => segs[i + j] === s)) return true
    }
    return false
  }
  if (DANGEROUS_DIRS.some(inside) || inside('.git/hooks')) return true
  // `**/.git/config`, unless the task grants `gitConfig` (B-41).
  return (
    !gitConfig &&
    segs.length >= 2 &&
    segs[segs.length - 2] === '.git' &&
    segs[segs.length - 1] === 'config'
  )
}

/** The deny path SRT derives from a hit (`linuxGetMandatoryDenyPaths`), or none. */
function denyOf(cwd: string, rel: string): string | undefined {
  const absolute = path.resolve(cwd, rel)
  const segments = absolute.split(path.sep)
  // Two-segment names never equal one segment: their hits fall through to
  // the file itself, as they do in SRT.
  for (const dir of [...DANGEROUS_DIRS, '.git']) {
    const i = segments.findIndex((s) => lower(s) === lower(dir))
    if (i === -1) continue
    if (dir !== '.git') return segments.slice(0, i + 1).join(path.sep)
    const gitDir = segments.slice(0, i + 1).join(path.sep)
    if (rel.includes('.git/hooks')) return path.join(gitDir, 'hooks')
    if (rel.includes('.git/config')) return path.join(gitDir, 'config')
    return undefined
  }
  return absolute
}

/**
 * The mandatory write denies for a task whose write grants are
 * `writePaths` (absolute), as SRT's whole-root scan of `cwd` would find
 * them within those grants. Throws when a deny could not reach bwrap: a
 * path with a glob character is dropped from `denyWrite` on Linux, and
 * the write it guards must not be left open.
 */
export function scopedMandatoryDenies(
  cwd: string,
  writePaths: readonly string[],
  gitConfig = false,
): string[] {
  const roots = new Set<string>()
  for (const w of writePaths) {
    if (atOrUnder(cwd, w)) roots.add(cwd)
    else if (atOrUnder(w, cwd)) roots.add(w)
  }
  const denies = new Set<string>()
  const visit = (abs: string, rel: string, depth: number): void => {
    let entries
    try {
      entries = readdirSync(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isDirectory()) {
        if (depth + 1 < SEARCH_DEPTH) visit(path.join(abs, e.name), childRel, depth + 1)
      } else if (isHit(childRel, gitConfig)) {
        const d = denyOf(cwd, childRel)
        if (d !== undefined) denies.add(d)
      }
    }
  }
  for (const root of roots) {
    const rel = relPosix(cwd, root)
    const depth = rel === '' ? 0 : rel.split('/').length
    if (depth > SEARCH_DEPTH) continue
    let dir: boolean
    try {
      dir = lstatSync(root).isDirectory()
    } catch {
      continue
    }
    if (dir) {
      if (depth < SEARCH_DEPTH) visit(root, rel, depth)
    } else if (isHit(rel, gitConfig)) {
      const d = denyOf(cwd, rel)
      if (d !== undefined) denies.add(d)
    }
  }
  for (const d of denies) {
    // SRT's `containsGlobChars` is this set: such a `denyWrite` entry is dropped on Linux.
    if (MOUNT_WILDCARDS.test(d)) {
      throw new UserError(
        `the sandbox must keep ${d} read-only, and a path with a glob character (* ? [ ]) cannot reach it — rename the directory`,
      )
    }
  }
  return [...denies]
}

/** Whether the scan can be scoped here: a root with a glob character loses every supplied deny. */
export function canScopeDenyScan(cwd: string): boolean {
  return !MOUNT_WILDCARDS.test(cwd)
}
