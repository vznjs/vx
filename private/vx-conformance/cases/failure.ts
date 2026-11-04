import { defineCase } from '../src/spec.ts'
import { chainProject, one, out } from './shapes.ts'

const failing = { command: 'echo failing-now && exit 3', inputs: ['src/**'], outputs: ['dist/**'] }

export default [
  defineCase({
    id: 'failure/exit-code-fails-run',
    category: 'failure',
    kind: 'correctness',
    title: 'A task that exits non-zero fails the run',
    from: ['run-exit-codes', 'failure-mode'],
    workspace: one(failing),
    steps: [{ run: 'build', expect: { exit: 'fail', output: ['failing-now'] } }],
  }),

  defineCase({
    id: 'failure/never-cached',
    category: 'failure',
    kind: 'correctness',
    title: 'A failed task is not replayed as a success next time',
    from: ['parity-turbo', 'parity-nx', 'run-failures-store'],
    workspace: one(failing),
    steps: [
      { run: 'build', expect: { exit: 'fail' } },
      { run: 'build', expect: { exit: 'fail', ran: ['a#build'] } },
    ],
  }),

  defineCase({
    id: 'failure/dependents-skipped',
    category: 'failure',
    kind: 'correctness',
    title: 'A failed dependency stops the projects that need it from running',
    from: ['parity-turbo', 'parity-nx', 'continue-taint'],
    workspace: {
      projects: {
        lib: {
          tasks: { build: { ...failing, dependsOn: ['^build'] } },
          files: { 'src/a.txt': 'lib\n' },
        },
        app: chainProject('app', ['lib']),
      },
    },
    steps: [{ run: 'build', expect: { exit: 'fail', notRan: ['app#build'] } }],
  }),

  defineCase({
    id: 'failure/fixed-then-passes',
    category: 'failure',
    kind: 'correctness',
    title: 'Fixing a failed task’s input makes the next run pass and build',
    from: ['run-failures-store', 'failed-output-whole'],
    workspace: one(
      {
        command: 'mkdir -p dist && grep -q ok src/a.txt && cat src/a.txt > dist/out.txt',
        inputs: ['src/**'],
        outputs: ['dist/**'],
      },
      { 'src/a.txt': 'bad\n' },
    ),
    steps: [
      { run: 'build', expect: { exit: 'fail' } },
      { write: { 'packages/a/src/a.txt': 'ok\n' } },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'ok\n' } } },
    ],
  }),

  defineCase({
    id: 'failure/killed-by-signal',
    category: 'failure',
    kind: 'correctness',
    title: 'A task killed by a signal fails the run and is not cached',
    from: ['signal-death', 'failure-mode'],
    workspace: one({
      command: 'mkdir -p dist && echo partial > dist/out.txt && kill -9 $$',
      inputs: ['src/**'],
      outputs: ['dist/**'],
    }),
    steps: [
      { run: 'build', expect: { exit: 'fail' } },
      { run: 'build', expect: { exit: 'fail', ran: ['a#build'] } },
    ],
  }),

  defineCase({
    id: 'failure/stderr-is-not-failure',
    category: 'failure',
    kind: 'correctness',
    title: 'A task that writes to stderr and exits 0 succeeds',
    from: ['run-output', 'warnings-stderr'],
    workspace: one({
      command: 'echo warning >&2 && mkdir -p dist && cat src/a.txt > dist/out.txt',
      inputs: ['src/**'],
      outputs: ['dist/**'],
    }),
    steps: [{ run: 'build', expect: { exit: 0, files: { [out('a')]: 'a\n' } } }],
  }),

  defineCase({
    id: 'failure/missing-task-in-filter',
    category: 'failure',
    kind: 'correctness',
    title: 'Asking for a task no project declares fails the run',
    why: 'A typo that exits 0 lets CI pass having checked nothing.',
    from: ['task-typo-verb', 'cli-task-names'],
    workspace: one({ command: 'echo hi', inputs: ['src/**'] }),
    steps: [{ run: 'biuld', expect: { exit: 'fail' } }],
  }),
]
