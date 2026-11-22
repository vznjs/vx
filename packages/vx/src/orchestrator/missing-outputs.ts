// Every declared output is required (M 2026-11-22): a positive glob that
// matches nothing once the command exited 0 fails the task. An empty artifact
// would replay as a build that ran; a pattern against the wrong directory, a
// sandbox with no write grant and an incremental tool that skipped its emit
// all look like this.

import { lstatSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { anyTaskGlob, asTrees, isLiteralPattern, splitNegations, taskGlob } from '../util/index.js'

const SCAN = { onlyFiles: false, followSymlinks: false, dot: true } as const

/**
 * The positive globs of `globs` (relative to `base`) that match no path a `!`
 * leaves. Each stops at its first match: `dist/**` costs one directory read,
 * not the walk the save does.
 */
export async function missingOutputs(
  base: string,
  globs: readonly string[],
  nestedDirs: readonly string[],
): Promise<string[]> {
  const { positive, negative } = splitNegations(globs)
  if (positive.length === 0) return []
  const takenBack = anyTaskGlob(negative)
  const nested = nestedDirs
    .map((d) => path.relative(base, d))
    .filter((r) => r !== '' && !r.startsWith('..'))
  const kept = (rel: string): boolean =>
    !takenBack(rel) && !nested.some((n) => rel === n || rel.startsWith(`${n}/`))
  const missing: string[] = []
  for (const g of positive) if (!(await matchesAny(base, g, kept))) missing.push(g)
  return missing
}

async function matchesAny(
  base: string,
  glob: string,
  kept: (rel: string) => boolean,
): Promise<boolean> {
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
    // `dir/**` takes `dir` itself: an empty one is saved, and a hit makes it.
    if (tree === `${prefix}/**` && kept(prefix) && isEmptyDir(path.join(base, prefix))) return true
    for await (const rel of taskGlob(tree).scan({ ...SCAN, cwd: base })) {
      if (rel !== '' && kept(rel)) return true
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

function isEmptyDir(abs: string): boolean {
  try {
    return (
      lstatSync(abs, { throwIfNoEntry: false })?.isDirectory() === true &&
      readdirSync(abs).length === 0
    )
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
