// A task's time limit and its retries: what a timed-out or retried task
// leaves behind, what is cached, and that the run stays bounded.
import { defineCase, type TaskSpec, type WorkspaceSpec } from '../src/spec.ts'

const a = (tasks: Record<string, TaskSpec>): WorkspaceSpec => ({
  projects: { a: { tasks, files: { 'in.txt': 'in\n' } } },
})

/** Seeded on its first attempt: fails then, passes on every later one. */
const FLAKY =
  'if [ -f flag.txt ]; then echo winning > out.txt; else touch flag.txt; echo losing > out.txt; exit 1; fi'

export default [
  defineCase({
    id: 'failure/timeout-kills-an-overrunning-task',
    category: 'failure',
    kind: 'correctness',
    title: 'A task past its time limit is killed, fails the run, and is not cached',
    why: 'A time limit exists so a hung task cannot hold a run, or a CI job, forever. A task that hits it did not finish, so it fails the run and its partial output is never cached. If it were cached, the next run would replay a half-written result instead of trying again.',
    from: ['persistent-ready-timeout', 'task-timeout'],
    needs: ['timeout'],
    workspace: a({
      slow: {
        command: 'echo started > out.txt; sleep 60; echo done > out.txt',
        timeout: 1,
        inputs: ['in.txt'],
        outputs: ['out.txt'],
      },
    }),
    steps: [
      { run: 'slow', expect: { exit: 'fail', within: 20, alone: true } },
      { run: 'slow', expect: { exit: 'fail', ran: ['a#slow'], within: 20, alone: true } },
    ],
  }),

  defineCase({
    id: 'failure/timeout-spares-a-task-within-it',
    category: 'failure',
    kind: 'correctness',
    title: 'A task that finishes inside its time limit succeeds',
    why: 'A time limit is an upper bound, not a schedule. A task that finishes inside it must succeed exactly as it would with no limit. A runner that killed it early, or read the limit in the wrong unit, would fail healthy builds at random and teach users to remove the limit.',
    from: ['persistent-ready-timeout', 'task-timeout'],
    needs: ['timeout'],
    workspace: a({ quick: { command: 'sleep 0.3; echo done > out.txt', timeout: 10 } }),
    steps: [{ run: 'quick', expect: { exit: 0, files: { 'packages/a/out.txt': 'done\n' } } }],
  }),

  defineCase({
    id: 'failure/timeout-trapped-exit-0-still-fails',
    category: 'failure',
    kind: 'correctness',
    title:
      'A timed-out task that traps SIGTERM and exits 0 still fails, and its partial output is not cached',
    why: 'A timeout is a failure, whatever exit code the task gives back. Many programs trap SIGTERM and exit 0 as their graceful shutdown, so the exit code after the kill says nothing about the work. Read as success, the partial output would be cached and replayed as a finished build on later runs.',
    from: ['task-timeout'],
    needs: ['timeout'],
    workspace: a({
      t: {
        command: `trap 'echo TRAPPED >> out.txt; exit 0' TERM; echo PARTIAL > out.txt; sleep 60 & wait; echo COMPLETE >> out.txt`,
        timeout: 1,
        inputs: ['in.txt'],
        outputs: ['out.txt'],
      },
    }),
    steps: [
      {
        run: 't',
        expect: { exit: 'fail', files: { 'packages/a/out.txt': 'PARTIAL\nTRAPPED\n' }, within: 20 },
      },
      { run: 't', expect: { exit: 'fail', ran: ['a#t'], within: 20 } },
    ],
  }),

  defineCase({
    id: 'failure/timeout-escalates-past-an-ignoring-task',
    category: 'failure',
    kind: 'correctness',
    title: 'A timed-out task that ignores SIGTERM is killed anyway, and the run does not hang',
    why: 'A time limit only bounds a run if the task actually dies. A task that ignores SIGTERM would keep the run, and the CI job, waiting well past the limit. After a short grace period the runner must send SIGKILL, so the limit means what it says.',
    from: ['task-timeout'],
    needs: ['timeout'],
    workspace: a({ t: { command: `trap '' TERM; sleep 60`, timeout: 1 } }),
    steps: [{ run: 't', expect: { exit: 'fail', within: 20, alone: true } }],
  }),

  defineCase({
    id: 'failure/timeout-reaps-what-the-task-backgrounded',
    category: 'failure',
    kind: 'correctness',
    title: 'A timeout kills what the task backgrounded, not only its shell',
    why: 'A timeout ends the task, and the task is its whole process tree, not only its shell. A command like `sh -c "server & wait"` starts a process that outlives its shell if only the shell is killed. That orphan keeps running after every timeout, holding ports and CPU into the next run.',
    from: ['task-tree-kill'],
    needs: ['timeout'],
    workspace: a({ t: { command: `sh -c 'exec sleep 60' & sleep 60`, timeout: 1 } }),
    steps: [{ run: 't', expect: { exit: 'fail', within: 20, alone: true } }],
  }),

  defineCase({
    id: 'failure/timeout-reaps-a-backgrounded-child-ignoring-sigterm',
    category: 'failure',
    kind: 'correctness',
    title: 'A timeout kills a backgrounded child that ignores SIGTERM after its shell has died',
    why: 'A timeout must end every process the task started, even one that ignores SIGTERM. The shell dies on SIGTERM at once, so a runner that stops escalating when the shell exits never sends SIGKILL to the child. The child then runs on with no parent, holding resources after the run has failed.',
    from: ['task-tree-kill'],
    needs: ['timeout'],
    workspace: a({
      t: { command: `sh -c 'trap "" TERM; exec sleep 60' & sleep 60`, timeout: 1 },
    }),
    steps: [{ run: 't', expect: { exit: 'fail', within: 20, alone: true } }],
  }),

  defineCase({
    id: 'config/timeout-beyond-any-timer-refused',
    category: 'config',
    kind: 'correctness',
    title: 'A time limit no timer can hold is refused, not turned into an instant kill',
    why: 'A limit the runner cannot honour should be refused, not silently changed. Timers have a maximum, and a value past it often fires at once, so a limit of hundreds of years kills the task within milliseconds. That is the opposite of what the user asked for, and the cause is hard to see from the failure.',
    from: ['timeout-bounds'],
    needs: ['timeout'],
    workspace: a({ t: { command: 'echo ran > out.txt', timeout: 1e10 } }),
    steps: [
      {
        run: 't',
        expect: { exit: 'fail', notRan: ['a#t'], files: { 'packages/a/out.txt': null } },
      },
    ],
  }),

  defineCase({
    id: 'failure/retry-passes-a-flaky-task',
    category: 'failure',
    kind: 'correctness',
    title:
      'A task that fails once and passes on its retry passes the run, and the passing attempt is what is cached',
    why: 'A retry exists to absorb a transient failure, so a task that passes on its retry passes the run. What is cached is the output of the passing attempt, because that is the result the run reported. Caching the failed attempt’s files would replay the wrong bytes; caching nothing would redo the work next time.',
    from: ['retries'],
    needs: ['retries'],
    workspace: a({
      flaky: { command: FLAKY, retries: 1, inputs: ['in.txt'], outputs: ['out.txt'] },
    }),
    steps: [
      { run: 'flaky', expect: { exit: 0, files: { 'packages/a/out.txt': 'winning\n' } } },
      { write: { 'packages/a/out.txt': null } },
      {
        run: 'flaky',
        expect: { exit: 0, notRan: ['a#flaky'], files: { 'packages/a/out.txt': 'winning\n' } },
      },
    ],
  }),

  defineCase({
    id: 'failure/retries-exhausted-fail',
    category: 'failure',
    kind: 'correctness',
    title: 'A task that fails every attempt runs once plus its retries, then fails the run',
    why: 'Retries are a bounded number of extra tries, not a way to hide a real failure. The task runs once plus each retry, and if every attempt fails, the run fails. Running fewer attempts ignores the config, and running more stretches a broken CI job for nothing.',
    from: ['retries'],
    needs: ['retries'],
    workspace: a({ t: { command: 'echo x >> attempts.txt; exit 3', retries: 2 } }),
    steps: [
      { run: 't', expect: { exit: 'fail', files: { 'packages/a/attempts.txt': 'x\nx\nx\n' } } },
    ],
  }),

  defineCase({
    id: 'failure/retries-unused-on-success',
    category: 'failure',
    kind: 'efficiency',
    title: 'A task with retries that passes first time runs once',
    why: 'A retry is for a failure. A task that passes on its first attempt is done, and running it again would spend CI time and could repeat side effects such as a publish, an upload or a database migration. The retry count bounds attempts after failures; it is never a number of runs.',
    from: ['retries'],
    needs: ['retries'],
    workspace: a({ t: { command: 'echo x >> attempts.txt', retries: 3 } }),
    steps: [{ run: 't', expect: { exit: 0, files: { 'packages/a/attempts.txt': 'x\n' } } }],
  }),

  defineCase({
    id: 'failure/retry-after-a-signal-death',
    category: 'failure',
    kind: 'correctness',
    title: 'A task killed by a signal the run did not send is retried like any failure',
    why: 'A task killed by a signal the user did not send has failed like any other. The out-of-memory killer, a crashed tool or the task’s own script can kill it, and that is the kind of transient failure retries exist for. Only a stop the user asked for should end the retries.',
    from: ['aborted-outcome'],
    needs: ['retries'],
    workspace: a({ t: { command: 'echo x >> attempts.txt; kill -TERM $$', retries: 2 } }),
    steps: [
      { run: 't', expect: { exit: 'fail', files: { 'packages/a/attempts.txt': 'x\nx\nx\n' } } },
    ],
  }),

  defineCase({
    id: 'failure/stop-ends-retries',
    category: 'failure',
    kind: 'correctness',
    title: 'Ctrl-C during a task with retries does not attempt it again',
    why: 'When the user stops the run, the task’s failure is the stop itself. Retrying it would start the work again right after the user asked it to end, and Ctrl-C would seem not to work. The run ends after the one attempt, as asked, and reports the stop rather than a run of failed retries.',
    from: ['signal-handling'],
    needs: ['retries'],
    workspace: a({
      t: {
        command: `trap 'exit 1' INT TERM; echo attempt >> attempts.txt; touch started; while :; do sleep 0.05; done`,
        retries: 3,
      },
    }),
    steps: [
      {
        run: 't',
        stop: { signal: 'SIGINT', when: 'packages/a/started' },
        expect: {
          exit: 'fail',
          files: { 'packages/a/attempts.txt': 'attempt\n' },
          within: 20,
          alone: true,
        },
      },
    ],
  }),

  defineCase({
    id: 'outputs/retry-spares-a-sibling-output',
    category: 'outputs',
    kind: 'correctness',
    title: 'A retry does not remove the output directory a task beside it is writing into',
    why: 'Before a retry, a runner may clean the failed attempt’s own outputs, and only those. Removing a shared directory, or pruning one that looks empty, can delete what a task running beside it has just made there. The sibling then fails, or its output vanishes, for no fault of its own.',
    from: ['retries'],
    needs: ['retries'],
    workspace: a({
      p: {
        command:
          'until [ -e ready ]; do sleep 0.01; done; if [ -e tried ]; then touch go; exit 1; fi; touch tried; echo a > out/a.txt; exit 1',
        retries: 1,
        inputs: ['in.txt'],
        outputs: ['out/a.txt'],
      },
      q: {
        command:
          'mkdir -p out && touch ready && until [ -e go ]; do sleep 0.01; done; echo b > out/b.txt',
        inputs: ['in.txt'],
        outputs: ['out/b.txt'],
      },
      both: { command: 'true', dependsOn: ['p', 'q'] },
    }),
    steps: [
      {
        run: 'both',
        concurrency: 2,
        expect: {
          exit: 'fail',
          ran: ['a#q'],
          files: { 'packages/a/out/b.txt': 'b\n' },
          within: 30,
        },
      },
    ],
  }),
]
