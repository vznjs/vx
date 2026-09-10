// @vzn/vx-lockfile — one plugin per package manager, each keying every
// task on its project's own resolved dependency closure from the
// lockfile instead of the whole file.
//
// Core folds every lockfile at the root into the workspace fingerprint
// that every task key sees, so one install re-keys the workspace and
// `--affected` selects every project. Each plugin here CLAIMS its file
// (`VxPlugin.fingerprint`) through core's `lockfileClaim`: the file leaves
// the key digest, each task folds one digest per project — what that
// project can reach through its dependencies, by resolved identity — and
// `--affected` names the projects whose digest moved. This package is the
// parsers; the claim, the per-project key, the memo (one parse per file
// content), the per-run read and the diff are core's.
//
// Imports core only through the public `@vzn/vx` specifier.
import { definePlugin, lockfileClaim, type VxPlugin } from '@vzn/vx'
import * as pnpmLock from './pnpm.js'
import * as bunLock from './bun.js'
import * as npmLock from './npm.js'
import * as yarnLock from './yarn.js'

export interface LockfileOptions {
  /**
   * `'project'` (default): each task folds its own project's dependency
   * closure — a lockfile change re-keys only the projects it reaches.
   * `'workspace'`: the whole file, as core folds it — the coarse key,
   * through the plugin, for a workspace that wants the claim but not yet
   * the precision (`vx why` names it either way).
   */
  readonly scope?: 'project' | 'workspace'
}

/** Bumps when a digest folds differently (the memo's identity). */
const DIGEST_VERSION = 2

interface Manager {
  readonly name: string
  readonly file: string
  readonly digest: (text: string) => ReadonlyMap<string, string>
}

const MANAGERS = {
  pnpm: {
    name: 'pnpm',
    file: 'pnpm-lock.yaml',
    digest: (t) => pnpmLock.importerDigests(pnpmLock.parseLockfile(t)),
  },
  bun: {
    name: 'bun',
    file: 'bun.lock',
    digest: (t) => bunLock.importerDigests(bunLock.parseLockfile(t)),
  },
  npm: {
    name: 'npm',
    file: 'package-lock.json',
    digest: (t) => npmLock.importerDigests(npmLock.parseLockfile(t)),
  },
  yarn: {
    name: 'yarn',
    file: 'yarn.lock',
    digest: (t) => yarnLock.importerDigests(yarnLock.parseLockfile(t)),
  },
} satisfies Record<string, Manager>

function plugin(manager: Manager, options: LockfileOptions): VxPlugin {
  const scope = options.scope ?? 'project'
  if (scope !== 'project' && scope !== 'workspace') {
    throw new Error(
      `@vzn/vx-lockfile: ${manager.name}() scope must be 'project' or 'workspace', not ${JSON.stringify(scope)}`,
    )
  }
  return definePlugin(
    import.meta,
    lockfileClaim({
      file: manager.file,
      part: manager.name,
      version: DIGEST_VERSION,
      scope,
      digest: (text) => {
        try {
          return manager.digest(text)
        } catch (err) {
          throw new Error(`${manager.file}: ${err instanceof Error ? err.message : String(err)}`)
        }
      },
    }),
  )
}

/** `pnpm-lock.yaml` (lockfile v5, v6, v9): importers, snapshots, peers, patches, `link:`. */
export function pnpm(options: LockfileOptions = {}): VxPlugin {
  return plugin(MANAGERS.pnpm, options)
}

/** `bun.lock` (the text lockfile): Bun's hoisted layout, nested versions, `workspace:` links. */
export function bun(options: LockfileOptions = {}): VxPlugin {
  return plugin(MANAGERS.bun, options)
}

/** `package-lock.json` (lockfileVersion 2, 3): the `packages` map, nested `node_modules`, workspace links. */
export function npm(options: LockfileOptions = {}): VxPlugin {
  return plugin(MANAGERS.npm, options)
}

/** `yarn.lock`: berry (yarn 2+, per workspace) and classic (yarn 1, one digest for the root). */
export function yarn(options: LockfileOptions = {}): VxPlugin {
  return plugin(MANAGERS.yarn, options)
}

export { pnpmLock, bunLock, npmLock, yarnLock }
