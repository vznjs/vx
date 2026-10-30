// The task graph memo: the graph a run built, read back whole when nothing
// it is built from has moved. Building 1,206 tasks' graph was 4.5 ms of a
// warm run (2026-10-23), nearly all of it code a short process runs cold;
// reading it back is half that.
//
// A run's configs come from the lock and nowhere else when no plugin fills
// the `project` stage, so the token names them by the lock's bytes instead
// of serializing them (3 ms at 1,206 tasks): the bytes, the projects
// discovered and loaded, their package edges, the requested tasks, the
// rules, the root and the code are everything `buildTaskGraph` reads. A
// scoped load hands undeclared `^name`s back instead of refusing them, so
// it is never remembered.

import type { FoldMemo } from '../cache/index.js'
import {
  buildTaskGraph,
  computeReverseDepCount,
  declaredTask,
  type TaskNode,
} from '../graph/index.js'
import { xxh3hex } from '../util/index.js'
import type { ProjectMeta } from '../workspace/index.js'
import { codeIdentity } from './run-keys.js'

type BuildGraphOptions = Parameters<typeof buildTaskGraph>[0]

/** Moves every remembered graph: bump it when what a token stands for changes. */
const GRAPH_MEMO_VERSION = 'graph-memo-v1'

/** What names a run's configs: the lock they were read from and the projects discovered. */
export interface GraphMemo {
  folds: FoldMemo
  lock: string
  metas: readonly ProjectMeta[]
}

/**
 * A node as the memo holds it: its project and task, requested, its deps
 * and the tasks it adds outputs to as positions in the list (ids in full
 * were 123 KB for 1,206 tasks, and parsing them back cost what the walk
 * saved), and the globs that add to its own outputs.
 */
type Row = [
  project: string,
  task: string,
  requested: 0 | 1,
  deps: number[],
  adds?: number[] | null,
  added?: string[] | null,
]

/**
 * `buildTaskGraph`, answered from the memo when it built this graph before,
 * and the token that names the graph (undefined when not remembered).
 */
export function memoGraph(
  options: BuildGraphOptions,
  memo: GraphMemo | undefined,
): { nodes: Map<string, TaskNode>; token: string | undefined } {
  if (memo === undefined || options.undeclaredDeps !== undefined) {
    return { nodes: buildTaskGraph(options), token: undefined }
  }
  const { projects, packageGraph } = options
  const parts: string[] = [
    GRAPH_MEMO_VERSION,
    codeIdentity(),
    memo.lock,
    options.workspaceRoot ?? '',
    JSON.stringify(options.rules ?? null),
    String(packageGraph.edgeSource),
    JSON.stringify(options.requested),
  ]
  for (const m of memo.metas) {
    parts.push(
      m.name,
      m.dir,
      m.configPath ?? '\u0001',
      packageGraph.directDeps(m.name).join('\u0001'),
    )
  }
  for (const name of projects.keys()) parts.push(name)
  const id = `\0graph\0${xxh3hex(JSON.stringify(options.requested))}`
  const token = xxh3hex(parts.join('\0'))
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
    if (n.addsToOutputsOf !== undefined || n.outputsAddedToBy !== undefined)
      row.push(
        n.addsToOutputsOf === undefined ? null : pos(n.addsToOutputsOf),
        n.outputsAddedToBy ?? null,
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
    const [, , , deps, adds, added] = rows[i]!
    const node = list[i]!
    node.deps = ids(deps)
    if (adds != null) node.addsToOutputsOf = ids(adds)
    if (added != null) node.outputsAddedToBy = added
    nodes.set(node.id, node)
  }
  return nodes
}

/**
 * The run's dependents count, the scheduler's baseline and every row's
 * `blocks`, read back with the graph it was counted on: the closure over a
 * 9,603-task graph (11k nodes) was ~100 ms of every warm run, the same each
 * time (2026-10-29). `token` names the graph's edges (`memoGraph`, undefined
 * once anything edited them), the node ids which of them this run kept
 * (`--affected` prunes under the same token).
 */
export function graphCounts(
  nodes: ReadonlyMap<string, TaskNode>,
  folds: FoldMemo | undefined,
  token: string | undefined,
): Map<string, number> {
  if (folds === undefined || token === undefined) return computeReverseDepCount(nodes)
  // Not `counts`: those rows held a second count the rows no longer show.
  const id = `\0dependents\0${token}`
  const probe = xxh3hex([...nodes.keys()].join('\0'))
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
