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
import { LOCKFILE_NAME } from './lockfile.js'
import { WORKSPACE_FINGERPRINT_FILES } from './fingerprint.js'
import type { ProjectMeta } from './workspace.js'

export interface AffectedArgs {
  workspaceRoot: string
  /** Git ref / commit / branch to compare against. Required. */
  since: string
  projects: readonly ProjectMeta[]
  /**
   * Which projects declare a `cache.inputs.workspaceFiles` glob matching one of
   * these workspace-relative paths.
   *
   * A workspace-anchored glob is the documented escape hatch for shared files
   * that belong to NO project, so mapping changed paths to project directories
   * structurally cannot see it — the path resolves to no project and the run
   * selects nothing for a change that re-keyed the task.
   *
   * Answering needs the RESOLVED configs, which selection runs before loading;
   * that ordering is what left this open. It is resolved by asking only when
   * the question can matter: this is called ONLY with paths that belong to no
   * project, so a run whose every change is inside a project — the common case
   * — never invokes it and pays nothing.
   */
  workspaceGlobOwners?: (orphanPaths: readonly string[]) => Promise<Iterable<string>>
}

/**
 * Return the set of project names whose files changed between
 * `<since>` and the current working tree. Errors if `git` is missing
 * or `<since>` doesn't resolve to a commit.
 */
export async function affectedProjects(args: AffectedArgs): Promise<Set<string>> {
  await verifyRef(args.workspaceRoot, args.since)

  const [diffed, untracked] = await Promise.all([
    // `--no-renames` is crucial for project-affected detection: with
    // git's auto rename-detection on (the default in modern git), a
    // cross-project `git mv` collapses to a single rename entry that
    // surfaces only the destination path. We'd then miss flagging the
    // source project as affected. Treating renames as delete+add gives
    // us both halves so both projects get correctly marked.
    //
    // `--relative` prints paths relative to the cwd (the workspace root), NOT
    // the git repo root. Without it, when the workspace root is a SUBDIR of the
    // git repo, `git diff` emits repo-root-relative paths (`code/pkg/x`) that
    // `path.resolve(workspaceRoot, …)` mangles into `<root>/code/…`, matching no
    // project → the project is silently NOT flagged affected. `--relative` also
    // (correctly) drops changes ABOVE the workspace, which belong to no project.
    // No-op when the workspace root IS the git root.
    //
    // `-z` because git otherwise C-quotes and octal-escapes any path with a
    // non-ASCII / `"` / `\` character — the quoted string then resolves to no
    // project, while the cache-input enumeration (which uses `-z`) sees the
    // real name and re-keys the task. The two surfaces must agree.
    gitPaths(args.workspaceRoot, [
      'diff',
      '--no-renames',
      '--relative',
      '--name-only',
      '-z',
      args.since,
    ]),
    // `git diff` never reports untracked-but-not-ignored files, but input
    // enumeration does (`git ls-files --cached --others --exclude-standard`),
    // so a brand-new source file changes a task's cache key. Union it in or
    // `--affected` skips a package that genuinely has new work.
    gitPaths(args.workspaceRoot, ['ls-files', '--others', '--exclude-standard', '-z']),
  ])

  // vx-lock.json (workspace-root metadata) is excluded like a gitignored
  // file: re-running `vx lock` must not mark every project affected.
  const changed = [...diffed, ...untracked].filter((s) => s !== LOCKFILE_NAME)

  // A lockfile or workspace-definition change re-keys EVERY task, because the
  // workspace fingerprint folds those files into every cache key. Mapping
  // changed paths to project directories cannot see that — they sit at the
  // root and belong to no project — so `--affected` selected ZERO projects for
  // a change that invalidates the entire cache. `vx run test --affected` after
  // a `pnpm update` exited 0 having run nothing, which is precisely the
  // failure `docs/cli.md` warns against in the sentence it states as a
  // principle: "input hashing sees it, so `--affected` must too."
  //
  // Selection is not hashed, so widening it here changes no cache key.
  if (changed.some((p) => FINGERPRINT_SET.has(p))) {
    return new Set(args.projects.map((p) => p.name))
  }

  const { owned, orphans } = projectsContaining(args.workspaceRoot, changed, args.projects)
  if (orphans.length === 0 || args.workspaceGlobOwners === undefined) return owned
  for (const name of await args.workspaceGlobOwners(orphans)) owned.add(name)
  return owned
}

/**
 * Does any `cache.inputs.workspaceFiles` entry in `globs` match `rel`?
 *
 * Mirrors `resolveWorkspaceFiles`' partition: a leading `!` is an EXCLUDE, and
 * with no positive glob nothing matches. Paths are workspace-root-relative and
 * POSIX-separated, which is the form both git enumeration and the glob
 * resolver already speak.
 */
export function workspaceGlobsMatch(globs: readonly string[], rel: string): boolean {
  const positive: Bun.Glob[] = []
  const negative: Bun.Glob[] = []
  for (const entry of globs) {
    if (entry.startsWith('!')) negative.push(new Bun.Glob(entry.slice(1)))
    else positive.push(new Bun.Glob(entry))
  }
  if (positive.length === 0) return false
  if (!positive.some((g) => g.match(rel))) return false
  return !negative.some((g) => g.match(rel))
}

/**
 * The fingerprint files as workspace-root-relative paths. Read from the same
 * constant the fingerprint itself walks, so a new lockfile format cannot be
 * taught to one surface and not the other.
 */
const FINGERPRINT_SET: ReadonlySet<string> = new Set(WORKSPACE_FINGERPRINT_FILES)

/** Run a NUL-separated path-listing git command from the workspace root. */
async function gitPaths(workspaceRoot: string, cmd: string[]): Promise<string[]> {
  const proc = Bun.spawn({
    cmd: ['git', ...cmd],
    cwd: workspaceRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exit = await proc.exited
  if (exit !== 0) {
    throw new UserError(`git ${cmd[0]} failed (exit ${exit}): ${stderr.trim()}`)
  }
  return stdout.split('\0').filter((s) => s.length > 0)
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
  if (proc.exitCode === 0) return
  // `--verify --quiet` exits 1 for "that ref does not exist" and 128 for
  // "git could not run here at all" (not a repository, corrupt objects,
  // permissions). Reporting the second as a ref problem sends you hunting
  // for a branch name when the real fault is the repository — so only exit
  // 1 gets the ref message; anything else surfaces what git actually said.
  const stderr = new TextDecoder().decode(proc.stderr).trim()
  if (proc.exitCode !== 1) {
    throw new UserError(
      `git rev-parse failed (exit ${proc.exitCode}) in ${workspaceRoot}` +
        (stderr.length > 0 ? `: ${stderr}` : ''),
    )
  }
  throw new UserError(`git ref "${ref}" did not resolve. Pass a branch or commit you have locally.`)
}

function projectsContaining(
  workspaceRoot: string,
  changedRelPaths: readonly string[],
  projects: readonly ProjectMeta[],
): { owned: Set<string>; orphans: string[] } {
  // Index projects by their (canonical) dir, then for each changed path walk
  // its ancestor dirs bottom-up until one is a project dir. The FIRST hit is
  // the DEEPEST containing project — so a nested project still wins over its
  // parent, exactly as the prior longest-dir sort did — but this is
  // O(files · path-depth) instead of O(files · projects): independent of the
  // project count, which is what a big --affected diff on a 1000-project repo
  // pays for.
  const dirToName = new Map<string, string>()
  for (const p of projects) dirToName.set(p.dir, p.name)
  const owned = new Set<string>()
  // Paths that belong to no project. Only these can reach a task through a
  // workspace-anchored glob, so they are the exact set worth asking about.
  const orphans: string[] = []
  for (const rel of changedRelPaths) {
    let dir = path.resolve(workspaceRoot, rel)
    let hit = false
    for (;;) {
      const name = dirToName.get(dir)
      if (name !== undefined) {
        owned.add(name)
        hit = true
        break
      }
      const parent = path.dirname(dir)
      if (parent === dir) break // reached the filesystem root
      dir = parent
    }
    if (!hit) orphans.push(rel)
  }
  return { owned, orphans }
}
