// Nx → vx mapping over the RESOLVED project graph, shared by the two
// consumers: `bunx @vzn/vx-migrate --from nx` writes it to files, and the
// `nx()` plugin runs it live. Static by design: targets that Nx plugins
// infer at runtime are whatever the graph says. Named inputs expand from
// nx.json when readable; the graph's dependency edges are ignored (vx
// derives package edges from package.json manifests) except for one
// report line counting edges with no manifest counterpart.
//
// Executors: `nx:run-commands`, a plain `command` and `nx:run-script` are
// shell; `nx:noop` is a group; every other executor runs through this
// package's `nx-exec` bin with the executor and its resolved options on
// the command line (design: docs/design/nx-unchanged-2026-09.md). A
// configuration is a task of its own, `<target>:<configuration>`; the
// default configuration is folded into the base task.

import path from 'node:path'
import {
  buildPackageGraph,
  type GeneratedProject,
  type GeneratedTask,
  type ProjectMeta,
  pruneOrphanPersistentNotes,
  UserError,
} from '@vzn/vx'
import { mapRunCommands, shellQuote } from '../nx-command.js'
import { scriptCommand, yarnPnp } from '../script-command.js'
import {
  ownFileOutput,
  ownFileTodo,
  resolveSharedOutputs,
  resolveSharedWorkspaceOutputs,
  wildcardOutput,
  wildcardTodo,
} from '../shared-outputs.js'
import type { TrackedKinds } from '../tracked-outputs.js'
import { packageScripts, relPosix } from '../paths.js'
import { mapNxDeps, matchNxProjects, type TaskNameFor } from './nx-deps.js'
import {
  dotenvCandidates,
  type DotenvListing,
  existingDotenv,
  listDotenv,
  ownerTargetOf,
} from './nx-dotenv.js'
import { emptyNxInputs, expandNxInputs } from './nx-inputs.js'
import { planNxUpstream, type NxUpstream } from './nx-upstream.js'
import { mapNxOutputs, nxDefaultOutputs, nxProjectOutputs } from './nx-outputs.js'

const PLACEHOLDER = "echo 'TODO(vx-migrate): fill in' && exit 1"

interface NxTarget {
  executor?: string
  command?: string
  options?: Record<string, unknown>
  configurations?: Record<string, Record<string, unknown>>
  defaultConfiguration?: string
  inputs?: unknown[]
  outputs?: string[]
  dependsOn?: unknown[]
  cache?: boolean
  continuous?: boolean
  parallelism?: boolean
  syncGenerators?: unknown[]
  metadata?: { nonAtomizedTarget?: unknown }
}

interface NxNode {
  name?: string
  data?: {
    root?: string
    namedInputs?: Record<string, unknown[]>
    targets?: Record<string, NxTarget>
    metadata?: { targetGroups?: unknown }
  }
}

type NxEdge = { source?: string; target?: string }

/** The two shapes a graph file takes, reduced to the one the mapper reads. */
export interface NxGraph {
  nodes: Record<string, NxNode>
  dependencies: unknown
}

/**
 * Both `{ graph: { nodes, dependencies } }` (`nx graph --file`) and
 * top-level `{ nodes, dependencies }` (Nx's own cache) exist across nx
 * versions. `label` names the source in the error.
 */
export function parseNxGraph(text: string, label: string): NxGraph {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new UserError(`failed to parse ${label}: ${msg}`)
  }
  // `?.`: a file of `null` is JSON, and read as an object it threw a bare
  // TypeError instead of naming the shape it wanted (item 811).
  const g = ((parsed as { graph?: unknown } | null)?.graph ?? parsed) as {
    nodes?: unknown
    dependencies?: unknown
  }
  const nodes = g?.nodes
  if (typeof nodes !== 'object' || nodes === null) {
    throw new UserError(
      `${label}: unrecognized shape — expected { graph: { nodes, dependencies } } ` +
        'or { nodes, dependencies }',
    )
  }
  checkNxNodes(nodes as Record<string, unknown>, label)
  return { nodes: nodes as Record<string, NxNode>, dependencies: g.dependencies }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Every dependency name the root package.json declares; none without one. */
async function rootDependencies(root: string): Promise<ReadonlySet<string>> {
  const pkg = (await Bun.file(path.join(root, 'package.json'))
    .json()
    .catch(() => null)) as Record<string, unknown> | null
  const names = new Set<string>()
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const deps = pkg?.[field]
    if (deps && typeof deps === 'object') for (const n of Object.keys(deps)) names.add(n)
  }
  return names
}

/**
 * The shape of every node field the mapper reads, refused by name. A
 * number where the graph holds a list reached the mapper's loops as a
 * TypeError: `"dependsOn": true` threw `true is not iterable` (fuzzed,
 * L-15, as turbo.json's reader did).
 */
function checkNxNodes(nodes: Record<string, unknown>, label: string): void {
  const refuse = (at: string, what: string): never => {
    throw new UserError(`${label}: ${at} must be ${what}`)
  }
  const optional = (v: unknown, at: string, ok: (v: unknown) => boolean, what: string): void => {
    if (v !== undefined && !ok(v)) refuse(at, what)
  }
  const strings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string')
  const entries = (v: unknown) =>
    Array.isArray(v) && v.every((x) => typeof x === 'string' || isRecord(x))
  for (const [id, node] of Object.entries(nodes)) {
    const at = `nodes.${JSON.stringify(id)}`
    if (!isRecord(node)) refuse(at, 'an object')
    const n = node as Record<string, unknown>
    optional(n['name'], `${at}.name`, (v) => typeof v === 'string', 'a string')
    optional(n['data'], `${at}.data`, isRecord, 'an object')
    const data = (n['data'] ?? {}) as Record<string, unknown>
    optional(data['root'], `${at}.data.root`, (v) => typeof v === 'string', 'a string')
    optional(data['targets'], `${at}.data.targets`, isRecord, 'an object of targets')
    for (const [name, target] of Object.entries((data['targets'] ?? {}) as object)) {
      const t = `${at}.data.targets.${JSON.stringify(name)}`
      if (!isRecord(target)) refuse(t, 'an object')
      const tt = target as Record<string, unknown>
      optional(tt['dependsOn'], `${t}.dependsOn`, entries, 'an array of targets')
      optional(tt['inputs'], `${t}.inputs`, entries, 'an array of inputs')
      optional(tt['outputs'], `${t}.outputs`, strings, 'an array of strings')
      optional(tt['options'], `${t}.options`, isRecord, 'an object')
      for (const k of ['executor', 'command'])
        optional(tt[k], `${t}.${k}`, (v) => typeof v === 'string', 'a string')
    }
  }
}

export interface MapNxOptions {
  /** The note a persistent task carries (the CLI's TODO, the plugin's warning). */
  readonly persistentTodo: string
  /** nx.json's legacy `cacheableOperations`, for a graph whose targets carry no `cache` field. */
  readonly cacheable: ReadonlySet<string>
  /**
   * The projects whose tasks will exist (the plugin's workspace packages).
   * Absent, every mapped project's do: the CLI writes a config for each.
   */
  readonly attached?: ReadonlySet<string>
  /**
   * What git tracks under a root-relative project directory: a
   * wildcard-first output of a kind it has none of stays cached, as in
   * `turbo()`. Absent, every wildcard-first output runs uncached.
   */
  readonly tracked?: (rel: string) => TrackedKinds
  /**
   * The config file name a root-relative project's mapped tasks live beside
   * (null: none), which core holds an output to. Absent, every spelling.
   */
  readonly ownConfig?: (rel: string) => string | null
  /**
   * A script's `npm_package_name` / `npm_package_version`: `vx-migrate`
   * reads them from the manifest it imports (`{ raw: 'pkg.version' }`), so a
   * bump reaches a written config, as `turbo()`'s mapper does; absent, the
   * values themselves (the plugin re-maps on a manifest edit).
   */
  readonly manifestField?: (key: 'name' | 'version') => unknown
}

/** The options with what the mapper reads itself: the root's dependency names. */
type MapOpts = MapNxOptions & {
  readonly rootDeps: ReadonlySet<string>
  readonly pnp: boolean
  /** Tasks per `syncGenerators` list, said once in the notes. */
  readonly syncTasks: Map<string, number>
}

export interface NxMapping {
  readonly projects: GeneratedProject[]
  /** Workspace-wide gaps, one line each. */
  readonly notes: string[]
}

function normRel(p: string): string {
  return p === '' || p === '.' ? '.' : p.replace(/\/$/, '')
}

export async function mapNxWorkspace(
  root: string,
  metas: readonly ProjectMeta[],
  graph: NxGraph,
  opts: MapNxOptions,
): Promise<NxMapping> {
  const nodeMap = graph.nodes
  const g = graph

  const { namedInputs, cacheable, globalSync } = await readNxJsonFacts(root)
  const mapOpts: MapOpts = {
    ...opts,
    cacheable: new Set([...opts.cacheable, ...cacheable]),
    rootDeps: await rootDependencies(root),
    pnp: yarnPnp(root),
    syncTasks: new Map(),
  }

  const metaByRel = new Map<string, ProjectMeta>()
  for (const meta of metas) metaByRel.set(normRel(relPosix(root, meta.dir)), meta)
  const metaByNode = new Map<string, ProjectMeta>()
  const nodeByMeta = new Map<ProjectMeta, NxNode>()
  const nodeNameOf = new Map<ProjectMeta, string>()
  for (const [nodeName, node] of Object.entries(nodeMap)) {
    const meta = metaByRel.get(normRel(node?.data?.root ?? ''))
    if (meta) {
      metaByNode.set(nodeName, meta)
      nodeByMeta.set(meta, node)
      nodeNameOf.set(meta, nodeName)
    }
  }

  // Graph nodes with no discovered counterpart: the ROOT project is
  // the common case — `packages/*` discovery never lists the
  // workspace root, but Nx routinely defines root targets. Synthesize
  // a meta for any unmatched node whose root resolves inside the
  // workspace, so its targets migrate too.
  const allMetas: ProjectMeta[] = [...metas]
  const taken = new Set(metas.map((m) => m.name))
  for (const [nodeName, node] of Object.entries(nodeMap)) {
    if (metaByNode.has(nodeName)) continue
    const relRoot = normRel(node?.data?.root ?? '')
    if (node?.data?.targets === undefined) continue
    const dir = relRoot === '' || relRoot === '.' ? root : path.join(root, relRoot)
    let pkg: ProjectMeta['packageJson'] = { name: nodeName }
    try {
      pkg = (await Bun.file(path.join(dir, 'package.json')).json()) as ProjectMeta['packageJson']
    } catch {
      // No manifest at the node root — keep the synthetic one.
    }
    // A manifest name a package already holds (a root package.json named
    // after its app) replaced that package's tasks with the node's; the
    // Nx name is the node's own.
    const name = [pkg.name, nodeName].find((n) => n && !taken.has(n))
    if (name === undefined) continue
    taken.add(name)
    const synthetic: ProjectMeta = {
      name,
      dir,
      packageJson: pkg,
      configPath: null,
    }
    allMetas.push(synthetic)
    metaByNode.set(nodeName, synthetic)
    nodeByMeta.set(synthetic, node)
    nodeNameOf.set(synthetic, nodeName)
  }

  const upstream = planNxUpstream(nodeMap, g.dependencies, namedInputs, metaByNode)

  const taskNameFor: TaskNameFor = (project, target, configuration) => {
    const t = nodeMap[project]?.data?.targets?.[target]
    if (t === undefined) return null
    const v = variants(target, t).find((x) => x.configuration === configuration)
    return v === undefined ? null : v.name
  }

  // Once per project, not per task and variant: `path.relative` was a
  // fifth of the mapping at 1,000 projects (item 608).
  const relOf = new Map<ProjectMeta, string>()
  for (const meta of allMetas) {
    if (nodeByMeta.get(meta)?.data?.targets) relOf.set(meta, normRel(relPosix(root, meta.dir)))
  }
  // Nx loads a task's `.env` files unless NX_LOAD_DOT_ENV_FILES is `false`;
  // one listing per project dir decides which exist (~4 ms at 1,000).
  const listing: DotenvListing | null =
    process.env['NX_LOAD_DOT_ENV_FILES'] === 'false'
      ? null
      : await listDotenv(root, [...relOf.values()])

  const mapped: Array<{ meta: ProjectMeta; tasks: GeneratedTask[] }> = []
  // A configuration variant's task (`build:production`) and what it runs.
  const configured = new WeakMap<GeneratedTask, string>()
  // The target an atomizer split (cypress's `e2e`, named by each
  // `e2e-ci--<spec>`'s `nonAtomizedTarget`), each configuration of it too.
  const split = new Set<GeneratedTask>()
  for (const meta of allMetas) {
    const node = nodeByMeta.get(meta)
    const targets = node?.data?.targets
    if (!targets) continue
    const tasks: GeneratedTask[] = []
    const projectName = node?.name ?? meta.name
    const projectRel = relOf.get(meta)!
    const scripts = packageScripts(meta)
    // Relative to the project dir, where vx runs the task.
    const dotenvFor = (
      l: DotenvListing,
      targetName: string,
      configuration: string | undefined,
    ): string[] => {
      const [owner, parent] = ownerTargetOf(targetName, targets, node?.data?.metadata?.targetGroups)
      return existingDotenv(dotenvCandidates(projectRel, owner, configuration, parent), l).map(
        (f) => relPosix(projectRel, f),
      )
    }
    const atomized = new Set(Object.values(targets).map((t) => t.metadata?.nonAtomizedTarget))
    for (const [targetName, target] of Object.entries(targets)) {
      for (const v of variants(targetName, target)) {
        const t = buildTask(
          meta,
          projectRel,
          scripts,
          projectName,
          targetName,
          target,
          v,
          nodeNameOf.get(meta)!,
          upstream,
          metaByNode,
          nodeMap,
          taskNameFor,
          mapOpts,
          listing === null ? null : dotenvFor(listing, targetName, v.configuration),
        )
        if (v.name !== targetName) configured.set(t, v.configuration!)
        if (atomized.has(targetName)) split.add(t)
        tasks.push(t)
      }
    }
    mapped.push({ meta, tasks })
  }
  // The `nx-input:<name>` twins the `^` inputs above asked for, in every
  // project a graph node owns — one with no targets too.
  const byMeta = new Map(mapped.map((m) => [m.meta, m]))
  for (const [nodeName, list] of upstream.inputTasks()) {
    const meta = metaByNode.get(nodeName)!
    const entry = byMeta.get(meta)
    if (entry !== undefined) entry.tasks.push(...list)
    else mapped.push({ meta, tasks: list })
  }

  // Nx gives `^name` no edges when no project runs the target; core refuses
  // a `^name` no project declares as a typo, so such an edge is dropped
  // before the shared-output rule reads which tasks have a `^` edge.
  // Counted over the projects that will carry tasks: a target only the
  // unattached root declares kept its `^` edge, and core refused the run
  // (item 1051).
  const emitted = new Set<string>()
  const emittedIds = new Set<string>()
  for (const { meta, tasks } of mapped) {
    if (opts.attached !== undefined && !opts.attached.has(meta.name)) continue
    for (const t of tasks) {
      if (t.task === null) continue
      emitted.add(t.name)
      emittedIds.add(`${meta.name}#${t.name}`)
    }
  }
  const nxEdges = nxDependencyTargets(nodeMap, g.dependencies)
  // What vx's `^` already reaches: a manifest path, direct or through
  // another project, orders `^x` and folds its key (item 931). Built once,
  // on the first `^` edge.
  let reach: ((name: string) => ReadonlySet<string>) | undefined
  const reached = (name: string): ReadonlySet<string> => {
    if (reach === undefined) {
      const graph = buildPackageGraph([...metas])
      const memo = new Map<string, ReadonlySet<string>>()
      reach = (n) => {
        let r = memo.get(n)
        if (r === undefined) memo.set(n, (r = new Set(graph.transitiveDeps(n))))
        return r
      }
    }
    return reach(name)
  }
  const projects: GeneratedProject[] = []
  for (const { meta, tasks } of mapped) {
    const nodeName = nodeNameOf.get(meta)
    for (const t of tasks) {
      const c = configured.get(t)
      if (nodeName !== undefined && c !== undefined)
        passConfiguration(t.task, nodeName, c, nxEdges, metaByNode, emittedIds, taskNameFor)
      if (nodeName !== undefined)
        followNxGraph(t.task, nodeName, meta.name, nxEdges, metaByNode, emittedIds, reached)
      dropUnheldDeps(t, emitted, emittedIds)
    }
    projects.push({
      name: meta.name,
      dir: meta.dir,
      importLines: [],
      tasks: resolveSharedOutputs(tasks),
    })
  }

  resolveAtomizedWorkspaceOutputs(root, projects, split)
  pruneOrphanPersistentNotes(projects, opts.persistentTodo)
  const notes: string[] =
    globalSync.length === 0
      ? []
      : [
          `nx.json \`sync.globalGenerators\` (${globalSync.map((g) => JSON.stringify(g)).join(', ')}): ` +
            'Nx runs them before a run, and vx does not — run `nx sync` when they are out of date',
        ]
  for (const [gens, n] of mapOpts.syncTasks)
    notes.push(
      `\`syncGenerators\` (${gens}) on ${n} task${n === 1 ? '' : 's'}: ` +
        'Nx runs them before those targets, and vx does not — run `nx sync` when they are out of date',
    )
  return { projects, notes }
}

/**
 * The shared-workspace-output rule keeps the first task on a path cached.
 * Cypress's atomizer gives `e2e` the whole `videos` dir and each
 * `e2e-ci--<spec>` a subdir of it, so `e2e` first ran every spec's CI task
 * uncached — the tasks atomizing exists to cache and distribute
 * (nx-examples). The split target is tried last too, and the order that
 * leaves more tasks cached wins; on a tie (jest's children share one path)
 * the declared order stands.
 */
function resolveAtomizedWorkspaceOutputs(
  root: string,
  projects: GeneratedProject[],
  split: ReadonlySet<GeneratedTask>,
): void {
  const last = projects.map((p) => ({
    name: p.name,
    dir: p.dir,
    tasks: [...p.tasks.filter((t) => !split.has(t)), ...p.tasks.filter((t) => split.has(t))],
  }))
  const cached = (ps: readonly { name: string; dir: string; tasks: GeneratedTask[] }[]): number => {
    const copy = structuredClone(ps.map((p) => ({ name: p.name, dir: p.dir, tasks: p.tasks })))
    resolveSharedWorkspaceOutputs(root, copy)
    return copy.reduce(
      (n, p) => n + p.tasks.filter((t) => t.task?.['cache'] !== undefined).length,
      0,
    )
  }
  const better = split.size > 0 && cached(last) > cached(projects)
  resolveSharedWorkspaceOutputs(root, better ? last : projects)
}

/**
 * One task per configuration: the base task carries the default
 * configuration's options (what `nx run p:t` runs), every other one is
 * `<t>:<c>`. Nx merges a configuration over the options field by field.
 */
interface Variant {
  /** The vx task name. */
  name: string
  configuration: string | undefined
  options: Record<string, unknown>
}

function variants(targetName: string, target: NxTarget): Variant[] {
  const base = target.options ?? {}
  const configs =
    typeof target.configurations === 'object' && target.configurations !== null
      ? target.configurations
      : {}
  const dflt =
    typeof target.defaultConfiguration === 'string' && configs[target.defaultConfiguration]
      ? target.defaultConfiguration
      : undefined
  const out: Variant[] = [
    {
      name: targetName,
      configuration: dflt,
      options: dflt === undefined ? base : { ...base, ...configs[dflt] },
    },
  ]
  for (const [c, over] of Object.entries(configs)) {
    if (c === dflt || typeof over !== 'object' || over === null) continue
    out.push({ name: `${targetName}:${c}`, configuration: c, options: { ...base, ...over } })
  }
  return out
}

/** What the mapper reads from nx.json: the named inputs and the legacy cacheable list. */
interface NxJsonFacts {
  readonly namedInputs: Record<string, unknown[]> | null
  readonly cacheable: ReadonlySet<string>
  /** `sync.globalGenerators`: Nx runs them before a run's tasks. */
  readonly globalSync: readonly string[]
}

/**
 * `nx.json` as Nx reads it: an `extends` base (a path or a package,
 * resolved from the file's directory) merged shallowly under it, the base's
 * own `extends` first. Only the raw file was read, so named inputs a base
 * declared fell back to `{projectRoot}/**` with no word and a `sharedGlobals`
 * edit re-ran nothing (item 1050). `files` lists every file read, which the
 * graph snapshot's freshness stats. Null when `nx.json` is absent; a file
 * that does not parse throws.
 */
export async function readNxJson(
  root: string,
): Promise<{ json: Record<string, unknown>; files: string[] } | null> {
  const first = path.join(root, 'nx.json')
  if (!(await Bun.file(first).exists())) return null
  const files: string[] = []
  const layers: Record<string, unknown>[] = []
  let at: string | null = first
  while (at !== null && !files.includes(at)) {
    files.push(at)
    const parsed = (Bun.JSONC.parse(await Bun.file(at).text()) ?? {}) as Record<string, unknown>
    layers.unshift(parsed)
    const ext = parsed['extends']
    at = typeof ext === 'string' ? Bun.resolveSync(ext, path.dirname(at)) : null
  }
  const json: Record<string, unknown> = {}
  for (const layer of layers) Object.assign(json, layer)
  delete json['extends']
  return { json, files }
}

export async function readNxJsonFacts(root: string): Promise<NxJsonFacts> {
  const none: NxJsonFacts = { namedInputs: null, cacheable: new Set(), globalSync: [] }
  try {
    const read = await readNxJson(root)
    if (read === null) return none
    const parsed = read.json as {
      namedInputs?: unknown
      tasksRunnerOptions?: { default?: { options?: { cacheableOperations?: unknown } } }
      sync?: { globalGenerators?: unknown }
    }
    const named = parsed?.namedInputs
    const ops = parsed?.tasksRunnerOptions?.default?.options?.cacheableOperations
    return {
      namedInputs:
        typeof named === 'object' && named !== null ? (named as Record<string, unknown[]>) : null,
      cacheable: new Set(
        Array.isArray(ops) ? ops.filter((o): o is string => typeof o === 'string') : [],
      ),
      globalSync: Array.isArray(parsed?.sync?.globalGenerators)
        ? parsed.sync.globalGenerators.filter((g): g is string => typeof g === 'string')
        : [],
    }
  } catch {
    // An unreadable nx.json (or base) just degrades named-input refs to TODOs.
    return none
  }
}

function dropUnheldDeps(
  t: GeneratedTask,
  emitted: ReadonlySet<string>,
  emittedIds: ReadonlySet<string>,
): void {
  const task = t.task
  const deps = task?.['dependsOn']
  if (task === null || !Array.isArray(deps)) return
  // A pattern (`^build-*`, `*` in core's dependency syntax) may match
  // nothing; core takes that, as Nx does.
  const kept = deps.filter((d) => {
    if (typeof d !== 'string' || d.includes('*')) return true
    if (d.startsWith('^')) return emitted.has(d.slice(1))
    // `pkg#task` on a project no package holds (the root project with no
    // vx.config) refused the whole run as "no such project".
    if (!d.includes('#') || emittedIds.has(d)) return true
    t.todos.push(
      `dependsOn ${JSON.stringify(d)}: no vx project runs it — edge dropped, and the key misses it`,
    )
    return false
  })
  if (kept.length === deps.length) return
  // A group keeps its (now empty) list: `dependsOn` is all a group is.
  if (kept.length > 0 || task['exec'] === undefined) task['dependsOn'] = kept
  else delete task['dependsOn']
}

const targetNamesMemo = new WeakMap<object, string[]>()
/** Every target name in the graph, once per graph: what an Nx target glob expands over. */
function allTargetNames(nodeMap: Readonly<Record<string, NxNode>>): string[] {
  let names = targetNamesMemo.get(nodeMap)
  if (names === undefined) {
    const set = new Set<string>()
    for (const n of Object.values(nodeMap))
      for (const t of Object.keys(n?.data?.targets ?? {})) set.add(t)
    names = [...set]
    targetNamesMemo.set(nodeMap, names)
  }
  return names
}

function buildTask(
  meta: ProjectMeta,
  projectRel: string,
  scripts: Record<string, unknown>,
  projectName: string,
  targetName: string,
  target: NxTarget,
  variant: Variant,
  nodeName: string,
  upstream: NxUpstream,
  metaByNode: ReadonlyMap<string, ProjectMeta>,
  nodeMap: Readonly<Record<string, NxNode>>,
  taskNameFor: TaskNameFor,
  opts: MapOpts,
  dotenv: readonly string[] | null,
): GeneratedTask {
  const todos: string[] = []
  const options = variant.options

  const mapped = mapCommand(
    targetName,
    target,
    options,
    projectRel,
    projectName,
    variant.configuration,
    scripts,
    todos,
    dotenv,
    opts.pnp,
    meta.packageJson,
    opts.manifestField,
  )

  const inputs = emptyNxInputs()
  const at = {
    rel: projectRel,
    name: projectName,
    outputs: nxProjectOutputs(nodeMap[nodeName]?.data?.targets, projectRel, projectName),
    rootDeps: opts.rootDeps,
  }
  expandNxInputs(target.inputs ?? [], upstream.namedOf(nodeName), at, inputs, todos)
  const cacheWanted =
    target.cache === true || (target.cache === undefined && opts.cacheable.has(targetName))
  // An output only matters to a task vx caches: Nx's default `build` /
  // `public` note sat on every uncached `build` that declares none.
  const outTodos = cacheWanted ? todos : []
  const { outFiles, wsOutFiles } = mapNxOutputs(
    target.outputs ??
      nxDefaultOutputs(targetName, options, projectRel, outTodos, opts.tracked?.(projectRel).tops),
    options,
    projectRel,
    projectName,
    outTodos,
  )
  const deps = mapNxDeps(
    target.dependsOn ?? [],
    metaByNode,
    (t) => Object.hasOwn(nodeMap[nodeName]?.data?.targets ?? {}, t),
    taskNameFor,
    (p, t) => Object.hasOwn(nodeMap[p]?.data?.targets ?? {}, t),
    todos,
    (patterns) =>
      matchNxProjects(
        patterns,
        Object.entries(nodeMap).map(([name, n]) => ({
          name,
          tags: ((n?.data as { tags?: unknown } | undefined)?.tags as string[] | undefined) ?? [],
          ...(typeof n?.data?.root === 'string' ? { root: n.data.root } : {}),
        })),
      ),
    allTargetNames(nodeMap),
    variant.name === targetName
      ? undefined
      : { node: nodeName, configuration: variant.configuration! },
    options,
  )

  // Nx's rule, not a guess: a target is cached when it says `cache: true`
  // (Nx ≥ 17 writes it into the graph from `cacheableOperations` too —
  // refine's `build` carries it, its `dev` does not) or its name is in the
  // legacy `cacheableOperations` list. Until item 591 a target with
  // outputs and no `cache` was cached anyway, so refine's 204 persistent
  // `dev` targets (tsup --watch, outputs `dist`) were cached and then
  // made uncached only by the shared-output rule (2026-09-22).
  const readyWhen = mapped?.readyWhen
  const persistent = readyWhen !== undefined || persistentTarget(target)
  const wild = wildcardOutput(outFiles, opts.tracked?.(projectRel)) ?? wildcardOutput(wsOutFiles)
  if (wild !== undefined && cacheWanted && !persistent) todos.push(wildcardTodo(wild))
  const own = wild === undefined ? ownFileOutput(outFiles, opts.ownConfig?.(projectRel)) : undefined
  if (own !== undefined && cacheWanted && !persistent) todos.push(ownFileTodo(own))
  const cacheEnabled = !persistent && cacheWanted && wild === undefined && own === undefined
  if (persistent && cacheWanted) {
    todos.push('Nx caches this target, and vx never caches a persistent task — uncached here')
  }
  // Both were dropped in silence: a target Nx runs alone ran beside others.
  if (target.parallelism === false) {
    todos.push(
      '`parallelism: false`: Nx runs this target alone, and vx has no per-task exclusivity — ' +
        'run it with `--concurrency 1` where it must not share the machine',
    )
  }
  // One note, not a todo per task: Nx's TypeScript plugin gives every
  // typecheck target `@nx/js:typescript-sync` (83 on typebot).
  if (Array.isArray(target.syncGenerators) && target.syncGenerators.length > 0) {
    const gens = target.syncGenerators.map((g) => JSON.stringify(g)).join(', ')
    opts.syncTasks.set(gens, (opts.syncTasks.get(gens) ?? 0) + 1)
  }
  if (cacheEnabled && mapped !== null) {
    // No `inputs` is Nx's `default` and `^default`: the project's
    // `default` named input (its whole tree unless declared) and each
    // dependency's. No gap to report (487 lines per run on refine,
    // 2026-09-22).
    if (target.inputs === undefined)
      expandNxInputs(['default', '^default'], upstream.namedOf(nodeName), at, inputs, todos)
    if (inputs.files.length === 0 && target.inputs === undefined) inputs.files.push('**/*')
    // Before the env block: a dependency's `{ env }` passes through too.
    for (const edge of upstream.resolve(nodeName, inputs, todos))
      if (!deps.includes(edge)) deps.push(edge)
  }

  if (mapped === null) {
    // nx:noop → vx group task: dependsOn only, no exec, no cache
    // (vx forbids cache on groups). A noop with nothing to chain has
    // no vx representation — skipped with a report line.
    if (deps.length === 0) {
      todos.push('nx:noop target with no dependsOn — nothing to represent; skipped')
      return { name: variant.name, task: null, todos }
    }
    return { name: variant.name, task: { dependsOn: deps }, todos }
  }
  const exec: Record<string, unknown> = { command: mapped.command }
  const env: Record<string, unknown> = {}
  if (inputs.envNames.length > 0) env.passThrough = inputs.envNames
  // Nx hands every task its target (`getNxEnvVariablesForTask`), and
  // `nx exec -- <cmd>`, a package script's way to run under Nx, reads it:
  // unset, it booted Nx's own task runner, which ran the target and its
  // dependencies again. `LERNA_PACKAGE_NAME` is the project too: Lerna
  // runs on Nx's runner and documents it to scripts. A run-commands `env`
  // still wins, as in Nx.
  env.define = {
    NX_TASK_TARGET_PROJECT: projectName,
    NX_TASK_TARGET_TARGET: targetName,
    LERNA_PACKAGE_NAME: projectName,
    ...(variant.configuration === undefined
      ? {}
      : { NX_TASK_TARGET_CONFIGURATION: variant.configuration }),
    ...mapped.env,
  }
  exec.env = env
  if (readyWhen !== undefined) {
    exec.persistent = { readyWhen }
  } else if (persistent) {
    exec.persistent = {}
    todos.push(opts.persistentTodo)
  }
  const task: Record<string, unknown> = { exec }
  if (deps.length > 0) task.dependsOn = deps
  if (cacheEnabled) {
    const cacheInputs: Record<string, unknown> = { files: inputs.files }
    if (inputs.wsFiles.length > 0) cacheInputs.workspaceFiles = inputs.wsFiles
    if (inputs.envNames.length > 0) cacheInputs.env = inputs.envNames
    // The `.env` files the task loads are inputs, and gitignored ones
    // (`.env.local`) are invisible to a glob: their bytes, read per run.
    // Their paths are project-relative: `runtime`, in the project dir.
    if (mapped.envInputs.length > 0) cacheInputs.runtime = [envProbe(mapped.envInputs)]
    if (inputs.runtimeCmds.length > 0) cacheInputs.workspaceRuntime = inputs.runtimeCmds
    const outputs: Record<string, unknown> = { files: outFiles }
    if (wsOutFiles.length > 0) outputs.workspaceFiles = wsOutFiles
    task.cache = { inputs: cacheInputs, outputs }
  }

  return { name: variant.name, todos, task }
}

/**
 * The `$npm_*` variables a script body reads, which Nx's `<pm> run <name>`
 * sets and an inlined body does not: `echo $npm_package_version` printed
 * nothing under `nx()`. The name and version are the manifest's (a bump
 * re-maps: the mapping keys on every manifest), the event the script's
 * own name unless hooks are folded beside it (each has its own); any
 * other is a todo, as core's `vx init` does it (D-34).
 */
function npmScriptEnv(
  command: string,
  script: string,
  folded: boolean,
  manifest: { readonly name?: unknown; readonly version?: unknown },
  manifestField: MapNxOptions['manifestField'],
  todos: string[],
): Record<string, unknown> {
  const env: Record<string, unknown> = {}
  const unset = new Set<string>()
  for (const [, v] of command.matchAll(/\$\{?(npm_[A-Za-z0-9_]+)/g)) {
    const value =
      v === 'npm_package_name'
        ? manifest.name
        : v === 'npm_package_version'
          ? manifest.version
          : v === 'npm_lifecycle_event' && !folded
            ? script
            : undefined
    if (typeof value !== 'string') unset.add(v!)
    else if (manifestField !== undefined && v !== 'npm_lifecycle_event')
      env[v!] = manifestField(v === 'npm_package_name' ? 'name' : 'version')
    else env[v!] = value
  }
  for (const v of unset)
    todos.push(`nx:run-script: \`$${v}\` is set by the package manager's \`run\`, not here — unset`)
  return env
}

/** What a target runs as; null for `nx:noop`, which is a group task. */
interface MappedCommand {
  readonly command: string
  readonly env: Readonly<Record<string, unknown>>
  readonly readyWhen: string | undefined
  /** The `.env` files the command loads, relative to the project dir: key inputs. */
  readonly envInputs: readonly string[]
}

/**
 * `dotenv` is the task's existing `.env` files relative to the project dir,
 * or null when Nx would load none (NX_LOAD_DOT_ENV_FILES=false). A shell
 * line that has any, or a run-commands `envFile`, runs under `nx-env`; an
 * executor line hands them to `nx-exec`.
 */
function mapCommand(
  targetName: string,
  target: NxTarget,
  options: Record<string, unknown>,
  projectRel: string,
  projectName: string,
  configuration: string | undefined,
  scripts: Record<string, unknown>,
  todos: string[],
  dotenv: readonly string[] | null,
  pnp: boolean,
  manifest: { readonly name?: unknown; readonly version?: unknown },
  manifestField: MapNxOptions['manifestField'],
): MappedCommand | null {
  const executor = target.executor
  if (executor === 'nx:noop') {
    // No command by definition — the vx equivalent is a group task
    // (handled by the caller; nothing to map here).
    return null
  }
  const files = dotenv ?? []
  const line = (command: string): MappedCommand => ({
    command,
    env: {},
    readyWhen: undefined,
    envInputs: [],
  })
  const shell = (
    command: string,
    envFile: string | undefined,
    rest: Pick<MappedCommand, 'env' | 'readyWhen'> = { env: {}, readyWhen: undefined },
  ): MappedCommand => {
    if (files.length === 0 && envFile === undefined) return { ...rest, command, envInputs: [] }
    const flags = files.flatMap((f) => ['--dotenv', shellQuote(f)])
    if (envFile !== undefined) flags.push('--envFile', shellQuote(envFile))
    return {
      ...rest,
      command: `nx-env ${flags.join(' ')} -- ${shellQuote(command)}`,
      envInputs: envFile === undefined ? files : [...files, envFile],
    }
  }
  // run-commands, and a plain `command` (its shorthand, over the same
  // options) — see nx-command.ts.
  const plain =
    executor === undefined && typeof target.command === 'string' && target.command.length > 0
  if (executor === 'nx:run-commands' || plain) {
    const rc = mapRunCommands(
      plain ? { ...options, command: target.command } : options,
      { projectRel, projectName },
      todos,
    )
    if (rc === null) return line(PLACEHOLDER)
    // Nx loads `envFile` from its own working directory, the workspace
    // root, and not at all under NX_LOAD_DOT_ENV_FILES=false.
    const envFile =
      rc.envFile === undefined || dotenv === null
        ? undefined
        : path.posix.isAbsolute(rc.envFile)
          ? rc.envFile
          : relPosix(projectRel, path.posix.normalize(rc.envFile))
    return shell(rc.command, envFile, { env: rc.env, readyWhen: rc.readyWhen })
  }
  if (executor === 'nx:run-script') {
    const script = typeof options.script === 'string' ? options.script : targetName
    // package.json is a boundary: a script value is whatever the file holds.
    // This read used to be typed `Record<string, string>`, so `body.length`
    // type-checked on a value that need not be a string at all (item 446).
    const raw = scripts[script]
    const body = typeof raw === 'string' ? raw : undefined
    // An empty script is a target Nx lists and `pnpm run` runs as nothing
    // (novu's `test:watch: ""`, 2026-09-11); as a command it is a config
    // that refuses to load, so it is the placeholder with its todo.
    if (body !== undefined && body.length > 0) {
      const command = scriptCommand(script, body, scripts, pnp)
      // `yarn run <name>` sets its own.
      const env =
        command === `yarn run ${script}`
          ? {}
          : npmScriptEnv(command, script, command !== body, manifest, manifestField, todos)
      return shell(command, undefined, { env, readyWhen: undefined })
    }
    todos.push(
      body === undefined
        ? `nx:run-script: package.json has no ${JSON.stringify(script)} script`
        : `nx:run-script: package.json script ${JSON.stringify(script)} is empty`,
    )
    return line(PLACEHOLDER)
  }
  if (executor === undefined) {
    todos.push(`target has neither an executor nor a command — options: ${JSON.stringify(options)}`)
    return line(PLACEHOLDER)
  }
  // Every other executor runs as itself, one process per task, through
  // this package's `nx-exec` bin: the executor and its options are on the
  // command line, so the key sees them and the line pastes into a shell.
  if (/\{args\.[^}]*\}/.test(JSON.stringify(options))) {
    todos.push(
      '`{args.*}` in the options: params forwarding is not supported — put the value in the option',
    )
  }
  return {
    ...line(nxExecCommand(executor, projectName, targetName, configuration, options, files)),
    envInputs: files,
  }
}

/**
 * Prints each file's name and bytes, for `cache.inputs.runtime`: the name
 * keeps a line moved from one file to the next (a different precedence) a
 * different key.
 */
function envProbe(files: readonly string[]): string {
  return `for f in ${files.map(shellQuote).join(' ')}; do echo "$f"; cat -- "$f" 2>/dev/null; echo; done`
}

/** The `nx-exec` line for one target, shell-quoted; `--options` only when there are any. */
export function nxExecCommand(
  executor: string,
  project: string,
  target: string,
  configuration: string | undefined,
  options: Record<string, unknown>,
  dotenv: readonly string[] = [],
): string {
  const parts = ['nx-exec', executor, '--project', project, '--target', target]
  if (configuration !== undefined) parts.push('--configuration', configuration)
  // JSON's own escapes keep a newline out of the line.
  if (Object.keys(options).length > 0) parts.push('--options', JSON.stringify(options))
  for (const f of dotenv) parts.push('--dotenv', f)
  return parts.map(shellQuote).join(' ')
}

/**
 * The executors whose LIFETIME is known: a server never exits, a build
 * does. Any executor runs through `nx-exec`; this table only decides
 * `persistent`, and only for a target whose graph says no `continuous`.
 */
const KNOWN_EXECUTORS: Record<string, { persistent: boolean }> = {
  '@nx/vite:build': { persistent: false },
  '@nx/vite:dev-server': { persistent: true },
  '@nx/vite:preview-server': { persistent: true },
  '@nx/vite:test': { persistent: false },
  '@nx/vitest:test': { persistent: false },
  '@nx/jest:jest': { persistent: false },
  '@nx/eslint:lint': { persistent: false },
  '@nx/js:tsc': { persistent: false },
  '@nx/webpack:webpack': { persistent: false },
  '@nx/webpack:dev-server': { persistent: true },
  '@nx/esbuild:esbuild': { persistent: false },
  '@nx/rollup:rollup': { persistent: false },
  '@nx/next:build': { persistent: false },
  '@nx/next:server': { persistent: true },
  '@nx/storybook:storybook': { persistent: true },
  '@nx/storybook:build': { persistent: false },
  '@nx/playwright:playwright': { persistent: false },
  '@nx/cypress:cypress': { persistent: false },
  '@angular-devkit/build-angular:dev-server': { persistent: true },
}

/**
 * Does this target run a server that never exits? Nx's own word first: a
 * target that says `continuous` (Nx ≥ 21 infers it for every serve target)
 * is one, and one that says `continuous: false` is not. A graph from an
 * older Nx says nothing, so a known server executor is one whatever the
 * target is called. The target NAME is never the signal: a cached
 * `nx:run-commands` target named `dev` ran uncached every time while the
 * same target named `gen` cached (nx#32610).
 */
function persistentTarget(target: NxTarget): boolean {
  if (typeof target.continuous === 'boolean') return target.continuous
  const known = target.executor === undefined ? undefined : KNOWN_EXECUTORS[target.executor]
  return known?.persistent ?? false
}

/**
 * The projects Nx links a `^target` edge of `from` to
 * (`processTasksForDependencies`): each dependency on the NX graph that
 * has the target, and through one that lacks it, that one's
 * dependencies. vx's `^target` follows package.json alone, so an edge Nx
 * draws from `implicitDependencies` or a tsconfig path (nx-examples'
 * e2e projects → their apps) ordered nothing and folded nothing: an
 * app's source edit left its e2e `typecheck` a hit. It was reported
 * "not representable"; it is an explicit `pkg#target` edge.
 */
function nxDependencyTargets(
  nodeMap: Readonly<Record<string, NxNode>>,
  dependencies: unknown,
): (from: string, target: string) => readonly string[] {
  const direct = new Map<string, string[]>()
  if (typeof dependencies === 'object' && dependencies !== null) {
    for (const [source, edges] of Object.entries(dependencies as Record<string, NxEdge[]>)) {
      if (!Array.isArray(edges)) continue
      const to = edges
        .map((e) => e?.target)
        // An `npm:` node has no root: a package, not a project.
        .filter(
          (t): t is string => typeof t === 'string' && typeof nodeMap[t]?.data?.root === 'string',
        )
      direct.set(source, [...new Set(to)])
    }
  }
  const memo = new Map<string, readonly string[]>()
  return (from, target) => {
    const key = `${from}\0${target}`
    const known = memo.get(key)
    if (known !== undefined) return known
    const out: string[] = []
    const seen = new Set<string>([from])
    const stack = [...(direct.get(from) ?? [])].reverse()
    while (stack.length > 0) {
      const n = stack.pop()!
      if (seen.has(n)) continue
      seen.add(n)
      if (Object.hasOwn(nodeMap[n]?.data?.targets ?? {}, target)) out.push(n)
      else stack.push(...[...(direct.get(n) ?? [])].reverse())
    }
    memo.set(key, out)
    return out
  }
}

/**
 * Nx hands a `^name` edge the configuration the run asked for, and each
 * dependency runs it where it declares it, else its default
 * (`resolveConfiguration`). A `^name` beside a configuration task ran
 * every dependency's default (analog: 17 `development` / `production`
 * builds), and both beside each other would race on one `dist`. Where any
 * dependency Nx links declares the configuration, the `^name` becomes an
 * explicit edge per dependency: its configured task, else its base one.
 */
function passConfiguration(
  task: Record<string, unknown> | null,
  nodeName: string,
  configuration: string,
  nxEdges: (from: string, target: string) => readonly string[],
  metaByNode: ReadonlyMap<string, ProjectMeta>,
  emittedIds: ReadonlySet<string>,
  taskNameFor: TaskNameFor,
): void {
  const deps = task?.['dependsOn']
  if (task === null || !Array.isArray(deps)) return
  const out: unknown[] = []
  for (const d of deps) {
    if (typeof d !== 'string' || !d.startsWith('^') || d.includes('*')) {
      out.push(d)
      continue
    }
    const name = d.slice(1)
    const nodes = nxEdges(nodeName, name)
    if (!nodes.some((n) => taskNameFor(n, name, configuration) !== null)) {
      out.push(d)
      continue
    }
    for (const n of nodes) {
      const m = metaByNode.get(n)
      if (m === undefined) continue
      const id = `${m.name}#${taskNameFor(n, name, configuration) ?? name}`
      if (emittedIds.has(id) && !out.includes(id)) out.push(id)
    }
  }
  task['dependsOn'] = out
}

/** Each `^name` of `task` gains the explicit edges Nx's graph draws for it and vx's `^` does not. */
function followNxGraph(
  task: Record<string, unknown> | null,
  nodeName: string,
  pkgName: string,
  nxEdges: (from: string, target: string) => readonly string[],
  metaByNode: ReadonlyMap<string, ProjectMeta>,
  emittedIds: ReadonlySet<string>,
  reached: (name: string) => ReadonlySet<string>,
): void {
  const deps = task?.['dependsOn']
  if (!Array.isArray(deps)) return
  for (const d of [...deps]) {
    if (typeof d !== 'string' || !d.startsWith('^')) continue
    const name = d.slice(1)
    for (const n of nxEdges(nodeName, name)) {
      const m = metaByNode.get(n)
      if (m === undefined || reached(pkgName).has(m.name)) continue
      const id = `${m.name}#${name}`
      if (emittedIds.has(id) && !deps.includes(id)) deps.push(id)
    }
  }
}

/** Nx's cache-size grammar (`10GB`, `1.5 GB`, bare bytes) as core's size; `0` is no cap. */
export function nxSizeText(raw: unknown): string | undefined {
  if (typeof raw !== 'string' && typeof raw !== 'number') return undefined
  const text = String(raw).trim()
  const m = /^(\d+\.?\d*|\.\d+)\s?([KMG]?B)?$/.exec(text)
  if (m === null) return text
  const units = ['B', 'KB', 'MB', 'GB']
  let n = Math.floor(Number(m[1]) * 1024 ** units.indexOf(m[2] ?? 'B'))
  if (n === 0) return undefined
  let u = 0
  while (u < units.length - 1 && n % 1024 === 0) {
    n /= 1024
    u++
  }
  return `${n}${units[u]}`
}
