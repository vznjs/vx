// Resolve declared cache inputs into the concrete pieces that go into the
// cache key:
//   - files: absolute paths whose contents are hashed
//   - envValues: [name, value] pairs from parent process.env
//
// `cache.inputs.env` is the cache-tracking axis for env vars; it's
// independent of `exec.env`, which controls what reaches the child.
//
// File enumeration defers to git — same as Turbo and Nx. We ask git for
// the file set via `git ls-files --cached --others --exclude-standard`,
// which gives us:
//   - all tracked files,
//   - plus untracked-but-not-ignored files,
//   - with nested .gitignore + .git/info/exclude + global excludes
//     correctly applied (because git already does the cascade).
// The user's `inputs.files` globs are then matched as a *filter* on
// top of that file set. vx requires git to be installed and the
// workspace to be a git work tree; non-git environments are not
// supported.

import path from 'node:path'
import { rm } from 'node:fs/promises'
import type { CacheInputs } from '../config.js'
import { UserError } from '../util/index.js'

const ALWAYS_IGNORE = ['**/node_modules/**', '**/.git/**', '**/.vx/**', '**/*.tsbuildinfo']

const DEFAULT_FILE_GLOBS: readonly string[] = ['**/*']

export interface ResolvedInputs {
  files: string[]
  envValues: Array<[name: string, value: string]>
}

export interface ResolveInputsArgs {
  projectDir: string
  workspaceRoot: string
  envSource: NodeJS.ProcessEnv
  inputs: CacheInputs | undefined
  /** Project-relative output globs to exclude from inputs. */
  ownOutputs: string[]
  /** Absolute dirs of nested projects (cross-boundary isolation). */
  nestedProjectDirs: string[]
  /**
   * Per-run memo for `git ls-files` output. The same project's file
   * list is asked for once per task (build + test + …) — without
   * memoization we spawn git 3× per project per run. The orchestrator
   * passes a fresh Map at the top of every `vx run`.
   */
  gitFilesCache?: Map<string, readonly string[]>
}

export async function resolveInputs(args: ResolveInputsArgs): Promise<ResolvedInputs> {
  return {
    files: await resolveFiles({
      projectDir: args.projectDir,
      workspaceRoot: args.workspaceRoot,
      files: args.inputs?.files,
      ownOutputs: args.ownOutputs,
      nestedProjectDirs: args.nestedProjectDirs,
      ...(args.gitFilesCache !== undefined ? { gitFilesCache: args.gitFilesCache } : {}),
    }),
    envValues: resolveEnvValues(args.inputs?.env ?? [], args.envSource),
  }
}

function resolveEnvValues(
  names: readonly string[],
  source: NodeJS.ProcessEnv,
): Array<[string, string]> {
  return [...names].sort().map((name) => [name, source[name] ?? ''] as [string, string])
}

/** Resolve declared output globs (project-relative) to actual produced files. */
export async function resolveOutputs(args: {
  projectDir: string
  outputs: string[]
  nestedProjectDirs: string[]
}): Promise<string[]> {
  if (args.outputs.length === 0) return []
  const excludeGlobs = boundaryIgnorePatterns(args.projectDir, args.nestedProjectDirs).map(
    (p) => new Bun.Glob(p),
  )
  return [...(await scanUnion(args.outputs, excludeGlobs, args.projectDir))].sort()
}

/**
 * Remove every file currently matching the declared output globs in
 * the project dir. Called both before a cache-hit restore (so the
 * restore lands on a clean slate, matching the cached snapshot bit-
 * for-bit) and before a cache-miss exec (so the task's output dir
 * doesn't carry stale stragglers from a prior run).
 *
 * Globs are evaluated against the *current* tree. Files in declared
 * output paths that the user dropped by hand will be removed — that's
 * the contract of declaring something as an output. Nested-project
 * dirs are excluded the same way `resolveOutputs` does, so we never
 * cross a project boundary.
 */
export async function cleanOutputs(args: {
  projectDir: string
  outputs: string[]
  nestedProjectDirs: string[]
}): Promise<void> {
  const files = await resolveOutputs(args)
  // `force: true` makes rm tolerate ENOENT (e.g. when two output
  // globs overlap and a sibling already deleted a path mid-iteration).
  await Promise.all(files.map((f) => rm(f, { force: true })))
}

interface ResolveFilesArgs {
  projectDir: string
  workspaceRoot: string
  files: string[] | undefined
  ownOutputs: string[]
  nestedProjectDirs: string[]
  gitFilesCache?: Map<string, readonly string[]>
}

async function resolveFiles(args: ResolveFilesArgs): Promise<string[]> {
  const positive: string[] = []
  const negative: string[] = []

  if (args.files === undefined) {
    positive.push(...DEFAULT_FILE_GLOBS)
  } else {
    for (const entry of args.files) {
      if (entry.startsWith('!')) negative.push(entry.slice(1))
      else positive.push(entry)
    }
  }

  if (positive.length === 0) return []

  const boundaryIgnores = boundaryIgnorePatterns(args.projectDir, args.nestedProjectDirs)
  const excludeGlobs = [...ALWAYS_IGNORE, ...boundaryIgnores, ...args.ownOutputs, ...negative].map(
    (p) => new Bun.Glob(p),
  )

  // Defer to git for the file set (Turbo / Nx parity). Nested .gitignore
  // files, .git/info/exclude, and global excludes all participate
  // correctly because git applies the cascade for us.
  //
  // Per-run memo: each project's git ls-files output is asked for once
  // per task (build + test + lint + …). Spawning git N times for the
  // same project per run is wasteful; we cache the result for the
  // duration of one orchestrator run.
  let gitFiles: readonly string[]
  if (args.gitFilesCache !== undefined && args.gitFilesCache.has(args.projectDir)) {
    gitFiles = args.gitFilesCache.get(args.projectDir) as readonly string[]
  } else {
    gitFiles = runGitLsFiles(args.projectDir)
    args.gitFilesCache?.set(args.projectDir, gitFiles)
  }
  const positiveGlobs = positive.map((p) => new Bun.Glob(p))
  // First pass: glob-filter to candidate absolute paths (no I/O).
  const candidates: string[] = []
  for (const rel of gitFiles) {
    let matched = false
    for (const g of positiveGlobs) {
      if (g.match(rel)) {
        matched = true
        break
      }
    }
    if (!matched) continue
    if (excludeGlobs.some((g) => g.match(rel))) continue
    candidates.push(path.resolve(args.projectDir, rel))
  }
  // Second pass: parallel existence check. `git ls-files --cached`
  // can surface stale entries when the working tree has the file
  // gone; the hasher would otherwise throw ENOENT. Parallelizing
  // turns N serial syscalls into one round-trip's worth of latency.
  const exists = await Promise.all(candidates.map((abs) => Bun.file(abs).exists()))
  const matches: string[] = []
  for (let i = 0; i < candidates.length; i++) {
    if (exists[i]) matches.push(candidates[i]!)
  }
  return matches.sort()
}

/**
 * Run `git ls-files --cached --others --exclude-standard -z .` in
 * `cwd` and return the NUL-split, non-empty entries. Throws a
 * `UserError` when git is unavailable or `cwd` isn't a git work tree;
 * vx requires git. `-z` survives filenames with newlines / spaces.
 */
function runGitLsFiles(cwd: string): readonly string[] {
  let proc
  try {
    proc = Bun.spawnSync({
      cmd: ['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '.'],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch {
    throw new UserError(
      `vx requires git: failed to spawn 'git' (working dir: ${cwd}). Install git and re-run.`,
    )
  }
  if (proc.exitCode !== 0) {
    // Exit 128 = not a git work tree; other non-zero = git failure.
    // Either way we can't enumerate inputs reliably.
    const stderr = new TextDecoder().decode(proc.stderr).trim()
    throw new UserError(
      `vx requires git: ${cwd} is not inside a git work tree. ` +
        `Run 'git init' in your workspace root.${stderr ? ` (git: ${stderr})` : ''}`,
    )
  }
  const out = new TextDecoder().decode(proc.stdout)
  if (out.length === 0) return []
  // ls-files emits NUL-separated; trailing NUL produces an empty
  // segment we filter out.
  return out.split('\0').filter((s) => s.length > 0)
}

/**
 * Run `git ls-files` ONCE at the workspace root, then partition the
 * result by project. Populates `cache` for every project in
 * `projectDirs` with project-relative path lists matching what a
 * per-project spawn would have produced. Throws `UserError` if the
 * workspace isn't a git work tree (vx requires git).
 *
 * Why bulk: each spawn costs ~5-10ms (fork+exec). On a 200-project
 * workspace that's 1-2s of pure overhead reclaimed.
 *
 * Files in nested-project subtrees stay in their parent's list — the
 * boundary-ignore globs in `resolveFiles` filter them out the same way
 * they did before. Cheaper to filter once-per-task than to subtract
 * here.
 */
export function populateGitFilesCache(
  workspaceRoot: string,
  projectDirs: readonly string[],
  cache: Map<string, readonly string[]>,
): void {
  const all = runGitLsFiles(workspaceRoot)
  for (const projectDir of projectDirs) {
    const relPrefix = path.relative(workspaceRoot, projectDir).split(path.sep).join('/')
    if (relPrefix === '' || relPrefix === '.') {
      cache.set(projectDir, all)
      continue
    }
    const prefix = `${relPrefix}/`
    const matches: string[] = []
    for (const p of all) {
      if (p.startsWith(prefix)) matches.push(p.slice(prefix.length))
    }
    cache.set(projectDir, matches)
  }
}

/**
 * Union of files matching any positive pattern in `cwd`, minus files
 * matching any exclude glob (tested by Bun.Glob.match on the relative
 * path). Bun.Glob takes a single pattern per instance, so we iterate.
 */
async function scanUnion(
  positive: readonly string[],
  excludeGlobs: readonly Bun.Glob[],
  cwd: string,
): Promise<Set<string>> {
  const matches = new Set<string>()
  for (const pattern of positive) {
    const glob = new Bun.Glob(pattern)
    for await (const rel of glob.scan({ cwd, onlyFiles: true, dot: true })) {
      if (excludeGlobs.some((g) => g.match(rel))) continue
      matches.add(path.resolve(cwd, rel))
    }
  }
  return matches
}

function boundaryIgnorePatterns(projectDir: string, nestedDirs: string[]): string[] {
  return nestedDirs.map((d) => {
    const rel = path.relative(projectDir, d).split(path.sep).join('/')
    return `${rel}/**`
  })
}
