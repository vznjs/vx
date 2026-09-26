// Nx's `^name` inputs over the project graph (item 910). Nx hashes a
// dependency's `name` input for every project the graph reaches, whether or
// not a task edge exists, so a `test` with `^production` and no `dependsOn`
// re-keys on a dependency's source. vx folds upstream KEYS along
// `dependsOn`, so each project gets one `nx-input:<name>` task — `true`,
// cached, keyed on the project's own `name` input — with an edge to its
// dependencies' twin. A task that reads `^name` depends on its direct
// dependencies' twins and folds the whole closure through them: each
// project's files are hashed once, not once per dependant (listing the
// closure's globs on every task was 2.5 million globs at 1,000 projects).
//
// The edges are the NX graph's, not vx's package graph (`^` in vx follows
// package.json, and an Nx edge from a tsconfig path has no manifest entry),
// so they are explicit `pkg#nx-input:<name>`. A graph node with no vx
// project is transparent: its files join as workspace globs and the walk
// goes on through it. Nx allows a project cycle and vx's task graph does
// not: inside a cycle a twin carries its peers' files as workspace globs
// and edges only out of the cycle.
import type { GeneratedTask, ProjectMeta } from '@vzn/vx'
import { emptyNxInputs, expandNxInputs, type NxInputs } from './nx-inputs.js'

interface GraphNode {
  name?: string
  data?: { root?: string; namedInputs?: Record<string, unknown[]> }
}

const inputTask = (name: string): string => `nx-input:${name}`

function normRel(p: string): string {
  const s = p.replace(/\/+$/, '')
  return s === '.' ? '' : s
}

export interface NxUpstream {
  /** Nx's merge: an implicit `default` of the whole project, nx.json's, the project's. */
  namedOf(node: string): Readonly<Record<string, unknown[]>>
  /**
   * Folds `into.upstream` for a task of `node`: the `dependsOn` edges it
   * needs, with a transparent node's files added to `into`.
   */
  resolve(node: string, into: NxInputs, todos: string[]): string[]
  /** Each project's `nx-input:<name>` tasks, for every name `resolve` was asked for. */
  inputTasks(): Map<string, GeneratedTask[]>
}

export function planNxUpstream(
  nodes: Readonly<Record<string, GraphNode>>,
  dependencies: unknown,
  workspaceNamed: Readonly<Record<string, unknown[]>> | null,
  metaByNode: ReadonlyMap<string, ProjectMeta>,
): NxUpstream {
  const isProject = (n: string): boolean => typeof nodes[n]?.data?.root === 'string'
  const direct = new Map<string, string[]>()
  if (typeof dependencies === 'object' && dependencies !== null) {
    for (const [source, edges] of Object.entries(
      dependencies as Record<string, Array<{ target?: unknown }>>,
    )) {
      if (!Array.isArray(edges)) continue
      // An `npm:` node has no root: it is a package, not a project.
      const to = edges
        .map((e) => e?.target)
        .filter((t): t is string => typeof t === 'string' && t !== source && isProject(t))
      direct.set(source, [...new Set(to)])
    }
  }

  // The vx projects a node reaches first, through any transparent nodes,
  // and the transparent nodes on the way.
  const reachMemo = new Map<string, { edges: string[]; through: string[] }>()
  const reach = (node: string): { edges: string[]; through: string[] } => {
    const known = reachMemo.get(node)
    if (known !== undefined) return known
    const edges = new Set<string>()
    const through = new Set<string>()
    const stack = [...(direct.get(node) ?? [])]
    while (stack.length > 0) {
      const n = stack.pop()!
      if (n === node || edges.has(n) || through.has(n)) continue
      if (metaByNode.has(n)) edges.add(n)
      else {
        through.add(n)
        stack.push(...(direct.get(n) ?? []))
      }
    }
    const r = { edges: [...edges].sort(), through: [...through].sort() }
    reachMemo.set(node, r)
    return r
  }

  // Tarjan's strongly connected components over the vx projects.
  const component = new Map<string, string[]>()
  {
    let index = 0
    const idx = new Map<string, number>()
    const low = new Map<string, number>()
    const onStack = new Set<string>()
    const stack: string[] = []
    const visit = (root: string): void => {
      // Iterative: a deep graph must not overflow the call stack.
      const work: Array<{ node: string; next: number }> = [{ node: root, next: 0 }]
      idx.set(root, index)
      low.set(root, index++)
      stack.push(root)
      onStack.add(root)
      while (work.length > 0) {
        const frame = work[work.length - 1]!
        const out = reach(frame.node).edges
        if (frame.next < out.length) {
          const w = out[frame.next++]!
          if (!idx.has(w)) {
            idx.set(w, index)
            low.set(w, index++)
            stack.push(w)
            onStack.add(w)
            work.push({ node: w, next: 0 })
          } else if (onStack.has(w)) {
            low.set(frame.node, Math.min(low.get(frame.node)!, idx.get(w)!))
          }
          continue
        }
        work.pop()
        const parent = work[work.length - 1]
        if (parent !== undefined)
          low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!))
        if (low.get(frame.node) === idx.get(frame.node)) {
          const members: string[] = []
          let w: string
          do {
            w = stack.pop()!
            onStack.delete(w)
            members.push(w)
          } while (w !== frame.node)
          members.sort()
          for (const m of members) component.set(m, members)
        }
      }
    }
    for (const n of [...metaByNode.keys()].sort()) if (!idx.has(n)) visit(n)
  }

  const namedMemo = new Map<string, Readonly<Record<string, unknown[]>>>()
  const namedOf = (node: string): Readonly<Record<string, unknown[]>> => {
    let named = namedMemo.get(node)
    if (named === undefined) {
      named = {
        default: ['{projectRoot}/**/*'],
        ...workspaceNamed,
        ...nodes[node]?.data?.namedInputs,
      }
      namedMemo.set(node, named)
    }
    return named
  }

  // A node's `name` input, its project globs rewritten under its root.
  const underMemo = new Map<string, { inputs: NxInputs; todos: string[] }>()
  const under = (node: string, name: string): { inputs: NxInputs; todos: string[] } => {
    const key = `${node}\0${name}`
    const known = underMemo.get(key)
    if (known !== undefined) return known
    const own = emptyNxInputs()
    const todos: string[] = []
    expandOwn(node, name, own, todos)
    const rel = normRel(nodes[node]?.data?.root ?? '')
    const inputs = emptyNxInputs()
    for (const g of own.files) {
      const neg = g.startsWith('!') ? '!' : ''
      inputs.wsFiles.push(rel === '' ? g : `${neg}${rel}/${neg === '' ? g : g.slice(1)}`)
    }
    inputs.wsFiles.push(...own.wsFiles)
    inputs.envNames.push(...own.envNames)
    inputs.runtimeCmds.push(...own.runtimeCmds)
    inputs.upstream.push(...own.upstream)
    const r = { inputs, todos }
    underMemo.set(key, r)
    return r
  }
  const expandOwn = (node: string, name: string, into: NxInputs, todos: string[]): void => {
    if (namedOf(node)[name] === undefined) {
      todos.push(
        `named input ${JSON.stringify(name)} not found for ${JSON.stringify(node)} — declare its globs manually`,
      )
      return
    }
    const at = { rel: normRel(nodes[node]?.data?.root ?? ''), name: nodes[node]?.name ?? node }
    expandNxInputs([name], namedOf(node), at, into, todos)
  }

  const merge = (from: NxInputs, into: NxInputs): void => {
    into.wsFiles.push(...from.wsFiles)
    for (const n of from.envNames) if (!into.envNames.includes(n)) into.envNames.push(n)
    for (const c of from.runtimeCmds) if (!into.runtimeCmds.includes(c)) into.runtimeCmds.push(c)
  }

  const needed = new Set<string>()
  const queue: string[] = []
  const need = (name: string): void => {
    if (needed.has(name)) return
    needed.add(name)
    queue.push(name)
  }

  // `name` of everything `self` reaches, as edges to twins, except
  // `peers` — the other members of `self`'s cycle, which a twin carries as
  // files. `visited` ends the walk of a nested `^` through a cycle of
  // transparent nodes.
  const fold = (
    self: string,
    name: string,
    peers: ReadonlySet<string>,
    into: NxInputs,
    todos: string[],
    edges: Set<string>,
    visited: Set<string> = new Set(),
  ): void => {
    const files = new Set<string>()
    for (const s of peers.size > 0 ? peers : [self]) {
      const r = reach(s)
      for (const t of r.through) files.add(t)
      for (const e of r.edges) {
        if (peers.has(e)) continue
        edges.add(`${metaByNode.get(e)!.name}#${inputTask(name)}`)
        need(name)
      }
    }
    for (const p of peers) if (p !== self) files.add(p)
    for (const f of [...files].sort()) {
      if (visited.has(`${f}\0${name}`)) continue
      visited.add(`${f}\0${name}`)
      const r = under(f, name)
      merge(r.inputs, into)
      todos.push(...r.todos)
      // A folded node's own nested `^other` goes on from it; `^name` itself
      // is the closure this walk already covers.
      for (const u of r.inputs.upstream)
        if (u.of === 'deps' && u.name !== name)
          fold(f, u.name, new Set(), into, todos, edges, visited)
    }
  }

  // `{ input, projects }`: those projects' twins (Nx reads each one's own
  // input; the twin's closure is a superset, which only costs hits).
  const foldProjects = (
    name: string,
    of: readonly string[],
    into: NxInputs,
    todos: string[],
    edges: Set<string>,
  ): void => {
    for (const p of of) {
      const u = { name }
      const meta = metaByNode.get(p)
      if (meta !== undefined) {
        edges.add(`${meta.name}#${inputTask(u.name)}`)
        need(u.name)
      } else if (isProject(p)) {
        const r = under(p, u.name)
        merge(r.inputs, into)
        todos.push(...r.todos)
      } else {
        todos.push(`input project ${JSON.stringify(p)} is not a graph node — map manually`)
      }
    }
  }

  const resolve = (node: string, into: NxInputs, todos: string[]): string[] => {
    const edges = new Set<string>()
    for (const u of into.upstream) {
      if (u.of === 'deps') fold(node, u.name, new Set(), into, todos, edges)
      else foldProjects(u.name, u.of, into, todos, edges)
    }
    return [...edges]
  }

  const inputTasks = (): Map<string, GeneratedTask[]> => {
    const out = new Map<string, GeneratedTask[]>()
    const projects = [...metaByNode.keys()].sort()
    while (queue.length > 0) {
      const name = queue.shift()!
      for (const node of projects) {
        const todos: string[] = []
        const inputs = emptyNxInputs()
        expandOwn(node, name, inputs, todos)
        const members = component.get(node) ?? [node]
        const peers = new Set(members.length > 1 ? members : [])
        const edges = new Set<string>()
        fold(node, name, peers, inputs, todos, edges)
        // A nested `^other` in this project's `name` input.
        for (const u of inputs.upstream) {
          if (u.of !== 'deps') foldProjects(u.name, u.of, inputs, todos, edges)
          else if (u.name !== name) fold(node, u.name, peers, inputs, todos, edges)
        }
        const cacheInputs: Record<string, unknown> = { files: inputs.files }
        if (inputs.wsFiles.length > 0) cacheInputs.workspaceFiles = inputs.wsFiles
        if (inputs.envNames.length > 0) cacheInputs.env = inputs.envNames
        if (inputs.runtimeCmds.length > 0) cacheInputs.runtime = inputs.runtimeCmds
        const task: Record<string, unknown> = { exec: { command: 'true' } }
        if (edges.size > 0) task.dependsOn = [...edges].sort()
        task.cache = { inputs: cacheInputs, outputs: { files: [] } }
        const list = out.get(node) ?? []
        list.push({ name: inputTask(name), task, todos })
        out.set(node, list)
      }
    }
    return out
  }

  return { namedOf, resolve, inputTasks }
}
