// lage → vx mapping, the pure half. lage's config is a JS module
// (`lage.config.js` / `.cjs` / `.mjs`) whose `pipeline` names targets the
// way turbo.json does: a task runs a package's npm script, `dependsOn`
// takes `build`, `^build`, `^^build` and `pkg#build`. Two consumers, one
// mapper: `lage()` hands the tasks to the `project` stage live, and
// `bunx @vzn/vx-migrate --from lage` renders them to vx.config.ts files.
//
// lage's rules followed here (lage 2.17.0's target graph builder;
// microsoft/lage, react-native-windows, fluentui-react-native, 2026-09-28):
// - a generic `task` entry applies to every package; `pkg#task` REPLACES
//   it for that package (later key wins), unless
//   `enableTargetConfigMerging` deep-merges them, arrays appended;
// - an npmScript target runs `<npmClient> run <script>` where the package
//   has the script, and is a pass-through no-op where it has none;
// - `^^build` is every transitive dependency's build (dev dependencies
//   included), `^build` the nearest ones;
// - a target's inputs default to every package file; its outputs to
//   `cacheOptions.outputGlob`, else every package file — which vx would
//   clean before a run, so such a target runs uncached.

import path from 'node:path'
import { UserError, type ProjectMeta } from '@vzn/vx'
import { pruneDanglingEdges } from '../dangling-edges.js'
import { minimatchToVx } from '../glob-grammar.js'
import { shellQuote } from '../nx-command.js'
import { packageScripts, relPosix } from '../paths.js'
import { scriptCommand } from '../script-command.js'
import { resolveSharedOutputs } from '../shared-outputs.js'

type Raw = Record<string, unknown>

export interface LageMappedTask {
  name: string
  todos: string[]
  task: Record<string, unknown> | null
}

export interface LageMappedProject {
  name: string
  dir: string
  tasks: LageMappedTask[]
}

export interface LageMapping {
  projects: LageMappedProject[]
  notes: string[]
}

const CONFIG_NAMES = ['lage.config.js', 'lage.config.cjs', 'lage.config.mjs']

/** The workspace's lage config file, or null. */
export async function lageConfigFile(root: string): Promise<string | null> {
  for (const name of CONFIG_NAMES) {
    const file = path.join(root, name)
    if (await Bun.file(file).exists()) return file
  }
  return null
}

// The config is code: it runs in a child, as lage runs it, and comes back
// as JSON with each function a marker. A child and not an import: an
// imported module is cached for the process, and under `vx watch` an edit
// to the config (or a file it requires) mapped the old pipeline.
const LOAD = `
const m = await import(process.argv[1])
let c = m.default ?? m
if (typeof c === 'function') c = await c()
process.stdout.write(JSON.stringify(c ?? {}, (_k, v) => (typeof v === 'function' ? { __function: true } : v)))
`

/** The evaluated config, functions marked; a config that throws is refused with its message. */
export async function loadLageConfig(root: string, file: string): Promise<Raw> {
  // --no-install: a require no node_modules provides is refused, never
  // fetched from the registry and run (L-22).
  const proc = Bun.spawn([process.execPath, '--no-install', '-e', LOAD, file], {
    cwd: root,
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) {
    const last = err.trim().split('\n').filter(Boolean).slice(-3).join(' ')
    throw new UserError(`failed to load ${relPosix(root, file)}: ${last}`)
  }
  const parsed = JSON.parse(out) as unknown
  return isRaw(parsed) ? parsed : {}
}

/** The root package.json's name, when it has one. */
export async function rootPackageName(root: string): Promise<string | undefined> {
  const pj = (await Bun.file(path.join(root, 'package.json'))
    .json()
    .catch(() => ({}))) as Raw
  return typeof pj['name'] === 'string' ? pj['name'] : undefined
}

const isRaw = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
const uniq = <T>(xs: readonly T[]): T[] => [...new Set(xs)]
const isFn = (v: unknown): boolean => isRaw(v) && v['__function'] === true

/** A pipeline value as a target config: an array is its `dependsOn`. */
function targetOf(v: unknown): Raw {
  if (Array.isArray(v)) return { dependsOn: strings(v) }
  return isRaw(v) ? v : {}
}

/** lage's deep merge with arrays appended (`enableTargetConfigMerging`). */
function deepMerge(a: Raw, b: Raw): Raw {
  const out: Raw = { ...a }
  for (const [k, v] of Object.entries(b)) {
    const prev = out[k]
    if (Array.isArray(prev) && Array.isArray(v)) out[k] = [...prev, ...v]
    else if (isRaw(prev) && isRaw(v)) out[k] = deepMerge(prev, v)
    else out[k] = v
  }
  return out
}

const DEP_FIELDS = ['dependencies', 'devDependencies'] as const

interface Ctx {
  root: string
  meta: ProjectMeta
  config: Raw
  pipeline: Raw
  /** Package name → the tasks it emits (a runnable script, a noop, a group). */
  emitted: ReadonlyMap<string, ReadonlySet<string>>
  emittedAnywhere: ReadonlySet<string>
  /** Package name → its transitive workspace dependencies. */
  closure: ReadonlyMap<string, ReadonlySet<string>>
  /** The root package's name: its `name#task` is a root target. */
  rootName: string | undefined
}

/** The target config `task` resolves to in `pkg`, or undefined when the pipeline has none. */
function resolveTarget(
  pipeline: Raw,
  merging: boolean,
  pkg: string,
  task: string,
): Raw | undefined {
  let out: Raw | undefined
  for (const [key, v] of Object.entries(pipeline)) {
    if (key !== task && key !== `${pkg}#${task}`) continue
    const t = targetOf(v)
    out = merging && out !== undefined ? deepMerge(out, t) : t
  }
  return out
}

/** Whether a package emits `task`: a noop, or an npmScript whose script it has. */
function emits(meta: ProjectMeta, t: Raw, task: string): boolean {
  const type = t['type'] ?? 'npmScript'
  if (type === 'noop') return true
  if (type !== 'npmScript') return true
  const script =
    isRaw(t['options']) && typeof t['options']['script'] === 'string'
      ? t['options']['script']
      : task
  const body = packageScripts(meta)[script]
  return typeof body === 'string' && body !== ''
}

function place(ctx: Ctx, p: string): { ws: boolean; path: string } | null {
  const s = p.replace(/^\.\//, '')
  if (!s.startsWith('../')) return { ws: false, path: s }
  const up = path.posix.normalize(path.posix.join(relPosix(ctx.root, ctx.meta.dir), s))
  return up.startsWith('../') ? null : { ws: true, path: up }
}

function mapTask(ctx: Ctx, name: string, t: Raw): LageMappedTask {
  const todos: string[] = []
  const type = t['type'] ?? 'npmScript'
  const merging = ctx.config['enableTargetConfigMerging'] === true
  if (type !== 'npmScript' && type !== 'noop' && type !== 'worker') {
    todos.push(
      `a ${JSON.stringify(type)} target runs through a custom lage runner — task skipped; ` +
        'write the command by hand',
    )
    return { name, todos, task: null }
  }
  if (isFn(t['shouldRun']))
    todos.push('shouldRun is a function vx cannot run — the task always runs')

  let command: string | undefined
  if (type === 'npmScript') {
    const options = isRaw(t['options']) ? t['options'] : {}
    const script = typeof options['script'] === 'string' ? options['script'] : name
    const scripts = packageScripts(ctx.meta)
    const args = strings(options['taskArgs']).map(shellQuote)
    command = [scriptCommand(script, scripts[script] as string, scripts), ...args].join(' ')
  } else if (type === 'worker') {
    command = workerCommand(ctx, name, t, todos)
    if (command === undefined) return { name, todos, task: null }
  }

  const deps: string[] = []
  const edge = (d: string): void => {
    if (!deps.includes(d)) deps.push(d)
  }
  const pkg = ctx.meta.name
  const through = new Set<string>([name])
  const walk = (specs: readonly string[]): void => {
    for (const d of specs) {
      if (
        d.startsWith('#') ||
        d.startsWith('//') ||
        (ctx.rootName !== undefined && d.startsWith(`${ctx.rootName}#`))
      ) {
        todos.push(
          `dependsOn ${JSON.stringify(d)}: a workspace-root target — vx has no root tasks; edge dropped`,
        )
      } else if (d.startsWith('^^')) {
        const task = d.slice(2)
        for (const dep of ctx.closure.get(pkg) ?? []) {
          if (ctx.emitted.get(dep)?.has(task)) edge(`${dep}#${task}`)
        }
      } else if (d.startsWith('^')) {
        if (ctx.emittedAnywhere.has(d.slice(1))) edge(d)
      } else if (d.includes('#')) {
        const hash = d.indexOf('#')
        if (ctx.emitted.get(d.slice(0, hash))?.has(d.slice(hash + 1))) {
          edge(d.slice(0, hash) === pkg ? d.slice(hash + 1) : d)
        } else
          todos.push(
            `dependsOn ${JSON.stringify(d)}: no workspace package runs that task — edge dropped`,
          )
      } else if (ctx.emitted.get(pkg)?.has(d)) {
        edge(d)
      } else if (!through.has(d)) {
        // A target this package has no script for is a no-op in lage's
        // graph that keeps its own edges: followed in its place.
        through.add(d)
        const hop = resolveTarget(ctx.pipeline, merging, pkg, d)
        if (hop !== undefined) walk(strings(hop['dependsOn'] ?? hop['deps']))
      }
    }
  }
  walk(strings(t['dependsOn'] ?? t['deps']))

  const task: Record<string, unknown> = {}
  if (command !== undefined) task['exec'] = { command }
  if (deps.length > 0 || command === undefined) task['dependsOn'] = deps

  if (command !== undefined && t['cache'] !== false) {
    const cache = mapCache(ctx, t, todos)
    if (cache !== null) task['cache'] = cache
  }
  return { name, todos, task }
}

/** Whether a JSON value holds a function marker anywhere. */
function holdsFn(v: unknown): boolean {
  if (isFn(v)) return true
  if (Array.isArray(v)) return v.some(holdsFn)
  return isRaw(v) && Object.values(v).some(holdsFn)
}

/**
 * A worker target as one `lage-worker` process: the module (relative to
 * the package, so the key holds no machine path) and the options it reads
 * from its target, on the command line.
 */
function workerCommand(ctx: Ctx, name: string, t: Raw, todos: string[]): string | undefined {
  const options = isRaw(t['options']) ? t['options'] : {}
  const worker = options['worker'] ?? options['script']
  if (typeof worker !== 'string' || worker === '') {
    todos.push('a worker target names no worker module — task skipped')
    return undefined
  }
  const abs = path.resolve(ctx.root, worker)
  const rel = relPosix(ctx.meta.dir, abs)
  if (relPosix(ctx.root, abs).startsWith('../')) {
    todos.push(`worker ${JSON.stringify(worker)} is outside the workspace — task skipped`)
    return undefined
  }
  const { worker: _w, script: _s, taskArgs, ...rest } = options
  if (holdsFn(rest)) {
    todos.push(
      'the worker options hold a function vx cannot pass — task skipped; write the command by hand',
    )
    return undefined
  }
  const words = [
    'lage-worker',
    rel.startsWith('.') ? rel : `./${rel}`,
    '--package',
    ctx.meta.name,
    '--task',
    name,
  ]
  if (Object.keys(rest).length > 0) words.push('--options', JSON.stringify(rest))
  words.push(...strings(taskArgs))
  return words.map(shellQuote).join(' ')
}

function mapCache(ctx: Ctx, t: Raw, todos: string[]): Raw | null {
  const cacheOptions = isRaw(ctx.config['cacheOptions']) ? ctx.config['cacheOptions'] : {}
  const rawOutputs = Array.isArray(t['outputs']) ? t['outputs'] : cacheOptions['outputGlob']
  if (!Array.isArray(rawOutputs)) {
    todos.push(
      'no outputs and no cacheOptions.outputGlob: lage caches every package file, which vx would ' +
        'clean before a run — task runs uncached; declare its outputs to cache it',
    )
    return null
  }
  const outFiles: string[] = []
  for (const o of strings(rawOutputs)) {
    const at = o.startsWith('!') ? null : place(ctx, o)
    const glob = at === null || at.ws ? null : minimatchToVx(at.path, false)
    if (glob === null || /[*?{[]/.test(glob.split('/')[0] ?? '')) {
      todos.push(
        `output ${JSON.stringify(o)}: a negation, a path outside the package or a wildcard first ` +
          'segment, which vx would clean with the sources — task runs uncached; declare the exact ' +
          'outputs in a vx.config to cache it',
      )
      return null
    }
    outFiles.push(glob)
  }

  const files: string[] = []
  const ws: string[] = []
  const rawInputs = Array.isArray(t['inputs']) ? strings(t['inputs']) : ['**/*']
  for (const i of rawInputs) {
    const neg = i.startsWith('!')
    const at = place(ctx, neg ? i.slice(1) : i)
    const glob = at === null ? null : minimatchToVx(at.path, neg)
    if (at === null || glob === null) {
      todos.push(
        `input ${JSON.stringify(i)}: outside the workspace or glob syntax vx cannot take — every package file is keyed`,
      )
      if (!neg) files.push('**/*')
      continue
    }
    ;(at.ws ? ws : files).push((neg ? '!' : '') + glob)
  }
  if (files.length > 0 && files.every((f) => f.startsWith('!'))) files.unshift('**/*')
  const env = Array.isArray(t['environmentGlob'])
    ? t['environmentGlob']
    : cacheOptions['environmentGlob']
  // Relative to the git root, and a leading `/` names it (lage's own config: `/package.json`).
  for (const raw of strings(env)) {
    const neg = raw.startsWith('!')
    const g = (neg ? '!' : '') + (neg ? raw.slice(1) : raw).replace(/^\/+/, '')
    const glob = minimatchToVx(g, neg)
    if (glob === null)
      todos.push(`environmentGlob ${JSON.stringify(g)}: glob syntax vx cannot take — map manually`)
    else ws.push(glob)
  }
  if (ws.length > 0 && ws.every((f) => f.startsWith('!'))) ws.length = 0
  const inputs: Raw = { files: uniq(files) }
  if (ws.length > 0) inputs['workspaceFiles'] = uniq(ws)
  return { inputs, outputs: { files: uniq(outFiles) } }
}

/** Each package's transitive workspace dependencies (dev included, as lage's `^^` walks them). */
function closures(metas: readonly ProjectMeta[]): Map<string, Set<string>> {
  const names = new Set(metas.map((m) => m.name))
  const direct = new Map<string, string[]>()
  for (const m of metas) {
    const pj = m.packageJson as unknown as Raw
    direct.set(
      m.name,
      DEP_FIELDS.flatMap((f) => (isRaw(pj[f]) ? Object.keys(pj[f]) : [])).filter(
        (d) => names.has(d) && d !== m.name,
      ),
    )
  }
  const out = new Map<string, Set<string>>()
  for (const m of metas) {
    const seen = new Set<string>()
    const stack = [...(direct.get(m.name) ?? [])]
    while (stack.length > 0) {
      const d = stack.pop()!
      if (seen.has(d) || d === m.name) continue
      seen.add(d)
      stack.push(...(direct.get(d) ?? []))
    }
    out.set(m.name, seen)
  }
  return out
}

export function mapLageWorkspace(
  root: string,
  metas: readonly ProjectMeta[],
  config: Raw,
  rootName?: string,
): LageMapping {
  const notes: string[] = []
  const pipeline = isRaw(config['pipeline']) ? config['pipeline'] : {}
  const merging = config['enableTargetConfigMerging'] === true
  const isRootKey = (k: string): boolean =>
    k.startsWith('#') ||
    k.startsWith('//') ||
    (rootName !== undefined && k.startsWith(`${rootName}#`))
  const rootTargets = Object.keys(pipeline).filter(isRootKey)
  if (rootTargets.length > 0) {
    notes.push(
      `note: workspace-root targets (${rootTargets.join(', ')}) are not mapped — vx has no workspace-root tasks`,
    )
  }
  const tasksOf = (m: ProjectMeta): string[] =>
    uniq(
      Object.keys(pipeline).flatMap((k) => {
        if (isRootKey(k)) return []
        const hash = k.indexOf('#')
        if (hash === -1) return [k]
        return k.slice(0, hash) === m.name ? [k.slice(hash + 1)] : []
      }),
    )
  const packages = metas.filter(
    (m) => path.resolve(m.dir) !== path.resolve(root) || metas.length === 1,
  )
  const emitted = new Map<string, Set<string>>()
  const emittedAnywhere = new Set<string>()
  for (const m of packages) {
    const set = new Set<string>()
    for (const task of tasksOf(m)) {
      const t = resolveTarget(pipeline, merging, m.name, task)
      if (t !== undefined && emits(m, t, task)) set.add(task)
    }
    emitted.set(m.name, set)
    for (const n of set) emittedAnywhere.add(n)
  }
  const closure = closures(packages)
  const projects: LageMappedProject[] = []
  for (const m of packages) {
    const ctx: Ctx = {
      root,
      meta: m,
      config,
      pipeline,
      emitted,
      emittedAnywhere,
      closure,
      rootName,
    }
    const tasks = [...emitted.get(m.name)!].map((name) =>
      mapTask(ctx, name, resolveTarget(pipeline, merging, m.name, name)!),
    )
    // A group task left with no edge is refused by core; lage runs it as nothing.
    for (const t of tasks) {
      const deps = t.task?.['dependsOn']
      if (
        t.task !== null &&
        t.task['exec'] === undefined &&
        Array.isArray(deps) &&
        deps.length === 0
      ) {
        t.task = { dependsOn: [] }
      }
    }
    if (tasks.length > 0) projects.push({ name: m.name, dir: m.dir, tasks })
  }
  pruneDanglingEdges(projects)
  for (const p of projects) resolveSharedOutputs(p.tasks)
  return { projects, notes }
}
