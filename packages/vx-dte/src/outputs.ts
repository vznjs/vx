// The files a task's declared outputs match in a checkout: what a worker
// clears before it runs the task, so an earlier task's files under them
// are not saved as this one's.

import { lstat, readdir, realpath, stat } from 'node:fs/promises'
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
          // quiet: a path that is not there is no output
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
    /**
     * Whether the tree at `rel` is where it says, under `base`: the walk
     * follows a link only at its start (a nested one is an entry), and a
     * worker deletes what it names. `dist -> ../victim` for `dist/**`
     * deleted a file out of the project, and `dist -> .git` the repository,
     * as core measured (`containedIn`, `refuseDirLinkedOut`), which refuses
     * the task's save there too.
     */
    const lies = async (realBase: string | undefined, rel: string): Promise<boolean> => {
      const at = path.join(root, base, rel)
      // quiet: nothing there is nothing to walk
      const st = await stat(at).catch(() => undefined)
      if (st === undefined) return true
      const dir = st.isDirectory() ? rel : path.dirname(rel)
      // quiet: a tree that will not resolve is left alone
      const real = await realpath(path.join(root, base, dir)).catch(() => undefined)
      if (real === undefined || realBase === undefined) return false
      if (real === path.join(realBase, dir)) return true
      if (real !== realBase && !real.startsWith(realBase + path.sep)) return false
      const parts = real.slice(realBase.length + 1).split(path.sep)
      return !parts.some((p) => p.toLowerCase() === '.git') && parts[0]?.toLowerCase() !== '.vx'
    }
    // Only the trees the globs can reach: walking the whole project for
    // each task cost a worker 450 ms a task in a project of 9000 output
    // dirs (2026-10-25). Root-anchored or escaping globs keep the walk.
    const dirs = outputDirPrefixes(globs.filter((g) => !g.startsWith('!'))) ?? ['']
    // quiet: a base that will not resolve holds no outputs; `lies` refuses it
    const realBase = await realpath(path.join(root, base)).catch(() => undefined)
    await Promise.all(dirs.map(async (d) => (await lies(realBase, d)) && walk(d)))
  }
  await scan(project, outputs.files, 'project')
  await scan('', outputs.workspaceFiles, 'workspace')
  return [...found].sort()
}

/**
 * Of the files under a task's outputs, those an earlier task left
 * (`cleared`: neither tracked, a nested project's, nor an upstream's) and
 * those an upstream's outputs name (`held`). The held ones were read
 * against every cleared one: 20,000 stale files cost a worker a second a
 * task (2026-10-25).
 */
export function leftUnder(
  under: readonly string[],
  tracked: ReadonlySet<string>,
  nested: readonly string[],
  upstream: readonly ((file: string) => boolean)[],
): { cleared: string[]; held: string[] } {
  const cleared: string[] = []
  const held: string[] = []
  for (const f of under) {
    if (upstream.some((up) => up(f))) held.push(f)
    else if (!tracked.has(f) && !nested.some((n) => f.startsWith(`${n}/`))) cleared.push(f)
  }
  return { cleared, held }
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
