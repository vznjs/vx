// `buildTaskGraph` then `runGraph`, over seeded random workspaces that
// cycle now and then (a `name` edge back, a `p#t` loop across projects, a
// `^name` through a package cycle, a task naming itself). The sibling
// property files hold the edge set (task-graph-properties) and the
// scheduler over hand-made DAGs (scheduler-properties); this one holds
// what neither does: a refusal names a cycle the reference graph has, the
// build and a serial run are the same twice, and a graph the builder
// made is run each task at most once, after its deps, within the
// worker limit, with a failure's dependents held per `--continue` mode.

import { expect, it } from 'bun:test'
import type { ProjectConfig, TaskConfig } from '../src/config.js'
import type { TaskNode } from '../src/graph/index.js'
import { runGraph, type ContinueMode, type TaskOutcome } from '../src/graph/scheduler.js'
import { buildTaskGraph, type ProjectEntry } from '../src/graph/task-graph.js'
import type { PackageGraph } from '../src/workspace/index.js'
import { rng } from './helpers/rng.js'

const NAMES = ['build', 'test', 'lint', 'pack']
const MODES: ContinueMode[] = ['never', 'deps-ok', 'always']

interface Workspace {
  projects: Map<string, ProjectEntry>
  graph: PackageGraph
  requested: { project: string; task: string }[]
  // The reference: every edge each declared task's dependsOn makes.
  edges: Map<string, string[]>
}

function workspace(rnd: () => number): Workspace {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!
  const n = 1 + Math.floor(rnd() * 5)
  const names = Array.from({ length: n }, (_, i) => `p${i}`)
  const direct = new Map(
    names.map((p, i) => [p, names.filter((q, j) => q !== p && rnd() < (j < i ? 0.4 : 0.06))]),
  )
  const declared = new Map(names.map((p) => [p, NAMES.filter(() => rnd() < 0.65)]))
  const has = (p: string, t: string): boolean => declared.get(p)!.includes(t)
  const holders = (p: string, t: string): string[] => {
    const out: string[] = []
    const seen = new Set([p])
    const walk = (q: string): void => {
      if (seen.has(q)) return
      seen.add(q)
      if (has(q, t)) out.push(q)
      else for (const d of direct.get(q)!) walk(d)
    }
    for (const d of direct.get(p)!) walk(d)
    return out
  }
  const everywhere = names.flatMap((p) => declared.get(p)!.map((t) => `${p}#${t}`))
  const projects = new Map<string, ProjectEntry>()
  const edges = new Map<string, string[]>()
  for (const p of names) {
    const tasks: Record<string, TaskConfig> = {}
    const mine = declared.get(p)!
    for (const t of mine) {
      const dependsOn: string[] = []
      const out: string[] = []
      const k = Math.floor(rnd() * 3)
      for (let i = 0; i < k; i++) {
        const form = rnd()
        if (form < 0.03) {
          dependsOn.push(t)
          out.push(`${p}#${t}`)
        } else if (form < 0.35) {
          // Mostly an earlier name; a later one may close a loop.
          const earlier = mine.filter((x) => NAMES.indexOf(x) < NAMES.indexOf(t))
          const x = rnd() < 0.85 && earlier.length > 0 ? pick(earlier) : pick(mine)
          if (x === t) continue
          dependsOn.push(x)
          out.push(`${p}#${x}`)
        } else if (form < 0.7) {
          const x = pick(NAMES)
          if (!names.some((q) => has(q, x))) continue
          dependsOn.push(`^${x}`)
          for (const h of holders(p, x)) out.push(`${h}#${x}`)
        } else {
          const id = pick(everywhere)
          if (id.startsWith(`${p}#`)) continue
          dependsOn.push(id)
          out.push(id)
        }
      }
      const group = rnd() < 0.15 && dependsOn.length > 0
      tasks[t] = group ? { dependsOn } : { dependsOn, exec: { command: 'x' } }
      edges.set(`${p}#${t}`, [...new Set(out)])
    }
    projects.set(p, { name: p, dir: `/ws/${p}`, config: { tasks } as ProjectConfig })
  }
  const graph: PackageGraph = {
    directDeps: (p) => direct.get(p) ?? [],
    transitiveDeps: () => [],
    transitiveDependents: () => [],
  }
  const requested = everywhere
    .filter(() => rnd() < 0.35)
    .map((id) => {
      const [project, task] = id.split('#') as [string, string]
      return { project, task }
    })
  return { projects, graph, requested, edges }
}

function reachable(ws: Workspace): Set<string> {
  const out = new Set<string>()
  const stack = ws.requested.map((r) => `${r.project}#${r.task}`)
  while (stack.length > 0) {
    const id = stack.pop()!
    if (out.has(id)) continue
    out.add(id)
    stack.push(...ws.edges.get(id)!)
  }
  return out
}

function hasCycle(ws: Workspace, ids: Set<string>): boolean {
  const state = new Map<string, 1 | 2>()
  const visit = (id: string): boolean => {
    if (state.get(id) === 2) return false
    if (state.get(id) === 1) return true
    state.set(id, 1)
    const c = ws.edges.get(id)!.some(visit)
    state.set(id, 2)
    return c
  }
  return [...ids].some(visit)
}

type Built = { nodes: Map<string, TaskNode> } | { error: string }

function build(ws: Workspace): Built {
  try {
    return {
      nodes: buildTaskGraph({
        projects: ws.projects,
        packageGraph: ws.graph,
        requested: ws.requested,
      }),
    }
  } catch (err) {
    return { error: (err as Error).message }
  }
}

const show = (b: Built): string =>
  'error' in b
    ? b.error
    : JSON.stringify([...b.nodes.values()].map((n) => [n.id, n.deps, n.requested]))

const yieldTurns = (k: number) =>
  Array.from({ length: k }).reduce<Promise<void>>(
    (p) => p.then(() => Bun.sleep(0)),
    Promise.resolve(),
  )

interface Run {
  outcomes: Map<string, TaskOutcome>
  starts: string[]
}

async function run(
  nodes: Map<string, TaskNode>,
  fail: Set<string>,
  concurrency: number,
  mode: ContinueMode,
  turns: (id: string) => number,
  bad: (m: string) => void,
): Promise<Run> {
  const starts: string[] = []
  const finished = new Set<string>()
  let firstFailure = -1
  let active = 0
  const outcomes = await runGraph({
    nodes,
    concurrency,
    continueMode: mode,
    onFinish: (o) => {
      finished.add(o.node.id)
      if (o.status === 'failed' && firstFailure < 0) firstFailure = starts.length
    },
    execute: async (node) => {
      if (starts.includes(node.id)) bad(`${node.id} ran twice`)
      if (mode === 'never' && firstFailure >= 0) bad(`${node.id} started after a failure`)
      for (const d of node.deps) if (!finished.has(d)) bad(`${node.id} started before ${d}`)
      starts.push(node.id)
      if (++active > concurrency) bad(`${active} running > ${concurrency}`)
      await yieldTurns(turns(node.id))
      active--
      const status = fail.has(node.id) ? 'failed' : 'success'
      return { node, status, exitCode: status === 'failed' ? 1 : 0, durationMs: 0 } as TaskOutcome
    },
  })
  return { outcomes, starts }
}

it('builds, refuses and runs random workspaces as the reference says', async () => {
  const rnd = rng(1871)
  const broken: string[] = []
  let cycles = 0
  let runs = 0
  for (let iter = 0; iter < 1500; iter++) {
    const bad = (m: string) => broken.push(`#${iter} ${m}`)
    const ws = workspace(rnd)
    const want = reachable(ws)
    const built = build(ws)
    if (show(build(ws)) !== show(built)) bad('the build differs between two calls')

    if (hasCycle(ws, want)) {
      cycles++
      const m = 'error' in built ? /^Cycle detected in task graph: (.+)$/.exec(built.error) : null
      if (m === null) {
        bad(`a cycle not refused as one: ${show(built)}`)
        continue
      }
      const path = m[1]!.split(' -> ')
      const inner = path.slice(0, -1)
      if (path.length < 2 || path[0] !== path.at(-1) || new Set(inner).size !== inner.length)
        bad(`not a simple cycle: ${m[1]}`)
      for (let i = 0; i + 1 < path.length; i++) {
        if (!want.has(path[i]!)) bad(`${path[i]} is not in the run`)
        if (!ws.edges.get(path[i]!)?.includes(path[i + 1]!))
          bad(`no edge ${path[i]} -> ${path[i + 1]} in ${m[1]}`)
      }
      continue
    }
    if ('error' in built) {
      bad(`refused an acyclic workspace: ${built.error}`)
      continue
    }
    const nodes = built.nodes
    const got = [...nodes.keys()].sort().join()
    if (got !== [...want].sort().join()) bad(`tasks ${got} != ${[...want].sort().join()}`)
    if (nodes.size === 0) continue

    runs++
    const fail = new Set([...nodes.keys()].filter(() => rnd() < 0.2))
    const mode = MODES[Math.floor(rnd() * MODES.length)]!
    const concurrency = 1 + Math.floor(rnd() * 4)
    const turnsOf = new Map([...nodes.keys()].map((id) => [id, Math.floor(rnd() * 3)]))
    const turns = (id: string): number => turnsOf.get(id)!
    const { outcomes, starts } = await run(nodes, fail, concurrency, mode, turns, bad)

    if (outcomes.size !== nodes.size) bad(`${outcomes.size} outcomes for ${nodes.size} tasks`)
    const ran = new Set(starts)
    const blocked = new Map<string, boolean>()
    const failedAbove = (id: string): boolean => {
      const known = blocked.get(id)
      if (known !== undefined) return known
      const b = nodes
        .get(id)!
        .deps.some((d) => outcomes.get(d)?.status === 'failed' || failedAbove(d))
      blocked.set(id, b)
      return b
    }
    const anyFailed = [...outcomes.values()].some((o) => o.status === 'failed')
    for (const id of nodes.keys()) {
      const status = outcomes.get(id)?.status
      const expected =
        mode === 'always' ? true : mode === 'deps-ok' ? !failedAbove(id) : !anyFailed || ran.has(id)
      if (ran.has(id) !== expected) bad(`${mode}: ${id} ran=${ran.has(id)}`)
      if (ran.has(id) && status !== (fail.has(id) ? 'failed' : 'success'))
        bad(`${id} ran and reported ${status}`)
      if (!ran.has(id) && status !== 'skipped') bad(`${id} did not run and reported ${status}`)
    }

    if (concurrency === 1) {
      const again = await run(nodes, fail, 1, mode, turns, bad)
      if (again.starts.join() !== starts.join())
        bad(`serial order ${again.starts.join()} != ${starts.join()}`)
    }
  }
  // The generator must reach both arms, or a pass says nothing.
  expect({ cyclesSeen: cycles > 150, runsSeen: runs > 600 }).toEqual({
    cyclesSeen: true,
    runsSeen: true,
  })
  expect(broken.slice(0, 5)).toEqual([])
})
