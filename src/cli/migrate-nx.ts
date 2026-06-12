// Nx → vx mapping, from the resolved project-graph snapshot ONLY
// (.nx/workspace-data/project-graph.json). Static by design: targets
// that Nx plugins infer at runtime are frozen as the snapshot saw
// them. Named inputs expand from nx.json when readable; the graph's
// dependency edges are ignored (vx derives package edges from
// package.json manifests) except for one report line counting edges
// with no manifest counterpart.

import path from 'node:path'
import { relPosix, UserError } from '../util/index.js'
import type { ProjectMeta } from '../workspace/index.js'
import type { GeneratedProject, GeneratedTask, MigrationPlan } from './migrate.js'

const PLACEHOLDER = "echo 'TODO(vx-migrate): fill in' && exit 1"
const GRAPH_REL = '.nx/workspace-data/project-graph.json'

interface NxTarget {
  executor?: string
  command?: string
  options?: Record<string, unknown>
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

function normRel(p: string): string {
  return p === '' || p === '.' ? '.' : p.replace(/\/$/, '')
}

export async function migrateNx(
  root: string,
  metas: readonly ProjectMeta[],
): Promise<MigrationPlan> {
  const graphPath = path.join(root, GRAPH_REL)
  let parsed: unknown
  try {
    parsed = JSON.parse(await Bun.file(graphPath).text())
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new UserError(`failed to parse ${GRAPH_REL}: ${msg}`)
  }
  // Both {graph:{nodes,dependencies}} and top-level {nodes,dependencies}
  // exist across nx versions.
  const g = ((parsed as { graph?: unknown }).graph ?? parsed) as {
    nodes?: unknown
    dependencies?: unknown
  }
  const nodes = g?.nodes
  if (typeof nodes !== 'object' || nodes === null) {
    throw new UserError(
      `${GRAPH_REL}: unrecognized shape — expected { graph: { nodes, dependencies } } ` +
        'or { nodes, dependencies }',
    )
  }
  const nodeMap = nodes as Record<string, NxNode>

  const namedInputs = await readNamedInputs(root)

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

  const projects: GeneratedProject[] = []
  for (const meta of metas) {
    const node = nodeByMeta.get(meta)
    const targets = node?.data?.targets
    if (!targets) continue
    const tasks: GeneratedTask[] = []
    for (const [targetName, target] of Object.entries(targets)) {
      tasks.push(buildTask(root, meta, targetName, target, namedInputs, metaByNode))
    }
    projects.push({ name: meta.name, dir: meta.dir, importLines: [], tasks })
  }

  const notes: string[] = []
  const implicit = countImplicitDeps(g?.dependencies, metaByNode)
  if (implicit > 0) {
    notes.push(
      `${implicit} implicit Nx dep${implicit === 1 ? '' : 's'} not representable; review dependsOn`,
    )
  }

  return {
    headerNotes: [
      'migrating from the resolved project-graph snapshot — plugin-inferred targets ' +
        'are frozen as static config',
    ],
    projects,
    extraFiles: [],
    notes,
  }
}

async function readNamedInputs(root: string): Promise<Record<string, unknown[]> | null> {
  const file = Bun.file(path.join(root, 'nx.json'))
  if (!(await file.exists())) return null
  try {
    const parsed = Bun.JSONC.parse(await file.text()) as { namedInputs?: unknown }
    const named = parsed?.namedInputs
    if (typeof named !== 'object' || named === null) return null
    return named as Record<string, unknown[]>
  } catch {
    // Unreadable nx.json just degrades named-input refs to TODOs.
    return null
  }
}

function buildTask(
  root: string,
  meta: ProjectMeta,
  targetName: string,
  target: NxTarget,
  namedInputs: Record<string, unknown[]> | null,
  metaByNode: ReadonlyMap<string, ProjectMeta>,
): GeneratedTask {
  const todos: string[] = []
  const options = target.options ?? {}
  const projectRel = normRel(relPosix(root, meta.dir))
  const scripts =
    (meta.packageJson as unknown as { scripts?: Record<string, string> }).scripts ?? {}

  const command = mapCommand(targetName, target, options, projectRel, scripts, todos)

  const files: string[] = []
  const envNames: string[] = []
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
      if (s.startsWith('{workspaceRoot}')) {
        todos.push(
          `input ${JSON.stringify(entry)} is workspace-root-relative — vx inputs are ` +
            'project-relative; relocate manually',
        )
        return
      }
      if (s.startsWith('^')) {
        todos.push(
          `deps-input ${JSON.stringify(entry)}: vx folds upstream outputs into the cache ` +
            'key via dependsOn automatically — usually safe to drop',
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
          'input {dependentTasksOutputFiles: …}: vx folds upstream outputs into the cache ' +
            'key via dependsOn automatically',
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
  const pushOut = (rel: string): void => {
    const last = rel.split('/').at(-1)!
    // Heuristic: a bare directory path captures its whole subtree.
    outFiles.push(!rel.includes('*') && !last.includes('.') ? `${rel}/**` : rel)
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
    if (s.startsWith('{workspaceRoot}')) {
      todos.push(
        `output ${JSON.stringify(o)} is workspace-root-relative — vx outputs are project-relative`,
      )
      continue
    }
    if (s.includes('{')) {
      todos.push(`output ${JSON.stringify(o)} uses a token vx does not support`)
      continue
    }
    // Plain paths resolve against the workspace root in nx.
    if (projectRel === '.') pushOut(s)
    else if (s.startsWith(`${projectRel}/`)) pushOut(s.slice(projectRel.length + 1))
    else {
      todos.push(
        `output ${JSON.stringify(o)} falls outside the project dir — vx outputs are ` +
          'project-relative',
      )
    }
  }

  const deps: string[] = []
  for (const d of target.dependsOn ?? []) {
    if (typeof d === 'string') {
      deps.push(d)
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

  const cacheEnabled =
    target.cache === true ||
    (target.cache === undefined && (target.inputs !== undefined || target.outputs !== undefined))

  const exec: Record<string, unknown> = { command }
  if (envNames.length > 0) exec.env = { passThrough: envNames }
  const task: Record<string, unknown> = { exec }
  if (deps.length > 0) task.dependsOn = deps
  if (cacheEnabled) {
    if (target.inputs === undefined && files.length === 0) {
      files.push('**/*')
      todos.push(
        "cache enabled with no declared inputs — defaulting to ['**/*']; narrow to the real input set",
      )
    }
    const inputs: Record<string, unknown> = { files }
    if (envNames.length > 0) inputs.env = envNames
    task.cache = { inputs, outputs: { files: outFiles } }
  }

  return { name: targetName, todos, task }
}

function mapCommand(
  targetName: string,
  target: NxTarget,
  options: Record<string, unknown>,
  projectRel: string,
  scripts: Record<string, string>,
  todos: string[],
): string {
  const executor = target.executor
  if (executor === 'nx:run-commands') {
    if (typeof options.cwd === 'string' && normRel(options.cwd) !== projectRel) {
      todos.push(
        `run-commands cwd ${JSON.stringify(options.cwd)} differs from the project root — vx ` +
          'runs commands from the project dir; adjust the command',
      )
    }
    const cmds = options.commands
    if (Array.isArray(cmds) && cmds.length > 0) {
      const parts = cmds
        .map((c) => (typeof c === 'string' ? c : ((c as { command?: unknown }).command as string)))
        .filter((c): c is string => typeof c === 'string' && c.length > 0)
      if (parts.length > 0) return parts.join(' && ')
    }
    if (typeof options.command === 'string') return options.command
    todos.push(`nx:run-commands target has no command — options: ${JSON.stringify(options)}`)
    return PLACEHOLDER
  }
  if (executor === 'nx:run-script') {
    const script = typeof options.script === 'string' ? options.script : targetName
    const body = scripts[script]
    if (body !== undefined) return body
    todos.push(`nx:run-script: package.json has no ${JSON.stringify(script)} script`)
    return PLACEHOLDER
  }
  if (executor === undefined && typeof target.command === 'string') return target.command
  todos.push(
    `executor ${JSON.stringify(executor ?? '(none)')} has no shell equivalent — fill in the ` +
      `CLI command. options: ${JSON.stringify(options)}`,
  )
  return PLACEHOLDER
}

function countImplicitDeps(
  dependencies: unknown,
  metaByNode: ReadonlyMap<string, ProjectMeta>,
): number {
  if (typeof dependencies !== 'object' || dependencies === null) return 0
  let count = 0
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
      if (manifest[tm.name] === undefined) count++
    }
  }
  return count
}
