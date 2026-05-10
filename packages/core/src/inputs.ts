// Discovery of files that participate in a task's cache key.
//
// MVP rule: every file in the project directory, with `.gitignore` applied,
// is an input. Declared outputs of the same task are excluded so a task does
// not invalidate itself on the next run.

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import ignore, { type Ignore } from 'ignore'
import { glob } from 'tinyglobby'

const ALWAYS_IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.nxt/**',
  '**/*.tsbuildinfo',
]

/** Files in the project directory that should participate in the cache key. */
export async function projectInputFiles(args: {
  projectDir: string
  workspaceRoot: string
  /** Outputs of this task; excluded from inputs to avoid self-invalidation. */
  ownOutputs: string[]
}): Promise<string[]> {
  const ig = await loadGitignore(args.workspaceRoot, args.projectDir)

  const matches = await glob('**/*', {
    cwd: args.projectDir,
    absolute: true,
    dot: true,
    onlyFiles: true,
    ignore: [...ALWAYS_IGNORE, ...args.ownOutputs],
  })

  return matches
    .filter((p) => !ig.ignores(path.relative(args.workspaceRoot, p)))
    .sort()
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
