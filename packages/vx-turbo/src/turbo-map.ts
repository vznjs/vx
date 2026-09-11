// Turbo → vx mapping, the pure half. Reads turbo.json (`tasks` in turbo 2,
// `pipeline` in turbo 1), per-package turbo.json overlays and each package's
// scripts, and emits one TaskConfig-shaped object per (package, task) — a
// task exists for a package only when the package declares the script,
// turbo's own rule. Two consumers, one mapper, so they cannot drift:
//   - `@vzn/vx-migrate` renders these to vx.config.ts files, splicing
//     turbo's global fields in as imports of a generated preset;
//   - `@vzn/vx-turbo` hands them to the `project` stage live, with the
//     global values inlined, so a Turbo repo runs under vx with no file
//     written.
// The consumer decides what a global becomes through `splice`.

import path from 'node:path'
import { type ProjectMeta, UserError } from '@vzn/vx'

/** `path.relative` with forward slashes — the shape an ESM specifier or a report line needs. */
function relPosix(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join('/')
}

export interface TurboTask {
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
   * What a task's array holds for one global field: `vx migrate` splices a
   * preset import (`{ raw: '...globalInputs' }`), the plugin the values
   * themselves. Called only for a global that is non-empty.
   */
  splice(kind: TurboGlobal, values: readonly string[]): readonly unknown[]
  /** The TODO attached to a persistent task, in the consumer's words. */
  persistentTodo: string
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

function scriptsOf(meta: ProjectMeta): Record<string, unknown> {
  // package.json is a system boundary — a script value is whatever the
  // file holds, not necessarily a string.
  return (meta.packageJson as unknown as { scripts?: Record<string, unknown> }).scripts ?? {}
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
  const rootCfg = await readTurboJson(path.join(root, 'turbo.json'), root)
  const rootTasks = tasksOf(rootCfg)

  const globals = {
    inputs: rootCfg.globalDependencies ?? [],
    env: rootCfg.globalEnv ?? [],
    pass: rootCfg.globalPassThroughEnv ?? [],
  }

  const pkgTasksByName = new Map<string, Record<string, TurboTask>>()
  for (const meta of metas) {
    const file = path.join(meta.dir, 'turbo.json')
    if (await Bun.file(file).exists()) {
      pkgTasksByName.set(meta.name, tasksOf(await readTurboJson(file, root)))
    }
  }

  const notes: string[] = []
  for (const key of Object.keys(rootTasks)) {
    if (key.startsWith('//#')) {
      notes.push(`note: root task ${key} not migrated — vx has no workspace-root tasks`)
    }
  }

  // First pass: which tasks does each package emit? Needed so dependsOn
  // edges can be validated/dropped against the real emitted set.
  const emitted = new Map<string, Set<string>>()
  for (const meta of metas) {
    const scripts = scriptsOf(meta)
    const set = new Set<string>()
    for (const name of taskNamesFor(meta.name, rootTasks, pkgTasksByName.get(meta.name))) {
      if (usableScript(scripts[name])) set.add(name)
    }
    emitted.set(meta.name, set)
  }

  const projects: TurboMappedProject[] = []
  for (const meta of metas) {
    const scripts = scriptsOf(meta)
    const pkgTasks = pkgTasksByName.get(meta.name)
    const own = emitted.get(meta.name)!
    const tasks: TurboMappedTask[] = []
    for (const name of taskNamesFor(meta.name, rootTasks, pkgTasks)) {
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
      const overlay = pkgTasks?.[name]
      const def: TurboTask =
        overlay?.extends === false
          ? { ...overlay }
          : { ...rootTasks[name], ...rootTasks[`${meta.name}#${name}`], ...overlay }
      delete def.extends
      tasks.push(
        buildTask(name, def, script, own, emitted, globals, opts, relPosix(root, meta.dir)),
      )
    }
    projects.push({ name: meta.name, dir: meta.dir, tasks })
  }

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
  emitted: ReadonlyMap<string, ReadonlySet<string>>,
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
  for (const d of def.dependsOn ?? []) {
    if (d.includes('$TURBO_ROOT$')) {
      todos.push(
        `dependsOn ${JSON.stringify(d)} uses $TURBO_ROOT$ — vx has no workspace-root tasks; ` +
          'restructure manually',
      )
      continue
    }
    if (d.startsWith('^')) {
      deps.push(d)
      continue
    }
    const hashAt = d.indexOf('#')
    if (hashAt !== -1) {
      const pkg = d.slice(0, hashAt)
      const task = d.slice(hashAt + 1)
      if (emitted.get(pkg)?.has(task)) deps.push(d)
      else
        todos.push(
          `dependsOn ${JSON.stringify(d)}: ${pkg} declares no ${task} script — edge dropped`,
        )
      continue
    }
    // Same-project dep on a script this package lacks: turbo silently
    // skips the task there, so the edge simply doesn't exist.
    if (own.has(d)) deps.push(d)
  }

  const envNames: string[] = []
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
    if (def.inputs === undefined) {
      // Turbo's default input set is every package file.
      files.push('**/*')
    } else {
      for (const i of def.inputs) {
        if (i === '$TURBO_DEFAULT$') {
          files.push('**/*')
          continue
        }
        const neg = i.startsWith('!')
        const body = neg ? i.slice(1) : i
        const up = climbed(i)
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
        } else files.push(i)
      }
    }

    const outFiles: string[] = []
    const wsOutFiles: string[] = []
    for (const o of def.outputs ?? []) {
      if (o.startsWith('!')) {
        todos.push(
          `output ${JSON.stringify(o)}: vx outputs have no negation — narrow the positive ` +
            'globs instead',
        )
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
