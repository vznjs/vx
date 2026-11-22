// Every declared output is required (M 2026-11-22): a positive glob that
// matches nothing once the command exited 0 fails the task. An empty artifact
// would replay as a build that ran; a pattern against the wrong directory, a
// sandbox with no write grant and an incremental tool that skipped its emit
// all look like this.

import { lstatSync, statSync } from 'node:fs'
import path from 'node:path'
import { anyTaskGlob, asTrees, isLiteralPattern, splitNegations, taskGlob } from '../util/index.js'

const SCAN = { onlyFiles: false, followSymlinks: false, dot: true } as const

/**
 * The positive globs of `globs` (relative to `base`) that match no path a `!`
 * leaves. Each stops at its first match: `dist/**` costs one directory read,
 * not the walk the save does.
 */
export function missingOutputs(
  base: string,
  globs: readonly string[],
  nestedDirs: readonly string[],
): string[] {
  const { positive, negative } = splitNegations(globs)
  if (positive.length === 0) return []
  const takenBack = anyTaskGlob(negative)
  const nested = nestedDirs
    .map((d) => path.relative(base, d))
    .filter((r) => r !== '' && !r.startsWith('..'))
  const kept = (rel: string): boolean =>
    !takenBack(rel) && !nested.some((n) => rel === n || rel.startsWith(`${n}/`))
  const missing: string[] = []
  for (const g of positive) if (!matchesAny(base, g, kept)) missing.push(g)
  return missing
}

function matchesAny(base: string, glob: string, kept: (rel: string) => boolean): boolean {
  for (const tree of asTrees([glob])) {
    if (isLiteralPattern(tree)) {
      if (kept(tree) && exists(path.join(base, tree))) return true
      continue
    }
    // A link to a directory is listed by its own name, which a glob reaching
    // below it does not match: its target holds the outputs.
    const prefix = staticPrefix(tree)
    if (prefix !== '' && kept(prefix) && linksToDir(path.join(base, prefix))) return true
    if (prefix !== '' && !exists(path.join(base, prefix))) continue
    // `dir/**` left empty matched nothing: the clean keeps the root, so an
    // empty one is no sign the command wrote. A literal `dir` is required
    // as itself, and the clean removes it.
    // Synchronous: it stops at the first match, and the async scan's answer
    // waited its turn on a busy run's loop with the task's slot held (1.1 ms
    // a build on the bench's cold run, against 0.05 ms).
    try {
      for (const rel of taskGlob(tree).scanSync({ ...SCAN, cwd: base })) {
        if (rel !== '' && kept(rel)) return true
      }
    } catch {
      // A directory it cannot list holds something: the save names it.
      return true
    }
  }
  return false
}

function staticPrefix(glob: string): string {
  const parts = glob.split('/')
  const i = parts.findIndex((p) => !isLiteralPattern(p))
  return parts.slice(0, i).join('/')
}

function exists(abs: string): boolean {
  try {
    return lstatSync(abs, { throwIfNoEntry: false }) !== undefined
  } catch {
    return false
  }
}

function linksToDir(abs: string): boolean {
  try {
    return (
      lstatSync(abs, { throwIfNoEntry: false })?.isSymbolicLink() === true &&
      statSync(abs, { throwIfNoEntry: false })?.isDirectory() === true
    )
  } catch {
    return false
  }
}
