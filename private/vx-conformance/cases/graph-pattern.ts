// dependsOn naming tasks by a `*` pattern (`lint.*`, `^build.*`): every
// matching task joins the graph, and the dependant keys on each.
import { defineCase, type TaskSpec } from '../src/spec.ts'

const FROM = ['wildcard-depends']

const write = (name: string, file: string): TaskSpec => ({
  command: `echo ${name} > ${file}`,
  inputs: ['src/**'],
})

export default [
  defineCase({
    id: 'graph/pattern-group',
    category: 'graph',
    kind: 'correctness',
    title: '`lint.*` in dependsOn runs every task it matches and none it does not',
    from: FROM,
    needs: ['task-pattern'],
    workspace: {
      projects: {
        app: {
          tasks: {
            lint: { command: 'true', dependsOn: ['lint.*'], inputs: ['src/**'] },
            'lint.a': write('LINT-A', 'a.txt'),
            'lint.b': write('LINT-B', 'b.txt'),
            build: write('BUILD', 'build.txt'),
          },
          files: { 'src/a.txt': 'x\n' },
        },
      },
    },
    steps: [
      {
        run: 'lint',
        expect: {
          exit: 0,
          ran: ['app#lint.a', 'app#lint.b', 'app#lint'],
          notRan: ['app#build'],
          order: [
            ['app#lint.a', 'app#lint'],
            ['app#lint.b', 'app#lint'],
          ],
          files: {
            'packages/app/a.txt': 'LINT-A\n',
            'packages/app/b.txt': 'LINT-B\n',
            'packages/app/build.txt': null,
          },
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/pattern-caret',
    category: 'graph',
    kind: 'correctness',
    title: '`^build.*` waits for every matching task of each dependency',
    from: FROM,
    needs: ['task-pattern'],
    workspace: {
      projects: {
        lib: {
          tasks: { 'build.js': write('JS', 'js.txt'), 'build.dts': write('DTS', 'dts.txt') },
          files: { 'src/a.txt': 'x\n' },
        },
        app: {
          deps: ['lib'],
          tasks: {
            test: {
              command: 'cat ../lib/js.txt ../lib/dts.txt > seen.txt',
              dependsOn: ['^build.*'],
              inputs: ['src/**'],
            },
          },
          files: { 'src/a.txt': 'x\n' },
        },
      },
    },
    steps: [
      {
        run: 'test',
        expect: {
          exit: 0,
          ran: ['lib#build.js', 'lib#build.dts', 'app#test'],
          order: [
            ['lib#build.js', 'app#test'],
            ['lib#build.dts', 'app#test'],
          ],
          files: { 'packages/app/seen.txt': 'JS\nDTS\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/pattern-dependency-change-reruns',
    category: 'graph',
    kind: 'correctness',
    title: 'A task on `build.*` reruns when a matched task’s input changes',
    why: 'top copies what build.x wrote; replaying it after build.x’s source changed ships the old bytes.',
    from: FROM,
    needs: ['task-pattern'],
    workspace: {
      projects: {
        app: {
          tasks: {
            'build.x': { command: 'cp src.txt out.txt', inputs: ['src.txt'], outputs: ['out.txt'] },
            top: {
              command: 'cp out.txt final.txt',
              dependsOn: ['build.*'],
              inputs: ['top-src.txt'],
              outputs: ['final.txt'],
            },
          },
          files: { 'src.txt': 'v1\n', 'top-src.txt': 'const\n' },
        },
      },
    },
    steps: [
      { run: 'top', expect: { exit: 0, files: { 'packages/app/final.txt': 'v1\n' } } },
      { write: { 'packages/app/src.txt': 'v2\n' } },
      {
        run: 'top',
        expect: { exit: 0, ran: ['app#top'], files: { 'packages/app/final.txt': 'v2\n' } },
      },
    ],
  }),

  ...(['*', '^*', '**'] as const).map((dep) =>
    defineCase({
      id: `config/bare-wildcard-${dep === '*' ? 'star' : dep === '^*' ? 'caret-star' : 'globstar'}-refused`,
      category: 'config',
      kind: 'correctness',
      title: `\`${dep}\` alone in dependsOn fails the run`,
      why: 'A pattern that matches every task makes the task wait on itself and everything else; the user meant a name.',
      from: FROM,
      needs: ['task-pattern'],
      workspace: {
        projects: {
          app: {
            tasks: {
              build: { command: 'echo x', dependsOn: [dep], inputs: ['src/**'] },
              other: { command: 'echo y', inputs: ['src/**'] },
            },
            files: { 'src/a.txt': 'x\n' },
          },
        },
      },
      steps: [{ run: 'build', expect: { exit: 'fail', notRan: ['app#build', 'app#other'] } }],
    }),
  ),
]
