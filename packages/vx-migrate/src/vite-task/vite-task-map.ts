// Vite Task (vite-plus's `vp run`) → vx: each package's `vite.config`
// `run` block and its package.json scripts, as the projects a migration
// plan writes. The schema is vite-plus's `RunConfig` (1.1): a task is a
// command string, an array of them, or `{ command, cwd, dependsOn, cache }`.
// vite-plus 0.x put `env`, `untrackedEnv`, `input` and `output` on the task
// itself beside `cache: true | false`; both shapes map.

import { existsSync } from 'node:fs'
import path from 'node:path'
import { type GeneratedProject, type GeneratedTask, type ProjectMeta, UserError } from '@vzn/vx'
import { minimatchToVx, withoutTakenBack } from '../glob-grammar.js'
import { packageScripts, relPosix } from '../paths.js'
import { scriptCommand, yarnPnp } from '../script-command.js'
import {
  ownFileOutput,
  ownFileTodo,
  takingBack,
  wildcardOutput,
  wildcardTodo,
} from '../shared-outputs.js'
import type { TrackedKinds } from '../tracked-outputs.js'

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

/**
 * A package's `run` block, as `vp run` reads it: the config evaluated in
 * build mode (vite-plus resolves it with `command: 'build'`), a function
 * config called. Bun loads the TypeScript itself.
 */
async function readRunConfig(file: string, root: string): Promise<RunConfig | null> {
  let config: unknown
  try {
    config = ((await import(file)) as { default?: unknown }).default
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
  /** The env names the tracked files under `dirs` spell: a `*` env entry's stand-in. */
  sourceNames?: (dirs: readonly string[]) => Promise<readonly string[]>
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
  metas: readonly ProjectMeta[],
): Promise<{ metas: ProjectMeta[]; notes: string[] }> {
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
  metas: readonly ProjectMeta[],
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
  const tasksOf = (m: ProjectMeta): Record<string, unknown> => runs.get(m.name)?.tasks ?? {}
  const defines = (m: ProjectMeta, task: string): boolean =>
    Object.hasOwn(tasksOf(m), task) || typeof packageScripts(m)[task] === 'string'
  const byName = new Map(metas.map((m) => [m.name, m]))
  /** Workspace members `m` lists under each field, by name. */
  const depsIn = (m: ProjectMeta, field: string): string[] => {
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
  function inlineRuns(t: GeneratedTask, self: ProjectMeta): void {
    const exec = t.task?.['exec'] as { command?: unknown } | undefined
    if (typeof exec?.command !== 'string') return
    const parts = exec.command.split('&&').map((p) => p.trim())
    if (!parts.some((p) => VP_RUN.test(p))) return
    const edges: string[] = []
    let i = 0
    for (; i < parts.length && VP_RUN.test(parts[i]!); i++) {
      const e = /[|;()`$<>'"\\\n]/.test(parts[i]!) ? null : runEdges(parts[i]!, self, t.name)
      if (e === null) break
      edges.push(...e)
    }
    if (parts.slice(i).some((p) => VP_RUN.test(p))) {
      const seg = parts.find((p, j) => j >= i && VP_RUN.test(p))!
      t.todos.push(
        `\`${seg}\` runs Vite Task inside the command, which \`vp run\` inlined into its graph: name the tasks it runs under dependsOn and drop it from the command`,
      )
      return
    }
    const deps = (t.task!['dependsOn'] as string[] | undefined) ?? []
    t.task!['dependsOn'] = [...new Set([...deps, ...edges])]
    const rest = parts.slice(i).join(' && ')
    if (rest === '') delete t.task!['exec']
    else exec.command = rest
  }

  /** The edges one `vp run` stands for, or null when it has none. */
  function runEdges(segment: string, self: ProjectMeta, own: string): string[] | null {
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
    let picked: ProjectMeta[]
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
  const wildUsed = new Map<string, number>()
  for (const meta of metas) {
    const pkgDir = relPosix(root, meta.dir)
    const atRoot = pkgDir === '' || pkgDir === '.'
    const tasks: GeneratedTask[] = []
    const own = tasksOf(meta)
    // A `*` env entry matches names in the run's environment; a written
    // config lists the ones this package and its workspace dependencies spell.
    const wild = Object.values(own).some((raw) => {
      const def = (typeof raw === 'object' && raw !== null ? raw : {}) as TaskDef
      const c = (typeof def.cache === 'object' && def.cache !== null ? def.cache : def) as CacheDef
      return [...asStrings(c.env), ...asStrings(c.untrackedEnv)].some(
        (e) => !e.startsWith('!') && e.includes('*'),
      )
    })
    let spelled: readonly string[] | undefined
    if (wild && opts.sourceNames !== undefined) {
      const closure = new Set<ProjectMeta>([meta])
      for (const p of closure)
        for (const field of [...DEP_FIELDS, 'optionalDependencies'])
          for (const n of depsIn(p, field)) closure.add(byName.get(n)!)
      spelled = await opts.sourceNames([...closure].map((p) => p.dir))
    }
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
          spelled,
          wildUsed,
        }),
      )
    }

    /**
     * `{ task, from }`: the task in each direct member `from` lists that
     * defines it. `^task` is that set while no member listed under another
     * field defines it too (vx's `^` follows every field); else the edges.
     */
    function fromDeps(m: ProjectMeta, entry: { task: string; from: unknown }): string[] {
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
    if (tasks.length > 0) projects.push({ name: meta.name, dir: meta.dir, importLines: [], tasks })
  }
  const notes = [...wildUsed].map(
    ([e, n]) =>
      `env ${JSON.stringify(e)}: the configs list the names the files of each task's package and its ` +
      `workspace dependencies spell (${n} task${n === 1 ? '' : 's'}) — add any other a task reads to ` +
      'cache.inputs.env and exec.env.passThrough',
  )
  return { projects, notes }
}

/** The TODO for what Vite Task traces and vx declares. */
function autoTodo(what: string, known?: Record<string, unknown>): string {
  const have = known === undefined ? '' : ` (declared so far: \`${JSON.stringify(known)}\`)`
  return (
    `cache: Vite Task traced this task's ${what} and vx infers none — add ` +
    `\`cache: { inputs: { files: [...] }, outputs: { files: [...] } }\` with the real ones${have}; ` +
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
  spelled: readonly string[] | undefined
  /** Each `*` entry the spelled names stood in for, with its task count. */
  wildUsed: Map<string, number>
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

  const env = envNames('cache.env', cache?.env, todos, ctx)
  const pass = [
    ...new Set([...env, ...envNames('cache.untrackedEnv', cache?.untrackedEnv, todos, ctx)]),
  ]
  if (pass.length > 0) exec['env'] = { passThrough: pass }
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
  const inputLists: Record<string, unknown> = { ...inputs.lists }
  if (env.length > 0) inputLists['env'] = env
  task['cache'] = { inputs: inputLists, outputs: outputs.lists }
  return { name, todos, task }
}

/**
 * `env` / `untrackedEnv` as the exact names vx takes. `*` matches any run
 * of characters and `!` takes names back, as Vite Task's patterns do; a `*`
 * entry lists the names `spelled` holds that it matches (the bare prefix is
 * no name), or is a TODO when none does.
 */
function envNames(
  field: string,
  v: unknown,
  todos: string[],
  { spelled, wildUsed }: Pick<TaskCtx, 'spelled' | 'wildUsed'>,
): string[] {
  const re = (p: string): RegExp => new RegExp(`^${p.split('*').map(RegExp.escape).join('.*')}$`)
  const names: string[] = []
  const dropped: RegExp[] = []
  for (const e of asStrings(v)) {
    if (e.startsWith('!')) {
      dropped.push(re(e.slice(1)))
      continue
    }
    const hits =
      e.includes('*') && spelled !== undefined
        ? spelled.filter((n) => n !== e.replaceAll('*', '') && re(e).test(n))
        : []
    if (hits.length > 0) {
      names.push(...hits)
      wildUsed.set(e, (wildUsed.get(e) ?? 0) + 1)
      continue
    }
    if (/[*?[\]{}=\0]/.test(e) || e === '') {
      todos.push(
        `${field} ${JSON.stringify(e)}: vx takes exact env names — list the ones the task reads in exec.env.passThrough${field === 'cache.env' ? ' and cache.inputs.env' : ''}`,
      )
      continue
    }
    names.push(e)
  }
  return [...new Set(names)].filter((n) => !dropped.some((d) => d.test(n)))
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
    const wax = minimatchToVx(raw, neg)
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
  const lists: Record<string, string[]> = {}
  if (kind === 'input') {
    // Exclusions alone narrow every file; core refuses a list of them alone.
    if (files.length > 0 && files.every((f) => f.startsWith('!'))) files.unshift('**/*')
    lists['files'] = withoutTakenBack(files)
    if (ws.length > 0) lists['workspaceFiles'] = withoutTakenBack(ws)
  } else {
    lists['files'] = takingBack(files)
    const w = takingBack(ws)
    if (w.length > 0) lists['workspaceFiles'] = w
  }
  return { auto, uncached, lists }
}
