// Pipeline outcomes mined from the rivals’ own tests and fixed bugs:
// Turborepo’s crates/turborepo/tests (run_caching, process_launcher_test,
// watch_test, affected_*) and closed issues, Nx’s e2e/nx (run.test.ts,
// watch.test.ts) and packages/nx/src/tasks-runner specs, moon’s
// crates/task-runner, action-pipeline and affected tests, and Vite Task’s
// CHANGELOG fixes. Each case’s comment names its source; `from` names the vx
// tests guarding the same outcome.
import { defineCase, type Case, type TaskSpec } from '../src/spec.ts'
import { CONCAT, chainProject, one, out } from './shapes.ts'

const A = 'packages/a'

const task = (command: string, extra: Partial<TaskSpec> = {}): TaskSpec => ({
  command,
  inputs: ['src/**'],
  outputs: ['dist/**'],
  ...extra,
})

/** A build that writes a partial output, then fails while its source says `bad`. */
const FRAGILE = `mkdir -p dist && echo partial > dist/out.txt && ! grep -q bad src/*.txt && ${CONCAT}`

/** Waits up to `seconds` for `file`, so a task acts only once another has reached a point. */
const waitFor = (file: string, seconds = 10) =>
  `for i in $(seq ${seconds * 20}); do test -f ${file} && break; sleep 0.05; done`

export default [
  // Nx run.test.ts 'Nx Bail' (--nx-bail): what finished before the failure stays
  defineCase({
    id: 'failure/fail-fast-keeps-what-finished',
    category: 'failure',
    kind: 'efficiency',
    title: 'A task that finished before a fail-fast run stopped is replayed by the next run',
    why: 'Failing fast stops the work still in flight; it does not undo work that already ended. A task that passed before the failure passed for good, and its result is as valid as any other run’s. Throwing it away makes the fix cost a rebuild of everything that had already finished.',
    from: ['fail-fast', 'run-failures-store'],
    needs: ['fail-fast'],
    workspace: {
      projects: {
        ok: { tasks: { build: task(CONCAT) }, files: { 'src/a.txt': 'ok\n' } },
        bad: {
          tasks: {
            build: task(`${waitFor('../ok/dist/out.txt')}; sleep 0.5; ${FRAGILE}`),
          },
          files: { 'src/a.txt': 'bad\n' },
        },
      },
    },
    steps: [
      {
        run: 'build',
        failFast: true,
        expect: { exit: 'fail', ran: ['ok#build', 'bad#build'], files: { [out('ok')]: 'ok\n' } },
      },
      { write: { 'packages/bad/src/a.txt': 'good\n' } },
      {
        run: 'build',
        failFast: true,
        expect: {
          exit: 0,
          ran: ['bad#build'],
          notRan: ['ok#build'],
          files: { [out('ok')]: 'ok\n', [out('bad')]: 'good\n' },
        },
      },
    ],
  }),

  // moon task_runner_test.rs doesnt_reuse_previous_outputs_after_being_stopped
  defineCase({
    id: 'failure/fail-fast-stopped-task-saves-nothing',
    category: 'failure',
    kind: 'correctness',
    title: 'A task a fail-fast run stopped halfway is run again next time, never replayed',
    why: 'A task stopped by fail-fast never finished: what it left in its outputs is half a build. Saving that as a pass would replay the half build on the next run, after the real failure is fixed, under a green run. The next run must run the task to its end and leave its full output.',
    from: ['fail-fast', 'aborted-outcome'],
    needs: ['fail-fast'],
    workspace: {
      projects: {
        slow: {
          tasks: {
            build: task(
              `mkdir -p dist && echo partial > dist/out.txt && touch started && ${waitFor('../bad/passed', 30)}; test -f ../bad/passed && cat src/a.txt > dist/out.txt`,
            ),
          },
          files: { 'src/a.txt': 'slow\n' },
        },
        bad: {
          tasks: {
            build: task(
              `${waitFor('../slow/started')}; ! grep -q bad src/a.txt && touch passed && ${CONCAT}`,
            ),
          },
          files: { 'src/a.txt': 'bad\n' },
        },
      },
    },
    steps: [
      { run: 'build', failFast: true, expect: { exit: 'fail', ran: ['slow#build'], within: 25 } },
      { write: { 'packages/bad/src/a.txt': 'good\n' } },
      {
        run: 'build',
        failFast: true,
        expect: {
          exit: 0,
          ran: ['slow#build', 'bad#build'],
          files: { [out('slow')]: 'slow\n', [out('bad')]: 'good\n' },
        },
      },
    ],
  }),

  // Nx tasks-runner task-orchestrator.spec.ts: a retried task is not a failure until its last attempt
  defineCase({
    id: 'failure/fail-fast-waits-for-retries',
    category: 'failure',
    kind: 'correctness',
    title: 'A flaky task that passes on its retry does not stop a fail-fast run',
    why: 'A task with retries has failed only once its last attempt fails. A fail-fast run that stops at the first failed attempt kills the other tasks for a failure that never happened, and the run fails though every task passed. The retry passes, the slow task beside it finishes, and the run succeeds.',
    from: ['fail-fast', 'flaky-retry'],
    needs: ['fail-fast', 'retries'],
    workspace: {
      projects: {
        flaky: {
          tasks: {
            build: task(
              'if test -f tried; then mkdir -p dist && cat src/a.txt > dist/out.txt; else touch tried; exit 1; fi',
              { retries: 1 },
            ),
          },
          files: { 'src/a.txt': 'flaky\n' },
        },
        slow: {
          tasks: { build: task(`sleep 1.5 && ${CONCAT}`) },
          files: { 'src/a.txt': 'slow\n' },
        },
      },
    },
    steps: [
      {
        run: 'build',
        failFast: true,
        expect: {
          exit: 0,
          ran: ['flaky#build', 'slow#build'],
          files: { [out('flaky')]: 'flaky\n', [out('slow')]: 'slow\n' },
        },
      },
    ],
  }),

  // Nx run.test.ts 'Nx Bail': at --parallel=1 with --nx-bail only one failing task runs
  defineCase({
    id: 'failure/fail-fast-serial-run-starts-nothing-after-a-failure',
    category: 'failure',
    kind: 'efficiency',
    title: 'A fail-fast run of one task at a time starts no other task after the first fails',
    why: 'At a concurrency of one, nothing else is running when the first task fails, so failing fast can only mean starting nothing more. A run that goes on to the queued tasks spends the whole wait the user asked to skip. Of two failing tasks, exactly one runs.',
    from: ['fail-fast', 'run-concurrency'],
    needs: ['fail-fast'],
    workspace: {
      projects: {
        x: { tasks: { check: { command: 'echo t >> ../../tried.txt; exit 1', cache: false } } },
        y: { tasks: { check: { command: 'echo t >> ../../tried.txt; exit 1', cache: false } } },
      },
    },
    steps: [
      {
        run: 'check',
        concurrency: 1,
        failFast: true,
        expect: { exit: 'fail', files: { 'tried.txt': 't\n' } },
      },
    ],
  }),

  // Nx run.test.ts 'Nx Bail' (without --nx-bail): both failing tasks run
  defineCase({
    id: 'failure/serial-run-goes-on-past-a-failure',
    category: 'failure',
    kind: 'correctness',
    title: 'A run of one task at a time still runs an unrelated task after a failure',
    why: 'Without fail-fast, a failure skips only what depends on it. A serial run has the same duty as a parallel one: an unrelated task still queued must start once the failed one ends. A scheduler that stops taking work from its queue after a failure hides every other result. Both failing tasks run, and the run fails.',
    from: ['failure-mode', 'run-concurrency'],
    workspace: {
      projects: {
        x: { tasks: { check: { command: 'echo t >> ../../tried.txt; exit 1', cache: false } } },
        y: { tasks: { check: { command: 'echo t >> ../../tried.txt; exit 1', cache: false } } },
      },
    },
    steps: [
      {
        run: 'check',
        concurrency: 1,
        expect: { exit: 'fail', ran: ['x#check', 'y#check'], files: { 'tried.txt': 't\nt\n' } },
      },
    ],
  }),

  // moon task_runner_test.rs doesnt_reuse_previous_outputs_after_a_requirement_fails
  defineCase({
    id: 'failure/revert-after-failure-replays-the-pass',
    category: 'failure',
    kind: 'correctness',
    title:
      'Undoing the edit that broke a build replays the earlier pass, not the broken run’s leftovers',
    why: 'The failed run left a partial file in the outputs. Once the source is back as it was, the earlier pass is the right result, and a replay must put its bytes back over the leftovers. A tool that sees the outputs present and skips the restore leaves the partial file under a green run.',
    from: ['failure-cache-properties', 'run-failures-store'],
    workspace: one(task(FRAGILE)),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [`${A}/dist/out.txt`]: 'a\n' } } },
      { write: { [`${A}/src/a.txt`]: 'bad\n' } },
      {
        run: 'build',
        expect: { exit: 'fail', ran: ['a#build'], files: { [`${A}/dist/out.txt`]: 'partial\n' } },
      },
      { write: { [`${A}/src/a.txt`]: 'a\n' } },
      {
        run: 'build',
        expect: { exit: 0, notRan: ['a#build'], files: { [`${A}/dist/out.txt`]: 'a\n' } },
      },
    ],
  }),

  // moon task_runner_test.rs skips_if_dep_failed, then the dependency is put back
  defineCase({
    id: 'failure/revert-after-dependency-failure-replays-the-chain',
    category: 'failure',
    kind: 'efficiency',
    title: 'Putting back a dependency that broke replays it and the project built on it',
    why: 'The dependant was skipped while its dependency failed, so nothing about it changed: once the dependency is back as it was, both are where the first run left them. A tool that treats a skipped task as stale rebuilds work the cache already holds. Both replay, and the dependant’s output is the first run’s.',
    from: ['failure-cache-properties', 'failure-mode'],
    workspace: {
      projects: {
        lib: { tasks: { build: task(FRAGILE) }, files: { 'src/a.txt': 'lib\n' } },
        app: chainProject('app', ['lib']),
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('app')]: 'lib\napp\n' } } },
      { write: { 'packages/lib/src/a.txt': 'bad\n' } },
      { run: 'build', expect: { exit: 'fail', ran: ['lib#build'], notRan: ['app#build'] } },
      { write: { 'packages/lib/src/a.txt': 'lib\n' } },
      {
        run: 'build',
        expect: {
          exit: 0,
          notRan: ['lib#build', 'app#build'],
          files: { [out('lib')]: 'lib\n', [out('app')]: 'lib\napp\n' },
        },
      },
    ],
  }),

  // Turborepo run_summary / task graph: a failed task skips dependent tasks, not dependent packages
  defineCase({
    id: 'failure/failed-test-keeps-dependent-project-build',
    category: 'failure',
    kind: 'correctness',
    title: 'A library’s failing test does not stop the build of an app that needs only its build',
    why: 'The app’s build waits on the library’s build, not on its tests. A failed test says nothing about the build it never fed. A tool that skips by project instead of by task drops the app’s build for no reason. The app builds and the run still fails.',
    from: ['failure-mode', 'task-graph'],
    needs: ['multi-task'],
    workspace: {
      projects: {
        lib: {
          tasks: { build: task(CONCAT), test: { command: 'exit 1', cache: false } },
          files: { 'src/a.txt': 'lib\n' },
        },
        app: chainProject('app', ['lib']),
      },
    },
    steps: [
      {
        run: 'build',
        also: ['test'],
        expect: {
          exit: 'fail',
          ran: ['lib#build', 'lib#test', 'app#build'],
          files: { [out('app')]: 'lib\napp\n' },
        },
      },
    ],
  }),

  // Nx run.test.ts 'should run multiple targets', one of them failing
  defineCase({
    id: 'failure/failing-lint-keeps-build-of-its-project-saved',
    category: 'failure',
    kind: 'efficiency',
    title:
      'A build that passed beside its own project’s failing lint replays once the lint is fixed',
    why: 'Two tasks of one project are separate work: a failing lint does not make the build that passed beside it any less good. A tool that throws away a project’s results when one of its tasks fails makes the lint fix cost a rebuild. The second run runs only the lint.',
    from: ['run-failures-store', 'task-selection'],
    needs: ['multi-task'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: task(CONCAT),
            lint: { command: 'grep -q ok lint.txt', inputs: ['lint.txt'], outputs: [] },
          },
          files: { 'src/a.txt': 'a\n', 'lint.txt': 'nope\n' },
        },
      },
    },
    steps: [
      { run: 'build', also: ['lint'], expect: { exit: 'fail', ran: ['a#build', 'a#lint'] } },
      { write: { [`${A}/lint.txt`]: 'ok\n' } },
      {
        run: 'build',
        also: ['lint'],
        expect: { exit: 0, ran: ['a#lint'], notRan: ['a#build'] },
      },
    ],
  }),

  // Turborepo process_launcher_test.rs drains_verbose_output_without_deadlocking_or_unbounded_capture
  defineCase({
    id: 'failure/megabytes-of-output-on-both-streams-finish',
    category: 'failure',
    kind: 'correctness',
    title: 'A task printing megabytes on both its output and error streams finishes and is cached',
    why: 'A runner that reads one stream while the task blocks writing the other deadlocks: the pipe fills and both sides wait for good. A verbose test runner or a bundler’s warnings easily print megabytes. The task must finish, its file must be written, and the next run must replay it.',
    from: ['frame-big-output', 'capture-cap'],
    workspace: one(
      task(
        `yes out | head -c 3000000; yes err | head -c 3000000 >&2; yes out | head -c 1000000; ${CONCAT}`,
      ),
    ),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [`${A}/dist/out.txt`]: 'a\n' }, within: 90 } },
      {
        run: 'build',
        expect: {
          exit: 0,
          notRan: ['a#build'],
          files: { [`${A}/dist/out.txt`]: 'a\n' },
          within: 90,
        },
      },
    ],
  }),

  // Turborepo run_logging.rs: a line of a megabyte, no newline at the end
  defineCase({
    id: 'failure/one-megabyte-line-finishes',
    category: 'failure',
    kind: 'correctness',
    title: 'A task printing a single megabyte-long line with no newline finishes and is cached',
    why: 'Minified bundles and progress bars print one enormous line. A runner that splits output into lines and buffers until a newline can grow without bound or wait for a newline that never comes. The task must finish, and the next run replays it.',
    from: ['frame-big-output', 'failed-output-whole'],
    workspace: one(task(`head -c 1000000 /dev/zero | tr '\\0' y; ${CONCAT}`)),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [`${A}/dist/out.txt`]: 'a\n' }, within: 60 } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'], within: 60 } },
    ],
  }),

  // Turborepo run_logging.rs test_no_color_strips_task_output_live_and_replayed: raw bytes
  defineCase({
    id: 'failure/binary-bytes-on-output-are-no-failure',
    category: 'failure',
    kind: 'correctness',
    title: 'A task printing NUL, invalid UTF-8 and escape bytes succeeds, live and replayed',
    why: 'A task’s output is bytes, not text: a test can print a binary diff, a compiler a stray Latin-1 byte. A runner that decodes output as UTF-8 and throws on a bad byte fails a task that passed. The task succeeds, and its replay succeeds too.',
    from: ['raw-output-bytes', 'replay-fidelity'],
    workspace: one(
      task(`printf 'x\\000y\\377\\376\\033[31mred\\r\\n'; printf '\\200\\201\\n' >&2; ${CONCAT}`),
    ),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [`${A}/dist/out.txt`]: 'a\n' } } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
    ],
  }),

  // Turborepo graceful_shutdown_test.rs: dependencies restored for a dependant that then fails
  defineCase({
    id: 'failure/replayed-dependency-restored-for-a-failing-dependant',
    category: 'failure',
    kind: 'correctness',
    title: 'A dependency replayed for a dependant that fails is restored before the dependant runs',
    why: 'The dependant reads its dependency’s output, and it must find it whether or not it then passes. A tool that restores lazily, or only on success, lets the dependant fail for the wrong reason. Once the dependant is fixed, the dependency replays and only the dependant runs.',
    from: ['dependency-outputs-there', 'run-failures-store'],
    workspace: {
      projects: {
        lib: { tasks: { build: task(CONCAT) }, files: { 'src/a.txt': 'lib\n' } },
        app: {
          deps: ['lib'],
          tasks: {
            build: task(
              'cat ../lib/dist/out.txt > seen.txt && ! grep -q bad src/a.txt && mkdir -p dist && cat ../lib/dist/out.txt src/a.txt > dist/out.txt',
              { dependsOn: ['^build'] },
            ),
          },
          files: { 'src/a.txt': 'bad\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 'fail', ran: ['lib#build', 'app#build'] } },
      { write: { 'packages/lib/dist': null, 'packages/app/seen.txt': null } },
      {
        run: 'build',
        expect: {
          exit: 'fail',
          notRan: ['lib#build'],
          ran: ['app#build'],
          files: { 'packages/app/seen.txt': 'lib\n', [out('lib')]: 'lib\n' },
        },
      },
      { write: { 'packages/app/src/a.txt': 'app\n' } },
      {
        run: 'build',
        expect: {
          exit: 0,
          notRan: ['lib#build'],
          ran: ['app#build'],
          files: { [out('app')]: 'lib\napp\n' },
        },
      },
    ],
  }),

  // Turborepo process_launcher_test.rs launcher_captures_shutdown_and_guard_cleans_task_tree
  defineCase({
    id: 'failure/task-signalling-its-own-group-ends-only-itself',
    category: 'failure',
    kind: 'correctness',
    title: 'A task that signals its own process group kills only itself, not the run',
    why: 'Shell scripts end their jobs with `kill 0`, which signals every process in the caller’s group. A runner that starts tasks in its own process group is killed along with the task, and the unrelated task beside it dies too. Each task needs its own group: the run fails for the killed task, and the other finishes.',
    from: ['task-tree-kill', 'signal-death'],
    workspace: {
      projects: {
        k: { tasks: { build: { command: 'sleep 0.2; kill -TERM 0; sleep 5', cache: false } } },
        b: {
          tasks: { build: task(`sleep 1.5 && ${CONCAT}`) },
          files: { 'src/a.txt': 'b\n' },
        },
      },
    },
    steps: [
      {
        run: 'build',
        expect: { exit: 'fail', ran: ['b#build'], files: { [out('b')]: 'b\n' }, within: 30 },
      },
    ],
  }),

  // Turborepo run_caching.rs test_basic_monorepo_cache_behaviors: switching back to a branch
  defineCase({
    id: 'cache/branch-switch-back-replays',
    category: 'cache',
    kind: 'efficiency',
    title: 'Switching to another branch and back replays the build made on the first branch',
    why: 'Moving between branches is the most common way sources go back to a state already built. The output on disk is the other branch’s, so the replay must restore the first build’s bytes, not trust what is there. Rebuilding wastes the entry the first branch saved.',
    from: ['stale-hit-git', 'branch-scope'],
    workspace: one(task(CONCAT)),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [`${A}/dist/out.txt`]: 'a\n' } } },
      { sh: `git checkout -q -b other && echo b > ${A}/src/a.txt && git commit -qam b` },
      {
        run: 'build',
        expect: { exit: 0, ran: ['a#build'], files: { [`${A}/dist/out.txt`]: 'b\n' } },
      },
      { sh: 'git checkout -q main' },
      {
        run: 'build',
        expect: { exit: 0, notRan: ['a#build'], files: { [`${A}/dist/out.txt`]: 'a\n' } },
      },
    ],
  }),

  // Turborepo run_caching.rs: git stash and stash pop move the tree between two built states
  defineCase({
    id: 'cache/stash-and-pop-replay-each-state',
    category: 'cache',
    kind: 'correctness',
    title: 'Stashing an edit replays the clean build, and popping it replays the edited one',
    why: 'A stash puts committed bytes back into an edited file and a pop brings the edit back, both without a commit. Each state has been built, and each must replay its own result. A tool that keys a file from git’s record while it is dirty, or misses the pop, replays the wrong one.',
    from: ['stale-hit-git', 'git-trust'],
    workspace: one(task(CONCAT)),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [`${A}/dist/out.txt`]: 'a\n' } } },
      { write: { [`${A}/src/a.txt`]: 'e\n' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['a#build'], files: { [`${A}/dist/out.txt`]: 'e\n' } },
      },
      { sh: 'git stash -q' },
      {
        run: 'build',
        expect: { exit: 0, notRan: ['a#build'], files: { [`${A}/dist/out.txt`]: 'a\n' } },
      },
      { sh: 'git stash pop -q' },
      {
        run: 'build',
        expect: { exit: 0, notRan: ['a#build'], files: { [`${A}/dist/out.txt`]: 'e\n' } },
      },
    ],
  }),

  // Turborepo crates/turborepo-scm: object lookups after the repository is packed
  defineCase({
    id: 'cache/repack-keeps-every-entry',
    category: 'cache',
    kind: 'efficiency',
    title: 'Packing the repository with `git gc` keeps the task replaying',
    why: 'Git moves loose objects into packs on its own schedule; the files and their contents do not change. A tool that keys files by where git stores them, not by what they hold, loses every entry after a gc. The run after the gc replays.',
    from: ['git-oid', 'stable-keys'],
    workspace: one(task(CONCAT)),
    steps: [
      { write: { [`${A}/src/b.txt`]: 'b\n' } },
      { commit: 'b' },
      { run: 'build', expect: { exit: 0, files: { [`${A}/dist/out.txt`]: 'a\nb\n' } } },
      { sh: 'git gc -q --aggressive --prune=now' },
      {
        run: 'build',
        expect: { exit: 0, notRan: ['a#build'], files: { [`${A}/dist/out.txt`]: 'a\nb\n' } },
      },
    ],
  }),

  // Turborepo run_caching.rs: the commit changes, the tree does not
  defineCase({
    id: 'cache/amended-commit-keeps-the-entry',
    category: 'cache',
    kind: 'efficiency',
    title: 'Amending the last commit’s message keeps the task replaying',
    why: 'An amend makes a new commit with the same files. Nothing a task reads has changed, so its key must not either. A tool that folds the commit into the key rebuilds after every amend or rebase. The run after the amend replays.',
    from: ['stable-keys', 'stale-hit-git'],
    workspace: one(task(CONCAT)),
    steps: [
      { write: { [`${A}/src/a.txt`]: 'x\n' } },
      { commit: 'x' },
      { run: 'build', expect: { exit: 0, files: { [`${A}/dist/out.txt`]: 'x\n' } } },
      { sh: 'git commit -q --amend -m y' },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
    ],
  }),

  // Turborepo crates/turborepo-scm: a stale index.lock left by a crashed git
  defineCase({
    id: 'cache/stale-index-lock-still-sees-edits',
    category: 'cache',
    kind: 'correctness',
    title: 'With a stale `.git/index.lock` left behind, a same-size edit still runs the task again',
    why: 'A crashed git or editor plugin can leave `index.lock` behind, and git then refuses to write the index. A tool that needs to refresh the index to see an edit misses it, or fails the run. The run must go on and key the edited bytes.',
    from: ['git-optional-locks', 'stale-hit-git'],
    workspace: one(task(CONCAT)),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [`${A}/dist/out.txt`]: 'a\n' } } },
      { sh: 'touch .git/index.lock' },
      { write: { [`${A}/src/a.txt`]: 'b\n' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['a#build'], files: { [`${A}/dist/out.txt`]: 'b\n' } },
      },
    ],
  }),

  // Turborepo crates/turborepo-scm: falling back to hashing files when git has no index
  defineCase({
    id: 'cache/missing-git-index-still-sees-edits',
    category: 'cache',
    kind: 'correctness',
    title: 'With `.git/index` deleted, an edit still runs the task again',
    why: 'Without its index git sees every file as untracked: nothing is clean, so nothing may be keyed from git’s record. A tool that keeps trusting old facts about the files replays a stale build. The edit runs the task again and the output holds it.',
    from: ['git-trust', 'stale-hit-git'],
    workspace: one(task(CONCAT)),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [`${A}/dist/out.txt`]: 'a\n' } } },
      { sh: 'rm .git/index' },
      { write: { [`${A}/src/a.txt`]: 'b\n' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['a#build'], files: { [`${A}/dist/out.txt`]: 'b\n' } },
      },
    ],
  }),

  // Turborepo run_caching.rs: the package is part of the task hash
  defineCase({
    id: 'cache/same-sources-two-projects-keep-their-own-results',
    category: 'cache',
    kind: 'correctness',
    title:
      'Two projects with the same command and the same sources never replay each other’s results',
    why: 'Copy-pasted packages often hold byte-identical sources, yet a build can depend on where it runs, its directory name or its package. A key built only from the command and the file contents gives both one entry, and the second project replays the first one’s output. Each project builds its own.',
    from: ['task-hash-derive', 'keyed-projects'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: task('mkdir -p dist && { basename "$PWD"; cat src/a.txt; } > dist/out.txt'),
          },
          files: { 'src/a.txt': 'same\n' },
        },
        b: {
          tasks: {
            build: task('mkdir -p dist && { basename "$PWD"; cat src/a.txt; } > dist/out.txt'),
          },
          files: { 'src/a.txt': 'same\n' },
        },
      },
    },
    steps: [
      { run: 'build', projects: ['a'], expect: { exit: 0, files: { [out('a')]: 'a\nsame\n' } } },
      {
        run: 'build',
        projects: ['b'],
        expect: { exit: 0, ran: ['b#build'], files: { [out('b')]: 'b\nsame\n' } },
      },
      { write: { 'packages/a/dist': null, 'packages/b/dist': null } },
      {
        run: 'build',
        expect: {
          exit: 0,
          notRan: ['a#build', 'b#build'],
          files: { [out('a')]: 'a\nsame\n', [out('b')]: 'b\nsame\n' },
        },
      },
    ],
  }),

  // Turborepo crates/turborepo-scm (gix index reader): index format version 4
  defineCase({
    id: 'cache/index-version-4-replays-and-sees-edits',
    category: 'cache',
    kind: 'correctness',
    title: 'With git’s index in format version 4, the task replays and an edit runs it again',
    why: 'Version 4 compresses paths in the index, and `feature.manyFiles` turns it on in big repositories. A tool that parses the index itself and does not know the format mis-reads every entry. Both directions must hold: replay when nothing changed, run when a file did.',
    from: ['git-oid', 'stale-hit-git'],
    workspace: one(task(CONCAT), { 'src/a.txt': 'a\n', 'src/sub/deep/b.txt': 'b\n' }),
    steps: [
      { sh: 'git update-index --index-version 4' },
      { run: 'build', expect: { exit: 0, files: { [`${A}/dist/out.txt`]: 'a\n' } } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
      { write: { [`${A}/src/a.txt`]: 'c\n' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['a#build'], files: { [`${A}/dist/out.txt`]: 'c\n' } },
      },
    ],
  }),

  // Turborepo crates/turborepo-scm: a split index keeps entries in a shared file
  defineCase({
    id: 'cache/split-index-replays-and-sees-edits',
    category: 'cache',
    kind: 'correctness',
    title: 'With a split git index, the task replays and an edit runs it again',
    why: 'A split index keeps most entries in a shared file beside `.git/index`, which then lists only what changed. A tool that reads `.git/index` alone sees almost no tracked files. Replays and reruns must be the same as with a plain index.',
    from: ['git-oid', 'stale-hit-git'],
    workspace: one(task(CONCAT), { 'src/a.txt': 'a\n', 'src/b.txt': 'b\n' }),
    steps: [
      { sh: 'git update-index --split-index && git commit -q --allow-empty -m split' },
      { run: 'build', expect: { exit: 0, files: { [`${A}/dist/out.txt`]: 'a\nb\n' } } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
      { write: { [`${A}/src/b.txt`]: 'c\n' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['a#build'], files: { [`${A}/dist/out.txt`]: 'a\nc\n' } },
      },
    ],
  }),

  // Turborepo crates/turborepo-scm: core.untrackedCache hides new files from a stale cache
  defineCase({
    id: 'cache/untracked-cache-sees-a-new-file',
    category: 'cache',
    kind: 'correctness',
    title: 'With git’s untracked cache on, a new untracked input still runs the task again',
    why: 'The untracked cache lets git skip directories whose stat looks unchanged when it lists untracked files. A new file in an input directory must still be seen. A tool that trusts a stale listing replays a build without the file.',
    from: ['git-trust', 'absent-input'],
    workspace: one(task(CONCAT)),
    steps: [
      {
        sh: 'git config core.untrackedCache true && git update-index --untracked-cache && git status -s >/dev/null',
      },
      { run: 'build', expect: { exit: 0, files: { [`${A}/dist/out.txt`]: 'a\n' } } },
      { write: { [`${A}/src/b.txt`]: 'b\n' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['a#build'], files: { [`${A}/dist/out.txt`]: 'a\nb\n' } },
      },
    ],
  }),

  // vx git-oid / Turborepo gix: a repository in the SHA-256 object format
  defineCase({
    id: 'cache/sha256-repository-caches',
    category: 'cache',
    kind: 'correctness',
    title:
      'In a git repository using SHA-256 object names, the task replays and an edit runs it again',
    why: 'Git can name objects by SHA-256 instead of SHA-1, and their names are 64 hex digits, not 40. A tool that parses object names or the index with SHA-1 sizes mis-reads every entry. Caching must work as in any repository.',
    from: ['git-oid', 'stale-hit-git'],
    workspace: one(task(CONCAT)),
    steps: [
      {
        sh: 'rm -rf .git && git init -q --object-format=sha256 -b main && git add -A && git commit -qm init',
      },
      { run: 'build', expect: { exit: 0, files: { [`${A}/dist/out.txt`]: 'a\n' } } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
      { write: { [`${A}/src/a.txt`]: 'b\n' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['a#build'], files: { [`${A}/dist/out.txt`]: 'b\n' } },
      },
      { commit: 'b' },
      {
        run: 'build',
        expect: { exit: 0, notRan: ['a#build'], files: { [`${A}/dist/out.txt`]: 'b\n' } },
      },
    ],
  }),
  // Turborepo watch_test.rs watch_persistent_tasks_skipped_on_build_failure
  defineCase({
    id: 'watch/broken-dependency-holds-its-dependant-until-fixed',
    category: 'watch',
    kind: 'correctness',
    title:
      'While watching, a dependency that breaks holds back its dependant, and fixing it builds both',
    why: 'A dependant built over a failed dependency builds on stale or partial output. The watch must hold it back while the dependency is broken, then build both once the fix lands. Building the dependant anyway leaves a green output over a red library.',
    from: ['watch-loop', 'watch-dependency-gone'],
    needs: ['watch'],
    workspace: {
      projects: {
        lib: { tasks: { build: task(FRAGILE) }, files: { 'src/a.txt': 'lib\n' } },
        app: chainProject('app', ['lib']),
      },
    },
    steps: [
      {
        watch: 'build',
        phases: [
          { expect: { ran: ['lib#build', 'app#build'], files: { [out('app')]: 'lib\napp\n' } } },
          {
            write: { 'packages/lib/src/a.txt': 'bad\n' },
            expect: { notRan: ['app#build'], files: { [out('lib')]: 'partial\n' } },
          },
          {
            write: { 'packages/lib/src/a.txt': 'lib2\n' },
            expect: {
              ran: ['lib#build', 'app#build'],
              order: [['lib#build', 'app#build']],
              files: { [out('app')]: 'lib2\napp\n' },
            },
          },
        ],
      },
    ],
  }),

  // Turborepo watch_test.rs watch_no_concurrent_builds_of_same_package
  defineCase({
    id: 'watch/never-two-builds-of-one-task-at-once',
    category: 'watch',
    kind: 'correctness',
    title: 'An edit during a build never starts a second copy of that build beside the first',
    why: 'Two copies of one build write the same output files at once, and the result is whichever wrote last, or a mix. A watch must let the running build end, or stop it, before starting the next. The task notes when another copy of itself is already running, and no note may appear.',
    from: ['watch-loop-members', 'watch-ready-interrupt'],
    needs: ['watch'],
    workspace: {
      projects: {
        app: {
          tasks: {
            build: task(
              'mkdir lock.d 2>/dev/null || echo overlap >> overlap.txt; mkdir -p dist && cp src/a.txt dist/started && sleep 2 && cat src/*.txt > dist/out.txt; rmdir lock.d',
            ),
          },
          files: { 'src/a.txt': 'a1\n' },
        },
      },
    },
    steps: [
      {
        watch: 'build',
        phases: [
          { expect: { ran: ['app#build'], files: { [out('app')]: 'a1\n' } } },
          {
            write: { 'packages/app/src/a.txt': 'a2\n' },
            expect: { files: { 'packages/app/dist/started': 'a2\n' }, inFlight: true },
          },
          {
            write: { 'packages/app/src/a.txt': 'a3\n' },
            expect: {
              ran: ['app#build'],
              files: { [out('app')]: 'a3\n', 'packages/app/overlap.txt': null },
            },
          },
        ],
      },
    ],
  }),

  // Turborepo path_with_spaces_test.rs test_files_with_spaces_can_be_hashed, under watch
  defineCase({
    id: 'watch/input-named-with-spaces-reruns',
    category: 'watch',
    kind: 'correctness',
    title: 'Editing an input whose name holds spaces while watching runs the task again',
    why: 'A watch maps each changed path back to the tasks it keys. A path split at its spaces, or quoted on one side and not the other, maps to no task. The edit to `my notes.txt` must rebuild like any other.',
    from: ['watch-loop', 'workspace-path-chars'],
    needs: ['watch'],
    workspace: {
      projects: {
        app: { tasks: { build: task(CONCAT) }, files: { 'src/my notes.txt': 'n1\n' } },
      },
    },
    steps: [
      {
        watch: 'build',
        phases: [
          { expect: { ran: ['app#build'], files: { [out('app')]: 'n1\n' } } },
          {
            write: { 'packages/app/src/my notes.txt': 'n2\n' },
            expect: { ran: ['app#build'], files: { [out('app')]: 'n2\n' } },
          },
        ],
      },
    ],
  }),

  // vx watch-lossy-name; Nx watch.test.ts: names that are not ASCII
  defineCase({
    id: 'watch/non-ascii-input-name-reruns',
    category: 'watch',
    kind: 'correctness',
    title: 'Editing an input named in non-ASCII letters while watching runs the task again',
    why: 'File events carry raw bytes, and a watch that decodes or normalises them differently from how it listed the inputs loses the match. Accented and non-Latin names are ordinary in many teams. The edit to `données.txt` must rebuild.',
    from: ['watch-lossy-name', 'git-enum-unicode'],
    needs: ['watch'],
    workspace: {
      projects: {
        app: { tasks: { build: task(CONCAT) }, files: { 'src/données.txt': 'd1\n' } },
      },
    },
    steps: [
      {
        watch: 'build',
        phases: [
          { expect: { ran: ['app#build'], files: { [out('app')]: 'd1\n' } } },
          {
            write: { 'packages/app/src/données.txt': 'd2\n' },
            expect: { ran: ['app#build'], files: { [out('app')]: 'd2\n' } },
          },
        ],
      },
    ],
  }),

  // Turborepo watch_test.rs watch_task_inputs_reruns_deferred_dependency_output_consumers
  defineCase({
    id: 'watch/own-prerequisite-reruns-first',
    category: 'watch',
    kind: 'correctness',
    title:
      'While watching, an edit reruns the project’s own prerequisite task before the task that needs it',
    why: 'The build reads what the project’s codegen task writes. An edit to the codegen input must run codegen, then the build over its fresh output. A watch that reruns only the watched task builds over the old generated file.',
    from: ['watch-loop', 'task-graph'],
    needs: ['watch'],
    workspace: {
      projects: {
        app: {
          tasks: {
            gen: {
              command: 'mkdir -p gen && cat schema.txt > gen/out.txt',
              inputs: ['schema.txt'],
              outputs: ['gen/**'],
            },
            build: task('mkdir -p dist && cat gen/out.txt src/*.txt > dist/out.txt', {
              dependsOn: ['gen'],
            }),
          },
          files: { 'schema.txt': 's1\n', 'src/a.txt': 'a\n' },
        },
      },
    },
    steps: [
      {
        watch: 'build',
        phases: [
          { expect: { ran: ['app#gen', 'app#build'], files: { [out('app')]: 's1\na\n' } } },
          {
            write: { 'packages/app/schema.txt': 's2\n' },
            expect: {
              ran: ['app#gen', 'app#build'],
              order: [['app#gen', 'app#build']],
              files: { [out('app')]: 's2\na\n' },
            },
          },
        ],
      },
    ],
  }),

  // Turborepo watch_test.rs watch_rapid_edits_produce_single_rebuild, across a dependency edge
  defineCase({
    id: 'watch/dependency-and-dependant-edited-together',
    category: 'watch',
    kind: 'correctness',
    title:
      'Editing a library and its app at once while watching builds each once, the library first',
    why: 'One save can touch both sides of an edge, as a rename across packages does. The watch must build the library, then the app over it, each once. Building the app first, or twice, leaves a moment or a result built on the old library.',
    from: ['watch-loop-members', 'watch-late-batch'],
    needs: ['watch'],
    workspace: {
      projects: { lib: chainProject('lib'), app: chainProject('app', ['lib']) },
    },
    steps: [
      {
        watch: 'build',
        phases: [
          { expect: { ran: ['lib#build', 'app#build'] } },
          {
            sh: 'echo lib2 > packages/lib/src/a.txt && echo app2 > packages/app/src/a.txt',
            expect: {
              ran: ['lib#build', 'app#build'],
              order: [['lib#build', 'app#build']],
              files: { [out('app')]: 'lib2\napp2\n' },
            },
          },
        ],
      },
    ],
  }),

  // Turborepo path_with_spaces_test.rs: a package directory with spaces, under watch
  defineCase({
    id: 'watch/project-directory-with-spaces-reruns',
    category: 'watch',
    kind: 'correctness',
    title:
      'Editing a source in a project whose directory holds spaces while watching runs its task again',
    why: 'The watch must map an event under `packages/my app/` to the project there. A path compared after splitting or escaping it one way and not the other finds no owner, and the edit is dropped. The project rebuilds with the edit.',
    from: ['watch-loop', 'workspace-path-chars'],
    needs: ['watch'],
    workspace: { projects: { app: chainProject('app', [], { dir: 'packages/my app' }) } },
    steps: [
      {
        watch: 'build',
        phases: [
          { expect: { ran: ['app#build'], files: { 'packages/my app/dist/out.txt': 'app\n' } } },
          {
            write: { 'packages/my app/src/a.txt': 'app2\n' },
            expect: { ran: ['app#build'], files: { 'packages/my app/dist/out.txt': 'app2\n' } },
          },
        ],
      },
    ],
  }),

  // Nx watch.test.ts should watch for project changes: a new dependency in the config
  defineCase({
    id: 'watch/config-adding-a-prerequisite-runs-it-first',
    category: 'watch',
    kind: 'correctness',
    title:
      'Making the watched task depend on a new task while watching runs that task, then the build',
    why: 'Changing what a task depends on changes how it must be built. The watch must pick up the new edge, run the new prerequisite, and build again after it. A watch that keeps the old graph never runs the new task until it is restarted.',
    from: ['watch-loop', 'watch-rules'],
    needs: ['watch'],
    workspace: {
      projects: {
        app: {
          tasks: {
            build: task(
              'mkdir -p dist && { cat gen/out.txt 2>/dev/null; cat src/*.txt; } > dist/out.txt',
            ),
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    steps: [
      {
        watch: 'build',
        phases: [
          { expect: { ran: ['app#build'], files: { [out('app')]: 'a\n' } } },
          {
            configure: (given) => {
              const ws = structuredClone(given)
              const app = ws.projects.app!
              app.tasks = {
                gen: task('mkdir -p gen && echo gen > gen/out.txt', { outputs: ['gen/**'] }),
                build: { ...app.tasks!.build!, dependsOn: ['gen'] },
              }
              return ws
            },
            expect: {
              ran: ['app#gen', 'app#build'],
              order: [['app#gen', 'app#build']],
              files: { [out('app')]: 'gen\na\n' },
            },
          },
        ],
      },
    ],
  }),

  // vx watch-nested-boundary: a project nested inside another
  defineCase({
    id: 'watch/nested-project-edit-leaves-its-parent',
    category: 'watch',
    kind: 'efficiency',
    title: 'Editing a project nested inside another while watching rebuilds only the nested one',
    why: 'The nested project’s files sit under the outer project’s directory but belong to the nested one. A watch that maps a path to the first project whose directory holds it rebuilds the outer project for nothing. Only the nested project runs.',
    from: ['watch-nested-boundary', 'nested-boundary'],
    needs: ['watch'],
    workspace: {
      projects: {
        lib: chainProject('lib'),
        inner: chainProject('inner', [], { dir: 'packages/lib/inner' }),
      },
    },
    steps: [
      {
        watch: 'build',
        phases: [
          { expect: { ran: ['lib#build', 'inner#build'] } },
          {
            write: { 'packages/lib/inner/src/a.txt': 'inner2\n' },
            expect: {
              ran: ['inner#build'],
              notRan: ['lib#build'],
              files: { 'packages/lib/inner/dist/out.txt': 'inner2\n' },
            },
          },
        ],
      },
    ],
  }),

  // moon / Turborepo watch: a negated input glob holds under watch too
  defineCase({
    id: 'watch/file-excluded-by-negated-input-reruns-nothing',
    category: 'watch',
    kind: 'efficiency',
    title: 'Editing a file the task’s inputs exclude with `!` while watching reruns nothing',
    why: 'An excluded file is not an input: a run would replay after editing it, and a watch must agree. A watch that matches only the positive glob rebuilds on every edit to a README beside the sources. Nothing runs.',
    from: ['watch-rules', 'watch-claimed-files'],
    needs: ['watch'],
    workspace: {
      projects: {
        app: {
          tasks: {
            build: task('mkdir -p dist && cat src/*.txt > dist/out.txt', {
              inputs: ['src/**', '!src/**/*.md'],
            }),
          },
          files: { 'src/a.txt': 'a\n', 'src/notes.md': 'n1\n' },
        },
      },
    },
    steps: [
      {
        watch: 'build',
        phases: [
          { expect: { ran: ['app#build'] } },
          { write: { 'packages/app/src/notes.md': 'n2\n' }, expect: { notRan: ['app#build'] } },
        ],
      },
    ],
  }),
  // Turborepo run tests: `turbo run build build` names one task twice
  defineCase({
    id: 'graph/task-asked-for-twice-runs-once',
    category: 'graph',
    kind: 'efficiency',
    title: 'Naming the same task twice in one run runs it once',
    why: 'A script that builds its task list from parts can name a task twice. The run is still one request for that work. Running it twice doubles the time and races two copies over the same outputs.',
    from: ['task-selection', 'run-shapes'],
    needs: ['multi-task'],
    workspace: one(task(CONCAT)),
    steps: [
      {
        run: 'build',
        also: ['build'],
        expect: { exit: 0, ran: ['a#build'], files: { [`${A}/dist/out.txt`]: 'a\n' } },
      },
    ],
  }),

  // Nx run.test.ts run-many --projects a,a: a project named twice
  defineCase({
    id: 'graph/project-named-twice-runs-once',
    category: 'graph',
    kind: 'efficiency',
    title: 'Naming the same project twice in one run runs its task once',
    why: 'A CI script that joins lists of changed projects often repeats one. Selection is a set, not a list. Running the task twice doubles the work and races two copies over the same outputs.',
    from: ['select', 'filter'],
    workspace: { projects: { a: chainProject('a'), b: chainProject('b') } },
    steps: [
      {
        run: 'build',
        projects: ['a', 'a'],
        expect: { exit: 0, ran: ['a#build'], notRan: ['b#build'] },
      },
    ],
  }),

  // Turborepo engine builder: `^build` and `lib#build` name one edge twice
  defineCase({
    id: 'graph/caret-and-explicit-edge-to-one-task-run-it-once',
    category: 'graph',
    kind: 'efficiency',
    title:
      'A task that reaches one dependency both by `^build` and by `lib#build` runs it once, first',
    why: 'Two ways of naming one edge are still one edge. A graph that adds a node per spelling builds the library twice, the second time while the app may already be reading its output. The library runs once, before the app.',
    from: ['task-graph', 'graph-order'],
    workspace: {
      projects: {
        lib: chainProject('lib'),
        app: {
          deps: ['lib'],
          tasks: {
            build: task('mkdir -p dist && cat ../lib/dist/out.txt src/*.txt > dist/out.txt', {
              dependsOn: ['^build', 'lib#build'],
            }),
          },
          files: { 'src/a.txt': 'app\n' },
        },
      },
    },
    steps: [
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['lib#build', 'app#build'],
          order: [['lib#build', 'app#build']],
          files: { [out('app')]: 'lib\napp\n' },
        },
      },
    ],
  }),

  // Nx create-task-graph.spec.ts: a duplicated dependsOn entry
  defineCase({
    id: 'graph/prerequisite-named-twice-runs-once',
    category: 'graph',
    kind: 'efficiency',
    title: 'A prerequisite listed twice in `dependsOn` runs once, before the task',
    why: 'A list merged from shared config can repeat an entry. It names one prerequisite, and that is one run of it. Running it twice doubles the work and can rewrite its output while the task reads it.',
    from: ['task-graph', 'dependency-rules'],
    workspace: {
      projects: {
        a: {
          tasks: {
            gen: task('mkdir -p gen && cat src/*.txt > gen/out.txt', { outputs: ['gen/**'] }),
            build: task('mkdir -p dist && cat gen/out.txt > dist/out.txt', {
              dependsOn: ['gen', 'gen'],
            }),
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    steps: [
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['a#gen', 'a#build'],
          order: [['a#gen', 'a#build']],
          files: { [`${A}/dist/out.txt`]: 'a\n' },
        },
      },
    ],
  }),

  // Nx run.test.ts 'should run multiple targets': a task asked for beside its own prerequisite
  defineCase({
    id: 'graph/task-asked-for-beside-its-prerequisite',
    category: 'graph',
    kind: 'correctness',
    title: 'Asking for a task and its prerequisite in one run runs the prerequisite once, first',
    why: 'The prerequisite is both requested and needed; it is one task either way. A tool that schedules the requested copy apart from the needed one runs it twice, or lets the task start before it. It runs once and the task follows it.',
    from: ['task-selection', 'task-graph'],
    needs: ['multi-task'],
    workspace: {
      projects: {
        a: {
          tasks: {
            gen: task('mkdir -p gen && cat src/*.txt > gen/out.txt', { outputs: ['gen/**'] }),
            build: task('mkdir -p dist && cat gen/out.txt > dist/out.txt', { dependsOn: ['gen'] }),
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    steps: [
      {
        run: 'build',
        also: ['gen'],
        expect: {
          exit: 0,
          ran: ['a#gen', 'a#build'],
          order: [['a#gen', 'a#build']],
          files: { [`${A}/dist/out.txt`]: 'a\n' },
        },
      },
    ],
  }),

  // moon action_pipeline_test.rs runs_in_parallel_with_other_tasks / doesnt_block_serial_dependencies
  defineCase({
    id: 'graph/dependant-does-not-wait-for-unrelated-work',
    category: 'graph',
    kind: 'efficiency',
    title:
      'A task starts as soon as its own dependencies are done, while unrelated work still runs',
    why: 'A scheduler that runs the graph level by level holds the app until every first-level task ends, including a slow one it does not need. That wait is the whole slow task, every run. The slow task here ends only once it sees the app’s output, so it passes only if the app is not held for it.',
    from: ['scheduler', 'graph-order'],
    workspace: {
      projects: {
        lib: chainProject('lib'),
        app: chainProject('app', ['lib']),
        slow: {
          tasks: {
            build: task(
              `${waitFor('../app/dist/out.txt', 15)}; test -f ../app/dist/out.txt && ${CONCAT}`,
            ),
          },
          files: { 'src/a.txt': 'slow\n' },
        },
      },
    },
    steps: [
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['lib#build', 'app#build', 'slow#build'],
          files: { [out('slow')]: 'slow\n' },
        },
      },
    ],
  }),

  // Nx tasks-schedule.spec.ts: a task with many dependencies
  defineCase({
    id: 'graph/forty-dependencies-all-build-first',
    category: 'graph',
    kind: 'correctness',
    title: 'An app depending on forty libraries builds after every one of them',
    why: 'Wide fan-in is the shape of a real app over many packages. Every library must end before the app starts, and none may be dropped or run twice. The app’s output holds every library’s line, in order.',
    from: ['scale-graph', 'graph-order'],
    workspace: {
      projects: Object.fromEntries([
        ...Array.from({ length: 40 }, (_, i) => [
          `l${String(i).padStart(2, '0')}`,
          chainProject(`l${String(i).padStart(2, '0')}`),
        ]),
        [
          'app',
          chainProject(
            'app',
            Array.from({ length: 40 }, (_, i) => `l${String(i).padStart(2, '0')}`),
          ),
        ],
      ]),
    },
    steps: [
      {
        run: 'build',
        projects: ['app'],
        expect: {
          exit: 0,
          ran: ['l00#build', 'l39#build', 'app#build'],
          order: [
            ['l00#build', 'app#build'],
            ['l39#build', 'app#build'],
          ],
          files: {
            [out('app')]:
              `${Array.from({ length: 40 }, (_, i) => `l${String(i).padStart(2, '0')}\n`).join('')}app\n`,
          },
          within: 120,
        },
      },
    ],
  }),

  // Turborepo affected_test.rs: the base and head trees are compared, not the commits between
  defineCase({
    id: 'affected/change-and-its-revert-select-nothing',
    category: 'affected',
    kind: 'efficiency',
    title: 'A commit and a later commit reverting it select nothing',
    why: 'What a branch changed is the difference between the base and the tip, not the list of files its commits touched. After a revert the files are as they were at the base, so nothing needs to run. A tool that walks the commits runs the project for a change that is gone.',
    from: ['affected', 'affected-head-range'],
    needs: ['affected'],
    workspace: { projects: { a: chainProject('a'), b: chainProject('b') } },
    steps: [
      { write: { 'packages/a/src/a.txt': 'a2\n' } },
      { commit: 'change a' },
      { write: { 'packages/a/src/a.txt': 'a\n' } },
      { commit: 'revert a' },
      {
        affected: 'build',
        base: 'HEAD~2',
        expect: { exit: 0, notRan: ['a#build', 'b#build'] },
      },
    ],
  }),

  // moon affected_tracker_test.rs not_affected_by_file_if_content_doesnt_match
  defineCase({
    id: 'affected/rewrite-with-same-bytes-selects-nothing',
    category: 'affected',
    kind: 'efficiency',
    title: 'A source written again with the same bytes selects nothing',
    why: 'An editor’s save-all, a formatter that changes nothing or a code generator run again rewrite files with the bytes they already hold. Only the time stamp moved. A tool that trusts the stat over the content selects every project touched.',
    from: ['affected', 'affected-weak-stat'],
    needs: ['affected'],
    workspace: { projects: { a: chainProject('a'), b: chainProject('b') } },
    steps: [
      { sh: 'sleep 1.1 && printf "a\\n" > packages/a/src/a.txt' },
      { affected: 'build', base: 'HEAD', expect: { exit: 0, notRan: ['a#build', 'b#build'] } },
    ],
  }),

  // Turborepo affected_test.rs: a committed mode change is a change
  defineCase({
    id: 'affected/committed-mode-change-selects-its-project',
    category: 'affected',
    kind: 'correctness',
    title: 'A committed change that only makes a file executable selects its project',
    why: 'Git records a file’s executable bit, and a diff that changes only the mode is still a diff. A task can depend on the bit: a packager keeps it, a check tests it. A tool that compares only content leaves the project out.',
    from: ['affected', 'affected-weak-stat'],
    needs: ['affected'],
    workspace: { projects: { a: chainProject('a'), b: chainProject('b') } },
    steps: [
      { chmod: { 'packages/a/src/a.txt': 0o755 } },
      { commit: 'mode' },
      {
        affected: 'build',
        base: 'HEAD~1',
        expect: { exit: 0, ran: ['a#build'], notRan: ['b#build'] },
      },
    ],
  }),

  // Turborepo affected_test.rs with a failing affected package
  defineCase({
    id: 'affected/failure-skips-only-its-dependants',
    category: 'affected',
    kind: 'correctness',
    title:
      'In an affected run, a failing project skips its dependants and the other changed project still runs',
    why: 'An affected run is a run like any other over fewer projects, and the failure rules are the same. The failure’s dependant must not run, and an unrelated changed project must. The run fails.',
    from: ['affected', 'failure-mode'],
    needs: ['affected'],
    workspace: {
      projects: {
        lib: { tasks: { build: task(FRAGILE) }, files: { 'src/a.txt': 'lib\n' } },
        app: chainProject('app', ['lib']),
        docs: chainProject('docs'),
      },
    },
    steps: [
      { write: { 'packages/lib/src/a.txt': 'bad\n', 'packages/docs/src/a.txt': 'docs2\n' } },
      { commit: 'change lib and docs' },
      {
        affected: 'build',
        base: 'HEAD~1',
        expect: {
          exit: 'fail',
          ran: ['lib#build', 'docs#build'],
          notRan: ['app#build'],
          files: { [out('docs')]: 'docs2\n' },
        },
      },
    ],
  }),

  // Turborepo strict_env_vars.rs: a declared variable set to the empty string
  defineCase({
    id: 'env/empty-declared-value-reaches-task-as-set',
    category: 'env',
    kind: 'correctness',
    title: 'A declared variable set to the empty string reaches the task as set, not as missing',
    why: 'Shell scripts tell `FOO=` from no `FOO` with `${FOO+set}`, and tools mean different things by them: an empty `NODE_OPTIONS` clears inherited flags. A runner that drops empty values from the task’s environment turns one into the other. The task sees the variable set.',
    from: ['env', 'env-properties'],
    needs: ['env-inputs'],
    workspace: one(task('mkdir -p dist && echo "${MODE+set}" > dist/out.txt', { env: ['MODE'] })),
    steps: [
      {
        run: 'build',
        env: { MODE: '' },
        expect: { exit: 0, files: { [`${A}/dist/out.txt`]: 'set\n' } },
      },
    ],
  }),

  // Turborepo strict_env_vars.rs: HOME is always passed through
  defineCase({
    id: 'env/home-reaches-task',
    category: 'env',
    kind: 'correctness',
    title: 'The runner’s `HOME` reaches the task unchanged',
    why: 'Git, npm, SSH and most CLIs find their config under `HOME`. A runner that resets or drops it makes a task read another user’s config, or none. The task sees the `HOME` the run was started with.',
    from: ['env', 'home-guard'],
    workspace: one(
      task(
        'mkdir -p dist && { test "$HOME" = "$(cd ../.. && pwd -P)/h" && echo same || echo "$HOME"; } > dist/out.txt',
      ),
    ),
    steps: [
      { sh: 'mkdir -p h' },
      {
        run: 'build',
        env: { HOME: '$ROOT/h' },
        expect: { exit: 0, files: { [`${A}/dist/out.txt`]: 'same\n' } },
      },
    ],
  }),

  // Turborepo graceful_shutdown_test.rs: a task that starts a detached daemon and exits
  defineCase({
    id: 'failure/detached-daemon-does-not-hold-the-run',
    category: 'failure',
    kind: 'correctness',
    title: 'A task that starts a detached background service and exits lets the run end',
    why: 'Some tasks start a daemon, such as a build server, a database or a Gradle daemon, that closes its streams and leaves the session on purpose. The task has ended, and so has everything the runner gave it. A runner that waits for every process it ever saw hangs until the daemon dies.',
    from: ['task-tree-kill', 'keep-alive'],
    workspace: one(task(`setsid sh -c 'sleep 15' </dev/null >/dev/null 2>&1 & ${CONCAT}`)),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [`${A}/dist/out.txt`]: 'a\n' }, within: 10 } },
    ],
  }),
  // Turborepo process_launcher_test.rs / Vite Task #675: what a task's programs inherit
  defineCase({
    id: 'failure/task-gets-the-default-broken-pipe-signal',
    category: 'failure',
    kind: 'correctness',
    title: 'A program in a task whose reader quits is ended by SIGPIPE, as it is in a terminal',
    why: 'Runtimes that ignore SIGPIPE for themselves can pass that setting on to every process they spawn. Then `yes | head -1` no longer ends `yes` quietly: it gets a write error, prints it and exits 1, and scripts built on pipes behave unlike in a terminal. The task sees `yes` killed by the signal, status 141.',
    from: ['runner', 'signal-death'],
    workspace: one(
      task(
        'mkdir -p dist && { yes; echo $? > dist/status; } | head -c 1 > /dev/null; cat dist/status > dist/out.txt; rm dist/status',
      ),
    ),
    steps: [{ run: 'build', expect: { exit: 0, files: { [`${A}/dist/out.txt`]: '141\n' } } }],
  }),

  // Vite Task CHANGELOG #939: an EXIT trap keeps the failing status
  defineCase({
    id: 'failure/exit-trap-keeps-the-failure',
    category: 'failure',
    kind: 'correctness',
    title: 'A command whose EXIT trap runs after a failure still fails the task',
    why: 'Scripts clean up in an `EXIT` trap, and a bare `exit` inside it keeps the status the script was leaving with. A shell that reports the trap’s own status turns every failing script with a cleanup trap into a pass. The trap runs, and the task fails and is not cached.',
    from: ['exit-trap-cleanup.unsafe', 'task-shell'],
    workspace: one(task(`trap 'echo cleaned > cleaned.txt; exit' EXIT; ${CONCAT}; exit 3`)),
    steps: [
      { run: 'build', expect: { exit: 'fail', files: { [`${A}/cleaned.txt`]: 'cleaned\n' } } },
      { run: 'build', expect: { exit: 'fail', ran: ['a#build'] } },
    ],
  }),

  // Vite Task CHANGELOG #939: a `while read` loop with a redirect under `set -e`
  defineCase({
    id: 'env/command-while-read-loop-under-set-e',
    category: 'env',
    kind: 'correctness',
    title: 'A `while read` loop over a file under `set -e` runs to its end and the command goes on',
    why: 'The loop’s last `read` fails at the end of the file; that ends the loop and, by POSIX, does not trip `set -e`. A shell that treats it as a failure stops the command right after the loop. Every line is read and the step after the loop runs.',
    from: ['task-shell', 'shell-verdict'],
    workspace: one(
      task(
        'set -e; mkdir -p dist; while read l; do echo "<$l>"; done < src/a.txt > dist/out.txt; echo after >> dist/out.txt',
      ),
      { 'src/a.txt': 'one\ntwo\n' },
    ),
    steps: [
      {
        run: 'build',
        expect: { exit: 0, files: { [`${A}/dist/out.txt`]: '<one>\n<two>\nafter\n' } },
      },
    ],
  }),

  // Vite Task CHANGELOG #788: a shebang naming an interpreter path over 126 bytes
  defineCase({
    id: 'failure/script-with-a-long-shebang-runs',
    category: 'failure',
    kind: 'correctness',
    title: 'A script whose shebang names an interpreter by a path over 150 bytes long runs',
    why: 'Deep install directories, as Nix or a CI cache leaves them, give interpreters long paths, and Linux reads up to 255 bytes of a shebang. A runner that wraps or traces exec and cuts the line shorter starts the wrong program or none. The script runs and prints its line.',
    from: ['binary-launch', 'runner'],
    workspace: one(
      task(
        'X=$(printf "x%.0s" $(seq 70)); mkdir -p "l/$X/$X" && ln -sf /bin/sh "l/$X/$X/sh" && printf "#!%s\\necho ok\\n" "$PWD/l/$X/$X/sh" > run.sh && chmod +x run.sh && mkdir -p dist && ./run.sh > dist/out.txt',
      ),
    ),
    steps: [{ run: 'build', expect: { exit: 0, files: { [`${A}/dist/out.txt`]: 'ok\n' } } }],
  }),

  // Vite Task CHANGELOG #940: a task that writes beside the workspace through `..`
  defineCase({
    id: 'cache/task-writing-beside-the-workspace-is-cached',
    category: 'cache',
    kind: 'efficiency',
    title: 'A task that also copies a file beside the workspace through `..` is still cached',
    why: 'Deploy steps copy a build into a sibling directory (`cp -r dist ../site`). What lands outside the workspace is no output, but it does not make the task uncacheable either. A tool that fails to store a task over such a path rebuilds it every run. The second run replays.',
    from: ['undeclared-writes', 'task-save'],
    workspace: {
      ...one(task(`cp src/a.txt ../../../outside/copy.txt && ${CONCAT}`)),
      outside: { 'keep.txt': 'keep\n' },
    },
    steps: [
      { run: 'build', expect: { exit: 0, files: { '../outside/copy.txt': 'a\n' } } },
      {
        run: 'build',
        expect: { exit: 0, notRan: ['a#build'], files: { [`${A}/dist/out.txt`]: 'a\n' } },
      },
    ],
  }),

  // Nx run.test.ts 'Nx Bail' with a task past its time limit
  defineCase({
    id: 'failure/fail-fast-on-a-timeout',
    category: 'failure',
    kind: 'correctness',
    title: 'A task killed at its time limit stops a fail-fast run like any failure',
    why: 'A time limit turns a hang into a failure, and fail-fast must treat it as one. A run that stops at exit codes but not at timeouts keeps every other task running after the first one hung. The slow task is stopped before it writes its file.',
    from: ['fail-fast', 'task-timeout'],
    needs: ['fail-fast', 'timeout'],
    workspace: {
      projects: {
        hang: { tasks: { build: { command: 'sleep 30', timeout: 1, cache: false } } },
        slow: { tasks: { build: { command: 'sleep 12 && echo done > out.txt', cache: false } } },
      },
    },
    steps: [
      {
        run: 'build',
        failFast: true,
        expect: { exit: 'fail', files: { 'packages/slow/out.txt': null }, within: 10, alone: true },
      },
    ],
  }),

  // vx watch-loop-uncached / moon runs_every_time_instead_of_being_hydrated, under watch
  defineCase({
    id: 'watch/uncached-task-reruns-on-edit',
    category: 'watch',
    kind: 'correctness',
    title: 'Editing the input of a task that is never cached while watching runs it again, once',
    why: 'A task kept out of the cache still has inputs, and an edit to them is a reason to run it. A watch that only reacts for cached tasks never reruns it; one that hears the task’s own outputs reruns it in a loop. It runs once with the edit.',
    from: ['watch-loop-uncached', 'uncached-outputs'],
    needs: ['watch', 'uncached-task'],
    workspace: {
      projects: {
        app: { tasks: { build: task(CONCAT, { cache: false }) }, files: { 'src/a.txt': 'a1\n' } },
      },
    },
    steps: [
      {
        watch: 'build',
        phases: [
          { expect: { ran: ['app#build'], files: { [out('app')]: 'a1\n' } } },
          {
            write: { 'packages/app/src/a.txt': 'a2\n' },
            expect: { ran: ['app#build'], files: { [out('app')]: 'a2\n' } },
          },
        ],
      },
    ],
  }),

  // Turborepo affected_rdeps_test.rs test_staged_rename_affects_source_destination_and_reverse_deps, under watch
  defineCase({
    id: 'watch/file-moved-between-projects-rebuilds-both',
    category: 'watch',
    kind: 'correctness',
    title: 'Moving a source from one project to another while watching rebuilds both',
    why: 'A move is a deletion in one project and a creation in the other. Each side changes what one project reads. A watch that maps the event to only one owner leaves the other project’s output with the file still in it, or still without it.',
    from: ['watch-loop-members', 'affected-moves'],
    needs: ['watch'],
    workspace: {
      projects: {
        a: chainProject('a', [], { files: { 'src/m.txt': 'm\n' } }),
        b: chainProject('b'),
      },
    },
    steps: [
      {
        watch: 'build',
        phases: [
          { expect: { ran: ['a#build', 'b#build'], files: { [out('a')]: 'a\nm\n' } } },
          {
            sh: 'mv packages/a/src/m.txt packages/b/src/m.txt',
            expect: {
              ran: ['a#build', 'b#build'],
              files: { [out('a')]: 'a\n', [out('b')]: 'b\nm\n' },
            },
          },
        ],
      },
    ],
  }),

  // Turborepo watch_test.rs watch_initial_run_executes_tasks, with a failing first run
  defineCase({
    id: 'watch/failed-first-run-keeps-watching',
    category: 'watch',
    kind: 'correctness',
    title:
      'A watch whose very first build fails keeps watching and builds once the source is fixed',
    why: 'People start a watch on broken code all the time, mid-refactor. A watch that exits, or stops listening, when its first run fails makes the user restart it after every fix. The fix must rebuild like any later edit.',
    from: ['watch-loop', 'watch-signals'],
    needs: ['watch'],
    workspace: {
      projects: {
        app: { tasks: { build: task(FRAGILE) }, files: { 'src/a.txt': 'bad\n' } },
      },
    },
    steps: [
      {
        watch: 'build',
        phases: [
          { expect: { files: { [out('app')]: 'partial\n' } } },
          {
            write: { 'packages/app/src/a.txt': 'good\n' },
            expect: { ran: ['app#build'], files: { [out('app')]: 'good\n' } },
          },
        ],
      },
    ],
  }),

  // Turborepo gitignored_inputs_test.rs test_gitignored_file_in_explicit_inputs, under watch
  defineCase({
    id: 'watch/gitignored-input-named-outright-reruns',
    category: 'watch',
    kind: 'correctness',
    title:
      'Editing a gitignored file the task names in its inputs while watching runs the task again',
    why: 'Generated files and local config are often gitignored and still read by a build that declares them. A watch that skips ignored paths for speed misses the edit, though a run would key it. The task reruns with the edit.',
    from: ['watch-unignored-deletion', 'ignored-inputs'],
    needs: ['watch'],
    workspace: {
      projects: {
        app: {
          tasks: {
            build: task('mkdir -p dist && cat src/*.txt gen/*.txt > dist/out.txt', {
              inputs: ['src/**', 'gen/**'],
            }),
          },
          files: { 'src/a.txt': 'a\n', 'gen/g.txt': 'g1\n', '.gitignore': 'gen\n' },
        },
      },
    },
    steps: [
      {
        watch: 'build',
        phases: [
          { expect: { ran: ['app#build'], files: { [out('app')]: 'a\ng1\n' } } },
          {
            write: { 'packages/app/gen/g.txt': 'g2\n' },
            expect: { ran: ['app#build'], files: { [out('app')]: 'a\ng2\n' } },
          },
        ],
      },
    ],
  }),

  // Nx create-task-graph.spec.ts: task names are matched whole
  defineCase({
    id: 'graph/task-name-with-a-dot-is-one-name',
    category: 'graph',
    kind: 'correctness',
    title: 'A task named `build.prod` and a task named `build` are each run only when asked for',
    why: 'Dots are common in task names (`test.unit`, `build.prod`). A tool that reads a dot as a separator or a pattern runs `build` with `build.prod`, or the reverse. Each name selects exactly its own task.',
    from: ['task-selection', 'cli-task-names'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: task('mkdir -p out && cat src/*.txt > out/b.txt', { outputs: ['out/**'] }),
            'build.prod': task('mkdir -p prod && cat src/*.txt > prod/p.txt', {
              outputs: ['prod/**'],
            }),
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    steps: [
      {
        run: 'build.prod',
        expect: { exit: 0, ran: ['a#build.prod'], notRan: ['a#build'] },
      },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], notRan: ['a#build.prod'] } },
    ],
  }),

  // Turborepo affected_test.rs test_affected_merge_base_diverged: the base merged back into the branch
  defineCase({
    id: 'affected/base-merged-into-branch-selects-only-branch-work',
    category: 'affected',
    kind: 'efficiency',
    title:
      'After merging the base branch into a feature branch, only the feature’s own changes are selected',
    why: 'Keeping a branch current by merging main into it is everyday work. What the branch changed is still only its own work: what came in from main is already on main. A tool that diffs against the old fork point runs every project main touched since.',
    from: ['affected', 'affected-head-range'],
    needs: ['affected'],
    workspace: { projects: { a: chainProject('a'), b: chainProject('b') } },
    steps: [
      {
        sh: 'git checkout -q -b feat && echo a2 > packages/a/src/a.txt && git commit -qam a && git checkout -q main && echo b2 > packages/b/src/a.txt && git commit -qam b && git checkout -q feat && git merge -q --no-edit main',
      },
      {
        affected: 'build',
        base: 'main',
        expect: { exit: 0, ran: ['a#build'], notRan: ['b#build'] },
      },
    ],
  }),
  // Nx task-orchestrator.spec.ts 'should not start a later wave once the run bails', with retries
  defineCase({
    id: 'failure/fail-fast-spends-every-retry-first',
    category: 'failure',
    kind: 'correctness',
    title: 'A fail-fast run gives a failing task all its retries before it stops',
    why: 'A task with two retries has three attempts, and fail-fast acts on the task’s failure, not on its first attempt. Stopping after one attempt makes retries mean nothing in exactly the runs that use fail-fast, CI runs. The task is tried three times, then the run stops the slow task beside it.',
    from: ['fail-fast', 'retries'],
    needs: ['fail-fast', 'retries'],
    workspace: {
      projects: {
        flaky: {
          tasks: {
            build: { command: 'echo t >> ../../tries.txt; exit 1', retries: 2, cache: false },
          },
        },
        slow: { tasks: { build: { command: 'sleep 15 && echo done > out.txt', cache: false } } },
      },
    },
    steps: [
      {
        run: 'build',
        failFast: true,
        expect: {
          exit: 'fail',
          files: { 'tries.txt': 't\nt\nt\n', 'packages/slow/out.txt': null },
          within: 12,
        },
      },
    ],
  }),

  // Nx #32857: a long TMPDIR made the runner hang
  defineCase({
    id: 'env/long-temp-directory-path',
    category: 'env',
    kind: 'correctness',
    title: 'A run whose TMPDIR path is over 150 bytes long still runs and caches its task',
    why: 'A Unix socket path may hold about 100 bytes, and a runner that puts its sockets or lock files under TMPDIR breaks when that path is long, as on macOS or in nested CI workspaces. The task must run, see the TMPDIR it was given, and replay next time.',
    from: ['tmpdir-refusal', 'sandbox-temp-vars.unsafe'],
    workspace: one(
      task(
        'mkdir -p dist && { test -d "$TMPDIR" && test "${#TMPDIR}" -gt 150 && echo long || echo "$TMPDIR"; } > dist/out.txt',
      ),
    ),
    steps: [
      {
        sh: `mkdir -p ${'.home/t'.padEnd(8, '/')}${'d'.repeat(60)}/${'e'.repeat(60)}/${'f'.repeat(30)}`,
      },
      {
        run: 'build',
        env: { TMPDIR: `$ROOT/.home/t/${'d'.repeat(60)}/${'e'.repeat(60)}/${'f'.repeat(30)}` },
        expect: { exit: 0, files: { [`${A}/dist/out.txt`]: 'long\n' } },
      },
      {
        run: 'build',
        env: { TMPDIR: `$ROOT/.home/t/${'d'.repeat(60)}/${'e'.repeat(60)}/${'f'.repeat(30)}` },
        expect: { exit: 0, notRan: ['a#build'] },
      },
    ],
  }),

  // Turborepo affected_test.rs: what is compared is the work tree, not only the index
  defineCase({
    id: 'affected/staged-edit-undone-in-the-work-tree-selects-nothing',
    category: 'affected',
    kind: 'efficiency',
    title: 'An edit that is staged but undone in the work tree selects nothing',
    why: 'Tasks read the files on disk, and those match the base again. Only git’s index still holds the edit, and the next `git add` drops it. A tool that unions the staged and unstaged diffs selects a project whose files did not change.',
    from: ['affected', 'affected-weak-stat'],
    needs: ['affected'],
    workspace: { projects: { a: chainProject('a'), b: chainProject('b') } },
    steps: [
      { write: { 'packages/a/src/a.txt': 'a2\n' } },
      { sh: 'git add -A' },
      { write: { 'packages/a/src/a.txt': 'a\n' } },
      { affected: 'build', base: 'HEAD', expect: { exit: 0, notRan: ['a#build', 'b#build'] } },
    ],
  }),

  // Nx create-task-graph.spec.ts / Turborepo task ids: names beyond ASCII
  defineCase({
    id: 'graph/non-ascii-task-name-runs',
    category: 'graph',
    kind: 'correctness',
    title: 'A task named in non-ASCII letters runs when asked for by that name',
    why: 'Task names come from people, and not all of them write in ASCII. A tool that mangles the name on its way through the CLI, the config or a shell finds no task, or another one. The task runs, and the second run replays it.',
    from: ['cli-task-names', 'task-selection'],
    workspace: {
      projects: {
        a: { tasks: { bâtir: task(CONCAT) }, files: { 'src/a.txt': 'a\n' } },
      },
    },
    steps: [
      {
        run: 'bâtir',
        expect: { exit: 0, ran: ['a#bâtir'], files: { [`${A}/dist/out.txt`]: 'a\n' } },
      },
      { run: 'bâtir', expect: { exit: 0, notRan: ['a#bâtir'] } },
    ],
  }),

  // Turborepo tests: a task named like one of the runner's own commands
  defineCase({
    id: 'graph/task-named-help-runs',
    category: 'graph',
    kind: 'correctness',
    title: 'A task named `help` runs like any other task',
    why: 'Projects name tasks `help`, `info` or `version` for their own reasons. Once named as a task to run, the word is a task name, not the runner’s own command or flag. The task runs and writes its output.',
    from: ['cli-task-names', 'task-verb'],
    workspace: {
      projects: { a: { tasks: { help: task(CONCAT) }, files: { 'src/a.txt': 'a\n' } } },
    },
    steps: [
      {
        run: 'help',
        expect: { exit: 0, ran: ['a#help'], files: { [`${A}/dist/out.txt`]: 'a\n' } },
      },
    ],
  }),

  // moon affected_tracker_test.rs empty_if_no_changed_files: git tracks no directories
  defineCase({
    id: 'affected/new-empty-directory-selects-nothing',
    category: 'affected',
    kind: 'efficiency',
    title: 'A new empty directory inside a project selects nothing',
    why: 'Git tracks files, not directories, and an empty directory changes no file a task can read through a glob. A tool that diffs directory listings selects the project for a `mkdir`. Nothing runs.',
    from: ['affected', 'unlistable-input-dir'],
    needs: ['affected'],
    workspace: { projects: { a: chainProject('a'), b: chainProject('b') } },
    steps: [
      { sh: 'mkdir -p packages/a/src/empty/deeper' },
      { affected: 'build', base: 'HEAD', expect: { exit: 0, notRan: ['a#build', 'b#build'] } },
    ],
  }),

  // moon / Turborepo globs: a glob matches files, not directories
  defineCase({
    id: 'cache/new-empty-directory-under-inputs-replays',
    category: 'cache',
    kind: 'efficiency',
    title: 'A new empty directory under a task’s input glob lets the task replay',
    why: 'An input glob names files; an empty directory adds none. Editors, test runners and `mkdir -p` leave empty directories all the time. A tool that keys directory entries rebuilds for each one.',
    from: ['inputs-resolution', 'unlistable-input-dir'],
    workspace: one(task(CONCAT)),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { sh: `mkdir -p ${A}/src/empty/deeper` },
      {
        run: 'build',
        expect: { exit: 0, notRan: ['a#build'], files: { [`${A}/dist/out.txt`]: 'a\n' } },
      },
    ],
  }),

  // Turborepo dry_run_test.rs: a planned run of a task behind a persistent one
  defineCase({
    id: 'cache/dry-run-starts-no-server',
    category: 'cache',
    kind: 'correctness',
    title: 'Planning a run of a dev server does not start it',
    why: 'A planned run must not run anything, and a dev server is the costliest thing to start by mistake: it binds a port and never ends on its own. A tool that starts persistent tasks while planning leaves a server running. Nothing starts and the plan returns at once.',
    from: ['dry-no-writes', 'persistent'],
    needs: ['dry-run', 'persistent'],
    workspace: {
      projects: {
        app: {
          tasks: {
            dev: { command: 'touch dev.up; sleep 60', persistent: true },
          },
        },
      },
    },
    steps: [
      {
        run: 'dev',
        dry: true,
        expect: {
          exit: 0,
          notRan: ['app#dev'],
          files: { 'packages/app/dev.up': null },
          within: 20,
          alone: true,
        },
      },
    ],
  }),

  // Turborepo dry_run_test.rs: a planned run of a task that is never cached
  defineCase({
    id: 'cache/dry-run-runs-no-uncached-task',
    category: 'cache',
    kind: 'correctness',
    title: 'Planning a run does not run a task that is never cached',
    why: 'A task kept out of the cache runs on every real run, which is why it must be the first to skip when planning: a deploy or a publish is often exactly such a task. Nothing runs and no file appears.',
    from: ['dry-no-writes', 'uncached-no-lookup'],
    needs: ['dry-run', 'uncached-task'],
    workspace: {
      projects: { a: { tasks: { deploy: { command: 'touch deployed', cache: false } } } },
    },
    steps: [
      {
        run: 'deploy',
        dry: true,
        expect: { exit: 0, notRan: ['a#deploy'], files: { [`${A}/deployed`]: null } },
      },
    ],
  }),

  // Turborepo watch_test.rs watch_task_inputs_reruns_on_turbo_root_input_without_root_tasks
  defineCase({
    id: 'watch/root-input-edit-reruns-only-its-reader',
    category: 'watch',
    kind: 'efficiency',
    title: 'Editing a root file one project reads while watching reruns only that project',
    why: 'A root file is an input only of the tasks that declare it. A watch that treats every root edit as workspace-wide rebuilds every project for a change one of them reads. Only the reader reruns.',
    from: ['watch-root-scope', 'watch-label-workspace-wide'],
    needs: ['watch'],
    workspace: {
      projects: {
        reader: {
          tasks: {
            build: task('mkdir -p dist && cat ../../config/shared.txt src/*.txt > dist/out.txt', {
              rootInputs: ['config/shared.txt'],
            }),
          },
          files: { 'src/a.txt': 'r\n' },
        },
        other: chainProject('other'),
      },
      files: { 'config/shared.txt': 's1\n' },
    },
    steps: [
      {
        watch: 'build',
        phases: [
          { expect: { ran: ['reader#build', 'other#build'] } },
          {
            write: { 'config/shared.txt': 's2\n' },
            expect: {
              ran: ['reader#build'],
              notRan: ['other#build'],
              files: { [out('reader')]: 's2\nr\n' },
            },
          },
        ],
      },
    ],
  }),

  // Nx watch.test.ts: a dependency edge removed from the config while watching
  defineCase({
    id: 'watch/removed-edge-stops-dependency-reruns',
    category: 'watch',
    kind: 'efficiency',
    title:
      'Once an app no longer depends on a library, editing the library while watching leaves the app alone',
    why: 'The watch must follow the graph as it is now, not as it was when it started. With the edge gone, a library edit reaches nothing else. A watch that keeps the old graph rebuilds the app for every library change.',
    from: ['watch-rules', 'watch-loop-members'],
    needs: ['watch'],
    workspace: {
      projects: {
        lib: chainProject('lib'),
        app: {
          tasks: { build: task(CONCAT, { dependsOn: ['lib#build'] }) },
          files: { 'src/a.txt': 'app\n' },
        },
      },
    },
    steps: [
      {
        watch: 'build',
        phases: [
          { expect: { ran: ['lib#build', 'app#build'] } },
          {
            configure: (given) => {
              const ws = structuredClone(given)
              ws.projects.app!.tasks!.build = task(CONCAT)
              return ws
            },
            expect: { ran: ['app#build'], notRan: ['lib#build'] },
          },
          {
            write: { 'packages/lib/src/a.txt': 'lib2\n' },
            expect: {
              ran: ['lib#build'],
              notRan: ['app#build'],
              files: { [out('lib')]: 'lib2\n', [out('app')]: 'app\n' },
            },
          },
        ],
      },
    ],
  }),
  // Turborepo run_caching.rs: names git could read as options or pathspec magic
  defineCase({
    id: 'inputs/file-names-git-could-read-as-options',
    category: 'inputs',
    kind: 'correctness',
    title: 'Edits to inputs named `-n.txt`, `:(top)x.txt` and `a*b.txt` each run the task again',
    why: 'A tool that passes file names to git without `--` and literal pathspecs hands git an option, a pathspec keyword or a glob. Git then answers about other files or none, and the edit replays a stale build. Each file is edited untracked, then again once committed, and each edit runs the task.',
    from: ['git-trust', 'stale-hit-git-enumeration'],
    workspace: one(task(CONCAT), {
      'src/a.txt': 'a\n',
      'src/-n.txt': 'n1\n',
      'src/:(top)x.txt': 'x1\n',
      'src/a*b.txt': 's1\n',
    }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/src/-n.txt`]: 'n2\n' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { commit: 'names' },
      { write: { [`${A}/src/:(top)x.txt`]: 'x2\n' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { write: { [`${A}/src/a*b.txt`]: 's2\n' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['a#build'] },
      },
    ],
  }),

  // Turborepo affected_test.rs: a changed file named like an option
  defineCase({
    id: 'affected/file-named-like-an-option-selects-its-project',
    category: 'affected',
    kind: 'correctness',
    title: 'A committed edit to a file named `-n.txt` selects its project',
    why: 'Changed paths come back from git and often go to git again, or to another tool. A name starting with a dash read as an option drops the path, and the project looks unchanged. The project is selected.',
    from: ['affected', 'affected-unicode'],
    needs: ['affected'],
    workspace: {
      projects: {
        a: chainProject('a', [], { files: { 'src/-n.txt': 'n1\n' } }),
        b: chainProject('b'),
      },
    },
    steps: [
      { write: { 'packages/a/src/-n.txt': 'n2\n' } },
      { commit: 'dash' },
      {
        affected: 'build',
        base: 'HEAD~1',
        expect: { exit: 0, ran: ['a#build'], notRan: ['b#build'] },
      },
    ],
  }),

  // Turborepo run_caching.rs: `git stash -u` takes an untracked input away and back
  defineCase({
    id: 'cache/stash-of-an-untracked-input-replays-each-state',
    category: 'cache',
    kind: 'correctness',
    title:
      'Stashing an untracked input replays the build without it, and popping it replays the build with it',
    why: '`git stash -u` removes untracked files from disk and `pop` brings them back. Each state has been built once. A tool that remembers the untracked file without checking the disk replays the build that read it while the file is gone, or misses it once it is back.',
    from: ['stale-hit-git', 'absent-input'],
    workspace: one(task(CONCAT)),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [`${A}/dist/out.txt`]: 'a\n' } } },
      { write: { [`${A}/src/b.txt`]: 'b\n' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['a#build'], files: { [`${A}/dist/out.txt`]: 'a\nb\n' } },
      },
      { sh: 'git stash push -q -u -- packages/a/src' },
      {
        run: 'build',
        expect: { exit: 0, notRan: ['a#build'], files: { [`${A}/dist/out.txt`]: 'a\n' } },
      },
      { sh: 'git stash pop -q' },
      {
        run: 'build',
        expect: { exit: 0, notRan: ['a#build'], files: { [`${A}/dist/out.txt`]: 'a\nb\n' } },
      },
    ],
  }),

  // moon task_runner_test.rs: a task's timeout starts when its command does
  defineCase({
    id: 'failure/time-limit-does-not-count-the-wait-for-dependencies',
    category: 'failure',
    kind: 'correctness',
    title: 'A task’s time limit counts only its own command, not the wait for its dependencies',
    why: 'A one-second limit on a quick check means the check may take a second, not that the whole graph below it must finish within one. A runner that starts the clock when it plans the task kills it before it has run. The dependency takes 1.5 s, the task 0.2 s under a 1 s limit, and both pass.',
    from: ['task-timeout', 'timeout-bounds'],
    needs: ['timeout'],
    workspace: {
      projects: {
        lib: { tasks: { build: task(`sleep 1.5 && ${CONCAT}`) }, files: { 'src/a.txt': 'lib\n' } },
        app: {
          deps: ['lib'],
          tasks: { build: task(`sleep 0.2 && ${CONCAT}`, { dependsOn: ['^build'], timeout: 1 }) },
          files: { 'src/a.txt': 'app\n' },
        },
      },
    },
    steps: [
      {
        run: 'build',
        expect: { exit: 0, ran: ['lib#build', 'app#build'], files: { [out('app')]: 'app\n' } },
      },
    ],
  }),

  // moon action_pipeline_test.rs runs_with_a_single_permit, with a time limit
  defineCase({
    id: 'failure/time-limit-does-not-count-the-wait-for-a-slot',
    category: 'failure',
    kind: 'correctness',
    title:
      'At a concurrency of one, a task’s time limit does not count the time it waits for its turn',
    why: 'Under a concurrency limit a ready task can wait a long time for a free slot. That wait is the runner’s, not the task’s. A limit that counts it kills a quick task because another one was slow. Both tasks pass, in either order.',
    from: ['task-timeout', 'run-concurrency'],
    needs: ['timeout'],
    workspace: {
      projects: {
        slow: {
          tasks: { build: task(`sleep 1.5 && ${CONCAT}`) },
          files: { 'src/a.txt': 'slow\n' },
        },
        quick: {
          tasks: { build: task(`sleep 0.2 && ${CONCAT}`, { timeout: 1 }) },
          files: { 'src/a.txt': 'quick\n' },
        },
      },
    },
    steps: [
      {
        run: 'build',
        concurrency: 1,
        expect: {
          exit: 0,
          ran: ['slow#build', 'quick#build'],
          files: { [out('quick')]: 'quick\n' },
        },
      },
    ],
  }),
  // Turborepo tests: package.json script names may hold spaces
  defineCase({
    id: 'graph/task-name-with-a-space-runs',
    category: 'graph',
    kind: 'correctness',
    title: 'A task named `build all` runs when asked for by that name',
    why: 'Script names in package.json may hold spaces, and some projects use them. A runner that splits the name on its way through a shell, a config or its own task id finds `build` and `all`, or nothing. The task runs and replays next time.',
    from: ['cli-task-names', 'run-spaced-value'],
    workspace: {
      projects: { a: { tasks: { 'build all': task(CONCAT) }, files: { 'src/a.txt': 'a\n' } } },
    },
    steps: [
      {
        run: 'build all',
        expect: { exit: 0, ran: ['a#build all'], files: { [`${A}/dist/out.txt`]: 'a\n' } },
      },
      { run: 'build all', expect: { exit: 0, notRan: ['a#build all'] } },
    ],
  }),

  // Turborepo #12554 / #8765: ignore rules that live outside any .gitignore file
  defineCase({
    id: 'inputs/file-ignored-by-core-excludesfile-is-not-an-input',
    category: 'inputs',
    kind: 'efficiency',
    title:
      'A file ignored through git’s `core.excludesFile` is not an input, and editing it replays',
    why: 'Git reads ignore rules from `.gitignore` files, `.git/info/exclude` and the file `core.excludesFile` names, often a user’s editor junk list. A tool that reads only `.gitignore` files keys what git ignores, and every editor swap file reruns the build. The edit replays.',
    from: ['ignored-inputs', 'git-trust'],
    workspace: one(task(CONCAT), { 'src/a.txt': 'a\n', 'src/notes.swp': 's1\n' }),
    steps: [
      {
        sh: 'printf "*.swp\\n" > .git/my-excludes && git config core.excludesFile "$PWD/.git/my-excludes" && git rm -q --cached packages/a/src/notes.swp && git commit -qm untrack',
      },
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/src/notes.swp`]: 's2\n' } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
    ],
  }),

  // Turborepo #8765: `.git/info/exclude` is an ignore file too
  defineCase({
    id: 'affected/file-ignored-by-info-exclude-selects-nothing',
    category: 'affected',
    kind: 'efficiency',
    title: 'A new file that `.git/info/exclude` ignores selects nothing',
    why: 'Local ignore rules live in `.git/info/exclude`, never committed. Git treats a file they match as ignored, so it is no change. A tool that reads only `.gitignore` files selects the project for a scratch file the user told git to ignore.',
    from: ['affected', 'ignored-inputs'],
    needs: ['affected'],
    workspace: { projects: { a: chainProject('a'), b: chainProject('b') } },
    steps: [
      { sh: 'printf "*.scratch\\n" >> .git/info/exclude' },
      { write: { 'packages/a/src/notes.scratch': 'x\n' } },
      { affected: 'build', base: 'HEAD', expect: { exit: 0, notRan: ['a#build', 'b#build'] } },
    ],
  }),
  // Turborepo crates/turborepo-scm manual hashing: a workspace that is no git repository
  defineCase({
    id: 'cache/workspace-without-git-caches',
    category: 'cache',
    kind: 'correctness',
    title: 'A workspace that is not a git repository still caches, and an edit still runs the task',
    why: 'A tarball of sources, a Docker build context or a fresh scaffold has no `.git`. Files must then be keyed by reading them. The second run replays, and an edit runs the task again.',
    from: ['no-git-on-path', 'gitlink-without-git'],
    needs: ['without-git'],
    workspace: one(task(CONCAT)),
    steps: [
      { sh: 'rm -rf .git' },
      { run: 'build', expect: { exit: 0, files: { [`${A}/dist/out.txt`]: 'a\n' } } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
      { write: { [`${A}/src/a.txt`]: 'b\n' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['a#build'], files: { [`${A}/dist/out.txt`]: 'b\n' } },
      },
    ],
  }),
  // Turborepo process_launcher_test.rs: a task holds no descriptor of the runner's
  defineCase({
    id: 'failure/task-inherits-only-its-three-streams',
    category: 'failure',
    kind: 'correctness',
    title: 'A task starts with no open file descriptors beyond its input, output and error streams',
    why: 'A descriptor a runner leaks into a task can be another task’s output pipe, a lock or the cache database. A leaked pipe end keeps that pipe open after its own task exits, so the runner waits on it, and a backgrounded child can hold a lock for good. A program the task starts sees only descriptors 0, 1 and 2.',
    from: ['runner', 'spawn-off'],
    workspace: one(
      task(
        // A program the task starts, not the task's own shell: what a leak would reach.
        `mkdir -p dist && sh -c 'ls /proc/$$/fd' | sort -n | tr "\\n" " " > dist/out.txt`,
      ),
    ),
    steps: [{ run: 'build', expect: { exit: 0, files: { [`${A}/dist/out.txt`]: '0 1 2 ' } } }],
  }),
] as Case[]

export const pending: Case[] = []
