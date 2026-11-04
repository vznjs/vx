import { defineCase } from '../src/spec.ts'
import { chainProject, one, out } from './shapes.ts'

const failing = { command: 'echo failing-now && exit 3', inputs: ['src/**'], outputs: ['dist/**'] }

export default [
  defineCase({
    id: 'failure/exit-code-fails-run',
    category: 'failure',
    kind: 'correctness',
    title: 'A task that exits non-zero fails the run',
    why: 'A non-zero exit is how a command says it failed, and the run’s exit code is what CI and scripts read. A runner that reports success over a failed task lets a broken build merge and deploy. The task’s own output is shown so the developer can see what failed without running it again.',
    from: ['run-exit-codes', 'failure-mode'],
    workspace: one(failing),
    steps: [{ run: 'build', expect: { exit: 'fail', output: ['failing-now'] } }],
  }),

  defineCase({
    id: 'failure/never-cached',
    category: 'failure',
    kind: 'correctness',
    title: 'A failed task is not replayed as a success next time',
    why: 'Only a successful run is a result worth keeping. A stored failure would replay the same error without trying again, so a flaky test or a fixed environment could never pass. A failure saved as a pass would be worse: a broken build hidden behind a green run. So a failed task runs again every time.',
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
    why: 'A task that depends on another reads what that one produced. If the dependency failed, its output is missing or half written, and a dependant built on it either fails with a confusing second error or passes on stale files. Skipping the dependants keeps the first real error in front of the developer and saves the time spent building on a broken base.',
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
    why: 'A fix to an input is a new input, so the task must run again on it and succeed. A runner that remembered the failure by task name, not by input, would keep failing after the fix and push the user to wipe the cache. The output on disk is the one the passing run wrote.',
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
    why: 'A task killed by a signal never finished, so whatever it wrote is partial. Treating the death as success, or caching it, would replay half-written output as a green result on every later run. The run fails so CI sees it, and the next run tries the task again from scratch.',
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
    why: 'Many tools print warnings, progress and deprecation notes to stderr while succeeding. The exit code is the only contract a command makes about failure. A runner that failed on stderr output would break builds over harmless warnings and push users to silence useful diagnostics.',
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
    why: 'A task name no project declares is almost always a typo or a stale script. If the run exits 0 having run nothing, CI reports green while no test or build ran at all. Failing loudly turns the typo into a message the developer sees at once, instead of a gap found weeks later.',
    from: ['task-typo-verb', 'cli-task-names'],
    workspace: one({ command: 'echo hi', inputs: ['src/**'] }),
    steps: [{ run: 'biuld', expect: { exit: 'fail' } }],
  }),

  defineCase({
    id: 'failure/task-cycle-refused',
    category: 'failure',
    kind: 'correctness',
    title: 'Tasks that depend on each other in a cycle fail the run before any runs',
    why: 'A cycle has no valid order: each task waits on the other, so neither can correctly go first. Starting one anyway means it runs without the input it declared it needs. Refusing before anything runs points at the config mistake, rather than leaving a half-run graph or a run that waits forever.',
    from: ['default-build-cycle-key', 'task-graph'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: { command: 'echo build', inputs: ['src/**'], dependsOn: ['check'] },
            check: { command: 'echo check', inputs: ['src/**'], dependsOn: ['build'] },
          },
          files: { 'src/a.txt': 'a' },
        },
      },
    },
    steps: [{ run: 'build', expect: { exit: 'fail', notRan: ['a#build', 'a#check'] } }],
  }),
]
