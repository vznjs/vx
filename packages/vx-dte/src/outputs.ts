// The files a task's declared outputs match in a checkout: what an agent
// clears before it runs the task, so an earlier task's files under them
// are not saved as this one's.

import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { restorableOutput } from '@vzn/vx'

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
    const walk = async (rel: string): Promise<void> => {
      const entries = await readdir(path.join(root, base, rel), { withFileTypes: true }).catch(
        () => [],
      )
      for (const e of entries) {
        const child = rel === '' ? e.name : `${rel}/${e.name}`
        if (e.isDirectory()) {
          if (e.name === '.git' || (e.name === 'node_modules' && !intoModules)) continue
          await walk(child)
        } else if ((e.isFile() || e.isSymbolicLink()) && wanted(child)) {
          found.add(base === '' ? child : `${base}/${child}`)
        }
      }
    }
    await walk('')
  }
  await scan(project, outputs.files, 'project')
  await scan('', outputs.workspaceFiles, 'workspace')
  return [...found].sort()
}
