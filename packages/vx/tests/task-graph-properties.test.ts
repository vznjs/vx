// `buildTaskGraph` over seeded random workspaces, against a recursive
// reference that reads the `dependsOn` rules as written: `name` and
// `pkg#name` must exist, `build.*` names every other matching task of the
// project, and `^name` reaches the nearest holders through packages that
// lack it (a package-graph cycle never leads back to the declaring
// project). The builder's explicit stack and pending lists must give the
// same tasks, the same edges and the same requested flags, and refuse
// exactly the workspaces the reference refuses (C-79).

import { expect, it } from 'bun:test'
import type { ProjectConfig, TaskConfig } from '../src/config.js'
import { buildTaskGraph, type ProjectEntry } from '../src/graph/task-graph.js'
import type { PackageGraph } from '../src/workspace/index.js'
import { rng } from './helpers/rng.js'

const NAMES = ['build', 'test', 'lint', 'build.a', 'build.b']

function check(seed: number): string[] {
  const rnd = rng(seed)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!
  const broken: string[] = []
  for (let iter = 0; iter < 2000; iter++) {
    const n = 1 + Math.floor(rnd() * 6)
    const names = Array.from({ length: n }, (_, i) => `p${i}`)
    // Mostly the order a workspace has (a package depends on earlier ones),
    // with the odd cycle a dev dependency makes.
    const direct = new Map(
      names.map((p, i) => [
        p,
        names.filter((q, j) => q !== p && rnd() < (j < i ? 0.45 : 0.05)).sort(),
      ]),
    )
    const declared = new Map(names.map((p) => [p, NAMES.filter(() => rnd() < 0.6)]))
    const projects = new Map<string, ProjectEntry>()
    for (const p of names) {
      const tasks: Record<string, TaskConfig> = {}
      for (const t of declared.get(p)!) {
        const dependsOn: string[] = []
        const earlier = declared.get(p)!.filter((x) => NAMES.indexOf(x) < NAMES.indexOf(t))
        const k = Math.floor(rnd() * 4)
        for (let i = 0; i < k; i++) {
          const form = rnd()
          // Now and then a name nothing declares or an edge back: refused.
          if (form < 0.05) dependsOn.push(pick(NAMES))
          else if (form < 0.3) {
            if (earlier.length > 0) dependsOn.push(pick(earlier))
          } else if (form < 0.6) dependsOn.push(`^${pick(NAMES)}`)
          else if (form < 0.75) dependsOn.push(rnd() < 0.5 ? 'build.*' : '^build.*')
          else {
            const q = pick(names)
            const there = declared.get(q)!
            if (q !== p && there.length > 0) dependsOn.push(`${q}#${pick(there)}`)
          }
        }
        tasks[t] = dependsOn.length > 0 ? { dependsOn, exec: { command: 'x' } } : {}
      }
      projects.set(p, { name: p, dir: `/ws/${p}`, config: { tasks } as ProjectConfig })
    }
    const graph: PackageGraph = {
      directDeps: (p) => direct.get(p) ?? [],
      transitiveDeps: () => [],
      transitiveDependents: () => [],
    }
    const requested = names
      .flatMap((p) => declared.get(p)!.map((task) => ({ project: p, task })))
      .filter(() => rnd() < 0.3)

    // The reference.
    const has = (p: string, t: string): boolean => declared.get(p)?.includes(t) === true
    const anywhere = (t: string): boolean => names.some((p) => has(p, t))
    const holders = (p: string, holds: (q: string) => boolean): string[] => {
      const out: string[] = []
      const seen = new Set([p])
      const walk = (q: string): void => {
        if (seen.has(q)) return
        seen.add(q)
        if (holds(q)) out.push(q)
        else for (const d of direct.get(q)!) walk(d)
      }
      for (const d of direct.get(p)!) walk(d)
      return out
    }
    const glob = (t: string): boolean => t.startsWith('build.')
    const edges = (p: string, t: string): string[] | 'refused' => {
      const out: string[] = []
      for (const raw of projects.get(p)!.config.tasks![t]!.dependsOn ?? []) {
        if (raw === 'build.*') {
          for (const x of declared.get(p)!) if (x !== t && glob(x)) out.push(`${p}#${x}`)
        } else if (raw === '^build.*') {
          for (const h of holders(p, (q) => declared.get(q)!.some(glob)))
            for (const x of declared.get(h)!) if (glob(x)) out.push(`${h}#${x}`)
        } else if (raw.startsWith('^')) {
          const name = raw.slice(1)
          const hs = holders(p, (q) => has(q, name))
          if (hs.length === 0 && !anywhere(name)) return 'refused'
          for (const h of hs) out.push(`${h}#${name}`)
        } else if (raw.includes('#')) {
          const [q, x] = raw.split('#') as [string, string]
          if (!has(q, x)) return 'refused'
          out.push(raw)
        } else {
          if (!has(p, raw)) return 'refused'
          out.push(`${p}#${raw}`)
        }
      }
      return [...new Set(out)].sort()
    }
    const want = new Map<string, string[]>()
    let refused = false
    const stack = requested.map((r) => `${r.project}#${r.task}`)
    while (stack.length > 0 && !refused) {
      const id = stack.pop()!
      if (want.has(id)) continue
      const [p, t] = id.split('#') as [string, string]
      const e = edges(p, t)
      if (e === 'refused') refused = true
      else {
        want.set(id, e)
        stack.push(...e)
      }
    }
    if (!refused) {
      const state = new Map<string, 1 | 2>()
      const cyclic = (id: string): boolean => {
        if (state.get(id) === 2) return false
        if (state.get(id) === 1) return true
        state.set(id, 1)
        const c = want.get(id)!.some(cyclic)
        state.set(id, 2)
        return c
      }
      refused = [...want.keys()].some(cyclic)
    }

    let got: Map<string, { deps: string[]; requested: boolean }> | 'refused'
    try {
      got = new Map(
        [...buildTaskGraph({ projects, packageGraph: graph, requested })].map(([id, node]) => [
          id,
          { deps: node.deps, requested: node.requested },
        ]),
      )
    } catch {
      got = 'refused'
    }
    const asked = new Set(requested.map((r) => `${r.project}#${r.task}`))
    const expected = refused
      ? 'refused'
      : new Map([...want].map(([id, deps]) => [id, { deps, requested: asked.has(id) }]))
    const show = (g: typeof got): string =>
      g === 'refused'
        ? g
        : JSON.stringify(Object.fromEntries([...g].sort(([a], [b]) => (a < b ? -1 : 1))))
    if (show(got) !== show(expected))
      broken.push(
        `#${iter}: got ${show(got)}, expected ${show(expected)} ` +
          `(direct ${JSON.stringify(Object.fromEntries(direct))}, ` +
          `tasks ${JSON.stringify(Object.fromEntries([...projects].map(([p, e]) => [p, e.config.tasks])))}, ` +
          `requested ${JSON.stringify(requested)})`,
      )
  }
  return broken
}

it('builds the graph the dependsOn rules describe, over random workspaces', () => {
  expect(check(298).slice(0, 2)).toEqual([])
})
