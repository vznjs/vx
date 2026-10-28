// What a worker must have checked out: the tracked files as the run sees
// them. Workers compare trees, not commits, so a run on uncommitted changes
// still matches the worktrees `local()` makes from them.

/**
 * A commit of the tracked files as they are now (`HEAD`'s when none changed),
 * and its tree; both empty when git cannot say.
 */
export async function snapshot(root: string): Promise<{ commit: string; tree: string }> {
  // `git stash create` touches neither the index nor the working tree. Its
  // commit is nobody's, so it needs no one's identity: a CI runner with none
  // made it fail, and HEAD stood in for the changes (2026-10-28).
  const made = await git(['stash', 'create'], root, IDENTITY)
  if (made === undefined) return { commit: '', tree: '' }
  const commit = made.trim() || ((await git(['rev-parse', 'HEAD'], root)) ?? '').trim()
  if (commit === '') return { commit: '', tree: '' }
  return { commit, tree: ((await git(['rev-parse', `${commit}^{tree}`], root)) ?? '').trim() }
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
