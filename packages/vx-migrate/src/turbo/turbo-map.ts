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
import { scriptCommand } from '../script-command.js'
import { resolveSharedOutputs } from '../shared-outputs.js'
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
  try {
    // turbo.json allows comments + trailing commas.
    return (Bun.JSONC.parse(text) ?? {}) as TurboJson
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new UserError(`failed to parse ${relPosix(root, file)}: ${msg}`)
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

/** Declared task names for a package: plain root keys, `pkg#name` keys
 * for this package, and per-package turbo.json keys — in that order. */
function taskNamesFor(
  pkgName: string,
  rootTasks: Record<string, TurboTask>,
  pkgTasks: Record<string, TurboTask> | undefined,
): string[] {
  const names: string[] = []
  const push = (n: string): void => {
    if (!names.includes(n)) names.push(n)
  }
  for (const key of Object.keys(rootTasks)) {
    if (!key.includes('#')) push(key)
    else if (key.startsWith(`${pkgName}#`)) push(key.slice(pkgName.length + 1))
  }
  for (const key of Object.keys(pkgTasks ?? {})) {
    if (!key.includes('#')) push(key)
  }
  return names.filter((n) => !optedOut(pkgTasks?.[n]))
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

export async function mapTurboWorkspace(
  root: string,
  metas: readonly ProjectMeta[],
  opts: MapTurboOptions,
): Promise<TurboMapping> {
  const rootCfg = await readTurboJson(
    (await turboConfigFile(root)) ?? path.join(root, 'turbo.json'),
    root,
  )
  const rootTasks = tasksOf(rootCfg)

  // Turbo 1 lists an env var as `$NAME` among `globalDependencies` (and a
  // task's `dependsOn`); read as a file it was a glob that matched nothing,
  // and the var re-keyed nothing (item 909).
  const globalDeps = rootCfg.globalDependencies ?? []
  const notes: string[] = []
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
  const globals = {
    // Turbo 1's `globalDotEnv` files are hashed as `globalDependencies`
    // are, and mapped the same way; unread, an edit to one re-keyed
    // nothing (item 937). One git does not report is core's refusal to
    // explain, as for a `globalDependencies` entry: it cannot be keyed.
    inputs: [
      ...globalDeps.filter((d) => envDependency(d) === null),
      ...(rootCfg.globalDotEnv ?? []),
    ],
    env: [
      ...envNames('globalEnv', rootCfg.globalEnv ?? []),
      ...globalDeps.flatMap((d) => envDependency(d) ?? []),
    ],
    pass: envNames('globalPassThroughEnv', rootCfg.globalPassThroughEnv ?? []),
  }

  const pkgTasksByName = new Map<string, Record<string, TurboTask>>()
  for (const meta of metas) {
    const file = await turboConfigFile(meta.dir)
    if (file !== null) {
      pkgTasksByName.set(meta.name, tasksOf(await readTurboJson(file, root)))
    }
  }

  for (const key of Object.keys(rootTasks)) {
    if (key.startsWith('//#')) {
      notes.push(`note: root task ${key} not migrated — vx has no workspace-root tasks`)
    }
  }

  // First pass: which tasks does each package emit? Needed so dependsOn
  // edges can be validated/dropped against the real emitted set.
  const emitted = new Map<string, Set<string>>()
  for (const meta of metas) {
    const scripts = packageScripts(meta)
    const set = new Set<string>()
    for (const name of taskNamesFor(meta.name, rootTasks, pkgTasksByName.get(meta.name))) {
      if (usableScript(scripts[name])) set.add(name)
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
    const pkgTasks = pkgTasksByName.get(meta.name)
    const own = emitted.get(meta.name)!
    const defined = new Set(taskNamesFor(meta.name, rootTasks, pkgTasks))
    const defFor = (name: string): TurboTask | undefined => {
      if (!defined.has(name)) return undefined
      const overlay = pkgTasks?.[name]
      const def: TurboTask =
        overlay?.extends === false
          ? { ...overlay }
          : // A root `pkg#task` REPLACES `task` for that package, as Turbo's
            // `TurboJson::task` looks it up: merged field by field, the
            // generic task's `inputs` narrowed a `pkg#task` that names none
            // (Turbo's every file) and an edit outside them was a stale hit
            // (item 935).
            withOverlay({ ...(rootTasks[`${meta.name}#${name}`] ?? rootTasks[name]) }, overlay)
      delete def.extends
      return def
    }
    const tasks: TurboMappedTask[] = []
    for (const name of defined) {
      const script = scripts[name]
      if (!usableScript(script)) {
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
          scriptCommand(name, script, scripts),
          own,
          defFor,
          emitted,
          emittedAnywhere,
          globals,
          opts,
          relPosix(root, meta.dir),
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
  if (deps.length > 0) task.dependsOn = deps

  if (cacheEnabled) {
    const files: unknown[] = []
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
    // Turbo 1's task `dotEnv`: package-relative `.env` files it hashes. An
    // unset `inputs` already reads every file git reports.
    const dotEnv = (def as { dotEnv?: unknown }).dotEnv
    if (def.inputs !== undefined && def.inputs.length > 0 && Array.isArray(dotEnv)) {
      files.push(...dotEnv.filter((f) => typeof f === 'string'))
    }

    const outFiles: string[] = []
    const wsOutFiles: string[] = []
    const negated: string[] = []
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
      const o = cut < 0 ? raw : `${raw.slice(0, cut + 1)}${rest}`
      if (o.startsWith('!')) {
        negated.push(o)
      } else if (o.startsWith('$TURBO_ROOT$/')) {
        wsOutFiles.push(o.slice('$TURBO_ROOT$/'.length))
      } else if (climbed(o) !== null) {
        wsOutFiles.push(climbed(o)!)
      } else if (o.startsWith('../')) {
        todos.push(`output ${JSON.stringify(o)}: leaves the workspace — map manually`)
      } else if (o.includes('$TURBO_ROOT$')) {
        todos.push(
          `output ${JSON.stringify(o)}: $TURBO_ROOT$ only maps as a '$TURBO_ROOT$/<path>' ` +
            'prefix (→ cache.outputs.workspaceFiles) — map manually',
        )
      } else outFiles.push(o)
    }

    // vx cleans and restores exactly the positive globs. A negation under
    // a literal-rooted output (`dist/**` minus `!dist/**/*.map`) leaves a
    // harmless superset of build products and is a todo; one that carves
    // the package root out of a wildcard (medusa: `*/**` minus `!src/**`
    // and `!node_modules/**`) does not — the superset is the sources, and
    // the clean before exec would delete them. That task runs uncached.
    const wild = outFiles.find((o) => !isLiteralPattern(o.split('/')[0] ?? ''))
    if (negated.length > 0 && wild !== undefined) {
      todos.push(
        `outputs ${negated.map((n) => JSON.stringify(n)).join(', ')} narrow ${JSON.stringify(wild)}: ` +
          'vx outputs have no negation and the positive glob reaches the sources — task runs ' +
          'uncached; declare the exact outputs in a vx.config to cache it',
      )
      return { name, todos, task, uses }
    }
    // Without a negation too: Turbo never cleans an output, vx cleans it
    // before a run and a restore, so `**/*.d.ts` deleted a hand-written
    // `src/env.d.ts` and an uncommitted edit to it was lost for good (item
    // 1031). A wildcard first segment can reach the sources.
    if (wild !== undefined) {
      todos.push(
        `output ${JSON.stringify(wild)}: a wildcard first segment reaches the sources, which ` +
          'vx cleans before every run — task runs uncached; declare the exact outputs in a ' +
          'vx.config to cache it',
      )
      return { name, todos, task, uses }
    }
    for (const n of negated) {
      todos.push(
        `output ${JSON.stringify(n)}: vx outputs have no negation — narrow the positive ` +
          'globs instead',
      )
    }

    const cacheEnv = uniq([...global('env'), ...envNames])

    const inputs: Record<string, unknown> = { files }
    if (wsFiles.length > 0) inputs.workspaceFiles = uniq(wsFiles)
    if (cacheEnv.length > 0) inputs.env = cacheEnv
    const outputs: Record<string, unknown> = { files: outFiles }
    if (wsOutFiles.length > 0) outputs.workspaceFiles = wsOutFiles
    task.cache = { inputs, outputs }
  }

  return { name, todos, task, uses }
}
