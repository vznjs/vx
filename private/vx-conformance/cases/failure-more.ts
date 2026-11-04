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
    why: '`^build` means the build of each nearest dependency that has one, not every build further down. Here b’s own build declares no dependency on c’s build: c is in b’s package graph but not in this task graph. Running c’s build anyway does work nobody asked for, on every run.',
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
    why: '`^build` passes through dependencies that have no build to reach the builds beyond them. When two such paths lead to the same project, its build is still one task and runs once. Running it twice wastes time and can race two writers on the same output directory.',
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
    why: 'Each task that lists `^build` needs its dependencies built before it starts. When two tasks of one project both list it, each must wait, not only the first. If the second loses its edge, it reads the dependency half built and produces output from stale or missing files.',
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
    why: 'Every entry in a dependsOn list is a separate requirement. A runner that honours only the first entry, or lets one `^` entry stand for the others, starts the task before some of what it needs exists. The task then reads missing files, or old ones from an earlier run.',
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
    why: 'A project that declares no tasks still sits in the package graph. `^test` and `^lint` must each pass through it to the projects beyond that declare them, and the order they are listed in must not matter. Stopping at the empty project, or letting one name’s walk decide the other’s, runs the task before its real dependencies.',
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
    why: '`^build` asks for the builds of this project’s dependencies, and none of them has one. Some other project declares build, so the name is not a typo and the run should not fail. The task runs alone, and the unrelated project’s build is not pulled in.',
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
    why: 'A run builds what was asked for and what that needs, not what happens to depend on it. A task that depends on the build tree is a consumer of the builds, not part of them. Running it too adds work, and possibly side effects such as a deploy, that the user did not request.',
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
    why: 'A dependsOn entry is a promise that the named task runs first. If that task does not exist, the promise cannot be kept, and dropping the edge in silence runs the task without what it said it needs. Failing before anything runs points at the typo or the renamed task.',
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
    why: 'A same-project name the project does not declare, such as `lnt` for `lint`, is a typo. Running the task without it quietly skips the check the user meant to run first. Failing before any task runs shows the mistake in the config where it was made.',
    from: GRAPH,
    workspace: app({ lint: plain(), test: plain(['lnt']) }),
    steps: [{ run: 'test', expect: { exit: 'fail', notRan: ['app#test', 'app#lint'] } }],
  }),

  defineCase({
    id: 'graph/caret-name-no-project-declares-refused',
    category: 'graph',
    kind: 'correctness',
    title: '`^biuld`, a name no project declares, fails the run instead of passing with no edge',
    why: 'A `^name` some project declares may simply have no holder among this project’s dependencies, which is fine. A `^name` no project anywhere declares, like `^biuld`, can only be a typo. Passing the run with no edge hides that the dependency the user wanted is never built.',
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
    why: 'A ring of `^build` edges has no valid order: each build needs another that needs it back. Starting any of them means it reads its dependency’s output before that exists. Failing before any build runs names the cycle, instead of a run that hangs or builds from stale files.',
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
    why: '`^build` reaches past a project without a build to the builds beyond it. Around this ring that walk comes back to the start, so each build waits on itself through the empty project. It is a real cycle, and the run must refuse it before any build runs, as it would a direct one.',
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
    why: 'A cycle in the package graph is not a cycle in the task graph unless tasks close it. Here walking past the projects without a build leads back to the project that asked, and a task is never its own dependency. Refusing would break a valid repo over a package loop that holds no task cycle.',
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
    why: 'app1’s build reaches app3’s build through app2, which has none. app3’s own walk back through app2 meets only itself, so there is no task cycle. The builds have a valid order and run; refusing them would fail a repo over a package loop its tasks never close.',
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
    why: 'A cycle anywhere below the requested task makes its graph impossible to order, even if the task itself is not in the cycle. Starting what can start would leave the run stuck, or run tasks before their inputs exist. Failing before any task runs names the cycle so it can be fixed.',
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
    why: 'A pattern like `build.*` names the other tasks in its family. It also matches the name of the task that declares it, and read as an edge, that is a cycle the user never wrote. The declaring task is left out, so the pattern means what it plainly says.',
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
    why: 'A pattern names a family of tasks that may be empty in a given project. A shared preset can list `codegen.*` for every project, including ones with no codegen. Failing there would force each project to opt out by hand, so the task simply runs alone.',
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
    why: 'A `^` pattern names a family of tasks that dependencies may or may not have. When no project matches, there is nothing to wait for, and the task runs alone. Unlike an exact name nobody declares, a pattern that matches nothing is a normal case for shared config, not a typo.',
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
    why: '`^build.*` runs the matching tasks of the nearest dependency that has any, as `^build` does for one name. It runs every match there, since each may produce something the task needs. It does not reach further down, where the dependency’s own config decides what its tasks need.',
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
    why: 'A dependency with no matching task is a step on the way, not the end of the walk. `^build.*` passes through it to the project beyond that has matches, as an exact `^build` would. Stopping there would run the task before the build it needs, on missing or stale files.',
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
    why: '`^` means the tasks of dependencies, never of the asking project itself. Across a package cycle, walking a’s dependencies leads back to a, but its own `build.inner` is still no dependency’s task. Including it would add an edge the user never wrote and run work nobody asked for.',
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
    why: 'In a task pattern the `.` is a plain character; task names use it to group families like `build.x1`. Reading it as a regular-expression wildcard would also match `buildAx1` and run a task the pattern was never meant to reach. Only `*` is a wildcard.',
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
    why: 'A task named twice in one dependsOn, once exactly and once by a pattern, is still one task. It runs once, before the task that needs it. Running it twice wastes time and lets two copies race on the same outputs, so the result depends on which copy finishes last.',
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
    why: 'An exact name in dependsOn is matched as written, whatever characters it holds. Generated task names often follow file routes and contain `[`, `]` or `/`. Reading such a name as a pattern links the wrong task or none, and the dependant runs without what it needs.',
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
    why: 'Only `*` is a wildcard in a task pattern; brackets are plain characters. Routes like `src/app/[id]/page` are common in task names, and reading `[id]` as a character class would match `i/page` instead. The pattern then links the wrong task, and the one the user meant runs late or not at all.',
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
    why: 'A task exists only if a config declares it. A name every JavaScript object carries, like `constructor`, must not be found by accident in a lookup table. Otherwise the run would pass or crash on a task nobody declared, instead of reporting the unknown name.',
    from: GRAPH,
    workspace: app({ build: plain() }),
    steps: [{ run: 'constructor', expect: { exit: 'fail', notRan: ['app#build'] } }],
  }),

  defineCase({
    id: 'graph/object-property-task-name-runs',
    category: 'graph',
    kind: 'correctness',
    title: 'A task the config names `constructor` runs like any other',
    why: 'A task name is just a string, and `constructor` is as valid as `build`. A runner that keeps tasks in a plain object may confuse it with the object’s own property and fail or run the wrong thing. The declared task must run like any other.',
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
    why: 'Names with colons, like `build:prod`, are common for task variants and must work in `^` edges. The dependency’s `build:prod` runs first, and a change to its inputs reaches the dependant’s cache key. Otherwise the dependant could replay output built from the old dependency.',
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
    why: 'Some runners read a colon as a separator, such as between project and target. A task named `a:b:c` must still be one name, run as declared. Splitting it would run a different task, here `a`, and report a result for work nobody asked for.',
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
    why: 'A git worktree checked out inside the workspace holds copies of the same projects under the same names. Those copies are another checkout, not part of this workspace. Read as projects, they clash on names or build everything twice, and files from the other branch mix into this run.',
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
    why: 'When the user turns caching off for a task, the task must run every time. The entry saved while it was cached is exactly what they no longer want replayed. Replaying it would skip a task the user has marked as needing to run, such as one with side effects.',
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
    why: 'An uncached task still needs its cached dependencies’ outputs on disk. When those outputs were deleted and the dependency is a cache hit, the runner must restore them before the dependant runs. Otherwise the dependant reads nothing and fails, or ships an empty deploy.',
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
    why: 'Arguments passed through to a command change what it does. The output saved for `--a` is wrong for `--b`, so the args must be part of the cache key. Without that, a different command line replays the earlier result, and the user gets output for flags they did not pass.',
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
    id: 'graph/concurrency-one-serializes-tasks',
    category: 'graph',
    kind: 'correctness',
    title: 'A concurrency of 1 runs independent tasks one at a time',
    why: 'A concurrency of 1 is how a user says tasks must not overlap, often because they share a port, a database or a lot of memory. Independent tasks then run one at a time. Running two at once breaks that promise and causes failures that depend on timing.',
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
    why: 'A directory selector names paths in the workspace, so it means the same thing wherever the command runs. A runner that reads the path from the current directory, or adds the project it was started in, selects different projects by cwd. The same command then gives different results in a script and in a terminal.',
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

  ...(
    [
      [
        'SIGINT',
        'A server past its ready line should still receive Ctrl-C as SIGINT. Its shutdown hook is often bound to that one signal, to close connections and remove temp files. Forwarded as SIGTERM or SIGKILL, the hook never runs, and the server’s state is left behind while its dependants are torn down.',
      ],
      [
        'SIGTERM',
        'A ready server should receive a supervisor’s SIGTERM as SIGTERM. Servers bind their graceful shutdown, such as draining open connections, to that signal. Forwarded as another signal, that code is skipped, and requests in flight are cut off instead of drained while the run shuts down.',
      ],
    ] as const
  ).map(([signal, why]) =>
    defineCase({
      id: `failure/${signal.toLowerCase()}-reaches-ready-server-as-itself`,
      category: 'failure',
      kind: 'correctness',
      title: `${signal} to the run reaches a server past its ready line as ${signal}`,
      why,
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
    why: 'SIGTERM ends the whole run: every task in it, not only the one that started first. Here a ready server and the task using it are both running, and both must end. A run that stops one and waits on the other hangs the supervisor that asked it to stop.',
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
    why: 'A stop must end every process the run started, even a server’s child that traps TERM, INT and HUP. Without escalating to SIGKILL, that child outlives the run and keeps its port and its output pipe. The next run then fails to bind, or the current one never exits.',
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
    why: 'One Ctrl-C should reach a ready server once. Many servers read a second signal as a request to force quit and skip their cleanup. A runner that sends the stop twice, once to the group and once to the server, leaves lock files and temp state behind.',
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
    why: 'A command that computes part of a task’s key is part of the run and must end with it. If Ctrl-C leaves that probe running, the stopped run stays open until the probe finishes on its own. To the user, the run seems to ignore Ctrl-C.',
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
