// W9 spike (item 676): vx's real planner over a virtual workspace — the
// entry point of the browser bundle (build.ts).
//
// Everything below the shim is core's own source, bundled unchanged:
// discovery (`loadWorkspace`, `listProjects`), the package graph, the
// staged-config load (`loadProjects`), config validation, the task graph,
// the workspace fingerprint, the git-enumeration partition, `plan()` with
// the real key fold (`Cache.prototype.key`) and the scheduler. What this
// file supplies is what `prepareRun` gets from the machine: the git
// enumeration (every VFS file tracked and clean, its OID a git blob SHA-1),
// the evaluated configs (plain objects, as a `vx.config.mjs` default export
// evaluates), and a cache layer whose store is a set of keys.

import { platformCalls, setEnv } from './shim/platform.js'
import { useVfs, Vfs } from './shim/vfs.js'
import type { ProjectConfig } from '../../vx/src/config.js'
import {
  Cache,
  GitFilesCache,
  applyGitEnumeration,
  type CacheLayer,
} from '../../vx/src/cache/index.js'
import {
  buildPackageGraph,
  computeNestedProjectDirs,
  computeWorkspaceFingerprints,
  listProjects,
  loadWorkspace,
  validateProjectConfig,
  type ProjectEntry,
} from '../../vx/src/workspace/index.js'
import {
  buildTaskGraph,
  expandRequested,
  runGraph,
  unresolvedRequests,
  type TaskNode,
} from '../../vx/src/graph/index.js'
import { computeReverseDepCount } from '../../vx/src/graph/priorities.js'
import { loadProjects } from '../../vx/src/orchestrator/projects.js'
import { plan } from '../../vx/src/orchestrator/plan.js'
import { createHashCache } from '../../vx/src/orchestrator/task-hash.js'

export interface PlaygroundInput {
  /** Absolute posix path the workspace lives at inside the VFS. */
  root: string
  /** Root-relative path → contents. */
  files: Record<string, string>
  /** Project name → its evaluated `vx.config` default export. */
  configs: Record<string, unknown>
  /** The environment `cache.inputs.env` reads. */
  env: Record<string, string>
  /** Task specs, as `vx run <tasks…>` takes them. */
  tasks: string[]
  /** Keys the simulated cache holds (a hit is a key found here). */
  cached?: string[]
  /** Workers for the simulated run's dispatch order. */
  concurrency?: number
}

export interface PlaygroundTask {
  id: string
  project: string
  task: string
  hash: string
  cacheStatus: string
  deps: string[]
}

export interface PlaygroundResult {
  tasks: PlaygroundTask[]
  unresolvedTasks: string[]
  /** Core's structural priorities (`computeReverseDepCount`). */
  priorities: Record<string, number>
  /** Task ids in the order `runGraph` dispatched them. */
  dispatchOrder: string[]
  platformCalls: Record<string, number>
  vfsReads: number
}

async function blobOid(bytes: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`)
  const buf = new Uint8Array(header.byteLength + bytes.byteLength)
  buf.set(header)
  buf.set(bytes, header.byteLength)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', buf))
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * A `CacheLayer` over a set of keys, whose `key()` is core's own fold:
 * `Cache.prototype.key` borrowed onto an object that is not a SQLite store
 * (the fold reads only `hashFile` and the `relFor` memo). The borrow is the
 * spike's one hack; the design note proposes lifting the fold out of the
 * class so a platform-free caller need not reach into it.
 */
function playgroundCache(
  held: ReadonlySet<string>,
  oidOf: (abs: string) => Promise<string>,
): CacheLayer {
  const layer = Object.create(Cache.prototype) as Record<string, unknown>
  layer.relMemo = new Map<string, string>()
  layer.relMemoRoot = undefined
  layer.hashFile = oidOf
  layer.has = async (hash: string) => (held.has(hash) ? 'local' : null)
  layer.close = () => {}
  return layer as unknown as CacheLayer
}

export async function planPlayground(input: PlaygroundInput): Promise<PlaygroundResult> {
  platformCalls.clear()
  const vfs = new Vfs(input.root, input.files)
  useVfs(vfs)
  setEnv(input.env)
  const root = input.root

  const trusted = new Map<string, string>()
  for (const [abs, bytes] of vfs.files)
    trusted.set(abs.slice(root.length + 1), await blobOid(bytes))

  const workspace = await loadWorkspace(root)
  const metas = await listProjects(workspace)
  const packageGraph = buildPackageGraph(metas)
  const staged = new Map<string, ProjectEntry>()
  for (const meta of metas) {
    if (meta.configPath === null) continue
    const config = structuredClone(input.configs[meta.name]) as ProjectConfig
    validateProjectConfig(config, meta.configPath)
    staged.set(meta.name, { name: meta.name, dir: meta.dir, config })
  }
  const warn = (m: string): void => console.warn(m)
  const { projects, configured } = await loadProjects({
    workspaceRoot: root,
    cacheDir: `${root}/.vx/cache`,
    plugins: [],
    projectMetas: metas,
    packageGraph,
    seeds: 'all',
    closure: true,
    lock: null,
    evalCache: undefined,
    warn,
    staged,
  })
  const nestedDirsByProject = computeNestedProjectDirs(
    configured.map((m) => ({ name: m.name, dir: m.dir })),
  )
  const candidates = [...projects.keys()]
  const requested = expandRequested(input.tasks, candidates, projects)
  const unresolvedTasks = unresolvedRequests(input.tasks, candidates, projects)
  const nodes: Map<string, TaskNode> = buildTaskGraph({ projects, packageGraph, requested })

  const fingerprints = await computeWorkspaceFingerprints(root, new Set())
  const gitFilesCache = new GitFilesCache()
  const usesWorkspaceInputs = [...projects.values()].some((p) =>
    Object.values(p.config.tasks ?? {}).some(
      (t) => (t.cache?.inputs.workspaceFiles?.length ?? 0) > 0,
    ),
  )
  applyGitEnumeration(
    { all: [...trusted.keys()], trusted, dirty: false },
    root,
    [...projects.values()].map((p) => p.dir),
    gitFilesCache,
    usesWorkspaceInputs,
  )
  const cache = playgroundCache(new Set(input.cached ?? []), async (abs) => {
    const bytes = vfs.read(abs)
    if (bytes === undefined) throw new Error(`playground: no file ${abs}`)
    return blobOid(bytes)
  })

  const planned = await plan({
    nodes,
    workspaceRoot: root,
    workspaceFingerprint: fingerprints.unclaimed,
    cache,
    forwardArgs: [],
    nestedDirsByProject,
    gitFilesCache,
    hashCache: createHashCache(),
  })

  const priorities = computeReverseDepCount(nodes)
  const dispatchOrder: string[] = []
  await runGraph({
    nodes,
    concurrency: input.concurrency ?? 2,
    priorities,
    execute: async (node) => {
      dispatchOrder.push(node.id)
      return { node, status: 'success', exitCode: 0, durationMs: 0 }
    },
  })

  return {
    tasks: planned.tasks.map((t) => ({
      id: t.node.id,
      project: t.node.projectName,
      task: t.node.taskName,
      hash: t.hash,
      cacheStatus: t.cacheStatus,
      deps: [...t.deps],
    })),
    unresolvedTasks: [...unresolvedTasks],
    priorities: Object.fromEntries(priorities),
    dispatchOrder,
    platformCalls: Object.fromEntries(platformCalls),
    vfsReads: vfs.reads.length,
  }
}
