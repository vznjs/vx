import { defineCase } from '../src/spec.ts'
import { chainProject, fourProjects, out } from './shapes.ts'

export default [
  defineCase({
    id: 'graph/deps-first',
    category: 'graph',
    kind: 'correctness',
    title: '`^build` builds every dependency before the project that needs it',
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
    why: 'app reads lib’s output through mid; skipping lib leaves app reading nothing.',
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
