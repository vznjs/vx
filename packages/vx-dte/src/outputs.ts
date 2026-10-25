// The files a task's declared outputs match in a checkout: what a worker
// clears before it runs the task, so an earlier task's files under them
// are not saved as this one's.

import { lstat, readdir } from 'node:fs/promises'
import path from 'node:path'
import { outputDirPrefixes, restorableOutput } from '@vzn/vx'

/**
 * The files declared outputs name, workspace-relative: `files` under the
 * project, `workspaceFiles` under the root. A `!` glob drops what it matches.
 */
export async function outputFiles(
  root: string,
  project: string,
  outputs: { readonly files: readonly string[]; readonly workspaceFiles: readonly string[] },
): Promise<string[]> {
  const found = new Set<string>()
  // Core's own matcher, so a glob means here what it means to a restore.
  const scan = async (base: string, globs: readonly string[], scope: 'project' | 'workspace') => {
    if (globs.length === 0) return
    const wanted = restorableOutput(globs, scope)
    const intoModules = globs.some((g) => g.includes('node_modules'))
    const add = (rel: string) => found.add(base === '' ? rel : `${base}/${rel}`)
    const walk = async (rel: string): Promise<void> => {
      const at = path.join(root, base, rel)
      const entries = await readdir(at, { withFileTypes: true }).catch(
        async (err: NodeJS.ErrnoException) => {
          // A literal output names a file: its prefix is that file. ENOTDIR
          // also means a FILE above it (`dist/x.js` with `dist` a file): no
          // path there, and clearing one threw (2026-10-25).
          if (err.code === 'ENOTDIR' && wanted(rel) && (await lstat(at).catch(() => null))) add(rel)
          return []
        },
      )
      for (const e of entries) {
        const child = rel === '' ? e.name : `${rel}/${e.name}`
        if (e.isDirectory()) {
          if (e.name === '.git' || (e.name === 'node_modules' && !intoModules)) continue
          await walk(child)
        } else if ((e.isFile() || e.isSymbolicLink()) && wanted(child)) {
          add(child)
        }
      }
    }
    // Only the trees the globs can reach: walking the whole project for
    // each task cost a worker 450 ms a task in a project of 9000 output
    // dirs (2026-10-25). Root-anchored or escaping globs keep the walk.
    const dirs = outputDirPrefixes(globs.filter((g) => !g.startsWith('!'))) ?? ['']
    await Promise.all(dirs.map(walk))
  }
  await scan(project, outputs.files, 'project')
  await scan('', outputs.workspaceFiles, 'workspace')
  return [...found].sort()
}

/** Whether declared outputs name `file` (workspace-relative), as `outputFiles` would find it. */
export function names(
  project: string,
  outputs: { readonly files: readonly string[]; readonly workspaceFiles: readonly string[] },
): (file: string) => boolean {
  const inProject =
    outputs.files.length === 0 ? () => false : restorableOutput(outputs.files, 'project')
  const inRoot =
    outputs.workspaceFiles.length === 0
      ? () => false
      : restorableOutput(outputs.workspaceFiles, 'workspace')
  const prefix = project === '' ? '' : `${project}/`
  return (file) => inRoot(file) || (file.startsWith(prefix) && inProject(file.slice(prefix.length)))
}
