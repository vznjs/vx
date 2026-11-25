// A run's lifecycle beyond one task: what a stop reaches, what a time limit
// and a retry leave alone, how servers start, wait, stay up and stop, and
// that every run ends with nothing of it left running. Mined from
// Turborepo's graceful shutdown and stdin tests, Nx's continuous tasks,
// moon's action pipeline and retry tests, and vx's own signal, persistent,
// timeout and retry tests.
import { defineCase, MEET, type Case, type TaskSpec, type WorkspaceSpec } from '../src/spec.ts'
import { CONCAT } from './shapes.ts'

/** Wait (bounded, 20 s) for a file, then go on only if it is there. */
const until = (file: string) =>
  `i=0; until [ -e ${file} ] || [ $i -ge 400 ]; do sleep 0.05; i=$((i+1)); done; [ -e ${file} ]`

/** A loop that never ends on its own, so only a signal can end the task. */
const LOOP = 'while :; do sleep 0.05; done'

/** Seeded on its first attempt: fails then, passes on every later one. */
const FLAKY =
  'if [ -f flag.txt ]; then echo winning > out.txt; else touch flag.txt; echo losing > out.txt; exit 1; fi'

/** One project `app` with these tasks. */
const app = (tasks: Record<string, TaskSpec>): WorkspaceSpec => ({
  projects: { app: { tasks, files: { 'src/a.txt': 'app\n' } } },
})

/** One project per entry, each with one task named `task`. */
const each = (task: string, specs: Record<string, TaskSpec>): WorkspaceSpec => ({
  projects: Object.fromEntries(
    Object.entries(specs).map(([name, spec]) => [
      name,
      { tasks: { [task]: spec }, files: { 'src/a.txt': `${name}\n` } },
    ]),
  ),
})

/** Takes the one slot or marks an overlap, holds it a moment, gives it back. */
const SLOT =
  'if mkdir ../../slot 2>/dev/null; then :; else touch ../../overlap; exit 1; fi; sleep 0.3; rmdir ../../slot'

/** A server that writes its shell's pid, then runs until stopped. */
const SERVER = 'echo $$ > srv.pid; sleep 60'

/** A test that needs `srv` up: it waits for the file the server writes. */
const e2e = (file = 'up'): TaskSpec => ({
  command: `${until(file)} && echo ok > ok.txt`,
  dependsOn: ['srv'],
  cache: false,
})

export default [
  // Turborepo graceful_shutdown_test.rs: run_force_kills_after_timeout_without_tty (no new task after the stop)
  defineCase({
    id: 'failure/stop-starts-no-queued-task',
    category: 'failure',
    kind: 'correctness',
    title: 'Ctrl-C at a concurrency of 1 ends the running task and starts none of those waiting',
    why: 'At a concurrency of 1 the other tasks wait in a queue for the one slot. Ctrl-C ends the running task and with it the slot, and a scheduler that hands the freed slot to the next task in the queue goes on running after the user asked it to stop. Only the task that was running when the stop came may have started.',
    from: ['abort', 'run-concurrency'],
    workspace: each('work', {
      p0: { command: `echo x >> ../../count; touch ../../started; ${LOOP}` },
      p1: { command: `echo x >> ../../count; touch ../../started; ${LOOP}` },
      p2: { command: `echo x >> ../../count; touch ../../started; ${LOOP}` },
    }),
    steps: [
      {
        run: 'work',
        concurrency: 1,
        stop: { signal: 'SIGINT', when: 'started' },
        expect: { exit: 'fail', files: { count: 'x\n' }, within: 20, alone: true },
      },
    ],
  }),

  // Turborepo graceful_shutdown_test.rs: first_stop_request_waits_for_one_graceful_cleanup, with two tasks
  defineCase({
    id: 'failure/stop-reaches-every-running-task',
    category: 'failure',
    kind: 'correctness',
    title: 'Ctrl-C reaches every task that is running, and each one gets to clean up',
    why: 'A stop is for the whole run, not for the task the runner happens to look at first. Two tasks running side by side both hold state they need to put away, a lock file, a temp directory, a child process. Each must get the signal and the time to finish its handler before the run exits.',
    from: ['abort', 'signal-handling'],
    workspace: each('work', {
      a: { command: `trap 'echo INT > got.txt; exit 0' INT; touch started; ${LOOP}` },
      b: {
        command: `trap 'echo INT > got.txt; exit 0' INT; ${until('../a/started')}; touch started; ${LOOP}`,
      },
    }),
    steps: [
      {
        run: 'work',
        stop: { signal: 'SIGINT', when: 'packages/b/started' },
        expect: {
          exit: 'fail',
          files: { 'packages/a/got.txt': 'INT\n', 'packages/b/got.txt': 'INT\n' },
          within: 20,
          alone: true,
        },
      },
    ],
  }),

  // vx signal-death: a task killed by a signal vx did not send is an ordinary failure
  defineCase({
    id: 'failure/task-interrupting-itself-ends-only-itself',
    category: 'failure',
    kind: 'correctness',
    title: 'A task that dies of SIGINT on its own fails alone, and the task beside it finishes',
    why: 'A shell that sees its child die of SIGINT assumes the user pressed Ctrl-C and stops too. A runner must not reason that way: here nobody pressed anything, one task killed itself with SIGINT. That task fails and skips what depends on it, and the task running beside it goes on to finish.',
    from: ['signal-death', 'abort'],
    workspace: {
      projects: {
        a: { tasks: { build: { command: 'touch ../../a-dying; kill -INT $$; sleep 5' } } },
        b: {
          tasks: {
            build: { command: `${until('../../a-dying')} && sleep 0.5 && echo b > b.txt` },
          },
        },
        c: { deps: ['a'], tasks: { build: { command: 'echo c > c.txt', dependsOn: ['^build'] } } },
      },
    },
    steps: [
      {
        run: 'build',
        expect: {
          exit: 'fail',
          ran: ['b#build'],
          notRan: ['c#build'],
          files: { 'packages/b/b.txt': 'b\n', 'packages/c/c.txt': null },
          within: 20,
        },
      },
    ],
  }),

  // Nx run-outcome.spec.ts: an exit code is a task's outcome; 130 is no stop request
  defineCase({
    id: 'failure/task-exiting-130-is-an-ordinary-failure',
    category: 'failure',
    kind: 'correctness',
    title: 'A task that exits 130 fails alone, and the task beside it finishes',
    why: 'Exit status 130 is what a shell reports for a command Ctrl-C ended, and some tools exit with it when their own child was interrupted. To the runner it is only a task’s exit code: no signal reached the run. The task fails and skips its dependants, and an unrelated task still finishes.',
    from: ['signal-death', 'abort'],
    workspace: {
      projects: {
        a: { tasks: { build: { command: 'touch ../../a-dying; exit 130' } } },
        b: {
          tasks: {
            build: { command: `${until('../../a-dying')} && sleep 0.5 && echo b > b.txt` },
          },
        },
        c: { deps: ['a'], tasks: { build: { command: 'echo c > c.txt', dependsOn: ['^build'] } } },
      },
    },
    steps: [
      {
        run: 'build',
        expect: {
          exit: 'fail',
          ran: ['b#build'],
          notRan: ['c#build'],
          files: { 'packages/b/b.txt': 'b\n', 'packages/c/c.txt': null },
          within: 20,
        },
      },
    ],
  }),

  // vx task-tree-kill: a backgrounded child with its streams closed is invisible to a runner that tracks pipes
  defineCase({
    id: 'failure/stop-reaps-a-child-that-closed-its-streams',
    category: 'failure',
    kind: 'correctness',
    title: 'Ctrl-C ends a job the task backgrounded with its output sent to /dev/null',
    why: 'A runner that judges a task’s end by its output pipes closing never sees a background job that redirected its streams away. The job also has SIGINT ignored, as a shell starts every `&` job, so only the runner can end it. It belongs to the task, so the stop must take it too, or it runs on after the prompt is back.',
    from: ['task-tree-kill', 'signal-handling'],
    workspace: app({
      slow: { command: 'sleep 60 </dev/null >/dev/null 2>&1 & touch started; sleep 60' },
    }),
    steps: [
      {
        run: 'slow',
        stop: { signal: 'SIGINT', when: 'packages/app/started' },
        expect: { exit: 'fail', within: 20, alone: true },
      },
    ],
  }),

  // vx task-tree-kill: a timeout reaps the grandchild; here one that closed its streams
  defineCase({
    id: 'failure/timeout-reaps-a-child-that-closed-its-streams',
    category: 'failure',
    kind: 'correctness',
    title: 'A time limit ends a job the task backgrounded with its output sent to /dev/null',
    why: 'A job that redirects its output away holds none of the task’s pipes, so a runner that only waits for those pipes to close never learns it exists. The time limit is on the task’s whole tree, and that job is part of it. Left alive, it keeps working after the failure has been reported, writing files and holding ports.',
    from: ['task-tree-kill', 'task-timeout'],
    needs: ['timeout'],
    workspace: app({
      t: { command: 'sleep 60 </dev/null >/dev/null 2>&1 & sleep 60', timeout: 1 },
    }),
    steps: [{ run: 't', expect: { exit: 'fail', within: 20, alone: true } }],
  }),

  // Turborepo graceful_shutdown_test.rs: run_stops_with_task_when_parent_exits, a sidecar's child with closed streams
  defineCase({
    id: 'graph/server-child-that-closed-its-streams-stopped-at-the-end',
    category: 'graph',
    kind: 'correctness',
    title: 'A server’s child that sent its output to /dev/null is stopped when the run ends',
    why: 'Dev servers often start a helper, a type checker or a CSS watcher, with its output sent elsewhere. When the run stops the server, that helper must go with it, though it holds none of the server’s pipes. Otherwise every run of the test suite leaves one more helper running.',
    from: ['persistent-shutdown', 'task-tree-kill'],
    needs: ['persistent'],
    workspace: app({
      srv: { command: 'sleep 60 </dev/null >/dev/null 2>&1 & touch up; wait', persistent: true },
      e2e: e2e(),
    }),
    steps: [{ run: 'e2e', expect: { exit: 0, within: 30, alone: true } }],
  }),

  // vx persistent: a server whose shell exited before ready is stopped with its group
  defineCase({
    id: 'graph/server-that-closed-its-output-still-stopped',
    category: 'graph',
    kind: 'correctness',
    title: 'A server that closes its output streams is still stopped when the run ends',
    why: 'A server that sends its log to a file closes the streams the runner gave it, yet keeps running. A runner that reads the closed pipe as the server’s exit stops tracking it, and never stops it. The server is still a process the run started, and it must be gone when the run ends.',
    from: ['persistent', 'persistent-shutdown'],
    needs: ['persistent'],
    workspace: app({
      srv: { command: 'exec >/dev/null 2>&1; touch up; sleep 60', persistent: true },
      e2e: e2e(),
    }),
    steps: [{ run: 'e2e', expect: { exit: 0, within: 30, alone: true } }],
  }),

  // Turborepo graceful_shutdown_test.rs: run_finishes_successfully_without_shutdown_banner (no wait on pipes)
  defineCase({
    id: 'failure/child-left-holding-output-does-not-hold-the-run',
    category: 'failure',
    kind: 'correctness',
    title: 'A task that exits while a job it backgrounded still holds its output lets the run end',
    why: 'A script that ends with a job still running in the background has exited, and its exit status is the task’s result. The job still holds the output pipe the runner gave it, so a runner that waits for the pipe to close waits for the job instead. The run must end when the task does, not half a minute later.',
    from: ['task-tree-kill', 'keep-alive-sigkill'],
    workspace: app({
      build: {
        command: `sleep 30 & ${CONCAT}`,
        inputs: ['src/**'],
        outputs: ['dist/**'],
      },
    }),
    steps: [
      {
        run: 'build',
        expect: { exit: 0, files: { 'packages/app/dist/out.txt': 'app\n' }, within: 15 },
      },
    ],
  }),

  // Turborepo graceful_shutdown_test.rs: second_stop_request_force_kills_without_orphans, under --bail
  defineCase({
    id: 'failure/fail-fast-reaps-what-a-stopped-task-backgrounded',
    category: 'failure',
    kind: 'correctness',
    title: 'A fail-fast run ends what the tasks it stopped had backgrounded',
    why: 'A fail-fast run stops the tasks still running when one fails, and a task is its whole process tree. A job that task started in the background has SIGINT ignored and may not be the runner’s direct child. Killing only the task’s shell leaves that job running on after the run has failed.',
    from: ['task-tree-kill', 'abort'],
    needs: ['fail-fast'],
    workspace: each('build', {
      a: { command: `sh -c 'exec sleep 60' & touch ../../a-up; sleep 60` },
      b: { command: `${until('../../a-up')}; exit 1` },
    }),
    steps: [{ run: 'build', failFast: true, expect: { exit: 'fail', within: 20, alone: true } }],
  }),

  // vx task-timeout: a timeout kills only the timed-out task's own tree
  defineCase({
    id: 'failure/timeout-spares-the-task-beside-it',
    category: 'failure',
    kind: 'correctness',
    title:
      'A task killed at its time limit leaves the task beside it to finish, and that one is cached',
    why: 'A time limit belongs to one task, and so does the kill that enforces it. A runner that kills a whole shared process group, or stops the run, takes down an unrelated task halfway through its work. That task finishes, is cached, and replays on the next run while the timed-out one runs again.',
    from: ['task-timeout', 'task-tree-kill'],
    needs: ['timeout'],
    workspace: each('build', {
      a: { command: 'touch ../../a-up; sleep 60', timeout: 1 },
      b: {
        command: `${until('../../a-up')} && sleep 2 & wait; ${CONCAT}`,
        inputs: ['src/**'],
        outputs: ['dist/**'],
      },
    }),
    steps: [
      {
        run: 'build',
        expect: {
          exit: 'fail',
          ran: ['b#build'],
          files: { 'packages/b/dist/out.txt': 'b\n' },
          within: 30,
        },
      },
      { write: { 'a-up': null } },
      {
        run: 'build',
        expect: { exit: 'fail', ran: ['a#build'], notRan: ['b#build'], within: 30 },
      },
    ],
  }),

  // moon task_executor.rs: monitor_timeout watches one task's own process
  defineCase({
    id: 'failure/time-limit-stays-with-its-own-task',
    category: 'failure',
    kind: 'correctness',
    title: 'A dependency’s time limit does not bound the task that depends on it',
    why: 'A time limit is set on one task, sized to that task’s work. The task that runs after it may take far longer, and declared no limit at all. A runner that carries the limit along the edge, or starts it once for both, kills a healthy build.',
    from: ['task-timeout'],
    needs: ['timeout'],
    workspace: {
      projects: {
        lib: { tasks: { build: { command: 'echo lib > out.txt', timeout: 2 } } },
        app: {
          deps: ['lib'],
          tasks: {
            build: { command: 'sleep 3; echo app > out.txt', dependsOn: ['^build'] },
          },
        },
      },
    },
    steps: [
      {
        run: 'build',
        expect: { exit: 0, files: { 'packages/app/out.txt': 'app\n' }, within: 30 },
      },
    ],
  }),

  // vx run-concurrency + task-timeout: the slot a timed-out task held goes to the next task
  defineCase({
    id: 'graph/timeout-frees-its-slot',
    category: 'graph',
    kind: 'correctness',
    title: 'At a concurrency of 1, a task killed at its time limit hands the slot to the next one',
    why: 'The task the time limit killed is over, and its slot is free. A runner that keeps the slot held until the killed process is reaped by some later sweep, or never, leaves the rest of the queue waiting. The next task runs, and the run fails only for the timeout.',
    from: ['task-timeout', 'run-concurrency'],
    needs: ['timeout'],
    workspace: each('build', {
      p0: { command: 'sleep 60', timeout: 1 },
      p1: { command: 'echo ok > ok.txt' },
    }),
    steps: [
      {
        run: 'build',
        concurrency: 1,
        expect: {
          exit: 'fail',
          ran: ['p1#build'],
          files: { 'packages/p1/ok.txt': 'ok\n' },
          within: 20,
        },
      },
    ],
  }),

  // moon command_executor_test.rs: returns_attempts_for_each_retry (only the task is attempted again)
  defineCase({
    id: 'failure/retry-runs-only-the-failing-task-again',
    category: 'failure',
    kind: 'correctness',
    title: 'A retry runs only the task that failed again, not its dependency or the task beside it',
    why: 'A retry is another attempt at one task’s command. Its dependency already succeeded and its sibling has nothing to do with it, so running either again repeats work, and repeats side effects such as a publish or a migration. Each runs once while the flaky task runs twice.',
    from: ['flaky-retry'],
    needs: ['retries'],
    workspace: {
      projects: {
        lib: {
          tasks: {
            build: {
              command: `echo x >> ../../lib-runs; ${CONCAT}`,
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'lib\n' },
        },
        side: {
          tasks: { build: { command: 'echo x >> ../../side-runs', cache: false } },
        },
        app: {
          deps: ['lib'],
          tasks: {
            build: {
              command: `test -f ../lib/dist/out.txt && ${FLAKY}`,
              dependsOn: ['^build'],
              inputs: ['src/**'],
              outputs: ['out.txt'],
              retries: 1,
            },
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
          files: {
            'lib-runs': 'x\n',
            'side-runs': 'x\n',
            'packages/app/out.txt': 'winning\n',
          },
        },
      },
    ],
  }),

  // moon action_pipeline_test.rs: skips_if_the_dependency_already_failed, for a task with retries
  defineCase({
    id: 'failure/task-behind-a-failure-is-not-retried',
    category: 'failure',
    kind: 'correctness',
    title: 'A task with retries whose dependency failed is never attempted at all',
    why: 'Retries are attempts at a task that ran and failed. A task whose dependency failed never ran, so there is nothing to retry. Running it, once or per retry, builds on a dependency that did not produce its output.',
    from: ['flaky-retry'],
    needs: ['retries'],
    workspace: {
      projects: {
        lib: { tasks: { build: { command: 'echo x >> ../../lib-runs; exit 1' } } },
        app: {
          deps: ['lib'],
          tasks: {
            build: {
              command: 'echo x >> ../../app-runs',
              dependsOn: ['^build'],
              retries: 2,
            },
          },
        },
      },
    },
    steps: [
      {
        run: 'build',
        expect: {
          exit: 'fail',
          notRan: ['app#build'],
          files: { 'lib-runs': 'x\n', 'app-runs': null },
        },
      },
    ],
  }),

  // moon command_executor_test.rs: fails_and_retries_when_command_not_found
  defineCase({
    id: 'failure/retry-after-a-missing-command',
    category: 'failure',
    kind: 'correctness',
    title: 'A task that fails because a command is not found is retried like any failure',
    why: 'A shell that cannot find a command exits 127, and to the runner that is a failed attempt like any other. On CI the program may appear a moment later, when a parallel install or a cache restore finishes. The retry runs, finds it, and passes the run.',
    from: ['flaky-retry'],
    needs: ['retries'],
    workspace: app({
      build: {
        command:
          'if [ -f flag.txt ]; then echo winning > out.txt; else touch flag.txt; no-such-tool-xyz; fi',
        inputs: ['src/**'],
        outputs: ['out.txt'],
        retries: 1,
      },
    }),
    steps: [{ run: 'build', expect: { exit: 0, files: { 'packages/app/out.txt': 'winning\n' } } }],
  }),

  // vx flaky-retry: the retry budget is per task
  defineCase({
    id: 'failure/each-flaky-task-has-its-own-retries',
    category: 'failure',
    kind: 'correctness',
    title: 'Two flaky tasks with one retry each both pass, each on its own second attempt',
    why: 'A retry count is declared on a task and belongs to it. A runner that keeps one budget for the run, or for every task of one name, spends it on the first flaky task and fails the second. Each task gets its own retry, so both pass.',
    from: ['flaky-retry'],
    needs: ['retries'],
    workspace: each('build', {
      a: { command: FLAKY, inputs: ['src/**'], outputs: ['out.txt'], retries: 1 },
      b: { command: FLAKY, inputs: ['src/**'], outputs: ['out.txt'], retries: 1 },
    }),
    steps: [
      {
        run: 'build',
        expect: {
          exit: 0,
          files: { 'packages/a/out.txt': 'winning\n', 'packages/b/out.txt': 'winning\n' },
        },
      },
    ],
  }),

  // vx run-concurrency + flaky-retry: an attempt takes a slot like any task
  defineCase({
    id: 'graph/retry-stays-inside-the-concurrency-limit',
    category: 'graph',
    kind: 'correctness',
    title: 'At a concurrency of 1, a task’s retry never runs beside another task',
    why: 'Each attempt of a task is a process using the machine, so it counts against the limit like the first attempt did. A runner that starts the retry straight away, outside the scheduler, runs two things at once under a limit of one. That is the overload the limit is set to prevent.',
    from: ['flaky-retry', 'run-concurrency'],
    needs: ['retries', 'uncached-task'],
    workspace: each('work', {
      p0: {
        command: `${SLOT}; if [ -f flag ]; then :; else touch flag; exit 1; fi`,
        retries: 2,
        cache: false,
      },
      p1: { command: SLOT, cache: false },
      p2: { command: SLOT, cache: false },
    }),
    steps: [
      {
        run: 'work',
        concurrency: 1,
        expect: { exit: 0, files: { overlap: null }, within: 30 },
      },
    ],
  }),

  // vx run-concurrency: a limit of n lets n run
  defineCase({
    id: 'graph/concurrency-limit-is-reached',
    category: 'graph',
    kind: 'efficiency',
    title: 'At a concurrency of 3, three independent tasks run at the same time',
    why: 'A concurrency limit is the most work the machine should take at once, and a run with enough work should use all of it. A scheduler that reads the limit off by one, or holds a slot back for itself, leaves a core idle on every run. Three tasks with no edges between them run together under a limit of three.',
    from: ['run-concurrency', 'scheduler'],
    workspace: each(
      'work',
      Object.fromEntries(
        ['a', 'b', 'c'].map((self) => {
          const m = `../../${MEET}`
          const wait = ['a', 'b', 'c'].map((p) => `[ -e ${m}/${p} ]`).join(' && ')
          return [
            self,
            {
              command: `mkdir -p ${m} && touch ${m}/${self}; i=0; until { ${wait}; } || [ $i -ge 200 ]; do sleep 0.05; i=$((i+1)); done; if ${wait}; then echo together; else echo apart; fi > out.txt`,
              cache: false,
            },
          ]
        }),
      ),
    ),
    steps: [
      {
        run: 'work',
        concurrency: 3,
        expect: {
          exit: 0,
          files: {
            'packages/a/out.txt': 'together\n',
            'packages/b/out.txt': 'together\n',
            'packages/c/out.txt': 'together\n',
          },
          within: 30,
        },
      },
    ],
  }),

  // Nx continuous tasks: one serve shared by two e2e projects (e2e/nx run.test.ts)
  defineCase({
    id: 'graph/server-starts-once-for-two-users',
    category: 'graph',
    kind: 'correctness',
    title: 'A server two projects’ tests need starts once, and both tests use it',
    why: 'One dev server serves every test that needs it. Starting a second copy for the second test runs into the port the first already holds, or leaves two servers fighting over one cache directory. The server starts once, both tests run against it, and the run ends with it stopped.',
    from: ['persistent'],
    needs: ['persistent'],
    workspace: {
      projects: {
        app: {
          tasks: {
            srv: { command: `echo x >> ../../starts; ${SERVER}`, persistent: true },
          },
        },
        x: {
          tasks: {
            e2e: {
              command: `${until('../app/srv.pid')} && echo ok > ok.txt`,
              dependsOn: ['app#srv'],
              cache: false,
            },
          },
        },
        y: {
          tasks: {
            e2e: {
              command: `${until('../app/srv.pid')} && echo ok > ok.txt`,
              dependsOn: ['app#srv'],
              cache: false,
            },
          },
        },
      },
    },
    steps: [
      {
        run: 'e2e',
        expect: {
          exit: 0,
          ran: ['x#e2e', 'y#e2e'],
          files: { starts: 'x\n', 'packages/x/ok.txt': 'ok\n', 'packages/y/ok.txt': 'ok\n' },
          within: 30,
          alone: true,
        },
      },
    ],
  }),

  // vx server-stops-unneeded: a server stops when its last user finishes, while the graph still runs
  defineCase({
    id: 'graph/server-stops-once-its-last-user-ends',
    category: 'graph',
    kind: 'efficiency',
    title: 'A server stops once the last task needing it ends, while unrelated work still runs',
    why: 'A server started for a test holds a port, memory and CPU only that test needs. Once the test is done, keeping the server up until the slowest unrelated task in the run finishes wastes all three, and can keep a port busy that a later task wants. The runner stops it as soon as nothing left in the run needs it.',
    from: ['server-stops-unneeded', 'persistent'],
    needs: ['persistent'],
    workspace: {
      projects: {
        app: {
          tasks: {
            srv: {
              command: `trap 'touch stopped; exit 0' TERM INT HUP; touch up; ${LOOP}`,
              persistent: true,
            },
            e2e: {
              command: `${until('up')} && echo ok > done.txt`,
              dependsOn: ['srv'],
              cache: false,
            },
          },
        },
        other: {
          tasks: {
            e2e: {
              command: `${until('../app/done.txt')}; i=0; until [ -e ../app/stopped ] || [ $i -ge 100 ]; do sleep 0.05; i=$((i+1)); done; if [ -e ../app/stopped ]; then echo stopped; else echo running; fi > saw.txt`,
              cache: false,
            },
          },
        },
      },
    },
    steps: [
      {
        run: 'e2e',
        expect: { exit: 0, files: { 'packages/other/saw.txt': 'stopped\n' }, within: 30 },
      },
    ],
  }),

  // vx server-chain-stop-order: a server stops after the server using it
  defineCase({
    id: 'graph/server-stops-after-the-server-using-it',
    category: 'graph',
    kind: 'correctness',
    title:
      'Of two servers where one uses the other, the user stops first and the one it uses after',
    why: 'An API server that uses a database server may still need it while it shuts down, to flush a write or close its connections. Stopping both at once, or the database first, breaks that shutdown. Servers stop in the reverse of the order they started, as a process manager stops dependent services.',
    from: ['server-chain-stop-order', 'persistent-shutdown'],
    needs: ['persistent'],
    workspace: app({
      db: {
        command: `trap 'if kill -0 $(cat api.pid) 2>/dev/null; then echo api-alive; else echo api-gone; fi > db-saw.txt; exit 0' TERM INT HUP; touch db.up; ${LOOP}`,
        persistent: true,
      },
      api: {
        command: `${until('db.up')}; trap 'sleep 0.5; exit 0' TERM INT HUP; echo $$ > api.pid; ${LOOP}`,
        dependsOn: ['db'],
        persistent: true,
      },
      e2e: { command: `${until('api.pid')} && echo ok > ok.txt`, dependsOn: ['api'], cache: false },
    }),
    steps: [
      {
        run: 'e2e',
        expect: {
          exit: 0,
          files: { 'packages/app/db-saw.txt': 'api-gone\n' },
          within: 30,
          alone: true,
        },
      },
    ],
  }),

  // vx persistent-lifecycle: keeps what was requested; Turborepo persistent tasks run until Ctrl-C
  defineCase({
    id: 'graph/requested-server-outlives-the-task-using-it',
    category: 'graph',
    kind: 'correctness',
    title: 'A server asked for by name keeps running after the task using it ends',
    why: 'Asking for the server by name says the user wants it up, not only that a test needs it. A user who runs the dev server and its codegen together still wants the server once codegen ends. The runner keeps it up until the user stops the run.',
    from: ['persistent', 'held-persistent'],
    needs: ['persistent', 'multi-task'],
    workspace: app({
      srv: {
        command: `touch up; until [ -e done.txt ]; do sleep 0.05; done; sleep 0.5; touch outlived; sleep 60`,
        persistent: true,
      },
      e2e: { command: `${until('up')} && echo ok > done.txt`, dependsOn: ['srv'], cache: false },
    }),
    steps: [
      {
        run: 'srv',
        also: ['e2e'],
        stop: { signal: 'SIGINT', when: 'packages/app/outlived' },
        expect: {
          ran: ['app#srv', 'app#e2e'],
          files: { 'packages/app/outlived': '' },
          within: 20,
          alone: true,
        },
      },
    ],
  }),

  // moon action_pipeline_test.rs: runs_with_a_single_permit / doesnt_block_persistent_dependents
  defineCase({
    id: 'graph/one-slot-runs-an-unrelated-build-beside-a-server',
    category: 'graph',
    kind: 'correctness',
    title:
      'At a concurrency of 1, a running dev server does not keep an unrelated build from running',
    why: 'A server never ends on its own, so a server that takes the only slot keeps it for good. Then the build asked for in the same run never starts, and the run sits there with nothing happening. The build runs beside the server.',
    from: ['persistent', 'run-concurrency'],
    needs: ['persistent', 'multi-task'],
    workspace: {
      projects: {
        app: { tasks: { dev: { command: 'sleep 60', persistent: true } } },
        lib: { tasks: { build: { command: 'echo built > built.txt' } } },
      },
    },
    steps: [
      {
        run: 'dev',
        also: ['build'],
        concurrency: 1,
        stop: { signal: 'SIGINT', when: 'packages/lib/built.txt' },
        expect: {
          ran: ['lib#build'],
          files: { 'packages/lib/built.txt': 'built\n' },
          within: 20,
          alone: true,
        },
      },
    ],
  }),

  // moon action_pipeline_test.rs: can_wait_on_a_persistent_task, across the package graph
  defineCase({
    id: 'graph/server-in-a-dependency-starts-for-its-dependant',
    category: 'graph',
    kind: 'correctness',
    title: 'A test that needs its library’s dev server through `^dev` starts it and waits for it',
    why: 'An app’s tests often need a server the library they depend on provides, such as a mock API. Selecting only the app still pulls in that server through the package graph, the same way `^build` pulls in a dependency’s build. The test starts once the server is ready, and the server stops when the test is done.',
    from: ['persistent'],
    needs: ['persistent', 'ready'],
    workspace: {
      projects: {
        lib: {
          tasks: {
            dev: { command: 'touch up; echo ready; sleep 60', persistent: { ready: 'ready' } },
          },
        },
        app: {
          deps: ['lib'],
          tasks: {
            e2e: {
              command: 'test -e ../lib/up && echo ok > ok.txt',
              dependsOn: ['^dev'],
              cache: false,
            },
          },
        },
      },
    },
    steps: [
      {
        run: 'e2e',
        projects: ['app'],
        expect: {
          exit: 0,
          ran: ['lib#dev', 'app#e2e'],
          files: { 'packages/app/ok.txt': 'ok\n' },
          within: 30,
          alone: true,
        },
      },
    ],
  }),

  // Nx continuous tasks: an e2e target depending on two continuous serve targets
  defineCase({
    id: 'graph/task-needing-two-servers-waits-for-both',
    category: 'graph',
    kind: 'correctness',
    title: 'A task that needs two servers waits for both ready lines, not only the first',
    why: 'An e2e suite that needs a web server and an API server needs both up before its first request. The fast server being ready says nothing about the slow one. Starting the task on the first ready line sends requests to a server that is still booting.',
    from: ['persistent'],
    needs: ['persistent', 'ready'],
    workspace: {
      projects: {
        web: {
          tasks: {
            srv: {
              command: 'touch ../../web.up; echo ready; sleep 60',
              persistent: { ready: 'ready' },
            },
          },
        },
        api: {
          tasks: {
            srv: {
              command: 'sleep 1; touch ../../api.up; echo ready; sleep 60',
              persistent: { ready: 'ready' },
            },
          },
        },
        app: {
          deps: ['web', 'api'],
          tasks: {
            e2e: {
              command: 'test -e ../../web.up && test -e ../../api.up && echo ok > ok.txt',
              dependsOn: ['^srv'],
              cache: false,
            },
          },
        },
      },
    },
    steps: [
      {
        run: 'e2e',
        projects: ['app'],
        expect: { exit: 0, files: { 'packages/app/ok.txt': 'ok\n' }, within: 30, alone: true },
      },
    ],
  }),

  // vx persistent: a server's ready text is its own; another server printing it releases nothing
  defineCase({
    id: 'graph/another-servers-ready-text-does-not-release',
    category: 'graph',
    kind: 'correctness',
    title: 'A server’s ready text printed by a different server does not release its dependants',
    why: 'A server is ready when it says so itself. Two servers in one run often print similar lines, and a log line from one says nothing about the other. A runner that watches the run’s combined output starts the task while the server it needs is still booting.',
    from: ['persistent'],
    needs: ['persistent', 'ready'],
    workspace: {
      projects: {
        noisy: {
          tasks: {
            srv: {
              command: `echo 'api ready'; echo 'noisy up'; sleep 60`,
              persistent: { ready: 'noisy up' },
            },
          },
        },
        api: {
          tasks: {
            srv: {
              command: `sleep 1; touch ../../api.up; echo 'api ready'; sleep 60`,
              persistent: { ready: 'api ready' },
            },
          },
        },
        app: {
          deps: ['noisy', 'api'],
          tasks: {
            e2e: {
              command: 'test -e ../../api.up && echo ok > ok.txt',
              dependsOn: ['^srv'],
              cache: false,
            },
          },
        },
      },
    },
    steps: [
      {
        run: 'e2e',
        projects: ['app'],
        expect: { exit: 0, files: { 'packages/app/ok.txt': 'ok\n' }, within: 30, alone: true },
      },
    ],
  }),

  // Nx readiness/ready-when.spec.ts: a ready signal is text in the server's output
  defineCase({
    id: 'graph/ready-text-inside-a-longer-line-releases',
    category: 'graph',
    kind: 'correctness',
    title:
      'A ready text that is only part of the line the server prints still releases its dependants',
    why: 'Servers print their ready message with a banner, a version or a timing around it, such as `VITE v5.0.0  ready in 312 ms`. The user names the part that never changes. A runner that needs the whole line to match never sees the server ready, and the run hangs.',
    from: ['persistent'],
    needs: ['persistent', 'ready'],
    workspace: app({
      srv: {
        command: `touch up; echo '  VITE v5.0.0  ready in 312 ms'; sleep 60`,
        persistent: { ready: 'ready in' },
      },
      e2e: { command: 'test -e up && echo ok > ok.txt', dependsOn: ['srv'], cache: false },
    }),
    steps: [
      {
        run: 'e2e',
        expect: { exit: 0, files: { 'packages/app/ok.txt': 'ok\n' }, within: 20, alone: true },
      },
    ],
  }),

  // Nx readiness/ready-when.spec.ts: resolves placeholders and leaves other braces alone
  defineCase({
    id: 'graph/ready-text-is-matched-as-written',
    category: 'graph',
    kind: 'correctness',
    title: 'A ready text holding brackets and parentheses matches exactly those characters',
    why: 'Ready lines are full of brackets and parentheses, `[ready] (1/1)` among them. The user wrote the text they see, not a pattern. Read as a regular expression it matches something else entirely, and the server that printed exactly that text is never seen ready.',
    from: ['persistent'],
    needs: ['persistent', 'ready'],
    workspace: app({
      srv: {
        command: `touch up; echo '[ready] (1/1)'; sleep 60`,
        persistent: { ready: '[ready] (1/1)' },
      },
      e2e: { command: 'test -e up && echo ok > ok.txt', dependsOn: ['srv'], cache: false },
    }),
    steps: [
      {
        run: 'e2e',
        expect: { exit: 0, files: { 'packages/app/ok.txt': 'ok\n' }, within: 20, alone: true },
      },
    ],
  }),

  // vx persistent: persistent task streams output captured before ready into the body
  defineCase({
    id: 'graph/ready-line-after-a-megabyte-of-logs-releases',
    category: 'graph',
    kind: 'correctness',
    title: 'A ready line printed after a megabyte of startup logs still releases its dependants',
    why: 'A server can log a great deal before it is ready: compiled modules, warnings, a dependency scan. A runner that searches only a bounded window, or stops reading while it is busy, misses the line at the end. The test still starts once the line appears.',
    from: ['persistent'],
    needs: ['persistent', 'ready'],
    workspace: app({
      srv: {
        command: `i=0; while [ $i -lt 20000 ]; do echo "compiled module $i ........................................"; i=$((i+1)); done; touch up; echo ready; sleep 60`,
        persistent: { ready: 'ready' },
      },
      e2e: { command: 'test -e up && echo ok > ok.txt', dependsOn: ['srv'], cache: false },
    }),
    steps: [
      {
        run: 'e2e',
        expect: { exit: 0, files: { 'packages/app/ok.txt': 'ok\n' }, within: 30, alone: true },
      },
    ],
  }),

  // vx persistent: persistent task with readyWhen waits for the pattern, printed without a newline
  defineCase({
    id: 'graph/ready-text-without-a-newline-releases',
    category: 'graph',
    kind: 'correctness',
    title: 'A ready text the server prints with no newline after it still releases its dependants',
    why: 'Some servers print their status as a prompt or a spinner line and never end it with a newline. The text is on the stream all the same. A runner that waits for a whole line before it looks never sees the server ready.',
    from: ['persistent'],
    needs: ['persistent', 'ready'],
    workspace: app({
      srv: {
        command: `touch up; printf 'listening, ready'; sleep 60`,
        persistent: { ready: 'ready' },
      },
      e2e: { command: 'test -e up && echo ok > ok.txt', dependsOn: ['srv'], cache: false },
    }),
    steps: [
      {
        run: 'e2e',
        expect: { exit: 0, files: { 'packages/app/ok.txt': 'ok\n' }, within: 20, alone: true },
      },
    ],
  }),

  // vx persistent: persistent upstream is SIGTERMd when a downstream task fails, here by its time limit
  defineCase({
    id: 'failure/server-stopped-when-its-user-times-out',
    category: 'failure',
    kind: 'correctness',
    title:
      'A test killed at its time limit fails the run, and the server it used is stopped politely',
    why: 'Once the only task that needed a server has been killed, the server has nothing left to serve. The run fails for the timeout and ends, asking the server to stop with a signal it can handle. A server left up, or killed outright, holds the CI job open or leaves its lock behind.',
    from: ['persistent', 'task-timeout'],
    needs: ['persistent', 'timeout'],
    workspace: app({
      srv: {
        command: `trap 'touch stopped; exit 0' TERM INT HUP; touch up; ${LOOP}`,
        persistent: true,
      },
      e2e: { command: `${until('up')}; sleep 60`, dependsOn: ['srv'], timeout: 1, cache: false },
    }),
    steps: [
      {
        run: 'e2e',
        expect: {
          exit: 'fail',
          files: { 'packages/app/stopped': '' },
          within: 30,
          alone: true,
        },
      },
    ],
  }),

  // Turborepo graceful_shutdown_test.rs under --bail; moon runs_after_the_task_fails_when_bailing
  defineCase({
    id: 'failure/fail-fast-stops-a-requested-server',
    category: 'failure',
    kind: 'correctness',
    title: 'A fail-fast run stops a dev server it was asked to run when another task fails',
    why: 'A fail-fast run stops everything at the first failure, and a dev server is part of everything. Without that, a requested server keeps the run up until someone presses Ctrl-C, long after the failure that should have ended it. In CI, where nobody does, the job runs to its time limit.',
    from: ['persistent', 'abort'],
    needs: ['persistent', 'fail-fast'],
    workspace: {
      projects: {
        app: { tasks: { dev: { command: 'touch up; sleep 60', persistent: true } } },
        lib: { tasks: { dev: { command: `${until('../app/up')}; exit 1`, cache: false } } },
      },
    },
    steps: [{ run: 'dev', failFast: true, expect: { exit: 'fail', within: 20, alone: true } }],
  }),

  // vx persistent: a ready persistent upstream is alive while its dependent runs, beside a failure
  defineCase({
    id: 'failure/failure-elsewhere-keeps-a-needed-server-up',
    category: 'failure',
    kind: 'correctness',
    title: 'A failure in another project does not stop a server a running test still needs',
    why: 'A failure ends what depends on it. The test that needs the server does not depend on the broken task, so it keeps running, and the server it uses must keep running too. Stopping every server at the first failure fails a healthy test for a reason that has nothing to do with it.',
    from: ['persistent'],
    needs: ['persistent'],
    workspace: {
      projects: {
        app: {
          tasks: {
            srv: { command: SERVER, persistent: true },
            e2e: {
              command: `${until('../lib/failed')} && sleep 0.3 && kill -0 $(cat srv.pid) && echo alive > alive.txt`,
              dependsOn: ['srv'],
              cache: false,
            },
          },
        },
        lib: {
          tasks: {
            e2e: { command: `${until('../app/srv.pid')}; touch failed; exit 1`, cache: false },
          },
        },
      },
    },
    steps: [
      {
        run: 'e2e',
        expect: {
          exit: 'fail',
          files: { 'packages/app/alive.txt': 'alive\n' },
          within: 30,
          alone: true,
        },
      },
    ],
  }),

  // vx persistent: a ready persistent upstream is alive while its dependent runs, across the dependant's retry
  defineCase({
    id: 'failure/server-stays-up-for-a-retried-test',
    category: 'failure',
    kind: 'correctness',
    title: 'A server stays up while a test that needs it fails once and runs again',
    why: 'A failed attempt with a retry left is not the end of the test, so the server it needs is still needed. A runner that stops the server when the first attempt fails sends the retry against a server that is gone. The second attempt finds the server up and passes.',
    from: ['persistent', 'flaky-retry'],
    needs: ['persistent', 'retries'],
    workspace: app({
      srv: { command: SERVER, persistent: true },
      e2e: {
        command: `${until('srv.pid')}; if [ -f flag ]; then kill -0 $(cat srv.pid) && echo alive > alive.txt; else touch flag; exit 1; fi`,
        dependsOn: ['srv'],
        retries: 1,
        cache: false,
      },
    }),
    steps: [
      {
        run: 'e2e',
        expect: {
          exit: 0,
          files: { 'packages/app/alive.txt': 'alive\n' },
          within: 30,
          alone: true,
        },
      },
    ],
  }),

  // moon action_pipeline_test.rs: runs_every_time_instead_of_being_hydrated
  defineCase({
    id: 'graph/server-starts-every-run-over-a-replayed-build',
    category: 'graph',
    kind: 'correctness',
    title:
      'A dev server starts on every run, while the build it depends on replays the second time',
    why: 'A server’s work is being up, which no cache can replay. Its dependency’s build is ordinary work, cached the first time and replayed after. The second run restores the build and still starts the server.',
    from: ['persistent'],
    needs: ['persistent'],
    workspace: {
      projects: {
        lib: {
          tasks: { build: { command: CONCAT, inputs: ['src/**'], outputs: ['dist/**'] } },
          files: { 'src/a.txt': 'lib\n' },
        },
        app: {
          deps: ['lib'],
          tasks: {
            dev: {
              command:
                'test -f ../lib/dist/out.txt && echo x >> ../../starts && touch up && sleep 60',
              dependsOn: ['^build'],
              persistent: true,
            },
          },
        },
      },
    },
    steps: [
      {
        run: 'dev',
        stop: { signal: 'SIGINT', when: 'packages/app/up' },
        expect: { ran: ['lib#build', 'app#dev'], within: 20, alone: true },
      },
      {
        run: 'dev',
        stop: { signal: 'SIGINT', when: 'packages/app/up' },
        expect: {
          ran: ['app#dev'],
          notRan: ['lib#build'],
          files: { starts: 'x\nx\n' },
          within: 20,
          alone: true,
        },
      },
    ],
  }),

  // moon action_pipeline_test.rs: doesnt_report_terminated_tasks_as_the_failure
  defineCase({
    id: 'graph/server-exiting-1-when-stopped-fails-nothing',
    category: 'graph',
    kind: 'correctness',
    title: 'A server that exits 1 when the run stops it does not fail a run whose work passed',
    why: 'Many servers exit non-zero when told to stop: Node reports 143 for SIGTERM, and some frameworks exit 1 from their shutdown hook. The runner asked the server to stop, so how it exits afterwards is no verdict on the work. The run’s result is its tasks’ result, and those passed.',
    from: ['persistent-shutdown', 'persistent'],
    needs: ['persistent'],
    workspace: app({
      srv: { command: `trap 'exit 1' TERM INT HUP; touch up; ${LOOP}`, persistent: true },
      e2e: e2e(),
    }),
    steps: [{ run: 'e2e', expect: { exit: 0, within: 30, alone: true } }],
  }),

  // vx persistent: a server that exited on its own carries its exit on its outcome
  defineCase({
    id: 'graph/server-exiting-0-on-its-own-ends-the-run',
    category: 'graph',
    kind: 'correctness',
    title: 'A dev server that exits 0 by itself ends the run with success',
    why: 'A task marked as a server can still finish, for example a dev script that only prints a notice and exits when there is nothing to serve. Once it has exited there is nothing left to wait for. Waiting for a Ctrl-C that nobody will send hangs the terminal or the CI job.',
    from: ['persistent'],
    needs: ['persistent'],
    workspace: app({ dev: { command: 'echo nothing to serve', persistent: true } }),
    steps: [{ run: 'dev', expect: { exit: 0, within: 20, alone: true } }],
  }),

  // Turborepo graceful_shutdown_test.rs: a persistent task exiting mid-run; vx persistent: exited mid-run
  defineCase({
    id: 'failure/server-crashing-after-it-started-fails-the-run',
    category: 'failure',
    kind: 'correctness',
    title: 'A dev server that crashes a second after starting ends the run with a failure',
    why: 'A server that crashes after a good start has failed as surely as one that never starts. A runner that only watches for an exit at startup keeps waiting for a server that is gone, and the user sees a frozen terminal with the crash scrolled away. The run fails as soon as the server exits non-zero.',
    from: ['persistent'],
    needs: ['persistent'],
    workspace: app({ dev: { command: 'touch up; sleep 1; exit 3', persistent: true } }),
    steps: [{ run: 'dev', expect: { exit: 'fail', within: 20, alone: true } }],
  }),

  // Turborepo stdin_eof_startup_test.rs: nonpersistent_task_sees_eof_on_stdin_in_stream_mode, beside a server
  defineCase({
    id: 'failure/task-beside-a-server-sees-its-input-end',
    category: 'failure',
    kind: 'correctness',
    title: 'A test that reads its input stream while its server runs sees the stream end',
    why: 'A runner may hand a server the terminal’s input so the user can type its shortcuts. The test running against that server is not interactive, and the input it reads must end. If it is given the open terminal too, it waits for typing that never comes and the run never ends.',
    from: ['persistent'],
    needs: ['persistent'],
    workspace: app({
      srv: { command: SERVER, persistent: true },
      e2e: {
        command: `${until('srv.pid')} && cat > got.txt && echo done >> got.txt`,
        dependsOn: ['srv'],
        cache: false,
      },
    }),
    steps: [
      {
        run: 'e2e',
        openStdin: true,
        expect: { exit: 0, files: { 'packages/app/got.txt': 'done\n' }, within: 20, alone: true },
      },
    ],
  }),

  // moon command_executor_test.rs: doesnt_retry_once_processes_are_terminated
  defineCase({
    id: 'failure/fail-fast-stopped-task-is-not-retried',
    category: 'failure',
    kind: 'correctness',
    title: 'A task with retries that a fail-fast run stops is not attempted again',
    why: 'Retries are for a task that failed on its own. A task the runner itself killed, because another task failed and the user asked to fail fast, did not fail, and running it again starts new work after the run decided to stop. It runs once, and the run ends.',
    from: ['flaky-retry', 'abort'],
    needs: ['fail-fast', 'retries'],
    workspace: each('build', {
      a: { command: `echo x >> ../../a-runs; touch ../../a-up; ${LOOP}`, retries: 2 },
      b: { command: `${until('../../a-up')}; exit 1` },
    }),
    steps: [
      {
        run: 'build',
        failFast: true,
        expect: { exit: 'fail', files: { 'a-runs': 'x\n' }, within: 20, alone: true },
      },
    ],
  }),

  // Nx readiness: the ready text is matched in decoded output; a character split across two writes
  defineCase({
    id: 'graph/ready-text-with-a-character-split-across-writes-releases',
    category: 'graph',
    kind: 'correctness',
    title:
      'A ready text whose non-ASCII character reaches the runner in two writes still releases its dependants',
    why: 'Servers decorate their ready line with symbols such as `➜`, three bytes in UTF-8, and a pipe may hand those bytes over in two reads. A runner that decodes each read on its own turns the split character into replacement marks, and the text never matches. Decoding the stream as a stream sees the line the server printed.',
    from: ['persistent'],
    needs: ['persistent', 'ready'],
    workspace: app({
      srv: {
        command: `touch up; printf '\\342\\236'; sleep 0.3; printf '\\234 ready\\n'; sleep 60`,
        persistent: { ready: '➜ ready' },
      },
      e2e: { command: 'test -e up && echo ok > ok.txt', dependsOn: ['srv'], cache: false },
    }),
    steps: [
      {
        run: 'e2e',
        expect: { exit: 0, files: { 'packages/app/ok.txt': 'ok\n' }, within: 20, alone: true },
      },
    ],
  }),

  // vx server-stops-unneeded: serverUsers — a server stops only when its LAST user finishes
  defineCase({
    id: 'graph/server-stays-up-until-its-slowest-user-ends',
    category: 'graph',
    kind: 'correctness',
    title: 'A server two tests use stays up after the quick test ends, until the slow one does',
    why: 'A runner that stops a server once a test using it ends must count every test that uses it. Stopping it when the first, quicker test finishes pulls it out from under the slower one, which then fails for no fault of its own. The server stops after the last of them.',
    from: ['server-stops-unneeded', 'persistent'],
    needs: ['persistent'],
    workspace: {
      projects: {
        app: { tasks: { srv: { command: SERVER, persistent: true } } },
        x: {
          tasks: {
            e2e: {
              command: `${until('../app/srv.pid')} && echo ok > done.txt`,
              dependsOn: ['app#srv'],
              cache: false,
            },
          },
        },
        y: {
          tasks: {
            e2e: {
              command: `${until('../x/done.txt')} && sleep 1 && kill -0 $(cat ../app/srv.pid) && echo alive > alive.txt`,
              dependsOn: ['app#srv'],
              cache: false,
            },
          },
        },
      },
    },
    steps: [
      {
        run: 'e2e',
        expect: {
          exit: 0,
          files: { 'packages/y/alive.txt': 'alive\n' },
          within: 30,
          alone: true,
        },
      },
    ],
  }),

  // vx server-stops-unneeded: a server stops when its last user finishes — a user not yet started counts
  defineCase({
    id: 'graph/server-stays-up-for-a-test-not-yet-started',
    category: 'graph',
    kind: 'correctness',
    title: 'A server stays up between two tests that use it when the second has not started yet',
    why: 'A test still waiting on another task needs the server as much as a running one. A runner that stops a server when no running task uses it stops it between the first test and the second. The second test then starts against a server that is gone, or the server has to boot twice.',
    from: ['server-stops-unneeded', 'persistent'],
    needs: ['persistent'],
    workspace: app({
      srv: { command: SERVER, persistent: true },
      quick: {
        command: `${until('srv.pid')} && echo ok > quick.txt`,
        dependsOn: ['srv'],
        cache: false,
      },
      slow: { command: 'sleep 1', dependsOn: ['quick'], cache: false },
      late: {
        command: 'kill -0 $(cat srv.pid) && echo alive > alive.txt',
        dependsOn: ['srv', 'slow'],
        cache: false,
      },
    }),
    steps: [
      {
        run: 'late',
        expect: {
          exit: 0,
          ran: ['app#quick', 'app#slow', 'app#late'],
          files: { 'packages/app/alive.txt': 'alive\n' },
          within: 30,
          alone: true,
        },
      },
    ],
  }),
  // vx task-tree-kill: a vx started with SIGHUP ignored (nohup) runs on, as a script's `&` job does for SIGINT
  defineCase({
    id: 'failure/run-with-sigint-ignored-runs-through-ctrl-c',
    category: 'failure',
    kind: 'correctness',
    title: 'A run a script started in the background, with SIGINT ignored, runs on through Ctrl-C',
    why: 'A shell script that starts a job with `&` hands it SIGINT ignored, so that Ctrl-C at the terminal stops the script’s foreground work and leaves the background job alone. A runner that installs its own SIGINT handler over the inherited ignore stops a job its user deliberately shielded. The run finishes its task and exits 0.',
    from: ['task-tree-kill', 'signal-handling'],
    workspace: app({ slow: { command: 'touch started; sleep 1; echo done > done.txt' } }),
    steps: [
      {
        run: 'slow',
        stop: { signal: 'SIGINT', when: 'packages/app/started', ignored: true },
        expect: { exit: 0, files: { 'packages/app/done.txt': 'done\n' }, within: 20 },
      },
    ],
  }),

  // vx held-persistent: a held run hands its server back though another task failed
  defineCase({
    id: 'failure/build-failure-leaves-a-requested-server-running',
    category: 'failure',
    kind: 'correctness',
    title: 'Without fail-fast, a build that fails does not stop the dev server running beside it',
    why: 'A failure skips what depends on it, and nothing else, unless the user asked to fail fast. A dev server that does not depend on the broken build should stay up, so the user can fix the build without starting the server again. The run fails once it is stopped, but the server stays up until then.',
    from: ['held-persistent', 'persistent'],
    needs: ['persistent'],
    workspace: {
      projects: {
        app: {
          tasks: {
            dev: {
              command: `touch up; ${until('../lib/failed')}; sleep 1; touch outlived; sleep 60`,
              persistent: true,
            },
          },
        },
        lib: {
          tasks: { dev: { command: `${until('../app/up')}; touch failed; exit 1`, cache: false } },
        },
      },
    },
    steps: [
      {
        run: 'dev',
        stop: { signal: 'SIGINT', when: 'packages/app/outlived' },
        expect: {
          exit: 'fail',
          files: { 'packages/app/outlived': '' },
          within: 20,
          alone: true,
        },
      },
    ],
  }),
] as Case[]

export const pending: Case[] = []
