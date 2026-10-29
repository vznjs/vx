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
import { isLiteralPattern, pruneOrphanPersistentNotes, UserError } from '@vzn/vx'
import type { PackageMeta } from '../packages.js'
import { refuseTaskNames } from '../plugin-gaps.js'
import { literalGlob, minimatchToVx, withoutTakenBack } from '../glob-grammar.js'
import { shellQuote } from '../nx-command.js'
import { type Owner, runsScriptHooks, scriptCommand, yarnPnp } from '../script-command.js'
import {
  ownFileTakeBacks,
  excludeSiblingOutputs,
  excludeWorkspaceOutputs,
  resolveSharedOutputs,
  resolveSharedWorkspaceOutputs,
  takingBack,
  unkey,
  wildcardCleanTodo,
  wildcardOutput,
  wildcardTodo,
} from '../shared-outputs.js'
import { manifestGraph, type ManifestGraph } from '../manifest-graph.js'
import { isRecord, packageScripts, relPosix } from '../paths.js'
import {
  FRAMEWORK_ENV,
  keyable,
  microfrontendsConfigs,
  ROOT,
  turboConfigFile,
} from './turbo-reads.js'
import type { TrackedKinds } from '../tracked-outputs.js'
import {
  DOTENV_PROBE,
  DOTENV_PROBE_TOP,
  dotenvGlobsProbe,
  ignoredFilesProbe,
} from '../dotenv-probe.js'

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

const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

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
  spelled?: { readonly names: readonly string[]; readonly used: (entry: string) => void },
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
    } else if (spelled !== undefined) {
      // A written config cannot ask the run's environment: the names the
      // package's files spell stand in for it (clerk's root `E2E_*`), the
      // bare prefix no name.
      const re = regex(parts)
      const bare = parts.join('')
      const hits = spelled.names.filter((n) => n !== bare && re.test(n) && keyable(n))
      if (hits.length === 0) gap(e, null)
      else {
        out.push(...hits)
        spelled.used(e)
      }
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
  'interactive',
  'extends',
  'outputLogs',
  // `outputLogs` as Turbo 1 spells it (renamed in 2.0; 1.13 still reads it).
  'outputMode',
  'dotEnv',
  'command',
  'description',
  // `turbo watch` restarts a persistent task only when it says so; `vx
  // watch` keeps it up and restarts it only when its config changes or it
  // dies, so either value maps to nothing.
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
   * What a task's array holds for one global field: `bunx @vzn/vx-migrate` splices a
   * preset import (`{ raw: '...globalInputs' }`), the plugin the values
   * themselves. Called only for a global that is non-empty.
   */
  splice(kind: TurboGlobal, values: readonly string[]): readonly unknown[]
  /** The TODO attached to a persistent task, in the consumer's words. */
  persistentTodo: string
  /**
   * A task's `npm_package_name` / `npm_package_version`: `bunx @vzn/vx-migrate` reads
   * them from the manifest it imports (`{ raw: 'pkg.version' }`), so a bump
   * reaches them; absent, the values themselves.
   */
  manifestField?(key: 'name' | 'version'): unknown
  /**
   * The environment's variable names, when the mapping runs where the tasks
   * will (`turbo()`): an env wildcard (`NEXT_PUBLIC_*`) expands over them.
   * Absent (`bunx @vzn/vx-migrate` writes files), a wildcard is a todo.
   */
  envNames?: readonly string[]
  /**
   * Without `envNames` (written configs): the upper-case names the files
   * under `dirs` spell, which a framework's `*` prefix is matched against.
   */
  sourceNames?: (dirs: readonly string[]) => Promise<readonly string[]>
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
  /**
   * Which root-relative paths git ignores (`gitIgnored`): an input named by
   * path among them is keyed by a probe. Absent, none is.
   */
  ignored?: (rels: readonly string[]) => Promise<ReadonlySet<string>>
  /**
   * The `.tsbuildinfo` files a root-relative package's command writes,
   * relative to the package (`tscBuildInfo`). Absent, none.
   */
  buildInfo?: (rel: string, command: string) => readonly string[]
}

/**
 * A cacheable task's inputs and what its turbo.json names literally: each
 * path root-relative, and the list and entry that name it (none: a global
 * already left out).
 */
interface Literals {
  readonly inputs: Record<string, unknown>
  readonly rels: ReadonlyMap<string, Named>
}
type Named = readonly ['files' | 'workspaceFiles' | null, string]

/**
 * X for a Turbo glob `X/**` whose X has a wildcard, else null. Turbo's
 * trailing `/**` matches zero segments too (doublestar v4: `**` is zero or
 * more path segments, so `*\/**` matches `tsconfig.tsbuildinfo` at the
 * package root); vx's matches only below X, and medusa's `*\/**` build lost
 * its root `tsconfig.tsbuildinfo` on a restore. A literal X is left as is:
 * it names the output directory, which `X/**` already covers.
 */
function zeroSegments(glob: string): string | null {
  if (!glob.endsWith('/**')) return null
  const head = glob.slice(0, -'/**'.length)
  // An escaped character (`literalGlob`'s `g\{1\}`) is no wildcard.
  return head === '' || isLiteralPattern(head.replace(/\\./g, '_')) ? null : head
}

/** A glob, `!` or not, and the X its `X/**` also matches in Turbo (`zeroSegments`). */
function withZeroSegments(glob: string): string[] {
  const neg = glob.startsWith('!') ? '!' : ''
  const head = zeroSegments(glob.slice(neg.length))
  return head === null ? [glob] : [glob, neg + head]
}

/** Does a positive glob of `globs` take `rel`, and no `!` give it back? */
function covers(globs: readonly string[], rel: string): boolean {
  const hit = (g: string) => new Bun.Glob(g).match(rel)
  return (
    globs.some((g) => !g.startsWith('!') && hit(g)) &&
    !globs.some((g) => g.startsWith('!') && hit(g.slice(1)))
  )
}

/** No glob syntax: one path, which git may ignore. */
const isLiteral = (glob: string): boolean => !/[*?[\]{}()!]/.test(glob)

/**
 * Keys gitignored paths (root-relative, with what names them) by a probe and takes
 * their entries out of the file lists. A global one was never put there.
 */
function keyIgnored(
  inputs: Record<string, unknown>,
  hits: readonly (readonly [string, Named])[],
): void {
  for (const kind of ['files', 'workspaceFiles'] as const) {
    const list = inputs[kind] as unknown[] | undefined
    const entries = new Set(hits.flatMap(([, [k, e]]) => (k === kind ? [e] : [])))
    if (list === undefined || entries.size === 0) continue
    const kept = list.filter((e) => typeof e !== 'string' || !entries.has(e))
    // Exclusions left alone narrow nothing core will take.
    const left = kept.some((e) => typeof e !== 'string' || !e.startsWith('!')) ? kept : []
    if (kind === 'files') inputs.files = left
    else if (left.length > 0) inputs.workspaceFiles = left
    else delete inputs.workspaceFiles
  }
  const probes = (inputs.workspaceRuntime as unknown[] | undefined) ?? []
  inputs.workspaceRuntime = [...probes, ignoredFilesProbe(hits.map(([rel]) => rel))]
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
      for (const k of ['outputLogs', 'outputMode'])
        if (d[k] !== undefined && typeof d[k] !== 'string') refuse(`${at}.${k}`, 'a string')
    }
  }
}

function tasksOf(cfg: TurboJson): Record<string, TurboTask> {
  return cfg.tasks ?? cfg.pipeline ?? {}
}

/** A turbo.json's own task `key`: a plain index reads `constructor` off Object. */
function taskAt(tasks: Record<string, TurboTask>, key: string): TurboTask | undefined {
  return Object.hasOwn(tasks, key) ? tasks[key] : undefined
}

function declares(meta: PackageMeta, dependency: string): boolean {
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
  const def = taskAt(tasks, `${pkgName}#${name}`) ?? taskAt(tasks, name)
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
    return i === 0
      ? (taskAt(tasks, `${pkgName}#${name}`) ?? taskAt(tasks, name))
      : taskAt(tasks, name)
  })
  let from = 0
  for (let i = defs.length - 1; i > 0; i--) {
    if (defs[i]?.extends === false) {
      from = i
      break
    }
  }
  let def: TurboTask = {}
  let fromDeps: DependencyOutputs | null = null
  for (const d of defs.slice(from)) {
    if (d === undefined) continue
    const own: TurboTask = { ...d }
    delete own.extends
    if (Array.isArray(own.inputs)) {
      const found = dependencyOutputsOf(own.inputs)
      if (found !== null || !own.inputs.includes(TURBO_EXTENDS)) fromDeps = found
      own.inputs = flatInputs(own.inputs)
    }
    def = withOverlay(def, own)
  }
  if (fromDeps !== null) dependencyOutputs.set(def, fromDeps)
  return def
}

/** A task's `{ mode: "dependencyOutputs" }` input: the producers it names, and which of their files. */
interface DependencyOutputs {
  from: readonly string[] | null
  globs: readonly string[]
}

/** Held beside a resolved definition, out of the keys the unknown-key check reads. */
const dependencyOutputs = new WeakMap<TurboTask, DependencyOutputs>()

function dependencyOutputsOf(inputs: readonly unknown[]): DependencyOutputs | null {
  for (const i of inputs) {
    if (i === null || typeof i !== 'object') continue
    const { mode, from, globs } = i as { mode?: unknown; from?: unknown; globs?: unknown }
    if (mode !== 'dependencyOutputs') continue
    const strings = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((g): g is string => typeof g === 'string') : []
    return { from: Array.isArray(from) ? strings(from) : null, globs: strings(globs) }
  }
  return null
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
  rootPkg: PackageMeta['packageJson'],
  metas: readonly PackageMeta[],
): string[] {
  const byName = new Map(metas.map((m) => [m.name, m]))
  const depsOf = (pkg: PackageMeta['packageJson']): string[] =>
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
    if (rel !== '' && rel !== '.') out.push(`${literalGlob(rel)}/**`)
  }
  return out.sort()
}

/** The root's manifest; `{}` when it is missing or no object. */
async function rootPackageJson(root: string): Promise<PackageMeta['packageJson']> {
  const pkg = (await Bun.file(path.join(root, 'package.json'))
    .json()
    .catch(() => null)) as unknown
  return (pkg !== null && typeof pkg === 'object' ? pkg : {}) as PackageMeta['packageJson']
}

export async function mapTurboWorkspace(
  root: string,
  metas: readonly PackageMeta[],
  opts: MapTurboOptions,
): Promise<TurboMapping> {
  // A workspace with no Turbo config answered with a bare ENOENT and a stack
  // (item 1043): turbo() declared in the wrong repo, or its file removed.
  const rootFile = await turboConfigFile(root)
  if (rootFile === null) {
    throw new UserError(
      `no turbo.json or turbo.jsonc at the workspace root (${root}): turbo() maps a Turbo repo's config — add one, or remove turbo() from .vx/workspace.ts`,
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
        'the declared ones — list what each task reads in exec.env.passThrough (or inputs.env)',
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
          'each reads in exec.env.passThrough (or inputs.env)',
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
    // Turbo 2 added the root's dependencies to its global hash; 1.13.4's
    // leaves them out (trigger.dev: a Prisma migration re-keyed only the
    // packages that depend on the database package).
    ...(rootCfg.tasks === undefined && rootCfg.pipeline !== undefined
      ? []
      : rootDependencyGlobs(root, rootMeta?.packageJson ?? (await rootPackageJson(root)), metas)),
    ...microfrontendsConfigs(root, [root, ...metas.map((m) => m.dir)]).map((c) => c.rel),
  ]
  const rootDotenv = globalFiles.filter((f) => isDotenvGlob(f))
  // Turbo globs an explicit input on the disk, gitignored or not. Core
  // refuses a literal input git ignores (it would key nothing), so a
  // `config.local.json` in globalDependencies ran every task uncached: a
  // probe keys each such path instead. One `git check-ignore` per kind.
  const globalIgnored = [
    ...(await (opts.ignored?.(globalFiles.filter(isLiteral)) ?? new Set<string>())),
  ].filter((f) => !isDotenvGlob(f))
  const globals = {
    inputs: globalFiles.filter((f) => !isDotenvGlob(f) && !globalIgnored.includes(f)),
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
  const definitions = (meta: PackageMeta) => {
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
  // whenever the node is run: such a node is a group task (below). So are
  // the edges of a package nothing depends on: no `^` reaches its `build`,
  // and `turbo run type-check` built ai's 16 examples through their
  // script-less `type-check: [build]` while vx built none. One no other
  // package reaches in a package something depends on stays none (a
  // `test: [build]` in a package with no tests adds nothing its
  // dependants' `^build` does not).
  let graph: ManifestGraph | undefined
  // The root runs only its `//#` tasks, so its dependencies are no reach
  // (ai's root dev-depends on `konsistent-provider`).
  const depended = (pkg: string): boolean =>
    (graph ??= manifestGraph(metas)).transitiveDependents(pkg).some((d) => d !== rootMeta?.name)
  const sidecarGroups = new Set<string>()
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
      if (sidecar) sidecarGroups.add(`${meta.name}#${name}`)
      // A name no package has a script for is the entry rule's (below).
      const leaf = (): boolean => scripted.has(name) && !depended(meta.name)
      if (sidecar || (local && (reached || leaf()))) emitted.get(meta.name)!.add(name)
      // A name no package has a script for is an entry point of its own:
      // `turbo run ci` over `ci: { dependsOn: ["lint", "build"] }`, or
      // cal.com's `deploy` → `@calcom/web#build`, runs its edges, and vx
      // said no project declares it. With no edge left (documenso's `lint`,
      // shadcn-ui's `check`) Turbo still runs a no-op node per package and
      // exits 0, so a CI step `vx run lint` must too. Its `pkg#task` edges
      // stay in that package alone: core's `--filter`/`--affected` reach
      // follows a task edge across packages, and cal.com's `deploy` in all
      // 116 would have made every package a dependent of web.
      else if (!scripted.has(name)) {
        emitted.get(meta.name)!.add(name)
        entry.add(`${meta.name}#${name}`)
      }
    }
  }
  // Turbo's transit node (its with-vitest example; the docs' pattern for a
  // task that runs in parallel yet re-runs on a dependency's edit):
  // `transit: { dependsOn: ["^transit"] }`, no script anywhere, and
  // `test: { dependsOn: ["transit"] }` (or `["^transit"]`). Turbo hashes the no-op per package,
  // over its files, so `test` keys on its dependencies' sources. Dropped,
  // vx keyed `test` on its own files alone: a dependency's edit was a hit.
  // Each package has it as a key-only task, a keyed group, as nx()'s
  // `inputs:*` twins are.
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
  // One with edges of its own (with-shell-commands' `tooling-config#build`
  // → `prebuild`) was a group, which keys nothing: Turbo's node still
  // hashes the package's files, so it is key-only with its edges. A node
  // that starts persistent sidecars stays a group. One a `^name` reaches
  // whose own edges lack `^name` (opencode's `build: { dependsOn: [] }`)
  // is key-only too: Turbo's `^build` stops at it, and core's walked past
  // it to the builds below, running and keying ones Turbo never waits on.
  const keyOnly = new Map<string, Set<string>>()
  for (const meta of metas) {
    const scripts = packageScripts(meta)
    const { defined, defFor } = definitions(meta)
    const depended = metas.some((m) => m !== meta && declares(m, meta.name))
    for (const name of defined) {
      const def = defFor(name)
      const stops = depended && caretNames.has(name) && !(def?.dependsOn ?? []).includes(`^${name}`)
      if (!(caretSelf.has(name) || stops) || !withScript.has(name) || transit.has(name)) continue
      if (scripts[name] !== undefined || commandOverride(def) !== undefined) continue
      if (sidecarGroups.has(`${meta.name}#${name}`)) continue
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
  // The names a package's files and its workspace dependencies' spell, once.
  const spelledMemo = new Map<string, Promise<readonly string[]>>()
  const spelledBy = (m: PackageMeta): Promise<readonly string[]> => {
    let names = spelledMemo.get(m.name)
    if (names === undefined) {
      const closure = new Set<PackageMeta>([m])
      for (const p of closure)
        for (const d of metas) if (!closure.has(d) && declares(p, d.name)) closure.add(d)
      names = opts.sourceNames!([...closure].map((p) => p.dir))
      spelledMemo.set(m.name, names)
    }
    return names
  }
  const usersOf = new Map<(typeof FRAMEWORK_ENV)[number], string[]>()
  const sourcedOf = new Map<(typeof FRAMEWORK_ENV)[number], string[]>()
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
    } else if (opts.sourceNames !== undefined) {
      // A written config cannot ask the run's environment, and with the
      // prefix only in a note, a migrated Next build inlined every
      // NEXT_PUBLIC_ value empty. The names the package's own files spell
      // are what its build reads, and so are its workspace dependencies':
      // Next bundles their source (cal.com's web spells 23, with them 58).
      const spelled = await spelledBy(m)
      inferredOf.set(
        m.name,
        // The bare prefix is no name: formbricks' web spells `NEXT_PUBLIC_`
        // in a `startsWith` test, and the configs keyed a variable of it.
        fw.env.flatMap((e) => {
          if (!e.endsWith('*')) return [e]
          const head = e.slice(0, -1)
          return spelled.filter((n) => n.startsWith(head) && n.length > head.length)
        }),
      )
      sourcedOf.set(fw, [...(sourcedOf.get(fw) ?? []), m.name])
    } else usersOf.set(fw, [...(usersOf.get(fw) ?? []), m.name])
  }
  // One short line per framework: nitro's twelve names and a long package
  // list ran past any terminal (Growth's first-run funnel F7, 2026-10-13).
  const few = (list: readonly string[]): string =>
    list.length <= 3
      ? list.join(', ')
      : `${list.slice(0, 3).join(', ')} and ${list.length - 3} more`
  for (const [fw, users] of sourcedOf)
    notes.push(
      `${fw.slug} in ${few(users)}: Turbo passes ${few(fw.env)} implicitly; the configs list ` +
        'the names the package and its workspace dependencies spell, so add any an installed ' +
        'dependency reads to inputs.env and exec.env.passThrough',
    )
  for (const [fw, users] of usersOf)
    notes.push(
      `${fw.slug} in ${few(users)}: Turbo passes ${few(fw.env)} implicitly; list the ones ` +
        'they read in inputs.env and exec.env.passThrough',
    )

  // A task's own `*` env name, in a written config: expanded over the
  // names its package spells (`explicitEnv`), each entry noted once.
  const wildcardUses = new Map<string, number>()
  const spelledOf = new Map<
    string,
    { readonly names: readonly string[]; readonly used: (entry: string) => void }
  >()
  if (opts.envNames === undefined && opts.sourceNames !== undefined)
    for (const meta of metas) {
      const { defined, defFor } = definitions(meta)
      const wild = [...defined].some((name) =>
        [...(defFor(name)?.env ?? []), ...(defFor(name)?.passThroughEnv ?? [])].some(
          (e) => !e.startsWith('!') && /(?<!\\)\*/.test(e),
        ),
      )
      if (!wild) continue
      spelledOf.set(meta.name, {
        names: await spelledBy(meta),
        used: (e) => wildcardUses.set(e, (wildcardUses.get(e) ?? 0) + 1),
      })
    }

  const projects: TurboMappedProject[] = []
  const hookMemo = new Map<string, Owner>()
  const literals = { tasks: [] as Literals[], globalIgnored }
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
      // Core gives a project with no `build` this very node (a group behind
      // `^build`, keyed on the project's files), so writing it is noise:
      // solid's three script-less packages each got a key-only `build`.
      const noopEdges = defFor(name)!.dependsOn ?? []
      if (
        noop &&
        name === 'build' &&
        noopEdges.includes('^build') &&
        noopEdges.every((d) => d === '^build')
      )
        continue
      if (
        override === undefined &&
        script === undefined &&
        ((transit.has(name) && own.has(name)) || noop)
      ) {
        tasks.push(
          keyOnlyGroup(
            buildTask(
              literals,
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
              spelledOf.get(meta.name),
            ),
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
          literals,
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
          spelledOf.get(meta.name),
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
      // Turbo runs `<pm> run <name>`: the hooks fold only where the manager runs them.
      const hooks = runsScriptHooks(meta.dir, hookMemo) === null ? {} : scripts
      const command = override ?? scriptCommand(name, script as string, hooks, pnp)
      const mapped = buildTask(
        literals,
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
        spelledOf.get(meta.name),
      )
      if (override === undefined && mapped.task !== null)
        npmScriptEnv(mapped.task, name, command === script, meta, opts)
      tasks.push(mapped)
    }
    excludeSiblingOutputs(resolveSharedOutputs(tasks))
    projects.push({ name: meta.name, dir: meta.dir, tasks })
  }

  // Turbo 2.11's `dependencyOutputs` input hashes the named files after
  // their producer ran. A cached producer's key already reaches the reader
  // through `dependsOn`, its outputs following from it; an uncached one's
  // (vercel/vercel's `//#generate:cache-keys`, which records the host) do
  // not, and a test cached on one platform hit on another. The reader
  // keys those files by a probe at the workspace root.
  const metaNamed = new Map(metas.map((m) => [m.name, m]))

  // An entry group's `//#task` edge is the root's, and the root has no
  // group of that name (it runs only `//#` tasks): left to `entryEdges`,
  // `deploy → //#format` ran no format, where `turbo run deploy` runs it.
  // The root gets the group, edges to its own tasks only, unless it
  // declares the name itself.
  const rootProject =
    rootMeta === undefined || singlePackage
      ? undefined
      : projects.find((p) => p.name === rootMeta.name)
  if (rootProject !== undefined) {
    const rootRuns = emitted.get(rootProject.name)!
    const groups = new Map<string, string[]>()
    for (const id of entry) {
      const at = id.indexOf('#')
      const pkg = metaNamed.get(id.slice(0, at))
      const name = id.slice(at + 1)
      if (pkg === undefined || pkg === rootMeta || rootRuns.has(name)) continue
      for (const d of definitions(pkg).defFor(name)?.dependsOn ?? []) {
        const task = d.slice(ROOT.length + 1)
        if (!d.startsWith(`${ROOT}#`) || !rootRuns.has(task)) continue
        const edges = groups.get(name) ?? []
        if (!edges.includes(task)) edges.push(task)
        groups.set(name, edges)
      }
    }
    for (const [name, dependsOn] of groups)
      rootProject.tasks.push({ name, todos: [], task: { dependsOn }, uses: new Set() })
  }
  for (const meta of metas) {
    const { defFor } = definitions(meta)
    for (const t of projects.find((p) => p.name === meta.name)?.tasks ?? []) {
      const def = defFor(t.name)
      const dep = def === undefined ? undefined : dependencyOutputs.get(def)
      const inputs = t.task?.['inputs'] as Record<string, unknown> | undefined
      if (dep === undefined || inputs === undefined) continue
      const rels: string[] = []
      const unfold = new Set<string>()
      for (const sel of dep.from ?? def!.dependsOn ?? []) {
        if (envDependency(sel) !== null) continue
        const hash = sel.indexOf('#')
        const producers: [PackageMeta | undefined, string][] = sel.startsWith('^')
          ? metas.filter((m) => declares(meta, m.name)).map((m) => [m, sel.slice(1)])
          : hash === -1
            ? [[meta, sel]]
            : [
                [
                  sel.startsWith(`${ROOT}#`) ? rootMeta : metaNamed.get(sel.slice(0, hash)),
                  sel.slice(hash + 1),
                ],
              ]
        for (const [pm, task] of producers) {
          if (pm === undefined) continue
          const pdef = definitions(pm).defFor(task)
          if (pdef?.cache !== false) continue
          if (!sel.startsWith('^')) unfold.add(`${pm.name}#${task}`)
          const at = relPosix(root, pm.dir)
          for (const g of dep.globs.length > 0 ? dep.globs : (pdef.outputs ?? []))
            if (!g.startsWith('!')) rels.push(at === '' ? g : `${at}/${g}`)
        }
      }
      if (rels.length === 0) continue
      const probe = rels.every(isLiteral) ? ignoredFilesProbe(rels) : dotenvGlobsProbe(rels)
      if (probe === null) {
        unkey(t.task!)
        t.todos.push(
          `inputs read ${rels.map((r) => JSON.stringify(r)).join(', ')} from an uncached ` +
            'dependency, a glob vx cannot key by a probe — task runs uncached; key it in a vx.config to cache it',
        )
        continue
      }
      const probes = (inputs['workspaceRuntime'] as unknown[] | undefined) ?? []
      inputs['workspaceRuntime'] = [...probes, probe]
      // Folded, the producer's key "covers" what it writes, and core answers
      // the probe before it runs: the previous run's bytes. Left out of the
      // fold, the probe waits for it (core's late probes, X-34).
      const deps = (t.task!['dependsOn'] as string[] | undefined) ?? []
      const id = (d: string) => (d.startsWith('^') || d.includes('#') ? d : `${meta.name}#${d}`)
      if (deps.some((d) => unfold.has(id(d))))
        inputs['tasks'] = deps.filter((d) => !unfold.has(id(d)))
    }
  }

  if (opts.ignored !== undefined) {
    const ignored = await opts.ignored([
      ...new Set(literals.tasks.flatMap((l) => [...l.rels.keys()])),
    ])
    for (const { inputs, rels } of literals.tasks) {
      const hits = [...rels].filter(([rel]) => ignored.has(rel))
      if (hits.length > 0) keyIgnored(inputs, hits)
    }
  }

  nestedInputs(root, projects)
  for (const [entry, n] of wildcardUses)
    notes.push(
      `env ${JSON.stringify(entry)}: the configs list the names the files of each task's ` +
        `package and its workspace dependencies spell (${n} task${n === 1 ? '' : 's'}) — add ` +
        'any other a task reads to inputs.env and exec.env.passThrough',
    )
  literalEnvGapsOnce(projects, notes)
  resolveSharedWorkspaceOutputs(root, projects)
  // A written config spreads the preset (`...globalInputs`), which the
  // take-back pass must read as its globs: unread, opencode's configs
  // read `packages/plugin/**` with no `!packages/plugin/dist/**` and
  // core refused to load them.
  const opaque = new Map<string, readonly string[]>()
  for (const e of opts.splice('inputs', globals.inputs))
    if (typeof e !== 'string') opaque.set(JSON.stringify(e), globals.inputs)
  excludeWorkspaceOutputs(root, projects, (e) => opaque.get(JSON.stringify(e)) ?? [])
  pruneUnreachedPersistentNotes(projects, metas, opts.persistentTodo)
  pruneOrphanPersistentNotes(projects, opts.persistentTodo)
  refuseTaskNames(projects, 'task')
  return { projects, notes, globals }
}

/**
 * Turbo hashes a package's files as git lists them, nested workspace
 * packages included (probed on 2.11.6: `a#build` keys `n/x.ts` of a
 * package `n` inside `a`). cal.com's `@calcom/app-store` holds ~100 app
 * packages its source imports by relative path; core's file globs stop at
 * a nested project, so an edit to an app replayed `@calcom/web#build`
 * from the cache. Each file glob that reaches a nested package is listed
 * again in `workspaceFiles`, anchored there, or at the package when it
 * opens on `**` (its own files are keyed twice, the same way).
 */
function nestedInputs(root: string, projects: readonly TurboMappedProject[]): void {
  const rels = projects.map((p) => relPosix(root, p.dir))
  projects.forEach((p, i) => {
    const own = rels[i]!
    if (own === '' || own === '.') return
    const inside = rels.filter((r) => r.startsWith(`${own}/`)).map((r) => r.slice(own.length + 1))
    // A package inside a nested one is reached through it.
    const nested = inside.filter((n) => !inside.some((m) => n.startsWith(`${m}/`)))
    if (nested.length === 0) return
    for (const t of p.tasks) {
      const inputs = t.task?.['inputs'] as Record<string, unknown> | undefined
      const files = inputs?.['files']
      if (inputs === undefined || !Array.isArray(files)) continue
      const extra: string[] = []
      for (const g of files) {
        if (typeof g !== 'string') continue
        const neg = g.startsWith('!')
        const body = neg ? g.slice(1) : g
        // One that opens on `**` reaches them all: listed once, at the package.
        if (body.startsWith('**')) extra.push(`${neg ? '!' : ''}${own}/${body}`)
        else
          for (const n of nested) {
            const under = reanchor(body, n)
            if (under !== null) extra.push(`${neg ? '!' : ''}${own}/${n}/${under}`)
          }
      }
      if (!extra.some((g) => !g.startsWith('!'))) continue
      const ws = inputs['workspaceFiles']
      inputs['workspaceFiles'] = uniq([...(Array.isArray(ws) ? ws : []), ...extra])
    }
  })
}

/**
 * A literal env name core cannot key (`\\*`, which Turbo reads as the one
 * variable `*`) keys nothing in Turbo either unless the run sets it, so it
 * is no task's to fix: openstatus's root `build` env wrote the same
 * TODO into 45 configs. Reported once, with how many tasks name it.
 */
function literalEnvGapsOnce(projects: readonly TurboMappedProject[], notes: string[]): void {
  const counts = new Map<string, number>()
  for (const p of projects)
    for (const t of p.tasks)
      t.todos = t.todos.filter((todo) => {
        if (!/^(env|passThroughEnv) ".*": Turbo reads this as the one variable /s.test(todo))
          return true
        counts.set(todo, (counts.get(todo) ?? 0) + 1)
        return false
      })
  for (const [todo, n] of counts) notes.push(`${todo} (${n} task${n === 1 ? '' : 's'})`)
}

/**
 * The part of a package-relative glob below `dir`, its nested package's
 * directory: `**\/*.ts` under `n` is `**\/*.ts`, `src/**` under `src/n`
 * is `**`; null when the glob cannot reach a file there.
 */
function reanchor(glob: string, dir: string): string | null {
  const gs = glob.split('/')
  const ds = dir.split('/')
  for (let i = 0; i < ds.length; i++) {
    const seg = gs[i]
    if (seg === undefined) return null
    if (seg === '**') return gs.slice(i).join('/')
    if (!new Bun.Glob(seg).match(ds[i]!)) return null
  }
  return gs.length > ds.length ? gs.slice(ds.length).join('/') : null
}

/**
 * The readiness note on a persistent task is for its dependents. Core's
 * prune matches by name, so any `^dev` kept every persistent `dev`'s note:
 * create-t3-turbo's root `dev` depends on `^dev`, and its three apps, which
 * nothing depends on, each carried a note about dependents. A `^name` edge
 * reaches only the packages its package depends on (transitively, as core
 * walks past one without the task); `name` its own package; `pkg#name` one.
 */
function pruneUnreachedPersistentNotes(
  projects: readonly TurboMappedProject[],
  metas: readonly PackageMeta[],
  note: string,
): void {
  const byName = new Map(metas.map((m) => [m.name, m]))
  const below = (name: string): Set<string> => {
    const seen = new Set<string>()
    const queue = [name]
    while (queue.length > 0) {
      const m = byName.get(queue.pop()!)
      if (m === undefined) continue
      for (const d of metas)
        if (!seen.has(d.name) && d.name !== name && declares(m, d.name)) {
          seen.add(d.name)
          queue.push(d.name)
        }
    }
    return seen
  }
  const reached = new Set<string>()
  for (const p of projects)
    for (const t of p.tasks) {
      const deps = t.task?.['dependsOn']
      if (!Array.isArray(deps)) continue
      for (const d of deps) {
        if (typeof d !== 'string') continue
        if (d.startsWith('^')) for (const q of below(p.name)) reached.add(`${q}#${d.slice(1)}`)
        else reached.add(d.includes('#') ? d : `${p.name}#${d}`)
      }
    }
  for (const p of projects)
    for (const t of p.tasks) {
      if (reached.has(`${p.name}#${t.name}`)) continue
      const at = t.todos.indexOf(note)
      if (at !== -1) t.todos.splice(at, 1)
    }
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
  meta: PackageMeta,
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

/**
 * A no-op `true` task as a keyed group: dependants fold the same key and
 * nothing spawns. Kept a task when it writes outputs, stays up or takes a
 * terminal, and when it has neither a key nor an edge (a group needs one).
 */
function keyOnlyGroup(t: TurboMappedTask): TurboMappedTask {
  const task = t.task
  if (task === null) return t
  const exec = task['exec'] as Record<string, unknown>
  if (exec['persistent'] !== undefined || exec['interactive'] !== undefined) return t
  const cache = task['cache'] as
    | { outputs: { files: unknown[]; workspaceFiles?: unknown[] } }
    | undefined
  if (task['inputs'] === undefined && task['dependsOn'] === undefined) return t
  if (
    cache !== undefined &&
    (cache.outputs.files.length > 0 || cache.outputs.workspaceFiles !== undefined)
  )
    return t
  const { exec: _exec, cache: _cache, ...group } = task
  return { ...t, task: group }
}

function buildTask(
  literals: { readonly tasks: Literals[]; readonly globalIgnored: readonly string[] },
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
  rootDotenv: readonly string[],
  rootName: string | undefined,
  sidecars: {
    readonly name: string
    readonly persistentAt: ReadonlyMap<string, ReadonlySet<string>>
    readonly withOf: ReadonlyMap<string, readonly string[]>
  },
  inferred: readonly string[],
  spelled?: { readonly names: readonly string[]; readonly used: (entry: string) => void },
): TurboMappedTask {
  const todos: string[] = []
  // A glob that climbs out of the package (`../../packages/app-store/
  // *.generated.ts`, cal.com's app-store-cli) is a workspace-root glob
  // in vx's terms: re-anchor it on the root. One that climbs out of the
  // workspace has no home and is reported.
  const climbed = (glob: string): string | null => {
    const body = glob.startsWith('!') ? glob.slice(1) : glob
    if (!body.startsWith('../')) return null
    const anchored = path.posix.normalize(path.posix.join(literalGlob(pkgDir), body))
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
  // Turbo refuses an interactive task that caches; vx refuses `cache` on one.
  const interactive = def['interactive'] === true
  const cacheEnabled = def.cache !== false && !persistent && !interactive

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
  const logsKey =
    (def as { outputLogs?: unknown }).outputLogs !== undefined ? 'outputLogs' : 'outputMode'
  const outputLogs = (def as Record<string, unknown>)[logsKey]
  if (outputLogs !== undefined && outputLogs !== OUTPUT_LOGS_DEFAULT) {
    todos.push(
      typeof outputLogs === 'string' && OUTPUT_LOGS_RUN_FLAG.has(outputLogs)
        ? `turbo key "${logsKey}" (${JSON.stringify(outputLogs)}) is a per-run setting in vx — ` +
            `run with --output-logs ${outputLogs}`
        : `turbo key "${logsKey}" (${JSON.stringify(outputLogs)}) is not a value vx knows — ` +
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
          ' in vx env names — list explicit names in inputs.env + exec.env.passThrough',
        ),
      ),
    opts.envNames,
    spelled,
  )
  const passNames: string[] = explicitEnv(
    def.passThroughEnv ?? [],
    (e, literal) => todos.push(envGap('passThroughEnv', e, literal, ' — list explicit names')),
    opts.envNames,
    spelled,
  )

  // A name that is no shell identifier never reached a task (`sh` drops it)
  // and core refuses it in passThrough.
  const passThrough = uniq(
    [...global('env'), ...global('pass'), ...envNames, ...passNames],
    hidden('env', 'pass'),
  ).filter((n) => typeof n !== 'string' || SHELL_NAME.test(n))

  const exec: Record<string, unknown> = { command }
  if (passThrough.length > 0) exec.env = { passThrough }
  if (persistent) {
    exec.persistent = {}
    todos.push(opts.persistentTodo)
  }
  if (interactive) exec.interactive = true

  const task: Record<string, unknown> = { exec }
  if (typeof def['description'] === 'string') task.description = def['description']
  if (deps.length > 0) task.dependsOn = deps

  const files: unknown[] = []
  // `.env` files Turbo hashes although git ignores them; a glob over git's
  // files keyed none of them (item 1032). Probed instead, per package and
  // at the root.
  let pkgDotenv = false
  // Any of them below the package root needs the walk.
  let pkgDotenvDeep = false
  // The root-relative `.env` globs, probed at the workspace root.
  const wsDotenv = [...rootDotenv]
  // globalDependencies are workspace-root-relative by definition —
  // they map to inputs.workspaceFiles, not project-relative files.
  const wsFiles: unknown[] = [...global('inputs')]
  // Root-relative path → the entry naming it.
  const rels = new Map<string, Named>(literals.globalIgnored.map((f) => [f, [null, f]]))
  const atRoot = pkgDir === '' || pkgDir === '.'
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
      // Turbo's globs have extglobs and vx's do not, so
      // `src/**/*.@(js|ts)` keyed on nothing and an edit replayed the old
      // build (item 1031). A positive glob with no safe
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
        if (body.startsWith('$TURBO_ROOT$/')) wsDotenv.push(body.slice('$TURBO_ROOT$/'.length))
        else if (up !== null) wsDotenv.push(up)
        else {
          pkgDotenv = true
          if (body.includes('/')) pkgDotenvDeep = true
        }
        continue
      }
      if (body.startsWith('$TURBO_ROOT$/')) {
        wsFiles.push(...withZeroSegments((neg ? '!' : '') + body.slice('$TURBO_ROOT$/'.length)))
        const rel = body.slice('$TURBO_ROOT$/'.length)
        if (!neg) rels.set(rel, ['workspaceFiles', rel])
      } else if (up !== null) {
        wsFiles.push(...withZeroSegments(up))
        if (!neg) rels.set(up, ['workspaceFiles', up])
      } else if (body.startsWith('../')) {
        todos.push(`input ${JSON.stringify(i)}: leaves the workspace — map manually`)
      } else if (i.includes('$TURBO_ROOT$')) {
        todos.push(
          `input ${JSON.stringify(i)}: $TURBO_ROOT$ only maps as a '$TURBO_ROOT$/<path>' ` +
            'prefix (→ inputs.workspaceFiles) — map manually',
        )
      } else {
        // Unkeyed, a root file edit `*\/**` reaches in Turbo replayed a stale hit.
        files.push(...withZeroSegments(translated))
        const rel = path.posix.join(atRoot ? '.' : pkgDir, body)
        if (!neg) rels.set(rel, [atRoot ? 'workspaceFiles' : 'files', translated])
      }
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

  const keyEnv = uniq([...global('env'), ...envNames], hidden('env'))

  // Turbo hashes a root task over the whole repo; core stops a root
  // project's own globs at every member (D-39), so as `files` a root
  // `oxlint` over the repo replayed green after a member file broke.
  // A root task's globs are the workspace's, outputs too.
  if (atRoot) wsFiles.unshift(...files.splice(0))
  const inputs: Record<string, unknown> = { files: withoutTakenBack(files) }
  if (wsFiles.length > 0) inputs.workspaceFiles = withoutTakenBack(uniq(wsFiles, hidden('inputs')))
  if (keyEnv.length > 0) inputs.env = keyEnv
  if (pkgDotenv) inputs.runtime = [pkgDotenvDeep ? DOTENV_PROBE : DOTENV_PROBE_TOP]
  if (wsDotenv.length > 0) inputs.workspaceRuntime = [dotenvGlobsProbe(wsDotenv) ?? DOTENV_PROBE]
  for (const rel of rels.keys()) if (!isLiteral(rel)) rels.delete(rel)
  literals.tasks.push({ inputs, rels })
  // Turbo keys every task on its inputs, cached or not, and a dependant
  // folds that key: an uncached task's inputs still move its dependants.
  task.inputs = inputs
  if (!cacheEnabled) return { name, todos, task, uses }

  const outFiles: string[] = []
  const zeroed = new Set<string>()
  const wsOutFiles: string[] = []
  for (const raw of def.outputs ?? []) {
    // Turbo's grammar: an extglob in `dist/**/*.@(js|mjs)` matched
    // nothing, so a hit restored nothing (item 1031).
    const mapped = minimatchToVx(raw, raw.startsWith('!'))
    if (mapped === null) {
      todos.push(
        `output ${JSON.stringify(raw)}: glob syntax vx cannot take — task runs uncached; ` +
          'declare the exact outputs in a vx.config to cache it',
      )
      return { name, todos, task, uses }
    }
    // A `!` output takes a path back, as Turbo's does (A-44): Next's
    // `.next/**` minus `!.next/cache/**` saved the cache and cleaned it
    // before every run while vx outputs could not exclude.
    const neg = mapped.startsWith('!') ? '!' : ''
    const o = mapped.slice(neg.length)
    const signed = (g: string) => {
      const head = zeroSegments(g)
      if (head === null) return [neg + g]
      zeroed.add(neg + head)
      return [neg + g, neg + head]
    }
    if (o.startsWith('$TURBO_ROOT$/')) {
      wsOutFiles.push(...signed(o.slice('$TURBO_ROOT$/'.length)))
    } else if (climbed(o) !== null) {
      wsOutFiles.push(...signed(climbed(o)!))
    } else if (o.startsWith('../')) {
      todos.push(`output ${JSON.stringify(o)}: leaves the workspace — map manually`)
    } else if (o.includes('$TURBO_ROOT$')) {
      todos.push(
        `output ${JSON.stringify(o)}: $TURBO_ROOT$ only maps as a '$TURBO_ROOT$/<path>' ` +
          'prefix (→ cache.outputs.workspaceFiles) — map manually',
      )
    } else outFiles.push(...signed(o))
  }

  // With git's file list known, a wildcard-first output stays cached as
  // nx() keeps it (2026-10-03; turbo() 2026-10-14): core never
  // cleans a committed file. Turbo never cleans, so the untracked files
  // it reaches are named. An X added for `X/**` is judged with it.
  const wild = wildcardOutput(
    outFiles.filter((g) => !zeroed.has(g)),
    opts.tracked?.(pkgDir),
    true,
  )
  if (wild !== undefined && opts.tracked === undefined) {
    todos.push(wildcardTodo(wild))
    return { name, todos, task, uses }
  }
  if (wild !== undefined) todos.push(wildcardCleanTodo(wild))
  // tsc re-emits only what its buildinfo calls changed: outside the
  // outputs it survives the clean before a miss, and the miss caches a
  // partial `dist/` (`tsc-buildinfo.ts`).
  if (outFiles.some((g) => !g.startsWith('!')))
    for (const rel of opts.buildInfo?.(pkgDir, command) ?? [])
      if (!covers(outFiles, rel)) outFiles.push(literalGlob(rel))
  // An output over the project's own package.json (trpc's builds list
  // it: tsdown rewrites `exports`) is taken back and keeps the cache, as
  // nx() does (2026-10-03). The build rewrites an input the key
  // folds, so its identical rewrite counts as unchanged ('mutable').
  const takeBacks = ownFileTakeBacks(outFiles, opts.ownConfig?.(pkgDir))
  outFiles.push(...takeBacks)
  const rewritesManifest = takeBacks.includes('!package.json')

  if (atRoot) wsOutFiles.unshift(...outFiles.splice(0))
  const outputs: Record<string, unknown> = { files: takingBack(outFiles) }
  const ws = takingBack(wsOutFiles)
  if (ws.length > 0) outputs.workspaceFiles = ws
  task.cache = {
    outputs,
    ...(rewritesManifest ? { inputStability: { strategy: 'mutable' } } : {}),
  }

  return { name, todos, task, uses }
}
