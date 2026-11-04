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

const reaps = (signal: Stop['signal'], name: string, why: string, from: string[]) =>
  defineCase({
    id: `failure/${signal.toLowerCase()}-reaps-task-tree`,
    category: 'failure',
    kind: 'correctness',
    title: `${name} ends the run, its task, and what the task backgrounded`,
    why,
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

const reachesAs = (signal: 'SIGINT' | 'SIGTERM', why: string) =>
  defineCase({
    id: `failure/${signal.toLowerCase()}-reaches-task-as-itself`,
    category: 'failure',
    kind: 'correctness',
    title: `${signal} to the run reaches a running task as ${signal}`,
    why,
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
  reaps(
    'SIGINT',
    'Ctrl-C (SIGINT)',
    'Ctrl-C means stop everything this run started, and start nothing new. A non-interactive shell runs a backgrounded job with SIGINT ignored, so the signal alone does not end it. Unless the runner takes down the whole process tree, the job runs on under init, holding ports and files after the prompt is back.',
    ['abort', 'signal-handling', 'task-tree-kill'],
  ),
  reaps(
    'SIGTERM',
    'SIGTERM',
    'SIGTERM is how a CI system, a container runtime or a process supervisor asks a run to end. Unless the runner ends the whole task tree, a job the task backgrounded keeps running after the run has exited. On a shared CI machine that orphan can hold a port, keep writing files or use CPU into the next job.',
    ['signal-handling', 'task-tree-kill'],
  ),
  reaps(
    'SIGHUP',
    'A hang-up (SIGHUP)',
    'A closed terminal or a dropped SSH session sends SIGHUP, and the work started there should end with it. A runner that passes it only to the task’s shell leaves what the task backgrounded running, unseen, with no terminal to show it. Such orphans pile up and hold the ports and locks the next run needs.',
    ['task-tree-kill'],
  ),
  reaps(
    'SIGQUIT',
    'Ctrl-\\ (SIGQUIT)',
    'The quit key is a harder stop than Ctrl-C, and a user who presses it wants everything gone. A shell runs a backgrounded job with SIGQUIT ignored, so the signal alone does not end it. The runner must end the whole tree, or the job runs on under init with nothing left that will stop it.',
    ['task-tree-kill'],
  ),

  reachesAs(
    'SIGINT',
    'A task should receive the signal the user sent, unchanged. Cleanup code is often bound to one signal, such as a Node `process.on("SIGINT")` handler or a shell `trap ... INT`. If Ctrl-C is forwarded as SIGTERM or SIGKILL, that handler never runs, and temp files, locks or child processes are left behind.',
  ),
  reachesAs(
    'SIGTERM',
    'A supervisor’s SIGTERM should reach the task as SIGTERM. Containers and CI agents send it to ask for a graceful shutdown, and programs bind their shutdown code to it. Forwarded as SIGINT or SIGKILL, that code is skipped, so connections are not drained and partial state is left on disk.',
  ),

  defineCase({
    id: 'failure/stop-starts-no-dependant-of-a-task-that-exits-0',
    category: 'failure',
    kind: 'correctness',
    title: 'A task that exits 0 on Ctrl-C does not start its dependants',
    why: 'Once the user asks a run to stop, nothing new should start. A task that handles Ctrl-C by exiting 0 is shutting down cleanly, not reporting that its work is done. Starting its dependants would launch new work after the stop, on output that may be incomplete, and keep the terminal busy after Ctrl-C.',
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
    why: 'A stop must end the run even when a task ignores the polite signals. Some programs trap or ignore SIGINT and SIGTERM, by design or by bug. Without escalating to SIGKILL after a grace period, the run hangs at Ctrl-C, or exits and leaves the task running in the background.',
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
    why: 'A run should exit only after its tasks have. If the runner returns the prompt while tasks are still running their shutdown code, they keep printing over the next command and writing files the user thinks are settled. A script that starts the next step once the runner exits would race those late writes.',
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
    why: 'One Ctrl-C should reach a task once. Many cleanup handlers run once and then reset, like `process.once` or a trap that clears itself, so a second copy of the signal kills the task in the middle of its cleanup. A runner that signals the process group and then the task again leaves the cleanup half done.',
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
    why: 'Every process in a task’s tree deserves the same chance to shut down cleanly. A task’s shell often dies on SIGTERM at once, while a process it backgrounded is still running its handler. A runner that sends SIGKILL to the rest of the tree as soon as the shell exits cuts that cleanup short and leaves lock files or temp state behind.',
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
    why: 'An exit 0 after a stop does not mean the work finished. A program that traps Ctrl-C and exits 0 to shut down gracefully may have written only part of its outputs. Cached, that partial tree would replay as a success on every later run with the same inputs, so the next run must run the task again.',
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
    why: 'A task that finished before the stop produced a complete, valid result. Throwing it away because a later task was interrupted makes the next run redo work that was already done. Only the interrupted tasks need to run again; the finished one replays from the cache.',
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
    why: '`nohup` sets SIGHUP to ignored so that a long job survives a closed terminal or a dropped SSH session. The ignore is inherited, and a runner that installs its own SIGHUP handler over it stops the run anyway. The user asked for the job to keep going, so the run finishes and exits 0.',
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
    why: 'A dependency killed mid-write leaves partial output, and nothing built from it may be kept. The kill came from something that is not an input, so a later healthy run derives the same cache keys. If a dependant had been cached from the partial file, that run would replay the wrong bytes under a green result.',
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
    why: 'A concurrency of 0 lets no task start, so a run that takes it literally waits forever. In CI that is a job that hangs until its timeout, with no error to explain it. The runner may refuse the value with a clear message or read it as some valid limit, but it must never sit idle.',
    from: ['run-concurrency'],
    workspace: a({ t: { command: 'echo t' } }),
    steps: [{ run: 't', concurrency: 0, expect: { within: 30 } }],
  }),
]
