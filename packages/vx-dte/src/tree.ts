// What a worker must have checked out: the tracked files as the run sees
// them. Workers compare trees, not commits, so a run on uncommitted changes
// still matches the worktrees `local()` makes from them.

/** A commit of the tracked files as they are now (`HEAD`'s when none changed), and its tree. */
export async function snapshot(root: string): Promise<{ commit: string; tree: string }> {
  // `git stash create` touches neither the index nor the working tree.
  const made = (await git(['stash', 'create'], root)).trim()
  const commit = made === '' ? (await git(['rev-parse', 'HEAD'], root)).trim() : made
  return { commit, tree: (await git(['rev-parse', `${commit}^{tree}`], root)).trim() }
}

async function git(args: string[], cwd: string): Promise<string> {
  const p = Bun.spawn(['git', ...args], { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' })
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited])
  return code === 0 ? out : ''
}
