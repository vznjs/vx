// The task graph dependsOn describes: which tasks a run reaches, in what
// order, across project names, directories and package cycles.
import { defineCase, type ProjectSpec, type TaskSpec } from '../src/spec.ts'
import { chainBuild, chainProject, out } from './shapes.ts'

const GRAPH = ['task-graph-properties', 'graph-pipeline-properties']

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

export default [
  defineCase({
    id: 'graph/caret-names-other-task',
    category: 'graph',
    kind: 'correctness',
    title: '`^gen` runs the dependencies’ gen first, and not their build',
    why: '`^gen` asks for one specific task in each dependency, here the code generation app reads. Running lib’s build in its place leaves `gen/g.txt` missing or stale, and app builds on it. Running both wastes time on a build nobody asked for; the caret names a task, not a whole project.',
    from: GRAPH,
    workspace: {
      projects: {
        lib: {
          tasks: {
            gen: { command: 'mkdir -p gen && cat src/a.txt > gen/g.txt', inputs: ['src/**'] },
            build: plain(),
          },
          files: { 'src/a.txt': 'lib\n' },
        },
        app: {
          deps: ['lib'],
          tasks: {
            build: {
              command: 'mkdir -p dist && cat ../lib/gen/g.txt > dist/out.txt',
              dependsOn: ['^gen'],
              inputs: ['src/**'],
            },
          },
          files: { 'src/a.txt': 'app\n' },
        },
      },
    },
    steps: [
      {
        run: 'build',
        projects: ['app'],
        expect: {
          exit: 0,
          ran: ['lib#gen', 'app#build'],
          notRan: ['lib#build'],
          order: [['lib#gen', 'app#build']],
          files: { [out('app')]: 'lib\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/caret-dependency-without-task',
    category: 'graph',
    kind: 'correctness',
    title: '`^build` over a dependency that declares no build runs the project alone',
    why: '`^build` means build each dependency that has a build. A dependency without one has nothing to wait for, so the project runs on its own. Failing the run would make every project declare an empty build, and running some other task of lib in its place does work nobody asked for.',
    from: GRAPH,
    workspace: {
      projects: {
        lib: proj({ lint: plain() }),
        app: proj({ build: plain(['^build']) }, ['lib']),
      },
    },
    steps: [{ run: 'build', expect: { exit: 0, ran: ['app#build'], notRan: ['lib#lint'] } }],
  }),

  defineCase({
    id: 'graph/deep-chain-order',
    category: 'graph',
    kind: 'correctness',
    title: 'A five-project chain builds strictly from the bottom up',
    why: 'Each project in the chain reads the one below it, so the order must hold at every step, not only the first. If any build starts early it reads a missing or older output, and the error carries silently up to the top. A long chain is where a scheduler that only checks direct edges or races ahead shows it.',
    from: ['scheduler', 'scheduler-properties'],
    workspace: {
      projects: {
        p1: chainProject('p1'),
        p2: chainProject('p2', ['p1']),
        p3: chainProject('p3', ['p2']),
        p4: chainProject('p4', ['p3']),
        p5: chainProject('p5', ['p4']),
      },
    },
    steps: [
      {
        run: 'build',
        projects: ['p5'],
        expect: {
          exit: 0,
          order: [
            ['p1#build', 'p2#build'],
            ['p2#build', 'p3#build'],
            ['p3#build', 'p4#build'],
            ['p4#build', 'p5#build'],
          ],
          files: { [out('p5')]: 'p1\np2\np3\np4\np5\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/two-roots-shared-leaf',
    category: 'graph',
    kind: 'correctness',
    title: 'Two selected projects over one dependency build it once, before both',
    why: 'Two selected projects that share a dependency need it built once, and before either of them. Building it twice wastes time and can rewrite its output while one of them reads it. Starting either project before the shared build finishes gives it a missing or stale input.',
    from: ['scheduler', 'scheduler-properties'],
    needs: ['filter'],
    workspace: {
      projects: {
        lib: chainProject('lib'),
        x: chainProject('x', ['lib']),
        y: chainProject('y', ['lib']),
      },
    },
    steps: [
      {
        run: 'build',
        projects: ['x', 'y'],
        expect: {
          exit: 0,
          ran: ['lib#build', 'x#build', 'y#build'],
          order: [
            ['lib#build', 'x#build'],
            ['lib#build', 'y#build'],
          ],
          files: { [out('x')]: 'lib\nx\n', [out('y')]: 'lib\ny\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/same-and-caret',
    category: 'graph',
    kind: 'correctness',
    title: '`test` on `build` and `^build` waits for both the project’s and its dependency’s build',
    why: 'Two edges on one task both have to hold: the project’s own build and its dependency’s build. Honouring only one lets test start while the other build is still writing, so it checks a missing or half-written output. The test result then says nothing reliable about the code.',
    from: GRAPH,
    workspace: {
      projects: {
        lib: chainProject('lib'),
        app: chainProject('app', ['lib'], {
          tasks: {
            test: {
              command: 'cat dist/out.txt > tested.txt',
              dependsOn: ['build', '^build'],
              inputs: ['src/**'],
            },
          },
        }),
      },
    },
    steps: [
      {
        run: 'test',
        expect: {
          exit: 0,
          ran: ['lib#build', 'app#build', 'app#test'],
          order: [
            ['lib#build', 'app#build'],
            ['app#build', 'app#test'],
            ['lib#build', 'app#test'],
          ],
          files: { 'packages/app/tested.txt': 'lib\napp\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/selected-dependency-ordered',
    category: 'graph',
    kind: 'correctness',
    title: 'Selecting a project and its dependency runs the dependency once, first',
    why: 'Selecting a dependency by name does not make it independent of the project that needs it. lib must still build once and before app, as it would if only app were asked for. Running it twice or alongside app wastes time and lets app read a missing or stale lib.',
    from: ['exclude-dependencies-key', 'scheduler'],
    needs: ['filter'],
    workspace: { projects: { lib: chainProject('lib'), app: chainProject('app', ['lib']) } },
    steps: [
      {
        run: 'build',
        projects: ['app', 'lib'],
        expect: {
          exit: 0,
          ran: ['lib#build', 'app#build'],
          order: [['lib#build', 'app#build']],
          files: { [out('app')]: 'lib\napp\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/name-differs-from-dir',
    category: 'graph',
    kind: 'correctness',
    title: '`^build` follows a dependency by package name when its directory is named otherwise',
    why: 'Projects depend on each other by package name, and the directory a package lives in can be named anything. Matching dependencies by directory name drops the edge from app to ui. app then builds before ui, or on an old ui, and the run still exits 0.',
    from: ['package-graph', 'project-dirs'],
    workspace: {
      projects: {
        ui: chainProject('ui', [], { dir: 'packages/frontend' }),
        app: {
          deps: ['ui'],
          tasks: {
            build: {
              ...chainBuild([]),
              command: 'mkdir -p dist && cat ../frontend/dist/out.txt src/*.txt > dist/out.txt',
            },
          },
          files: { 'src/a.txt': 'app\n' },
        },
      },
    },
    steps: [
      {
        run: 'build',
        projects: ['app'],
        expect: {
          exit: 0,
          ran: ['ui#build', 'app#build'],
          order: [['ui#build', 'app#build']],
          files: { [out('app')]: 'ui\napp\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/scoped-explicit-edge',
    category: 'graph',
    kind: 'correctness',
    title: '`@acme/core#build` in dependsOn runs that scoped project’s build first',
    why: 'Scoped names such as `@acme/core` are ordinary package names and must work in an explicit edge. A runner that misreads the `@` or the `/` cannot find the task and either fails or drops the edge. Dropping it lets site build first and copy a missing or stale core output.',
    from: ['package-graph', 'filter'],
    workspace: {
      projects: {
        '@acme/core': chainProject('core', [], { dir: 'packages/core' }),
        site: {
          tasks: {
            build: {
              command: 'cat ../core/dist/out.txt > site.txt',
              dependsOn: ['@acme/core#build'],
              inputs: ['src/**'],
            },
          },
          files: { 'src/a.txt': 'site\n' },
        },
      },
    },
    steps: [
      {
        run: 'build',
        projects: ['site'],
        expect: {
          exit: 0,
          ran: ['@acme/core#build', 'site#build'],
          order: [['@acme/core#build', 'site#build']],
          files: { 'packages/site/site.txt': 'core\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/nested-project-own-task',
    category: 'graph',
    kind: 'correctness',
    title: 'A project nested in another runs its own task in its own directory',
    why: 'A project inside another project’s directory is still its own project with its own task. Running it from the outer directory, or folding it into the outer project, writes outputs to the wrong place or skips it. Each task must run where its project lives, or its paths mean something else.',
    from: ['project-dirs', 'exclude-dependencies-key'],
    workspace: {
      projects: {
        lib: chainProject('lib'),
        inner: chainProject('inner', [], { dir: 'packages/lib/inner' }),
      },
    },
    steps: [
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['lib#build', 'inner#build'],
          files: {
            [out('lib')]: 'lib\n',
            'packages/lib/inner/dist/out.txt': 'inner\n',
          },
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/package-cycle-without-task-edges',
    category: 'graph',
    kind: 'correctness',
    title: 'Projects that depend on each other run a task that names no dependency',
    why: 'Packages that depend on each other form a cycle only for tasks that wait on dependencies. A task that names no dependency has no order to keep, so nothing stops it. Refusing the run would block checks like lint in any workspace with a package cycle, for no reason the tasks give.',
    from: ['package-graph', 'filter'],
    workspace: {
      projects: {
        a: proj({ check: plain() }, ['b']),
        b: proj({ check: plain() }, ['a']),
      },
    },
    steps: [{ run: 'check', expect: { exit: 0, ran: ['a#check', 'b#check'] } }],
  }),

  defineCase({
    id: 'graph/package-cycle-caret-refused',
    category: 'graph',
    kind: 'correctness',
    title: '`^build` across projects that depend on each other fails before any build runs',
    why: 'When each build waits on the other, no order is right: whichever runs first builds on a dependency not built yet. Running anyway gives an output that depends on timing and is never reproducible. Failing before any build runs names the cycle so the user can break it.',
    from: GRAPH,
    workspace: {
      projects: {
        a: proj({ build: plain(['^build']) }, ['b']),
        b: proj({ build: plain(['^build']) }, ['a']),
      },
    },
    steps: [{ run: 'build', expect: { exit: 'fail', notRan: ['a#build', 'b#build'] } }],
  }),

  defineCase({
    id: 'graph/package-names-itself',
    category: 'graph',
    kind: 'correctness',
    title: 'A project listing itself as a dependency is no cycle: `^build` runs its build',
    why: 'A package cannot be its own dependency, so a self entry in its manifest orders nothing. Treating it as a cycle fails a run that has a clear and valid order. The right reading ignores the self edge and runs the build once. A package that lists itself is a common slip in a manifest, and it should not block every build of that package.',
    from: ['package-graph'],
    workspace: { projects: { a: proj({ build: plain(['^build']) }, ['a']) } },
    steps: [{ run: 'build', expect: { exit: 0, ran: ['a#build'] } }],
  }),

  defineCase({
    id: 'graph/cross-project-cycle-refused',
    category: 'graph',
    kind: 'correctness',
    title: 'Two projects’ tasks naming each other fail the run before either runs',
    why: 'Two tasks that each wait on the other can never both run after their dependency. Running them anyway breaks the order the user wrote, so one of them reads a missing or stale output. Failing before either runs points at the cycle instead of producing a build that depends on timing.',
    from: GRAPH,
    workspace: {
      projects: {
        a: proj({ build: plain(['b#build']) }),
        b: proj({ build: plain(['a#build']) }),
      },
    },
    steps: [{ run: 'build', expect: { exit: 'fail', notRan: ['a#build', 'b#build'] } }],
  }),

  defineCase({
    id: 'graph/self-dependency-refused',
    category: 'graph',
    kind: 'correctness',
    title: 'A task that depends on itself fails the run',
    why: 'A task cannot run after itself, so a self dependency is a mistake in the config. Running the task anyway hides that mistake and ignores an order the user wrote, perhaps meaning another task. Failing the run makes the bad edge visible while it is cheap to fix.',
    from: GRAPH,
    workspace: { projects: { a: proj({ build: plain(['build']) }) } },
    steps: [{ run: 'build', expect: { exit: 'fail', notRan: ['a#build'] } }],
  }),

  defineCase({
    id: 'graph/peer-workspace-dependency-orders-and-keys',
    category: 'graph',
    kind: 'correctness',
    title:
      'A workspace package named only as a peer is built first, and an edit to it runs the consumer again',
    why: 'The workspace links the peer in, so the consumer’s build reads it as it reads any dependency. Naming it as a peer only changes who installs it outside the workspace. Building the consumer first, or replaying it after the peer changed, leaves it built against code that is no longer there.',
    from: ['parity-turbo', 'vx-lockfile/discover'],
    workspace: {
      projects: {
        lib: chainProject('lib'),
        app: {
          tasks: { build: chainBuild(['lib']) },
          files: {
            'src/a.txt': 'app\n',
            'package.json': JSON.stringify({
              name: 'app',
              version: '0.0.0',
              private: true,
              peerDependencies: { lib: 'workspace:*' },
            }),
          },
        },
      },
    },
    steps: [
      {
        run: 'build',
        projects: ['app'],
        expect: { exit: 0, files: { [out('app')]: 'lib\napp\n' } },
      },
      { write: { 'packages/lib/src/a.txt': 'lib2\n' } },
      {
        run: 'build',
        projects: ['app'],
        expect: {
          exit: 0,
          ran: ['lib#build', 'app#build'],
          files: { [out('app')]: 'lib2\napp\n' },
        },
      },
    ],
  }),
]
