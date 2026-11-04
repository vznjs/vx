import { defineCase } from '../src/spec.ts'
import { CONCAT, fourProjects, one, out } from './shapes.ts'

const cached = { command: CONCAT, inputs: ['src/**'], outputs: ['dist/**'] }

export default [
  defineCase({
    id: 'cache/uncached-runs-every-time',
    category: 'cache',
    kind: 'correctness',
    title: 'A task with caching off runs on every run',
    from: ['parity-turbo', 'uncached-no-lookup'],
    workspace: one({ command: 'echo live', inputs: ['src/**'], cache: false }),
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
    ],
  }),

  defineCase({
    id: 'cache/command-change-reruns',
    category: 'cache',
    kind: 'correctness',
    title: 'Changing a task’s command runs it again',
    from: ['parity-turbo-hashing-env', 'task-hash-derive'],
    workspace: one(cached),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      {
        configure: (ws) => ({
          ...ws,
          projects: {
            a: {
              ...ws.projects['a']!,
              tasks: { build: { ...cached, command: 'mkdir -p dist && echo v2 > dist/out.txt' } },
            },
          },
        }),
      },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'v2\n' } } },
    ],
  }),

  defineCase({
    id: 'cache/dependency-command-change-cascades',
    category: 'cache',
    kind: 'correctness',
    title: 'Changing a dependency’s command rebuilds the projects that read its output',
    from: ['parity-turbo-hashing-env', 'hash-chain'],
    workspace: fourProjects(),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      {
        configure: (ws) => {
          const lib = ws.projects['lib']!
          const build = {
            ...lib.tasks!['build']!,
            command: 'mkdir -p dist && echo LIB2 > dist/out.txt',
          }
          return { ...ws, projects: { ...ws.projects, lib: { ...lib, tasks: { build } } } }
        },
      },
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['lib#build', 'ui#build', 'app#build'],
          files: { [out('app')]: 'LIB2\nLIB2\nui\napp\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'cache/outputs-change-rekeys',
    category: 'cache',
    kind: 'correctness',
    title: 'Declaring a new output runs the task again so the cache holds it',
    why: 'An entry saved before the output was declared does not hold it; a hit would restore a tree without it.',
    from: ['parity-turbo', 'task-hash-derive', 'output-shape'],
    workspace: one({
      command: 'mkdir -p dist lib && cat src/a.txt > dist/out.txt && cat src/a.txt > lib/out.txt',
      inputs: ['src/**'],
      outputs: ['dist/**'],
    }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      {
        configure: (ws) => ({
          ...ws,
          projects: {
            a: {
              ...ws.projects['a']!,
              tasks: {
                build: { ...ws.projects['a']!.tasks!['build']!, outputs: ['dist/**', 'lib/**'] },
              },
            },
          },
        }),
      },
      { write: { 'packages/a/lib': null } },
      { run: 'build', expect: { exit: 0, files: { 'packages/a/lib/out.txt': 'a\n' } } },
    ],
  }),

  defineCase({
    id: 'cache/survives-checkout-copy',
    category: 'cache',
    kind: 'efficiency',
    title: 'Committing a change keeps the entry the uncommitted run saved',
    from: ['parity-turbo-hashing', 'hash-scenarios'],
    workspace: one(cached),
    steps: [
      { write: { 'packages/a/src/a.txt': 'edited\n' } },
      { run: 'build', expect: { exit: 0 } },
      { commit: 'edit' },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
    ],
  }),
]
