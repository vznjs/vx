import { existsSync } from 'node:fs'
import path from 'node:path'
import { createJiti } from 'jiti'
import type { ProjectConfig, WorkspaceConfig } from './config.js'
import { UserError } from './errors.js'

const WORKSPACE_CONFIG_FILENAMES = [
  'vzn.workspace.ts',
  'vzn.workspace.mts',
  'vzn.workspace.js',
  'vzn.workspace.mjs',
]

// jiti handles every supported extension (.ts/.mts/.cts/.js/.mjs/.cjs) with
// `moduleCache: false`, so edits show up across repeated calls within a
// single process. We previously used native `import()` with an `?mtime=…`
// query for plain JS, but Bun ignores query strings on file: URLs and
// returns the cached module — so jiti is the portable choice.
// `interopDefault: false` matters: with it on, jiti synthesizes a fake
// `.default` (the namespace itself) for sources that have no real default
// export. We need to distinguish "user exported a default" from "no default
// was exported" to give a clear error.
const jiti = createJiti(import.meta.url, {
  interopDefault: false,
  moduleCache: false,
})

export async function loadProjectConfig(configPath: string): Promise<ProjectConfig> {
  const ns = (await jiti.import(configPath)) as { default?: unknown }
  const mod = ns?.default
  if (!mod || typeof mod !== 'object') {
    throw new UserError(`Project config at ${configPath} did not export a default object`)
  }
  validate(mod as ProjectConfig, configPath)
  return mod as ProjectConfig
}

/**
 * Find and load `vzn.workspace.{ts,mts,js,mjs}` from the workspace
 * root. Returns `null` if no such file exists (the common case;
 * the schema is fully optional). Validates the shape and throws
 * a `UserError` on malformed input.
 */
export async function loadWorkspaceConfig(root: string): Promise<WorkspaceConfig | null> {
  const configPath =
    WORKSPACE_CONFIG_FILENAMES.map((f) => path.join(root, f)).find((f) => existsSync(f)) ?? null
  if (!configPath) return null
  const ns = (await jiti.import(configPath)) as { default?: unknown }
  const mod = ns?.default
  if (!mod || typeof mod !== 'object') {
    throw new UserError(`Workspace config at ${configPath} did not export a default object`)
  }
  validateWorkspace(mod as WorkspaceConfig, configPath)
  return mod as WorkspaceConfig
}

function validateWorkspace(config: WorkspaceConfig, configPath: string): void {
  if (config.concurrency !== undefined) {
    if (
      typeof config.concurrency !== 'number' ||
      !Number.isFinite(config.concurrency) ||
      config.concurrency < 1 ||
      !Number.isInteger(config.concurrency)
    ) {
      throw new UserError(`${configPath}: \`concurrency\` must be a positive integer`)
    }
  }
  if (config.cacheDir !== undefined && typeof config.cacheDir !== 'string') {
    throw new UserError(`${configPath}: \`cacheDir\` must be a string`)
  }
}

/**
 * Runtime validation for the user-authored config. TypeScript checks
 * shape at edit-time, but `vzn run` may load configs that were never
 * typechecked (plain .js, or TS with errors ignored). Catch the worst
 * shape problems early with a clear message rather than letting them
 * crash deeper in the orchestrator.
 */
function validate(config: ProjectConfig, configPath: string): void {
  const tasks = config.run?.tasks
  if (tasks === undefined) return
  if (typeof tasks !== 'object' || tasks === null) {
    throw new UserError(`${configPath}: \`run.tasks\` must be an object`)
  }
  for (const [name, task] of Object.entries(tasks)) {
    const where = `${configPath}: run.tasks.${name}`
    if (!task || typeof task !== 'object') {
      throw new UserError(`${where} must be an object`)
    }
    const exec = (task as { exec?: unknown }).exec
    if (!exec || typeof exec !== 'object') {
      throw new UserError(`${where}.exec must be an object with a \`command\` string`)
    }
    const command = (exec as { command?: unknown }).command
    if (typeof command !== 'string' || command.length === 0) {
      throw new UserError(`${where}.exec.command must be a non-empty string`)
    }
    const cache = (task as { cache?: unknown }).cache
    if (cache !== undefined) {
      if (typeof cache !== 'object' || cache === null) {
        throw new UserError(`${where}.cache must be an object when present`)
      }
      const inputs = (cache as { inputs?: unknown }).inputs
      const outputs = (cache as { outputs?: unknown }).outputs
      if (!inputs || typeof inputs !== 'object') {
        throw new UserError(`${where}.cache.inputs is required when \`cache\` is set`)
      }
      if (!Array.isArray((inputs as { files?: unknown }).files)) {
        throw new UserError(`${where}.cache.inputs.files must be an array of glob strings`)
      }
      if (!outputs || typeof outputs !== 'object') {
        throw new UserError(`${where}.cache.outputs is required when \`cache\` is set`)
      }
      if (!Array.isArray((outputs as { files?: unknown }).files)) {
        throw new UserError(`${where}.cache.outputs.files must be an array of glob strings`)
      }
    }
  }
}
