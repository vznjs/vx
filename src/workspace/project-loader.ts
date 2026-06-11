import path from 'node:path'
import type { ProjectConfig, WorkspaceConfig } from '../config.js'
import { UserError, xxh3hex } from '../util/index.js'

const WORKSPACE_CONFIG_FILENAMES = [
  'vx.workspace.ts',
  'vx.workspace.mts',
  'vx.workspace.js',
  'vx.workspace.mjs',
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
  const bust = xxh3hex(bytes)
  const ns = (await import(`${configPath}?vx-bust=${bust}`)) as { default?: unknown }
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
 * Find and load `vx.workspace.{ts,mts,js,mjs}` from the workspace
 * root. Returns `null` if no such file exists (the common case;
 * the schema is fully optional). Validates the shape and throws
 * a `UserError` on malformed input.
 */
export async function loadWorkspaceConfig(root: string): Promise<WorkspaceConfig | null> {
  let configPath: string | null = null
  for (const candidate of WORKSPACE_CONFIG_FILENAMES.map((f) => path.join(root, f))) {
    if (await Bun.file(candidate).exists()) {
      configPath = candidate
      break
    }
  }
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
 * shape at edit-time, but `vx run` may load configs that were never
 * typechecked (plain .js, or TS with errors ignored). Catch the worst
 * shape problems early with a clear message rather than letting them
 * crash deeper in the orchestrator.
 */
function validate(config: ProjectConfig, configPath: string): void {
  const tasks = config.tasks
  if (tasks === undefined) return
  if (typeof tasks !== 'object' || tasks === null) {
    throw new UserError(`${configPath}: \`tasks\` must be an object`)
  }
  for (const [name, task] of Object.entries(tasks)) {
    const where = `${configPath}: tasks.${name}`
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
      const persistent = (exec as { persistent?: unknown }).persistent
      if (persistent !== undefined) {
        if (typeof persistent !== 'object' || persistent === null) {
          throw new UserError(`${where}.exec.persistent must be an object (or omitted)`)
        }
        const readyWhen = (persistent as { readyWhen?: unknown }).readyWhen
        if (readyWhen !== undefined && typeof readyWhen !== 'string') {
          throw new UserError(`${where}.exec.persistent.readyWhen must be a string regex`)
        }
        const readyTimeoutMs = (persistent as { readyTimeoutMs?: unknown }).readyTimeoutMs
        if (readyTimeoutMs !== undefined) {
          if (readyWhen === undefined) {
            throw new UserError(
              `${where}.exec.persistent.readyTimeoutMs requires \`readyWhen\` — ` +
                `a task that is ready on spawn has nothing to time out`,
            )
          }
          if (
            typeof readyTimeoutMs !== 'number' ||
            !Number.isInteger(readyTimeoutMs) ||
            readyTimeoutMs <= 0
          ) {
            throw new UserError(
              `${where}.exec.persistent.readyTimeoutMs must be a positive integer (milliseconds)`,
            )
          }
        }
        if (cache !== undefined) {
          throw new UserError(
            `${where}: \`cache\` is not allowed on a persistent task — persistent tasks ` +
              `don't terminate, so there's no exit to cache`,
          )
        }
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
    const description = (task as { description?: unknown }).description
    if (description !== undefined && typeof description !== 'string') {
      throw new UserError(`${where}.description must be a string`)
    }
    if (dependsOn !== undefined) {
      if (!Array.isArray(dependsOn) || dependsOn.some((s) => typeof s !== 'string')) {
        throw new UserError(
          `${where}.dependsOn must be an array of strings ` +
            `(Turbo/Nx micro-syntax: 'name', '^name', 'pkg#name')`,
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
      const envList = (inputs as { env?: unknown }).env
      if (envList !== undefined) {
        if (
          !Array.isArray(envList) ||
          envList.some((s) => typeof s !== 'string' || s.length === 0)
        ) {
          throw new UserError(
            `${where}.cache.inputs.env must be an array of non-empty env var names`,
          )
        }
        for (const name of envList as string[]) {
          // Reject wildcards explicitly so users don't silently miss
          // env vars they thought they were tracking. Turbo supports
          // `VERCEL_*` expansion; vx requires the literal names. If
          // we add expansion later it'll be additive — until then,
          // surface the footgun instead of returning '' for the
          // literal env name `'VERCEL_*'`.
          if (/[*?[\]]/.test(name)) {
            throw new UserError(
              `${where}.cache.inputs.env: wildcards in env names are not supported ` +
                `(got "${name}") — list explicit env var names instead`,
            )
          }
        }
      }
      if (!outputs || typeof outputs !== 'object') {
        throw new UserError(`${where}.cache.outputs is required when \`cache\` is set`)
      }
      const outFiles = (outputs as { files?: unknown }).files
      if (!Array.isArray(outFiles)) {
        throw new UserError(`${where}.cache.outputs.files must be an array of glob strings`)
      }
      // Reject zero-length strings and absolute paths up front.
      // Both reach `resolveOutputs` as undefined behavior; the error
      // surfaces deep inside the glob resolver with no line pointing
      // at the user's config. Fail loud at load time.
      for (const g of outFiles as unknown[]) {
        if (typeof g !== 'string' || g.length === 0) {
          throw new UserError(`${where}.cache.outputs.files must be an array of non-empty strings`)
        }
        if (g.startsWith('/')) {
          throw new UserError(
            `${where}.cache.outputs.files: absolute paths are not allowed (got "${g}") — ` +
              `outputs must be project-relative globs`,
          )
        }
      }
      // Same for inputs.files.
      for (const g of (inputs as { files: unknown[] }).files) {
        if (typeof g !== 'string' || g.length === 0) {
          throw new UserError(`${where}.cache.inputs.files must be an array of non-empty strings`)
        }
        if (g.startsWith('/')) {
          throw new UserError(
            `${where}.cache.inputs.files: absolute paths are not allowed (got "${g}") — ` +
              `inputs must be project-relative globs`,
          )
        }
      }
    }
    const sandbox = (task as { sandbox?: unknown }).sandbox
    if (sandbox !== undefined) validateSandbox(sandbox, where, exec !== undefined)
  }
}

const SANDBOX_PATH_FIELDS = ['allowRead', 'allowWrite'] as const
const SANDBOX_BOOL_FIELDS = [
  'allowGitConfig',
  'allowPty',
  'enableWeakerNestedSandbox',
  'enableWeakerNetworkIsolation',
] as const
const SANDBOX_NETWORK_PATH_FIELDS = [
  'allowedDomains',
  'deniedDomains',
  'allowUnixSockets',
  'allowMachLookup',
] as const
const SANDBOX_NETWORK_BOOL_FIELDS = ['allowAllUnixSockets', 'allowLocalBinding'] as const
const SANDBOX_FIELDS = new Set<string>([
  ...SANDBOX_PATH_FIELDS,
  ...SANDBOX_BOOL_FIELDS,
  'network',
  'ignoreViolations',
])
const SANDBOX_NETWORK_FIELDS = new Set<string>([
  ...SANDBOX_NETWORK_PATH_FIELDS,
  ...SANDBOX_NETWORK_BOOL_FIELDS,
])

/**
 * Validate a `sandbox: {...}` block. The field set mirrors the user-
 * facing surface of SandboxConfig in src/config.ts; this is the only
 * place we enforce shape at runtime (TS users get compile-time checks
 * already).
 */
function validateSandbox(sandbox: unknown, where: string, hasExec: boolean): void {
  if (typeof sandbox !== 'object' || sandbox === null || Array.isArray(sandbox)) {
    throw new UserError(
      `${where}.sandbox must be an object (e.g. \`{}\` for the baseline, or ` +
        `\`{ allowRead: [...], network: true }\`)`,
    )
  }
  if (!hasExec) {
    throw new UserError(`${where}.sandbox requires \`exec\` — a group task has nothing to wrap`)
  }
  for (const key of Object.keys(sandbox as object)) {
    if (!SANDBOX_FIELDS.has(key)) {
      throw new UserError(
        `${where}.sandbox.${key} is not a known field. Allowed: ` +
          `${[...SANDBOX_FIELDS].sort().join(', ')}`,
      )
    }
  }
  const obj = sandbox as Record<string, unknown>
  for (const field of SANDBOX_PATH_FIELDS) {
    if (obj[field] === undefined) continue
    assertPathArray(obj[field], `${where}.sandbox.${field}`)
  }
  for (const field of SANDBOX_BOOL_FIELDS) {
    if (obj[field] !== undefined && typeof obj[field] !== 'boolean') {
      throw new UserError(`${where}.sandbox.${field} must be a boolean`)
    }
  }
  const network = obj.network
  if (network !== undefined && typeof network !== 'boolean') {
    if (typeof network !== 'object' || network === null || Array.isArray(network)) {
      throw new UserError(
        `${where}.sandbox.network must be a boolean or an object (allowedDomains, ` +
          `deniedDomains, allowUnixSockets, allowAllUnixSockets, allowLocalBinding, allowMachLookup)`,
      )
    }
    for (const key of Object.keys(network)) {
      if (!SANDBOX_NETWORK_FIELDS.has(key)) {
        throw new UserError(
          `${where}.sandbox.network.${key} is not a known field. Allowed: ` +
            `${[...SANDBOX_NETWORK_FIELDS].sort().join(', ')}`,
        )
      }
    }
    const netObj = network as Record<string, unknown>
    for (const field of SANDBOX_NETWORK_PATH_FIELDS) {
      if (netObj[field] === undefined) continue
      assertStringArray(netObj[field], `${where}.sandbox.network.${field}`)
    }
    for (const field of SANDBOX_NETWORK_BOOL_FIELDS) {
      if (netObj[field] !== undefined && typeof netObj[field] !== 'boolean') {
        throw new UserError(`${where}.sandbox.network.${field} must be a boolean`)
      }
    }
  }
  const ignoreViolations = obj.ignoreViolations
  if (ignoreViolations !== undefined) {
    if (
      typeof ignoreViolations !== 'object' ||
      ignoreViolations === null ||
      Array.isArray(ignoreViolations)
    ) {
      throw new UserError(
        `${where}.sandbox.ignoreViolations must be a record mapping command patterns to arrays of paths`,
      )
    }
    for (const [k, v] of Object.entries(ignoreViolations)) {
      assertStringArray(v, `${where}.sandbox.ignoreViolations[${JSON.stringify(k)}]`)
    }
  }
}

function assertStringArray(v: unknown, where: string): void {
  if (!Array.isArray(v) || v.some((s) => typeof s !== 'string' || s.length === 0)) {
    throw new UserError(`${where} must be an array of non-empty strings`)
  }
}

function assertPathArray(v: unknown, where: string): void {
  assertStringArray(v, where)
  if ((v as string[]).some((s) => /[*?[\]]/.test(s))) {
    throw new UserError(
      `${where} entries must be path prefixes (no globs — bwrap on Linux can't enforce them)`,
    )
  }
}
