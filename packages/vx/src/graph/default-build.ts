import type { TaskConfig } from '../config.js'

/**
 * The `build` a project gets when neither its config nor a plugin declared
 * one (owner, 2026-10-04): a group behind `^build`, keyed on every file of
 * the project. A package consumed as source then carries its files to every
 * dependent behind `^build`, in the key and in `--affected`, and the chain
 * through it to deeper builds holds. A keyed group, as a config may
 * declare one (config-schema.ts).
 */
export const DEFAULT_BUILD: TaskConfig = Object.freeze({
  dependsOn: Object.freeze(['^build']),
  inputs: Object.freeze({ files: Object.freeze(['**']) }),
})

/** The default `build`, which a menu of the tasks a user declared leaves out. */
export function isDefaultBuild(task: TaskConfig | undefined): boolean {
  return task === DEFAULT_BUILD
}
