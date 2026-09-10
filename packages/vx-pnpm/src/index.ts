// @vzn/vx-pnpm — keys every task on its project's own resolved dependency
// closure from `pnpm-lock.yaml`, instead of the whole file.
//
// Core folds every lockfile at the root into the workspace fingerprint that
// every task key sees, so one `pnpm update foo` re-keys the workspace and
// `--affected` selects every project. This plugin CLAIMS the file
// (`VxPlugin.fingerprint`): core leaves it out of the key digest, and the
// `key` hook folds one digest per project — the packages that project can
// reach through its dependencies (name, version, resolved peers, integrity,
// patch), following `link:` into the linked workspace package's closure.
// `pnpm update foo` then re-keys exactly the projects that reach `foo`, and
// `--affected` names the same projects from the same digests.
//
// The claim, the per-project key, the memo (one parse per lockfile
// content; a warm run reads a small JSON) and the `--affected` diff are
// core's `lockfileClaim`; this package is the parser and the digest.
//
// Imports core only through the public `@vzn/vx` specifier.
import { definePlugin, lockfileClaim, type VxPlugin } from '@vzn/vx'
import { importerDigests, parseLockfile } from './lockfile.js'

export { importerDigests, parseLockfile, type Lockfile } from './lockfile.js'

export interface PnpmOptions {
  /**
   * `'project'` (default): each task folds its own project's dependency
   * closure — a lockfile change re-keys only the projects it reaches.
   * `'workspace'`: the whole file, as core folds it — the coarse key,
   * through the plugin, for a workspace that wants the claim but not yet
   * the precision (`vx why` names it either way).
   */
  readonly scope?: 'project' | 'workspace'
}

export const LOCKFILE = 'pnpm-lock.yaml'
/** Bumps when the digest folds differently (the memo's identity). */
const DIGEST_VERSION = 1

export function pnpm(options: PnpmOptions = {}): VxPlugin {
  const scope = options.scope ?? 'project'
  if (scope !== 'project' && scope !== 'workspace') {
    throw new Error(
      `@vzn/vx-pnpm: scope must be 'project' or 'workspace', not ${JSON.stringify(scope)}`,
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
