import { defineCase } from '../src/spec.ts'
import { chainProject, fourProjects, out } from './shapes.ts'

export default [
  defineCase({
    id: 'graph/deps-first',
    category: 'graph',
    kind: 'correctness',
    title: '`^build` builds every dependency before the project that needs it',
    why: 'A project’s build reads what its dependencies built, so each dependency must finish first. Started early, app concatenates a lib or ui output that is missing or left over from an older build. The run can still exit 0, so the bad bundle ships without anyone seeing an error.',
    from: ['parity-turbo', 'parity-nx', 'graph-order'],
    workspace: fourProjects(),
    steps: [
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['lib#build', 'ui#build', 'app#build', 'docs#build'],
          order: [
            ['lib#build', 'ui#build'],
            ['ui#build', 'app#build'],
            ['lib#build', 'app#build'],
          ],
          files: { [out('app')]: 'lib\nlib\nui\napp\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/one-project-pulls-its-deps',
    category: 'graph',
    kind: 'correctness',
    title: "Running one project's task runs what it depends on, and nothing else",
    why: 'Asking for one project’s task means that task done right, which needs what it depends on built first. Skipping the dependencies builds ui on a missing or stale lib. Running unrelated projects as well spends CI minutes on work nobody asked for and can fail the run on code the user did not touch.',
    from: ['parity-turbo', 'parity-nx', 'task-selection'],
    needs: ['filter'],
    workspace: fourProjects(),
    steps: [
      {
        run: 'build',
        projects: ['ui'],
        expect: {
          exit: 0,
          ran: ['lib#build', 'ui#build'],
          notRan: ['app#build', 'docs#build'],
          order: [['lib#build', 'ui#build']],
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/same-project-dependency',
    category: 'graph',
    kind: 'correctness',
    title: 'A bare name in dependsOn waits on the same project’s task',
    why: 'A bare name in dependsOn points at a task in the same project, the usual way to say test needs build. If the runner ignores it or looks elsewhere, test reads a `dist` that is missing or from the last build. The test then passes or fails on old code, which is worse than no test.',
    from: ['parity-turbo', 'task-graph'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command: 'mkdir -p dist && cp src/a.txt dist/a.txt',
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
            test: {
              command: 'cat dist/a.txt > tested.txt',
              dependsOn: ['build'],
              inputs: ['src/**'],
            },
          },
          files: { 'src/a.txt': 'built\n' },
        },
      },
    },
    steps: [
      {
        run: 'test',
        expect: {
          exit: 0,
          ran: ['a#build', 'a#test'],
          order: [['a#build', 'a#test']],
          files: { 'packages/a/tested.txt': 'built\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/explicit-task-edge',
    category: 'graph',
    kind: 'correctness',
    title: '`lib#build` in dependsOn runs that task first, with no package dependency',
    why: 'An edge like `lib#build` states an order the package manifests do not show. site publishes lib’s output, so lib must be built first even though site does not list lib as a dependency. Ignoring the edge publishes a missing or stale file, and the order would hold only by luck of timing.',
    from: ['parity-turbo', 'parity-nx', 'task-edge-selection'],
    workspace: {
      projects: {
        lib: chainProject('lib'),
        site: {
          tasks: {
            publish: {
              command: 'cat ../lib/dist/out.txt > published.txt',
              dependsOn: ['lib#build'],
              inputs: ['src/**'],
            },
          },
          files: { 'src/a.txt': 'site\n' },
        },
      },
    },
    steps: [
      {
        run: 'publish',
        expect: {
          exit: 0,
          ran: ['lib#build', 'site#publish'],
          order: [['lib#build', 'site#publish']],
          files: { 'packages/site/published.txt': 'lib\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/diamond-runs-once',
    category: 'graph',
    kind: 'efficiency',
    title: 'A dependency two projects share builds once per run',
    why: 'When two projects depend on the same library, one run needs that library built only once. Building it twice wastes time, and a second build can rewrite files while the first consumer is reading them. Each task in a run is one unit of work, however many paths lead to it.',
    from: ['scheduler', 'task-graph-properties'],
    workspace: fourProjects(),
    steps: [
      {
        run: 'build',
        projects: ['app'],
        expect: { exit: 0, ran: ['lib#build', 'ui#build', 'app#build'] },
      },
      // The marks hold one start per execution; a second lib start would show twice.
    ],
  }),

  defineCase({
    id: 'graph/transitive-through-taskless',
    category: 'graph',
    kind: 'correctness',
    title: '`^build` reaches a dependency’s dependency when the middle project has no build',
    why: 'app reads lib’s output, reached through mid, which has no build of its own. A project without the task does not cut the chain; its own dependencies still have to be built. Stopping at mid leaves app reading a missing or stale lib, and the build of app still exits 0.',
    from: ['parity-turbo', 'graph-pipeline-properties'],
    workspace: {
      projects: {
        lib: chainProject('lib'),
        mid: { deps: ['lib'], tasks: {}, files: { 'src/a.txt': 'mid\n' } },
        app: {
          deps: ['mid'],
          tasks: {
            build: {
              command: 'mkdir -p dist && cat ../lib/dist/out.txt src/a.txt > dist/out.txt',
              dependsOn: ['^build'],
              inputs: ['src/**'],
              outputs: ['dist/**'],
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
        expect: { exit: 0, ran: ['lib#build', 'app#build'], order: [['lib#build', 'app#build']] },
      },
    ],
  }),

  defineCase({
    id: 'graph/dependents-not-pulled',
    category: 'graph',
    kind: 'efficiency',
    title: 'Running a library’s task does not run the projects that depend on it',
    why: 'Dependencies run first because the task needs them; dependents do not, because the task does not read them. Building lib should not rebuild ui and app, which only consume lib. Pulling them in turns a quick library build into a workspace build and can fail it on code the user never asked to touch.',
    from: ['task-selection', 'select'],
    needs: ['filter'],
    workspace: fourProjects(),
    steps: [
      {
        run: 'build',
        projects: ['lib'],
        expect: { exit: 0, ran: ['lib#build'], notRan: ['ui#build', 'app#build'] },
      },
    ],
  }),

  defineCase({
    id: 'graph/task-in-some-projects',
    category: 'graph',
    kind: 'correctness',
    title: 'A task only some projects declare runs in exactly those',
    why: 'Running a task by name runs it where it is declared and nowhere else. A project without that task has nothing to run, and should not be swapped for some other task it does have. Running `build` in place of a missing `lint` does work nobody asked for and reports it as lint.',
    from: ['task-selection', 'bare-name-default-build'],
    workspace: {
      projects: {
        a: {
          tasks: { lint: { command: 'echo lint-a', inputs: ['src/**'] } },
          files: { 'src/a.txt': 'a' },
        },
        b: {
          tasks: { build: { command: 'echo build-b', inputs: ['src/**'] } },
          files: { 'src/a.txt': 'b' },
        },
      },
    },
    steps: [{ run: 'lint', expect: { exit: 0, ran: ['a#lint'], notRan: ['b#build'] } }],
  }),

  defineCase({
    id: 'graph/project-dir-with-spaces',
    category: 'graph',
    kind: 'correctness',
    title: 'A project whose directory holds spaces builds, caches and restores',
    why: 'A directory name with spaces is a valid path and must work like any other. A runner that splits paths on spaces misses inputs, writes outputs to the wrong place or fails to restore them. The project then looks cached while its `dist` stays empty, or never caches at all.',
    from: ['parity-nx', 'workspace-path-chars'],
    workspace: {
      projects: {
        lib: chainProject('lib', [], { dir: 'packages/my lib' }),
      },
    },
    steps: [
      {
        run: 'build',
        expect: { exit: 0, ran: ['lib#build'], files: { 'packages/my lib/dist/out.txt': 'lib\n' } },
      },
      { write: { 'packages/my lib/dist': null } },
      {
        run: 'build',
        expect: {
          exit: 0,
          notRan: ['lib#build'],
          files: { 'packages/my lib/dist/out.txt': 'lib\n' },
        },
      },
      { write: { 'packages/my lib/src/a.txt': 'changed\n' } },
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['lib#build'],
          files: { 'packages/my lib/dist/out.txt': 'changed\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/task-name-with-colon',
    category: 'graph',
    kind: 'correctness',
    title: 'A task named `test:unit` runs as its own task',
    why: 'A colon is a common part of task names such as `test:unit`, not a separator the runner may reinterpret. Reading it as project and task, or as a prefix of `test`, runs the wrong command. The user asked for unit tests and gets the whole suite, or nothing, under the same green exit.',
    from: ['parity-nx', 'cli-task-names'],
    workspace: {
      projects: {
        a: {
          tasks: {
            'test:unit': { command: 'echo unit-ran', inputs: ['src/**'] },
            test: { command: 'echo plain-test', inputs: ['src/**'] },
          },
          files: { 'src/a.txt': 'a' },
        },
      },
    },
    steps: [{ run: 'test:unit', expect: { exit: 0, ran: ['a#test:unit'], notRan: ['a#test'] } }],
  }),
]
