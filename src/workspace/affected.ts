// `--affected` — git-relative project selection.
//
// Resolves the set of project names whose files have changed since a
// given git ref. The diff is `<since>...HEAD` plus working-tree
// changes (uncommitted edits), so it captures everything you've
// touched on the current branch.
//
// We use `git diff --name-only <since>` which by default compares the
// `<since>` commit to the working tree — i.e. commits-from-`<since>`
// + index + unstaged. Matches Turbo's `[<since>]` filter semantics.

import path from 'node:path'
import { UserError } from '../util/index.js'
import type { ProjectMeta } from './workspace.js'

export interface AffectedArgs {
  workspaceRoot: string
  /** Git ref / commit / branch to compare against. Required. */
  since: string
  projects: readonly ProjectMeta[]
}

/**
 * Return the set of project names whose files changed between
 * `<since>` and the current working tree. Errors if `git` is missing
 * or `<since>` doesn't resolve to a commit.
 */
export async function affectedProjects(args: AffectedArgs): Promise<Set<string>> {
  await verifyRef(args.workspaceRoot, args.since)

  const proc = Bun.spawn({
    // `--no-renames` is crucial for project-affected detection: with
    // git's auto rename-detection on (the default in modern git), a
    // cross-project `git mv` collapses to a single rename entry that
    // surfaces only the destination path. We'd then miss flagging the
    // source project as affected. Treating renames as delete+add gives
    // us both halves so both projects get correctly marked.
    cmd: ['git', 'diff', '--no-renames', '--name-only', args.since],
    cwd: args.workspaceRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exit = await proc.exited
  if (exit !== 0) {
    throw new UserError(`git diff failed (exit ${exit}): ${stderr.trim()}`)
  }

  const changed = stdout.split('\n').filter((s) => s.length > 0)
  return projectsContaining(args.workspaceRoot, changed, args.projects)
}

/**
 * Resolve the default base for `--affected` with no explicit value.
 * Tries the remote's HEAD branch first (`origin/main`, `origin/master`,
 * etc.), then falls back to `HEAD~1` which always exists once there
 * are at least two commits.
 */
export async function defaultAffectedBase(workspaceRoot: string): Promise<string> {
  const probe = Bun.spawnSync({
    cmd: ['git', 'symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'],
    cwd: workspaceRoot,
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const out = new TextDecoder().decode(probe.stdout).trim()
  if (probe.exitCode === 0 && out.length > 0) return out
  return 'HEAD~1'
}

async function verifyRef(workspaceRoot: string, ref: string): Promise<void> {
  const proc = Bun.spawnSync({
    cmd: ['git', 'rev-parse', '--verify', '--quiet', ref],
    cwd: workspaceRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (proc.exitCode !== 0) {
    throw new UserError(
      `git ref "${ref}" did not resolve. Pass a branch or commit you have locally.`,
    )
  }
}

function projectsContaining(
  workspaceRoot: string,
  changedRelPaths: readonly string[],
  projects: readonly ProjectMeta[],
): Set<string> {
  // Sort by dir length descending so a nested project wins over its
  // parent when a single file falls inside both (a parent project's
  // glob can't reach into a nested one, but the file's path is still
  // a descendant of both dirs).
  const sortedProjects = [...projects].sort((a, b) => b.dir.length - a.dir.length)
  const out = new Set<string>()
  for (const rel of changedRelPaths) {
    const abs = path.resolve(workspaceRoot, rel)
    for (const proj of sortedProjects) {
      if (abs === proj.dir || abs.startsWith(proj.dir + path.sep)) {
        out.add(proj.name)
        break
      }
    }
  }
  return out
}
