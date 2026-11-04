// Stopping a run in flight: Ctrl-C, a supervisor's SIGTERM, a closed
// terminal's SIGHUP, Ctrl-\. Each stop reaches the runner's process group,
// as a terminal sends it; each task writes `started` once its own traps are
// set, and the stop waits for that file.
import { defineCase, type Stop, type TaskSpec, type WorkspaceSpec } from '../src/spec.ts'
import { CONCAT } from './shapes.ts'

const WHEN = 'packages/a/started'
const stop = (signal: Stop['signal']): Stop => ({ signal, when: WHEN })

/** Project `a` with these tasks and one source file. */
const a = (tasks: Record<string, TaskSpec>): WorkspaceSpec => ({
  projects: { a: { tasks, files: { 'src/a.txt': 'a\n', 'in.txt': 'in\n' } } },
})

/** A loop that never ends on its own, so only the stop can end the task. */
const LOOP = 'while :; do sleep 0.05; done'

const reaps = (signal: Stop['signal'], name: string, from: string[]) =>
  defineCase({
    id: `failure/${signal.toLowerCase()}-reaps-task-tree`,
    category: 'failure',
    kind: 'correctness',
    title: `${name} ends the run, its task, and what the task backgrounded`,
    why: 'A shell runs a backgrounded job with SIGINT and SIGQUIT ignored, so the signal alone does not end it: the runner must take down the whole tree, or the job runs on under init.',
    from,
    workspace: a({
      slow: { command: `sh -c 'exec sleep 60' & touch started; sleep 60` },
      after: { command: 'echo after > after.txt', dependsOn: ['slow'] },
    }),
    steps: [
      {
        run: 'after',
        stop: stop(signal),
        expect: {
          exit: 'fail',
          ran: ['a#slow'],
          notRan: ['a#after'],
          files: { 'packages/a/after.txt': null },
          within: 20,
          alone: true,
        },
      },
    ],
  })

const reachesAs = (signal: 'SIGINT' | 'SIGTERM') =>
  defineCase({
    id: `failure/${signal.toLowerCase()}-reaches-task-as-itself`,
    category: 'failure',
    kind: 'correctness',
    title: `${signal} to the run reaches a running task as ${signal}`,
    why: 'A cleanup bound to one signal (Node’s process.on, a shell trap) runs only if that signal arrives; one forwarded as another skips it.',
    from: ['signal-handling'],
    workspace: a({
      t: {
        command: `trap 'echo SIGINT > got.txt; exit 0' INT; trap 'echo SIGTERM > got.txt; exit 0' TERM; touch started; ${LOOP}`,
      },
    }),
    steps: [
      {
        run: 't',
        stop: stop(signal),
        expect: { exit: 'fail', files: { 'packages/a/got.txt': `${signal}\n` }, within: 20 },
      },
    ],
  })

export default [
  reaps('SIGINT', 'Ctrl-C (SIGINT)', ['abort', 'signal-handling', 'task-tree-kill']),
  reaps('SIGTERM', 'SIGTERM', ['signal-handling', 'task-tree-kill']),
  reaps('SIGHUP', 'A hang-up (SIGHUP)', ['task-tree-kill']),
  reaps('SIGQUIT', 'Ctrl-\\ (SIGQUIT)', ['task-tree-kill']),

  reachesAs('SIGINT'),
  reachesAs('SIGTERM'),

  defineCase({
    id: 'failure/stop-starts-no-dependant-of-a-task-that-exits-0',
    category: 'failure',
    kind: 'correctness',
    title: 'A task that exits 0 on Ctrl-C does not start its dependants',
    why: 'The user asked the run to stop; a task that handles the signal by exiting cleanly has not finished its work.',
    from: ['abort'],
    workspace: a({
      slow: { command: `trap 'exit 0' INT TERM; touch started; ${LOOP}` },
      after: { command: 'echo after > after.txt', dependsOn: ['slow'] },
    }),
    steps: [
      {
        run: 'after',
        stop: stop('SIGINT'),
        expect: {
          exit: 'fail',
          notRan: ['a#after'],
          files: { 'packages/a/after.txt': null },
          within: 20,
        },
      },
    ],
  }),

  defineCase({
    id: 'failure/stop-escalates-past-an-ignoring-task',
    category: 'failure',
    kind: 'correctness',
    title: 'Ctrl-C ends a run whose task ignores SIGINT and SIGTERM',
    why: 'A task that shrugs the polite signal off must still die: the run neither hangs nor leaves it running.',
    from: ['abort', 'signal-handling'],
    workspace: a({ stubborn: { command: `trap '' INT TERM; touch started; sleep 60` } }),
    steps: [
      { run: 'stubborn', stop: stop('SIGINT'), expect: { exit: 'fail', within: 20, alone: true } },
    ],
  }),

  defineCase({
    id: 'failure/stop-waits-for-a-task-cleanup',
    category: 'failure',
    kind: 'correctness',
    title: 'A run stopped by SIGTERM exits only once its tasks have',
    why: 'A runner that exits while its tasks are still shutting down leaves them writing to the terminal, and to files, after the prompt is back.',
    from: ['signal-handling'],
    workspace: a({
      slow: {
        command: `trap 'sleep 3; echo late > late.txt; exit 0' TERM; touch started; ${LOOP}`,
      },
    }),
    steps: [
      { run: 'slow', stop: stop('SIGTERM'), expect: { exit: 'fail', within: 20, alone: true } },
    ],
  }),

  defineCase({
    id: 'failure/stop-cleanup-not-cut-short',
    category: 'failure',
    kind: 'correctness',
    title: 'One Ctrl-C lets a task finish its cleanup',
    why: 'A handler that runs once (process.once, a trap that resets itself) dies mid-cleanup if the task hears the stop twice.',
    from: ['abort', 'persistent-ready-timeout'],
    workspace: a({
      t: {
        command: `trap 'trap - INT TERM; sleep 0.3; echo done > clean.txt; exit 0' INT TERM; touch started; ${LOOP}`,
      },
    }),
    steps: [
      {
        run: 't',
        stop: stop('SIGINT'),
        expect: { exit: 'fail', files: { 'packages/a/clean.txt': 'done\n' }, within: 20 },
      },
    ],
  }),

  defineCase({
    id: 'failure/stop-grandchild-cleanup-gets-its-grace',
    category: 'failure',
    kind: 'correctness',
    title:
      'A process a task backgrounded gets to clean up on SIGTERM after the task’s shell has died',
    from: ['task-tree-kill'],
    workspace: a({
      t: {
        command: `sh -c 'trap "sleep 0.3; echo done > cleanup.txt; exit 0" TERM; touch started; ${LOOP}' & sleep 60`,
      },
    }),
    steps: [
      {
        run: 't',
        stop: stop('SIGTERM'),
        expect: {
          exit: 'fail',
          files: { 'packages/a/cleanup.txt': 'done\n' },
          within: 20,
          alone: true,
        },
      },
    ],
  }),

  defineCase({
    id: 'failure/stop-trapped-exit-0-not-cached',
    category: 'failure',
    kind: 'correctness',
    title: 'A task that traps Ctrl-C and exits 0 is not cached with its partial outputs',
    why: 'Its exit 0 came from the stop, not the end of its work: cached, the partial tree replays as a success.',
    from: ['signal-handling', 'aborted-outcome'],
    workspace: a({
      t: {
        command: `trap 'exit 0' INT TERM; mkdir -p out; echo partial > out/x; if [ ! -f done.flag ]; then touch started; ${LOOP}; fi; echo full > out/x`,
        inputs: ['in.txt'],
        outputs: ['out/**'],
      },
    }),
    steps: [
      { run: 't', stop: stop('SIGINT'), expect: { exit: 'fail', within: 20 } },
      { write: { 'packages/a/done.flag': '' } },
      { run: 't', expect: { exit: 0, ran: ['a#t'], files: { 'packages/a/out/x': 'full\n' } } },
    ],
  }),

  defineCase({
    id: 'failure/stop-keeps-what-finished',
    category: 'failure',
    kind: 'efficiency',
    title: 'A task that finished before Ctrl-C is replayed by the next run',
    from: ['signal-handling'],
    workspace: a({
      quick: { command: CONCAT, inputs: ['src/**'], outputs: ['dist/**'] },
      slow: {
        command: `if [ ! -f ../../go ]; then touch started; sleep 60; fi`,
        dependsOn: ['quick'],
        cache: false,
      },
    }),
    steps: [
      { run: 'slow', stop: stop('SIGINT'), expect: { exit: 'fail', ran: ['a#quick'], within: 20 } },
      { write: { go: '' } },
      {
        run: 'slow',
        expect: {
          exit: 0,
          ran: ['a#slow'],
          notRan: ['a#quick'],
          files: { 'packages/a/dist/out.txt': 'a\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'failure/nohup-runs-through-a-hang-up',
    category: 'failure',
    kind: 'correctness',
    title: 'A run started with SIGHUP ignored (nohup) runs on when the terminal closes',
    why: '`nohup` asks for exactly this; a runner that installs its own SIGHUP handler over the inherited ignore stops the run.',
    from: ['task-tree-kill', 'hangup-ignored'],
    workspace: a({ slow: { command: 'touch started; sleep 1; echo done > done.txt' } }),
    steps: [
      {
        run: 'slow',
        stop: { signal: 'SIGHUP', when: WHEN, ignored: true },
        expect: { exit: 0, files: { 'packages/a/done.txt': 'done\n' }, within: 20 },
      },
    ],
  }),

  defineCase({
    id: 'failure/killed-dependency-builds-no-stale-dependant',
    category: 'failure',
    kind: 'correctness',
    title:
      'A dependency killed by a signal mid-write leaves no dependant cached from its partial output',
    why: 'The kill switch is no input, so a healthy run derives the same keys: anything cached from the partial tree replays as a green hit.',
    from: ['aborted-outcome'],
    workspace: {
      projects: {
        lib: {
          tasks: {
            build: {
              command:
                'mkdir -p dist; printf PARTIAL > dist/out.txt; if [ -f ../../kill.flag ]; then kill -TERM $$; sleep 5; fi; printf COMPLETE > dist/out.txt',
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'lib\n' },
        },
        app: {
          deps: ['lib'],
          tasks: {
            build: {
              command: 'mkdir -p dist; cat ../lib/dist/out.txt > dist/copy.txt',
              dependsOn: ['^build'],
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'app\n' },
        },
      },
    },
    steps: [
      { write: { 'kill.flag': '' } },
      { run: 'build', expect: { exit: 'fail', notRan: ['app#build'] } },
      {
        write: { 'kill.flag': null, 'packages/lib/dist': null, 'packages/app/dist': null },
      },
      {
        run: 'build',
        expect: {
          exit: 0,
          files: {
            'packages/lib/dist/out.txt': 'COMPLETE',
            'packages/app/dist/copy.txt': 'COMPLETE',
          },
        },
      },
    ],
  }),

  defineCase({
    id: 'failure/zero-concurrency-does-not-hang',
    category: 'failure',
    kind: 'correctness',
    title: 'A concurrency of 0 is refused or read as a limit, never a run that waits for good',
    from: ['run-concurrency'],
    workspace: a({ t: { command: 'echo t' } }),
    steps: [{ run: 't', concurrency: 0, expect: { within: 30 } }],
  }),

  defineCase({
    id: 'failure/second-stop-kills-at-once',
    category: 'failure',
    kind: 'correctness',
    title: 'A second Ctrl-C kills a task still in its cleanup at once, and leaves nothing running',
    why: 'The user pressed it again to stop now: a runner that waits out the cleanup ignores them.',
    from: ['signal-handling'],
    workspace: a({
      slow: {
        // The cleanup ignores the signal itself: only a kill ends it.
        command: `trap 'trap "" INT; touch cleaning; sleep 30; echo late > late.txt' INT; touch started; ${LOOP}`,
      },
    }),
    steps: [
      {
        run: 'slow',
        stop: { ...stop('SIGINT'), again: 'packages/a/cleaning' },
        expect: { exit: 'fail', within: 15, alone: true, files: { 'packages/a/late.txt': null } },
      },
    ],
  }),

  defineCase({
    id: 'failure/stdin-read-sees-eof',
    category: 'failure',
    kind: 'correctness',
    title:
      'A task that reads its input stream sees it end, though the runner’s own stays open, and the run finishes',
    why: 'A task handed the terminal, or a pipe nobody closes, waits forever for input no one types.',
    from: ['runner'],
    workspace: a({
      build: {
        command: 'mkdir -p dist && cat > dist/out.txt && echo done >> dist/out.txt',
        inputs: ['src/**'],
        outputs: ['dist/**'],
      },
    }),
    steps: [
      {
        run: 'build',
        openStdin: true,
        expect: { exit: 0, within: 20, files: { 'packages/a/dist/out.txt': 'done\n' } },
      },
    ],
  }),
]
