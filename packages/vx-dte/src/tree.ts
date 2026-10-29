// What a worker must have checked out: the tracked files as the run sees
// them. Workers compare trees, not commits, so a run on uncommitted changes
// still matches the worktrees `local()` makes from them.

import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * A commit of the tracked files as they are now (`HEAD`'s when none changed),
 * and its tree; both empty when git cannot say.
 */
export async function snapshot(root: string): Promise<{ commit: string; tree: string }> {
  const none = { commit: '', tree: '' }
  const head = (await git(['rev-parse', '--verify', '-q', 'HEAD^{commit}'], root))?.trim()
  if (head === undefined || head === '') return none
  // The working tree's tracked files staged into a copy of the index, which
  // leaves the index and the working tree as they are. `git stash create`
  // did the same, but refused an intent-to-add entry (`git add -N`), and
  // HEAD stood in for the changes (2026-10-28).
  const index = (
    await git(['rev-parse', '--path-format=absolute', '--git-path', 'index'], root)
  )?.trim()
  if (index === undefined) return none
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-dte-index-'))
  try {
    const env = { GIT_INDEX_FILE: path.join(dir, 'index') }
    try {
      await copyFile(index, env.GIT_INDEX_FILE)
    } catch {
      // quiet: no index yet, so HEAD's tree is its tracked set.
      if ((await git(['read-tree', head], root, env)) === undefined) return none
    }
    if ((await git(['add', '-u', '--', ':/'], root, env)) === undefined) return none
    const tree = (await git(['write-tree'], root, env))?.trim()
    if (tree === undefined || tree === '') return none
    const was = (await git(['rev-parse', `${head}^{tree}`], root))?.trim()
    if (tree === was) return { commit: head, tree }
    // The commit is nobody's, so it needs no one's identity: a CI runner
    // with none made `git stash create` fail (2026-10-28).
    const commit = (
      await git(['commit-tree', tree, '-p', head, '-m', 'vx dte'], root, IDENTITY)
    )?.trim()
    return commit === undefined || commit === '' ? none : { commit, tree }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const IDENTITY = {
  GIT_AUTHOR_NAME: 'vx',
  GIT_AUTHOR_EMAIL: 'vx@localhost',
  GIT_COMMITTER_NAME: 'vx',
  GIT_COMMITTER_EMAIL: 'vx@localhost',
}

/** git's stdout, or undefined when it failed. */
async function git(
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<string | undefined> {
  const p = Bun.spawn(['git', ...args], {
    cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
    ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
  })
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited])
  return code === 0 ? out : undefined
}
