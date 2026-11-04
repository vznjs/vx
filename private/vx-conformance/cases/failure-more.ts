// The task graph a run builds and refuses, how a stop ends a run with
// servers and probes in flight, and what a cached task replays: drawn from
// the failure area's graph, signal and parity tests.
import { defineCase, type ProjectSpec, type TaskSpec, type WorkspaceSpec } from '../src/spec.ts'
import { CONCAT, chainProject } from './shapes.ts'

/** A task that reads nothing and depends on what it is given. */
const plain = (dependsOn: string[] = []): TaskSpec => ({
  command: 'true',
  inputs: ['src/**'],
  ...(dependsOn.length > 0 ? { dependsOn } : {}),
})

const proj = (tasks: Record<string, TaskSpec>, deps: string[] = []): ProjectSpec => ({
  deps,
  tasks,
  files: { 'src/a.txt': 'x\n' },
})

/** One project `app` with these tasks. */
const app = (tasks: Record<string, TaskSpec>): WorkspaceSpec => ({
  projects: { app: proj(tasks) },
})

const ready = { ready: 'Listening on' }
const LOOP = 'while :; do sleep 0.05; done'

/** Every task named ran before `last` started. */
const before = (tasks: string[], last: string): [string, string][] => tasks.map((t) => [t, last])

const GRAPH = ['task-graph']

export default [
  // ─── what `^name` reaches ─────────────────────────────────────────────

  defineCase({
    id: 'graph/caret-stops-at-nearest-holder',
    category: 'graph',
    kind: 'efficiency',
    title: '`^build` runs the dependency’s build, not the builds that build itself never names',
    why: 'b’s build declares no dependency on c’s build; c is b’s package dependency, not app’s task’s.',
    from: GRAPH,
    workspace: {
      projects: {
        c: proj({ build: plain() }),
        b: proj({ build: plain() }, ['c']),
        app: proj({ build: plain(['^build']) }, ['b']),
      },
    },
    steps: [
      {
        run: 'build',
        projects: ['app'],
        expect: {
          exit: 0,
          ran: ['b#build', 'app#build'],
          notRan: ['c#build'],
          order: [['b#build', 'app#build']],
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/bridged-diamond-runs-shared-once',
    category: 'graph',
    kind: 'correctness',
    title: '`^build` reaching one build through two projects without a build runs it once',
    from: GRAPH,
    workspace: {
      projects: {
        shared: proj({ build: plain() }),
        left: proj({ lint: plain() }, ['shared']),
        right: proj({ lint: plain() }, ['shared']),
        app: proj({ build: plain(['^build']) }, ['left', 'right']),
      },
    },
    steps: [
      {
        run: 'build',
        projects: ['app'],
        expect: {
          exit: 0,
          ran: ['shared#build', 'app#build'],
          notRan: ['left#lint', 'right#lint'],
          order: [['shared#build', 'app#build']],
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/two-tasks-on-caret-both-wait',
    category: 'graph',
    kind: 'correctness',
    title: 'Two tasks of one project on `^build` each wait for the dependency’s build',
    why: 'With two of a package’s tasks on `^build`, the second lost its edge and read the dependency half-built (turborepo#2981).',
    from: GRAPH,
    workspace: {
      projects: {
        lib: chainProject('lib'),
        app: {
          deps: ['lib'],
          tasks: {
            build: {
              command: 'cat ../lib/dist/out.txt > built.txt',
              dependsOn: ['^build'],
              inputs: ['src/**'],
            },
            compile: {
              command: 'cat ../lib/dist/out.txt > compiled.txt',
              dependsOn: ['^build'],
              inputs: ['src/**'],
            },
            all: plain(['build', 'compile']),
          },
          files: { 'src/a.txt': 'app\n' },
        },
      },
    },
    steps: [
      {
        run: 'all',
        projects: ['app'],
        expect: {
          exit: 0,
          ran: ['lib#build', 'app#build', 'app#compile'],
          order: [
            ['lib#build', 'app#build'],
            ['lib#build', 'app#compile'],
          ],
          files: { 'packages/app/built.txt': 'lib\n', 'packages/app/compiled.txt': 'lib\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/every-depends-on-entry-is-an-edge',
    category: 'graph',
    kind: 'correctness',
    title: 'Each entry of a dependsOn list runs first: three of the project’s, two `^` names',
    why: 'Another runner ran only the first entry, or let one `^` entry stand for the others.',
    from: GRAPH,
    workspace: {
      projects: {
        b: proj({ gen2: plain() }),
        c: proj({ gen1: plain() }),
        a: proj(
          {
            t1: plain(),
            t2: plain(),
            t3: plain(),
            t4: plain(['t1', 't2', 't3', '^gen1', '^gen2']),
          },
          ['b', 'c'],
        ),
      },
    },
    steps: [
      {
        run: 't4',
        projects: ['a'],
        expect: {
          exit: 0,
          ran: ['a#t1', 'a#t2', 'a#t3', 'c#gen1', 'b#gen2', 'a#t4'],
          order: before(['a#t1', 'a#t2', 'a#t3', 'c#gen1', 'b#gen2'], 'a#t4'),
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/two-carets-through-taskless',
    category: 'graph',
    kind: 'correctness',
    title:
      '`^test` and `^lint` through a project with no tasks reach each project beyond that declares them',
    why: 'Nx’s order-invariance fixture: the middle project declares nothing, so both names pass through it.',
    from: GRAPH,
    workspace: {
      projects: {
        lib2: proj({ test: plain(), lint: plain() }),
        lib3: proj({ lint: plain() }),
        lib1: { deps: ['lib2', 'lib3'], tasks: {}, files: { 'src/a.txt': 'x\n' } },
        app1: proj({ test: plain(['^test', '^lint']), lint: plain(['^lint']) }, ['lib1']),
      },
    },
    steps: [
      {
        run: 'test',
        projects: ['app1'],
        expect: {
          exit: 0,
          ran: ['lib2#test', 'lib2#lint', 'lib3#lint', 'app1#test'],
          notRan: ['app1#lint'],
          order: before(['lib2#test', 'lib2#lint', 'lib3#lint'], 'app1#test'),
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/caret-declared-off-path-runs-alone',
    category: 'graph',
    kind: 'correctness',
    title:
      '`^build` where only a project off the dependency path declares build runs the task alone',
    why: 'Some project declares build, so the name is no typo; none of this project’s dependencies has one.',
    from: GRAPH,
    workspace: {
      projects: {
        web: proj({ build: plain() }),
        cart: proj({ lint: plain() }),
        app: proj({ test: plain(['^build']) }, ['cart']),
      },
    },
    steps: [
      {
        run: 'test',
        projects: ['app'],
        expect: { exit: 0, ran: ['app#test'], notRan: ['web#build', 'cart#lint'] },
      },
    ],
  }),

  defineCase({
    id: 'graph/task-built-on-the-tree-not-run',
    category: 'graph',
    kind: 'efficiency',
    title: 'A task that depends on the requested builds is not run with them',
    why: 'Turborepo’s scheduler grew a `side-quest` cluster: a task depending on the build tree is not part of it.',
    from: GRAPH,
    workspace: {
      projects: {
        lib: proj({ build: plain(), side: plain(['build']) }),
        app: proj({ build: plain(['^build']), side: plain(['build', '^build']) }, ['lib']),
      },
    },
    steps: [
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['lib#build', 'app#build'],
          notRan: ['lib#side', 'app#side'],
        },
      },
    ],
  }),

  // ─── what dependsOn refuses ───────────────────────────────────────────

  defineCase({
    id: 'graph/unknown-project-task-edge-refused',
    category: 'graph',
    kind: 'correctness',
    title: 'dependsOn naming another project’s task that does not exist fails before any runs',
    why: 'An edge dropped in silence runs the task without what it said it needs.',
    from: GRAPH,
    workspace: {
      projects: {
        lib: proj({ build: plain() }),
        app: proj({ build: plain(['nope#build']) }),
      },
    },
    steps: [{ run: 'build', expect: { exit: 'fail', notRan: ['app#build', 'lib#build'] } }],
  }),

  defineCase({
    id: 'graph/unknown-same-project-dependency-refused',
    category: 'graph',
    kind: 'correctness',
    title: 'dependsOn naming a task its own project lacks fails before any runs',
    why: 'A misspelled same-project name (`lnt` for `lint`) is a typo; running without it skips the check.',
    from: GRAPH,
    workspace: app({ lint: plain(), test: plain(['lnt']) }),
    steps: [{ run: 'test', expect: { exit: 'fail', notRan: ['app#test', 'app#lint'] } }],
  }),

  defineCase({
    id: 'graph/caret-name-no-project-declares-refused',
    category: 'graph',
    kind: 'correctness',
    title: '`^biuld`, a name no project declares, fails the run instead of passing with no edge',
    why: 'A `^name` some project declares may have no holder here, but one nothing declares can only be a typo (nx#32779).',
    from: GRAPH,
    workspace: {
      projects: {
        cart: proj({ build: plain() }),
        app: proj({ typo: plain(['^biuld']) }, ['cart']),
      },
    },
    steps: [{ run: 'typo', expect: { exit: 'fail', notRan: ['app#typo', 'cart#build'] } }],
  }),

  defineCase({
    id: 'graph/task-cycle-through-four-projects-refused',
    category: 'graph',
    kind: 'correctness',
    title: '`^build` around a ring of four projects fails before any build runs',
    from: GRAPH,
    workspace: {
      projects: {
        lib1: proj({ build: plain(['^build']) }, ['lib2']),
        lib2: proj({ build: plain(['^build']) }, ['lib3']),
        lib3: proj({ build: plain(['^build']) }, ['lib4']),
        lib4: proj({ build: plain(['^build']) }, ['lib1']),
      },
    },
    steps: [
      {
        run: 'build',
        projects: ['lib1'],
        expect: { exit: 'fail', notRan: ['lib1#build', 'lib2#build', 'lib3#build', 'lib4#build'] },
      },
    ],
  }),

  defineCase({
    id: 'graph/task-cycle-through-taskless-refused',
    category: 'graph',
    kind: 'correctness',
    title: 'A `^build` ring that passes through a project without a build still fails',
    why: '`^build` reaches past a project without the task; around the ring each build then waits on itself.',
    from: GRAPH,
    workspace: {
      projects: {
        lib1: proj({ build: plain(['^build']) }, ['lib2']),
        lib2: proj({ build: plain(['^build']) }, ['lib3']),
        lib3: { deps: ['lib4'], tasks: {}, files: { 'src/a.txt': 'x\n' } },
        lib4: proj({ build: plain(['^build']) }, ['lib1']),
      },
    },
    steps: [
      {
        run: 'build',
        projects: ['lib1'],
        expect: { exit: 'fail', notRan: ['lib1#build', 'lib2#build', 'lib4#build'] },
      },
    ],
  }),

  defineCase({
    id: 'graph/package-ring-through-taskless-runs',
    category: 'graph',
    kind: 'correctness',
    title:
      'A package ring whose other projects declare no build is no task cycle: `^build` runs the build',
    why: 'Walking past the projects without a build leads back to the one that asked; it is no dependency of itself.',
    from: GRAPH,
    workspace: {
      projects: {
        lib1: proj({ build: plain(['^build']) }, ['lib2']),
        lib2: { deps: ['lib3'], tasks: {}, files: { 'src/a.txt': 'x\n' } },
        lib3: { deps: ['lib1'], tasks: {}, files: { 'src/a.txt': 'x\n' } },
      },
    },
    steps: [{ run: 'build', expect: { exit: 0, ran: ['lib1#build'] } }],
  }),

  defineCase({
    id: 'graph/package-cycle-below-a-holder-runs',
    category: 'graph',
    kind: 'correctness',
    title: 'A package cycle between a project with a build and one without orders and runs',
    why: 'app1’s build reaches app3’s through app2; app3’s walk back through app2 meets only itself.',
    from: GRAPH,
    workspace: {
      projects: {
        app3: proj({ build: plain(['^build']) }, ['app2']),
        app2: { deps: ['app3'], tasks: {}, files: { 'src/a.txt': 'x\n' } },
        app1: proj({ build: plain(['^build']) }, ['app2']),
      },
    },
    steps: [
      {
        run: 'build',
        projects: ['app1'],
        expect: {
          exit: 0,
          ran: ['app3#build', 'app1#build'],
          order: [['app3#build', 'app1#build']],
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/cycle-reached-through-another-task-refused',
    category: 'graph',
    kind: 'correctness',
    title: 'A cycle the requested task only leads into fails the run before any task runs',
    from: GRAPH,
    workspace: app({ a: plain(['b']), b: plain(['c']), c: plain(['b']) }),
    steps: [{ run: 'a', expect: { exit: 'fail', notRan: ['app#a', 'app#b', 'app#c'] } }],
  }),

  // ─── task-name patterns in dependsOn ──────────────────────────────────

  defineCase({
    id: 'graph/pattern-skips-the-declaring-task',
    category: 'graph',
    kind: 'correctness',
    title: '`build.*` on a task named `build.all` runs the other matches, not itself',
    why: 'The pattern matches its own name; read as an edge, that is a cycle the user never wrote.',
    from: GRAPH,
    needs: ['task-pattern'],
    workspace: app({
      'build.all': plain(['build.*']),
      'build.bin': plain(),
      'build.lib': plain(),
    }),
    steps: [
      {
        run: 'build.all',
        expect: {
          exit: 0,
          ran: ['app#build.bin', 'app#build.lib', 'app#build.all'],
          order: before(['app#build.bin', 'app#build.lib'], 'app#build.all'),
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/pattern-matching-nothing-runs',
    category: 'graph',
    kind: 'correctness',
    title: 'A dependsOn pattern that matches no task runs the task alone',
    why: 'A pattern names a family that may be empty here: a shared preset spreads `codegen.*` over projects with no codegen.',
    from: GRAPH,
    needs: ['task-pattern'],
    workspace: app({ test: plain(['codegen.*']) }),
    steps: [{ run: 'test', expect: { exit: 0, ran: ['app#test'] } }],
  }),

  defineCase({
    id: 'graph/caret-pattern-matching-nothing-runs',
    category: 'graph',
    kind: 'correctness',
    title: 'A `^` pattern no project’s task matches runs the task alone',
    from: GRAPH,
    needs: ['task-pattern'],
    workspace: {
      projects: {
        cart: proj({ build: plain() }),
        app: proj({ typo: plain(['^gen.*']) }, ['cart']),
      },
    },
    steps: [{ run: 'typo', expect: { exit: 0, ran: ['app#typo'], notRan: ['cart#build'] } }],
  }),

  defineCase({
    id: 'graph/caret-pattern-stops-at-nearest-holder',
    category: 'graph',
    kind: 'efficiency',
    title: '`^build.*` runs every match of the nearest dependency holding one, and stops there',
    from: GRAPH,
    needs: ['task-pattern'],
    workspace: {
      projects: {
        deeper: proj({ 'build.js': plain() }),
        lib: proj({ 'build.js': plain(), 'build.dts': plain(), lint: plain() }, ['deeper']),
        app: proj({ test: plain(['^build.*']) }, ['lib']),
      },
    },
    steps: [
      {
        run: 'test',
        projects: ['app'],
        expect: {
          exit: 0,
          ran: ['lib#build.js', 'lib#build.dts', 'app#test'],
          notRan: ['deeper#build.js', 'lib#lint'],
          order: before(['lib#build.js', 'lib#build.dts'], 'app#test'),
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/caret-pattern-through-taskless',
    category: 'graph',
    kind: 'correctness',
    title: '`^build.*` passes through a dependency with no match to the one beyond it',
    from: GRAPH,
    needs: ['task-pattern'],
    workspace: {
      projects: {
        deep: proj({ 'build.wasm': plain() }),
        bridge: proj({ lint: plain() }, ['deep']),
        app: proj({ test: plain(['^build.*']) }, ['bridge']),
      },
    },
    steps: [
      {
        run: 'test',
        projects: ['app'],
        expect: {
          exit: 0,
          ran: ['deep#build.wasm', 'app#test'],
          notRan: ['bridge#lint'],
          order: [['deep#build.wasm', 'app#test']],
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/caret-pattern-skips-own-project-on-package-cycle',
    category: 'graph',
    kind: 'correctness',
    title: '`^build.*` across a package cycle does not wrap back to the asking project’s own tasks',
    why: 'Walking a’s dependencies leads back to a; its own `build.inner` is no dependency’s task.',
    from: GRAPH,
    needs: ['task-pattern'],
    workspace: {
      projects: {
        a: proj({ build: plain(['^build.*']), 'build.inner': plain() }, ['b']),
        b: proj({ lint: plain() }, ['a']),
      },
    },
    steps: [
      {
        run: 'build',
        projects: ['a'],
        expect: { exit: 0, ran: ['a#build'], notRan: ['a#build.inner', 'b#lint'] },
      },
    ],
  }),

  defineCase({
    id: 'graph/pattern-dot-is-literal',
    category: 'graph',
    kind: 'correctness',
    title: 'The `.` in `build.x*` is a dot: it never matches `buildAx1`',
    from: GRAPH,
    needs: ['task-pattern'],
    workspace: app({ all: plain(['build.x*']), 'build.x1': plain(), buildAx1: plain() }),
    steps: [
      {
        run: 'all',
        expect: { exit: 0, ran: ['app#build.x1', 'app#all'], notRan: ['app#buildAx1'] },
      },
    ],
  }),

  defineCase({
    id: 'graph/pattern-and-exact-name-run-once',
    category: 'graph',
    kind: 'correctness',
    title: 'A task named both exactly and by a pattern in one dependsOn runs once',
    from: GRAPH,
    needs: ['task-pattern'],
    workspace: app({ top: plain(['build.a', 'build.*']), 'build.a': plain(), 'build.b': plain() }),
    steps: [
      {
        run: 'top',
        expect: {
          exit: 0,
          ran: ['app#build.a', 'app#build.b', 'app#top'],
          order: before(['app#build.a', 'app#build.b'], 'app#top'),
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/bracket-task-name-is-literal',
    category: 'graph',
    kind: 'correctness',
    title: 'A task named like a route, `t--src/app/[id]/page`, is one name in dependsOn',
    why: 'A name holding `[`, `]` or `/` was read as a pattern and linked nothing (nx#36498).',
    from: GRAPH,
    workspace: app({
      all: plain(['t--src/app/[id]/page']),
      't--src/app/[id]/page': plain(),
      't--src/app/i/page': plain(),
    }),
    steps: [
      {
        run: 'all',
        expect: {
          exit: 0,
          ran: ['app#t--src/app/[id]/page', 'app#all'],
          notRan: ['app#t--src/app/i/page'],
          order: [['app#t--src/app/[id]/page', 'app#all']],
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/bracket-in-pattern-is-literal',
    category: 'graph',
    kind: 'correctness',
    title: 'In `t--src/app/[id]/*` the brackets are characters, not a class',
    from: GRAPH,
    needs: ['task-pattern'],
    workspace: app({
      route: plain(['t--src/app/[id]/*']),
      't--src/app/[id]/page': plain(),
      't--src/app/i/page': plain(),
    }),
    steps: [
      {
        run: 'route',
        expect: {
          exit: 0,
          ran: ['app#t--src/app/[id]/page', 'app#route'],
          notRan: ['app#t--src/app/i/page'],
        },
      },
    ],
  }),

  // ─── task names a run is asked for ────────────────────────────────────

  defineCase({
    id: 'failure/object-property-task-name-refused',
    category: 'failure',
    kind: 'correctness',
    title: 'Asking for `constructor`, a task no project declares, fails the run',
    why: 'A name every object carries is still no task unless a config declares it.',
    from: GRAPH,
    workspace: app({ build: plain() }),
    steps: [{ run: 'constructor', expect: { exit: 'fail', notRan: ['app#build'] } }],
  }),

  defineCase({
    id: 'graph/object-property-task-name-runs',
    category: 'graph',
    kind: 'correctness',
    title: 'A task the config names `constructor` runs like any other',
    from: GRAPH,
    workspace: app({ constructor: { command: 'echo ran > ran.txt', inputs: ['src/**'] } }),
    steps: [
      {
        run: 'constructor',
        expect: { exit: 0, ran: ['app#constructor'], files: { 'packages/app/ran.txt': 'ran\n' } },
      },
    ],
  }),

  defineCase({
    id: 'graph/colon-task-caret-keys-dependant',
    category: 'graph',
    kind: 'correctness',
    title: '`^build:prod` runs the dependency’s `build:prod` first and reruns on its change',
    from: ['cli-task-names'],
    workspace: {
      projects: {
        b: {
          tasks: { 'build:prod': { command: CONCAT, inputs: ['src/**'], outputs: ['dist/**'] } },
          files: { 'src/a.txt': 'b1\n' },
        },
        a: {
          deps: ['b'],
          tasks: {
            'build:prod': {
              command: 'mkdir -p dist && cat ../b/dist/out.txt src/*.txt > dist/out.txt',
              dependsOn: ['^build:prod'],
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'a1\n' },
        },
      },
    },
    steps: [
      {
        run: 'build:prod',
        projects: ['a'],
        expect: {
          exit: 0,
          order: [['b#build:prod', 'a#build:prod']],
          files: { 'packages/a/dist/out.txt': 'b1\na1\n' },
        },
      },
      { write: { 'packages/b/src/a.txt': 'b2\n' } },
      {
        run: 'build:prod',
        projects: ['a'],
        expect: {
          exit: 0,
          ran: ['b#build:prod', 'a#build:prod'],
          files: { 'packages/a/dist/out.txt': 'b2\na1\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/multi-colon-task-name',
    category: 'graph',
    kind: 'correctness',
    title: 'A task named `a:b:c` runs as one name, not as `a` with more after it',
    from: ['cli-task-names'],
    workspace: app({
      'a:b:c': { command: 'echo abc > abc.txt', inputs: ['src/**'] },
      a: { command: 'echo a > a.txt', inputs: ['src/**'] },
    }),
    steps: [
      {
        run: 'a:b:c',
        expect: {
          exit: 0,
          ran: ['app#a:b:c'],
          notRan: ['app#a'],
          files: { 'packages/app/abc.txt': 'abc\n', 'packages/app/a.txt': null },
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/worktree-inside-adds-no-project',
    category: 'graph',
    kind: 'correctness',
    title: 'A git worktree checked out inside the workspace adds no project to a run',
    why: 'The worktree’s copies carry the same names; read as projects, they clash or build twice.',
    from: ['cli-task-names'],
    workspace: {
      projects: {
        a: {
          tasks: { build: { command: CONCAT, inputs: ['src/**'] } },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    steps: [
      { sh: 'git worktree add -q --detach .wt' },
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['a#build'],
          files: { 'packages/a/dist/out.txt': 'a\n', '.wt/packages/a/dist/out.txt': null },
        },
      },
    ],
  }),

  // ─── runs a Turborepo user relies on ──────────────────────────────────

  defineCase({
    id: 'cache/losing-cache-runs-the-task',
    category: 'cache',
    kind: 'correctness',
    title: 'A task switched to never cached runs, instead of replaying what it saved while cached',
    why: 'The user turned caching off for it; the entry from before is exactly what they no longer want (turborepo#1010).',
    from: ['parity-turbo'],
    needs: ['uncached-task'],
    workspace: app({
      build: { command: 'echo x >> runs.txt', inputs: ['src/**'], outputs: ['runs.txt'] },
    }),
    steps: [
      { run: 'build', expect: { exit: 0, files: { 'packages/app/runs.txt': 'x\n' } } },
      { run: 'build', expect: { exit: 0, notRan: ['app#build'] } },
      {
        configure: (ws) => ({
          ...ws,
          projects: {
            app: {
              ...ws.projects['app']!,
              tasks: { build: { command: 'echo x >> runs.txt', cache: false } },
            },
          },
        }),
      },
      { run: 'build', expect: { exit: 0, ran: ['app#build'] } },
    ],
  }),

  defineCase({
    id: 'outputs/uncached-dependant-restores-dependency',
    category: 'outputs',
    kind: 'correctness',
    title: 'An uncached task over a cached dependency finds the dependency’s deleted outputs back',
    why: 'Asked for by name, the uncached task skipped restoring its dependency’s outputs and read nothing (turborepo#6749).',
    from: ['parity-turbo'],
    needs: ['uncached-task'],
    workspace: app({
      build: {
        command: 'mkdir -p dist && cat src/a.txt > dist/out.txt',
        inputs: ['src/**'],
        outputs: ['dist/**'],
      },
      deploy: { command: 'cat dist/out.txt > deployed.txt', dependsOn: ['build'], cache: false },
    }),
    steps: [
      { run: 'deploy', expect: { exit: 0, files: { 'packages/app/deployed.txt': 'x\n' } } },
      { write: { 'packages/app/dist': null, 'packages/app/deployed.txt': null } },
      {
        run: 'deploy',
        expect: {
          exit: 0,
          ran: ['app#deploy'],
          files: { 'packages/app/dist/out.txt': 'x\n', 'packages/app/deployed.txt': 'x\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'cache/forwarded-args-key-the-task',
    category: 'cache',
    kind: 'correctness',
    title: 'A cached task run with other forwarded args runs again instead of replaying',
    why: 'The args change what the command does; the output saved for `--a` is wrong for `--b`.',
    from: ['parity-turbo'],
    workspace: app({
      show: {
        command: `mkdir -p dist && printf '<%s>' "$@" > dist/args.txt`,
        takesArgs: true,
        inputs: ['src/**'],
        outputs: ['dist/**'],
      },
    }),
    steps: [
      {
        run: 'show',
        projects: ['app'],
        args: ['--a'],
        expect: { exit: 0, files: { 'packages/app/dist/args.txt': '<--a>' } },
      },
      {
        run: 'show',
        projects: ['app'],
        args: ['--b'],
        expect: { exit: 0, ran: ['app#show'], files: { 'packages/app/dist/args.txt': '<--b>' } },
      },
    ],
  }),

  defineCase({
    id: 'graph/concurrency-one-runs-one-at-a-time',
    category: 'graph',
    kind: 'correctness',
    title: 'A concurrency of 1 runs independent tasks one at a time',
    from: ['parity-turbo', 'run-concurrency'],
    workspace: {
      projects: Object.fromEntries(
        ['p1', 'p2', 'p3'].map((p) => [
          p,
          {
            tasks: {
              t: {
                command:
                  'if [ -e ../../busy ]; then echo overlap >> ../../overlap.txt; fi; touch ../../busy; sleep 0.3; rm -f ../../busy',
                inputs: ['src/**'],
              },
            },
            files: { 'src/a.txt': `${p}\n` },
          },
        ]),
      ),
    },
    steps: [
      {
        run: 't',
        concurrency: 1,
        expect: { exit: 0, ran: ['p1#t', 'p2#t', 'p3#t'], files: { 'overlap.txt': null } },
      },
    ],
  }),

  defineCase({
    id: 'graph/select-dir-from-subdirectory',
    category: 'graph',
    kind: 'correctness',
    title: 'A directory selector selects the same projects from a subdirectory as from the root',
    why: 'A runner that read the path from where it ran, or added the project it ran in, selected differently by cwd (turborepo#11432, #11500).',
    from: ['parity-turbo'],
    needs: ['filter', 'select-dir', 'uncached-task'],
    workspace: {
      projects: Object.fromEntries(
        [
          ['apps', 'packages/apps'],
          ['x', 'packages/apps/x'],
          ['y', 'packages/apps/y'],
        ].map(([name, dir]) => [name, { dir, tasks: { lint: { command: 'true', cache: false } } }]),
      ),
    },
    steps: [
      {
        run: 'lint',
        select: [{ dir: 'packages/apps/*' }],
        expect: { exit: 0, ran: ['x#lint', 'y#lint'], notRan: ['apps#lint'] },
      },
      {
        run: 'lint',
        select: [{ dir: 'packages/apps/*' }],
        cwd: 'packages/apps',
        expect: { exit: 0, ran: ['x#lint', 'y#lint'], notRan: ['apps#lint'] },
      },
    ],
  }),

  // ─── stopping a run with servers and probes in flight ─────────────────

  ...(['SIGINT', 'SIGTERM'] as const).map((signal) =>
    defineCase({
      id: `failure/${signal.toLowerCase()}-reaches-ready-server-as-itself`,
      category: 'failure',
      kind: 'correctness',
      title: `${signal} to the run reaches a server past its ready line as ${signal}`,
      why: 'A server’s shutdown hook bound to one signal runs only if that signal arrives (turborepo#444, nx#23585).',
      from: ['signal-handling'],
      needs: ['persistent', 'ready'],
      workspace: app({
        dev: {
          command: `trap 'echo SIGINT > got.txt; exit 0' INT; trap 'echo SIGTERM > got.txt; exit 0' TERM; echo Listening on 1; touch up; ${LOOP}`,
          persistent: ready,
        },
      }),
      steps: [
        {
          run: 'dev',
          stop: { signal, when: 'packages/app/up' },
          expect: { files: { 'packages/app/got.txt': `${signal}\n` }, within: 30, alone: true },
        },
      ],
    }),
  ),

  defineCase({
    id: 'failure/sigterm-ends-a-ready-server-and-its-dependant',
    category: 'failure',
    kind: 'correctness',
    title: 'SIGTERM ends a run whose ready server and the task using it are both running',
    from: ['signal-handling'],
    needs: ['persistent', 'ready'],
    workspace: app({
      srv: { command: 'echo Listening on 1; sleep 60', persistent: ready },
      hold: { command: 'touch started; sleep 60', dependsOn: ['srv'], cache: false },
    }),
    steps: [
      {
        run: 'hold',
        stop: { signal: 'SIGTERM', when: 'packages/app/started' },
        expect: { exit: 'fail', ran: ['app#hold'], within: 20, alone: true },
      },
    ],
  }),

  defineCase({
    id: 'failure/sigterm-reaps-a-ready-server-child-that-ignores-it',
    category: 'failure',
    kind: 'correctness',
    title: 'SIGTERM ends the child of a ready server that traps TERM, INT and HUP',
    why: 'The child of a continuous task, trapping every signal it could get, outlived the stop (nx#33460, nx#32438).',
    from: ['signal-handling'],
    needs: ['persistent', 'ready'],
    workspace: app({
      srv: {
        command: `sh -c 'trap "" TERM INT HUP; exec sleep 60' & echo Listening on 1; wait`,
        persistent: ready,
      },
      hold: { command: 'touch started; sleep 60', dependsOn: ['srv'], cache: false },
    }),
    steps: [
      {
        run: 'hold',
        stop: { signal: 'SIGTERM', when: 'packages/app/started' },
        expect: { exit: 'fail', within: 30, alone: true },
      },
    ],
  }),

  defineCase({
    id: 'failure/stop-cleanup-of-a-ready-server-not-cut-short',
    category: 'failure',
    kind: 'correctness',
    title: 'One Ctrl-C lets a ready server finish its cleanup while its dependant is stopped',
    why: 'A server that reads a second signal as “force quit” skips its cleanup if the stop reaches it twice.',
    from: ['abort'],
    needs: ['persistent', 'ready'],
    workspace: app({
      srv: {
        command: `trap 'trap - INT TERM; sleep 0.3; echo done > clean.txt; exit 0' INT TERM; echo Listening on 1; ${LOOP}`,
        persistent: ready,
      },
      e2e: { command: 'touch started; sleep 60', dependsOn: ['srv'], cache: false },
    }),
    steps: [
      {
        run: 'e2e',
        stop: { signal: 'SIGINT', when: 'packages/app/started' },
        expect: { exit: 'fail', files: { 'packages/app/clean.txt': 'done\n' }, within: 20 },
      },
    ],
  }),

  defineCase({
    id: 'failure/stop-ends-a-runtime-probe',
    category: 'failure',
    kind: 'correctness',
    title: 'Ctrl-C while a command that keys a task is still running ends the run and the command',
    why: 'A probe left running held the stopped run open until it ended on its own.',
    from: ['abort'],
    needs: ['runtime-inputs'],
    workspace: app({
      t: {
        command: 'echo ran > ran.txt',
        inputs: ['src/**'],
        runtime: ['touch started; exec sleep 60'],
        outputs: [],
      },
    }),
    steps: [
      {
        run: 't',
        stop: { signal: 'SIGINT', when: 'started' },
        expect: {
          exit: 'fail',
          notRan: ['app#t'],
          files: { 'packages/app/ran.txt': null },
          within: 20,
          alone: true,
        },
      },
    ],
  }),
]
