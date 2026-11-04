import { defineCase } from '../src/spec.ts'
import { CONCAT, fourProjects, one, out } from './shapes.ts'

const cached = { command: CONCAT, inputs: ['src/**'], outputs: ['dist/**'] }

export default [
  defineCase({
    id: 'cache/uncached-runs-every-time',
    category: 'cache',
    kind: 'correctness',
    title: 'A task with caching off runs on every run',
    why: 'Turning caching off is an explicit request to run the command every time. Such tasks often have effects beyond their outputs, such as a deploy, a migration or a fetch of fresh data. Replaying one would skip that effect while reporting success. The cost of running again is the price the user chose.',
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
    why: 'The command produces the output as much as the source files do, so it is part of the key. Changing a flag or a script line and getting the old result back makes the edit look like it did nothing. A developer then debugs a config that is already right while the cache serves output from the old one.',
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
    why: 'A dependency’s new command produces new output, and projects built from that output must rebuild. If only the dependency reruns, its dependants keep the output they built from its previous result. The tree then holds a library built one way and an app built against the other, under a green run.',
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
    why: 'An entry saved before an output was declared does not hold that output, so it cannot be replayed as if it did. A hit here would restore a tree without the newly declared files, and anything that reads them fails or reads leftovers. Running once more stores the full set of outputs for later hits.',
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
    why: 'A cache entry belongs to the content a task reads, not to whether that content is committed. Running a build and then committing the same files changes nothing the task reads. Missing here would make every commit pay again for work done minutes before, which is most of the time a developer spends waiting.',
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
