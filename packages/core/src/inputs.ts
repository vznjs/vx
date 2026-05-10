// Resolve declared cache inputs into the concrete pieces that go into the
// cache key:
//   - files: absolute paths whose contents are hashed
//   - envValues: [name, value] pairs (from parent process.env)
//   - externalDeps: [name, version] pairs (from project's package.json)
//
// File globs are uniformly gitignore-aware. Every glob pass also excludes:
//   - ALWAYS_IGNORE (node_modules, .git, .nxt, *.tsbuildinfo)
//   - the project's declared outputs (no self-invalidation)
//   - the dirs of any nested nxt projects (no cross-boundary leakage)
//   - any negation patterns (`!...`) the user wrote in the inputs list

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import ignore, { type Ignore } from 'ignore'
import { glob } from 'tinyglobby'
import type { Input } from '@nxt/config'
import type { PackageJson } from './workspace.js'

const ALWAYS_IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.nxt/**',
  '**/*.tsbuildinfo',
]

const DEFAULT_INPUT_GLOBS: readonly string[] = ['**/*']

export interface ResolvedInputs {
  files: string[]
  envValues: Array<[name: string, value: string]>
  externalDeps: Array<[name: string, version: string]>
}

export interface ResolveInputsArgs {
  projectDir: string
  workspaceRoot: string
  packageJson: PackageJson
  envSource: NodeJS.ProcessEnv
  inputs: Input[] | undefined
  /** Project-relative output globs to exclude from inputs. */
  ownOutputs: string[]
  /** Absolute dirs of nested nxt projects (cross-boundary isolation). */
  nestedProjectDirs: string[]
}

export async function resolveInputs(args: ResolveInputsArgs): Promise<ResolvedInputs> {
  const boundaryIgnores = boundaryIgnorePatterns(args.projectDir, args.nestedProjectDirs)

  // No declaration -> implicit defaults: all project files.
  if (args.inputs === undefined) {
    return {
      files: await resolveFiles({
        projectDir: args.projectDir,
        workspaceRoot: args.workspaceRoot,
        positiveGlobs: [...DEFAULT_INPUT_GLOBS],
        ignorePatterns: [...boundaryIgnores, ...args.ownOutputs],
      }),
      envValues: [],
      externalDeps: [],
    }
  }

  const positiveGlobs: string[] = []
  const negativeGlobs: string[] = []
  const envNames = new Set<string>()
  const extDeps = new Set<string>()

  for (const input of args.inputs) {
    if (typeof input === 'string') {
      if (input.startsWith('!')) negativeGlobs.push(input.slice(1))
      else positiveGlobs.push(input)
    } else if ('env' in input) {
      envNames.add(input.env)
    } else if ('externalDependencies' in input) {
      for (const name of input.externalDependencies) extDeps.add(name)
    }
  }

  const files =
    positiveGlobs.length > 0
      ? await resolveFiles({
          projectDir: args.projectDir,
          workspaceRoot: args.workspaceRoot,
          positiveGlobs,
          ignorePatterns: [...boundaryIgnores, ...args.ownOutputs, ...negativeGlobs],
        })
      : []

  const envValues: Array<[string, string]> = [...envNames]
    .sort()
    .map((name) => [name, args.envSource[name] ?? ''] as [string, string])

  const allDeps = readDeclaredVersions(args.packageJson)
  const externalDeps: Array<[string, string]> = [...extDeps]
    .sort()
    .map((name) => [name, allDeps[name] ?? ''] as [string, string])

  return { files, envValues, externalDeps }
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
  positiveGlobs: string[]
  ignorePatterns: string[]
}

async function resolveFiles(args: ResolveFilesArgs): Promise<string[]> {
  const ig = await loadGitignore(args.workspaceRoot, args.projectDir)
  const matches = await glob(args.positiveGlobs, {
    cwd: args.projectDir,
    absolute: true,
    dot: true,
    onlyFiles: true,
    ignore: [...ALWAYS_IGNORE, ...args.ignorePatterns],
  })
  return matches.filter((p) => !ig.ignores(path.relative(args.workspaceRoot, p))).sort()
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

function readDeclaredVersions(pkg: PackageJson): Record<string, string> {
  const out: Record<string, string> = {}
  for (const field of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ] as const) {
    const obj = pkg[field]
    if (!obj) continue
    for (const [name, version] of Object.entries(obj)) {
      out[name] = version
    }
  }
  return out
}
