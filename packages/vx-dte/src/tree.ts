// What a worker must have checked out: the tracked files as the run sees
// them. Workers compare trees, not commits, so a run on uncommitted changes
// still matches the worktrees `local()` makes from them.

import { UserError } from '@vzn/vx'

/** A commit of the tracked files as they are now (`HEAD`'s when none changed), and its tree. */
export async function snapshot(root: string): Promise<{ commit: string; tree: string }> {
  // `git stash create` touches neither the index nor the working tree.
  const made = await git(['stash', 'create'], root)
  if (made.code !== 0) {
    const head = await git(['rev-parse', '--verify', '-q', 'HEAD'], root)
    if (head.code !== 0) return { commit: '', tree: '' }
    // HEAD is not the tree a run with an unmerged index sees: workers ran
    // HEAD's files under the working tree's keys and saved them there.
    const why = made.err.split('\n').find((l) => l.trim() !== '') ?? `exit ${made.code}`
    throw new UserError(`dte(): no snapshot of the tracked files (git stash create: ${why})`)
  }
  const commit = made.out.trim() || (await git(['rev-parse', 'HEAD'], root)).out.trim()
  const tree = await git(['rev-parse', `${commit}^{tree}`], root)
  return { commit, tree: tree.code === 0 ? tree.out.trim() : '' }
}

async function git(
  args: string[],
  cwd: string,
): Promise<{ out: string; err: string; code: number }> {
  const p = Bun.spawn(['git', ...args], { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  return { out: code === 0 ? out : '', err, code }
}
