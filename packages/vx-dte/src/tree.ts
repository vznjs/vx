// What a worker must have checked out: the tracked files as the run sees
// them. Workers compare trees, not commits, so a run on uncommitted changes
// still matches the worktrees `local()` makes from them.

import { existsSync } from 'node:fs'
import { copyFile, mkdtemp, rm, stat, utimes } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PROJECT_CONFIG_FILENAMES, UserError } from '@vzn/vx'

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
  const [top, index] =
    (
      await git(
        ['rev-parse', '--show-toplevel', '--path-format=absolute', '--git-path', 'index'],
        root,
      )
    )?.split('\n') ?? []
  if (top === undefined || index === undefined) return none
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-dte-index-'))
  try {
    const env = { GIT_INDEX_FILE: path.join(dir, 'index') }
    try {
      await copyFile(index, env.GIT_INDEX_FILE)
      // The copy keeps the index's mtime (as core's refreshedIndex): git
      // trusts an entry's stat only while its file is older than the index,
      // and a fresh mtime took a same-size edit made in the tick the index
      // was written for clean, its old blob in the tree (2026-10-29).
      const st = await stat(index)
      await utimes(env.GIT_INDEX_FILE, st.atime, st.mtime)
    } catch {
      // quiet: no index yet, so HEAD's tree is its tracked set.
      if ((await git(['read-tree', head], root, env)) === undefined) return none
    }
    await unflag(top, env)
    if ((await git([...UNSPARSE, 'add', '-u', '--', ':/'], root, env)) === undefined) return none
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

/**
 * The workspace config core loads (the first `.vx/workspace.*` under
 * `root`), when `tree` lacks it: every worker started without one failed
 * `unknown command: dte`, and started again three times, before a task
 * said why (2026-11-07).
 */
export async function untrackedWorkspace(root: string, tree: string): Promise<string | undefined> {
  for (const name of WORKSPACE_FILES) {
    if (!(await Bun.file(path.join(root, name)).exists())) continue
    return (await git(['cat-file', '-e', `${tree}:./${name}`], root)) === undefined
      ? name
      : undefined
  }
  return undefined
}

/** Core's names in its order: a project config's extensions. */
const WORKSPACE_FILES = PROJECT_CONFIG_FILENAMES.map((n) => `.vx/workspace${path.extname(n)}`)

/**
 * The copy's assume-unchanged and skip-worktree flags cleared, so `add -u`
 * takes those files from disk: it passed over them, and the tree kept
 * HEAD's blob of a file core's key hashed as edited, a stale hit
 * (2026-11-07). A skip-worktree file off disk (a sparse checkout's) stays
 * flagged: its bytes are the index's, not a deletion.
 */
async function unflag(top: string, env: Record<string, string>): Promise<void> {
  const listed = await git([...UNSPARSE, 'ls-files', '-v', '-z'], top, env)
  if (listed === undefined) return
  const assumed: string[] = []
  const skipped: string[] = []
  for (const entry of listed.split('\0')) {
    const tag = entry[0]
    if (tag === undefined) continue
    const file = entry.slice(2)
    // Lower case is assume-unchanged; S (s: both flags) skip-worktree.
    if (tag !== tag.toUpperCase()) assumed.push(file)
    if ((tag === 'S' || tag === 's') && existsSync(path.join(top, file))) skipped.push(file)
  }
  // One flag a call: given both, update-index clears the first and skips
  // the second.
  for (const [flag, files] of [
    ['--no-assume-unchanged', assumed],
    ['--no-skip-worktree', skipped],
  ] as const) {
    if (files.length === 0) continue
    const p = Bun.spawn(['git', ...UNSPARSE, 'update-index', flag, '-z', '--stdin'], {
      cwd: top,
      stdin: Buffer.from(files.join('\0') + '\0'),
      stdout: 'ignore',
      stderr: 'pipe',
      env: { ...process.env, ...env },
    })
    const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited])
    if (code !== 0)
      throw new UserError(
        `dte(): git could not take ${files[0]} (flagged assume-unchanged or skip-worktree) from disk, so workers would run its committed bytes: ${err.trim()}`,
      )
  }
}

// A sparse checkout's patterns kept `add` off a file outside them that is
// on disk all the same, and its index reads clear the flag of such a file
// in memory only, so `ls-files` named it unflagged.
const UNSPARSE = ['-c', 'core.sparseCheckout=false']

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
