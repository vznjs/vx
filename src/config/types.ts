// Public schema for vx project configuration. Deliberately minimal —
// only the fields the graph + runner pipeline cares about. Future
// modules (cache, sandbox, watch) extend the schema by reading their
// own fields off the underlying object; the loader's strict validation
// only covers the base surface defined here. Unknown fields are
// preserved unchanged so extension modules can inspect them.

import type { Project } from '../workspace/types.ts'

export interface ExecConfig {
  /** Shell command to run, from the project's directory. */
  command: string
}

export interface TaskConfig {
  /** Optional one-line description. Surfaced in `vx graph`. */
  description?: string
  /**
   * Shell command + env. Omit for a **group task** — a no-op node that
   * exists to chain `dependsOn`. Running a group is equivalent to
   * running its dependencies; nothing else happens.
   */
  exec?: ExecConfig
  /**
   * Upstream tasks. Turbo/Nx-style micro-syntax:
   *   - `'name'`     same-project task `name`
   *   - `'pkg#name'` specific package's `name` task
   *   - `'^name'`    `name` task in every workspace dep (deferred — not
   *                  resolved until the `package-graph` module ships)
   */
  dependsOn?: readonly string[]
}

export interface ProjectConfig {
  tasks?: Record<string, TaskConfig>
}

export interface LoadedConfig {
  readonly project: Project
  readonly config: ProjectConfig
}

export interface LoadOptions {
  workspace: { readonly projects: readonly Project[] }
}

export type LoadConfigs = (opts: LoadOptions) => Promise<readonly LoadedConfig[]>

/** Helper for users' vx.config.ts files. Identity at runtime; gives type inference. */
export function defineProject<T extends ProjectConfig>(config: T): T {
  return config
}
