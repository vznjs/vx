import { createJiti } from 'jiti'
import type { ProjectConfig } from './config.js'
import { UserError } from './errors.js'

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
