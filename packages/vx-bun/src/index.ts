// @vzn/vx-bun — keys every task on its project's own resolved dependency
// closure from `bun.lock`, instead of the whole file.
//
// Core folds every lockfile at the root into the workspace fingerprint
// that every task key sees, so one `bun add` re-keys the workspace and
// `--affected` selects every project. This plugin CLAIMS the file
// (`VxPlugin.fingerprint`) through core's `lockfileClaim`: the file
// leaves the key digest, and each task folds one digest per workspace
// package — the packages it can reach through Bun's hoisted
// `node_modules` layout (name, version, integrity), workspace packages
// included. `bun add foo` in one package then re-keys that package's
// tasks and whatever depends on it, and `--affected` names the same
// projects from the same digests. This package is the parser and the
// digest; the memo and the diff are core's.
//
// Imports core only through the public `@vzn/vx` specifier.
import { definePlugin, lockfileClaim, type VxPlugin } from '@vzn/vx'
import { importerDigests, parseLockfile } from './lockfile.js'

export { importerDigests, parseLockfile, type Lockfile } from './lockfile.js'

export interface BunOptions {
  /**
   * `'project'` (default): each task folds its own project's dependency
   * closure. `'workspace'`: the whole file, as core folds it — the coarse
   * key through the plugin.
   */
  readonly scope?: 'project' | 'workspace'
}

export const LOCKFILE = 'bun.lock'
/** Bumps when the digest folds differently (the memo's identity). */
const DIGEST_VERSION = 1

export function bun(options: BunOptions = {}): VxPlugin {
  const scope = options.scope ?? 'project'
  if (scope !== 'project' && scope !== 'workspace') {
    throw new Error(
      `@vzn/vx-bun: scope must be 'project' or 'workspace', not ${JSON.stringify(scope)}`,
    )
  }
  return definePlugin(
    import.meta,
    lockfileClaim({
      file: LOCKFILE,
      version: DIGEST_VERSION,
      scope,
      digest: (text) => importerDigests(parseLockfile(text)),
    }),
  )
}
