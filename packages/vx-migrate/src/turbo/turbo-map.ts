// Turbo → vx mapping, the pure half. Reads turbo.json (`tasks` in turbo 2,
// `pipeline` in turbo 1), per-package turbo.json overlays and each package's
// scripts, and emits one TaskConfig-shaped object per (package, task) — a
// task exists for a package only when the package declares the script,
// turbo's own rule. Two consumers, one mapper, so they cannot drift:
//   - `@vzn/vx-migrate` renders these to vx.config.ts files, splicing
//     turbo's global fields in as imports of a generated preset;
//   - `@vzn/vx-migrate` hands them to the `project` stage live, with the
//     global values inlined, so a Turbo repo runs under vx with no file
//     written.
// The consumer decides what a global becomes through `splice`.

import path from 'node:path'
import { isLiteralPattern, type ProjectMeta, UserError } from '@vzn/vx'
import { minimatchToVx } from '../glob-grammar.js'
import { shellQuote } from '../nx-command.js'
import { scriptCommand, yarnPnp } from '../script-command.js'
import { resolveSharedOutputs, takingBack } from '../shared-outputs.js'
import { packageScripts, relPosix } from '../paths.js'
import { pruneOrphanPersistentNotes } from '../persistent-note.js'

/** `path.relative` with forward slashes — the shape an ESM specifier or a report line needs. */
interface TurboTask {
  dependsOn?: string[]
  inputs?: string[]
  outputs?: string[]
  env?: string[]
  passThroughEnv?: string[]
  cache?: boolean
  persistent?: boolean
  [key: string]: unknown
}

interface TurboJson {
  tasks?: Record<string, TurboTask>
  pipeline?: Record<string, TurboTask>
  globalDependencies?: string[]
  globalEnv?: string[]
  globalPassThroughEnv?: string[]
  /** Turbo 1.10–1.13: root-relative `.env` files every task hashes. */
  globalDotEnv?: string[]
  /** A package config's parents: `//` (the root) first, then packages by name. */
  extends?: string[]
  /** Turbo 2.11 `futureFlags.globalConfiguration`: the global lists live here. */
  global?: { inputs?: string[]; env?: string[]; passThroughEnv?: string[]; envMode?: unknown }
  envMode?: unknown
}

const KNOWN_TASK_KEYS = new Set([
  'dependsOn',
  'inputs',
  'outputs',
  'env',
  'passThroughEnv',
  'cache',
  'persistent',
  'extends',
  'outputLogs',
  'dotEnv',
  'command',
  'description',
])

// Turbo's per-task `outputLogs` against vx's per-run `--output-logs`.
// `new-only` — frames for the tasks that ran, a one-liner per cache hit —
// is what vx's default flow already does, so the most common value in
// the wild (every Vercel template) maps to nothing and warns about
// nothing. The other values have no per-task knob in vx; the todo names
// the run flag that carries them.
const OUTPUT_LOGS_DEFAULT = 'new-only'
const OUTPUT_LOGS_RUN_FLAG = new Set(['full', 'hash-only', 'errors-only', 'none'])

// Turbo 2's framework inference: a package that depends on one of these
// has every variable with the prefix hashed into its tasks and passed to
// them, with nothing in turbo.json saying so. vx env names are explicit,
// so the variables were stripped in silence and a build that inlines them
// (Next's `NEXT_PUBLIC_*`) read empty values (item 940). Named in a note;
// only the frameworks whose prefix is certain are listed.
const FRAMEWORK_ENV: ReadonlyArray<readonly [dependency: string, prefixes: string]> = [
  ['next', 'NEXT_PUBLIC_*'],
  ['vite', 'VITE_*'],
  ['react-scripts', 'REACT_APP_*'],
  ['gatsby', 'GATSBY_*'],
  ['astro', 'PUBLIC_*'],
]

/** The three global fields of turbo.json a task may draw on. */
export type TurboGlobal = 'inputs' | 'env' | 'pass'

export interface TurboMappedTask {
  name: string
  /** What did not map, in the words the migration report prints. */
  todos: string[]
  /** TaskConfig-shaped, with whatever `splice` put in its arrays; null when the
   *  target has no vx representation (the todos say why). */
  task: Record<string, unknown> | null
  /** Which globals `task` draws on — the renderer imports exactly these. */
  uses: ReadonlySet<TurboGlobal>
}

export interface TurboMappedProject {
  name: string
  dir: string
  tasks: TurboMappedTask[]
}

export interface TurboMapping {
  projects: TurboMappedProject[]
  /** Report lines about what the workspace holds that vx has no place for. */
  notes: string[]
  globals: { inputs: string[]; env: string[]; pass: string[] }
}

export interface MapTurboOptions {
  /**
   * What a task's array holds for one global field: `vx migrate` splices a
   * preset import (`{ raw: '...globalInputs' }`), the plugin the values
   * themselves. Called only for a global that is non-empty.
   */
  splice(kind: TurboGlobal, values: readonly string[]): readonly unknown[]
  /** The TODO attached to a persistent task, in the consumer's words. */
  persistentTodo: string
}

/**
 * A directory's Turbo config: `turbo.json`, else `turbo.jsonc` (Turbo 2.5+
 * reads either). Only `turbo.json` was looked for, so a `turbo.jsonc` root
 * failed the run with ENOENT and a package's `turbo.jsonc` overlay was
 * skipped in silence — its `inputs` then keyed nothing (item 938).
 */
export async function turboConfigFile(dir: string): Promise<string | null> {
  for (const name of ['turbo.json', 'turbo.jsonc']) {
    const file = path.join(dir, name)
    if (await Bun.file(file).exists()) return file
  }
  return null
}

async function readTurboJson(file: string, root: string): Promise<TurboJson> {
  const text = await Bun.file(file).text()
  let parsed: unknown
  try {
    // turbo.json allows comments + trailing commas.
    parsed = Bun.JSONC.parse(text) ?? {}
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new UserError(`failed to parse ${relPosix(root, file)}: ${msg}`)
  }
  checkTurboShape(parsed, relPosix(root, file))
  return parsed as TurboJson
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const TOP_LISTS = [
  'globalDependencies',
  'globalEnv',
  'globalPassThroughEnv',
  'globalDotEnv',
  'extends',
]
const GLOBAL_LISTS = ['inputs', 'env', 'passThroughEnv']
const TASK_LISTS = ['dependsOn', 'outputs', 'env', 'passThroughEnv', 'with', 'dotEnv']
const TASK_FLAGS = ['cache', 'persistent', 'interactive']

/**
 * The shape of every field the mapper reads, refused by name. A number
 * where turbo.json holds a list reached the mapper's loops: `"dependsOn":
 * true` printed `TypeError: true is not iterable` with its stack from
 * `bunx @vzn/vx-migrate` (fuzzed, L-15). Turbo refuses the same file.
 */
function checkTurboShape(cfg: unknown, label: string): void {
  const refuse = (at: string, what: string): never => {
    throw new UserError(`${label}: ${at} must be ${what}`)
  }
  const list = (v: unknown, at: string): void => {
    if (v !== undefined && (!Array.isArray(v) || v.some((x) => typeof x !== 'string')))
      refuse(at, 'an array of strings')
  }
  if (!isRecord(cfg)) refuse('the file', 'a JSON object')
  const c = cfg as Record<string, unknown>
  for (const k of TOP_LISTS) list(c[k], k)
  if (c['global'] !== undefined) {
    if (!isRecord(c['global'])) refuse('global', 'an object')
    for (const k of GLOBAL_LISTS) list((c['global'] as Record<string, unknown>)[k], `global.${k}`)
  }
  for (const field of ['tasks', 'pipeline']) {
    const tasks = c[field]
    if (tasks === undefined) continue
    if (!isRecord(tasks)) refuse(field, 'an object of tasks')
    for (const [name, def] of Object.entries(tasks as Record<string, unknown>)) {
      const at = `${field}.${JSON.stringify(name)}`
      if (!isRecord(def)) refuse(at, 'an object')
      const d = def as Record<string, unknown>
      for (const k of TASK_LISTS) list(d[k], `${at}.${k}`)
      // Turbo 2.11 adds `{ mode, globs, withDefaults }` entries (`flatInputs`).
      const inputs = d['inputs']
      if (
        inputs !== undefined &&
        (!Array.isArray(inputs) || inputs.some((x) => typeof x !== 'string' && !isRecord(x)))
      )
        refuse(`${at}.inputs`, 'an array of globs')
      for (const k of TASK_FLAGS)
        if (d[k] !== undefined && typeof d[k] !== 'boolean') refuse(`${at}.${k}`, 'true or false')
      if (d['outputLogs'] !== undefined && typeof d['outputLogs'] !== 'string')
        refuse(`${at}.outputLogs`, 'a string')
    }
  }
}

function tasksOf(cfg: TurboJson): Record<string, TurboTask> {
  return cfg.tasks ?? cfg.pipeline ?? {}
}

function declares(meta: ProjectMeta, dependency: string): boolean {
  const pj = meta.packageJson as unknown as Record<string, unknown>
  return ['dependencies', 'devDependencies'].some((field) => {
    const deps = pj[field]
    return typeof deps === 'object' && deps !== null && Object.hasOwn(deps, dependency)
  })
}

/** A script value that can become `exec.command` verbatim. */
function usableScript(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function describeScript(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return 'an empty string'
  if (Array.isArray(value)) return 'an array'
  return `a ${typeof value}`
}

/**
 * Turbo 2.11's task `command` (`futureFlags.experimentalTaskCommand`),
 * which Turbo holds authoritative over the package's script: an argv runs
 * where the package has no script, and `null` or `[]` never runs, even
 * where it has one. A per-toolchain map (`{ "javascript": [...] }`)
 * applies its `javascript` entry (`typescript` is Turbo's alias for it)
 * to a JS package, and without one the script runs as before. Reported
 * as having no vx form, the key was dropped: on turborepo itself four
 * tasks with no script were missing, and the edges to them with them
 * (`docs#build` ran before the schema it copies).
 *
 * `undefined`: the script decides. `null`: no command. A string: the
 * argv as one sh line, each word quoted, run from the package dir as
 * Turbo runs it, with no `pre`/`post` hooks (it is not a script).
 */
function commandOverride(def: TurboTask | undefined): string | null | undefined {
  if (def === undefined || !Object.hasOwn(def, 'command')) return undefined
  const raw = def['command']
  if (raw === null) return null
  const map = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
  const argv = map
    ? ((raw as Record<string, unknown>)['javascript'] ??
      (raw as Record<string, unknown>)['typescript'])
    : raw
  if (!isArgv(argv)) return undefined
  return argv.length === 0 ? null : argv.map(shellQuote).join(' ')
}

function isArgv(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((w) => typeof w === 'string')
}

/** A `command` Turbo would refuse: neither an argv, `null`, nor a toolchain map of them. */
function badCommand(def: TurboTask): boolean {
  if (!Object.hasOwn(def, 'command')) return false
  const raw = def['command']
  if (raw === null || isArgv(raw)) return false
  if (typeof raw !== 'object' || Array.isArray(raw)) return true
  return Object.values(raw as Record<string, unknown>).some((v) => !isArgv(v))
}

/** Declared task names for a package: plain root keys, `pkg#name` keys
 * for this package, and per-package turbo.json keys — in that order. */
const ROOT = '//'

/**
 * A package's turbo.json files, root first and its own last, as Turbo's
 * `turbo_json_chain` orders them: a package config may extend another
 * package's (`"extends": ["//", "shared"]`, read by Turbo 2.11, refused by 2.5), and read as
 * root-plus-own the shared file's tasks and fields were gone (a task it
 * adds not emitted, an `inputs` it widens not keyed: a stale hit).
 */
function turboChain(pkgName: string, files: ReadonlyMap<string, TurboJson>): TurboJson[] {
  const out: TurboJson[] = []
  const seen = new Set<string>()
  const stack: { name: string; path: string[]; required: boolean }[] = [
    { name: pkgName, path: [], required: false },
  ]
  while (stack.length > 0) {
    const { name, path, required } = stack.pop()!
    if (path.includes(name)) {
      throw new UserError(`turbo.json extends form a cycle: ${[...path, name].join(' → ')}`)
    }
    if (seen.has(name)) continue
    const cfg = files.get(name)
    if (cfg === undefined) {
      if (required) {
        throw new UserError(`turbo.json of ${path.at(-1)} extends ${name}, which has no turbo.json`)
      }
      // Only the package's own file can be missing unrequired: read as the root's.
      stack.push({ name: ROOT, path, required: false })
      continue
    }
    out.push(cfg)
    seen.add(name)
    if (name === ROOT) continue
    for (const parent of parentsOf(cfg)) {
      stack.push({ name: parent, path: [...path, name], required: true })
    }
  }
  return out.reverse()
}

/** A package config's `extends`; Turbo refuses one that names none, read here as the root's. */
function parentsOf(cfg: TurboJson): string[] {
  return Array.isArray(cfg.extends) && cfg.extends.length > 0 ? cfg.extends : [ROOT]
}

/**
 * Whether `name` is a task of `pkgName`, as Turbo's
 * `has_task_definition_in_run` decides: the package's own entry, else the
 * first parent in `extends` order that has one; an `extends: false` with
 * nothing else is the opt-out, and it holds for every package below it.
 */
function taskDefined(
  pkgName: string,
  name: string,
  files: ReadonlyMap<string, TurboJson>,
  at: string = pkgName,
  seen: Set<string> = new Set(),
): 'found' | 'excluded' | 'none' {
  if (seen.has(at)) return 'none'
  seen.add(at)
  const cfg = files.get(at)
  if (cfg === undefined) return at === ROOT ? 'none' : taskDefined(pkgName, name, files, ROOT, seen)
  const tasks = tasksOf(cfg)
  const def = tasks[`${pkgName}#${name}`] ?? tasks[name]
  if (def !== undefined) return optedOut(def) ? 'excluded' : 'found'
  if (at === ROOT) return 'none'
  for (const parent of parentsOf(cfg)) {
    const r = taskDefined(pkgName, name, files, parent, seen)
    if (r !== 'none') return r
  }
  return 'none'
}

/** Every task `pkgName` has, in the order its files name them. */
function taskNamesFor(
  pkgName: string,
  chain: readonly TurboJson[],
  files: ReadonlyMap<string, TurboJson>,
): string[] {
  const names = new Set<string>()
  for (const cfg of chain) {
    for (const key of Object.keys(tasksOf(cfg))) {
      if (!key.includes('#')) names.add(key)
      else if (key.startsWith(`${pkgName}#`)) names.add(key.slice(pkgName.length + 1))
    }
  }
  return [...names].filter((n) => taskDefined(pkgName, n, files) === 'found')
}

/**
 * The task's definition along the chain, as Turbo's
 * `resolve_task_definitions_from_chain` folds it: the root's (a root
 * `pkg#task` REPLACES `task` for that package, as Turbo's `TurboJson::task`
 * looks it up: merged field by field, the generic task's `inputs` narrowed
 * a `pkg#task` that names none and an edit outside them was a stale hit,
 * item 935), then each later file's overlaid on it. The file nearest the
 * package that says `extends: false` starts afresh: its own fields, if
 * any, then the files after it.
 */
function definitionOf(pkgName: string, name: string, chain: readonly TurboJson[]): TurboTask {
  const defs = chain.map((cfg, i) => {
    const tasks = tasksOf(cfg)
    return i === 0 ? (tasks[`${pkgName}#${name}`] ?? tasks[name]) : tasks[name]
  })
  let from = 0
  for (let i = defs.length - 1; i > 0; i--) {
    if (defs[i]?.extends === false) {
      from = i
      break
    }
  }
  let def: TurboTask = {}
  for (const d of defs.slice(from)) {
    if (d === undefined) continue
    const own: TurboTask = { ...d }
    delete own.extends
    if (Array.isArray(own.inputs)) own.inputs = flatInputs(own.inputs)
    def = withOverlay(def, own)
  }
  return def
}

/**
 * Turbo 2.11's structured inputs as the strings they stand for: a
 * `startup` or `jit` entry is its globs (and every file with
 * `withDefaults`), keyed as the other inputs are (vx has no separate
 * just-in-time pass). `dependencyOutputs` is nothing: vx folds each
 * dependency's key instead (its outputs follow from it). Read as strings,
 * an object crashed the plugin and failed the whole run.
 */
function flatInputs(inputs: readonly unknown[]): string[] {
  return inputs.flatMap((i): string[] => {
    if (typeof i === 'string') return [i]
    if (i === null || typeof i !== 'object') return []
    const { mode, globs, withDefaults } = i as {
      mode?: unknown
      globs?: unknown
      withDefaults?: unknown
    }
    if (mode !== 'startup' && mode !== 'jit') return []
    return [
      ...(withDefaults === true ? ['$TURBO_DEFAULT$'] : []),
      ...(Array.isArray(globs) ? globs.filter((g): g is string => typeof g === 'string') : []),
    ]
  })
}

/**
 * A glob naming `.env` files: its last segment starts with `.env` or ends
 * with it, the shapes Turbo's docs and create-turbo write (`.env*`,
 * `**\/.env.*local`, `.env.local`).
 */
function isDotenvGlob(glob: string): boolean {
  const last = glob.slice(glob.lastIndexOf('/') + 1)
  return last.startsWith('.env') || last.endsWith('.env')
}

/**
 * Every `.env`-shaped file under the probe's directory, name and bytes, in
 * a stable order: a superset of what a `.env` glob names, so a change to
 * one misses and nothing else is lost. node_modules and .git are pruned.
 */
const DOTENV_PROBE =
  'find . \\( -name node_modules -o -name .git \\) -prune -o -type f \\( -name \'.env*\' -o -name \'*.env\' \\) -print | LC_ALL=C sort | while IFS= read -r f; do echo "$f"; cat -- "$f"; echo; done'

/** Turbo 1's env dependency, `$NAME`, as the name; null for anything else, `$TURBO_…$` tokens included. */
function envDependency(entry: string): string | null {
  const m = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(entry)
  return m === null ? null : m[1]!
}

/**
 * A package overlay on the task it inherits. A field the overlay sets
 * replaces the inherited one, except an array holding `$TURBO_EXTENDS$`
 * (Turbo 2.5+): that is the inherited list plus the overlay's other
 * entries. Spread whole, the token stayed as a literal input glob and
 * env name and the root's `inputs`, `env` and `dependsOn` were gone, so a
 * source edit was a hit (item 906).
 */
function withOverlay(inherited: TurboTask, overlay: TurboTask | undefined): TurboTask {
  if (overlay === undefined) return inherited
  const out: Record<string, unknown> = { ...inherited, ...overlay }
  for (const [field, value] of Object.entries(overlay)) {
    if (!Array.isArray(value) || !value.includes(TURBO_EXTENDS)) continue
    const base = (inherited as Record<string, unknown>)[field]
    out[field] = [...(Array.isArray(base) ? base : []), ...value.filter((v) => v !== TURBO_EXTENDS)]
  }
  return out as TurboTask
}

const TURBO_EXTENDS = '$TURBO_EXTENDS$'

/**
 * A per-package `{ "extends": false }` with nothing else is Turbo's
 * opt-out: the package's script exists, the root defines the task, and
 * Turbo 2.9 runs nothing for it (n8n's `@n8n/storybook` on `build` and
 * `test`; probed with `--dry=json`, 2026-09-11). With any other key the
 * task runs on those keys alone, the root definition not inherited.
 */
function optedOut(def: TurboTask | undefined): boolean {
  return def?.extends === false && Object.keys(def).length === 1
}

/**
 * Turbo 2.11's `global` block (`futureFlags.globalConfiguration`) in the
 * top-level fields it replaces, as Turbo's `resolve_global_config` moves
 * them. Unread, its `inputs` and `env` keyed nothing: an edit to a global
 * file was a hit everywhere.
 */
function withGlobal(cfg: TurboJson): TurboJson {
  const g = cfg.global
  if (g === undefined || g === null || typeof g !== 'object') return cfg
  const { globalDependencies: _d, globalEnv: _e, globalPassThroughEnv: _p, ...rest } = cfg
  return {
    ...rest,
    ...(g.inputs === undefined ? {} : { globalDependencies: g.inputs }),
    ...(g.env === undefined ? {} : { globalEnv: g.env }),
    ...(g.passThroughEnv === undefined ? {} : { globalPassThroughEnv: g.passThroughEnv }),
  }
}

export async function mapTurboWorkspace(
  root: string,
  metas: readonly ProjectMeta[],
  opts: MapTurboOptions,
): Promise<TurboMapping> {
  // A workspace with no Turbo config answered with a bare ENOENT and a stack
  // (item 1043): turbo() declared in the wrong repo, or its file removed.
  const rootFile = await turboConfigFile(root)
  if (rootFile === null) {
    throw new UserError(
      `no turbo.json or turbo.jsonc at the workspace root (${root}): turbo() maps a Turbo repo's config — add one, or remove turbo() from vx.workspace.ts`,
    )
  }
  const rootCfg = withGlobal(await readTurboJson(rootFile, root))
  const pnp = await yarnPnp(root)
  const rootTasks = tasksOf(rootCfg)

  // Turbo 1 lists an env var as `$NAME` among `globalDependencies` (and a
  // task's `dependsOn`); read as a file it was a glob that matched nothing,
  // and the var re-keyed nothing (item 909).
  const globalDeps = rootCfg.globalDependencies ?? []
  const notes: string[] = []
  // Loose mode hands every task the whole environment; vx's is isolated,
  // so a task that reads an undeclared variable ran without it, and said
  // nothing (a build baking a URL from the env built without one).
  if ((rootCfg.global?.envMode ?? rootCfg.envMode) === 'loose') {
    notes.push(
      'envMode "loose": Turbo passes every environment variable to every task; vx passes only ' +
        'the declared ones — list what each task reads in exec.env.passThrough (or cache.inputs.env)',
    )
  }
  // A wildcard or `!` entry names no one variable: core refuses it, and in
  // a global list that refusal failed every task of the run (item 937).
  // Reported once, as a task's own `env` wildcard is per task.
  const envNames = (field: string, names: readonly string[]): string[] =>
    names.filter((e) => {
      if (!/[*?[\]!]/.test(e)) return true
      notes.push(
        `${field} ${JSON.stringify(e)}: wildcards are not supported in vx env names — ` +
          'list explicit names',
      )
      return false
    })
  // Turbo 1's `globalDotEnv` files are hashed as `globalDependencies` are
  // (item 937). A `.env`-shaped one is gitignored as a rule, and a glob
  // over git's files keyed nothing: the workspace probe keys them (item
  // 1032).
  const globalFiles = [
    ...globalDeps.filter((d) => envDependency(d) === null),
    ...(rootCfg.globalDotEnv ?? []),
  ]
  const rootDotenv = globalFiles.some((f) => isDotenvGlob(f))
  const globals = {
    inputs: globalFiles.filter((f) => !isDotenvGlob(f)),
    env: [
      ...envNames('globalEnv', rootCfg.globalEnv ?? []),
      ...globalDeps.flatMap((d) => envDependency(d) ?? []),
    ],
    pass: envNames('globalPassThroughEnv', rootCfg.globalPassThroughEnv ?? []),
  }

  const files = new Map<string, TurboJson>([[ROOT, rootCfg]])
  for (const meta of metas) {
    const file = await turboConfigFile(meta.dir)
    if (file !== null) files.set(meta.name, await readTurboJson(file, root))
  }

  for (const key of Object.keys(rootTasks)) {
    if (key.startsWith('//#')) {
      notes.push(`note: root task ${key} not migrated — vx has no workspace-root tasks`)
    }
  }

  const definitions = (meta: ProjectMeta) => {
    const chain = turboChain(meta.name, files)
    const defined = new Set(taskNamesFor(meta.name, chain, files))
    const defFor = (name: string): TurboTask | undefined =>
      defined.has(name) ? definitionOf(meta.name, name, chain) : undefined
    return { defined, defFor }
  }

  // First pass: which tasks does each package emit? Needed so dependsOn
  // edges can be validated/dropped against the real emitted set.
  const emitted = new Map<string, Set<string>>()
  for (const meta of metas) {
    const scripts = packageScripts(meta)
    const { defined, defFor } = definitions(meta)
    const set = new Set<string>()
    for (const name of defined) {
      const override = commandOverride(defFor(name))
      if (override === undefined ? usableScript(scripts[name]) : override !== null) set.add(name)
    }
    emitted.set(meta.name, set)
  }
  const emittedAnywhere = new Set<string>()
  for (const set of emitted.values()) for (const name of set) emittedAnywhere.add(name)

  for (const [dependency, prefixes] of FRAMEWORK_ENV) {
    const users = metas
      .filter((m) => emitted.get(m.name)!.size > 0 && declares(m, dependency))
      .map((m) => m.name)
    if (users.length === 0) continue
    notes.push(
      `Turbo infers ${dependency} in ${users.join(', ')} and hashes and passes ${prefixes} to ` +
        'its tasks; vx env names are explicit — list the ones they read in cache.inputs.env ' +
        'and exec.env.passThrough',
    )
  }

  const projects: TurboMappedProject[] = []
  for (const meta of metas) {
    const scripts = packageScripts(meta)
    const own = emitted.get(meta.name)!
    const { defined, defFor } = definitions(meta)
    const tasks: TurboMappedTask[] = []
    for (const name of defined) {
      const override = commandOverride(defFor(name))
      if (override === null) continue
      const script = scripts[name]
      if (override === undefined && !usableScript(script)) {
        // The turbo task exists and so does the script KEY, but its value
        // can't become a command. Report it instead of emitting
        // `command: 42` / `command: null` — the first writes a config that
        // fails to load, the second used to abort the whole migration in
        // the emitter, and both landed AFTER "migrated clean, 0 TODOs".
        // An ABSENT script stays silent: turbo skips the task there too.
        if (script !== undefined) {
          tasks.push({
            name,
            todos: [
              `package.json script ${JSON.stringify(name)} is ${describeScript(script)}, not a ` +
                'non-empty command string — task skipped; write the command by hand',
            ],
            task: null,
            uses: new Set(),
          })
        }
        continue
      }
      tasks.push(
        buildTask(
          name,
          defFor(name)!,
          override ?? scriptCommand(name, script as string, scripts, pnp),
          own,
          defFor,
          emitted,
          emittedAnywhere,
          globals,
          opts,
          relPosix(root, meta.dir),
          rootDotenv,
        ),
      )
    }
    resolveSharedOutputs(tasks)
    projects.push({ name: meta.name, dir: meta.dir, tasks })
  }

  pruneOrphanPersistentNotes(projects, opts.persistentTodo)
  return { projects, notes, globals }
}

/**
 * A name both a global list and the task's own list carry — `globalEnv`
 * and a task `env`, `globalDependencies` and a `$TURBO_ROOT$/` input —
 * is listed once, in its first position. Only concrete strings are
 * compared: the `vx migrate` renderer splices globals as an opaque
 * preset spread, which stays as written.
 */
function uniq(values: readonly unknown[]): unknown[] {
  const seen = new Set<string>()
  const out: unknown[] = []
  for (const v of values) {
    if (typeof v === 'string') {
      if (seen.has(v)) continue
      seen.add(v)
    }
    out.push(v)
  }
  return out
}

function buildTask(
  name: string,
  def: TurboTask,
  command: string,
  own: ReadonlySet<string>,
  defFor: (name: string) => TurboTask | undefined,
  emitted: ReadonlyMap<string, ReadonlySet<string>>,
  emittedAnywhere: ReadonlySet<string>,
  globals: TurboMapping['globals'],
  opts: MapTurboOptions,
  pkgDir: string,
  rootDotenv: boolean,
): TurboMappedTask {
  const todos: string[] = []
  // A glob that climbs out of the package (`../../packages/app-store/
  // *.generated.ts`, cal.com's app-store-cli) is a workspace-root glob
  // in vx's terms: re-anchor it on the root. One that climbs out of the
  // workspace has no home and is reported.
  const climbed = (glob: string): string | null => {
    const body = glob.startsWith('!') ? glob.slice(1) : glob
    if (!body.startsWith('../')) return null
    const anchored = path.posix.normalize(path.posix.join(pkgDir, body))
    if (anchored.startsWith('../')) return null
    return (glob.startsWith('!') ? '!' : '') + anchored
  }
  const uses = new Set<TurboGlobal>()
  const global = (kind: TurboGlobal): readonly unknown[] => {
    const values = globals[kind]
    if (values.length === 0) return []
    uses.add(kind)
    return opts.splice(kind, values)
  }
  const persistent = def.persistent === true
  const cacheEnabled = def.cache !== false && !persistent

  for (const [key, value] of Object.entries(def)) {
    if (KNOWN_TASK_KEYS.has(key)) continue
    todos.push(
      `turbo key ${JSON.stringify(key)} (${JSON.stringify(value)}) has no vx equivalent — ` +
        'map it manually',
    )
  }
  if (badCommand(def)) {
    todos.push(
      `turbo key "command" (${JSON.stringify(def['command'])}) is not an argv, null or a toolchain map of them — the script runs; write the command by hand`,
    )
  }
  const outputLogs = (def as { outputLogs?: unknown }).outputLogs
  if (outputLogs !== undefined && outputLogs !== OUTPUT_LOGS_DEFAULT) {
    todos.push(
      typeof outputLogs === 'string' && OUTPUT_LOGS_RUN_FLAG.has(outputLogs)
        ? `turbo key "outputLogs" (${JSON.stringify(outputLogs)}) is a per-run setting in vx — ` +
            `run with --output-logs ${outputLogs}`
        : `turbo key "outputLogs" (${JSON.stringify(outputLogs)}) is not a value vx knows — ` +
            'run with --output-logs full|hash-only|errors-only|none',
    )
  }

  const deps: string[] = []
  const envDeps: string[] = []
  // A same-package task Turbo defines but this package has no script for
  // is still a node in Turbo's graph — a no-op that keeps its own edges.
  // Dropping it dropped them too: `test → codegen → ^build` with no
  // `codegen` script lost `^build`, so `test` ran before its dependency's
  // build and its key never folded it (item 939). Its edges are followed
  // in its place, once each.
  const through = new Set<string>([name])
  const walk = (dependsOn: readonly string[]): void => {
    for (const d of dependsOn) {
      const envName = envDependency(d)
      if (envName !== null) {
        envDeps.push(envName)
        continue
      }
      if (d.includes('$TURBO_ROOT$')) {
        todos.push(
          `dependsOn ${JSON.stringify(d)} uses $TURBO_ROOT$ — vx has no workspace-root tasks; ` +
            'restructure manually',
        )
        continue
      }
      if (d.startsWith('^')) {
        // A task no package runs gives `^name` no edges under turbo. Passed
        // through, core refuses it as a typo: no project declares the name.
        if (emittedAnywhere.has(d.slice(1)) && !deps.includes(d)) deps.push(d)
        continue
      }
      const hashAt = d.indexOf('#')
      if (hashAt !== -1) {
        const pkg = d.slice(0, hashAt)
        const task = d.slice(hashAt + 1)
        if (emitted.get(pkg)?.has(task)) {
          if (!deps.includes(d)) deps.push(d)
        } else
          todos.push(
            `dependsOn ${JSON.stringify(d)}: ${pkg} declares no ${task} script — edge dropped`,
          )
        continue
      }
      if (own.has(d)) {
        if (!deps.includes(d)) deps.push(d)
        continue
      }
      const hop = through.has(d) ? undefined : defFor(d)
      if (hop !== undefined) {
        through.add(d)
        walk(hop.dependsOn ?? [])
      }
    }
  }
  walk(def.dependsOn ?? [])

  const envNames: string[] = [...envDeps]
  for (const e of def.env ?? []) {
    if (/[*?[\]!]/.test(e)) {
      todos.push(
        `env ${JSON.stringify(e)}: wildcards are not supported in vx env names — ` +
          'list explicit names in cache.inputs.env + exec.env.passThrough',
      )
    } else envNames.push(e)
  }
  const passNames: string[] = []
  for (const e of def.passThroughEnv ?? []) {
    if (/[*?[\]!]/.test(e)) {
      todos.push(
        `passThroughEnv ${JSON.stringify(e)}: wildcards are not supported — list explicit names`,
      )
    } else passNames.push(e)
  }

  const passThrough = uniq([...global('env'), ...global('pass'), ...envNames, ...passNames])

  const exec: Record<string, unknown> = { command }
  if (passThrough.length > 0) exec.env = { passThrough }
  if (persistent) {
    exec.persistent = {}
    todos.push(opts.persistentTodo)
  }

  const task: Record<string, unknown> = { exec }
  if (typeof def['description'] === 'string') task.description = def['description']
  if (deps.length > 0) task.dependsOn = deps

  if (cacheEnabled) {
    const files: unknown[] = []
    // `.env` files Turbo hashes although git ignores them; a glob over git's
    // files keyed none of them (item 1032). Probed instead, per package and
    // at the root.
    let pkgDotenv = false
    let wsDotenv = rootDotenv
    // globalDependencies are workspace-root-relative by definition —
    // they map to inputs.workspaceFiles, not project-relative files.
    const wsFiles: unknown[] = [...global('inputs')]
    if (def.inputs === undefined || def.inputs.length === 0) {
      // Turbo's default input set is every package file, and an empty
      // `inputs` is that default: mapped as no files, it keyed on nothing
      // in the package and an edit replayed a stale build (item 936).
      files.push('**/*')
    } else {
      for (const i of def.inputs) {
        if (i === '$TURBO_DEFAULT$') {
          files.push('**/*')
          continue
        }
        const neg = i.startsWith('!')
        // Turbo's globs have character classes and extglobs; a vx bracket is
        // a literal, so `src/**/*.[jt]s` keyed on nothing and an edit
        // replayed the old build (item 1031). A positive glob with no safe
        // form widens to every package file; a negation with none is dropped
        // (it would exclude fewer files, never more).
        const wax = minimatchToVx(neg ? i.slice(1) : i, neg)
        if (wax === null) {
          todos.push(`input ${JSON.stringify(i)}: glob syntax vx cannot take — map manually`)
          if (!neg) files.push('**/*')
          continue
        }
        const translated = (neg ? '!' : '') + wax
        const body = wax
        const up = climbed(translated)
        if (!neg && isDotenvGlob(body)) {
          if (body.startsWith('$TURBO_ROOT$/') || up !== null) wsDotenv = true
          else pkgDotenv = true
          continue
        }
        if (body.startsWith('$TURBO_ROOT$/')) {
          wsFiles.push((neg ? '!' : '') + body.slice('$TURBO_ROOT$/'.length))
        } else if (up !== null) {
          wsFiles.push(up)
        } else if (body.startsWith('../')) {
          todos.push(`input ${JSON.stringify(i)}: leaves the workspace — map manually`)
        } else if (i.includes('$TURBO_ROOT$')) {
          todos.push(
            `input ${JSON.stringify(i)}: $TURBO_ROOT$ only maps as a '$TURBO_ROOT$/<path>' ` +
              'prefix (→ cache.inputs.workspaceFiles) — map manually',
          )
        } else files.push(translated)
      }
      // Exclusions alone narrow every package file: core refuses a list
      // with nothing to narrow, and that refusal failed the whole run
      // (item 936). Every file is the widest reading, so it can cost a
      // hit and never serve a stale one.
      if (files.length > 0 && files.every((f) => typeof f === 'string' && f.startsWith('!'))) {
        files.unshift('**/*')
      }
    }
    // Turbo 1's task `dotEnv`: package-relative `.env` files it hashes,
    // gitignored as a rule, so read as files they keyed nothing (item 1032).
    const dotEnv = (def as { dotEnv?: unknown }).dotEnv
    if (Array.isArray(dotEnv) && dotEnv.some((f) => typeof f === 'string')) pkgDotenv = true

    const outFiles: string[] = []
    const wsOutFiles: string[] = []
    for (const raw of def.outputs ?? []) {
      // The first segment stays a literal (a route directory, item 667);
      // the rest is Turbo's grammar: `dist/**/*.[cm]js` matched nothing, so
      // a hit restored nothing (item 1031).
      const cut = raw.indexOf('/')
      const rest = cut < 0 ? null : minimatchToVx(raw.slice(cut + 1), raw.startsWith('!'))
      if (cut >= 0 && rest === null) {
        todos.push(
          `output ${JSON.stringify(raw)}: glob syntax vx cannot take — task runs uncached; ` +
            'declare the exact outputs in a vx.config to cache it',
        )
        return { name, todos, task, uses }
      }
      const mapped = cut < 0 ? raw : `${raw.slice(0, cut + 1)}${rest}`
      // A `!` output takes a path back, as Turbo's does (A-44): Next's
      // `.next/**` minus `!.next/cache/**` saved the cache and cleaned it
      // before every run while vx outputs could not exclude.
      const neg = mapped.startsWith('!') ? '!' : ''
      const o = mapped.slice(neg.length)
      if (o.startsWith('$TURBO_ROOT$/')) {
        wsOutFiles.push(neg + o.slice('$TURBO_ROOT$/'.length))
      } else if (climbed(o) !== null) {
        wsOutFiles.push(neg + climbed(o)!)
      } else if (o.startsWith('../')) {
        todos.push(`output ${JSON.stringify(o)}: leaves the workspace — map manually`)
      } else if (o.includes('$TURBO_ROOT$')) {
        todos.push(
          `output ${JSON.stringify(o)}: $TURBO_ROOT$ only maps as a '$TURBO_ROOT$/<path>' ` +
            'prefix (→ cache.outputs.workspaceFiles) — map manually',
        )
      } else outFiles.push(neg + o)
    }

    // Turbo never cleans an output; vx cleans it before a run and a restore,
    // so `**/*.d.ts` deleted a hand-written `src/env.d.ts` and an uncommitted
    // edit to it was lost for good (item 1031). A wildcard first segment can
    // reach the sources, and a `!` beside it (medusa: `*/**` minus `!src/**`)
    // takes back only what it names.
    const wild = outFiles.find(
      (o) => !o.startsWith('!') && !isLiteralPattern(o.split('/')[0] ?? ''),
    )
    if (wild !== undefined) {
      todos.push(
        `output ${JSON.stringify(wild)}: a wildcard first segment reaches the sources, which ` +
          'vx cleans before every run — task runs uncached; declare the exact outputs in a ' +
          'vx.config to cache it',
      )
      return { name, todos, task, uses }
    }

    const cacheEnv = uniq([...global('env'), ...envNames])

    const inputs: Record<string, unknown> = { files }
    if (wsFiles.length > 0) inputs.workspaceFiles = uniq(wsFiles)
    if (cacheEnv.length > 0) inputs.env = cacheEnv
    if (pkgDotenv) inputs.runtime = [DOTENV_PROBE]
    if (wsDotenv) inputs.workspaceRuntime = [DOTENV_PROBE]
    const outputs: Record<string, unknown> = { files: takingBack(outFiles) }
    const ws = takingBack(wsOutFiles)
    if (ws.length > 0) outputs.workspaceFiles = ws
    task.cache = { inputs, outputs }
  }

  return { name, todos, task, uses }
}
