// Vite Task (vite-plus's `vp run`) → vx: each package's `vite.config`
// `run` block and its package.json scripts, as the projects a migration
// plan writes. The schema is vite-plus's `RunConfig` (1.1): a task is a
// command string, an array of them, or `{ command, cwd, dependsOn, cache }`.
// vite-plus 0.x put `env`, `untrackedEnv`, `input` and `output` on the task
// itself beside `cache: true | false`; both shapes map.

import { existsSync } from 'node:fs'
import path from 'node:path'
import { type GeneratedProject, type GeneratedTask, UserError } from '@vzn/vx'
import type { PackageMeta } from '../packages.js'
import { refuseTaskNames } from '../plugin-gaps.js'
import {
  hasGluedGlobstar,
  minimatchToVx,
  negationsAcrossBases,
  withoutTakenBack,
} from '../glob-grammar.js'
import { packageScripts, relPosix } from '../paths.js'
import { scriptCommand, yarnPnp } from '../script-command.js'
import {
  dropOwnOutputInputs,
  excludeSiblingOutputs,
  excludeWorkspaceOutputs,
  ownFileOutput,
  ownFileTodo,
  resolveSharedOutputs,
  resolveSharedWorkspaceOutputs,
  takingBack,
  wildcardOutput,
  wildcardTodo,
} from '../shared-outputs.js'
import type { TrackedKinds } from '../tracked-outputs.js'
import { mayOverlap } from '../turbo/turbo-reads.js'

/** vite-plus's `VITE_CONFIG_FILES`, in its order: the first one present is the package's. */
const VITE_CONFIG_FILES = [
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.ts',
  'vite.config.cjs',
  'vite.config.mts',
  'vite.config.cts',
]

const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies'] as const
type DepField = (typeof DEP_FIELDS)[number]

/** A command segment that runs Vite Task: `vp run`, `vpr`, through a package runner too. */
const VP_RUN = /^(?:(?:pnpm(?: exec)?|npx|bunx|yarn)\s+)?(?:vp\s+run|vpr)(?:\s|$)/

/** `vp run` or `vpr` anywhere in a command, as a word. */
const VP_RUN_ANYWHERE = /(?:^|[\s;&|(`])(?:vp\s+run|vpr)(?:\s|$)/

/**
 * `command` cut at each `&&` outside quotes, each part as written; null when
 * a `||`, `;`, `&`, newline, subshell or backtick sits outside quotes, where
 * Vite Task runs the command whole in a shell and a cut would change what
 * runs after a failure.
 */
function andChain(command: string): string[] | null {
  const parts: string[] = []
  let start = 0
  let quote: string | null = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (quote !== null) {
      if (c === '\\' && quote === '"') i++
      else if (c === quote) quote = null
    } else if (c === '\\') i++
    else if (c === "'" || c === '"') quote = c
    else if (c === '&' && command[i + 1] === '&') {
      parts.push(command.slice(start, i).trim())
      start = ++i + 1
    } else if (c === '|' && command[i + 1] === '|') return null
    // A redirect (`2>&1`, `&>`), not a background job.
    else if (c === '&' && (command[i - 1] === '>' || command[i + 1] === '>')) continue
    else if (';&\n()`'.includes(c)) return null
  }
  if (quote !== null) return null
  parts.push(command.slice(start).trim())
  return parts
}

/** npm's own verbs' hooks: the package manager runs them, never `vp run`'s task list. */
const LIFECYCLE = /^(pre|post)(install|publish|pack|version)$|^(prepare|prepublishOnly|install)$/

type Glob = string | { pattern?: unknown; base?: unknown; auto?: unknown }

interface TaskDef extends CacheDef {
  command?: unknown
  cwd?: unknown
  dependsOn?: unknown
  cache?: unknown
}

interface CacheDef {
  env?: unknown
  untrackedEnv?: unknown
  input?: unknown
  output?: unknown
}

interface RunConfig {
  tasks?: Record<string, unknown>
  cache?: unknown
  enablePrePostScripts?: unknown
}

/** The `vite.config` file in `dir`, or null. */
function viteConfigFile(dir: string): string | null {
  const name = VITE_CONFIG_FILES.find((f) => existsSync(path.join(dir, f)))
  return name === undefined ? null : path.join(dir, name)
}

// Bun's resolver reads `\` as a separator, even in a file: URL, so a config
// under `a\b` was looked for under `a/b`. Resolved here, the path stays as
// written; the file is read from it, found by its number: Bun 1.4.4 hands
// onLoad the path with `\` made `/`.
const LITERAL_QUERY = /\?vx-literal=(\d+)$/
let servingLiteral = false
const literals: string[] = []

function importAsWritten(file: string): Promise<{ default?: unknown }> {
  if (!file.includes('\\')) return import(file)
  if (!servingLiteral) {
    servingLiteral = true
    Bun.plugin({
      name: 'vx-migrate-literal',
      setup(build) {
        build.onResolve({ filter: LITERAL_QUERY }, (args) => ({
          path: args.path,
          namespace: 'file',
        }))
        build.onLoad({ filter: LITERAL_QUERY }, async (args) => {
          const at = literals[Number(LITERAL_QUERY.exec(args.path)![1])]!
          return {
            contents: await Bun.file(at).text(),
            loader: /\.[cm]?ts$/.test(at) ? 'ts' : 'js',
          }
        })
      },
    })
  }
  return import(`${file}?vx-literal=${literals.push(file) - 1}`)
}

/**
 * A package's `run` block, as `vp run` reads it: the config evaluated in
 * build mode (vite-plus resolves it with `command: 'build'`), a function
 * config called. Bun loads the TypeScript itself.
 */
async function readRunConfig(file: string, root: string): Promise<RunConfig | null> {
  let config: unknown
  try {
    config = (await importAsWritten(file)).default
    if (typeof config === 'function')
      config = await (config as (env: object) => unknown)({
        command: 'build',
        mode: 'production',
        isSsrBuild: false,
        isPreview: false,
      })
  } catch (err) {
    throw new UserError(
      `${relPosix(root, file)} did not load (${err instanceof Error ? err.message : String(err)}) — install the workspace's dependencies, then re-run vx-migrate`,
    )
  }
  const run = (config as { run?: unknown } | null | undefined)?.run
  return typeof run === 'object' && run !== null ? run : null
}

/** `run.cache` at the root: what `vp run` caches with no flag. */
function globalCache(run: RunConfig | null): { tasks: boolean; scripts: boolean } {
  const c = run?.cache
  if (typeof c === 'boolean') return { tasks: c, scripts: c }
  const o = (typeof c === 'object' && c !== null ? c : {}) as { tasks?: unknown; scripts?: unknown }
  return { tasks: o.tasks !== false, scripts: o.scripts === true }
}

export interface ViteTaskOptions {
  /** Each project's tracked files, by root-relative dir: what a wildcard output may not claim. */
  tracked?: (rel: string) => TrackedKinds
  /** The config file each written task lives beside, by project dir. */
  ownConfig?: (dir: string) => string | null
}

export interface ViteTaskMapping {
  projects: GeneratedProject[]
  notes: string[]
}

/** A shell word for `cd`: bare when it is safe, single-quoted otherwise. */
function shellWord(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`
}

const asStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

/**
 * `metas` plus the workspace root when it has tasks or scripts and no
 * member is the root: `vp run -w` runs them, so it is a project here.
 */
export async function viteTaskProjects(
  root: string,
  metas: readonly PackageMeta[],
): Promise<{ metas: PackageMeta[]; notes: string[] }> {
  if (metas.some((m) => path.resolve(m.dir) === path.resolve(root)))
    return { metas: [...metas], notes: [] }
  const file = viteConfigFile(root)
  const run = file === null ? null : await readRunConfig(file, root)
  const pkg = (await Bun.file(path.join(root, 'package.json'))
    .json()
    .catch(() => ({}))) as { name?: unknown; scripts?: unknown }
  const scripts = typeof pkg.scripts === 'object' && pkg.scripts !== null ? pkg.scripts : {}
  const hasTasks = Object.keys(run?.tasks ?? {}).length > 0 || Object.keys(scripts).length > 0
  if (!hasTasks) return { metas: [...metas], notes: [] }
  if (typeof pkg.name !== 'string' || pkg.name === '' || metas.some((m) => m.name === pkg.name))
    return {
      metas: [...metas],
      notes: [
        'the workspace root has tasks or scripts `vp run -w` runs, and no package.json "name" of its own (or one a member takes); vx names a project by it — give it one and re-run vx-migrate',
      ],
    }
  return {
    metas: [...metas, { name: pkg.name, dir: root, packageJson: pkg as never, configPath: null }],
    notes: [],
  }
}

/** Every project's Vite Task tasks and package.json scripts as vx tasks. */
export async function mapViteTaskWorkspace(
  root: string,
  metas: readonly PackageMeta[],
  opts: ViteTaskOptions = {},
): Promise<ViteTaskMapping> {
  const rootFile = viteConfigFile(root)
  const rootRun = rootFile === null ? null : await readRunConfig(rootFile, root)
  const cacheOn = globalCache(rootRun)
  const hooks = rootRun?.enablePrePostScripts !== false
  const pnp = yarnPnp(root)

  const runs = new Map<string, RunConfig | null>()
  for (const m of metas) {
    const file = viteConfigFile(m.dir)
    runs.set(
      m.name,
      path.resolve(m.dir) === path.resolve(root)
        ? rootRun
        : file === null
          ? null
          : await readRunConfig(file, root),
    )
  }
  const tasksOf = (m: PackageMeta): Record<string, unknown> => runs.get(m.name)?.tasks ?? {}
  const defines = (m: PackageMeta, task: string): boolean =>
    Object.hasOwn(tasksOf(m), task) || typeof packageScripts(m)[task] === 'string'
  const byName = new Map(metas.map((m) => [m.name, m]))
  /** Workspace members `m` lists under each field, by name. */
  const depsIn = (m: PackageMeta, field: string): string[] => {
    const deps = (m.packageJson as unknown as Record<string, unknown>)[field]
    if (typeof deps !== 'object' || deps === null) return []
    return Object.keys(deps).filter((n) => byName.has(n) && n !== m.name)
  }

  const rootMeta = metas.find((m) => path.resolve(m.dir) === path.resolve(root))

  /**
   * A `vp run` inside a command: Vite Task inlines it into its graph. A
   * leading chain of them becomes `dependsOn` edges, and the task a group
   * when nothing else is left; a form with no edge spelling is a TODO.
   */
  function inlineRuns(t: GeneratedTask, self: PackageMeta): void {
    const exec = t.task?.['exec'] as { command?: unknown } | undefined
    if (typeof exec?.command !== 'string') return
    const parts = andChain(exec.command)
    if (parts === null) {
      if (VP_RUN_ANYWHERE.test(exec.command))
        t.todos.push(
          `\`${exec.command}\` runs Vite Task inside the command, which \`vp run\` runs in a shell as written: name the tasks it runs under dependsOn and drop it from the command`,
        )
      return
    }
    if (!VP_RUN_ANYWHERE.test(exec.command)) return
    const edges: string[] = []
    let i = 0
    for (; i < parts.length && VP_RUN.test(parts[i]!); i++) {
      const e = /[|;()`$<>'"\\\n]/.test(parts[i]!) ? null : runEdges(parts[i]!, self, t.name)
      if (e === null) break
      edges.push(...e)
    }
    // `FOO=1 vp run x` too: kept, it ran Vite Task nested under vx.
    if (parts.slice(i).some((p) => VP_RUN_ANYWHERE.test(p))) {
      const seg = parts.find((p, j) => j >= i && VP_RUN_ANYWHERE.test(p))!
      t.todos.push(
        `\`${seg}\` runs Vite Task inside the command, which \`vp run\` inlined into its graph: name the tasks it runs under dependsOn and drop it from the command`,
      )
      return
    }
    const deps = (t.task!['dependsOn'] as string[] | undefined) ?? []
    t.task!['dependsOn'] = [...new Set([...deps, ...edges])]
    const rest = parts.slice(i).join(' && ')
    if (rest === '') noCommand(t)
    else exec.command = rest
  }

  /** The edges one `vp run` stands for, or null when it has none. */
  function runEdges(segment: string, self: PackageMeta, own: string): string[] | null {
    const words = segment.split(/\s+/)
    words.splice(0, words.indexOf(words[0] === 'vpr' ? 'vpr' : 'run') + 1)
    let recursive = false
    let workspace = false
    const filters: string[] = []
    const specs: string[] = []
    for (let k = 0; k < words.length; k++) {
      const w = words[k]!
      if (w === '-r' || w === '--recursive') recursive = true
      else if (w === '-w' || w === '--workspace-root') workspace = true
      else if (w === '-F' || w === '--filter') filters.push(words[++k] ?? '')
      else if (w.startsWith('--filter=')) filters.push(w.slice('--filter='.length))
      else if (w === '--log' || w === '--concurrency-limit') k++
      else if (['-v', '--verbose', '--cache', '--no-cache', '--fail-if-no-match'].includes(w))
        continue
      else if (w.startsWith('-')) return null
      else specs.push(w)
    }
    // One task and no forwarded arguments: an edge passes none.
    if (specs.length !== 1) return null
    const spec = specs[0]!
    const hash = spec.indexOf('#')
    if (hash !== -1) {
      const m = byName.get(spec.slice(0, hash))
      return recursive || workspace || filters.length > 0 || m === undefined ? null : [spec]
    }
    let picked: PackageMeta[]
    if (filters.length > 0) {
      // Package names only: pnpm's directory, glob and graph selectors are not.
      if (filters.some((f) => !byName.has(f))) return null
      picked = filters.map((f) => byName.get(f)!)
    } else if (recursive) picked = [...metas]
    else if (workspace) {
      if (rootMeta === undefined) return null
      picked = [rootMeta]
    } else return defines(self, spec) && spec !== own ? [spec] : null
    // Vite Task prunes the task's own reference (a root `build: vp run -r build`).
    return picked
      .filter((m) => defines(m, spec) && !(m === self && spec === own))
      .map((m) => `${m.name}#${spec}`)
      .sort()
  }

  const projects: GeneratedProject[] = []
  for (const meta of metas) {
    const pkgDir = relPosix(root, meta.dir)
    const atRoot = pkgDir === '' || pkgDir === '.'
    const tasks: GeneratedTask[] = []
    const own = tasksOf(meta)
    for (const [name, raw] of Object.entries(own)) {
      const def: TaskDef =
        typeof raw === 'string' || Array.isArray(raw) ? { command: raw } : (raw ?? {})
      tasks.push(
        mapTask(name, def, {
          pkgDir,
          atRoot,
          cacheOn: cacheOn.tasks,
          dependsOn: (from) => fromDeps(meta, from),
          opts,
          dir: meta.dir,
        }),
      )
    }

    /**
     * `{ task, from }`: the task in each direct member `from` lists that
     * defines it. `^task` is that set while no member listed under another
     * field defines it too (vx's `^` follows every field); else the edges.
     */
    function fromDeps(m: PackageMeta, entry: { task: string; from: unknown }): string[] {
      const fields = (Array.isArray(entry.from) ? entry.from : [entry.from]).filter(
        (f): f is DepField => (DEP_FIELDS as readonly unknown[]).includes(f),
      )
      const chosen = new Set(fields.flatMap((f) => depsIn(m, f)))
      const others = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
        .filter((f) => !(fields as string[]).includes(f))
        .flatMap((f) => depsIn(m, f))
        .filter((n) => !chosen.has(n) && defines(byName.get(n)!, entry.task))
      if (others.length === 0) return [`^${entry.task}`]
      return [...chosen]
        .filter((n) => defines(byName.get(n)!, entry.task))
        .sort()
        .map((n) => `${n}#${entry.task}`)
    }

    const scripts = packageScripts(meta)
    const has = (n: string): boolean => typeof scripts[n] === 'string' && scripts[n] !== ''
    for (const name of Object.keys(scripts)) {
      if (!has(name) || Object.hasOwn(own, name) || LIFECYCLE.test(name)) continue
      // With hooks on, `vp run x` runs `prex` and `postx` around it: they
      // ride inside x's command, as no task of their own.
      const hookOf = hooks ? /^(pre|post)(.+)$/.exec(name) : null
      if (hookOf !== null && has(hookOf[2]!) && !LIFECYCLE.test(hookOf[2]!)) continue
      const command = scriptCommand(name, scripts[name] as string, hooks ? scripts : {}, pnp)
      tasks.push({
        name,
        // Scripts are uncached unless `run.cache.scripts`, and then traced.
        todos: cacheOn.scripts ? [autoTodo('inputs and outputs')] : [],
        task: { exec: { command } },
      })
    }
    for (const t of tasks) inlineRuns(t, meta)
    // Vite Task runs two tasks over one output, or a reader of another's
    // output with no edge to it; core refuses both, as it does for Turbo.
    excludeSiblingOutputs(resolveSharedOutputs(tasks), true)
    if (tasks.length > 0) projects.push({ name: meta.name, dir: meta.dir, importLines: [], tasks })
  }
  resolveSharedWorkspaceOutputs(root, projects)
  excludeWorkspaceOutputs(root, projects)
  refuseTaskNames(projects, 'task')
  return { projects, notes: [] }
}

/**
 * A task whose command was only `vp run`s: nothing of its own runs, so
 * nothing is cached. Its inputs keep it a no-op task, a key its dependants
 * fold; with none it is a group of its edges.
 */
function noCommand(t: GeneratedTask): void {
  const task = t.task!
  // Its trace TODO asked for `cache: true`, which a task with no `exec` refuses.
  t.todos = t.todos.filter((x) => !x.startsWith(AUTO_TODO))
  delete task['exec']
  delete task['cache']
  delete task['outputs']
  const inputs = task['inputs'] as Record<string, unknown> | undefined
  if (inputs !== undefined && !Object.values(inputs).some((v) => Array.isArray(v) && v.length > 0))
    delete task['inputs']
}

const AUTO_TODO = "cache: Vite Task traced this task's "

/** The TODO for what Vite Task traces and vx declares. */
function autoTodo(what: string, known?: Record<string, unknown>): string {
  const have = known === undefined ? '' : ` (declared so far: \`${JSON.stringify(known)}\`)`
  return (
    `${AUTO_TODO}${what} and vx infers none — add ` +
    `\`inputs: { files: [...] }, outputs: { files: [...] }, cache: true\` with the real ones${have}; ` +
    'without it the task always runs'
  )
}

interface TaskCtx {
  pkgDir: string
  atRoot: boolean
  cacheOn: boolean
  dir: string
  dependsOn: (entry: { task: string; from: unknown }) => string[]
  opts: ViteTaskOptions
}

function mapTask(name: string, def: TaskDef, ctx: TaskCtx): GeneratedTask {
  const todos: string[] = []
  const task: Record<string, unknown> = {}

  const parts = typeof def.command === 'string' ? [def.command] : asStrings(def.command)
  const body = parts.filter((p) => p.trim() !== '').join(' && ')
  const cwd = typeof def.cwd === 'string' && def.cwd !== '' && def.cwd !== '.' ? def.cwd : null

  const deps: string[] = []
  for (const d of Array.isArray(def.dependsOn) ? def.dependsOn : []) {
    if (typeof d === 'string') deps.push(d)
    else if (
      typeof d === 'object' &&
      d !== null &&
      typeof (d as { task?: unknown }).task === 'string'
    )
      deps.push(...ctx.dependsOn(d as { task: string; from: unknown }))
  }
  if (deps.length > 0 || body === '') task['dependsOn'] = [...new Set(deps)]
  // `command: []` runs nothing: a group of its dependsOn.
  if (body === '') return { name, todos, task }

  const command = cwd === null ? body : `cd ${shellWord(cwd)} && ${body}`
  const exec: Record<string, unknown> = { command }
  task['exec'] = exec

  const cache: CacheDef | null =
    def.cache === false || !ctx.cacheOn
      ? null
      : typeof def.cache === 'object' && def.cache !== null
        ? def.cache
        : def

  // `cache.env` is core's `inputs.env`, passed and keyed; `untrackedEnv` is
  // `passThrough`, passed only. A task that writes no inputs passes both.
  const env = envNames('cache.env', cache?.env, todos)
  const untracked = envNames('cache.untrackedEnv', cache?.untrackedEnv, todos)
  const pass = (keyed: boolean): void => {
    const names = [...new Set([...(keyed ? [] : env), ...untracked])]
    if (names.length > 0) exec['env'] = { passThrough: names }
  }
  pass(false)
  if (cache === null) return { name, todos, task }

  const inputs = globs('input', cache.input, ctx, todos)
  const outputs = globs('output', cache.output, ctx, todos)
  if (inputs.auto || outputs.auto) {
    const known: Record<string, unknown> = {}
    if (!inputs.auto) known['inputs'] = inputs.lists
    if (!outputs.auto) known['outputs'] = outputs.lists
    const what =
      inputs.auto && outputs.auto ? 'inputs and outputs' : inputs.auto ? 'inputs' : 'outputs'
    todos.push(autoTodo(what, Object.keys(known).length > 0 ? known : undefined))
    return { name, todos, task }
  }
  // Declared inputs key the task cached or not: a dependant folds them.
  const inputLists: Record<string, unknown> = { ...inputs.lists }
  if (env.length > 0) inputLists['env'] = env
  pass(true)
  task['inputs'] = inputLists
  if (outputs.uncached) return { name, todos, task }

  const outFiles = outputs.lists['files'] as string[]
  const wild = wildcardOutput(outFiles, ctx.opts.tracked?.(ctx.pkgDir))
  if (wild !== undefined) {
    todos.push(wildcardTodo(wild))
    return { name, todos, task }
  }
  const ownFile = ownFileOutput(outFiles, ctx.opts.ownConfig?.(ctx.dir))
  if (ownFile !== undefined) {
    todos.push(ownFileTodo(ownFile))
    return { name, todos, task }
  }
  task['outputs'] = outputs.lists
  task['cache'] = true
  todos.push(...dropOwnOutputInputs(task, ctx.atRoot ? '' : ctx.pkgDir, 'Vite Task'))
  return { name, todos, task }
}

/**
 * `env` / `untrackedEnv` as vx env names: a name, or a `*` pattern kept as
 * written, which core matches each run as Vite Task does. A `!` entry takes
 * the list's own names back; one a kept pattern still matches is a TODO,
 * since core has no exclusion.
 */
function envNames(field: string, v: unknown, todos: string[]): string[] {
  const re = (p: string): RegExp => new RegExp(`^${p.split('*').map(RegExp.escape).join('.*')}$`)
  const names: string[] = []
  const dropped: string[] = []
  for (const e of asStrings(v)) {
    if (e.startsWith('!')) {
      dropped.push(e.slice(1))
      continue
    }
    if (
      e.includes('*')
        ? !/^(?!\*+$)[A-Za-z_*][A-Za-z0-9_*]*$/.test(e)
        : /[?[\]{}=\0]/.test(e) || e === ''
    ) {
      todos.push(
        `${field} ${JSON.stringify(e)}: a vx env name is letters, digits and _, with * the one wildcard — list the names the task reads`,
      )
      continue
    }
    names.push(e)
  }
  for (const d of dropped) {
    const wide = names.find((n) => n.includes('*') && mayOverlap(n, d))
    if (wide !== undefined)
      todos.push(
        `${field} ${JSON.stringify(`!${d}`)}: vx has no exclusion, so ${JSON.stringify(wide)} still takes ${d} — narrow the pattern to leave it out`,
      )
  }
  return [...new Set(names)].filter((n) => n.includes('*') || !dropped.some((d) => re(d).test(n)))
}

/**
 * `cache.input` / `cache.output`: package-relative globs (a string, or
 * `{ pattern, base: 'package' }`) are `files`, `base: 'workspace'` ones
 * `workspaceFiles`; a root task's are the workspace's. Omitted or holding
 * `{ auto: true }`, the list is traced, which vx does not do.
 */
function globs(
  kind: 'input' | 'output',
  v: unknown,
  ctx: TaskCtx,
  todos: string[],
): { auto: boolean; uncached: boolean; lists: Record<string, string[]> } {
  if (!Array.isArray(v)) return { auto: true, uncached: false, lists: {} }
  let auto = false
  let uncached = false
  const files: string[] = []
  const ws: string[] = []
  for (const e of v as Glob[]) {
    let pattern: string
    let workspace = ctx.atRoot
    if (typeof e === 'string') pattern = e
    else if (typeof e === 'object' && e !== null && 'auto' in e) {
      if (e.auto === true) auto = true
      continue
    } else if (typeof e === 'object' && e !== null && typeof e.pattern === 'string') {
      pattern = e.pattern
      if (e.base === 'workspace') workspace = true
    } else continue
    const neg = pattern.startsWith('!')
    const raw = neg ? pattern.slice(1) : pattern
    // wax refuses a glued `**` (`src/**.ts`), and so does core.
    const wax = hasGluedGlobstar(raw) ? null : minimatchToVx(raw, neg)
    if (wax === null) {
      todos.push(
        `${kind} ${JSON.stringify(pattern)}: glob syntax vx cannot take — ` +
          (kind === 'input'
            ? 'widened to every package file'
            : 'task runs uncached; declare the exact outputs in a vx.config to cache it'),
      )
      if (kind === 'output') uncached = true
      else if (!neg) files.push('**/*')
      continue
    }
    let body = wax.replace(/^(\.\/)+/, '')
    if (!workspace && body.startsWith('../')) {
      const anchored = path.posix.normalize(path.posix.join(ctx.pkgDir, body))
      if (anchored.startsWith('../')) {
        todos.push(`${kind} ${JSON.stringify(pattern)}: leaves the workspace — map manually`)
        if (kind === 'output') uncached = true
        continue
      }
      body = anchored
      workspace = true
    }
    ;(workspace ? ws : files).push((neg ? '!' : '') + body)
  }
  negationsAcrossBases(files, ws, ctx.atRoot ? '' : ctx.pkgDir)
  const lists: Record<string, string[]> = {}
  if (kind === 'input') {
    // Exclusions alone narrow every file.
    if (files.length > 0 && files.every((g) => g.startsWith('!'))) files.unshift('**/*')
    lists['files'] = withoutTakenBack(files)
    if (ws.length > 0) lists['workspaceFiles'] = withoutTakenBack(ws)
  } else {
    lists['files'] = takingBack(files)
    const w = takingBack(ws)
    if (w.length > 0) lists['workspaceFiles'] = w
  }
  return { auto, uncached, lists }
}
