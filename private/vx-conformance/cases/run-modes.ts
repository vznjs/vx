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
    why: 'Asked to continue, the run should go on with every task the failure does not block, so the user sees every error at once. The run as a whole still failed, though. A green exit would let a pipeline merge or deploy with a broken task the log mentions only in passing.',
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
    why: 'When the run continued past a failed dependency, the task after it ran on whatever the failure left, which is not a valid build. Saving that result lets it replay after the dependency is fixed. The task must run again on the fixed dependency, or the stale output outlives the fix.',
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
    why: 'Forcing a run asks for every task to run regardless of what the cache holds, often because the user suspects an entry. The fresh results must then replace the saved ones. A force that saves nothing leaves the doubted entry in place for the next run to replay.',
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
    why: 'A read-only cache lets a run use what others built without writing, as an untrusted branch build should. A hit must still replay, or the mode saves nothing. A miss must run and leave the cache as it was, so the next normal run builds it again instead of replaying it.',
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
    why: 'A planned run shows what would run without running it. No command may start, no output may be written and no cache entry may be saved. A plan that runs tasks surprises the user with side effects, and one that saves entries can later replay results nothing ever built.',
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
    why: 'A pass-through variable is one the task needs to run, such as a token or a path, but whose value does not change the output. It must reach the command, or the task fails or behaves differently. Keeping it out of the key is a choice about caching, not about whether the task sees it.',
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
    why: 'The user declared that this variable reaches the task but does not change its output, such as a log level or a token. Changing it therefore leaves the result as it was. Running the task again ignores that declaration and costs a full build on every machine where the value differs.',
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
    why: 'The task was told to run after its dependency but not to key on it, because it never reads what the dependency produces. A change only in the dependency leaves this task’s inputs as they were. Running it again ignores that declaration and costs a build that gives the same bytes.',
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
    why: 'A linked git worktree at the same commit holds the same files as the main checkout. The task’s inputs are identical, so the result already built is right here too. Building again because the path differs makes every extra worktree start cold, which is the cost a shared cache should remove.',
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
    why: 'Opening the workspace through a link leaves every file and the commit the same; only the path the shell shows differs. The task’s inputs are identical, so the saved result is right. Building again because of the path makes the same tree cost twice depending on how the user reached it.',
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
