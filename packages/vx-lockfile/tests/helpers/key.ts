// A task's key as a run folds it after `vx lock`: the lock records each
// claimed file's digests (`fingerprint.digests`), and the run's key reads
// them back (`KeyHookContext.locked`), never parsing. A test keying one
// task asks the plugin for both, so it checks the digest a run folds.
import type { KeyHookContext, TaskNode, VxPlugin } from '@vzn/vx'

/** A run's key context over what `vx lock` would record of `plugin`'s files now, for `projectDir`. */
export function lockedContext(
  plugin: VxPlugin,
  workspaceRoot: string,
  cacheDir: string,
  projectDir: string,
): KeyHookContext {
  const base = { workspaceRoot, cacheDir, warn() {} }
  return {
    ...base,
    async locked(file) {
      const projects = [{ name: 'p', dir: projectDir }]
      const d = await plugin.fingerprint!.digests!(file, { ...base, projects })
      // The extra files as recorded now: the record is fresh.
      return d === undefined ? undefined : { extras: {}, digest: () => d.projects['p'] }
    },
  }
}

/** `plugin`'s key for a task in `projectDir`, as a run after `vx lock` folds it. */
export function lockedKey(
  plugin: VxPlugin,
  workspaceRoot: string,
  cacheDir: string,
  projectDir = workspaceRoot,
): Promise<Readonly<Record<string, string>> | undefined> {
  const task = { projectDir } as TaskNode
  const ctx = lockedContext(plugin, workspaceRoot, cacheDir, projectDir)
  return Promise.resolve(plugin.key!(task, ctx))
}
