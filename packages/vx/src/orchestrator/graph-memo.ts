// The task graph memo: the graph a run built, read back whole when nothing
// it is built from has moved (`GRAPH_PARTS`). Reading it back is half the
// cost of building it, most of which is code a short process runs cold.

import type { FoldMemo } from '../memo/index.js'
import {
  buildTaskGraph,
  computeReverseDepCount,
  declaredTask,
  setStandIns,
  standInsOf,
  type TaskNode,
} from '../graph/index.js'
import { memoParts, onlyAbsent, xxh3hex } from '../util/index.js'
import type { ProjectMeta } from '../workspace/index.js'
import { codeIdentity } from './run-keys.js'

type BuildGraphOptions = Parameters<typeof buildTaskGraph>[0]

/** Moves every remembered graph: bump it when what a token stands for changes. */
const GRAPH_MEMO_VERSION = 'graph-memo-v2'

/** What names a run's configs: the lock they were read from and the projects discovered. */
export interface GraphMemo {
  folds: FoldMemo
  lock: string
  metas: readonly ProjectMeta[]
}

/**
 * Everything `buildTaskGraph` reads. The configs come from the lock and
 * nowhere else when no plugin fills the `project` stage, so the lock's
 * bytes name them instead of a serialization (3 ms at 1,206 tasks).
 */
const GRAPH_PARTS = memoParts<BuildGraphOptions & Omit<GraphMemo, 'folds'>>({
  lock: (lock) => lock,
  workspaceRoot: (root) => root ?? '',
  rules: (rules) => JSON.stringify(rules ?? null),
  packageGraph: (graph) => String(graph.edgeSource),
  requested: (requested) => JSON.stringify(requested),
  metas: (metas, of) =>
    metas
      .map((m) =>
        [
          m.name,
          m.dir,
          m.configPath ?? '\u0001',
          of.packageGraph.directDeps(m.name).join('\u0001'),
        ].join('\0'),
      )
      .join('\0'),
  projects: (projects) => [...projects.keys()].join('\0'),
  // A scoped load hands undeclared `^name`s back instead of refusing them.
  undeclaredDeps: onlyAbsent('a scoped load judges its graph against the rest'),
  nestedProjects: onlyAbsent('a refusal is never decided from a memo'),
  projectConfigs: onlyAbsent('a refusal is never decided from a memo'),
})

/**
 * A node as the memo holds it: its project and task, requested, its deps
 * and the tasks it adds outputs to as positions in the list (ids in full
 * were 123 KB for 1,206 tasks, and parsing them back cost what the walk
 * saved), the globs that add to its own outputs, and its stand-ins
 * (rebuilt without it, `inputs.tasks` dropped the edges past a default
 * build on a package cycle on every warm run).
 */
type Row = [
  project: string,
  task: string,
  requested: 0 | 1,
  deps: number[],
  adds?: number[] | null,
  added?: string[] | null,
  stands?: Array<[edge: number, past: number[]]>,
]

/**
 * `buildTaskGraph`, answered from the memo when it built this graph before,
 * and the token that names the graph (undefined when not remembered).
 */
export function memoGraph(
  options: BuildGraphOptions,
  memo: GraphMemo | undefined,
): { nodes: Map<string, TaskNode>; token: string | undefined } {
  if (memo === undefined) return { nodes: buildTaskGraph(options), token: undefined }
  const token = GRAPH_PARTS.token(`${GRAPH_MEMO_VERSION}\0${codeIdentity()}`, {
    ...options,
    lock: memo.lock,
    metas: memo.metas,
  })
  if (token === undefined) return { nodes: buildTaskGraph(options), token: undefined }
  const { projects } = options
  const id = `\0graph\0${xxh3hex(JSON.stringify(options.requested))}`
  const row = memo.folds.get(id, token)
  if (row !== undefined) {
    const nodes = rebuilt(row, projects)
    if (nodes !== undefined) return { nodes, token }
  }
  const nodes = buildTaskGraph(options)
  memo.folds.set(id, token, JSON.stringify(rowsOf(nodes)))
  return { nodes, token }
}

function rowsOf(nodes: Map<string, TaskNode>): Row[] {
  const at = new Map<string, number>()
  for (const id of nodes.keys()) at.set(id, at.size)
  const pos = (ids: readonly string[]): number[] => ids.map((d) => at.get(d)!)
  return [...nodes.values()].map((n) => {
    const row: Row = [n.projectName, n.taskName, n.requested ? 1 : 0, pos(n.deps)]
    const standsFor = standInsOf(n)
    if (
      n.addsToOutputsOf !== undefined ||
      n.outputsAddedToBy !== undefined ||
      standsFor !== undefined
    )
      row.push(
        n.addsToOutputsOf === undefined ? null : pos(n.addsToOutputsOf),
        n.outputsAddedToBy ?? null,
      )
    if (standsFor !== undefined)
      row.push(
        Object.entries(standsFor).map(([edge, past]): [number, number[]] => [
          at.get(edge)!,
          pos(past),
        ]),
      )
    return row
  })
}

function rebuilt(
  row: string,
  projects: BuildGraphOptions['projects'],
): Map<string, TaskNode> | undefined {
  let rows: Row[]
  try {
    rows = JSON.parse(row)
  } catch {
    return undefined
  }
  const list: TaskNode[] = []
  for (const [projectName, taskName, requested] of rows) {
    const project = projects.get(projectName)
    const config = declaredTask(project?.config, taskName)
    if (project === undefined || config === undefined) return undefined
    list.push({
      id: `${projectName}#${taskName}`,
      projectName,
      projectDir: project.dir,
      taskName,
      config,
      deps: [],
      requested: requested === 1,
    })
  }
  const ids = (at: readonly number[]): string[] => at.map((i) => list[i]!.id)
  const nodes = new Map<string, TaskNode>()
  for (let i = 0; i < rows.length; i++) {
    const [, , , deps, adds, added, stands] = rows[i]!
    const node = list[i]!
    node.deps = ids(deps)
    if (adds != null) node.addsToOutputsOf = ids(adds)
    if (added != null) node.outputsAddedToBy = added
    if (stands !== undefined) {
      const standsFor: Record<string, string[]> = {}
      for (const [edge, past] of stands) standsFor[list[edge]!.id] = ids(past)
      setStandIns(node, standsFor)
    }
    nodes.set(node.id, node)
  }
  return nodes
}

const DEPENDENTS_MEMO_VERSION = 'dependents-memo-v1'

/** The graph's edges are in the row's id (its token); which nodes this run kept, here. */
const COUNT_PARTS = memoParts<{ nodes: ReadonlyMap<string, TaskNode> }>({
  nodes: (nodes) => [...nodes.keys()].join('\0'),
})

/**
 * The run's dependents count, the scheduler's baseline and every row's
 * `blocks`, read back with the graph it was counted on: the closure over a
 * 9,603-task graph (11k nodes) was ~100 ms of every warm run, the same each
 * time. `token` names the graph's edges (`memoGraph`, undefined once anything
 * edited them), the node ids which of them this run kept (`--affected` prunes
 * under the same token).
 */
export function graphCounts(
  nodes: ReadonlyMap<string, TaskNode>,
  folds: FoldMemo | undefined,
  token: string | undefined,
): Map<string, number> {
  if (folds === undefined || token === undefined) return computeReverseDepCount(nodes)
  // Not `counts`: those rows held a second count the rows no longer show.
  const id = `\0dependents\0${token}`
  const probe = COUNT_PARTS.token(DEPENDENTS_MEMO_VERSION, { nodes })!
  const row = folds.get(id, probe)
  if (row !== undefined) {
    const back = countsOf(row, nodes)
    if (back !== undefined) return back
  }
  const counts = computeReverseDepCount(nodes)
  folds.set(id, probe, JSON.stringify([...nodes.keys()].map((k) => counts.get(k)!)))
  return counts
}

function countsOf(
  row: string,
  nodes: ReadonlyMap<string, TaskNode>,
): Map<string, number> | undefined {
  let all: number[]
  try {
    all = JSON.parse(row) as number[]
  } catch {
    return undefined
  }
  if (all?.length !== nodes.size) return undefined
  const counts = new Map<string, number>()
  let i = 0
  for (const id of nodes.keys()) counts.set(id, all[i++]!)
  return counts
}
