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

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pruneOrphanPersistentNotes, type ProjectMeta, UserError } from '@vzn/vx'
import { minimatchToVx } from '../glob-grammar.js'
import { shellQuote } from '../nx-command.js'
import { scriptCommand, yarnPnp } from '../script-command.js'
import {
  ownFileOutput,
  ownFileTodo,
  resolveSharedOutputs,
  resolveSharedWorkspaceOutputs,
  takingBack,
  wildcardOutput,
  wildcardTodo,
} from '../shared-outputs.js'
import { packageScripts, relPosix } from '../paths.js'
import type { TrackedKinds } from '../tracked-outputs.js'
import { DOTENV_PROBE, DOTENV_PROBE_TOP } from '../dotenv-probe.js'

/** `path.relative` with forward slashes — the shape an ESM specifier or a report line needs. */
interface TurboTask {
  dependsOn?: string[]
  inputs?: string[]
  outputs?: string[]
  env?: string[]
  passThroughEnv?: string[]
  cache?: boolean
  persistent?: boolean
  with?: string[]
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

/** A name core takes in `cache.inputs.env` and `exec.env.passThrough`. */
const keyable = (name: string): boolean =>
  name.length > 0 && !name.startsWith('!') && !/[*?[\]{}=\0]/.test(name)

/**
 * A Turbo env list's explicit names, read as Turbo reads them
 * (`wildcard_to_regex_pattern`): `*` is the one wildcard, `\*` a
 * literal `*`, a leading `\!` a literal `!`, and every other character
 * (`?`, `[`) itself. A `!` entry takes names back out of what the list
 * matched (openstatus drops `!NEXT_PUBLIC_VERCEL_URL` from a
 * `NEXT_PUBLIC_*` it would otherwise hash); vx matches no name it is not
 * given, so an exclusion only removes the list's own names and needs no
 * todo. With `live`, a `*` name expands over those names, and a literal
 * core cannot key (unkey's `NEXT_PUBLIC_\*`) is dropped when no variable
 * has it, as Turbo hashes nothing for it then. Any other wildcard, or such
 * a literal, is `gap(entry, literal)`'s to report.
 */
function explicitEnv(
  entries: readonly string[],
  gap: (entry: string, literal: string | null) => void,
  live?: readonly string[],
): string[] {
  const out: string[] = []
  const excluded: RegExp[] = []
  // Literal runs split at each unescaped `*`; one run is a literal name.
  const runs = (p: string): string[] => p.split(/(?<!\\)\*/).map((r) => r.replaceAll('\\*', '*'))
  const regex = (parts: readonly string[]): RegExp =>
    new RegExp(`^${parts.map(RegExp.escape).join('.*')}$`)
  for (const e of entries) {
    if (e.startsWith('!') && e.length > 1) {
      excluded.push(regex(runs(e.slice(1))))
      continue
    }
    const parts = runs(e.startsWith('\\!') ? e.slice(1) : e)
    if (parts.length === 1) {
      const name = parts[0]!
      if (keyable(name)) out.push(name)
      else if (live === undefined || live.includes(name)) gap(e, name)
    } else if (live !== undefined) {
      // Turbo matches a `*` name against the environment it runs in; so
      // does a live mapping, and the names it finds are keyed and passed.
      const re = regex(parts)
      out.push(...live.filter((n) => re.test(n) && keyable(n)).sort())
    } else gap(e, null)
  }
  return out.filter((n) => !excluded.some((re) => re.test(n)))
}

/** A gap's message: a wildcard, or a literal name core cannot key. */
const envGap = (field: string, entry: string, literal: string | null, list: string): string =>
  literal === null
    ? `${field} ${JSON.stringify(entry)}: wildcards are not supported${list}`
    : `${field} ${JSON.stringify(entry)}: Turbo reads this as the one variable ` +
      `${JSON.stringify(literal)} (only \`*\` is a wildcard), a name vx cannot key — dropped`

const KNOWN_TASK_KEYS = new Set([
  'dependsOn',
  'with',
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
  // `turbo watch` restarts a persistent task only when it says so; `vx
  // watch` stops and re-spawns every persistent task each cycle, so either
  // value maps to nothing.
  'interruptible',
  // Labels: Turbo keeps them out of the hash and the behaviour.
  'tags',
])

// Turbo's per-task `outputLogs` against vx's per-run `--output-logs`.
// `new-only` — frames for the tasks that ran, a one-liner per cache hit —
// is what vx's default flow already does, so the most common value in
// the wild (every Vercel template) maps to nothing and warns about
// nothing. The other values have no per-task knob in vx; the todo names
// the run flag that carries them.
const OUTPUT_LOGS_DEFAULT = 'new-only'
const OUTPUT_LOGS_RUN_FLAG = new Set(['full', 'hash-only', 'errors-only', 'none'])

// Turbo 2's framework inference: a package that depends on a framework
// has its variables hashed into its tasks and passed to them, with
// nothing in turbo.json saying so. vx env names are explicit, so the
// variables were stripped in silence and a build that inlines them
// (Next's `NEXT_PUBLIC_*`) read empty values (item 940). A live mapping
// (`envNames`) infers them as Turbo does; the migrate CLI names them in a
// note. Turbo's own table (`packages/turbo-types/src/json/frameworks.json`),
// in its order: a package takes the FIRST framework it matches, `all`
// needing every dependency and `some` any one.
const NITRO_ENV = [
  'NITRO_*',
  'SERVER_*',
  'AWS_APP_ID',
  'INPUT_AZURE_STATIC_WEB_APPS_API_TOKEN',
  'CLEAVR',
  'CF_PAGES',
  'FIREBASE_APP_HOSTING',
  'NETLIFY',
  'STORMKIT',
  'NOW_BUILDER',
  'ZEABUR',
  'RENDER',
]
const FRAMEWORK_ENV: ReadonlyArray<{
  slug: string
  env: readonly string[]
  all: boolean
  dependencies: readonly string[]
}> = [
  { slug: 'astro', env: ['PUBLIC_*'], all: true, dependencies: ['astro'] },
  { slug: 'blitzjs', env: ['NEXT_PUBLIC_*'], all: true, dependencies: ['blitz'] },
  {
    slug: 'create-react-app',
    env: ['REACT_APP_*'],
    all: false,
    dependencies: ['react-scripts', 'react-dev-utils'],
  },
  { slug: 'expo', env: ['EXPO_PUBLIC_*'], all: true, dependencies: ['expo'] },
  { slug: 'gatsby', env: ['GATSBY_*'], all: true, dependencies: ['gatsby'] },
  {
    slug: 'nextjs',
    env: ['NEXT_PUBLIC_*', 'NEXT_DEPLOYMENT_ID'],
    all: true,
    dependencies: ['next'],
  },
  {
    slug: 'nitro',
    env: NITRO_ENV,
    all: false,
    dependencies: ['nitropack', 'nitropack-nightly', 'nitro', 'nitro-nightly'],
  },
  {
    slug: 'nuxtjs',
    env: ['NUXT_*', 'NUXT_ENV_*', ...NITRO_ENV, 'LAUNCH_EDITOR'],
    all: false,
    dependencies: ['nuxt', 'nuxt-edge', 'nuxt3', 'nuxt3-edge'],
  },
  { slug: 'redwoodjs', env: ['REDWOOD_ENV_*'], all: true, dependencies: ['@redwoodjs/core'] },
  {
    slug: 'remix',
    env: ['REMIX_*'],
    all: false,
    dependencies: ['@remix-run/dev', '@remix-run/react', '@remix-run/serve', '@react-router/dev'],
  },
  { slug: 'sanity', env: ['SANITY_STUDIO_*'], all: true, dependencies: ['@sanity/cli'] },
  { slug: 'solidstart', env: ['VITE_*'], all: true, dependencies: ['solid-js', 'solid-start'] },
  { slug: 'sveltekit', env: ['VITE_*', 'PUBLIC_*'], all: true, dependencies: ['@sveltejs/kit'] },
  { slug: 'vite', env: ['VITE_*'], all: true, dependencies: ['vite'] },
  {
    slug: 'vue',
    env: ['VUE_APP_*', 'LAUNCH_EDITOR'],
    all: true,
    dependencies: ['@vue/cli-service'],
  },
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
  /**
   * A task's `npm_package_name` / `npm_package_version`: `vx migrate` reads
   * them from the manifest it imports (`{ raw: 'pkg.version' }`), so a bump
   * reaches them; absent, the values themselves.
   */
  manifestField?(key: 'name' | 'version'): unknown
  /**
   * The environment's variable names, when the mapping runs where the tasks
   * will (`turbo()`): an env wildcard (`NEXT_PUBLIC_*`) expands over them.
   * Absent (`vx migrate` writes files), a wildcard is a todo.
   */
  envNames?: readonly string[]
  /**
   * `TURBO_CI_VENDOR_ENV_KEY`, which a platform sets (Vercel:
   * `NEXT_PUBLIC_VERCEL_`): names with it are left out of framework
   * inference, as Turbo leaves them, since they change on every deploy.
   */
  vendorEnvPrefix?: string
  /** `TURBO_ENV_MODE`, when the mapping runs where the tasks will: above turbo.json's, as in Turbo. */
  envMode?: string
  /**
   * What git tracks under a root-relative package directory: a
   * wildcard-first output of a kind it has none of (`*.xml`, `dist` at any depth)
   * stays cached. Absent, every wildcard-first output runs uncached.
   */
  tracked?: (rel: string) => TrackedKinds
  /**
   * The config file name a root-relative package's mapped tasks live beside
   * (null: none), which core holds an output to. Absent, every spelling.
   */
  ownConfig?: (rel: string) => string | null
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

/**
 * The workspace root as a project to name when turbo.json declares `//#`
 * tasks: its package name and directory. Null with no such task, a
 * nameless root, or a file the mapping refuses (it names the file).
 */
export async function rootTaskProject(root: string): Promise<{ name: string; dir: string } | null> {
  const file = await turboConfigFile(root)
  if (file === null) return null
  let turbo: { tasks?: unknown; pipeline?: unknown } | null
  let pkg: { name?: unknown } | null
  try {
    turbo = Bun.JSONC.parse(await Bun.file(file).text()) as typeof turbo
    pkg = (await Bun.file(path.join(root, 'package.json')).json()) as typeof pkg
  } catch {
    return null
  }
  const tasks = turbo?.tasks ?? turbo?.pipeline
  const hasRootTask =
    typeof tasks === 'object' &&
    tasks !== null &&
    Object.keys(tasks).some((k) => k.startsWith(`${ROOT}#`))
  if (!hasRootTask || typeof pkg?.name !== 'string' || pkg.name === '') return null
  return { name: pkg.name, dir: root }
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
const TASK_FLAGS = ['cache', 'persistent', 'interactive', 'interruptible']

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
  // Turbo counts every kind but a peer in a monorepo.
  return ['dependencies', 'devDependencies', 'optionalDependencies'].some((field) => {
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

/**
 * The packages the workspace root depends on, transitively, as root-relative
 * `<dir>/**` globs: Turbo hashes their files into its global hash
 * (`root_internal_package_dependencies_paths`), so an edit to one re-keys
 * every task. with-nestjs's root dev-depends on `@repo/eslint-config`, and
 * `api#lint` (`lint: {}`, no edge) lints with it; unread, an edit to the
 * shared rules replayed every lint from the cache.
 */
function rootDependencyGlobs(
  root: string,
  rootPkg: ProjectMeta['packageJson'],
  metas: readonly ProjectMeta[],
): string[] {
  const byName = new Map(metas.map((m) => [m.name, m]))
  const depsOf = (pkg: ProjectMeta['packageJson']): string[] =>
    (['dependencies', 'devDependencies', 'optionalDependencies'] as const).flatMap((f) => {
      const d: unknown = pkg[f]
      return d !== null && typeof d === 'object' ? Object.keys(d) : []
    })
  const seen = new Set<string>()
  const queue = depsOf(rootPkg)
  while (queue.length > 0) {
    const name = queue.pop()!
    const meta = byName.get(name)
    if (meta === undefined || seen.has(name)) continue
    seen.add(name)
    queue.push(...depsOf(meta.packageJson))
  }
  const out: string[] = []
  for (const name of seen) {
    const rel = relPosix(root, byName.get(name)!.dir)
    if (rel !== '' && rel !== '.') out.push(`${rel}/**`)
  }
  return out.sort()
}

/** The root's manifest; `{}` when it is missing or no object. */
async function rootPackageJson(root: string): Promise<ProjectMeta['packageJson']> {
  const pkg = (await Bun.file(path.join(root, 'package.json'))
    .json()
    .catch(() => null)) as unknown
  return (pkg !== null && typeof pkg === 'object' ? pkg : {}) as ProjectMeta['packageJson']
}

/**
 * The microfrontends configs Turbo hashes into every task: each package's
 * (the root's too) `microfrontends.json`, else `microfrontends.jsonc`, or
 * the one name `VC_MICROFRONTENDS_CONFIG_FILE_NAME` gives, unless it is a
 * child's `{ "partOf": … }` (Turbo's `update_turbo_json` appends them to
 * the root's global deps). Unread, an edit to `web`'s routes replayed every
 * sibling app's build (with-microfrontends, Turbo 2.11's dry run moves all
 * 18 tasks). Paths are root-relative; `text` is what the mapping read.
 */
export function microfrontendsConfigs(
  root: string,
  dirs: readonly string[],
  custom = process.env['VC_MICROFRONTENDS_CONFIG_FILE_NAME'] ?? '',
): { rel: string; text: string }[] {
  const names = custom === '' ? ['microfrontends.json', 'microfrontends.jsonc'] : [custom]
  const out: { rel: string; text: string }[] = []
  for (const dir of new Set(dirs.map((d) => path.resolve(d)))) {
    const file = names.map((n) => path.join(dir, n)).find((f) => existsSync(f))
    if (file === undefined) continue
    const text = readFileSync(file, 'utf8')
    let child = false
    try {
      const parsed = Bun.JSONC.parse(text) as { partOf?: unknown } | null
      child = typeof parsed?.partOf === 'string'
    } catch {}
    if (!child) out.push({ rel: relPosix(root, file), text })
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1))
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
  const pnp = yarnPnp(root)
  const rootTasks = tasksOf(rootCfg)

  // Turbo 1 lists an env var as `$NAME` among `globalDependencies` (and a
  // task's `dependsOn`); read as a file it was a glob that matched nothing,
  // and the var re-keyed nothing (item 909).
  const globalDeps = rootCfg.globalDependencies ?? []
  const notes: string[] = []
  // Loose mode hands every task the whole environment; vx's is isolated,
  // so a task that reads an undeclared variable ran without it, and said
  // nothing (a build baking a URL from the env built without one).
  const envMode = opts.envMode || (rootCfg.global?.envMode ?? rootCfg.envMode)
  if (envMode === 'loose') {
    notes.push(
      'envMode "loose": Turbo passes every environment variable to every task; vx passes only ' +
        'the declared ones — list what each task reads in exec.env.passThrough (or cache.inputs.env)',
    )
  } else if (
    !envMode &&
    rootCfg.tasks === undefined &&
    rootCfg.pipeline !== undefined &&
    !('globalPassThroughEnv' in rootCfg)
  ) {
    // Turbo 1's default mode, "infer", runs a task loose unless a
    // pass-through list applies to it (probed on 1.13.4: dub's and
    // trigger.dev's every task), so it read variables nobody declared.
    const loose = Object.entries(rootTasks)
      .filter(([, def]) => def?.passThroughEnv === undefined)
      .map(([name]) => name)
    if (loose.length > 0) {
      notes.push(
        `Turbo 1 runs ${loose.join(', ')} in loose env mode (no passThroughEnv, so its "infer" ` +
          'mode passes every environment variable); vx passes only the declared ones — list what ' +
          'each reads in exec.env.passThrough (or cache.inputs.env)',
      )
    }
  }
  // A wildcard names no one variable: core refuses it, and in a global
  // list that refusal failed every task of the run (item 937). Reported
  // once, as a task's own `env` wildcard is per task.
  const envNames = (field: string, names: readonly string[]): string[] =>
    explicitEnv(
      names,
      (e, literal) =>
        notes.push(envGap(field, e, literal, ' in vx env names — list explicit names')),
      opts.envNames,
    )
  // Turbo 1's `globalDotEnv` files are hashed as `globalDependencies` are
  // (item 937). A `.env`-shaped one is gitignored as a rule, and a glob
  // over git's files keyed nothing: the workspace probe keys them (item
  // 1032).
  const rootMeta = metas.find((m) => path.resolve(m.dir) === path.resolve(root))
  const globalFiles = [
    ...globalDeps.filter((d) => envDependency(d) === null),
    ...(rootCfg.globalDotEnv ?? []),
    ...rootDependencyGlobs(root, rootMeta?.packageJson ?? (await rootPackageJson(root)), metas),
    ...microfrontendsConfigs(root, [root, ...metas.map((m) => m.dir)]).map((c) => c.rel),
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

  // The workspace root as a project (a `vx.config` there, D-39) holds
  // Turbo's `//#task`s (`rootMeta`, above); Turbo runs no plain task in the root package.
  const files = new Map<string, TurboJson>([[ROOT, rootCfg]])
  for (const meta of metas) {
    if (meta === rootMeta) continue
    const file = await turboConfigFile(meta.dir)
    if (file !== null) files.set(meta.name, await readTurboJson(file, root))
  }

  const rootTaskNames = Object.keys(rootTasks)
    .filter((k) => k.startsWith(`${ROOT}#`) && !optedOut(rootTasks[k]!))
    .map((k) => k.slice(ROOT.length + 1))
  if (rootMeta === undefined) {
    for (const name of rootTaskNames) {
      notes.push(
        `note: root task ${ROOT}#${name} not migrated — the workspace root is no project; ` +
          'a root package.json name no package holds makes it one',
      )
    }
  }

  // Turbo's single-package mode: a repo with no workspaces runs turbo.json's
  // plain tasks on its root package (its `non-monorepo` example). As a
  // `//#task` holder only, the root planned nothing: "no projects declare".
  const singlePackage = rootMeta !== undefined && metas.length === 1
  const definitions = (meta: ProjectMeta) => {
    if (meta === rootMeta && !singlePackage) {
      const defined = new Set(rootTaskNames)
      const defFor = (name: string): TurboTask | undefined =>
        defined.has(name) ? definitionOf(ROOT, name, [rootCfg]) : undefined
      return { defined, defFor }
    }
    const chain = turboChain(meta.name, files)
    const defined = new Set(taskNamesFor(meta.name, chain, files))
    const defFor = (name: string): TurboTask | undefined =>
      defined.has(name) ? definitionOf(meta.name, name, chain) : undefined
    return { defined, defFor }
  }

  // First pass: which tasks does each package emit? Needed so dependsOn
  // edges can be validated/dropped against the real emitted set.
  const emitted = new Map<string, Set<string>>()
  // Which of those are persistent: a `with` sidecar maps only onto one.
  const persistentAt = new Map<string, Set<string>>()
  // The tasks with a command: a same-package edge walks through the rest
  // (item 939), groups included, so a group never waits on itself.
  const runnable = new Map<string, Set<string>>()
  // Each task's `with` targets as `pkg#task`, to keep one edge of a pair.
  const withOf = new Map<string, readonly string[]>()
  for (const meta of metas) {
    const scripts = packageScripts(meta)
    const { defined, defFor } = definitions(meta)
    const set = new Set<string>()
    const lasting = new Set<string>()
    for (const name of defined) {
      const override = commandOverride(defFor(name))
      if (override === undefined ? usableScript(scripts[name]) : override !== null) {
        set.add(name)
        if (defFor(name)?.persistent === true) lasting.add(name)
        const w = defFor(name)?.with
        if (Array.isArray(w))
          withOf.set(
            `${meta.name}#${name}`,
            w.map((e) => sidecarId(e, meta.name, rootMeta?.name)),
          )
      }
    }
    emitted.set(meta.name, set)
    runnable.set(meta.name, new Set(set))
    persistentAt.set(meta.name, lasting)
  }
  // Which script-less nodes another package's edge can reach: `^name`
  // anywhere, or `pkg#name` for that package's.
  const caretNames = new Set<string>()
  const crossIds = new Set<string>()
  for (const meta of metas) {
    const { defined, defFor } = definitions(meta)
    for (const name of defined) {
      for (const d of defFor(name)?.dependsOn ?? []) {
        if (d.startsWith('^')) caretNames.add(d.slice(1))
        else if (d.includes('#'))
          crossIds.add(
            d.startsWith(`${ROOT}#`) ? `${rootMeta?.name ?? ROOT}${d.slice(ROOT.length)}` : d,
          )
      }
    }
  }
  const scripted = new Set<string>()
  for (const set of runnable.values()) for (const name of set) scripted.add(name)
  const entry = new Set<string>()
  // A script-less task is Turbo's no-op node, and it keeps its edges. Its
  // `^` edge to its own name needs nothing (core's `^task` walks past a
  // project without the task to the nearest one with it); a `^` edge to
  // another name (rallly's script-less `build` → `^db:generate`), or an
  // edge to a task of its own package or another (with-tailwind's
  // `ui#build` → `build:styles`), is lost when
  // another package reaches the node, and a persistent `with` sidecar
  // whenever the node is run: such a node is a group task (below). One no
  // other package reaches stays none (a `test: [build]` in a package with
  // no tests adds nothing Turbo's `^` would not).
  for (const meta of metas) {
    const scripts = packageScripts(meta)
    const own = runnable.get(meta.name)!
    const { defined, defFor } = definitions(meta)
    for (const name of defined) {
      const def = defFor(name)
      if (scripts[name] !== undefined || commandOverride(def) !== undefined) continue
      const runs = (id: string, of: ReadonlyMap<string, ReadonlySet<string>>): boolean => {
        const at = id.indexOf('#')
        return of.get(id.slice(0, at))?.has(id.slice(at + 1)) === true
      }
      const sidecar = (def?.with ?? []).some((e) =>
        runs(sidecarId(e, meta.name, rootMeta?.name), persistentAt),
      )
      const local = (def?.dependsOn ?? []).some((d) => {
        if (envDependency(d) !== null || d.includes('$TURBO_ROOT$')) return false
        if (d.startsWith('^'))
          return d !== `^${name}` && [...runnable.values()].some((r) => r.has(d.slice(1)))
        if (!d.includes('#')) return d !== name && (own.has(d) || defined.has(d))
        return runs(
          d.startsWith(`${ROOT}#`) ? `${rootMeta?.name ?? ROOT}${d.slice(ROOT.length)}` : d,
          emitted,
        )
      })
      const reached = caretNames.has(name) || crossIds.has(`${meta.name}#${name}`)
      if (sidecar || (local && reached)) emitted.get(meta.name)!.add(name)
      // A name no package has a script for is an entry point of its own:
      // `turbo run ci` over `ci: { dependsOn: ["lint", "build"] }`, or
      // cal.com's `deploy` → `@calcom/web#build`, runs its edges, and vx
      // said no project declares it. Its `pkg#task` edges stay in that
      // package alone: core's `--filter`/`--affected` reach follows a task
      // edge across packages, and cal.com's `deploy` in all 116 would have
      // made every package a dependent of web.
      else if (!scripted.has(name)) {
        const kept = entryEdges(def?.dependsOn ?? [], meta.name, rootMeta?.name)
        const keeps = kept.some((d) => {
          if (envDependency(d) !== null || d.includes('$TURBO_ROOT$')) return false
          if (d.startsWith('^'))
            return d !== `^${name}` && [...runnable.values()].some((r) => r.has(d.slice(1)))
          return d !== name && (own.has(d) || defined.has(d))
        })
        if (keeps) {
          emitted.get(meta.name)!.add(name)
          entry.add(`${meta.name}#${name}`)
        }
      }
    }
  }
  // Turbo's transit node (its with-vitest example; the docs' pattern for a
  // task that runs in parallel yet re-runs on a dependency's edit):
  // `transit: { dependsOn: ["^transit"] }`, no script anywhere, and
  // `test: { dependsOn: ["transit"] }` (or `["^transit"]`). Turbo hashes the no-op per package,
  // over its files, so `test` keys on its dependencies' sources. Dropped,
  // vx keyed `test` on its own files alone: a dependency's edit was a hit.
  // Each package runs it as a key-only task, `true` and cached, as nx()'s
  // `nx-input:*` twins do.
  const withScript = new Set<string>()
  for (const set of runnable.values()) for (const name of set) withScript.add(name)
  const sameRefs = new Set<string>()
  const caretSelf = new Set<string>()
  for (const meta of metas) {
    const { defined, defFor } = definitions(meta)
    for (const name of defined) {
      for (const d of defFor(name)?.dependsOn ?? []) {
        if (d === `^${name}`) caretSelf.add(name)
        // create-t3-turbo reaches its `topo` node only as `^topo`.
        else if (d.startsWith('^')) sameRefs.add(d.slice(1))
        else if (!d.includes('#') && envDependency(d) === null) sameRefs.add(d)
      }
    }
  }
  const transit = new Set([...caretSelf].filter((n) => sameRefs.has(n) && !withScript.has(n)))
  if (transit.size > 0) {
    for (const meta of metas) {
      const { defined, defFor } = definitions(meta)
      for (const name of transit)
        if (defined.has(name) && commandOverride(defFor(name)) === undefined) {
          emitted.get(meta.name)!.add(name)
          runnable.get(meta.name)!.add(name)
        }
    }
  }
  // The same no-op node in a package that lacks a script others run:
  // with-vite's `ui` has no `build`, its apps bundle it, and Turbo's
  // `ui#build` hashes ui's files into theirs. Walked past, vx's `^build`
  // folded nothing of ui, and an edit to it replayed both apps (a stale
  // hit). Key-only too, with no outputs: Turbo's no-op cleans nothing.
  const keyOnly = new Map<string, Set<string>>()
  for (const meta of metas) {
    const scripts = packageScripts(meta)
    const { defined, defFor } = definitions(meta)
    for (const name of defined) {
      const def = defFor(name)
      if (!caretSelf.has(name) || !withScript.has(name) || transit.has(name)) continue
      if (scripts[name] !== undefined || commandOverride(def) !== undefined) continue
      if (emitted.get(meta.name)!.has(name)) continue
      if (def?.cache === false || def?.persistent === true) continue
      emitted.get(meta.name)!.add(name)
      runnable.get(meta.name)!.add(name)
      let set = keyOnly.get(meta.name)
      if (set === undefined) keyOnly.set(meta.name, (set = new Set()))
      set.add(name)
    }
  }
  const emittedAnywhere = new Set<string>()
  for (const set of emitted.values()) for (const name of set) emittedAnywhere.add(name)

  // A live mapping infers as Turbo does: the prefix joins each task's env
  // list, where the task's own `!` entries can take names back.
  const inferredOf = new Map<string, readonly string[]>()
  const usersOf = new Map<(typeof FRAMEWORK_ENV)[number], string[]>()
  for (const m of metas) {
    if (emitted.get(m.name)!.size === 0) continue
    const fw = FRAMEWORK_ENV.find((f) =>
      f.all
        ? f.dependencies.every((d) => declares(m, d))
        : f.dependencies.some((d) => declares(m, d)),
    )
    if (fw === undefined) continue
    if (opts.envNames !== undefined) {
      const live = opts.envNames
      const vendor = opts.vendorEnvPrefix
      const names = fw.env.flatMap((e) => {
        if (!e.endsWith('*')) return [e]
        const head = e.slice(0, -1)
        return live.filter((n) => n.startsWith(head)).sort()
      })
      inferredOf.set(m.name, vendor ? names.filter((n) => !n.startsWith(vendor)) : names)
    } else usersOf.set(fw, [...(usersOf.get(fw) ?? []), m.name])
  }
  for (const [fw, users] of usersOf)
    notes.push(
      `Turbo infers ${fw.slug} in ${users.join(', ')} and hashes and passes ${fw.env.join(', ')} to ` +
        'its tasks; vx env names are explicit — list the ones they read in cache.inputs.env ' +
        'and exec.env.passThrough',
    )

  const projects: TurboMappedProject[] = []
  for (const meta of metas) {
    const scripts = packageScripts(meta)
    const own = runnable.get(meta.name)!
    const { defined, defFor } = definitions(meta)
    const tasks: TurboMappedTask[] = []
    for (const name of defined) {
      const override = commandOverride(defFor(name))
      if (override === null) continue
      const script = scripts[name]
      const noop = keyOnly.get(meta.name)?.has(name) === true
      if (
        override === undefined &&
        script === undefined &&
        ((transit.has(name) && own.has(name)) || noop)
      ) {
        tasks.push(
          buildTask(
            name,
            noop ? { ...defFor(name)!, outputs: [] } : defFor(name)!,
            'true',
            own,
            defFor,
            emitted,
            emittedAnywhere,
            globals,
            opts,
            relPosix(root, meta.dir),
            rootDotenv,
            rootMeta?.name,
            { name: meta.name, persistentAt, withOf },
            inferredOf.get(meta.name) ?? [],
          ),
        )
        continue
      }
      if (override === undefined && script === undefined && emitted.get(meta.name)!.has(name)) {
        // No script, but edges Turbo's no-op node keeps (above): a group
        // task depending on them does the same (with-tailwind's `ui#dev`
        // starts `dev:styles` and `dev:components`; its `ui#build` builds
        // `build:styles` and `build:components`).
        const groupDef = entry.has(`${meta.name}#${name}`)
          ? {
              ...defFor(name)!,
              dependsOn: entryEdges(defFor(name)!.dependsOn ?? [], meta.name, rootMeta?.name),
            }
          : defFor(name)!
        const t = buildTask(
          name,
          groupDef,
          '',
          own,
          defFor,
          emitted,
          emittedAnywhere,
          globals,
          opts,
          relPosix(root, meta.dir),
          rootDotenv,
          rootMeta?.name,
          { name: meta.name, persistentAt, withOf },
          inferredOf.get(meta.name) ?? [],
        )
        // Emitted even when its edges all drop: other packages' edges were
        // validated against it, and `dependsOn: []` is a group that waits
        // on nothing.
        const deps = t.task?.['dependsOn']
        tasks.push({
          name,
          todos: t.todos.filter((x) => x !== opts.persistentTodo),
          task: { dependsOn: Array.isArray(deps) ? deps : [] },
          uses: new Set(),
        })
        continue
      }
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
      const command = override ?? scriptCommand(name, script as string, scripts, pnp)
      const mapped = buildTask(
        name,
        defFor(name)!,
        command,
        own,
        defFor,
        emitted,
        emittedAnywhere,
        globals,
        opts,
        relPosix(root, meta.dir),
        rootDotenv,
        rootMeta?.name,
        { name: meta.name, persistentAt, withOf },
        inferredOf.get(meta.name) ?? [],
      )
      if (override === undefined && mapped.task !== null)
        npmScriptEnv(mapped.task, name, command === script, meta, opts)
      tasks.push(mapped)
    }
    resolveSharedOutputs(tasks)
    projects.push({ name: meta.name, dir: meta.dir, tasks })
  }

  resolveSharedWorkspaceOutputs(root, projects)
  pruneOrphanPersistentNotes(projects, opts.persistentTodo)
  return { projects, notes, globals }
}

/**
 * A name both a global list and the task's own list carry — `globalEnv`
 * and a task `env`, `globalDependencies` and a `$TURBO_ROOT$/` input —
 * is listed once, in its first position. `spliced` names the global values
 * an opaque preset spread already holds (`vx-migrate`'s configs): written
 * twice there, a migrated config listed `tsconfig.base.json` twice and
 * keyed apart from the live `turbo()` run, which lists it once.
 */
function uniq(values: readonly unknown[], spliced: readonly string[] = []): unknown[] {
  const seen = new Set<string>(spliced)
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

/** A `with` entry as `pkg#task`: bare is the task's own package, `//#` the root. */
function sidecarId(entry: string, own: string, rootName: string | undefined): string {
  const hashAt = entry.indexOf('#')
  if (hashAt === -1) return `${own}#${entry}`
  return entry.startsWith(`${ROOT}#`) ? `${rootName ?? ROOT}${entry.slice(ROOT.length)}` : entry
}

/**
 * The `npm_*` variables Turbo's tasks see: it runs a script through the
 * package manager (`pnpm run build`), which sets them, and vx runs the
 * body itself, so `echo $npm_package_version` printed nothing. The event
 * is the script's own name, which folded `pre`/`post` hooks do not share
 * (core's `vx init` rule, D-34).
 */
function npmScriptEnv(
  task: Record<string, unknown>,
  script: string,
  unfolded: boolean,
  meta: ProjectMeta,
  opts: MapTurboOptions,
): void {
  const exec = task['exec'] as { command: string; env?: Record<string, unknown> }
  // Only a command that names one gets them, as core's `vx init` does: a
  // written config reads the manifest through a JSON import, which a
  // user's `tsc` over the package may refuse (G-123), and a live mapping
  // keys as the written one does, so the two share a cache.
  const named = new Set([...exec.command.matchAll(/\$\{?(npm_[A-Za-z0-9_]+)/g)].map((m) => m[1]))
  const wanted = (v: string) => named.has(v)
  const field = (key: 'name' | 'version', value: string): unknown =>
    opts.manifestField?.(key) ?? value
  const define: Record<string, unknown> = {}
  if (wanted('npm_package_name')) define['npm_package_name'] = field('name', meta.name)
  const version = meta.packageJson.version
  if (typeof version === 'string' && version !== '' && wanted('npm_package_version'))
    define['npm_package_version'] = field('version', version)
  if (unfolded && wanted('npm_lifecycle_event')) define['npm_lifecycle_event'] = script
  if (Object.keys(define).length > 0) exec.env = { ...exec.env, define }
}

/**
 * An entry group's edges in one package: `pkg#task` is that package's own
 * task there and nobody's elsewhere (`//#task` the root's).
 */
function entryEdges(deps: readonly string[], pkg: string, rootName: string | undefined): string[] {
  return deps.flatMap((d) => {
    if (d.startsWith('^') || !d.includes('#') || envDependency(d) !== null) return [d]
    const at = d.indexOf('#')
    const owner = d.slice(0, at) === ROOT ? (rootName ?? ROOT) : d.slice(0, at)
    return owner === pkg ? [d.slice(at + 1)] : []
  })
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
  rootName: string | undefined,
  sidecars: {
    readonly name: string
    readonly persistentAt: ReadonlyMap<string, ReadonlySet<string>>
    readonly withOf: ReadonlyMap<string, readonly string[]>
  },
  inferred: readonly string[],
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
  // The global names a splice holds out of `uniq`'s sight: an opaque
  // preset spread (`vx-migrate`), never the names themselves (`turbo()`).
  const hidden = (...kinds: TurboGlobal[]): string[] =>
    kinds.flatMap((k) =>
      opts.splice(k, globals[k]).some((v) => typeof v !== 'string') ? globals[k] : [],
    )
  const persistent = def.persistent === true
  const cacheEnabled = def.cache !== false && !persistent

  for (const [key, value] of Object.entries(def)) {
    if (KNOWN_TASK_KEYS.has(key)) continue
    // Turbo hands an interactive task the terminal's stdin in its TUI; vx
    // hands no task the terminal (runner.ts), so a prompt there reads end
    // of input (create-t3-turbo's \`drizzle-kit push\`). Nothing to map.
    if (key === 'interactive') {
      if (value === true) {
        todos.push(
          'turbo key "interactive": vx gives no task the terminal, so a prompt reads end of ' +
            'input — run a task that asks for input outside vx',
        )
      }
      continue
    }
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
          `dependsOn ${JSON.stringify(d)} uses $TURBO_ROOT$, which names no task — ` +
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
        // `//#x` is the root project's `x`, named as vx names it.
        const pkg = d.startsWith(`${ROOT}#`) ? (rootName ?? ROOT) : d.slice(0, hashAt)
        const task = d.slice(hashAt + 1)
        if (emitted.get(pkg)?.has(task)) {
          const edge = `${pkg}#${task}`
          if (!deps.includes(edge)) deps.push(edge)
        } else if (pkg === ROOT)
          todos.push(
            `dependsOn ${JSON.stringify(d)}: the workspace root is no project — edge dropped; ` +
              'a root package.json name no package holds makes it one',
          )
        // A package outside the workspace (highlight's `rrweb`, a submodule
        // not checked out) is no script gap.
        else if (!emitted.has(pkg))
          todos.push(
            `dependsOn ${JSON.stringify(d)}: no workspace package is named ${pkg} — edge dropped`,
          )
        else
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

  // `with`: tasks Turbo runs alongside this one (`web#dev` with
  // `api#dev`). An edge to a persistent task is that: vx starts the
  // dependant once the sidecar has spawned, and runs it only when this
  // one runs. An edge to a task that ends would wait for it instead.
  const self = `${sidecars.name}#${name}`
  for (const w of def.with ?? []) {
    const id = sidecarId(w, sidecars.name, rootName)
    const hashAt = id.indexOf('#')
    const pkg = id.slice(0, hashAt)
    const task = id.slice(hashAt + 1)
    if (!sidecars.persistentAt.get(pkg)?.has(task)) {
      todos.push(
        `with ${JSON.stringify(w)}: ${emitted.get(pkg)?.has(task) ? 'not a persistent task' : `${pkg} declares no ${task} script`} — ` +
          'run it beside this one by hand',
      )
      continue
    }
    // Turbo runs a pair that names each other side by side; as two edges
    // they are a cycle core refuses. One edge, the same way round each time.
    if (id === self || (sidecars.withOf.get(id)?.includes(self) && id > self)) continue
    const edge = pkg === sidecars.name ? task : id
    if (!deps.includes(edge)) deps.push(edge)
  }

  const envNames: string[] = explicitEnv(
    [...inferred, ...envDeps, ...(def.env ?? [])],
    (e, literal) =>
      todos.push(
        envGap(
          'env',
          e,
          literal,
          ' in vx env names — list explicit names in cache.inputs.env + exec.env.passThrough',
        ),
      ),
    opts.envNames,
  )
  const passNames: string[] = explicitEnv(
    def.passThroughEnv ?? [],
    (e, literal) => todos.push(envGap('passThroughEnv', e, literal, ' — list explicit names')),
    opts.envNames,
  )

  const passThrough = uniq(
    [...global('env'), ...global('pass'), ...envNames, ...passNames],
    hidden('env', 'pass'),
  )

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
    // Any of them below the package root needs the walk.
    let pkgDotenvDeep = false
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
          else {
            pkgDotenv = true
            if (body.includes('/')) pkgDotenvDeep = true
          }
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

    const wild = wildcardOutput(outFiles, opts.tracked?.(pkgDir))
    if (wild !== undefined) {
      todos.push(wildcardTodo(wild))
      return { name, todos, task, uses }
    }
    const own = ownFileOutput(outFiles, opts.ownConfig?.(pkgDir))
    if (own !== undefined) {
      todos.push(ownFileTodo(own))
      return { name, todos, task, uses }
    }

    const cacheEnv = uniq([...global('env'), ...envNames], hidden('env'))

    // Turbo hashes a root task over the whole repo; core stops a root
    // project's own globs at every member (D-39), so as `files` a root
    // `oxlint` over the repo replayed green after a member file broke.
    // A root task's globs are the workspace's, outputs too.
    if (pkgDir === '' || pkgDir === '.') {
      wsFiles.unshift(...files.splice(0))
      wsOutFiles.unshift(...outFiles.splice(0))
    }
    const inputs: Record<string, unknown> = { files }
    if (wsFiles.length > 0) inputs.workspaceFiles = uniq(wsFiles, hidden('inputs'))
    if (cacheEnv.length > 0) inputs.env = cacheEnv
    if (pkgDotenv) inputs.runtime = [pkgDotenvDeep ? DOTENV_PROBE : DOTENV_PROBE_TOP]
    if (wsDotenv) inputs.workspaceRuntime = [DOTENV_PROBE]
    const outputs: Record<string, unknown> = { files: takingBack(outFiles) }
    const ws = takingBack(wsOutFiles)
    if (ws.length > 0) outputs.workspaceFiles = ws
    task.cache = { inputs, outputs }
  }

  return { name, todos, task, uses }
}
