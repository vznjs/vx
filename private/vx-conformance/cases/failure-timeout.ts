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
    why: 'Its exit 0 is the graceful-shutdown pattern answering the kill, not finished work: cached, the partial output replays as a success.',
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
    why: '`sh -c "server & wait"` left the server alive under init after every timeout.',
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
    why: 'The shell dies on SIGTERM; a kill escalation cleared on its exit leaves the child running (nx#11782).',
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
    why: 'A timer past its bound fires at once: a 317-year limit killed the task in milliseconds, the inverse of what was asked.',
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
    why: 'Only the user’s stop ends the retries; a task the OOM killer or its own script killed failed.',
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
    why: 'The task failed because the user stopped the run; a retry restarts what they asked to end.',
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
    why: 'The retry cleaned its failed attempt’s file and pruned the emptied directory a sibling had just made.',
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
