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
  UserError,
} from '@vzn/vx'
import { nxRunCommand } from '../nx-command.js'
import { scriptCommand } from '../script-command.js'
import { resolveSharedOutputs } from '../shared-outputs.js'
import { packageScripts, relPosix } from '../paths.js'
import { pruneOrphanPersistentNotes } from '../persistent-note.js'
import { mapNxDeps, type TaskNameFor } from './nx-deps.js'
import { emptyNxInputs, expandNxInputs } from './nx-inputs.js'
import { mapNxOutputs } from './nx-outputs.js'

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
}

interface NxNode {
  name?: string
  data?: { root?: string; targets?: Record<string, NxTarget> }
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
  const g = ((parsed as { graph?: unknown }).graph ?? parsed) as {
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
  return { nodes: nodes as Record<string, NxNode>, dependencies: g.dependencies }
}

export interface MapNxOptions {
  /** The note a persistent task carries (the CLI's TODO, the plugin's warning). */
  readonly persistentTodo: string
  /** nx.json's legacy `cacheableOperations`, for a graph whose targets carry no `cache` field. */
  readonly cacheable: ReadonlySet<string>
}

export interface NxMapping {
  readonly projects: GeneratedProject[]
  /** Report lines for the whole workspace (implicit deps). */
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

  const { namedInputs, cacheable } = await readNxJsonFacts(root)
  const mapOpts: MapNxOptions = { ...opts, cacheable: new Set([...opts.cacheable, ...cacheable]) }

  const metaByRel = new Map<string, ProjectMeta>()
  for (const meta of metas) metaByRel.set(normRel(relPosix(root, meta.dir)), meta)
  const metaByNode = new Map<string, ProjectMeta>()
  const nodeByMeta = new Map<ProjectMeta, NxNode>()
  for (const [nodeName, node] of Object.entries(nodeMap)) {
    const meta = metaByRel.get(normRel(node?.data?.root ?? ''))
    if (meta) {
      metaByNode.set(nodeName, meta)
      nodeByMeta.set(meta, node)
    }
  }

  // Graph nodes with no discovered counterpart: the ROOT project is
  // the common case — `packages/*` discovery never lists the
  // workspace root, but Nx routinely defines root targets. Synthesize
  // a meta for any unmatched node whose root resolves inside the
  // workspace, so its targets migrate too.
  const allMetas: ProjectMeta[] = [...metas]
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
    const synthetic: ProjectMeta = {
      name: pkg.name || nodeName,
      dir,
      packageJson: pkg,
      configPath: null,
    }
    allMetas.push(synthetic)
    metaByNode.set(nodeName, synthetic)
    nodeByMeta.set(synthetic, node)
  }

  const taskNameFor: TaskNameFor = (project, target, configuration) => {
    const t = nodeMap[project]?.data?.targets?.[target]
    if (t === undefined) return null
    const v = variants(target, t).find((x) => x.configuration === configuration)
    return v === undefined ? null : v.name
  }

  const projects: GeneratedProject[] = []
  for (const meta of allMetas) {
    const node = nodeByMeta.get(meta)
    const targets = node?.data?.targets
    if (!targets) continue
    const tasks: GeneratedTask[] = []
    const projectName = node?.name ?? meta.name
    // Once per project, not per task and variant: `path.relative` was a
    // fifth of the mapping at 1,000 projects (item 608).
    const projectRel = normRel(relPosix(root, meta.dir))
    const scripts = packageScripts(meta)
    for (const [targetName, target] of Object.entries(targets)) {
      for (const v of variants(targetName, target)) {
        tasks.push(
          buildTask(
            meta,
            projectRel,
            scripts,
            projectName,
            targetName,
            target,
            v,
            namedInputs,
            metaByNode,
            taskNameFor,
            mapOpts,
          ),
        )
      }
    }
    projects.push({
      name: meta.name,
      dir: meta.dir,
      importLines: [],
      tasks: resolveSharedOutputs(tasks),
    })
  }

  const notes: string[] = []
  // Named, not just counted: "1 implicit Nx dep" sends a reader looking
  // through the whole graph for it, and the pair is what they need to
  // write the `dependsOn` by hand (walked the Nx path, 2026-09-20).
  const implicit = implicitDeps(g?.dependencies, metaByNode)
  if (implicit.length > 0) {
    const shown = implicit.slice(0, 5).join(', ')
    const rest = implicit.length > 5 ? ` and ${implicit.length - 5} more` : ''
    notes.push(
      `${implicit.length} implicit Nx dep${implicit.length === 1 ? '' : 's'} not representable ` +
        `(${shown}${rest}); review dependsOn`,
    )
  }

  pruneOrphanPersistentNotes(projects, opts.persistentTodo)
  return { projects, notes }
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
}

export async function readNxJsonFacts(root: string): Promise<NxJsonFacts> {
  const none: NxJsonFacts = { namedInputs: null, cacheable: new Set() }
  const file = Bun.file(path.join(root, 'nx.json'))
  if (!(await file.exists())) return none
  try {
    const parsed = Bun.JSONC.parse(await file.text()) as {
      namedInputs?: unknown
      tasksRunnerOptions?: { default?: { options?: { cacheableOperations?: unknown } } }
    }
    const named = parsed?.namedInputs
    const ops = parsed?.tasksRunnerOptions?.default?.options?.cacheableOperations
    return {
      namedInputs:
        typeof named === 'object' && named !== null ? (named as Record<string, unknown[]>) : null,
      cacheable: new Set(
        Array.isArray(ops) ? ops.filter((o): o is string => typeof o === 'string') : [],
      ),
    }
  } catch {
    // Unreadable nx.json just degrades named-input refs to TODOs.
    return none
  }
}

function buildTask(
  meta: ProjectMeta,
  projectRel: string,
  scripts: Record<string, unknown>,
  projectName: string,
  targetName: string,
  target: NxTarget,
  variant: Variant,
  namedInputs: Record<string, unknown[]> | null,
  metaByNode: ReadonlyMap<string, ProjectMeta>,
  taskNameFor: TaskNameFor,
  opts: MapNxOptions,
): GeneratedTask {
  const todos: string[] = []
  const options = variant.options

  const command = mapCommand(
    targetName,
    target,
    options,
    projectRel,
    projectName,
    variant.configuration,
    scripts,
    todos,
  )

  const inputs = emptyNxInputs()
  expandNxInputs(target.inputs ?? [], namedInputs, inputs, todos)
  const { outFiles, wsOutFiles } = mapNxOutputs(target.outputs ?? [], options, projectRel, todos)
  const deps = mapNxDeps(target.dependsOn ?? [], metaByNode, taskNameFor, todos)

  // Nx's rule, not a guess: a target is cached when it says `cache: true`
  // (Nx ≥ 17 writes it into the graph from `cacheableOperations` too —
  // refine's `build` carries it, its `dev` does not) or its name is in the
  // legacy `cacheableOperations` list. Until item 591 a target with
  // outputs and no `cache` was cached anyway, so refine's 204 persistent
  // `dev` targets (tsup --watch, outputs `dist`) were cached and then
  // made uncached only by the shared-output rule (2026-09-22).
  const persistent = persistentTarget(target)
  const cacheEnabled =
    !persistent &&
    (target.cache === true || (target.cache === undefined && opts.cacheable.has(targetName)))

  if (command === null) {
    // nx:noop → vx group task: dependsOn only, no exec, no cache
    // (vx forbids cache on groups). A noop with nothing to chain has
    // no vx representation — skipped with a report line.
    if (deps.length === 0) {
      todos.push('nx:noop target with no dependsOn — nothing to represent; skipped')
      return { name: variant.name, task: null, todos }
    }
    return { name: variant.name, task: { dependsOn: deps }, todos }
  }
  if (variant.name !== targetName && deps.some((d) => d.startsWith('^'))) {
    todos.push(
      `configuration ${JSON.stringify(variant.configuration)}: Nx runs dependencies with the same ` +
        'configuration where they declare it — here the ^ edges run their default',
    )
  }

  const exec: Record<string, unknown> = { command }
  if (inputs.envNames.length > 0) exec.env = { passThrough: inputs.envNames }
  if (persistent) {
    exec.persistent = {}
    todos.push(opts.persistentTodo)
  }
  const task: Record<string, unknown> = { exec }
  if (deps.length > 0) task.dependsOn = deps
  if (cacheEnabled) {
    // No `inputs` is Nx's `default` named input when nx.json declares
    // one, else the project's whole tree — the same set either way, so
    // it is no gap to report (487 lines per run on refine, 2026-09-22).
    if (target.inputs === undefined) {
      if (namedInputs?.['default'] !== undefined)
        expandNxInputs(['default'], namedInputs, inputs, todos)
      if (inputs.files.length === 0) inputs.files.push('**/*')
    }
    const cacheInputs: Record<string, unknown> = { files: inputs.files }
    if (inputs.wsFiles.length > 0) cacheInputs.workspaceFiles = inputs.wsFiles
    if (inputs.envNames.length > 0) cacheInputs.env = inputs.envNames
    if (inputs.runtimeCmds.length > 0) cacheInputs.runtime = inputs.runtimeCmds
    const outputs: Record<string, unknown> = { files: outFiles }
    if (wsOutFiles.length > 0) outputs.workspaceFiles = wsOutFiles
    task.cache = { inputs: cacheInputs, outputs }
  }

  return { name: variant.name, todos, task }
}

function mapCommand(
  targetName: string,
  target: NxTarget,
  options: Record<string, unknown>,
  projectRel: string,
  projectName: string,
  configuration: string | undefined,
  scripts: Record<string, unknown>,
  todos: string[],
): string | null {
  const executor = target.executor
  if (executor === 'nx:noop') {
    // No command by definition — the vx equivalent is a group task
    // (handled by the caller; nothing to map here).
    return null
  }
  // run-commands, and a plain `command` (its shorthand): Nx runs them from
  // the workspace root unless `cwd` says otherwise, with `{projectRoot}`,
  // `{projectName}` and `{workspaceRoot}` expanded — see nx-command.ts.
  const shell = (cmd: string): string =>
    nxRunCommand(cmd, { projectRel, projectName, cwd: options.cwd }, todos)
  if (executor === 'nx:run-commands') {
    const cmds = options.commands
    if (Array.isArray(cmds) && cmds.length > 0) {
      const parts = cmds
        .map((c) => (typeof c === 'string' ? c : ((c as { command?: unknown }).command as string)))
        .filter((c): c is string => typeof c === 'string' && c.length > 0)
      if (parts.length > 0) return shell(parts.join(' && '))
    }
    if (typeof options.command === 'string' && options.command.length > 0) {
      return shell(options.command)
    }
    todos.push(`nx:run-commands target has no command — options: ${JSON.stringify(options)}`)
    return PLACEHOLDER
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
    if (body !== undefined && body.length > 0) return scriptCommand(script, body, scripts)
    todos.push(
      body === undefined
        ? `nx:run-script: package.json has no ${JSON.stringify(script)} script`
        : `nx:run-script: package.json script ${JSON.stringify(script)} is empty`,
    )
    return PLACEHOLDER
  }
  if (executor === undefined && typeof target.command === 'string' && target.command.length > 0) {
    return shell(target.command)
  }
  if (executor === undefined) {
    todos.push(`target has neither an executor nor a command — options: ${JSON.stringify(options)}`)
    return PLACEHOLDER
  }
  // Every other executor runs as itself, one process per task, through
  // this package's `nx-exec` bin: the executor and its options are on the
  // command line, so the key sees them and the line pastes into a shell.
  if (/\{args\.[^}]*\}/.test(JSON.stringify(options))) {
    todos.push(
      '`{args.*}` in the options: params forwarding is not supported — put the value in the option',
    )
  }
  return nxExecCommand(executor, projectName, targetName, configuration, options)
}

/** The `nx-exec` line for one target, shell-quoted; `--options` only when there are any. */
export function nxExecCommand(
  executor: string,
  project: string,
  target: string,
  configuration: string | undefined,
  options: Record<string, unknown>,
): string {
  const parts = ['nx-exec', executor, '--project', project, '--target', target]
  if (configuration !== undefined) parts.push('--configuration', configuration)
  if (Object.keys(options).length > 0) parts.push('--options', JSON.stringify(options))
  return parts.map(shellQuote).join(' ')
}

/** Single-quoted unless the word is safe bare; JSON's own escapes keep a newline out of the line. */
function shellQuote(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`
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

/** `a → b` for every graph edge vx's package graph cannot see. */
function implicitDeps(
  dependencies: unknown,
  metaByNode: ReadonlyMap<string, ProjectMeta>,
): string[] {
  if (typeof dependencies !== 'object' || dependencies === null) return []
  const pairs: string[] = []
  for (const [source, edges] of Object.entries(dependencies as Record<string, NxEdge[]>)) {
    const sm = metaByNode.get(source)
    if (!sm || !Array.isArray(edges)) continue
    const seen = new Set<string>()
    for (const edge of edges) {
      const tm = typeof edge?.target === 'string' ? metaByNode.get(edge.target) : undefined
      if (!tm || tm === sm || seen.has(tm.name)) continue
      seen.add(tm.name)
      // Whether sm's manifest links tm is vx's rule, not a name lookup: a
      // `"b": "^1.0.0"` beside a local b@2 is a registry dependency and no
      // edge. A graph of the two alone has the edge iff tm is in sm's
      // closure, and the rule reads nothing but sm's manifest and tm.
      if (!buildPackageGraph([sm, tm]).transitiveDeps(sm.name).includes(tm.name)) {
        pairs.push(`${sm.name} → ${tm.name}`)
      }
    }
  }
  return pairs
}
