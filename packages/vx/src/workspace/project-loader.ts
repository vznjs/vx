import path from 'node:path'
import type { ProjectConfig, WorkspaceConfig } from '../config.js'
import { MAX_TIMEOUT_MS, UserError, xxh3hex } from '../util/index.js'
import { evaluateConfigFresh } from './config-eval.js'

const WORKSPACE_CONFIG_FILENAMES = [
  'vx.workspace.ts',
  'vx.workspace.mts',
  'vx.workspace.js',
  'vx.workspace.mjs',
]

/** Project configs already loaded in this process, by absolute path. */
const loadedConfigs = new Set<string>()

function assertDefaultObject(mod: unknown, kind: string, configPath: string): void {
  if (!mod || typeof mod !== 'object') {
    throw new UserError(`${kind} config at ${configPath} did not export a default object`)
  }
}

// Bun has native TS / ESM execution — no transpiler dep needed. We fold
// a short content hash into the import URL as a cache-bust key so that:
//   same content   → same URL → Bun's module cache hits (fast)
//   changed content → new URL → fresh re-evaluation (correct)
// mtime would be cheaper but Bun's stat().mtimeNs is currently undefined
// on Linux/macOS, and ms-resolution mtime misses rapid edits in tests.
// Hashing a typical <10 KB config file is ~50µs — not measurable next
// to the import() evaluation itself.
async function loadDefaultExport(
  configPath: string,
  kind: string,
  fresh = false,
): Promise<unknown> {
  const bytes = await Bun.file(configPath).bytes()
  // `fresh` opts out of module-cache reuse entirely: `vx lock` and
  // `vx lock --check` must observe the CURRENT environment, and the
  // content-hash bust would replay an evaluation made under earlier
  // env values when the file bytes are unchanged in this process.
  const bust = fresh ? `${xxh3hex(bytes)}-${Bun.randomUUIDv7()}` : xxh3hex(bytes)
  const ns = (await import(`${configPath}?vx-bust=${bust}`)) as { default?: unknown }
  const mod = ns?.default
  assertDefaultObject(mod, kind, configPath)
  return mod
}

export async function loadProjectConfig(
  configPath: string,
  opts?: { fresh?: boolean },
): Promise<ProjectConfig> {
  // A REPEAT load in this process re-evaluates in a worker, because the
  // bust above cannot reach the config's import closure — see
  // config-eval.ts. A FIRST load keeps the in-process import, so the
  // single `vx run` hot path never pays for a worker.
  const repeat = loadedConfigs.has(configPath)
  loadedConfigs.add(configPath)
  const mod = repeat
    ? await evaluateConfigFresh(configPath)
    : await loadDefaultExport(configPath, 'Project', opts?.fresh === true)
  assertDefaultObject(mod, 'Project', configPath)
  // Validation runs HERE, on whichever object we ended up with, so a
  // malformed config reports the identical UserError whether it was
  // evaluated in-process or in a worker.
  validateProjectConfig(mod as ProjectConfig, configPath)
  return mod as ProjectConfig
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
  if (config.timeout !== undefined) {
    if (
      typeof config.timeout !== 'number' ||
      !Number.isInteger(config.timeout) ||
      config.timeout <= 0
    ) {
      throw new UserError(`${configPath}: \`timeout\` must be a positive integer (milliseconds)`)
    }
    assertTimeoutInRange(config.timeout, `${configPath}: \`timeout\``)
  }
  if (config.plugins !== undefined) {
    if (!Array.isArray(config.plugins)) {
      throw new UserError(`${configPath}: \`plugins\` must be an array of plugin objects`)
    }
    for (const [i, p] of config.plugins.entries()) {
      if (p === null || typeof p !== 'object') {
        throw new UserError(`${configPath}: \`plugins[${i}]\` must be an object`)
      }
      const plug = p as {
        name?: unknown
        setup?: unknown
        backend?: unknown
        cache?: unknown
        executor?: unknown
        telemetry?: unknown
        eventSink?: unknown
        teardown?: unknown
      }
      if (typeof plug.name !== 'string' || plug.name.length === 0) {
        throw new UserError(`${configPath}: \`plugins[${i}].name\` must be a non-empty string`)
      }
      // The whole-run `backend` seam was REMOVED on 2026-08-23 with vx
      // cloud: a run always executes in the `vx run` process. Nothing
      // consults `.backend` any more, so leaving it in `caps` below meant a
      // plugin declaring ONLY `backend` — a third-party one written against
      // the old API, say — validated as "contributes a capability" and was
      // then silently ignored. Refuse it by name and point at the seam that
      // replaced it; a silent no-op is the failure this validation exists
      // to prevent.
      if (plug.backend !== undefined) {
        throw new UserError(
          `${configPath}: \`plugins[${i}].backend\` is no longer a capability — the whole-run ` +
            `backend seam was removed in 2026-08. Use \`executor\` to change where a single ` +
            `task's command runs (see docs/architecture.md § plugin capabilities).`,
        )
      }
      const caps = ['setup', 'cache', 'executor', 'telemetry', 'eventSink', 'teardown'] as const
      for (const cap of caps) {
        if (plug[cap] !== undefined && typeof plug[cap] !== 'function') {
          throw new UserError(`${configPath}: \`plugins[${i}].${cap}\` must be a function`)
        }
      }
      // A plugin must contribute at least one capability or lifecycle hook
      // — an empty `{ name }` object is a no-op authoring mistake.
      if (caps.every((cap) => plug[cap] === undefined)) {
        throw new UserError(
          `${configPath}: \`plugins[${i}]\` must contribute at least one of ${caps.join('/')}`,
        )
      }
    }
  }
  if (config.predictive !== undefined && typeof config.predictive !== 'boolean') {
    throw new UserError(`${configPath}: \`predictive\` must be a boolean`)
  }
}

/**
 * Runtime validation for the user-authored config. TypeScript checks
 * shape at edit-time, but `vx run` may load configs that were never
 * typechecked (plain .js, or TS with errors ignored). Catch the worst
 * shape problems early with a clear message rather than letting them
 * crash deeper in the orchestrator. Also applied to configs loaded
 * back from `vx-lock.json` (a hand-editable file — same boundary).
 */
export function validateProjectConfig(config: ProjectConfig, configPath: string): void {
  const tasks = config.tasks
  if (tasks === undefined) return
  if (typeof tasks !== 'object' || tasks === null || Array.isArray(tasks)) {
    // An ARRAY of task objects reads as valid to `typeof`, and
    // `Object.entries` then yields a task literally named "0" — a config
    // that loads, runs nothing the author asked for, and never says why.
    throw new UserError(`${configPath}: \`tasks\` must be an object keyed by task name`)
  }
  for (const [name, task] of Object.entries(tasks)) {
    const where = `${configPath}: tasks.${name}`
    if (!task || typeof task !== 'object') {
      throw new UserError(`${where} must be an object`)
    }
    assertKnownFields(task, TASK_FIELDS, where)
    const exec = (task as { exec?: unknown }).exec
    const dependsOn = (task as { dependsOn?: unknown }).dependsOn
    const cache = (task as { cache?: unknown }).cache
    if (exec !== undefined) {
      if (typeof exec !== 'object' || exec === null) {
        throw new UserError(`${where}.exec must be an object with a \`command\` string`)
      }
      assertKnownFields(exec, EXEC_FIELDS, `${where}.exec`)
      const command = (exec as { command?: unknown }).command
      if (typeof command !== 'string' || command.length === 0) {
        throw new UserError(`${where}.exec.command must be a non-empty string`)
      }
      const timeout = (exec as { timeout?: unknown }).timeout
      if (timeout !== undefined) {
        if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout <= 0) {
          throw new UserError(`${where}.exec.timeout must be a positive integer (milliseconds)`)
        }
        assertTimeoutInRange(timeout, `${where}.exec.timeout`)
      }
      const retries = (exec as { retries?: unknown }).retries
      if (retries !== undefined) {
        if (typeof retries !== 'number' || !Number.isInteger(retries) || retries < 0) {
          throw new UserError(`${where}.exec.retries must be a non-negative integer`)
        }
      }
      const remote = (exec as { remote?: unknown }).remote
      if (remote !== undefined && typeof remote !== 'boolean' && remote !== 'only') {
        throw new UserError(`${where}.exec.remote must be a boolean or 'only' (or omitted)`)
      }
      const resources = (exec as { resources?: unknown }).resources
      if (resources !== undefined) {
        validateResources(resources, `${where}.exec.resources`)
      }
      const env = (exec as { env?: unknown }).env
      if (env !== undefined) {
        if (typeof env !== 'object' || env === null) {
          throw new UserError(`${where}.exec.env must be an object (or omitted)`)
        }
        const passThrough = (env as { passThrough?: unknown }).passThrough
        if (passThrough !== undefined) {
          // A non-array here reaches `buildIsolatedEnv`'s `for (const name of
          // passThrough)` — a number throws "not iterable" mid-run, a string
          // silently char-iterates. Fail loud at load with a config pointer.
          if (
            !Array.isArray(passThrough) ||
            passThrough.some((n) => typeof n !== 'string' || n.length === 0)
          ) {
            throw new UserError(
              `${where}.exec.env.passThrough must be an array of non-empty env var names`,
            )
          }
        }
        const define = (env as { define?: unknown }).define
        if (define !== undefined) {
          if (typeof define !== 'object' || define === null || Array.isArray(define)) {
            throw new UserError(
              `${where}.exec.env.define must be an object of name:value string pairs`,
            )
          }
          for (const [k, val] of Object.entries(define as Record<string, unknown>)) {
            if (typeof val !== 'string') {
              throw new UserError(`${where}.exec.env.define.${k} must be a string`)
            }
          }
        }
      }
      const persistent = (exec as { persistent?: unknown }).persistent
      if (persistent !== undefined) {
        if (typeof persistent !== 'object' || persistent === null) {
          throw new UserError(`${where}.exec.persistent must be an object (or omitted)`)
        }
        // The one nested object that had no unknown-key check while every
        // sibling did — and the failure it let through is the quiet kind:
        // `readWhen` (typo) leaves `readyWhen` undefined, so the task is
        // ready the moment it spawns instead of when its server actually
        // listens, and the dependents that start too early fail in a way
        // that points at the user's code rather than at their config.

        assertKnownFields(persistent, PERSISTENT_FIELDS, `${where}.exec.persistent`)
        const readyWhen = (persistent as { readyWhen?: unknown }).readyWhen
        if (readyWhen !== undefined && typeof readyWhen !== 'string') {
          throw new UserError(`${where}.exec.persistent.readyWhen must be a string regex`)
        }
        if (cache !== undefined) {
          throw new UserError(
            `${where}: \`cache\` is not allowed on a persistent task — persistent tasks ` +
              `don't terminate, so there's no exit to cache`,
          )
        }
        if (retries !== undefined) {
          throw new UserError(
            `${where}: \`retries\` is not allowed on a persistent task — persistent tasks ` +
              `don't terminate, so there's no failed exit to retry`,
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
      assertKnownFields(cache, CACHE_FIELDS, `${where}.cache`)
      const inputs = (cache as { inputs?: unknown }).inputs
      const outputs = (cache as { outputs?: unknown }).outputs
      if (!inputs || typeof inputs !== 'object') {
        throw new UserError(`${where}.cache.inputs is required when \`cache\` is set`)
      }
      assertKnownFields(inputs, CACHE_INPUT_FIELDS, `${where}.cache.inputs`)
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
      assertKnownFields(outputs, CACHE_OUTPUT_FIELDS, `${where}.cache.outputs`)
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
        if (hasParentSegment(g)) {
          throw new UserError(
            `${where}.cache.outputs.files: '..' path segments are not allowed (got "${g}") — ` +
              `outputs must stay within the project (a glob that escapes the project dir would ` +
              `let cleanOutputs delete files outside it)`,
          )
        }
        if (g.startsWith('!')) {
          throw new UserError(
            `${where}.cache.outputs.files: negation is not supported (got "${g}") — ` +
              `unlike inputs, output globs are never split on '!', so this is read as a literal ` +
              `path beginning with '!' and matches nothing. List the outputs you DO produce.`,
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
        if (hasParentSegment(g)) {
          throw new UserError(
            `${where}.cache.inputs.files: '..' path segments are not allowed (got "${g}") — ` +
              `inputs must be project-relative (a '..' glob silently matches nothing; ` +
              `use cache.inputs.workspaceFiles for workspace-root-relative inputs)`,
          )
        }
        assertNotDoubleNegated(g, `${where}.cache.inputs.files`)
      }
      // A list of ONLY negations selects nothing at all. `resolveFiles`
      // builds the file set from the POSITIVE globs and uses the `!` entries
      // purely to subtract, so with no positive pattern it returns `[]` — the
      // task folds ZERO file inputs and its key stops moving with its source,
      // which is a stale hit waiting to happen.
      //
      // Every gitignore-trained reader parses `['!**/*.spec.ts']` as
      // "everything except specs", and Turbo makes exactly this a hard config
      // error for the same reason. Refusing costs nothing: such a config was
      // already silently broken, so no working key changes.
      assertNotNegationOnly((inputs as { files: string[] }).files, `${where}.cache.inputs.files`)
      // The only CacheInputs field that reached the run unvalidated: a
      // non-string entry crashes deep in `filterUpstreamHashes` /
      // `parseDependencySpec` with a raw TypeError naming neither the task
      // nor the config. Entry SYNTAX is already checked downstream (a
      // `DependencySpecError` becomes a UserError naming the task) — this
      // only pins the shape.
      const taskFilters = (inputs as { tasks?: unknown }).tasks
      if (taskFilters !== undefined) {
        if (
          !Array.isArray(taskFilters) ||
          taskFilters.some((s) => typeof s !== 'string' || s.length === 0)
        ) {
          throw new UserError(
            `${where}.cache.inputs.tasks must be an array of non-empty strings ` +
              `(Turbo/Nx micro-syntax: 'name', '^name', 'pkg#name', '*', '^*', '!name')`,
          )
        }
      }
      for (const field of ['runtime', 'workspaceRuntime'] as const) {
        const list = (inputs as Record<string, unknown>)[field]
        if (list !== undefined) {
          if (!Array.isArray(list) || list.some((s) => typeof s !== 'string' || s.length === 0)) {
            throw new UserError(
              `${where}.cache.inputs.${field} must be an array of non-empty shell command strings`,
            )
          }
        }
      }
      // workspaceFiles mirror the files validation: non-empty strings,
      // never absolute (they're workspace-root-relative by definition).
      const wsInputs = (inputs as { workspaceFiles?: unknown }).workspaceFiles
      if (wsInputs !== undefined) {
        validateWorkspaceGlobs(wsInputs, `${where}.cache.inputs.workspaceFiles`, true)
      }
      const wsOutputs = (outputs as { workspaceFiles?: unknown }).workspaceFiles
      if (wsOutputs !== undefined) {
        validateWorkspaceGlobs(wsOutputs, `${where}.cache.outputs.workspaceFiles`, false)
      }
    }
    const sandbox = (task as { sandbox?: unknown }).sandbox
    if (sandbox !== undefined) validateSandbox(sandbox, where, exec !== undefined)
  }
}

// Known fields per config level, mirroring the interfaces in src/config.ts.
// Unknown keys are REJECTED rather than silently dropped: a typo in a
// cache-key field (`workspaceFile`, `task`, `timeoutMs`) is otherwise
// discarded, so the task hashes as if the field were never written and vx
// serves a stale artifact — the same reasoning `exec.resources` and
// `sandbox` already encode. A new field must be added here deliberately.
const TASK_FIELDS = new Set(['description', 'exec', 'dependsOn', 'cache', 'sandbox'])
const EXEC_FIELDS = new Set([
  'command',
  'env',
  'timeout',
  'retries',
  'resources',
  'persistent',
  'remote',
])
const PERSISTENT_FIELDS = new Set(['readyWhen'])
const CACHE_FIELDS = new Set(['inputs', 'outputs'])
const CACHE_INPUT_FIELDS = new Set([
  'files',
  'workspaceFiles',
  'env',
  'tasks',
  'runtime',
  'workspaceRuntime',
])
const CACHE_OUTPUT_FIELDS = new Set(['files', 'workspaceFiles'])

function assertKnownFields(value: object, allowed: ReadonlySet<string>, where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new UserError(
        `${where} has unknown field "${key}". Allowed: ${[...allowed].sort().join(', ')}`,
      )
    }
  }
}

/**
 * True when a glob contains a `..` PATH SEGMENT (`../x`, `a/../b`, `x/..`), which
 * escapes its base dir — `foo..bar` / `a..b` inside a filename are fine. A
 * leading negation marker is stripped first so `!../x` is caught too. Used to
 * keep output globs inside the project and workspace globs inside the workspace
 * root: `cleanOutputs` rm()s resolved output paths before every run, and
 * `Bun.Glob.scan` follows `..` out of its cwd, so a `..` glob is a data-loss
 * vector (delete files outside the project / above the repo root).
 */
/**
 * A millisecond delay past `MAX_TIMEOUT_MS` does not mean "effectively never" —
 * `setTimeout` silently reduces it to 1 ms, so the task is killed the instant it
 * spawns and reported `failed`. That is the exact inverse of the declaration,
 * and the only clue is a `TimeoutOverflowWarning` on stderr.
 *
 * Refused rather than clamped, because this is a value the user WROTE and reads
 * back: silently substituting ~24.8 days for the 317 years they asked for would
 * trade one surprise for a quieter one. Costs nothing — such a config never
 * worked, it killed the task in milliseconds, so refusing reports a state that
 * already existed.
 */
function assertTimeoutInRange(ms: number, where: string): void {
  if (ms <= MAX_TIMEOUT_MS) return
  throw new UserError(
    `${where}: ${ms} ms exceeds the maximum timer delay (${MAX_TIMEOUT_MS} ms, ~24.8 days). ` +
      `Timers larger than this do NOT mean "no limit" — the platform reduces them to 1 ms, so ` +
      `the task would be killed the moment it starts. Omit \`timeout\` for no limit.`,
  )
}

function hasParentSegment(glob: string): boolean {
  const g = glob.startsWith('!') ? glob.slice(1) : glob
  return g.split('/').some((seg) => seg === '..')
}

/**
 * Refuse a non-empty glob list made up ENTIRELY of negations.
 *
 * The resolvers build their file set from the POSITIVE globs and use `!`
 * entries only to subtract, so with no positive pattern they return `[]` —
 * the task folds zero file inputs and its cache key stops moving with its
 * source. That is a stale hit, and it is silent.
 *
 * Refusing is free: such a config was ALREADY selecting nothing, so no
 * working task's key changes and no CACHE_VERSION bump is owed.
 */
/**
 * `!!x` INVERTS the input set instead of double-negating it.
 *
 * The resolver strips ONE `!` and hands the remainder to `new Bun.Glob()` —
 * which applies its OWN leading-`!` negation. So `!!vendor/**` becomes the
 * exclude glob `Glob('!vendor/**')`, and that matches every path EXCEPT
 * vendor's. Everything else is therefore excluded and the task folds ONLY
 * `vendor/**`: its own source drops out of the cache key entirely, which is a
 * permanent stale hit.
 *
 * Neither neighbouring guard catches it — `assertNotNegationOnly` sees the
 * positive glob and is satisfied, and `hasParentSegment` strips one `!` before
 * splitting so `!!../x` shows no `..` segment.
 *
 * Refused rather than reinterpreted: `!!` has no coherent meaning here.
 * Negation in vx is subtraction from what a positive glob matched, not
 * gitignore's ordered re-inclusion, so there is nothing for a second `!` to
 * undo. Costs nothing to refuse — such a config already folds the wrong set,
 * so no working cache key changes.
 */
function assertNotDoubleNegated(glob: string, where: string): void {
  if (!glob.startsWith('!!')) return
  const inner = glob.slice(2)
  throw new UserError(
    `${where}: '!!' is not a double negation (got "${glob}") — it INVERTS the set. ` +
      `One '!' is stripped and the remainder is compiled as a glob, which applies its own ` +
      `leading-'!' negation, so this excludes everything EXCEPT ${JSON.stringify(inner)} and ` +
      `the task folds only that. Use ${JSON.stringify(`!${inner}`)} to subtract it, or ` +
      `${JSON.stringify(inner)} to include it.`,
  )
}

function assertNotNegationOnly(globs: readonly string[], where: string): void {
  if (globs.length === 0) return
  if (globs.some((g) => !g.startsWith('!'))) return
  throw new UserError(
    `${where}: every entry is a negation, which selects NOTHING (got ${JSON.stringify(globs)}) — ` +
      `negations only subtract from the files a positive glob already matched, so this task ` +
      `would fold zero file inputs and its cache key would stop tracking its source. ` +
      `Add the positive glob you meant, e.g. ['**/*', ${JSON.stringify(globs[0])}].`,
  )
}

/**
 * `negation: false` for OUTPUT globs — `resolveOutputs` /
 * `resolveWorkspaceOutputs` never split on `!`, so such an entry is read as a
 * literal path starting with `!` and matches nothing.
 */
function validateWorkspaceGlobs(v: unknown, where: string, negation: boolean): void {
  if (!Array.isArray(v)) {
    throw new UserError(`${where} must be an array of glob strings`)
  }
  for (const g of v as unknown[]) {
    if (typeof g !== 'string' || g.length === 0) {
      throw new UserError(`${where} must be an array of non-empty strings`)
    }
    if (g.startsWith('/') || g.startsWith('!/')) {
      throw new UserError(
        `${where}: absolute paths are not allowed (got "${g}") — ` +
          `entries are workspace-root-relative globs`,
      )
    }
    if (hasParentSegment(g)) {
      throw new UserError(
        `${where}: '..' path segments are not allowed (got "${g}") — ` +
          `entries are workspace-root-relative and must stay within the workspace root`,
      )
    }
    if (!negation && g.startsWith('!')) {
      throw new UserError(
        `${where}: negation is not supported (got "${g}") — ` +
          `unlike inputs, output globs are never split on '!', so this is read as a literal ` +
          `path beginning with '!' and matches nothing. List the outputs you DO produce.`,
      )
    }
    if (negation) assertNotDoubleNegated(g, where)
  }
  if (negation) assertNotNegationOnly(v as string[], where)
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

const RESOURCES_FIELDS = new Set(['cpus', 'memory', 'image'])

function validateResources(resources: unknown, where: string): void {
  if (typeof resources !== 'object' || resources === null || Array.isArray(resources)) {
    throw new UserError(`${where} must be an object (e.g. \`{ cpus: 2, memory: 2048 }\`)`)
  }
  for (const key of Object.keys(resources as object)) {
    if (!RESOURCES_FIELDS.has(key)) {
      throw new UserError(
        `${where} has unknown field "${key}". Allowed: ${[...RESOURCES_FIELDS].sort().join(', ')}`,
      )
    }
  }
  const { cpus, memory, image } = resources as {
    cpus?: unknown
    memory?: unknown
    image?: unknown
  }
  if (cpus !== undefined && (typeof cpus !== 'number' || !Number.isFinite(cpus) || cpus < 0)) {
    throw new UserError(`${where}.cpus must be a non-negative number of CPU cores`)
  }
  if (
    memory !== undefined &&
    (typeof memory !== 'number' || !Number.isInteger(memory) || memory < 0)
  ) {
    throw new UserError(`${where}.memory must be a non-negative integer number of megabytes`)
  }
  if (image !== undefined && (typeof image !== 'string' || image === '')) {
    throw new UserError(`${where}.image must be a non-empty string (or omitted)`)
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
