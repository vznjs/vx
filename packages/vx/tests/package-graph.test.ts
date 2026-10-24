import { rm } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { buildPackageGraph } from '../src/workspace/package-graph.js'
import type { ProjectMeta } from '../src/workspace/workspace.js'
import { writeLocalWorkspace } from './helpers/local-workspace.js'
import { dry, PARITY_TIMEOUT, vx } from './helpers/parity.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

/** A project at `/ws/<name>` with a `discover` plugin's `deps` (and `reach`), by name. */
function meta(name: string, deps?: string[], reach?: string[]): ProjectMeta {
  return {
    name,
    dir: `/ws/${name}`,
    configPath: null,
    ...(deps === undefined ? {} : { deps }),
    ...(reach === undefined ? {} : { reach }),
  }
}

describe('buildPackageGraph', () => {
  it('a project that names ITSELF is not its own dependency', () => {
    // A self-edge here is a `^build` that waits on itself: a task cycle
    // reported far from the edge that caused it. BOTH doors carry the same
    // guard (`name !== p.name`), a plugin's edges and the task edges.
    const g = buildPackageGraph(
      [meta('self', ['self', 'other'], ['self']), meta('other')],
      new Map([['self', ['self', 'other']]]),
    )
    expect(g.directDeps('self')).toEqual(['other'])
    expect(g.transitiveDeps('self')).toEqual(['other'])
    // And nothing lists itself as its own dependent, which is what would
    // make `--filter self...` select a cycle.
    expect(g.transitiveDependents('self')).toEqual([])
  })

  it('an edge to a name not in the graph is no edge', () => {
    const g = buildPackageGraph([meta('a', ['b', 'gone'], ['gone']), meta('b')])
    expect(g.directDeps('a')).toEqual(['b'])
    expect(g.transitiveDeps('a')).toEqual(['b'])
  })

  it('builds an empty graph from no projects', () => {
    const g = buildPackageGraph([])
    expect(g.transitiveDeps('anything')).toEqual([])
    expect(g.edgeSource).toBe(false)
  })

  it('a project carrying deps, even none, makes the graph an edge source', () => {
    expect(buildPackageGraph([meta('a', []), meta('b')]).edgeSource).toBe(true)
    // CONTROLS: reach alone and task edges alone supply no `^` edge.
    expect(buildPackageGraph([meta('a', undefined, ['b']), meta('b')]).edgeSource).toBe(false)
    expect(buildPackageGraph([meta('a'), meta('b')], new Map([['a', ['b']]])).edgeSource).toBe(
      false,
    )
  })

  it('directDeps returns only immediate deps, sorted', () => {
    const g = buildPackageGraph([meta('a', ['c', 'b']), meta('b', ['c']), meta('c')])
    expect(g.directDeps('a')).toEqual(['b', 'c'])
    expect(g.directDeps('b')).toEqual(['c'])
    expect(g.directDeps('c')).toEqual([])
    expect(g.directDeps('unknown')).toEqual([])
  })

  it('walks transitive deps and dedupes them', () => {
    const g = buildPackageGraph([meta('a', ['b', 'c']), meta('b', ['c']), meta('c')])
    expect(g.transitiveDeps('a')).toEqual(['b', 'c'])
    expect(g.transitiveDeps('b')).toEqual(['c'])
    expect(g.transitiveDeps('c')).toEqual([])
  })

  it('does not loop forever on a dep cycle', () => {
    const g = buildPackageGraph([meta('a', ['b']), meta('b', ['a'])])
    expect(g.transitiveDeps('a')).toContain('b')
    expect(g.transitiveDeps('b')).toContain('a')
  })

  it('a cycle does not poison the closure memo (results are query-order independent)', () => {
    // a → b → c → a, plus c → z. Computing a's closure first used to cache a
    // TRUNCATED closure for the nodes visited while a sat on the DFS stack
    // (the back-edge contributes nothing), so every later query read the
    // partial set. The closure must not depend on which node is asked first.
    const build = (): ReturnType<typeof buildPackageGraph> =>
      buildPackageGraph([meta('a', ['b']), meta('b', ['c']), meta('c', ['a', 'z']), meta('z')])
    const full = ['a', 'b', 'c', 'z']

    const aFirst = build()
    expect(aFirst.transitiveDeps('a')).toEqual(full)
    expect(aFirst.transitiveDeps('c')).toEqual(full)

    const cFirst = build()
    expect(cFirst.transitiveDeps('c')).toEqual(full)
    expect(cFirst.transitiveDeps('a')).toEqual(full)
  })

  it('a node outside the cycle still gets its full closure after a cycle query', () => {
    const g = buildPackageGraph([
      meta('top', ['a']),
      meta('a', ['b']),
      meta('b', ['a']),
      meta('leaf'),
    ])
    expect(g.transitiveDeps('a')).toEqual(['a', 'b'])
    expect(g.transitiveDeps('top')).toEqual(['a', 'b'])
  })

  it('transitiveDependents walks the reverse direction', () => {
    const g = buildPackageGraph([meta('a', ['b']), meta('b', ['c']), meta('c'), meta('lonely')])
    expect(g.transitiveDependents('c')).toEqual(['a', 'b'])
    expect(g.transitiveDependents('b')).toEqual(['a'])
    expect(g.transitiveDependents('a')).toEqual([])
    expect(g.transitiveDependents('lonely')).toEqual([])
  })

  it('transitiveDependents terminates on a 2-node cycle and includes the other node', () => {
    // The reverse-edge accessor takes the per-query search (the bitset
    // sweep bails on a cycle); the stack guard must stop the walk.
    const g = buildPackageGraph([meta('a', ['b']), meta('b', ['a'])])
    expect(g.transitiveDependents('a')).toContain('b')
    expect(g.transitiveDependents('b')).toContain('a')
  })

  it('reach from a plugin is in both closures and orders nothing', () => {
    const g = buildPackageGraph([meta('a', [], ['b']), meta('b', ['c']), meta('c')])
    expect(g.directDeps('a')).toEqual([])
    expect(g.transitiveDeps('a')).toEqual(['b', 'c'])
    expect(g.transitiveDependents('c')).toEqual(['a', 'b'])
  })
})

const BUILD = `export default {
  tasks: { build: { exec: { command: 'true' }, dependsOn: ['^build'] } },
}
`

describe('`^task` needs an edge source', () => {
  it(
    'with no plugin supplying edges, `^build` fails naming the fix',
    async () => {
      const root = await makeWorkspace({ prefix: 'vx-edge-source-none-' })
      try {
        // A manifest dependency is no edge: without a plugin, `app`'s
        // `^build` would fold nothing of `lib`.
        await addProject(root, 'app', { config: BUILD, deps: { lib: 'workspace:*' } })
        await addProject(root, 'lib', { config: BUILD })
        gitIn(root)('add', '-A')
        // `vx lock` builds the graph, so it refuses before any run can.
        const r = await vx(root, ['run', 'build', '--all', '--dry=json'])
        expect([r.code, r.err.split('\n')[2]]).toEqual([
          1,
          '  app#build: ^build needs project edges; add pnpm()/bun()/npm()/yarn() and install so its lockfile exists, or a plugin that returns `deps`',
        ])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    PARITY_TIMEOUT,
  )

  // `c#build` on a project with no build named a `^build` its config
  // never wrote: the default build's.
  it(
    "the default build's `^build` says it is the default build's",
    async () => {
      const root = await makeWorkspace({ prefix: 'vx-edge-source-default-' })
      try {
        await addProject(root, 'app', {
          config: `export default { tasks: { test: { exec: { command: 'true' } } } }\n`,
        })
        gitIn(root)('add', '-A')
        const r = await vx(root, ['run', 'app#build', '--dry=json'])
        expect([r.code, r.err.split('\n')[0]]).toEqual([
          1,
          '✗ vx run  app#build: app declares no build, so it is the default build, whose ^build needs project edges; add pnpm()/bun()/npm()/yarn() and install so its lockfile exists, or a plugin that returns `deps`',
        ])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    PARITY_TIMEOUT,
  )

  it(
    'a run whose lock was written with an edge source refuses once the plugin is gone',
    async () => {
      const root = await makeWorkspace({ prefix: 'vx-edge-source-gone-', edges: { app: ['lib'] } })
      try {
        await addProject(root, 'app', { config: BUILD })
        await addProject(root, 'lib', { config: BUILD })
        expect((await dry(root, ['build', '--all'])).map((t) => t.id)).toEqual([
          'app#build',
          'lib#build',
        ])
        await writeLocalWorkspace(root)
        // The run itself, past the lock the helper would rewrite.
        const run = Bun.spawnSync(
          [process.execPath, path.join(import.meta.dir, '../src/bin.ts'), 'run', 'build', '--all'],
          { cwd: root, stdout: 'pipe', stderr: 'pipe' },
        )
        expect([run.exitCode, run.stderr.toString().split('\n')[0]]).toEqual([
          1,
          '✗ vx run  app#build: ^build needs project edges; add pnpm()/bun()/npm()/yarn() and install so its lockfile exists, or a plugin that returns `deps`',
        ])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    PARITY_TIMEOUT,
  )

  it(
    'with an edge source, a leaf resolves `^build` to nothing and a dependent waits on its dep',
    async () => {
      const root = await makeWorkspace({ prefix: 'vx-edge-source-', edges: { app: ['lib'] } })
      try {
        await addProject(root, 'app', { config: BUILD })
        await addProject(root, 'lib', { config: BUILD })
        await addProject(root, 'leaf', { config: BUILD })
        const plan = await dry(root, ['build', '--all'])
        expect(Object.fromEntries(plan.map((t) => [t.id, t.deps]))).toEqual({
          'app#build': ['lib#build'],
          'leaf#build': [],
          'lib#build': [],
        })
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    PARITY_TIMEOUT,
  )

  it(
    'a workspace that writes no `^` runs with no edge source',
    async () => {
      const root = await makeWorkspace({ prefix: 'vx-edge-source-free-' })
      try {
        await addProject(root, 'a', {
          config: `export default { tasks: { build: { exec: { command: 'true' }, dependsOn: ['b#build'] } } }\n`,
        })
        await addProject(root, 'b', {
          config: `export default { tasks: { build: { exec: { command: 'true' } } } }\n`,
        })
        const plan = await dry(root, ['build', '--all'])
        expect(Object.fromEntries(plan.map((t) => [t.id, t.deps]))).toEqual({
          'a#build': ['b#build'],
          'b#build': [],
        })
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    PARITY_TIMEOUT,
  )
})
