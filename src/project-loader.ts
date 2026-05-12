import { existsSync } from 'node:fs'
import path from 'node:path'
import type { ProjectConfig, WorkspaceConfig } from './config.js'
import { UserError } from './errors.js'

const WORKSPACE_CONFIG_FILENAMES = [
  'vzn.workspace.ts',
  'vzn.workspace.mts',
  'vzn.workspace.js',
  'vzn.workspace.mjs',
]

// Bun has native TS / ESM execution — no transpiler dep needed. We fold
// a short content hash into the import URL as a cache-bust key so that:
//   same content   → same URL → Bun's module cache hits (fast)
//   changed content → new URL → fresh re-evaluation (correct)
// mtime would be cheaper but Bun's stat().mtimeNs is currently undefined
// on Linux/macOS, and ms-resolution mtime misses rapid edits in tests.
// Hashing a typical <10 KB config file is ~50µs — not measurable next
// to the import() evaluation itself.
async function loadDefaultExport(configPath: string, kind: string): Promise<unknown> {
  const bytes = await Bun.file(configPath).bytes()
  const bust = new Bun.CryptoHasher('sha256').update(bytes).digest('hex').slice(0, 16)
  const ns = (await import(`${configPath}?vzn-bust=${bust}`)) as { default?: unknown }
  const mod = ns?.default
  if (!mod || typeof mod !== 'object') {
    throw new UserError(`${kind} config at ${configPath} did not export a default object`)
  }
  return mod
}

export async function loadProjectConfig(configPath: string): Promise<ProjectConfig> {
  const mod = (await loadDefaultExport(configPath, 'Project')) as ProjectConfig
  validate(mod, configPath)
  return mod
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
  const mod = (await loadDefaultExport(configPath, 'Workspace')) as WorkspaceConfig
  validateWorkspace(mod, configPath)
  return mod
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
    const dependsOn = (task as { dependsOn?: unknown }).dependsOn
    const cache = (task as { cache?: unknown }).cache
    if (exec !== undefined) {
      if (typeof exec !== 'object' || exec === null) {
        throw new UserError(`${where}.exec must be an object with a \`command\` string`)
      }
      const command = (exec as { command?: unknown }).command
      if (typeof command !== 'string' || command.length === 0) {
        throw new UserError(`${where}.exec.command must be a non-empty string`)
      }
    } else {
      // Group task: no exec, just dependencies. Must declare something to
      // depend on, otherwise the task is a literal no-op with nothing to
      // chain (almost certainly a config mistake).
      if (dependsOn === undefined) {
        throw new UserError(
          `${where}: a task with no \`exec\` must declare \`dependsOn\` ` +
            `(group tasks exist to chain dependencies)`,
        )
      }
      if (cache !== undefined) {
        throw new UserError(
          `${where}: \`cache\` requires \`exec\` — a group task has nothing to cache`,
        )
      }
    }
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
