// A symlinked input folds as git folds it: the blob of its target STRING
// (file-hashes.ts). The task reads the bytes behind it, so a link whose
// target is no input of its own let an edit there replay the old output
// (Growth, 2026-10-16). Keying the target from here would leave `--affected`
// and `vx watch` blind to the same edit, so the target must be an input
// itself, and a link whose target is not is refused naming the declaration
// that keys it. A dangling link reads nothing.

import { realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { relPosix, UserError } from '../util/index.js'
import { runGitLsFiles } from './git-inputs.js'

const realRoots = new Map<string, string>()

/** Refuse the first link in `links` whose target's content `inputFiles` does not hold. */
export function refuseUnkeyedLinks(
  links: readonly string[],
  inputFiles: readonly string[],
  workspaceRoot: string,
): void {
  const inputs = new Set(inputFiles)
  let realRoot = realRoots.get(workspaceRoot)
  if (realRoot === undefined) {
    realRoot = realpathSync(workspaceRoot)
    realRoots.set(workspaceRoot, realRoot)
  }
  for (const link of links) {
    let real: string
    try {
      real = realpathSync(link)
    } catch {
      continue
    }
    const rel = path.relative(realRoot, real)
    const outside = rel.startsWith('..') || path.isAbsolute(rel)
    const targetRel = rel.split(path.sep).join('/')
    const head = `cache.inputs: "${relPosix(workspaceRoot, link)}" is a symlink to "${outside ? real : targetRel}"`
    const target = path.join(workspaceRoot, rel)
    if (!outside && statSync(real).isDirectory()) {
      const behind = runGitLsFiles(target).files
      const missing = behind.find((f) => !inputs.has(path.join(target, f)))
      if (missing === undefined) continue
      throw new UserError(
        `${head}, and "${targetRel}/${missing}" behind it is not an input — an edit to it would replay the old output. Add "${targetRel}/**" to cache.inputs.workspaceFiles.`,
      )
    }
    if (inputs.has(target)) continue
    if (outside || !listed(target)) {
      throw new UserError(
        `${head}, which git does not list (gitignored, or outside the workspace), so no glob can key it — an edit to it would replay the old output. Point the link at a tracked file, or exclude it from the inputs and key its content with cache.inputs.runtime.`,
      )
    }
    throw new UserError(
      `${head}, whose content the key does not see — an edit to it would replay the old output. Add "${targetRel}" to cache.inputs.workspaceFiles.`,
    )
  }
}

function listed(abs: string): boolean {
  const dir = path.dirname(abs)
  return runGitLsFiles(dir).files.includes(path.basename(abs))
}
