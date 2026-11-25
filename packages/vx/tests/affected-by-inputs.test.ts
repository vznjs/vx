// `--affected` is per task and decided by inputs (M, 2026-11-25): a task with
// `exec` and no `inputs` is always affected; one with `inputs` only when a
// changed path is one of them, its own definition moved, or its key's
// material (a lockfile claim) did; a group only when its dependencies are.
// Each reaches the tasks that depend on it. A path no input declares, or a
// workspace config edit that moves no key, reaches nothing.
import { describe, expect, it } from 'bun:test'
import { affectedRoots } from '../src/orchestrator/affected-tasks.js'
import { computeGroupHash } from '../src/orchestrator/task-hash.js'
import type { TaskNode, TaskOutcome } from '../src/graph/index.js'
import type { TaskConfig } from '../src/config.js'
import type { AffectedChanges, PackageGraph, ProjectEntry } from '../src/workspace/index.js'

const keyed = (...files: string[]): TaskConfig => ({
  exec: { command: 'true' },
  inputs: { files },
  outputs: { files: [] },
  cache: true,
})
const NO_INPUTS: TaskConfig = { exec: { command: 'true' } }
const GROUP: TaskConfig = { dependsOn: ['x'] }

function node(id: string, config: TaskConfig, deps: string[] = []): TaskNode {
  const [projectName, taskName] = id.split('#') as [string, string]
  return {
    id,
    projectName,
    projectDir: `/w/${projectName}`,
    taskName,
    config,
    deps,
    requested: false,
  } as unknown as TaskNode
}

const graphOf = (...ns: TaskNode[]) => new Map(ns.map((n) => [n.id, n]))
const projectsOf = (nodes: ReadonlyMap<string, TaskNode>) => {
  const out = new Map<string, { name: string; dir: string; config: { tasks: object } }>()
  for (const n of nodes.values()) {
    const p = out.get(n.projectName) ?? {
      name: n.projectName,
      dir: n.projectDir,
      config: { tasks: {} },
    }
    ;(p.config.tasks as Record<string, TaskConfig>)[n.taskName] = n.config
    out.set(n.projectName, p)
  }
  return out as unknown as ReadonlyMap<string, ProjectEntry>
}
const packageGraph = { edgeSource: true, directDeps: () => [] } as unknown as PackageGraph

function changed(
  paths: Record<string, string[]>,
  extra: Partial<AffectedChanges> = {},
): AffectedChanges {
  return {
    projects: new Set(Object.keys(paths)),
    changed: Object.entries(paths).flatMap(([p, rels]) => rels.map((r) => `${p}/${r}`)),
    paths: new Map(Object.entries(paths)),
    whole: new Set(),
    ...extra,
  }
}

function kept(
  nodes: ReadonlyMap<string, TaskNode>,
  changes: AffectedChanges,
  opts: { keyPlugins?: boolean } = {},
): string[] {
  return affectedRoots(
    nodes,
    [...nodes.keys()],
    changes,
    projectsOf(nodes),
    packageGraph,
    '/w',
    undefined,
    opts.keyPlugins === true,
  )
}

describe('--affected by inputs', () => {
  it('a changed path no input declares reaches no task with inputs', () => {
    const nodes = graphOf(node('app#build', keyed('src/**')), node('app#lint', keyed('lint/**')))
    expect(kept(nodes, changed({ app: ['other.txt'] }))).toEqual([])
    expect(kept(nodes, changed({ app: ['src/a.ts'] }))).toEqual(['app#build'])
  })

  it('a task with exec and no inputs is always affected, and so is what depends on it', () => {
    const nodes = graphOf(
      node('app#gen', NO_INPUTS),
      node('app#build', { ...keyed('src/**'), dependsOn: ['gen'] }, ['app#gen']),
      node('lib#test', keyed('test/**')),
    )
    // No change at all, and a change in another project.
    expect(kept(nodes, changed({}))).toEqual(['app#gen', 'app#build'])
    expect(kept(nodes, changed({ lib: ['README.md'] }))).toEqual(['app#gen', 'app#build'])
  })

  it('a task with inputs.files [] is reached only through its dependencies', () => {
    const nodes = graphOf(
      node('app#seed', keyed('src/**')),
      node('app#none', keyed()),
      node('app#after', { ...keyed(), dependsOn: ['seed'] }, ['app#seed']),
    )
    expect(kept(nodes, changed({ app: ['other.txt'] }))).toEqual([])
    expect(kept(nodes, changed({ app: ['src/a.ts'] }))).toEqual(['app#seed', 'app#after'])
  })

  it('a group is reached only through its dependencies, or its own definition', () => {
    const nodes = graphOf(
      node('app#dep', keyed('src/**')),
      node('app#g', { dependsOn: ['dep'] }, ['app#dep']),
      node('app#down', { ...keyed('down.txt'), dependsOn: ['g'] }, ['app#g']),
    )
    expect(kept(nodes, changed({ app: ['other.txt'] }))).toEqual([])
    expect(kept(nodes, changed({ app: ['src/a.ts'] }))).toEqual(['app#dep', 'app#g', 'app#down'])
    // The group's definition moved (a description): it and its dependant.
    const edit = changed(
      { app: ['vx.config.ts'] },
      { configTasks: new Map([['app', new Set(['g'])]]) },
    )
    expect(kept(nodes, edit)).toEqual(['app#g', 'app#down'])
  })

  it("a task's own config edit reaches it, and no sibling", () => {
    const nodes = graphOf(node('app#build', keyed('src/**')), node('app#test', keyed('test/**')))
    const edit = changed(
      { app: ['vx.config.ts'] },
      { configTasks: new Map([['app', new Set(['build'])]]) },
    )
    expect(kept(nodes, edit)).toEqual(['app#build'])
  })

  it('a lockfile claim reaches the tasks of the projects it names whose key holds it', () => {
    const nodes = graphOf(
      node('app#build', keyed('src/**')),
      node('app#g', GROUP, ['app#build']),
      node('lib#build', keyed('src/**')),
    )
    const claim = changed(
      {},
      {
        projects: new Set(['app']),
        changed: ['bun.lock'],
        whole: new Set(['app']),
        wholeBy: new Map([['app', 'bun.lock']]),
      },
    )
    expect(kept(nodes, claim)).toEqual(['app#build', 'app#g'])
  })

  it('a workspace config edit reaches only what it moves', () => {
    const nodes = graphOf(node('app#build', keyed('src/**')), node('lib#lint', NO_INPUTS))
    const edit = changed({ '.': ['.vx/workspace.ts'] }, { workspace: '.vx/workspace.ts' })
    // A comment: no locked config moved, and no plugin keys tasks.
    expect(kept(nodes, edit)).toEqual(['lib#lint'])
    // A plugin's `key` material may move with it.
    expect(kept(nodes, edit, { keyPlugins: true })).toEqual(['app#build', 'lib#lint'])
  })

  it('a dependency input reaches its dependants in other projects', () => {
    const nodes = graphOf(
      node('ui#build', keyed('src/**')),
      node('web#build', { ...keyed('src/**'), dependsOn: ['^build'] }, ['ui#build']),
      node('web#lint', keyed('src/**')),
    )
    expect(kept(nodes, changed({ ui: ['src/a.ts'] }))).toEqual(['ui#build', 'web#build'])
  })
})

describe('--affected checks only the changed projects', () => {
  it("never matches an untouched project's tasks against their inputs", () => {
    // Reads of what a match reads, through a spy. A task in a project the
    // diff missed is looked at once, for what it declares; no changed path
    // is tried against it.
    const reads = { files: 0, workspaceFiles: 0 }
    const spied = (dependsOn?: string[]): TaskConfig => ({
      exec: { command: 'true' },
      inputs: new Proxy(
        { files: ['src/**'] },
        {
          get(t, k, r) {
            if (k === 'files' || k === 'workspaceFiles') reads[k]++
            return Reflect.get(t, k, r) as unknown
          },
        },
      ),
      ...(dependsOn === undefined ? {} : { dependsOn }),
    })
    const ns: TaskNode[] = [node('ui#build', keyed('src/**'))]
    const n = 500
    for (let i = 0; i < n; i++) {
      ns.push(node(`p${i}#build`, spied()))
      ns.push(node(`p${i}#test`, spied(['^build']), i % 2 === 0 ? ['ui#build'] : []))
    }
    const nodes = graphOf(...ns)
    const paths = Array.from({ length: 40 }, (_, i) => `src/f${i}.ts`)
    const got = kept(nodes, changed({ ui: paths }))
    // Matching each changed path against each task read 40 per task.
    expect({ ...reads, kept: got.length }).toEqual({ files: 0, workspaceFiles: 2 * n, kept: 251 })
    // CONTROL: a touched project's tasks are matched.
    kept(nodes, changed({ p0: ['src/a.ts'] }))
    expect(reads.files).toBeGreaterThan(0)
  })
})

describe("a group's key", () => {
  const up: TaskOutcome[] = [
    {
      node: node('app#dep', keyed('src/**')),
      status: 'success',
      exitCode: 0,
      durationMs: 0,
      hash: 'h',
    },
  ]
  it('moves with its definition, and holds while it holds', () => {
    const g = node('app#g', { dependsOn: ['dep'] })
    const described = node('app#g', { dependsOn: ['dep'], description: 'x' })
    expect(computeGroupHash(g, up)).toBe(
      computeGroupHash(node('app#g', { dependsOn: ['dep'] }), up),
    )
    expect(computeGroupHash(described, up)).not.toBe(computeGroupHash(g, up))
  })
})
