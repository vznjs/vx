// Resolve declared cache inputs into the concrete pieces that go into the
// cache key:
//   - files: absolute paths whose contents are hashed
//   - envValues: [name, value] pairs (from parent process.env)
//   - externalDeps: [name, version] pairs (from project's package.json)
//
// MVP keeps this layer narrow: file-resolution uses `tinyglobby`, env reads
// from a supplied env source, external deps read from `package.json`.

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

export interface ResolvedInputs {
  /** Sorted absolute paths to all files whose contents go into the key. */
  files: string[]
  /** Sorted [name, value] pairs of declared env inputs. */
  envValues: Array<[name: string, value: string]>
  /** Sorted [name, version] pairs of declared external-dependency inputs. */
  externalDeps: Array<[name: string, version: string]>
}

export interface ResolveInputsArgs {
  projectDir: string
  workspaceRoot: string
  packageJson: PackageJson
  envSource: NodeJS.ProcessEnv
  inputs: Input[] | undefined
  /** Project-relative output globs to exclude from the implicit defaults. */
  ownOutputs: string[]
}

/** Resolve declared cache inputs. */
export async function resolveInputs(args: ResolveInputsArgs): Promise<ResolvedInputs> {
  // No declaration -> implicit default: all project files (gitignore-aware),
  // outputs excluded so a task does not invalidate itself.
  if (args.inputs === undefined) {
    return {
      files: await defaultProjectFiles(args.projectDir, args.workspaceRoot, args.ownOutputs),
      envValues: [],
      externalDeps: [],
    }
  }

  const projectGlobs: string[] = []
  const envNames = new Set<string>()
  const extDeps = new Set<string>()
  let includeDefaults = false

  for (const input of args.inputs) {
    if (typeof input === 'string') {
      projectGlobs.push(input)
    } else if ('default' in input) {
      includeDefaults = true
    } else if ('env' in input) {
      envNames.add(input.env)
    } else if ('externalDependencies' in input) {
      for (const name of input.externalDependencies) extDeps.add(name)
    }
  }

  const fileSet = new Set<string>()

  if (includeDefaults) {
    for (const f of await defaultProjectFiles(args.projectDir, args.workspaceRoot, args.ownOutputs)) {
      fileSet.add(f)
    }
  }

  if (projectGlobs.length > 0) {
    const matches = await glob(projectGlobs, {
      cwd: args.projectDir,
      absolute: true,
      dot: true,
      onlyFiles: true,
      ignore: ALWAYS_IGNORE,
    })
    for (const m of matches) fileSet.add(m)
  }

  const envValues: Array<[string, string]> = [...envNames]
    .sort()
    .map((name) => [name, args.envSource[name] ?? ''] as [string, string])

  const allDeps = readDeclaredVersions(args.packageJson)
  const externalDeps: Array<[string, string]> = [...extDeps]
    .sort()
    .map((name) => [name, allDeps[name] ?? ''] as [string, string])

  return {
    files: [...fileSet].sort(),
    envValues,
    externalDeps,
  }
}

/** Resolve declared output globs (project-relative) to actual produced files. */
export async function resolveOutputs(args: {
  projectDir: string
  outputs: string[]
}): Promise<string[]> {
  if (args.outputs.length === 0) return []
  const matches = await glob(args.outputs, {
    cwd: args.projectDir,
    absolute: true,
    dot: true,
    onlyFiles: true,
  })
  return matches.sort()
}

async function defaultProjectFiles(
  projectDir: string,
  workspaceRoot: string,
  ownOutputs: string[],
): Promise<string[]> {
  const ig = await loadGitignore(workspaceRoot, projectDir)
  const matches = await glob('**/*', {
    cwd: projectDir,
    absolute: true,
    dot: true,
    onlyFiles: true,
    ignore: [...ALWAYS_IGNORE, ...ownOutputs],
  })
  return matches.filter((p) => !ig.ignores(path.relative(workspaceRoot, p))).sort()
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
