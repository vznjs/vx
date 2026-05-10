// Resolve declared cache inputs into the concrete pieces that go into the
// cache key:
//   - files: absolute paths whose contents are hashed
//   - envValues: [name, value] pairs (from parent process.env)
//
// Each input kind has its own resolver; the orchestrator calls them via
// `resolveInputs`. File globs are uniformly gitignore-aware and exclude
// nested-project subtrees + declared outputs + always-ignored paths.

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import ignore, { type Ignore } from 'ignore'
import { glob } from 'tinyglobby'
import type { CacheInputs } from '@nxt/config'

const ALWAYS_IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.nxt/**',
  '**/*.tsbuildinfo',
]

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
  /** Absolute dirs of nested nxt projects (cross-boundary isolation). */
  nestedProjectDirs: string[]
}

export async function resolveInputs(args: ResolveInputsArgs): Promise<ResolvedInputs> {
  const cfg = args.inputs ?? {}
  return {
    files: await resolveFiles({
      projectDir: args.projectDir,
      workspaceRoot: args.workspaceRoot,
      files: cfg.files,
      ownOutputs: args.ownOutputs,
      nestedProjectDirs: args.nestedProjectDirs,
    }),
    envValues: resolveEnvValues(cfg.env ?? [], args.envSource),
  }
}

/** Resolve declared output globs (project-relative) to actual produced files. */
export async function resolveOutputs(args: {
  projectDir: string
  outputs: string[]
  nestedProjectDirs: string[]
}): Promise<string[]> {
  if (args.outputs.length === 0) return []
  const matches = await glob(args.outputs, {
    cwd: args.projectDir,
    absolute: true,
    dot: true,
    onlyFiles: true,
    ignore: boundaryIgnorePatterns(args.projectDir, args.nestedProjectDirs),
  })
  return matches.sort()
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

  const matches = await glob(positive, {
    cwd: args.projectDir,
    absolute: true,
    dot: true,
    onlyFiles: true,
    ignore: [...ALWAYS_IGNORE, ...boundaryIgnores, ...args.ownOutputs, ...negative],
  })

  return matches.filter((p) => !ig.ignores(path.relative(args.workspaceRoot, p))).sort()
}

function resolveEnvValues(
  names: readonly string[],
  source: NodeJS.ProcessEnv,
): Array<[string, string]> {
  return [...names].sort().map((name) => [name, source[name] ?? ''] as [string, string])
}

function boundaryIgnorePatterns(projectDir: string, nestedDirs: string[]): string[] {
  return nestedDirs.map((d) => {
    const rel = path.relative(projectDir, d).split(path.sep).join('/')
    return `${rel}/**`
  })
}

async function loadGitignore(workspaceRoot: string, projectDir: string): Promise<Ignore> {
  const ig = ignore()
  for (const f of [
    path.join(workspaceRoot, '.gitignore'),
    path.join(projectDir, '.gitignore'),
  ]) {
    if (existsSync(f)) ig.add(await readFile(f, 'utf8'))
  }
  return ig
}
