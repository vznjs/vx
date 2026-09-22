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
  type GeneratedProject,
  type GeneratedTask,
  PERSISTENT_TASK_NAMES,
  type ProjectMeta,
  UserError,
} from '@vzn/vx'
import { nxRunCommand } from '../nx-command.js'
import { scriptCommand } from '../script-command.js'
import { resolveSharedOutputs } from '../shared-outputs.js'
import { packageScripts, relPosix } from '../paths.js'
import { pruneOrphanPersistentNotes } from '../persistent-note.js'

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

  /** The vx task an Nx `project:target:configuration` reaches, or null when the target lacks it. */
  const taskNameFor = (project: string, target: string, configuration: string): string | null => {
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
    for (const [targetName, target] of Object.entries(targets)) {
      for (const v of variants(targetName, target)) {
        tasks.push(
          buildTask(
            root,
            meta,
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
export interface NxJsonFacts {
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
  root: string,
  meta: ProjectMeta,
  projectName: string,
  targetName: string,
  target: NxTarget,
  variant: Variant,
  namedInputs: Record<string, unknown[]> | null,
  metaByNode: ReadonlyMap<string, ProjectMeta>,
  taskNameFor: (project: string, target: string, configuration: string) => string | null,
  opts: MapNxOptions,
): GeneratedTask {
  const todos: string[] = []
  const options = variant.options
  const projectRel = normRel(relPosix(root, meta.dir))
  const scripts = packageScripts(meta)

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

  const files: string[] = []
  const wsFiles: string[] = []
  const envNames: string[] = []
  // Nx's `{ runtime: "<cmd>" }` hashes the command's output, which is
  // exactly `cache.inputs.runtime` — schema.md calls it "the Nx `runtime`
  // input equivalent". It was reaching the fall-through and being reported
  // as "not representable in vx" (walked the Nx path, 2026-09-20).
  const runtimeCmds: string[] = []
  const expandInput = (entry: unknown, seen: Set<string>): void => {
    if (typeof entry === 'string') {
      let s = entry
      let neg = ''
      if (s.startsWith('!')) {
        neg = '!'
        s = s.slice(1)
      }
      if (s.startsWith('{projectRoot}/')) {
        files.push(neg + s.slice('{projectRoot}/'.length))
        return
      }
      if (s.startsWith('{workspaceRoot}/')) {
        wsFiles.push(neg + s.slice('{workspaceRoot}/'.length))
        return
      }
      if (s.startsWith('^')) {
        todos.push(
          // Principle 5: the cascade folds each upstream task's KEY (its
          // inputs), never its outputs — the old text said the reverse.
          `deps-input ${JSON.stringify(entry)}: vx already folds each dependency's cache key ` +
            '(its inputs, never its outputs) through dependsOn — usually safe to drop',
        )
        return
      }
      if (s.includes('{')) {
        todos.push(`input ${JSON.stringify(entry)} uses a token vx does not support`)
        return
      }
      // Bare string = named-input reference.
      const named = namedInputs?.[s]
      if (named === undefined) {
        todos.push(
          `named input ${JSON.stringify(s)} not found in nx.json — declare its globs manually`,
        )
        return
      }
      if (seen.has(s)) return
      seen.add(s)
      for (const e of named) expandInput(e, seen)
      return
    }
    if (entry && typeof entry === 'object') {
      const o = entry as Record<string, unknown>
      if (typeof o.env === 'string') {
        envNames.push(o.env)
        return
      }
      if (typeof o.runtime === 'string') {
        runtimeCmds.push(o.runtime)
        return
      }
      if (typeof o.fileset === 'string') {
        expandInput(o.fileset, seen)
        return
      }
      if (o.externalDependencies !== undefined) {
        todos.push(
          `input {externalDependencies: ${JSON.stringify(o.externalDependencies)}}: vx hashes ` +
            "the project's package.json into every key — usually safe to drop",
        )
        return
      }
      if (o.dependentTasksOutputFiles !== undefined) {
        todos.push(
          "input {dependentTasksOutputFiles: …}: vx already folds each dependency's cache key " +
            '(its inputs, never its outputs) through dependsOn — a change upstream is a key change here',
        )
        return
      }
      if (typeof o.input === 'string') {
        if (o.dependencies === true || o.projects !== undefined) {
          todos.push(
            `deps-input ${JSON.stringify(entry)}: vx folds upstream via dependsOn automatically`,
          )
          return
        }
        expandInput(o.input, seen)
        return
      }
    }
    todos.push(`input ${JSON.stringify(entry)} not representable in vx`)
  }
  for (const entry of target.inputs ?? []) expandInput(entry, new Set())

  const outFiles: string[] = []
  const wsOutFiles: string[] = []
  // Heuristic: a bare directory path captures its whole subtree. A dot
  // past the first character is an extension (`lcov.info`); a leading
  // one is a hidden DIRECTORY (`.next`, `.output`, `.netlify` — what Nx
  // plugins and router declare), and a bare name for a directory saves
  // nothing: the output scan lists files, never a directory itself.
  const dirGlob = (rel: string): string => {
    const last = rel.split('/').at(-1)!
    return !rel.includes('*') && !last.slice(1).includes('.') ? `${rel}/**` : rel
  }
  const pushOut = (rel: string): void => {
    outFiles.push(dirGlob(rel))
  }
  for (const o of target.outputs ?? []) {
    let s = o
    const optTok = /\{options\.([^}]+)\}/.exec(s)
    if (optTok) {
      const v = options[optTok[1]!]
      if (typeof v !== 'string') {
        todos.push(
          `output ${JSON.stringify(o)}: option ${JSON.stringify(optTok[1])} is not a literal ` +
            'string — resolve manually',
        )
        continue
      }
      s = s.replace(optTok[0], v)
    }
    if (s.startsWith('{projectRoot}/')) {
      pushOut(s.slice('{projectRoot}/'.length))
      continue
    }
    if (s.startsWith('{workspaceRoot}/')) {
      wsOutFiles.push(dirGlob(s.slice('{workspaceRoot}/'.length)))
      continue
    }
    if (s.includes('{')) {
      todos.push(`output ${JSON.stringify(o)} uses a token vx does not support`)
      continue
    }
    // Plain paths resolve against the workspace root in nx. One outside
    // the project dir is Nx's DEFAULT layout (`@nx/js:tsc` writes
    // `dist/<project>` at the root), so it is the workspace-root output it
    // is, not a gap: as a todo, every such target hit green and restored
    // NOTHING (item 593, the bench workspace's 1,000 `build` targets).
    if (projectRel === '.') pushOut(s)
    else if (s.startsWith(`${projectRel}/`)) pushOut(s.slice(projectRel.length + 1))
    else wsOutFiles.push(dirGlob(path.posix.normalize(s).replace(/^\.\//, '')))
  }

  const deps: string[] = []
  for (const d of target.dependsOn ?? []) {
    if (typeof d === 'string') {
      // Nx separates a specific project's target with a COLON
      // (`ui:build`); vx's separator is `#`. Passed through, the entry
      // read as a task named `ui:build` in the DEPENDENT's own project
      // and the migrated workspace refused to run — "depends on
      // web#ui:build but no such task is declared", from a config
      // vx-migrate itself wrote (walked the Nx path, 2026-09-20). The
      // object form below already mapped it; this one did not.
      const colon = d.indexOf(':')
      if (colon <= 0) {
        deps.push(d)
        continue
      }
      const [project = '', targetPart, configuration] = d.split(':')
      const m = metaByNode.get(project)
      if (m === undefined || targetPart === undefined || targetPart === '') {
        todos.push(
          `dependsOn ${JSON.stringify(d)} names ${JSON.stringify(project)}, which is not a ` +
            'workspace package in this graph — edge dropped',
        )
        continue
      }
      // A configuration is a task of its own (`build:ci`) unless it is the
      // target's default, which the base task carries; an edge naming one
      // follows it there. A configuration the target does not declare has
      // no task to reach, so the edge falls back to the base with a todo.
      if (configuration !== undefined) {
        const named = taskNameFor(project, targetPart, configuration)
        if (named === null) {
          todos.push(
            `dependsOn ${JSON.stringify(d)}: ${project} declares no ${JSON.stringify(configuration)} ` +
              `configuration on ${targetPart} — depending on ${m.name}#${targetPart}`,
          )
        } else {
          deps.push(`${m.name}#${named}`)
          continue
        }
      }
      deps.push(`${m.name}#${targetPart}`)
      continue
    }
    if (d && typeof d === 'object') {
      const o = d as Record<string, unknown>
      const t = typeof o.target === 'string' ? o.target : undefined
      if (t === undefined) {
        todos.push(`dependsOn ${JSON.stringify(d)} has no target — dropped`)
        continue
      }
      if (o.params !== undefined) {
        todos.push(
          `dependsOn ${JSON.stringify(t)}: params forwarding is not supported — forward args ` +
            'via `vx run … -- args` instead',
        )
      }
      const projects = o.projects ?? (o.dependencies === true ? 'dependencies' : undefined)
      if (projects === undefined || projects === 'self') deps.push(t)
      else if (projects === 'dependencies') deps.push(`^${t}`)
      else if (Array.isArray(projects)) {
        for (const p of projects) {
          const m = typeof p === 'string' ? metaByNode.get(p) : undefined
          if (m) deps.push(`${m.name}#${t}`)
          else {
            todos.push(
              `dependsOn project ${JSON.stringify(p)} is not a workspace package — edge dropped`,
            )
          }
        }
      } else todos.push(`dependsOn ${JSON.stringify(d)} not representable in vx`)
      continue
    }
    todos.push(`dependsOn ${JSON.stringify(d)} not representable in vx`)
  }

  // Nx's rule, not a guess: a target is cached when it says `cache: true`
  // (Nx ≥ 17 writes it into the graph from `cacheableOperations` too —
  // refine's `build` carries it, its `dev` does not) or its name is in the
  // legacy `cacheableOperations` list. Until item 591 a target with
  // outputs and no `cache` was cached anyway, so refine's 204 persistent
  // `dev` targets (tsup --watch, outputs `dist`) were cached and then
  // made uncached only by the shared-output rule (2026-09-22).
  const persistent = persistentTarget(targetName, target.executor)
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
  if (envNames.length > 0) exec.env = { passThrough: envNames }
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
      if (namedInputs?.['default'] !== undefined) expandInput('default', new Set())
      if (files.length === 0) files.push('**/*')
    }
    const inputs: Record<string, unknown> = { files }
    if (wsFiles.length > 0) inputs.workspaceFiles = wsFiles
    if (envNames.length > 0) inputs.env = envNames
    if (runtimeCmds.length > 0) inputs.runtime = runtimeCmds
    const outputs: Record<string, unknown> = { files: outFiles }
    if (wsOutFiles.length > 0) outputs.workspaceFiles = wsOutFiles
    task.cache = { inputs, outputs }
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
 * `persistent`, and it is authoritative where the target's name is a guess.
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
 * Does this target run a server that never exits? A known executor is
 * authoritative — `@nx/vite:dev-server` IS one, whatever the target is
 * called. Anything else (a shell wrapper, a custom executor) says nothing
 * about lifetime, so fall back to the target NAME, the same guess the
 * scripts path makes. Without this a `serve` target became an ordinary
 * task and `vx run serve` waited forever for an exit that never comes.
 */
function persistentTarget(targetName: string, executor: string | undefined): boolean {
  const known = executor === undefined ? undefined : KNOWN_EXECUTORS[executor]
  if (known !== undefined) return known.persistent
  return PERSISTENT_TASK_NAMES.has(targetName)
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
    const manifest = {
      ...sm.packageJson.dependencies,
      ...sm.packageJson.devDependencies,
      ...sm.packageJson.peerDependencies,
      ...sm.packageJson.optionalDependencies,
    }
    const seen = new Set<string>()
    for (const edge of edges) {
      const tm = typeof edge?.target === 'string' ? metaByNode.get(edge.target) : undefined
      if (!tm || tm === sm || seen.has(tm.name)) continue
      seen.add(tm.name)
      if (manifest[tm.name] === undefined) pairs.push(`${sm.name} → ${tm.name}`)
    }
  }
  return pairs
}
