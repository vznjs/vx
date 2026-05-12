// Resolve declared cache inputs into the concrete pieces that go into the
// cache key:
//   - files: absolute paths whose contents are hashed
//   - envValues: [name, value] pairs from parent process.env
//
// `cache.inputs.env` is the cache-tracking axis for env vars; it's
// independent of `exec.env`, which controls what reaches the child.

import path from 'node:path'
import { rm } from 'node:fs/promises'
import ignore, { type Ignore } from 'ignore'
import type { CacheInputs } from '../config.js'

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
}

export async function resolveInputs(args: ResolveInputsArgs): Promise<ResolvedInputs> {
  return {
    files: await resolveFiles({
      projectDir: args.projectDir,
      workspaceRoot: args.workspaceRoot,
      files: args.inputs?.files,
      ownOutputs: args.ownOutputs,
      nestedProjectDirs: args.nestedProjectDirs,
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
  const ig = await loadGitignore(args.workspaceRoot, args.projectDir)
  const excludeGlobs = [...ALWAYS_IGNORE, ...boundaryIgnores, ...args.ownOutputs, ...negative].map(
    (p) => new Bun.Glob(p),
  )

  const matches = await scanUnion(positive, excludeGlobs, args.projectDir)
  return [...matches].filter((p) => !ig.ignores(path.relative(args.workspaceRoot, p))).sort()
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

async function loadGitignore(workspaceRoot: string, projectDir: string): Promise<Ignore> {
  const ig = ignore()
  for (const f of [path.join(workspaceRoot, '.gitignore'), path.join(projectDir, '.gitignore')]) {
    const file = Bun.file(f)
    if (await file.exists()) ig.add(await file.text())
  }
  return ig
}
