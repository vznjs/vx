// How a run is asked to treat failures and the cache, beyond what it runs:
// going on past a failure, ignoring or only reading the cache, planning
// without running, a variable that reaches a task without keying it, a
// dependency that orders a task without keying it, and a second checkout
// of the same repository.
import { defineCase } from '../src/spec.ts'
import { CONCAT, chainProject, one, out } from './shapes.ts'

const cached = { command: CONCAT, inputs: ['src/**'], outputs: ['dist/**'] }

export default [
  defineCase({
    id: 'failure/continue-runs-past-a-failure',
    category: 'failure',
    kind: 'correctness',
    title: 'Asked to continue, a run goes on past a failed task and still fails',
    why: 'Going on is what the user asked for; a green exit would hide the failure.',
    from: ['continue-taint', 'parity-turbo'],
    needs: ['continue'],
    workspace: {
      projects: {
        lib: {
          tasks: { build: { command: 'exit 1', inputs: ['src/**'], outputs: [] } },
          files: { 'src/a.txt': 'lib\n' },
        },
        app: {
          deps: ['lib'],
          tasks: {
            build: { command: 'echo app', dependsOn: ['^build'], inputs: ['src/**'], outputs: [] },
          },
          files: { 'src/a.txt': 'app\n' },
        },
      },
    },
    steps: [
      { run: 'build', continue: true, expect: { exit: 'fail', ran: ['lib#build', 'app#build'] } },
    ],
  }),

  defineCase({
    id: 'failure/continue-saves-nothing-built-on-a-failure',
    category: 'failure',
    kind: 'correctness',
    title:
      'A task that ran past its dependency’s failure is not replayed once the dependency is fixed',
    why: 'It was built on a failed dependency: replaying it would keep that result after the fix.',
    from: ['continue-taint', 'continue-cache-properties'],
    needs: ['continue'],
    workspace: {
      projects: {
        lib: chainProject('lib', [], {
          tasks: {
            build: {
              command:
                'mkdir -p dist && cat src/a.txt > dist/out.txt && ! grep -q broken src/a.txt',
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'broken\n' },
        }),
        app: chainProject('app', ['lib']),
      },
    },
    steps: [
      { run: 'build', continue: true, expect: { exit: 'fail', ran: ['lib#build', 'app#build'] } },
      { write: { 'packages/lib/src/a.txt': 'fixed\n' } },
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['lib#build', 'app#build'],
          files: { [out('app')]: 'fixed\napp\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'cache/force-runs-and-refreshes',
    category: 'cache',
    kind: 'correctness',
    title:
      'A forced run runs every task past its cache entry, and the next run replays what it saved',
    from: ['parity-turbo', 'parity-nx', 'cli'],
    needs: ['force'],
    workspace: one(cached),
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      {
        run: 'build',
        force: true,
        expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'a\n' } },
      },
      { write: { 'packages/a/dist/out.txt': null } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'], files: { [out('a')]: 'a\n' } } },
    ],
  }),

  defineCase({
    id: 'cache/read-only-replays-and-saves-nothing',
    category: 'cache',
    kind: 'correctness',
    title: 'A run that only reads the cache replays a hit, and saves nothing for a miss',
    from: ['download-policy', 'parity-turbo'],
    needs: ['read-only-cache'],
    workspace: one(cached),
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { run: 'build', readOnlyCache: true, expect: { exit: 0, notRan: ['a#build'] } },
      { write: { 'packages/a/src/a.txt': 'b\n' } },
      { run: 'build', readOnlyCache: true, expect: { exit: 0, ran: ['a#build'] } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
    ],
  }),

  defineCase({
    id: 'cache/dry-run-runs-and-saves-nothing',
    category: 'cache',
    kind: 'correctness',
    title: 'A planned run runs no task, writes no output, and saves nothing',
    from: ['dry-json-stdout', 'parity-turbo'],
    needs: ['dry-run'],
    workspace: one(cached),
    steps: [
      {
        run: 'build',
        dry: true,
        expect: { exit: 0, notRan: ['a#build'], files: { [out('a')]: null } },
      },
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
    ],
  }),

  defineCase({
    id: 'env/pass-through-reaches-task',
    category: 'env',
    kind: 'correctness',
    title: 'A variable passed through reaches the task',
    from: ['env', 'parity-turbo'],
    needs: ['pass-through-env'],
    workspace: one({
      command: 'mkdir -p dist && printf %s "$MODE" > dist/out.txt',
      inputs: ['src/**'],
      outputs: ['dist/**'],
      passThrough: ['MODE'],
    }),
    steps: [
      { run: 'build', env: { MODE: 'prod' }, expect: { exit: 0, files: { [out('a')]: 'prod' } } },
    ],
  }),

  defineCase({
    id: 'env/pass-through-change-replays',
    category: 'env',
    kind: 'efficiency',
    title: 'A change to a variable passed through, not keyed, replays the task',
    from: ['env', 'parity-turbo-hashing-env'],
    needs: ['pass-through-env'],
    workspace: one({
      command: 'mkdir -p dist && echo built > dist/out.txt && printf %s "$CI_RUN" > /dev/null',
      inputs: ['src/**'],
      outputs: ['dist/**'],
      passThrough: ['CI_RUN'],
    }),
    steps: [
      { run: 'build', env: { CI_RUN: '1' }, expect: { exit: 0, ran: ['a#build'] } },
      { run: 'build', env: { CI_RUN: '2' }, expect: { exit: 0, notRan: ['a#build'] } },
    ],
  }),

  defineCase({
    id: 'inputs/dependency-inputs-off-replays',
    category: 'inputs',
    kind: 'efficiency',
    title:
      'A task ordered after a dependency, but not keyed on it, replays when only the dependency changes',
    from: ['parity-nx-hashing', 'task-hash-derive'],
    needs: ['dependency-inputs-off'],
    workspace: {
      projects: {
        lib: chainProject('lib'),
        app: {
          deps: ['lib'],
          tasks: {
            build: {
              command: 'mkdir -p dist && cat src/a.txt > dist/out.txt',
              dependsOn: ['^build'],
              inputs: ['src/**'],
              outputs: ['dist/**'],
              dependencyInputs: false,
            },
          },
          files: { 'src/a.txt': 'app\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['lib#build', 'app#build'] } },
      { write: { 'packages/lib/src/a.txt': 'lib2\n' } },
      { run: 'build', expect: { exit: 0, ran: ['lib#build'], notRan: ['app#build'] } },
    ],
  }),

  defineCase({
    id: 'cache/linked-worktree-replays-main-checkout',
    category: 'cache',
    kind: 'efficiency',
    title: 'A linked git worktree of the same commit replays what the main checkout built',
    why: 'Same commit, same inputs: the second checkout asks nothing new of the task.',
    from: ['parity-turbo-hashing'],
    workspace: one(cached),
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { sh: 'git worktree add -q wt && cp -R node_modules wt/node_modules' },
      {
        run: 'build',
        cwd: 'wt',
        // A task that runs in the worktree marks wt/.ran.
        expect: { exit: 0, files: { 'wt/.ran': null, 'wt/packages/a/dist/out.txt': 'a\n' } },
      },
    ],
  }),

  defineCase({
    id: 'cache/workspace-through-link-replays',
    category: 'cache',
    kind: 'efficiency',
    title: 'A run started through a link to the workspace replays what the real path built',
    why: 'Same files, same commit: only the path the shell shows differs.',
    from: ['discover-stage'],
    workspace: one(cached),
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { sh: 'ln -s . via && rm -rf packages/a/dist' },
      {
        run: 'build',
        cwd: 'via',
        expect: { exit: 0, notRan: ['a#build'], files: { [out('a')]: 'a\n' } },
      },
    ],
  }),
]
