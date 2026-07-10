import { describe, expect, it } from 'bun:test'
import type { TaskConfig } from '../src/config.js'
import type { PackageGraph } from '../src/workspace/package-graph.js'
import { buildTaskGraph, markSurfacedDeps, type ProjectEntry } from '../src/graph/task-graph.js'

function project(name: string, tasks: Record<string, TaskConfig>): ProjectEntry {
  return { name, dir: `/ws/${name}`, config: { tasks } }
}

function projects(...entries: ProjectEntry[]): Map<string, ProjectEntry> {
  return new Map(entries.map((e) => [e.name, e]))
}

function packageGraph(direct: Record<string, string[]>): PackageGraph {
  const directDeps = new Map<string, string[]>()
  for (const [k, v] of Object.entries(direct)) directDeps.set(k, v)

  function transitive(name: string, seen: Set<string> = new Set()): string[] {
    if (seen.has(name)) return []
    seen.add(name)
    const out = new Set<string>()
    for (const d of directDeps.get(name) ?? []) {
      out.add(d)
      for (const t of transitive(d, seen)) out.add(t)
    }
    return [...out]
  }

  return {
    directDeps: (n) => directDeps.get(n) ?? [],
    transitiveDeps: (n) => transitive(n),
    transitiveDependents: () => [],
  }
}

const cmd = (s: string): TaskConfig => ({ exec: { command: s } })

describe('buildTaskGraph', () => {
  it('builds a single zero-dependency node', () => {
    const nodes = buildTaskGraph({
      projects: projects(project('a', { build: cmd('echo a') })),
      packageGraph: packageGraph({}),
      requested: [{ project: 'a', task: 'build' }],
    })
    expect([...nodes.keys()]).toEqual(['a#build'])
    expect(nodes.get('a#build')?.deps).toEqual([])
  })

  it('expands a same-project task dependency via dependsOn.self', () => {
    const nodes = buildTaskGraph({
      projects: projects(
        project('a', {
          test: { ...cmd('vitest'), dependsOn: ['build'] },
          build: cmd('tsc'),
        }),
      ),
      packageGraph: packageGraph({}),
      requested: [{ project: 'a', task: 'test' }],
    })
    expect(nodes.get('a#test')?.deps).toEqual(['a#build'])
    expect(nodes.has('a#build')).toBe(true)
  })

  it('errors when dependsOn.self targets a missing task', () => {
    expect(() =>
      buildTaskGraph({
        projects: projects(
          project('a', {
            test: { ...cmd('vitest'), dependsOn: ['nope'] },
          }),
        ),
        packageGraph: packageGraph({}),
        requested: [{ project: 'a', task: 'test' }],
      }),
    ).toThrow(/depends on a#nope/)
  })

  // ─── '^name' frontier expansion (nearest-holder semantics) ──────────
  //
  // '^task' walks the package dep graph from the project's DIRECT deps
  // and stops at the first package on each path that declares the task
  // (Turbo/Nx direct-deps parity). A holder's own dependsOn is
  // responsible for anything deeper; packages that don't declare the
  // task are passed through (sparse bridging — vx extension).

  it('^name edges only to the nearest holder; deeper builds order via the holder chaining ^name', () => {
    const nodes = buildTaskGraph({
      projects: projects(
        project('app', {
          build: { ...cmd('build app'), dependsOn: ['^build'] },
        }),
        project('lib', {
          build: { ...cmd('build lib'), dependsOn: ['^build'] },
        }),
        project('deep', { build: cmd('build deep') }),
      ),
      packageGraph: packageGraph({ app: ['lib'], lib: ['deep'] }),
      requested: [{ project: 'app', task: 'build' }],
    })
    expect(nodes.get('app#build')?.deps).toEqual(['lib#build'])
    expect(nodes.get('lib#build')?.deps).toEqual(['deep#build'])
    expect(nodes.has('deep#build')).toBe(true)
  })

  it('^name passes through deps that lack the task to deeper holders (sparse bridge)', () => {
    const nodes = buildTaskGraph({
      projects: projects(
        project('app', {
          build: { ...cmd('build app'), dependsOn: ['^build'] },
        }),
        project('mid', { lint: cmd('lint mid') }), // no `build` — bridged through
        project('leaf', { build: cmd('build leaf') }),
      ),
      packageGraph: packageGraph({ app: ['mid'], mid: ['leaf'] }),
      requested: [{ project: 'app', task: 'build' }],
    })
    expect(nodes.get('app#build')?.deps).toEqual(['leaf#build'])
    expect(nodes.has('leaf#build')).toBe(true)
  })

  it('^name does not walk past a holder: deeper holders are NOT auto-ordered', () => {
    // Turbo-parity: `b` declares build WITHOUT chaining '^build', so
    // c#build never enters the graph from app's expansion — b's config
    // owns its own dependency story.
    const nodes = buildTaskGraph({
      projects: projects(
        project('app', {
          build: { ...cmd('build app'), dependsOn: ['^build'] },
        }),
        project('b', { build: cmd('build b') }),
        project('c', { build: cmd('build c') }),
      ),
      packageGraph: packageGraph({ app: ['b'], b: ['c'] }),
      requested: [{ project: 'app', task: 'build' }],
    })
    expect(nodes.get('app#build')?.deps).toEqual(['b#build'])
    expect(nodes.has('c#build')).toBe(false)
  })

  it('^name dedupes a shared subtree reached via multiple bridged paths', () => {
    // left and right both lack `build`; both bridge to shared. The
    // visited-set must collapse the two paths into one edge.
    const nodes = buildTaskGraph({
      projects: projects(
        project('app', {
          build: { ...cmd('build app'), dependsOn: ['^build'] },
        }),
        project('left', { lint: cmd('lint') }),
        project('right', { lint: cmd('lint') }),
        project('shared', { build: cmd('build shared') }),
      ),
      packageGraph: packageGraph({
        app: ['left', 'right'],
        left: ['shared'],
        right: ['shared'],
      }),
      requested: [{ project: 'app', task: 'build' }],
    })
    expect(nodes.get('app#build')?.deps).toEqual(['shared#build'])
  })

  it('runs both self and dependencies tasks before the dependent', () => {
    const nodes = buildTaskGraph({
      projects: projects(
        project('app', {
          build: {
            ...cmd('build app'),
            dependsOn: ['codegen', '^build'],
          },
          codegen: cmd('codegen'),
        }),
        project('lib', { build: cmd('build lib') }),
      ),
      packageGraph: packageGraph({ app: ['lib'] }),
      requested: [{ project: 'app', task: 'build' }],
    })
    expect(nodes.get('app#build')?.deps.sort()).toEqual(['app#codegen', 'lib#build'])
  })

  it('silently skips workspace deps that have no such task', () => {
    const nodes = buildTaskGraph({
      projects: projects(
        project('app', {
          build: { ...cmd('build app'), dependsOn: ['^build'] },
        }),
        project('lib', { lint: cmd('lint lib') }), // no `build` task here
      ),
      packageGraph: packageGraph({ app: ['lib'] }),
      requested: [{ project: 'app', task: 'build' }],
    })
    expect([...nodes.keys()]).toEqual(['app#build'])
    expect(nodes.get('app#build')?.deps).toEqual([])
  })

  it('dedupes diamond dependency: shared upstream node is created once', () => {
    const nodes = buildTaskGraph({
      projects: projects(
        project('app', {
          build: { ...cmd('build'), dependsOn: ['^build'] },
        }),
        project('left', {
          build: { ...cmd('build'), dependsOn: ['^build'] },
        }),
        project('right', {
          build: { ...cmd('build'), dependsOn: ['^build'] },
        }),
        project('shared', { build: cmd('build') }),
      ),
      packageGraph: packageGraph({
        app: ['left', 'right'],
        left: ['shared'],
        right: ['shared'],
      }),
      requested: [{ project: 'app', task: 'build' }],
    })
    expect([...nodes.keys()].sort()).toEqual([
      'app#build',
      'left#build',
      'right#build',
      'shared#build',
    ])
    expect(nodes.get('left#build')?.deps).toEqual(['shared#build'])
    expect(nodes.get('right#build')?.deps).toEqual(['shared#build'])
  })

  it('detects a cross-project cycle', () => {
    expect(() =>
      buildTaskGraph({
        projects: projects(
          project('a', {
            build: { ...cmd('a'), dependsOn: ['^build'] },
          }),
          project('b', {
            build: { ...cmd('b'), dependsOn: ['^build'] },
          }),
        ),
        packageGraph: packageGraph({ a: ['b'], b: ['a'] }),
        requested: [{ project: 'a', task: 'build' }],
      }),
    ).toThrow(/Cycle detected/)
  })

  it('detects a same-project task self-cycle', () => {
    expect(() =>
      buildTaskGraph({
        projects: projects(
          project('a', {
            build: { ...cmd('a'), dependsOn: ['build'] },
          }),
        ),
        packageGraph: packageGraph({}),
        requested: [{ project: 'a', task: 'build' }],
      }),
    ).toThrow(/Cycle detected/)
  })

  it('returns an empty graph when no projects are requested', () => {
    const nodes = buildTaskGraph({
      projects: projects(project('a', { build: cmd('echo') })),
      packageGraph: packageGraph({}),
      requested: [],
    })
    expect(nodes.size).toBe(0)
  })

  it('marks user-requested nodes; deps pulled in by dependsOn are not requested', () => {
    // B2 from real-world test: forwardArgs must not leak to dependencies.
    // The graph builder is the source of truth for which nodes were
    // explicitly asked for vs implicitly pulled.
    const nodes = buildTaskGraph({
      projects: projects(
        project('app', {
          build: { ...cmd('build app'), dependsOn: ['^build'] },
        }),
        project('lib', { build: cmd('build lib') }),
      ),
      packageGraph: packageGraph({ app: ['lib'] }),
      requested: [{ project: 'app', task: 'build' }],
    })
    expect(nodes.get('app#build')?.requested).toBe(true)
    expect(nodes.get('lib#build')?.requested).toBe(false)
  })

  it('a node added implicitly and then requested explicitly is promoted', () => {
    const nodes = buildTaskGraph({
      projects: projects(
        project('app', {
          build: { ...cmd('build app'), dependsOn: ['^build'] },
        }),
        project('lib', { build: cmd('build lib') }),
      ),
      packageGraph: packageGraph({ app: ['lib'] }),
      // `lib#build` is pulled in by app's dependsOn AND requested directly.
      requested: [
        { project: 'app', task: 'build' },
        { project: 'lib', task: 'build' },
      ],
    })
    expect(nodes.get('app#build')?.requested).toBe(true)
    expect(nodes.get('lib#build')?.requested).toBe(true)
  })

  it('excludeDependencies: "all" skips both self and dependencies expansion', () => {
    const nodes = buildTaskGraph({
      projects: projects(
        project('app', {
          build: {
            ...cmd('build app'),
            dependsOn: ['codegen', '^build'],
          },
          codegen: cmd('codegen'),
        }),
        project('lib', { build: cmd('build lib') }),
      ),
      packageGraph: packageGraph({ app: ['lib'] }),
      requested: [{ project: 'app', task: 'build' }],
      excludeDependencies: 'all',
    })
    expect([...nodes.keys()]).toEqual(['app#build'])
    expect(nodes.get('app#build')?.deps).toEqual([])
  })

  it('excludeDependencies: name-list drops only matching edges in both self and deps', () => {
    const nodes = buildTaskGraph({
      projects: projects(
        project('app', {
          build: {
            ...cmd('build app'),
            dependsOn: ['codegen', '^build'],
          },
          codegen: cmd('codegen'),
        }),
        project('lib', { build: cmd('build lib') }),
      ),
      packageGraph: packageGraph({ app: ['lib'] }),
      requested: [{ project: 'app', task: 'build' }],
      excludeDependencies: ['build'],
    })
    // build edge to lib#build is dropped, but the same-project codegen edge stays.
    expect(nodes.has('lib#build')).toBe(false)
    expect(nodes.get('app#build')?.deps).toEqual(['app#codegen'])
  })

  // ─── dependsOn rejects wildcards/negation; cache.inputs.tasks accepts ──
  //
  // Turbo and Nx draw the same line: dependsOn adds edges to the
  // graph (must resolve to a concrete target) while inputs.tasks
  // FILTERS upstream cache contributions (filtering wildcards and
  // negation makes sense). Pin the asymmetric rule with a parametric
  // table so a regression on either side is obvious.
  describe('dependsOn rejects filter-only forms (`*`, `^*`, `!name`)', () => {
    const cases: Array<{ form: string; reason: RegExp }> = [
      { form: '*', reason: /wildcard/i },
      { form: '^*', reason: /wildcard/i },
      { form: '!build', reason: /negation/i },
      { form: '!^build', reason: /negation/i },
      { form: '!pkg#build', reason: /negation/i },
    ]
    for (const { form, reason } of cases) {
      it(`rejects dependsOn: ['${form}']`, () => {
        expect(() =>
          buildTaskGraph({
            projects: projects(project('app', { build: { ...cmd('x'), dependsOn: [form] } })),
            packageGraph: packageGraph({}),
            requested: [{ project: 'app', task: 'build' }],
          }),
        ).toThrow(reason)
      })
    }
  })

  it('cache.inputs.tasks accepts the same forms dependsOn rejects', () => {
    // The graph builder ignores cache.inputs.tasks entirely (it's a
    // cache-key filter, not an edge source). So passing wildcards /
    // negation through cache.inputs.tasks must succeed without
    // touching the dependsOn validation.
    const nodes = buildTaskGraph({
      projects: projects(
        project('app', {
          build: {
            ...cmd('build'),
            cache: {
              inputs: { files: [], tasks: ['*', '^*', '!build', '!^build', '!lib#build'] },
              outputs: { files: [] },
            },
          },
        }),
      ),
      packageGraph: packageGraph({}),
      requested: [{ project: 'app', task: 'build' }],
    })
    expect(nodes.has('app#build')).toBe(true)
  })

  // ─── dependsOn PARTIAL patterns (`build.*`, `^build.*`) — Nx 19.5 parity ──
  describe('dependsOn task-name patterns', () => {
    it("expands 'lint.*' to every other same-project match, never itself", () => {
      const nodes = buildTaskGraph({
        projects: projects(
          project('app', {
            lint: { dependsOn: ['lint.*'] }, // group task
            'lint.oxlint': cmd('oxlint'),
            'lint.oxfmt': cmd('oxfmt'),
            'lint.oxfmt.fix': cmd('oxfmt fix'), // deeper namespace still matches lint.*
            build: cmd('build'), // non-matching sibling
          }),
        ),
        packageGraph: packageGraph({}),
        requested: [{ project: 'app', task: 'lint' }],
      })
      expect(nodes.get('app#lint')?.deps).toEqual([
        'app#lint.oxfmt',
        'app#lint.oxfmt.fix',
        'app#lint.oxlint',
      ])
      expect(nodes.has('app#build')).toBe(false)
    })

    it("a pattern matching the declaring task skips it (no self-cycle) — 'build.*' on build.all", () => {
      const nodes = buildTaskGraph({
        projects: projects(
          project('app', {
            'build.all': { dependsOn: ['build.*'] },
            'build.bin': cmd('bin'),
            'build.lib': cmd('lib'),
          }),
        ),
        packageGraph: packageGraph({}),
        requested: [{ project: 'app', task: 'build.all' }],
      })
      expect(nodes.get('app#build.all')?.deps).toEqual(['app#build.bin', 'app#build.lib'])
    })

    it('zero matches is legal — a preset-spread pattern needs no match here', () => {
      const nodes = buildTaskGraph({
        projects: projects(project('app', { test: { ...cmd('test'), dependsOn: ['codegen.*'] } })),
        packageGraph: packageGraph({}),
        requested: [{ project: 'app', task: 'test' }],
      })
      expect(nodes.get('app#test')?.deps).toEqual([])
    })

    it("'^build.*' edges to ALL matching tasks of the nearest holder and stops there", () => {
      const nodes = buildTaskGraph({
        projects: projects(
          project('app', { test: { ...cmd('test'), dependsOn: ['^build.*'] } }),
          // lib declares two matches — both get edges; walk stops at lib.
          project('lib', {
            'build.js': cmd('js'),
            'build.dts': cmd('dts'),
            lint: cmd('lint'),
          }),
          // deeper holds a match too, but lib is the nearest holder on this path.
          project('deeper', { 'build.js': cmd('deep') }),
        ),
        packageGraph: packageGraph({ app: ['lib'], lib: ['deeper'] }),
        requested: [{ project: 'app', task: 'test' }],
      })
      expect(nodes.get('app#test')?.deps).toEqual(['lib#build.dts', 'lib#build.js'])
      expect(nodes.has('deeper#build.js')).toBe(false)
    })

    it("'^build.*' passes through a dep with no matching task (sparse bridging)", () => {
      const nodes = buildTaskGraph({
        projects: projects(
          project('app', { test: { ...cmd('test'), dependsOn: ['^build.*'] } }),
          project('bridge', { lint: cmd('lint') }), // no build.* — pass through
          project('deep', { 'build.wasm': cmd('wasm') }),
        ),
        packageGraph: packageGraph({ app: ['bridge'], bridge: ['deep'] }),
        requested: [{ project: 'app', task: 'test' }],
      })
      expect(nodes.get('app#test')?.deps).toEqual(['deep#build.wasm'])
    })

    it('--excludeDependencies filters expanded matches by their concrete name', () => {
      const nodes = buildTaskGraph({
        projects: projects(
          project('app', {
            lint: { dependsOn: ['lint.*'] },
            'lint.oxlint': cmd('oxlint'),
            'lint.oxfmt': cmd('oxfmt'),
          }),
        ),
        packageGraph: packageGraph({}),
        requested: [{ project: 'app', task: 'lint' }],
        excludeDependencies: ['lint.oxfmt'],
      })
      expect(nodes.get('app#lint')?.deps).toEqual(['app#lint.oxlint'])
    })

    it('rejects a pattern in the pkg#task form with a clear error', () => {
      expect(() =>
        buildTaskGraph({
          projects: projects(
            project('app', { build: { ...cmd('x'), dependsOn: ['lib#build.*'] } }),
            project('lib', { 'build.js': cmd('js') }),
          ),
          packageGraph: packageGraph({ app: ['lib'] }),
          requested: [{ project: 'app', task: 'build' }],
        }),
      ).toThrow(/patterns are not supported in the "pkg#task" form/)
    })

    it('mixed exact + pattern naming the same target contributes ONE edge', () => {
      const nodes = buildTaskGraph({
        projects: projects(
          project('app', {
            top: { dependsOn: ['build.a', 'build.*'] },
            'build.a': cmd('a'),
            'build.b': cmd('b'),
          }),
        ),
        packageGraph: packageGraph({}),
        requested: [{ project: 'app', task: 'top' }],
      })
      // No duplicate: a doubled edge would double-fold build.a's hash into
      // top's cache key and print the DOT edge twice.
      expect(nodes.get('app#top')?.deps).toEqual(['app#build.a', 'app#build.b'])
    })

    it("'*' is literal only as a metacharacter — dots in names never widen the match", () => {
      const nodes = buildTaskGraph({
        projects: projects(
          project('app', {
            all: { dependsOn: ['build.x*'] },
            'build.x1': cmd('x1'),
            // A '.' regex metachar bug would match this via 'build.x*' → /^build.x.*$/
            // with an UNescaped dot also matching 'buildAx1' — pin the escape.
            buildAx1: cmd('bad'),
          }),
        ),
        packageGraph: packageGraph({}),
        requested: [{ project: 'app', task: 'all' }],
      })
      expect(nodes.get('app#all')?.deps).toEqual(['app#build.x1'])
    })
  })
})

const group = (deps: string[]): TaskConfig => ({ dependsOn: deps })

describe('markSurfacedDeps', () => {
  const surfaced = (nodes: Map<string, { surfaced?: boolean }>): string[] =>
    [...nodes.entries()]
      .filter(([, n]) => n.surfaced === true)
      .map(([id]) => id)
      .sort()

  it('descends through nested same-project groups to the first real tasks', () => {
    // build (group) → build.bun (group) → build.bun.{x,y} (real).
    const nodes = buildTaskGraph({
      projects: projects(
        project('app', {
          build: group(['build.bun']),
          'build.bun': group(['build.bun.x', 'build.bun.y']),
          'build.bun.x': cmd('compile x'),
          'build.bun.y': cmd('compile y'),
        }),
      ),
      packageGraph: packageGraph({}),
      requested: [{ project: 'app', task: 'build' }],
    })
    expect(markSurfacedDeps(nodes)).toBe(2)
    expect(surfaced(nodes)).toEqual(['app#build.bun.x', 'app#build.bun.y'])
    // The intermediate group is never surfaced.
    expect(nodes.get('app#build.bun')?.surfaced).toBeUndefined()
  })

  it('never leaves the requested project (no `^`/cross-project deps)', () => {
    // build deps on a same-project real task, a workspace dep (^build),
    // and a same-project group whose only dep is cross-project.
    const nodes = buildTaskGraph({
      projects: projects(
        project('app', {
          build: group(['compile', '^build', 'checks']),
          compile: cmd('compile app'),
          checks: group(['lib#lint']),
        }),
        project('lib', { build: cmd('build lib'), lint: cmd('lint lib') }),
      ),
      packageGraph: packageGraph({ app: ['lib'] }),
      requested: [{ project: 'app', task: 'build' }],
    })
    markSurfacedDeps(nodes)
    // Only the same-project real task surfaces; lib#build (^) and
    // lib#lint (reached through a group but cross-project) do not.
    expect(surfaced(nodes)).toEqual(['app#compile'])
  })

  it('does not descend past a real task into its own deps', () => {
    const nodes = buildTaskGraph({
      projects: projects(
        project('app', {
          build: group(['compile']),
          compile: { ...cmd('compile'), dependsOn: ['codegen'] },
          codegen: cmd('codegen'),
        }),
      ),
      packageGraph: packageGraph({}),
      requested: [{ project: 'app', task: 'build' }],
    })
    markSurfacedDeps(nodes)
    // compile is the first real task; its own dep codegen stays hidden.
    expect(surfaced(nodes)).toEqual(['app#compile'])
  })

  it('surfaces nothing for a requested non-group task', () => {
    const nodes = buildTaskGraph({
      projects: projects(
        project('app', {
          build: { ...cmd('build'), dependsOn: ['compile'] },
          compile: cmd('compile'),
        }),
      ),
      packageGraph: packageGraph({}),
      requested: [{ project: 'app', task: 'build' }],
    })
    expect(markSurfacedDeps(nodes)).toBe(0)
  })
})
