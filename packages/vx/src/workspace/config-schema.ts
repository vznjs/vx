// What a config may SAY — the schema validators for `vx.config.*` and
// `.vx/workspace.*`, split from the loader (which decides HOW a file is
// evaluated) on 2026-09-10. Every object level refuses a key it does not
// know (tests/schema-unknown-keys), every message names the level and what
// it accepts, and `validateProjectConfig` is the one boundary the loader,
// the lockfile's frozen path and the plugin `project` stage all cross.

import path from 'node:path'
import {
  PLATFORMS,
  PLUGIN_FUNCTION_HOOKS,
  PLUGIN_HOOKS,
  PLUGIN_PACKAGE,
  type InputStability,
  type Plugin,
  type ProjectConfig,
  type WorkspaceConfig,
} from '../config.js'
import {
  CORE_VERBS,
  nearest,
  normalizeGlob,
  UserError,
  BUN_GLOB_WILDCARDS,
  EXTGLOB,
  braceRange,
  BRACE_RANGE_LIMIT,
  anyTaskGlob,
  asTrees,
  isLiteralPattern,
  parseDependencySpec,
  DependencySpecError,
} from '../util/index.js'
import {
  parseSettingValue,
  setting,
  SETTING_GROUPS,
  SETTINGS,
  settingEnv,
  settingRefusal,
} from '../settings.js'
import { compileNameGlob, parseFilter } from './filter.js'
import { nonJsonMessage, nonJsonPaths } from './json-data.js'
import { projectNameProblem, ROOT_NAME } from './workspace.js'

// Mirrors `WorkspaceConfig` in src/config.ts. Unknown keys are REJECTED for
// the same reason the task levels reject them: `plugin: [...]` (singular)
// declared no plugins and ran the workspace bare, `cacheDirectory` left the
// cache where it was — a config that loads and quietly does nothing it says.
const CACHE_SCOPE_RULE =
  "must be a scope name of letters, digits and . _ - / @ : (at most 128), like 'vznjs/vx:feat-x'"

/** A cache scope's rule, for `VX_CACHE_SCOPE` and a plugin's `setBranch`. */
export function isCacheScope(v: unknown): v is string {
  return typeof v === 'string' && /^[\w.@/:-]{1,128}$/.test(v)
}

/**
 * A branch's cache scope, `<owner>/<repo>:<branch>`: what CI writes for a
 * branch and a laptop on it reads (2026-10-17). The repository's
 * identity, not a remote's local name, so a clone whose `origin` is a fork
 * names the fork. A name may hold characters a scope may not; each
 * becomes `_`.
 */
const BASE_BRANCH_RULE = "must be a branch name like 'main'"

/**
 * A branch name git takes after `origin/`: a leading '-' would reach git
 * as an option, and whitespace, `..`, `~^:?*[\\` are no ref's. A ref
 * spelling (`origin/main`, `refs/heads/main`) is no branch either: vx
 * looked for `origin/origin/main`, found no base, and a run on main took
 * a branch's cache scope.
 */
function isBaseBranch(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[^-\s\0~^:?*[\\][^\s\0~^:?*[\\]*$/.test(value) &&
    !value.includes('..') &&
    !/^(?:origin|refs)\//.test(value)
  )
}

export function branchCacheScope(repo: string, branch: string): string {
  return `${repo.toLowerCase()}:${branch}`.replace(/[^\w.@/:-]/g, '_').slice(0, 128)
}

/** Why a `VX_CACHE_SCOPE` value is refused. */
export function cacheScopeError(source = 'VX_CACHE_SCOPE'): string {
  return `${source} ${CACHE_SCOPE_RULE}`
}

/** Why `VX_CACHE_SCOPE` is refused, as the run's error. */
export function cacheScopeEnvError(): UserError {
  return new UserError(cacheScopeError())
}

/** `baseBranch`: `VX_BASE_BRANCH`, else the workspace's; undefined lets git name it. */
export function configuredBaseBranch(workspace: WorkspaceConfig | null): string | undefined {
  const env = settingEnv('baseBranch')
  if (env !== undefined && !isBaseBranch(env)) {
    throw new UserError(`VX_BASE_BRANCH ${BASE_BRANCH_RULE}`, 'VX_E_USAGE')
  }
  return (env as string | undefined) ?? workspace?.baseBranch
}

const STRATEGIES = ['immutable', 'mutable', 'unchecked'] as const
const SEVERITIES = ['warn', 'error'] as const
const INPUT_STABILITY_FIELDS = new Set(['strategy', 'severity'])
const oneOf = (values: readonly string[]): string =>
  `must be ${values
    .map((v) => `'${v}'`)
    .join(', ')
    .replace(/, ([^,]*)$/, ' or $1')}`

function validateInputStability(stability: unknown, at: string): void {
  if (typeof stability !== 'object' || stability === null || Array.isArray(stability)) {
    throw new UserError(`${at} must be an object — \`inputStability: { strategy: 'mutable' }\``)
  }
  assertKnownFields(stability, INPUT_STABILITY_FIELDS, at)
  const { strategy, severity } = stability as Record<string, unknown>
  if (strategy !== undefined && !STRATEGIES.includes(strategy as never)) {
    throw new UserError(`${at}.strategy ${oneOf(STRATEGIES)}`)
  }
  if (severity !== undefined && !SEVERITIES.includes(severity as never)) {
    throw new UserError(`${at}.severity ${oneOf(SEVERITIES)}`)
  }
}

/**
 * `VX_CACHE_INPUT_STABILITY_STRATEGY` and `_SEVERITY`, which override every
 * task's `cache.inputStability` for the run: each undefined when unset or
 * empty, refused when it names no value.
 */
export function inputStabilityEnv(): InputStability {
  const strategy = settingEnv('cache.inputStability.strategy') as InputStability['strategy']
  const severity = settingEnv('cache.inputStability.severity') as InputStability['severity']
  return {
    ...(strategy !== undefined ? { strategy } : {}),
    ...(severity !== undefined ? { severity } : {}),
  }
}

const WORKSPACE_FIELDS = new Set<string>([...SETTING_GROUPS, 'baseBranch', 'plugins'])

/**
 * `.vx/workspace`'s settings, as `src/settings.ts` lists them: each group's
 * fields, and the nested objects (`run.rules`) with theirs.
 */
const GROUP_FIELDS = new Map<string, Set<string>>()
for (const s of SETTINGS) {
  if (s.config === false) continue
  const parts = s.path.split('.')
  for (let i = 1; i < parts.length; i++) {
    const at = parts.slice(0, i).join('.')
    if (!GROUP_FIELDS.has(at)) GROUP_FIELDS.set(at, new Set())
    GROUP_FIELDS.get(at)!.add(parts[i]!)
  }
}
// A list of objects, so no setting: no variable or flag can say it.
GROUP_FIELDS.get('run.rules')!.add('dependencies')

/** A setting's value or the level holding it, held to the schema. */
function validateSettingsAt(value: unknown, at: string, configPath: string): void {
  const where = `${configPath}: \`${at}\``
  const fields = GROUP_FIELDS.get(at)
  if (fields !== undefined) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      if (at === 'cache')
        // Turbo's and Nx's workspace `cache: true` is a task's own `cache` in vx (D-98).
        throw new UserError(
          `${where} must be an object like { dir, policy }; a task caches through its own \`cache\` in its project's vx.config`,
        )
      throw new UserError(`${where} must be an object (fields: ${[...fields].join(', ')})`)
    }
    assertKnownFields(value, fields, where)
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) validateSettingsAt(v, `${at}.${k}`, configPath)
    }
    return
  }
  if (at === 'run.rules.dependencies') validateDependencyRules(value, where)
  else validateSettingValue(value, at, where)
}

const RULE_FIELDS = new Set(['from', 'allow', 'deny'])

function validateDependencyRules(value: unknown, where: string): void {
  const shape = `an array of { from, allow?, deny? }, each a selector like 'tag:app' or '@acme/*'`
  if (!Array.isArray(value)) throw new UserError(`${where} must be ${shape}`)
  const selector = (v: unknown) => typeof v === 'string' && v.trim() !== '' && v !== 'tag:'
  const matchable = (v: string, field: string) => {
    const why = ruleSelectorProblem(v)
    if (why !== null)
      throw new UserError(
        `${field} ${JSON.stringify(v)} ${why}; a selector is 'tag:<tag>' or a project name, ` +
          `either may hold '*' (like 'tag:app' or '@acme/*')`,
      )
  }
  for (const [i, rule] of (value as unknown[]).entries()) {
    const at = `${where}[${i}]`
    if (typeof rule !== 'object' || rule === null || Array.isArray(rule))
      throw new UserError(`${at} must be { from, allow?, deny? }`)
    assertKnownFields(rule, RULE_FIELDS, at)
    const { from, allow, deny } = rule as Record<string, unknown>
    if (!selector(from)) throw new UserError(`${at}.from must be a selector like 'tag:app'`)
    matchable(from as string, `${at}.from`)
    for (const [k, list] of [
      ['allow', allow],
      ['deny', deny],
    ] as const) {
      if (list !== undefined && (!Array.isArray(list) || !list.every(selector)))
        throw new UserError(`${at}.${k} must be an array of selectors like 'tag:lib'`)
      for (const [j, v] of ((list ?? []) as string[]).entries()) matchable(v, `${at}.${k}[${j}]`)
    }
    // A rule that says nothing reads as a constraint and checks nothing.
    if (allow === undefined && deny === undefined)
      throw new UserError(`${at} names neither \`allow\` nor \`deny\``)
  }
}

/**
 * Why a rule selector can match no project, or null. The checker reads a
 * selector as a tag or name glob only, so a `--filter` form loaded and
 * matched nothing, and a `deny` of it passed every edge. Asked of the
 * filter parser itself, as `tagProblem`.
 */
function ruleSelectorProblem(s: string): string | null {
  const glob = s.startsWith('tag:') ? s.slice(4) : s
  if (s.trim() !== s || glob.trim() !== glob) return 'has surrounding whitespace'
  // The root's own name, which the filter reads as the root's directory.
  if (s === ROOT_NAME) return null
  if (s.startsWith('!')) return "starts with '!', which a filter reads as an exclusion"
  const walk = "starts or ends with '...', which a filter reads as a dependency walk"
  let f: ReturnType<typeof parseFilter>
  try {
    f = parseFilter(s, '/')
  } catch {
    // `...` alone: the walk with no project between.
    return walk
  }
  if (f.withDeps || f.withDependents || f.onlyDeps || f.onlyDependents) return walk
  if (f.gitSince !== undefined)
    return `ends in "[${f.gitSince}]", which a filter reads as a git range`
  if (f.isPath) return 'reads as a directory to a filter'
  return null
}

/** `value` as the setting at `path` takes it, refused in `where`'s words. */
function validateSettingValue(value: unknown, path: string, where: string): void {
  const { kind } = setting(path)
  // A file's values are typed: a count or a switch is no string (only a
  // share of the cores is), as a variable's or a flag's must be.
  const untyped =
    (kind.type === 'concurrency' && typeof value === 'string' && !value.endsWith('%')) ||
    (kind.type === 'int' && typeof value !== 'number') ||
    (kind.type === 'bool' && typeof value !== 'boolean')
  if (untyped || parseSettingValue(kind, value) === null) {
    throw new UserError(settingRefusal(path, where, value, shown(value)))
  }
}

/** The rules a setting's kind cannot say. */
function validateSettingsExtra(config: WorkspaceConfig, configPath: string): void {
  const dir = config.cache?.dir
  if (dir !== undefined && dir.includes('\0')) {
    // No path can carry one: the mkdir's argument error was reported as an
    // unwritable workspace.
    throw new UserError(`${configPath}: \`cache.dir\` holds a NUL, which no path can carry`)
  }
  const base = config.baseBranch
  if (base !== undefined && !isBaseBranch(base)) {
    throw new UserError(`${configPath}: \`baseBranch\` ${BASE_BRANCH_RULE}`)
  }
  // `policy`'s grammar is the cache module's (`parseCachePolicy`), which
  // this module may not import: the run parses it before any task (prepare.ts).
}

/**
 * A refused value as a message quotes it. A workspace file is evaluated
 * in-process and no JSON rule precedes its schema, so a value here may be
 * one `JSON.stringify` throws on (`30n`) or drops (a symbol): the refusal
 * became a TypeError with a stack.
 */
function shown(v: unknown): string {
  return typeof v === 'bigint' ? `${v}n` : (JSON.stringify(v) ?? String(v))
}

/** A `plugins` entry that stands for no plugin: `undefined`, `null` or `false`. */
export function isSkippedPlugin(p: unknown): p is undefined | null | false {
  return p === undefined || p === null || p === false
}

export function validateWorkspace(config: WorkspaceConfig, configPath: string): void {
  // No JSON-data rule here, unlike `validateProjectConfig`: `plugins` holds
  // objects of functions by design, the file is evaluated in-process on
  // every load (never through the config worker), and no key folds its JSON.
  assertKnownFields(config, WORKSPACE_FIELDS, configPath)
  for (const group of SETTING_GROUPS) {
    if (config[group] !== undefined) validateSettingsAt(config[group], group, configPath)
  }
  validateSettingsExtra(config, configPath)
  if (config.plugins !== undefined) {
    if (!Array.isArray(config.plugins)) {
      throw new UserError(`${configPath}: \`plugins\` must be an array of plugin objects`)
    }
    const verbOwners = new Map<string, string>()
    const fileClaimants = new Map<string, { name: string; at: number }>()
    for (const [i, p] of (config.plugins as readonly unknown[]).entries()) {
      // A factory that declines returns nothing, and `cond && plugin()` is
      // false: both are skipped, as Vite skips them.
      if (isSkippedPlugin(p)) continue
      if (p === null || typeof p !== 'object') {
        // Nx's nx.json lists plugins by module name (`'@nx/vite/plugin'`);
        // a vx plugin is the value its package's function returns.
        throw new UserError(
          `${configPath}: \`plugins[${i}]\` must be an object` +
            (typeof p === 'string'
              ? ` — a plugin is what its package's function returns (\`nx()\` from \`@vzn/vx-migrate\`), not a module name`
              : ''),
        )
      }
      // The loose schema's shape (unknown-typed hooks) plus the one retired
      // key this loader still refuses by name.
      const plug = p as Partial<Plugin> & { name?: unknown }
      // A plugin's name is its package name and nothing else. `definePlugin`
      // reads it and stamps it under a registry symbol; a plain object, or
      // one whose `name` was overwritten after the stamp, is refused here —
      // the one boundary every plugin crosses.
      const pkg = (p as Record<symbol, unknown>)[PLUGIN_PACKAGE]
      // An async factory called without `await` was told its plugin did not
      // come from definePlugin — it had (D-159).
      if (pkg === undefined && typeof (p as { then?: unknown }).then === 'function') {
        throw new UserError(
          `${configPath}: \`plugins[${i}]\` is a Promise — await the factory that returns the plugin`,
        )
      }
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
      // A misspelled hook (`excutor`, `setUp`) was never called and never
      // said: tasks ran here with the plugin's executor unheard (X-19).
      for (const key of Object.keys(plug)) {
        if (key === 'name' || (PLUGIN_HOOKS as readonly string[]).includes(key)) continue
        const near = nearest(key, PLUGIN_HOOKS)
        const hint =
          near === undefined ? ` (hooks: ${PLUGIN_HOOKS.join(', ')})` : ` — did you mean '${near}'?`
        throw new UserError(
          `${configPath}: plugin '${pkg}' declares '${key}', which is no plugin hook${hint}`,
        )
      }
      for (const cap of PLUGIN_FUNCTION_HOOKS) {
        if (plug[cap] !== undefined && typeof plug[cap] !== 'function') {
          throw new UserError(
            `${configPath}: \`plugins[${i}].${cap}\` of plugin '${pkg}' must be a function`,
          )
        }
      }
      if (plug.commands !== undefined) {
        if (plug.commands === null || typeof plug.commands !== 'object') {
          throw new UserError(
            `${configPath}: \`plugins[${i}].commands\` of plugin '${pkg}' must be an object`,
          )
        }
        // A list of commands loaded as the verbs `0`, `1`, … that help listed.
        if (Array.isArray(plug.commands)) {
          throw new UserError(
            `${configPath}: \`plugins[${i}].commands\` must be an object keyed by verb, not an array`,
          )
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
              `${configPath}: \`plugins[${i}].commands.${verb}\` of plugin '${pkg}' must be { description: string, run: function }`,
            )
          }
          // A verb the dispatcher would never reach is refused, not left
          // dead: core verbs are matched first, and two plugins on one verb
          // would run the first declared and hide the second. Here, in the
          // schema, so every loader of the file — a run, a reading verb, the
          // plugin-verb lookup — refuses it the same way. The owner is the
          // package: two plugins one package exports (`bun()` and `pnpm()`
          // both carry `prune`) are one owner, and the first declared runs.
          // `vx --version` and `vx ''` never reach a plugin: a flag is
          // core's, and an empty word is no verb (X-21). `vx completions`
          // writes verbs unquoted into a shell script, so a space or a `$(`
          // in one would break or inject into the user's rc.
          if (!/^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(verb)) {
            throw new UserError(
              `${configPath}: plugin '${plug.name}' declares command '${verb}', which is not a word — a verb is a letter or digit, then letters, digits, ':', '.', '_' or '-'`,
            )
          }
          if ((CORE_VERBS as readonly string[]).includes(verb)) {
            throw new UserError(
              `${configPath}: plugin '${plug.name}' declares command '${verb}', a core verb — core verbs cannot be shadowed`,
            )
          }
          const owner = verbOwners.get(verb)
          if (owner !== undefined && owner !== plug.name) {
            throw new UserError(
              `${configPath}: plugins '${owner}' and '${plug.name}' both declare command '${verb}' — a verb has one owner`,
            )
          }
          verbOwners.set(verb, plug.name)
        }
      }
      if (plug.fingerprint !== undefined) {
        const claim = plug.fingerprint as {
          files?: unknown
          affected?: unknown
          extraFiles?: unknown
        } | null
        if (
          claim === null ||
          typeof claim !== 'object' ||
          !Array.isArray(claim.files) ||
          claim.files.length === 0 ||
          typeof claim.affected !== 'function' ||
          (claim.extraFiles !== undefined && typeof claim.extraFiles !== 'function')
        ) {
          throw new UserError(
            `${configPath}: \`plugins[${i}].fingerprint\` of plugin '${pkg}' must be { files: [name, …], affected: function, extraFiles?: function }`,
          )
        }
        for (const file of claim.files as unknown[]) {
          // A bare name at the workspace root the plugin reads: a lockfile it
          // folds, or a file its stages read (`turbo.json`; `--affected` and
          // `vx watch` ask the claimant about it, item 961). A path is
          // refused: the root arm `vx watch` keeps is not recursive.
          if (
            typeof file !== 'string' ||
            file === '' ||
            file === '.' ||
            file === '..' ||
            /[/\\]/.test(file)
          ) {
            throw new UserError(
              `${configPath}: plugin '${plug.name}' claims fingerprint file ${shown(file)}, which is not a file name at the workspace root`,
            )
          }
          const owner = fileClaimants.get(file)
          // One package twice (`plugins: [bun(), bun()]`) read "plugins 'x'
          // and 'x' both claim" (D-158).
          if (owner !== undefined && owner.name === plug.name) {
            throw new UserError(
              `${configPath}: plugin '${plug.name}' claims fingerprint file '${file}' twice (plugins[${owner.at}] and plugins[${i}]) — a file has one claimant; declare the plugin once`,
            )
          }
          if (owner !== undefined) {
            throw new UserError(
              `${configPath}: plugins '${owner.name}' and '${plug.name}' both claim fingerprint file '${file}' — a file has one claimant`,
            )
          }
          fileClaimants.set(file, { name: plug.name, at: i })
        }
      }
      // A plugin must contribute at least one capability or lifecycle hook
      // — an empty `{ name }` object is a no-op authoring mistake.
      if (PLUGIN_HOOKS.every((hook) => plug[hook] === undefined)) {
        throw new UserError(
          `${configPath}: \`plugins[${i}]\` (plugin '${pkg}') must contribute at least one of ${PLUGIN_HOOKS.join('/')}`,
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
 * back from `.vx/projects.lock.json` (a hand-editable file — same boundary).
 * `ownConfig` is the config file outputs may not cover (null: none), apart
 * from `configPath` when that is a label (`<path> (after plugin 'x')`).
 */
export function validateProjectConfig(
  config: ProjectConfig,
  configPath: string,
  ownConfig: string | null = configPath,
): void {
  // Before the schema, on the object as it stands: the key folds its JSON,
  // so a value JSON cannot carry is refused here and in the config worker
  // alike (json-data.ts). A plugin's `project` edit and a lock entry cross
  // this line too.
  const [nonJson] = nonJsonPaths(config)
  if (nonJson !== undefined) throw new UserError(nonJsonMessage(configPath, nonJson))
  // The top level too: `task:` (singular) loaded as a project with no
  // tasks and every request against it said "no projects declare".
  assertKnownFields(config, PROJECT_FIELDS, configPath)
  const name: unknown = config.name
  if (name !== undefined) {
    // A task is `<project>#<task>`, split at the first `#`.
    if (typeof name !== 'string' || name === '' || name.trim() !== name || name.includes('#')) {
      throw new UserError(
        `${configPath}: \`name\` must be a non-empty string with no surrounding whitespace and no "#" (a task is <name>#<task>)`,
      )
    }
    const why = projectNameProblem(name)
    if (why !== null) {
      throw new UserError(
        `${configPath}: \`name\` ${JSON.stringify(name)} ${why} — dependsOn, --filter and the CLI could not name the project. Rename it.`,
      )
    }
  }
  const tags: unknown = config.tags
  if (
    tags !== undefined &&
    (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string' || t.trim() === ''))
  ) {
    throw new UserError(`${configPath}: \`tags\` must be an array of non-empty strings`)
  }
  for (const tag of (tags ?? []) as string[]) {
    const why = tagProblem(tag)
    if (why !== null) {
      throw new UserError(
        `${configPath}: tag ${JSON.stringify(tag)} ${why} — \`--filter tag:<name>\` could not ` +
          `name it. Rename the tag.`,
      )
    }
  }
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
    assertTaskName(name, configPath)
    if (!task || typeof task !== 'object') {
      // package.json's shape, `name: 'command'`, was refused without the
      // object that holds the command.
      const raw: unknown = task
      throw new UserError(
        typeof raw === 'string' && raw.trim() !== ''
          ? `${where} must be an object — a command is { exec: { command: ${JSON.stringify(raw)} } }`
          : `${where} must be an object`,
      )
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
      // Whitespace alone ran as a shell no-op, green and cached (item 1099).
      if (typeof command !== 'string' || command.trim().length === 0) {
        throw new UserError(`${where}.exec.command must be a non-empty string`)
      }
      // No argv can carry a NUL: the spawn refused it and the task failed
      // as exit 127, "not on this task's PATH", with the NUL printed as a
      // space (D-4), as an env name with one did before item 999.
      if (command.includes('\0')) {
        throw new UserError(`${where}.exec.command holds a NUL, which no command line can carry`)
      }
      const timeout = (exec as { timeout?: unknown }).timeout
      if (timeout !== undefined) {
        validateSettingValue(timeout, 'run.timeout', `${where}.exec.timeout`)
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
      // Documented and never held: an uncached 'only' task loaded, and the
      // REAPI executor refused it at run time for want of described inputs
      // (item 1001).
      if (remote === 'only' && cache === undefined) {
        throw new UserError(
          `${where}.exec.remote 'only' needs \`cache\`: its inputs are what a worker reproduces ` +
            `and its key is the address of its remote record`,
        )
      }
      const platforms = (exec as { platforms?: unknown }).platforms
      if (platforms !== undefined) {
        const known = PLATFORMS as readonly unknown[]
        if (
          !Array.isArray(platforms) ||
          platforms.length === 0 ||
          !platforms.every((p) => known.includes(p)) ||
          new Set(platforms).size !== platforms.length
        ) {
          throw new UserError(
            `${where}.exec.platforms must be a non-empty array of distinct platforms, each one of ${PLATFORMS.join(', ')}`,
          )
        }
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
          if (!Array.isArray(passThrough) || passThrough.some((n) => !isEnvName(n))) {
            throw new UserError(
              `${where}.exec.env.passThrough must be an array of env var names (non-empty, no '=' or NUL)`,
            )
          }
          // `VITE_*` passed nothing through and loaded clean (Turbo's
          // passThroughEnv expands it), where `inputs.env` refused the
          // same text below: one refusal for the class (item 1090).
          assertNoEnvNegation(passThrough as string[], `${where}.exec.env.passThrough`)
          const wild = (passThrough as string[]).find((n) => BUN_GLOB_WILDCARDS.test(n))
          if (wild !== undefined) {
            throw new UserError(
              `${where}.exec.env.passThrough: wildcards in env names are not supported ` +
                `(got "${wild}") — list explicit env var names instead`,
            )
          }
          for (const n of passThrough as string[])
            assertShellName(n, `${where}.exec.env.passThrough`)
        }
        const secret = (env as { secret?: unknown }).secret
        if (
          secret !== undefined &&
          (!Array.isArray(secret) ||
            secret.some((n) => !isEnvName(n) || BUN_GLOB_WILDCARDS.test(n)))
        ) {
          throw new UserError(
            `${where}.exec.env.secret must be an array of env var names (non-empty, no '=', NUL or wildcard)`,
          )
        }
        if (secret !== undefined)
          assertNoEnvNegation(secret as string[], `${where}.exec.env.secret`)
        const define = (env as { define?: unknown }).define
        if (define !== undefined) {
          if (typeof define !== 'object' || define === null || Array.isArray(define)) {
            throw new UserError(
              `${where}.exec.env.define must be an object of name:value string pairs`,
            )
          }
          for (const [k, val] of Object.entries(define as Record<string, unknown>)) {
            if (!isEnvName(k)) {
              throw new UserError(
                `${where}.exec.env.define: ${JSON.stringify(k)} is not an env var name (non-empty, no '=' or NUL)`,
              )
            }
            assertShellName(k, `${where}.exec.env.define`)
            if (typeof val !== 'string' || val.includes('\0')) {
              throw new UserError(`${where}.exec.env.define.${k} must be a string with no NUL`)
            }
          }
        }
      }
      const interactive = (exec as { interactive?: unknown }).interactive
      if (interactive !== undefined && typeof interactive !== 'boolean') {
        throw new UserError(`${where}.exec.interactive must be a boolean (or omitted)`)
      }
      if (interactive === true) {
        if (cache !== undefined) {
          throw new UserError(
            `${where}: \`cache\` is not allowed on an interactive task — what it does ` +
              `depends on what is typed, which no key holds`,
          )
        }
        // bwrap's --new-session keeps the terminal usable (probed), but the
        // sandboxed spawn pipes the task's streams: its stderr is read for
        // the tracer's own errors (sandbox-runtime.ts).
        if ((exec as { sandbox?: unknown }).sandbox !== undefined) {
          throw new UserError(
            `${where}: \`sandbox\` is not allowed on an interactive task — a sandboxed ` +
              `task's output passes through vx, and an interactive one writes to the terminal`,
          )
        }
        const ready = (exec as { persistent?: { readyWhen?: unknown } }).persistent
        if (typeof ready === 'object' && ready !== null && ready.readyWhen !== undefined) {
          throw new UserError(
            `${where}: \`persistent.readyWhen\` is not allowed on an interactive task — ` +
              `its output goes to the terminal, so vx reads none of it; it is ready once spawned`,
          )
        }
      }
      const persistent = (exec as { persistent?: unknown }).persistent
      if (persistent !== undefined) {
        if (typeof persistent !== 'object' || persistent === null) {
          throw new UserError(
            `${where}.exec.persistent must be an object (or omitted) — \`persistent: {}\`, or \`{ readyWhen: '<regex>' }\` to wait for a line`,
          )
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
        // Compiled here as the runner compiles it: an unbalanced `(` loaded
        // and then failed the task as "internal error" (item 998).
        if (readyWhen !== undefined) {
          try {
            new RegExp(readyWhen)
          } catch (err) {
            throw new UserError(
              `${where}.exec.persistent.readyWhen is not a valid regex (${(err as Error).message})`,
            )
          }
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
      // Group task: no exec, just dependencies. Only an ABSENT `dependsOn`
      // is refused — a task with neither is a typo, not a declaration. An
      // EMPTY one is deliberate and documented: `build: { dependsOn: [] }`
      // is how a package consumed as source says it has nothing to build,
      // so a dependant's `^build` finds it and waits on nothing
      // (the quickstart). The comment here used to call that case
      // "almost certainly a config mistake" while the docs taught it.
      // A keyed group (`inputs` with no `exec`) is a declaration on its own:
      // its inputs are a key that dependants fold, with no process.
      if (dependsOn === undefined && (task as { inputs?: unknown }).inputs === undefined) {
        throw new UserError(
          `${where}: a task with no \`exec\` must declare \`dependsOn\` or \`inputs\` ` +
            `(group tasks exist to chain dependencies or carry a key)`,
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
    const inputs = (task as { inputs?: unknown }).inputs
    if (inputs !== undefined) {
      if (typeof inputs !== 'object' || inputs === null) {
        throw new UserError(`${where}.inputs must be an object — \`inputs: { files: [...] }\``)
      }
      assertKnownFields(inputs, INPUT_FIELDS, `${where}.inputs`)
      if (!Array.isArray((inputs as { files?: unknown }).files)) {
        throw new UserError(`${where}.inputs.files must be an array of glob strings`)
      }
      const envList = (inputs as { env?: unknown }).env
      if (envList !== undefined) {
        if (
          !Array.isArray(envList) ||
          // A NUL can be in no env name, and the key fold's delimiter is one.
          envList.some((s) => !isEnvName(s))
        ) {
          throw new UserError(
            `${where}.inputs.env must be an array of env var names (non-empty, no '=' or NUL)`,
          )
        }
        assertNoEnvNegation(envList as string[], `${where}.inputs.env`)
        for (const name of envList as string[]) {
          // Reject wildcards explicitly so users don't silently miss
          // env vars they thought they were tracking. Turbo supports
          // `VERCEL_*` expansion; vx requires the literal names. If
          // we add expansion later it'll be additive — until then,
          // surface the footgun instead of returning '' for the
          // literal env name `'VERCEL_*'`.
          // An env name is no path, so a bracket is no route directory: the
          // whole `Bun.Glob` alphabet stays refused here.
          if (BUN_GLOB_WILDCARDS.test(name)) {
            throw new UserError(
              `${where}.inputs.env: wildcards in env names are not supported ` +
                `(got "${name}") — list explicit env var names instead`,
            )
          }
        }
      }
      // Same for inputs.files.
      for (const g of (inputs as { files: unknown[] }).files) {
        if (typeof g !== 'string' || g.length === 0) {
          throw new UserError(`${where}.inputs.files must be an array of non-empty strings`)
        }
        if (!g.startsWith('!/') && isAbsoluteGlob(g)) {
          throw new UserError(
            `${where}.inputs.files: absolute paths are not allowed (got "${g}") — ` +
              `inputs must be project-relative globs`,
          )
        }
        if (hasParentSegment(g)) {
          throw new UserError(
            `${where}.inputs.files: '..' path segments are not allowed (got "${g}") — ` +
              `inputs must be project-relative (a '..' glob silently matches nothing; ` +
              `use inputs.workspaceFiles for workspace-root-relative inputs)`,
          )
        }
        assertPosixGlob(g, `${where}.inputs.files`, 'project')
        assertNoForeignToken(g, `${where}.inputs.files`)
        assertInputGlob(g, `${where}.inputs.files`)
        if (namesDirItself(g)) {
          throw new UserError(
            `${where}.inputs.files: "${g}" names the project directory itself and selects nothing — use "**" for everything under it`,
          )
        }
        // A negated absolute path subtracts nothing (the positive globs are
        // project-relative), so it would sit in the config as a silent no-op;
        // `workspaceFiles` refuses both spellings the same way (item 679).
        if (g.startsWith('!/')) {
          throw new UserError(
            `${where}.inputs.files: absolute paths are not allowed (got "${g}") — ` +
              `inputs must be project-relative globs`,
          )
        }
        assertNotDoubleNegated(g, `${where}.inputs.files`)
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
      assertNotNegationOnly((inputs as { files: string[] }).files, `${where}.inputs.files`)
      assertNoLiteralTakenBack((inputs as { files: string[] }).files, `${where}.inputs.files`)
      // The only InputsConfig field that reached the run unvalidated: a
      // non-string entry crashes deep in `filterUpstreamHashes` /
      // `parseDependencySpec` with a raw TypeError naming neither the task
      // nor the config. Each entry's syntax too: a malformed one (`^`,
      // `a#`) passed `vx lock` and failed the task at hash time, after its
      // upstream ran.
      const taskFilters = (inputs as { tasks?: unknown }).tasks
      if (taskFilters !== undefined) {
        if (
          !Array.isArray(taskFilters) ||
          taskFilters.some((s) => typeof s !== 'string' || s.length === 0)
        ) {
          throw new UserError(
            `${where}.inputs.tasks must be an array of non-empty strings ` +
              `(Turbo/Nx micro-syntax: 'name', '^name', 'pkg#name', '*', '^*', '!name')`,
          )
        }
        for (const raw of taskFilters as string[]) {
          try {
            parseDependencySpec(raw, 'inputs.tasks')
          } catch (err) {
            if (err instanceof DependencySpecError) throw new UserError(`${where}: ${err.message}`)
            throw err
          }
        }
        assertFilterNamesDeclaredDeps(taskFilters, task.dependsOn, where)
      }
      for (const field of ['runtime', 'workspaceRuntime'] as const) {
        const list = (inputs as Record<string, unknown>)[field]
        if (list !== undefined) {
          if (
            !Array.isArray(list) ||
            // Whitespace alone ran as a no-op probe that folds nothing, as
            // a blank `exec.command` did before item 1099 (X-22).
            list.some((s) => typeof s !== 'string' || s.trim() === '' || s.includes('\0'))
          ) {
            throw new UserError(
              `${where}.inputs.${field} must be an array of non-empty shell command strings with no NUL`,
            )
          }
        }
      }
      // workspaceFiles mirror the files validation: non-empty strings,
      // never absolute (they're workspace-root-relative by definition).
      const wsInputs = (inputs as { workspaceFiles?: unknown }).workspaceFiles
      if (wsInputs !== undefined) {
        validateWorkspaceGlobs(wsInputs, `${where}.inputs.workspaceFiles`, true)
      }
    }
    if (cache !== undefined) {
      if (typeof cache !== 'object' || cache === null) {
        throw new UserError(
          `${where}.cache must be an object when present — \`inputs: { files: [...] }, cache: { outputs: { files: [...] } }\`, or no \`cache\` for a task that never caches`,
        )
      }
      assertKnownFields(cache, CACHE_FIELDS, `${where}.cache`)
      const stability = (cache as { inputStability?: unknown }).inputStability
      if (stability !== undefined)
        validateInputStability(stability, `${where}.cache.inputStability`)
      // The key is the task's inputs, and a group runs nothing to cache.
      if (exec === undefined) {
        throw new UserError(
          `${where}: \`cache\` needs \`exec\` — a task with no command produces nothing to cache`,
        )
      }
      if (inputs === undefined) {
        throw new UserError(
          `${where}: \`cache\` needs \`inputs\` — the key is the task's inputs, \`inputs: { files: [...] }\``,
        )
      }
      const outputs = (cache as { outputs?: unknown }).outputs
      if (outputs === undefined || outputs === null) {
        throw new UserError(`${where}.cache.outputs is required when \`cache\` is set`)
      }
      if (typeof outputs !== 'object') {
        throw new UserError(
          `${where}.cache.outputs must be an object — \`outputs: { files: [...] }\``,
        )
      }
      assertKnownFields(outputs, CACHE_OUTPUT_FIELDS, `${where}.cache.outputs`)
      const clean = (outputs as { clean?: unknown }).clean
      if (clean !== undefined && typeof clean !== 'boolean') {
        throw new UserError(`${where}.cache.outputs.clean must be true or false`)
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
        if (isAbsoluteGlob(g)) {
          throw new UserError(
            `${where}.cache.outputs.files: absolute paths are not allowed (got "${g}") — ` +
              `outputs must be project-relative globs`,
          )
        }
        if (hasParentSegment(g)) {
          throw new UserError(
            `${where}.cache.outputs.files: '..' path segments are not allowed (got "${g}") — ` +
              `outputs must stay within the project (vx clears a task's outputs before it runs, ` +
              `so a glob that escapes the project would delete files outside it)`,
          )
        }
        assertPosixGlob(g, `${where}.cache.outputs.files`, 'project')
        assertNoForeignToken(g, `${where}.cache.outputs.files`)
        if (namesDirItself(g)) {
          throw new UserError(
            `${where}.cache.outputs.files: "${g}" names the project directory itself and selects nothing — ` +
              `name the directory the task writes, such as "dist/**"`,
          )
        }
        // An artifact stores workspace outputs under `workspace-outputs/`,
        // and its index read a project output there as one: every hit was
        // a "corrupt artifact", dropped and run again.
        if (!g.startsWith('!') && normalizeGlob(g).split('/')[0] === 'workspace-outputs') {
          throw new UserError(
            `${where}.cache.outputs.files: "${g}" is under workspace-outputs/, a name vx's ` +
              `artifacts reserve for outputs.workspaceFiles — write the task's files to another directory`,
          )
        }
        // A `!` entry takes a path back from the outputs (A-44): it is not
        // cleaned, saved or restored, and it stays an input.
        assertNotDoubleNegated(g, `${where}.cache.outputs.files`)
        // Taken back by a `!`, the file is never cleaned or restored.
        const own = g.startsWith('!')
          ? undefined
          : ownFilesCovered(g, ownConfig).find((f) => !takenBack(outFiles as unknown[], f))
        if (own !== undefined) {
          throw new UserError(
            `${where}.cache.outputs.files: "${g}" covers the project's own ${own} — vx deletes a ` +
              `task's outputs before it runs and restores them on a hit, so the project would lose ` +
              `its config. Name the directory the task writes, such as "dist/**", ` +
              `or take the file back with "!${own}".`,
          )
        }
      }
      assertOutputsNotNegationOnly(outFiles as string[], `${where}.cache.outputs.files`)
      assertNoLiteralTakenBack(outFiles as string[], `${where}.cache.outputs.files`, OUTPUT_LOST)
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
// `tasks` first: `nearest` breaks a tie by order, and `taks` is one edit
// from both.
const PROJECT_FIELDS = new Set(['name', 'tasks', 'tags'])
const TASK_FIELDS = new Set(['description', 'exec', 'dependsOn', 'inputs', 'cache'])
const EXEC_FIELDS = new Set([
  'command',
  'env',
  'timeout',
  'retries',
  'persistent',
  'interactive',
  'remote',
  'sandbox',
  'platforms',
])
const PERSISTENT_FIELDS = new Set(['readyWhen'])
const ENV_FIELDS = new Set(['passThrough', 'define', 'secret'])
const CACHE_FIELDS = new Set(['outputs', 'inputStability'])
const INPUT_FIELDS = new Set([
  'files',
  'workspaceFiles',
  'env',
  'tasks',
  'runtime',
  'workspaceRuntime',
])
const CACHE_OUTPUT_FIELDS = new Set(['files', 'workspaceFiles', 'clean'])

/**
 * Another runner's spelling of a field vx has under another name, by the
 * level that meets it (D-37): a Turbo `outputs: [...]` or Nx `command` on
 * a task was refused as an unknown field that named neither the field
 * nor where vx keeps it.
 */
const FOREIGN_FIELDS: ReadonlyMap<ReadonlySet<string>, Readonly<Record<string, string>>> = new Map([
  [
    TASK_FIELDS,
    {
      outputs: '`cache.outputs.files`',
      env: '`inputs.env` (to key the task on a variable) or `exec.env` (to pass one)',
      passThroughEnv: '`exec.env.passThrough`',
      command: '`exec.command`',
      cmd: '`exec.command`',
      script: '`exec.command`',
      persistent: '`exec.persistent: {}`',
      // Nx's target keys (project.json) and Turbo's `outputLogs`.
      continuous: '`exec.persistent: {}`',
      executor:
        '`exec.command`: vx runs one shell command (`nx()` from `@vzn/vx-migrate` runs an Nx executor as one)',
      options: '`exec.command` (a run-commands `options.command`) and `exec.env`',
      outputLogs: 'the `--output-logs` flag of `vx run`',
      // Turbo's `interactive` / `with`, Nx's `cwd` / `parallelism` /
      // `configurations`: refused with no word on where they went (D-89).
      interactive: '`exec.interactive: true`',
      with: '`dependsOn` on each task it runs beside: a persistent one stays up, and this task starts once it is ready',
      cwd: '`cd <dir> && …` in `exec.command`: a task runs in its project directory',
      parallelism:
        '`run.concurrency: 1` in .vx/workspace or `--concurrency 1` on the run: no task runs alone beside others',
      configurations:
        'one task per configuration (`build:production`, with its own `exec.command`)',
    },
  ],
  [
    EXEC_FIELDS,
    {
      cmd: '`command`',
      script: '`command`',
      // Nx run-commands' options and shell-runner habits, refused with no
      // word on where they go (D-100).
      cwd: '`cd <dir> && …` in `command`: a task runs in its project directory',
      args: 'the arguments written into `command`, or after `--` on `vx run`',
      commands: 'one `command` (`a && b`, or `a & b; wait` to run them at once), or one task each',
      parallel: 'one task each, which vx runs at once, or `a & b; wait` in `command`',
      shell: 'no field: `command` always runs in a shell',
    },
  ],
  // wireit's `files` / `output` and include-style spellings written into
  // a cache block, refused with no word on where they go (D-118).
  [
    CACHE_FIELDS,
    {
      files: "the task's `inputs.files`",
      output: '`outputs.files`',
      env: "the task's `inputs.env`",
      dependencies: "the task's `dependsOn` (an upstream's key folds into this one)",
      enabled: 'no field: a task with a `cache` block caches, one without runs every time',
    },
  ],
  [
    INPUT_FIELDS,
    {
      globs: '`files`',
      include: '`files`',
      patterns: '`files`',
      exclude: "`files` with a `!` entry (`'!**/*.test.ts'`)",
      ignore: "`files` with a `!` entry (`'!**/*.test.ts'`)",
    },
  ],
  [
    CACHE_OUTPUT_FIELDS,
    {
      globs: '`files`',
      include: '`files`',
      exclude: "`files` with a `!` entry (`'!dist/cache/**'`)",
    },
  ],
  // A package's turbo.json and Nx's project.json keys, written into a
  // project's vx.config (D-56).
  [
    PROJECT_FIELDS,
    {
      targets: '`tasks` (a target is a task: `exec.command`, `dependsOn`, `cache`)',
      extends: 'an imported module spread into `tasks` (a vx.config is code; nothing is inherited)',
      implicitDependencies: 'a `dependsOn` entry `pkg#task`, or a package.json dependency',
      // A package.json's, turbo.json's and project.json's keys, and a
      // task's fields one level too high (D-99).
      scripts:
        "`tasks` (a script is a task's `exec.command`; `vx init` writes them from package.json)",
      pipeline: '`tasks` (`bunx @vzn/vx-migrate` writes them from turbo.json)',
      namedInputs: 'a module the vx.config imports, spread into `inputs.files`',
      root: "no field: a project's directory is where its vx.config sits",
      sourceRoot: "a task's `inputs.files`",
      projectType: 'no field: vx runs every project alike',
      ...Object.fromEntries(
        ['dependsOn', 'inputs', 'cache', 'exec', 'description'].map((k) => [
          k,
          `\`tasks.<name>.${k}\`: a project holds tasks, and each task its own \`${k}\``,
        ]),
      ),
      outputs: '`tasks.<name>.cache.outputs.files`',
      env: '`tasks.<name>.inputs.env` (to key a task on it) or `tasks.<name>.exec.env`',
    },
  ],
  // Turbo's turbo.json and Nx's nx.json keys, written into .vx/workspace
  // (D-38).
  [
    WORKSPACE_FIELDS,
    {
      pipeline:
        "each package's `vx.config` `tasks` (`bunx @vzn/vx-migrate` writes them from turbo.json)",
      tasks:
        "each package's `vx.config` `tasks` (`bunx @vzn/vx-migrate` writes them from turbo.json)",
      targetDefaults:
        "each package's `vx.config` `tasks`, sharing defaults through an imported module",
      namedInputs: 'a module each `vx.config` imports, spread into `inputs.files`',
      globalEnv: '`inputs.env` on the tasks it keys',
      globalDependencies: '`inputs.workspaceFiles` on the tasks it keys',
      remoteCache:
        'a cache plugin in `plugins` (`turboCache()` or `nxCache()` from `@vzn/vx-migrate`)',
      parallel: '`run.concurrency`',
      cacheDirectory: '`cache.dir`',
      defaultBase: '`baseBranch`',
      tasksRunnerOptions: 'a cache plugin in `plugins` (`nxCache()` from `@vzn/vx-migrate`)',
      globalPassThroughEnv: '`exec.env.passThrough` on the tasks it passes to',
      // pnpm-workspace.yaml's, Lerna's and the package.json's own keys
      // pasted into .vx/workspace: refused with no word on where vx reads
      // them (D-98).
      packages: 'a `vx.config` in each project directory: a project is a directory holding one',
      workspaces: 'a `vx.config` in each project directory: a project is a directory holding one',
      projects: 'a `vx.config` in each project directory: a project is a directory holding one',
      ignore:
        "no field: a directory with no `vx.config` is no project, and git's ignore rules apply",
      catalog:
        "pnpm-workspace.yaml's or package.json's `catalog`, where the package manager reads it",
      npmClient: "no field: a task's command runs as written, with no package manager in between",
      remote: 'a cache plugin in `plugins`',
      env: '`inputs.env` on the tasks it keys, or `exec.env` on the tasks it passes to',
    },
  ],
])

/**
 * A top-level typo of a grouped setting, as its path: by its last name
 * (`concurency`) or its path run together (`cachedir`).
 */
function nearestSetting(key: string): string | undefined {
  const byName = new Map<string, string>()
  for (const s of SETTINGS) {
    if (s.config === false) continue
    const parts = s.path.split('.')
    byName.set(parts.at(-1)!, s.path)
    byName.set(
      parts.map((p, i) => (i === 0 ? p : p[0]!.toUpperCase() + p.slice(1))).join(''),
      s.path,
    )
  }
  const name = nearest(key, byName.keys())
  return name === undefined ? undefined : `\`${byName.get(name)}\``
}

/**
 * Where a field one level down lives: `retries`, `timeout` or `sandbox` on
 * a task, beside `exec` rather than in it, was refused with the task's
 * fields alone, none of which is it.
 */
function nestedHome(allowed: ReadonlySet<string>, key: string): string | undefined {
  if (allowed !== TASK_FIELDS) return undefined
  for (const [field, own] of [
    ['exec', EXEC_FIELDS],
    ['inputs', INPUT_FIELDS],
    ['cache', CACHE_FIELDS],
  ] as const) {
    if (own.has(key)) return `\`${field}.${key}\``
  }
  return undefined
}

function assertKnownFields(value: object, allowed: ReadonlySet<string>, where: string): void {
  // `typeof [] === 'object'`, so an array reaches here and its indices read
  // as fields: `outputs: ['dist/**']` (Turbo's spelling) was refused as
  // `unknown field "0"`. Name the shape instead, and the one meant.
  if (Array.isArray(value)) {
    throw new UserError(
      `${where} must be an object (fields: ${[...allowed].sort().join(', ')}), not an array` +
        (allowed.has('files') ? ' — did you mean `{ files: [...] }`?' : ''),
    )
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      // The nearest accepted spelling first: the list says what the level
      // takes, the hint says which one was meant.
      const foreign = FOREIGN_FIELDS.get(allowed)?.[key] ?? nestedHome(allowed, key)
      const near =
        nearest(key, allowed) ?? (allowed === WORKSPACE_FIELDS ? nearestSetting(key) : undefined)
      throw new UserError(
        `${where} has unknown field "${key}" (allowed: ${[...allowed].sort().join(', ')})` +
          (foreign !== undefined
            ? ` — vx spells it ${foreign}`
            : near === undefined
              ? ''
              : ` — did you mean ${near}?`),
      )
    }
  }
}

/**
 * The project's config file if an output glob would take it. `outputs:
 * ['**']` loaded, and the clean before the run deleted the project's
 * source and `vx.config` while the run reported success (item 1002); the
 * message for `'.'` had even suggested `**`. Core names no other project
 * file: a file a plugin keys on is an input, and an output takes it out of
 * the input set like any other.
 */
function ownFilesCovered(glob: string, ownConfig: string | null): string[] {
  if (ownConfig === null) return []
  const own = path.basename(ownConfig)
  return new Bun.Glob(normalizeGlob(glob)).match(own) ? [own] : []
}

function takenBack(globs: readonly unknown[], file: string): boolean {
  return globs.some(
    (n) =>
      typeof n === 'string' &&
      n.startsWith('!') &&
      new Bun.Glob(normalizeGlob(n.slice(1))).match(file),
  )
}

/**
 * Turbo's and Nx's glob tokens, pasted from turbo.json or project.json
 * (D-50). vx expands none of them, so each is a literal that matches no
 * file: an input list of `$TURBO_DEFAULT$` keyed the task on nothing and
 * replayed a stale output after its source changed.
 */
const FOREIGN_TOKENS: readonly (readonly [string, string])[] = [
  [
    '$TURBO_DEFAULT$',
    'Turbo\'s default input set, which vx does not have — list the files, such as "**" for everything in the project',
  ],
  [
    '$TURBO_ROOT$',
    "Turbo's workspace root — name the path without it in `workspaceFiles`, which is workspace-root-relative",
  ],
  ['{projectRoot}', "Nx's project root — drop it: `files` globs are project-relative already"],
  [
    '{options.',
    'an Nx target option, which vx does not interpolate — write the path the option names',
  ],
  ['{projectName}', "Nx's project name, which vx does not interpolate — write the name"],
  [
    '{workspaceRoot}',
    "Nx's workspace root — name the path without it in `workspaceFiles`, which is workspace-root-relative",
  ],
]

function assertNoForeignToken(glob: string, where: string): void {
  // `^production`: Nx's named input of the dependencies (D-51). No file
  // starts with `^` in practice, while a bare `default` can be a directory,
  // so only the upstream form is refused; the bare one keeps the warning.
  if ((glob.startsWith('!') ? glob.slice(1) : glob).startsWith('^')) {
    throw new UserError(
      `${where}: "${glob}" starts with ^, Nx's named input of the dependencies — vx keys a task on its dependencies through \`dependsOn\` (\`^build\`); list this project's files here`,
    )
  }
  for (const [token, meaning] of FOREIGN_TOKENS) {
    if (glob.includes(token)) {
      const shown = token.endsWith('.') ? `${token}…}` : token
      throw new UserError(`${where}: "${glob}" holds ${shown}, ${meaning}`)
    }
  }
  // A leading `!` is vx's negation, so `!(group)/**` takes back a route group.
  const body = glob.startsWith('!') ? glob.slice(1) : glob
  const at = body.search(EXTGLOB)
  if (at !== -1) {
    // `@(a|b)` of plain names is exactly `{a,b}`, and `@(a)` is `a`.
    const group =
      body[at - 1] === '\\' ? null : /^@\(([^()|]+(?:\|[^()|]+)*)\)/.exec(body.slice(at))
    const names = group === null ? [] : group[1]!.split('|')
    const rewrite =
      group === null || BUN_GLOB_WILDCARDS.test(group[1]!)
        ? 'braces ("{a,b}") or one entry per alternative'
        : `"${glob.replace(group[0], names.length === 1 ? names[0]! : `{${names.join(',')}}`)}"`
    throw new UserError(
      `${where}: "${glob}" is an extglob, which vx's glob engine reads as literal text or a ` +
        `plain wildcard, never as the alternatives it lists, so the cache key would miss the ` +
        `files it names. Write ${rewrite} instead.`,
    )
  }
  assertNoBareGroup(glob, body, where)
  assertNoBraceRange(glob, where)
  assertNoGluedGlobstar(glob, where)
}

/**
 * `Bun.Glob` reads `**` glued to other text (`src/**.ts`, `a**`) as `*`, one
 * level: deeper inputs left the key and deeper outputs were never saved.
 * Turbo rewrites it to the deep reading (vercel/turborepo#5431); vx refuses
 * and names both.
 */
function assertNoGluedGlobstar(glob: string, where: string): void {
  const body = glob.startsWith('!') ? glob.slice(1) : glob
  if (!body.split(/[/{},]/).some((seg) => seg.includes('**') && /[^*]/.test(seg))) return
  const deep = glob.replace(/\*\*([^*/{},]+)/g, '**/*$1').replace(/([^*/{},]+)\*\*/g, '$1*/**')
  const one = glob.replace(/\*{2,}/g, (run, at: number) =>
    /[^*/{},]/.test(glob[at - 1] ?? '') || /[^*/{},]/.test(glob[at + run.length] ?? '') ? '*' : run,
  )
  throw new UserError(
    `${where}: "${glob}" glues ** to other text in one path segment, which vx's glob engine ` +
      `reads as one *, a single directory level. Write "${deep}" for every depth, or "${one}" ` +
      `for one level.`,
  )
}

/** `(a|b)` with no extglob sigil: `Bun.Glob` reads parens and `|` as literal text. */
const BARE_GROUP = /(?<!\\)\(([^()|]*(?:\|[^()|]*)+)\)/

function assertNoBareGroup(glob: string, body: string, where: string): void {
  const group = BARE_GROUP.exec(body)
  if (group === null) return
  const names = group[1]!.split('|')
  const rewrite = BUN_GLOB_WILDCARDS.test(group[1]!)
    ? 'braces ("{a,b}") or one entry per alternative'
    : `"${glob.replace(group[0], `{${names.join(',')}}`)}"`
  throw new UserError(
    `${where}: "${glob}" holds a bare (…|…) group, which vx's glob engine reads as literal ` +
      `text, never as the alternatives it lists, so the cache key would miss the files it ` +
      `names. Write ${rewrite} instead.`,
  )
}

const BRACE_RANGE = /(?<!\\)\{(-?\d+|[a-zA-Z])\.\.(-?\d+|[a-zA-Z])(\.\.-?\d+)?\}/g

/**
 * A range vx expands is any task glob's (`braceRange`). One it does not —
 * mixed case, or past the limit — `Bun.Glob` would still read, so the
 * readings would differ by engine: refused.
 */
function assertNoBraceRange(glob: string, where: string): void {
  // Every range, not the first: `a{1..2}{A..c}` held one vx reads past.
  const m = [...glob.matchAll(BRACE_RANGE)].find((r) => braceRange(r[0].slice(1, -1)) === null)
  if (m === undefined) return
  throw new UserError(
    `${where}: "${glob}" holds the brace range ${m[0]}, which vx expands only within one case ` +
      `and up to ${BRACE_RANGE_LIMIT} names. Write a smaller range or a comma brace.`,
  )
}

/**
 * `.`, `./`, `././` (with or without a `!`) name the directory itself, which
 * no matcher expands: the entry selected nothing and said so nowhere.
 * `./src/**
 * Turbo's `!NAME` takes a name back out of a wildcard (`env`,
 * `passThroughEnv`). vx has no wildcards, so the entry was a variable
 * named `!NAME`: nothing excluded, nothing said (D-53).
 */
function assertNoEnvNegation(names: readonly string[], where: string): void {
  const neg = names.find((n) => n.startsWith('!'))
  if (neg !== undefined) {
    throw new UserError(
      `${where}: "${neg}" is Turbo's exclusion from a wildcard — vx lists names explicitly, so leave ${neg.slice(1)} out`,
    )
  }
}

/**` is fine — the resolver strips the `./` (`normalizeGlob`).
 */
function namesDirItself(glob: string): boolean {
  const g = normalizeGlob(glob.startsWith('!') ? glob.slice(1) : glob)
  return g === '' || g === '/'
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
function hasParentSegment(glob: string): boolean {
  const g = glob.startsWith('!') ? glob.slice(1) : glob
  // A brace alternative is a segment too: `{../shared,src}/**` splits on `/`
  // into `{..`, so it passed, and its `..` arm matched nothing — an input
  // that silently left the key (M-64).
  return g.split(/[/{},]/).some((seg) => seg === '..')
}

/**
 * True when a glob is absolute, or a brace alternative in it is:
 * `{/etc,dist}/*` matched nothing outside and said so nowhere (M-64).
 */
function isAbsoluteGlob(glob: string): boolean {
  const g = glob.startsWith('!') ? glob.slice(1) : glob
  return g.startsWith('/') || (g.includes('{') && /[{,]\//.test(g))
}

const DRIVE = /(^|[{,])[A-Za-z]:[\\/]+/g

/**
 * True when a backslash in the glob is a Windows separator. One before a
 * bracket, a brace, a `!` or a backslash is an escape (`app/\[id\]`,
 * `\{b\}`); one before anything else is a separator — `a\*b` reads as
 * `a/*b` on Windows far more often than as a file named with a star, which
 * `a?b` still selects.
 */
function hasBackslashSeparator(body: string): boolean {
  for (let i = body.indexOf('\\'); i !== -1; i = body.indexOf('\\', i + 2)) {
    if (!'[]{}!\\'.includes(body[i + 1] ?? '/')) return true
  }
  return false
}

/**
 * A Windows spelling (`src\**`, `C:/src/**`) loaded with only a "matched no
 * files" warning, and a task keyed on it never saw its source (X-67).
 */
function assertPosixGlob(glob: string, where: string, base: string): void {
  const neg = glob.startsWith('!') ? '!' : ''
  const body = glob.slice(neg.length)
  DRIVE.lastIndex = 0
  const drive = DRIVE.test(body)
  if (!drive && !hasBackslashSeparator(body)) return
  const write = neg + body.replace(DRIVE, '$1').replace(/\\(?![[\]{}!\\])/g, '/')
  throw new UserError(
    `${where}: "${glob}" ${drive ? 'starts with a Windows drive' : 'uses a backslash as a path separator'} — ` +
      `task globs are ${base}-relative with forward slashes: write "${write}"`,
  )
}

const ONE_ALTERNATIVE_BRACE = /(?<!\\)\{[^{},]*\}/g

/**
 * What every run would refuse, or silently key nothing for, refused at
 * `vx lock` instead. `Bun.Glob` reads `{b}` as a brace of one alternative,
 * so `src/{b}.ts` matches `src/b.ts` and never a file named `{b}.ts`:
 * neither reading is sure to be the one meant, so both spellings are
 * named. A path under `.git` is never listed by git, so it keyed nothing.
 */
function assertInputGlob(glob: string, where: string): void {
  // A range is a brace vx expands (`braceRange`), not one alternative.
  const m = [...glob.matchAll(ONE_ALTERNATIVE_BRACE)].find(
    (b) => braceRange(b[0].slice(1, -1)) === null,
  )
  if (m !== undefined) {
    const inner = m[0].slice(1, -1)
    throw new UserError(
      `${where}: "${glob}" holds a brace with one alternative, which matches ` +
        `"${inner}" and never a name holding "${m[0]}". Write "${glob.replace(m[0], inner)}", ` +
        `or "${glob.replace(m[0], `\\{${inner}\\}`)}" for the braces themselves.`,
    )
  }
  if (glob.replace(/^!/, '').split('/').includes('.git')) {
    throw new UserError(
      `${where}: "${glob}" names a path under .git, which git never lists, so it keys nothing — ` +
        `inputs are the repository's files`,
    )
  }
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
      `keeps only that. Use ${JSON.stringify(`!${inner}`)} to subtract it, or ` +
      `${JSON.stringify(inner)} to include it.`,
  )
}

/**
 * An exact `inputs.tasks` entry that no `dependsOn` entry names would
 * match nothing at hash time and fold no upstream hash — the task silently
 * decoupled from its dependencies, which is a stale hit waiting for the
 * next upstream change. `['buidl']` for `['build']` is the shape. Patterns,
 * wildcards and negations stay silent (a preset-spread pattern legitimately
 * matches nothing in some projects; excluding what is absent is harmless);
 * an exact name must be named by some `dependsOn` entry of a form that can
 * reach the same node, exactly or by that entry's own `*` pattern. The form
 * matters: `build` selects this project's `build` and `^build` only other
 * projects', so `['build']` against `dependsOn: ['^build']` folded nothing
 * and served a stale hit (item 994). A `pkg#task` entry may name this
 * project or a dependency, which the schema cannot tell apart, so it pairs
 * with any form whose task half matches. `[]` is the explicit way to
 * decouple.
 */
function assertFilterNamesDeclaredDeps(
  filters: readonly string[],
  dependsOn: readonly string[] | undefined,
  where: string,
): void {
  const declared = (dependsOn ?? []).map(specForm)
  const matches = (pattern: string, name: string): boolean =>
    pattern.includes('*') ? compileNameGlob(pattern).test(name) : pattern === name
  const named = (f: SpecForm): boolean =>
    declared.some((d) => {
      if (!matches(d.task, f.task)) return false
      if (d.form === 'cross' && f.form === 'cross') {
        return f.project.includes('*') || matches(d.project, f.project)
      }
      return d.form === f.form || d.form === 'cross' || f.form === 'cross'
    })
  for (const raw of filters) {
    // `*` and `^*` need no arm of their own: their task half is `*`, which
    // the wildcard skip below takes (item 678).
    if (raw.startsWith('!')) continue
    const f = specForm(raw)
    if (f.task.includes('*') || named(f)) continue
    // `where` opens with the config's path; the message names it once.
    const task = where.slice(where.lastIndexOf(': tasks.') + 2)
    throw new UserError(
      `${where}.inputs.tasks: "${raw}" names no task in ${task}.dependsOn ` +
        `(${declared.length === 0 ? 'none declared' : dependsOn!.map((d) => `'${d}'`).join(', ')}) — ` +
        `it would match nothing and fold no upstream hash, decoupling the task from its ` +
        `dependencies. \`name\` is this project's task, \`^name\` its dependencies', ` +
        `\`pkg#name\` one project's. Fix the name, or use [] to decouple on purpose.`,
    )
  }
}

type SpecForm =
  | { form: 'self' | 'deps'; task: string }
  | { form: 'cross'; project: string; task: string }

/** A `dependsOn` / filter entry's form, as `parseDependencySpec` splits it. */
function specForm(spec: string): SpecForm {
  if (spec.startsWith('^')) return { form: 'deps', task: spec.slice(1) }
  const hash = spec.indexOf('#')
  if (hash === -1) return { form: 'self', task: spec }
  return { form: 'cross', project: spec.slice(0, hash), task: spec.slice(hash + 1) }
}

/**
 * A name an environment can hold. An `=` splits at the first one, so
 * `define: { 'A=B': 'x' }` gave the child `A` with the value `B=x`; `''`
 * was dropped; a NUL failed the spawn with a hint about exit 127 (item
 * 999). And the task runs under `sh -c`, whose dash (Linux) drops a
 * variable whose name is no shell identifier: `my.var` reached a task
 * under macOS's bash and nothing on Linux. Refused at load, where the
 * config is named.
 */
function assertShellName(name: string, field: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new UserError(
      `${field}: ${JSON.stringify(name)} is not a shell variable name ([A-Za-z_][A-Za-z0-9_]*); sh would drop it before the task runs`,
    )
  }
}

function isEnvName(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && !name.includes('=') && !name.includes('\0')
}

/**
 * A task name `dependsOn`, `inputs.tasks` and the CLI can name. Each
 * refused shape loaded and could not be referenced: `x#y` read as project
 * `x`, `^gen` as every dependency's `gen`, a `*` as a pattern, `''` ran
 * under `--all` as `a#` and `vx run a#` refused it, and a padded name was
 * trimmed away by the reader (item 1000).
 */
function assertTaskName(name: string, configPath: string): void {
  const why = taskNameProblem(name)
  if (why === null) return
  throw new UserError(
    `${configPath}: task name ${JSON.stringify(name)} ${why} — dependsOn, inputs.tasks and ` +
      `the CLI could not name it. Rename the task.`,
  )
}

/** Why `name` cannot be a task name, or null; `vx init` skips such a script (item 1033). */
export function taskNameProblem(name: string): string | null {
  return name.trim().length === 0
    ? 'is empty'
    : name.trim() !== name
      ? 'has surrounding whitespace'
      : name.includes('#')
        ? "holds '#', which separates a project from its task"
        : name.includes('*')
          ? "holds '*', which makes it a pattern"
          : name.startsWith('^') || name.startsWith('!')
            ? `starts with '${name[0]}', which names dependencies' tasks or negates`
            : null
}

/**
 * Why `--filter tag:<tag>` cannot name `tag`, or null. Asked of the filter
 * parser itself, so a suffix it learns to read is refused here too: `v1...`
 * read as a dependency walk from `v1`, `v[2]` as `v` changed since ref `2`.
 */
function tagProblem(tag: string): string | null {
  if (tag.trim() !== tag) return 'has surrounding whitespace'
  if (tag.includes('*')) return "holds '*', which makes it a pattern"
  const walk = "ends in '...', which a filter reads as a dependency walk"
  let f: ReturnType<typeof parseFilter>
  try {
    f = parseFilter(`tag:${tag}`, '/')
  } catch {
    // `...` alone: the walk leaves the filter no tag, and its refusal
    // named neither the config nor the tag.
    return walk
  }
  if (f.gitSince !== undefined) {
    return `ends in "[${f.gitSince}]", which a filter reads as a git range`
  }
  if (f.withDeps || f.onlyDeps) return walk
  return null
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
 * A `!` entry subtracts wherever it sits in the list, so a file named
 * outright after it (`['src/**', '!src/gen/**', 'src/gen/keep.ts']`) never
 * entered the key, and an edit to it replayed the old output. Refusing is
 * free: the literal already selected nothing.
 */
function assertNoLiteralTakenBack(
  globs: readonly string[],
  where: string,
  // An output's literal is never saved: a hit left it missing and said up-to-date.
  lost = 'the file never enters the key',
): void {
  const negative = globs.filter((g) => g.startsWith('!')).map((g) => g.slice(1))
  if (negative.length === 0) return
  const taken = anyTaskGlob(asTrees(negative))
  for (const g of globs) {
    if (g.startsWith('!')) continue
    const lit = normalizeGlob(g).replace(/\/+$/, '')
    if (!isLiteralPattern(lit) || !taken(lit)) continue
    const by = negative.find((n) => anyTaskGlob(asTrees([n]))(lit))
    throw new UserError(
      `${where}: "${g}" is taken back by "!${by}" — a \`!\` entry subtracts wherever it sits in ` +
        `the list, so ${lost}. Narrow the negation so it leaves "${g}".`,
    )
  }
}

/**
 * `negation: false` for OUTPUT globs: a `!` entry takes a path back (A-44),
 * and a list of only negations selects nothing and is refused.
 */
function validateWorkspaceGlobs(v: unknown, where: string, negation: boolean): void {
  if (!Array.isArray(v)) {
    throw new UserError(`${where} must be an array of glob strings`)
  }
  for (const g of v as unknown[]) {
    if (typeof g !== 'string' || g.length === 0) {
      throw new UserError(`${where} must be an array of non-empty strings`)
    }
    if (isAbsoluteGlob(g)) {
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
    assertPosixGlob(g, where, 'workspace-root')
    assertNoForeignToken(g, where)
    if (negation) assertInputGlob(g, where)
    if (namesDirItself(g)) {
      throw new UserError(
        `${where}: "${g}" names the workspace root itself and selects nothing — use "**" for everything under it`,
      )
    }
    assertNotDoubleNegated(g, where)
  }
  if (negation) {
    assertNotNegationOnly(v as string[], where)
    assertNoLiteralTakenBack(v as string[], where)
  } else {
    assertOutputsNotNegationOnly(v as string[], where)
    assertNoLiteralTakenBack(v as string[], where, OUTPUT_LOST)
  }
}

/**
 * An output list of only `!` entries selects nothing: the task saves and
 * restores nothing while it reads as if it declared outputs (A-44).
 */
const OUTPUT_LOST = 'the file is never saved or restored'

function assertOutputsNotNegationOnly(globs: readonly string[], where: string): void {
  if (globs.length === 0 || globs.some((g) => !g.startsWith('!'))) return
  throw new UserError(
    `${where}: every entry is a negation, which selects NOTHING (got ${JSON.stringify(globs)}) — ` +
      `a '!' entry only takes back what a positive glob selected. Add the outputs the task ` +
      `produces, e.g. ['dist/**', ${JSON.stringify(globs[0])}], or declare [] for none.`,
  )
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
const IGNORE_FIELDS = new Set(['read', 'write', 'systemInfo', 'network'])

function assertStringArray(v: unknown, where: string): void {
  if (!Array.isArray(v) || v.some((s) => typeof s !== 'string' || s.length === 0)) {
    throw new UserError(`${where} must be an array of non-empty strings`)
  }
  // No path, host or name holds a NUL; a write grant with one reached the
  // placeholder create as an internal error.
  const nul = (v as string[]).find((s) => s.includes('\0'))
  if (nul !== undefined) {
    throw new UserError(`${where}: ${JSON.stringify(nul)} holds a NUL byte`)
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
    // Only these reach the report's filter (`matchesIgnore`): a denial is
    // classed read, write, systemInfo or network, and nothing else. Every
    // grant name loaded here once, so `ignore.machLookup` silenced nothing
    // and said so nowhere (D-4).
    assertKnownFields(ignore, IGNORE_FIELDS, `${where}.sandbox.ignore`)
    const g = ignore as Record<string, unknown>
    // Patterns, not prefixes — `ignore` is vx's own filter over lines it
    // already holds, so a glob costs nothing and works on every platform.
    for (const f of IGNORE_FIELDS) {
      if (g[f] !== undefined) assertStringArray(g[f], `${where}.sandbox.ignore.${f}`)
    }
  }
}
