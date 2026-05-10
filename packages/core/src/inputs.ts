import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import ignore from 'ignore'
import { glob } from 'tinyglobby'
import type { Input } from '@nxt/config'

const ALWAYS_IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.nxt/**',
  '**/*.tsbuildinfo',
]

/**
 * Resolve declared inputs to a flat, sorted list of absolute paths.
 *
 * Behaviour:
 * - `inputs === undefined`: implicit "all files in the project directory",
 *   filtered through any `.gitignore` files at workspace root and project dir.
 * - `inputs` array: each string is a project-relative glob (with optional `!`
 *   negation), each `{ workspace }` object is a workspace-relative glob.
 */
export async function resolveInputs(args: {
  projectDir: string
  workspaceRoot: string
  inputs: Input[] | undefined
}): Promise<string[]> {
  const { projectDir, workspaceRoot, inputs } = args

  if (inputs === undefined) {
    return resolveAllProjectFiles(projectDir, workspaceRoot)
  }

  const projectGlobs: string[] = []
  const workspaceGlobs: string[] = []
  for (const input of inputs) {
    if (typeof input === 'string') {
      projectGlobs.push(input)
    } else {
      workspaceGlobs.push(input.workspace)
    }
  }

  const out = new Set<string>()

  if (projectGlobs.length > 0) {
    const matches = await glob(projectGlobs, {
      cwd: projectDir,
      absolute: true,
      dot: true,
      onlyFiles: true,
      ignore: ALWAYS_IGNORE,
    })
    for (const m of matches) out.add(m)
  }

  if (workspaceGlobs.length > 0) {
    const matches = await glob(workspaceGlobs, {
      cwd: workspaceRoot,
      absolute: true,
      dot: true,
      onlyFiles: true,
      ignore: ALWAYS_IGNORE,
    })
    for (const m of matches) out.add(m)
  }

  return [...out].sort()
}

async function resolveAllProjectFiles(
  projectDir: string,
  workspaceRoot: string,
): Promise<string[]> {
  const ig = ignore()
  for (const f of [
    path.join(workspaceRoot, '.gitignore'),
    path.join(projectDir, '.gitignore'),
  ]) {
    if (existsSync(f)) ig.add(await readFile(f, 'utf8'))
  }

  const matches = await glob('**/*', {
    cwd: projectDir,
    absolute: true,
    dot: true,
    onlyFiles: true,
    ignore: ALWAYS_IGNORE,
  })

  return matches
    .filter((p) => !ig.ignores(path.relative(workspaceRoot, p)))
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
