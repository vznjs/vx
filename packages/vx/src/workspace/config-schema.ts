// What a config may SAY — the schema validators for `vx.config.*` and
// `vx.workspace.*`, split from the loader (which decides HOW a file is
// evaluated) on 2026-09-10. Every object level refuses a key it does not
// know (tests/schema-unknown-keys), every message names the level and what
// it accepts, and `validateProjectConfig` is the one boundary the loader,
// the lockfile's frozen path and the plugin `project` stage all cross.

import {
  PLUGIN_FUNCTION_HOOKS,
  PLUGIN_HOOKS,
  PLUGIN_PACKAGE,
  type Plugin,
  type ProjectConfig,
  type WorkspaceConfig,
} from '../config.js'
import {
  DISPATCHED_VERBS,
  MAX_TIMEOUT_MS,
  nearest,
  normalizeGlob,
  UserError,
} from '../util/index.js'
import { WORKSPACE_FINGERPRINT_FILES } from './fingerprint.js'

// Mirrors `WorkspaceConfig` in src/config.ts. Unknown keys are REJECTED for
// the same reason the task levels reject them: `plugin: [...]` (singular)
// declared no plugins and ran the workspace bare, `cacheDirectory` left the
// cache where it was — a config that loads and quietly does nothing it says.
const WORKSPACE_FIELDS = new Set(['concurrency', 'cacheDir', 'timeout', 'plugins'])

export function validateWorkspace(config: WorkspaceConfig, configPath: string): void {
  assertKnownFields(config, WORKSPACE_FIELDS, configPath)
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
    const verbOwners = new Map<string, string>()
    const fileClaimants = new Map<string, string>()
    for (const [i, p] of config.plugins.entries()) {
      if (p === null || typeof p !== 'object') {
        throw new UserError(`${configPath}: \`plugins[${i}]\` must be an object`)
      }
      // The loose schema's shape (unknown-typed hooks) plus the one retired
      // key this loader still refuses by name.
      const plug = p as Partial<Plugin> & { name?: unknown; backend?: unknown }
      // A plugin's name is its package name and nothing else. `definePlugin`
      // reads it and stamps it under a registry symbol; a plain object, or
      // one whose `name` was overwritten after the stamp, is refused here —
      // the one boundary every plugin crosses.
      const pkg = (p as Record<symbol, unknown>)[PLUGIN_PACKAGE]
      if (typeof pkg !== 'string' || pkg.length === 0) {
        throw new UserError(
          `${configPath}: \`plugins[${i}]\` must come from definePlugin(import.meta, { … }) — a plugin's name is its package name`,
        )
      }
      if (plug.name !== pkg) {
        throw new UserError(
          `${configPath}: \`plugins[${i}].name\` overrides the package name ('${String(plug.name)}' over '${pkg}') — a plugin's name is its package name; drop the field`,
        )
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
      for (const cap of PLUGIN_FUNCTION_HOOKS) {
        if (plug[cap] !== undefined && typeof plug[cap] !== 'function') {
          throw new UserError(`${configPath}: \`plugins[${i}].${cap}\` must be a function`)
        }
      }
      if (plug.commands !== undefined) {
        if (plug.commands === null || typeof plug.commands !== 'object') {
          throw new UserError(`${configPath}: \`plugins[${i}].commands\` must be an object`)
        }
        for (const [verb, cmd] of Object.entries(plug.commands as Record<string, unknown>)) {
          const c = cmd as { description?: unknown; run?: unknown } | null
          if (
            c === null ||
            typeof c !== 'object' ||
            typeof c.run !== 'function' ||
            typeof c.description !== 'string'
          ) {
            throw new UserError(
              `${configPath}: \`plugins[${i}].commands.${verb}\` must be { description: string, run: function }`,
            )
          }
          // A verb the dispatcher would never reach is refused, not left
          // dead: core verbs are matched first, and two plugins on one verb
          // would run the first declared and hide the second. Here, in the
          // schema, so every loader of the file — a run, a reading verb, the
          // plugin-verb lookup — refuses it the same way.
          if (DISPATCHED_VERBS.includes(verb)) {
            throw new UserError(
              `${configPath}: plugin '${plug.name}' declares command '${verb}', a core verb — core verbs cannot be shadowed`,
            )
          }
          const owner = verbOwners.get(verb)
          if (owner !== undefined) {
            throw new UserError(
              `${configPath}: plugins '${owner}' and '${plug.name}' both declare command '${verb}' — a verb has one owner`,
            )
          }
          verbOwners.set(verb, plug.name)
        }
      }
      if (plug.fingerprint !== undefined) {
        const claim = plug.fingerprint as { files?: unknown; affected?: unknown } | null
        if (
          claim === null ||
          typeof claim !== 'object' ||
          !Array.isArray(claim.files) ||
          claim.files.length === 0 ||
          typeof claim.affected !== 'function'
        ) {
          throw new UserError(
            `${configPath}: \`plugins[${i}].fingerprint\` must be { files: [name, …], affected: function }`,
          )
        }
        for (const file of claim.files as unknown[]) {
          // A name core never folds has nothing to take out; claiming it
          // would read as covered while the plugin's material is all there is.
          if (typeof file !== 'string' || !WORKSPACE_FINGERPRINT_FILES.includes(file)) {
            throw new UserError(
              `${configPath}: plugin '${plug.name}' claims fingerprint file ${JSON.stringify(file)}, which core does not fold — one of ${WORKSPACE_FINGERPRINT_FILES.join(', ')}`,
            )
          }
          const owner = fileClaimants.get(file)
          if (owner !== undefined) {
            throw new UserError(
              `${configPath}: plugins '${owner}' and '${plug.name}' both claim fingerprint file '${file}' — a file has one claimant`,
            )
          }
          fileClaimants.set(file, plug.name)
        }
      }
      // A plugin must contribute at least one capability or lifecycle hook
      // — an empty `{ name }` object is a no-op authoring mistake.
      if (PLUGIN_HOOKS.every((hook) => plug[hook] === undefined)) {
        throw new UserError(
          `${configPath}: \`plugins[${i}]\` must contribute at least one of ${PLUGIN_HOOKS.join('/')}`,
        )
      }
    }
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
  // The top level too: `task:` (singular) loaded as a project with no
  // tasks and every request against it said "no projects declare".
  assertKnownFields(config, PROJECT_FIELDS, configPath)
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
      const sandbox = (exec as { sandbox?: unknown }).sandbox
      if (sandbox !== undefined) validateSandbox(sandbox, `${where}.exec`)
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
      const env = (exec as { env?: unknown }).env
      if (env !== undefined) {
        if (typeof env !== 'object' || env === null) {
          throw new UserError(`${where}.exec.env must be an object (or omitted)`)
        }
        // `env: { set: {...} }` loaded and defined nothing — the one level
        // without this check until 2026-09-10 (tests/schema-unknown-keys).
        assertKnownFields(env, ENV_FIELDS, `${where}.exec.env`)
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
        if (namesDirItself(g)) {
          throw new UserError(
            `${where}.cache.outputs.files: "${g}" names the project directory itself and selects nothing — use "**" for everything under it`,
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
        if (namesDirItself(g)) {
          throw new UserError(
            `${where}.cache.inputs.files: "${g}" names the project directory itself and selects nothing — use "**" for everything under it`,
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
        assertFilterNamesDeclaredDeps(taskFilters, task.dependsOn, where)
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
  }
}

// Known fields per config level, mirroring the interfaces in src/config.ts.
// Unknown keys are REJECTED rather than silently dropped: a typo in a
// cache-key field (`workspaceFile`, `task`, `timeoutMs`) is otherwise
// discarded, so the task hashes as if the field were never written and vx
// serves a stale artifact — the same reasoning `sandbox` already
// encodes. A new field must be added here deliberately.
const PROJECT_FIELDS = new Set(['tasks'])
const TASK_FIELDS = new Set(['description', 'exec', 'dependsOn', 'cache'])
const EXEC_FIELDS = new Set([
  'command',
  'env',
  'timeout',
  'retries',
  'persistent',
  'remote',
  'sandbox',
])
const PERSISTENT_FIELDS = new Set(['readyWhen'])
const ENV_FIELDS = new Set(['passThrough', 'define'])
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
      // The nearest accepted spelling first: the list says what the level
      // takes, the hint says which one was meant.
      const near = nearest(key, allowed)
      throw new UserError(
        `${where} has unknown field "${key}" (allowed: ${[...allowed].sort().join(', ')})` +
          (near === undefined ? '' : ` — did you mean ${near}?`),
      )
    }
  }
}

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
 * `.`, `./`, `././` (with or without a `!`) name the directory itself, which
 * no matcher expands: the entry selected nothing and said so nowhere.
 * `./src/**` is fine — the resolver strips the `./` (`normalizeGlob`).
 */
function namesDirItself(glob: string): boolean {
  const g = normalizeGlob(glob.startsWith('!') ? glob.slice(1) : glob)
  return g === '' || g === '/'
}

function hasParentSegment(glob: string): boolean {
  const g = glob.startsWith('!') ? glob.slice(1) : glob
  return g.split('/').some((seg) => seg === '..')
}

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

/**
 * An exact `cache.inputs.tasks` entry that no `dependsOn` entry names would
 * match nothing at hash time and fold no upstream hash — the task silently
 * decoupled from its dependencies, which is a stale hit waiting for the
 * next upstream change. `['buidl']` for `['build']` is the shape. Patterns,
 * wildcards and negations stay silent (a preset-spread pattern legitimately
 * matches nothing in some projects; excluding what is absent is harmless);
 * an exact name must be named by some `dependsOn` entry, exactly or by that
 * entry's own `*` pattern. `[]` is the explicit way to decouple.
 */
function assertFilterNamesDeclaredDeps(
  filters: readonly string[],
  dependsOn: readonly string[] | undefined,
  where: string,
): void {
  const taskHalf = (spec: string): string => {
    const body = spec.startsWith('^') ? spec.slice(1) : spec
    const hash = body.lastIndexOf('#')
    return hash === -1 ? body : body.slice(hash + 1)
  }
  const declared = (dependsOn ?? []).map(taskHalf)
  const named = (task: string): boolean =>
    declared.some((d) => (d.includes('*') ? taskPatternRegExp(d).test(task) : d === task))
  for (const raw of filters) {
    if (raw.startsWith('!') || raw === '*' || raw === '^*') continue
    const task = taskHalf(raw)
    if (task.length === 0 || task.includes('*') || named(task)) continue
    throw new UserError(
      `${where}.cache.inputs.tasks: "${raw}" names no task in ${where}.dependsOn ` +
        `(${declared.length === 0 ? 'none declared' : dependsOn!.map((d) => `'${d}'`).join(', ')}) — ` +
        `it would match nothing and fold no upstream hash, decoupling the task from its ` +
        `dependencies. Fix the name, or use [] to decouple on purpose.`,
    )
  }
}

/** The graph's `*`-only task glob (`compileTaskPattern`), mirrored: `*` is the sole metacharacter. */
function taskPatternRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`)
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
    if (namesDirItself(g)) {
      throw new UserError(
        `${where}: "${g}" names the workspace root itself and selects nothing — use "**" for everything under it`,
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

const SANDBOX_FIELDS = new Set([
  'allow',
  'deny',
  'ignore',
  'weakerWhenNested',
  'weakerNetworkIsolation',
])
const GRANT_PATH_FIELDS = ['read', 'write'] as const
const GRANT_NAME_FIELDS = ['systemInfo', 'machLookup'] as const
const GRANT_BOOL_FIELDS = ['pty', 'gitConfig'] as const
const GRANT_FIELDS = new Set<string>([
  ...GRANT_PATH_FIELDS,
  ...GRANT_NAME_FIELDS,
  ...GRANT_BOOL_FIELDS,
  'localBinding',
  'network',
  'unixSockets',
])
const DENY_FIELDS = new Set(['network'])

function assertStringArray(v: unknown, where: string): void {
  if (!Array.isArray(v) || v.some((s) => typeof s !== 'string' || s.length === 0)) {
    throw new UserError(`${where} must be an array of non-empty strings`)
  }
}

/**
 * Validate a `sandbox: {...}` block — one capability shape, whatever the
 * platform ends up doing with it. Unknown keys are refused rather than
 * dropped: a silently-ignored `allow.reads` would confine a task more than
 * its author believed, and the failure reads as a broken build.
 */
function validateSandbox(sandbox: unknown, where: string): void {
  if (typeof sandbox !== 'object' || sandbox === null || Array.isArray(sandbox)) {
    throw new UserError(
      `${where}.sandbox must be an object (e.g. \`{}\` for the baseline, or ` +
        `\`{ allow: { read: [...] } }\`)`,
    )
  }
  assertKnownFields(sandbox, SANDBOX_FIELDS, `${where}.sandbox`)
  const obj = sandbox as Record<string, unknown>

  for (const flag of ['weakerWhenNested', 'weakerNetworkIsolation']) {
    if (obj[flag] !== undefined && typeof obj[flag] !== 'boolean') {
      throw new UserError(`${where}.sandbox.${flag} must be a boolean`)
    }
  }

  const allow = obj['allow']
  if (allow !== undefined) {
    if (typeof allow !== 'object' || allow === null || Array.isArray(allow)) {
      throw new UserError(`${where}.sandbox.allow must be an object`)
    }
    assertKnownFields(allow, GRANT_FIELDS, `${where}.sandbox.allow`)
    const g = allow as Record<string, unknown>
    for (const f of GRANT_PATH_FIELDS) {
      // Patterns are allowed here: macOS matches them natively, Linux
      // expands them against the filesystem at resolve time.
      if (g[f] !== undefined) assertStringArray(g[f], `${where}.sandbox.allow.${f}`)
    }
    for (const f of GRANT_NAME_FIELDS) {
      if (g[f] !== undefined) assertStringArray(g[f], `${where}.sandbox.allow.${f}`)
    }
    for (const f of GRANT_BOOL_FIELDS) {
      if (g[f] !== undefined && typeof g[f] !== 'boolean') {
        throw new UserError(`${where}.sandbox.allow.${f} must be a boolean`)
      }
    }
    // `true` (everything) or an explicit list — nothing in between.
    for (const f of ['network', 'unixSockets']) {
      if (g[f] !== undefined && g[f] !== true) {
        assertStringArray(g[f], `${where}.sandbox.allow.${f}`)
      }
    }
    // A boolean, or the ports to bridge out of the sandbox: a non-empty
    // list of integers in the TCP range. An empty list would read as "no
    // port" while granting loopback, which is `true` with extra steps.
    const lb = g['localBinding']
    if (lb !== undefined && typeof lb !== 'boolean') {
      if (
        !Array.isArray(lb) ||
        lb.length === 0 ||
        lb.some((p) => !Number.isInteger(p) || (p as number) < 1 || (p as number) > 65535)
      ) {
        throw new UserError(
          `${where}.sandbox.allow.localBinding must be a boolean or a non-empty list of ports (1–65535)`,
        )
      }
    }
  }

  const deny = obj['deny']
  if (deny !== undefined) {
    if (typeof deny !== 'object' || deny === null || Array.isArray(deny)) {
      throw new UserError(`${where}.sandbox.deny must be an object`)
    }
    assertKnownFields(deny, DENY_FIELDS, `${where}.sandbox.deny`)
    const d = deny as Record<string, unknown>
    if (d['network'] !== undefined) assertStringArray(d['network'], `${where}.sandbox.deny.network`)
  }

  const ignore = obj['ignore']
  if (ignore !== undefined) {
    if (typeof ignore !== 'object' || ignore === null || Array.isArray(ignore)) {
      throw new UserError(`${where}.sandbox.ignore must be an object`)
    }
    assertKnownFields(ignore, GRANT_FIELDS, `${where}.sandbox.ignore`)
    const g = ignore as Record<string, unknown>
    // Patterns, not prefixes — `ignore` is vx's own filter over lines it
    // already holds, so a glob costs nothing and works on every platform.
    for (const f of [...GRANT_PATH_FIELDS, ...GRANT_NAME_FIELDS, 'network', 'unixSockets']) {
      if (g[f] !== undefined) assertStringArray(g[f], `${where}.sandbox.ignore.${f}`)
    }
    for (const f of GRANT_BOOL_FIELDS) {
      if (g[f] !== undefined) {
        throw new UserError(`${where}.sandbox.ignore.${f} is a flag, not something to ignore`)
      }
    }
  }
}
