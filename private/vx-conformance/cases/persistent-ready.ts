// A server with a ready line: its dependants wait for the line, and a
// server that never prints it fails the run instead of hanging it.
import { defineCase, type TaskSpec, type WorkspaceSpec } from '../src/spec.ts'

const app = (tasks: Record<string, TaskSpec>): WorkspaceSpec => ({
  projects: { app: { tasks, files: { 'src/a.txt': 'app\n' } } },
})

const ready = { ready: 'Listening on' }
const LOOP = 'while :; do sleep 0.05; done'

/** A dependant that records it ran. */
const e2e = (command = 'echo ran > e2e.txt'): TaskSpec => ({
  command,
  dependsOn: ['srv'],
  cache: false,
})

export default [
  defineCase({
    id: 'graph/dependant-waits-for-ready',
    category: 'graph',
    kind: 'correctness',
    title: 'A task that needs a server starts only once the server prints its ready line',
    from: ['persistent'],
    needs: ['persistent', 'ready'],
    workspace: app({
      srv: {
        command: 'sleep 0.5; touch booted; echo Listening on 3000; sleep 60',
        persistent: ready,
      },
      e2e: e2e('test -f booted && echo ran > e2e.txt'),
    }),
    steps: [
      {
        run: 'e2e',
        expect: { exit: 0, files: { 'packages/app/e2e.txt': 'ran\n' }, within: 30, alone: true },
      },
    ],
  }),

  defineCase({
    id: 'failure/server-dying-before-ready-fails',
    category: 'failure',
    kind: 'correctness',
    title:
      'A server that exits non-zero before its ready line fails the run and starts no dependant',
    from: ['persistent', 'persistent-ready-timeout'],
    needs: ['persistent', 'ready'],
    workspace: app({ srv: { command: 'echo nope; exit 2', persistent: ready }, e2e: e2e() }),
    steps: [
      {
        run: 'e2e',
        expect: {
          exit: 'fail',
          notRan: ['app#e2e'],
          files: { 'packages/app/e2e.txt': null },
          within: 30,
        },
      },
    ],
  }),

  defineCase({
    id: 'failure/missing-server-binary-fails-fast',
    category: 'failure',
    kind: 'correctness',
    title:
      'A server whose command does not exist fails the run at once, not after waiting for its ready line',
    from: ['persistent'],
    needs: ['persistent', 'ready'],
    workspace: app({
      srv: { command: '/this/binary/does/not/exist --serve', persistent: ready },
      e2e: e2e(),
    }),
    steps: [{ run: 'e2e', expect: { exit: 'fail', notRan: ['app#e2e'], within: 30 } }],
  }),

  defineCase({
    id: 'graph/setup-exiting-0-before-ready-lets-dependants-run',
    category: 'graph',
    kind: 'correctness',
    title:
      'A server-style task that finishes with exit 0 before its ready line lets its dependants run',
    why: 'It did its work and ended cleanly: there is no server left to wait for, and nothing failed.',
    from: ['persistent'],
    needs: ['persistent', 'ready'],
    workspace: app({
      srv: { command: 'echo seeded > seed.txt', persistent: ready },
      e2e: e2e('cat seed.txt > e2e.txt'),
    }),
    steps: [
      {
        run: 'e2e',
        expect: { exit: 0, files: { 'packages/app/e2e.txt': 'seeded\n' }, within: 30 },
      },
    ],
  }),

  defineCase({
    id: 'failure/stop-while-a-server-starts',
    category: 'failure',
    kind: 'correctness',
    title: 'Ctrl-C while a server is still starting ends it and starts none of its dependants',
    from: ['abort'],
    needs: ['persistent', 'ready'],
    workspace: app({ srv: { command: 'touch started; sleep 60', persistent: ready }, e2e: e2e() }),
    steps: [
      {
        run: 'e2e',
        stop: { signal: 'SIGINT', when: 'packages/app/started' },
        expect: {
          exit: 'fail',
          notRan: ['app#e2e'],
          files: { 'packages/app/e2e.txt': null },
          within: 30,
          alone: true,
        },
      },
    ],
  }),

  defineCase({
    id: 'failure/server-ready-after-the-stop-is-not-ready',
    category: 'failure',
    kind: 'correctness',
    title: 'A server that prints its ready line as Ctrl-C stops it does not start its dependants',
    why: 'The line came from its shutdown, after the user stopped the run.',
    from: ['abort'],
    needs: ['persistent', 'ready'],
    workspace: app({
      srv: {
        command: `trap 'echo Listening on 3000; exit 0' INT TERM; touch started; ${LOOP}`,
        persistent: ready,
      },
      e2e: e2e(),
    }),
    steps: [
      {
        run: 'e2e',
        stop: { signal: 'SIGINT', when: 'packages/app/started' },
        expect: {
          exit: 'fail',
          notRan: ['app#e2e'],
          files: { 'packages/app/e2e.txt': null },
          within: 30,
        },
      },
    ],
  }),

  defineCase({
    id: 'failure/never-ready-server-times-out',
    category: 'failure',
    kind: 'correctness',
    title: 'A server that never prints its ready line fails at its time limit, and is killed',
    why: 'Alive but never ready, it would otherwise hold the run open for good.',
    from: ['persistent-ready-timeout'],
    needs: ['persistent', 'ready', 'timeout'],
    workspace: app({
      srv: { command: 'echo wrong-banner; sleep 60', persistent: ready, timeout: 1 },
      e2e: e2e(),
    }),
    steps: [{ run: 'e2e', expect: { exit: 'fail', notRan: ['app#e2e'], within: 20, alone: true } }],
  }),

  defineCase({
    id: 'failure/ready-server-outlives-its-time-limit',
    category: 'failure',
    kind: 'correctness',
    title: 'A server that is ready inside its time limit keeps running past it',
    why: 'For a server the limit bounds the wait for its ready line, not its life.',
    from: ['persistent-ready-timeout'],
    needs: ['persistent', 'ready', 'timeout'],
    workspace: app({
      srv: {
        command: 'echo $$ > srv.pid; echo Listening on 3000; sleep 60',
        persistent: ready,
        timeout: 1,
      },
      e2e: e2e('sleep 1.5 && kill -0 $(cat srv.pid) && echo alive > e2e.txt'),
    }),
    steps: [
      {
        run: 'e2e',
        expect: { exit: 0, files: { 'packages/app/e2e.txt': 'alive\n' }, within: 30, alone: true },
      },
    ],
  }),

  defineCase({
    id: 'failure/never-ready-server-ignoring-sigterm-killed',
    category: 'failure',
    kind: 'correctness',
    title: 'A never-ready server that ignores SIGTERM is killed at its time limit anyway',
    from: ['persistent-ready-timeout'],
    needs: ['persistent', 'ready', 'timeout'],
    workspace: app({
      srv: { command: `trap '' TERM; echo wrong-banner; sleep 60`, persistent: ready, timeout: 1 },
      e2e: e2e(),
    }),
    steps: [{ run: 'e2e', expect: { exit: 'fail', notRan: ['app#e2e'], within: 20, alone: true } }],
  }),

  defineCase({
    id: 'failure/never-ready-server-trapping-exit-0-fails',
    category: 'failure',
    kind: 'correctness',
    title: 'A never-ready server that exits 0 on its time limit’s SIGTERM still fails',
    from: ['persistent-ready-timeout'],
    needs: ['persistent', 'ready', 'timeout'],
    workspace: app({
      srv: {
        command: `trap 'exit 0' TERM; echo wrong-banner; ${LOOP}`,
        persistent: ready,
        timeout: 1,
      },
      e2e: e2e(),
    }),
    steps: [{ run: 'e2e', expect: { exit: 'fail', notRan: ['app#e2e'], within: 20 } }],
  }),

  defineCase({
    id: 'failure/never-ready-server-child-killed',
    category: 'failure',
    kind: 'correctness',
    title:
      'A never-ready server’s backgrounded child that ignores SIGTERM dies with it at its time limit',
    why: 'The shell exits on SIGTERM at once; its child would hold the port into the next run.',
    from: ['persistent-ready-timeout'],
    needs: ['persistent', 'ready', 'timeout'],
    workspace: app({
      srv: { command: `sh -c "trap '' TERM; exec sleep 60" & wait`, persistent: ready, timeout: 1 },
      e2e: e2e(),
    }),
    steps: [{ run: 'e2e', expect: { exit: 'fail', notRan: ['app#e2e'], within: 20, alone: true } }],
  }),

  defineCase({
    id: 'failure/never-ready-cleanup-finishes',
    category: 'failure',
    kind: 'correctness',
    title: 'A never-ready server’s SIGTERM cleanup runs to its end at the time limit',
    why: 'A handler that runs once dies mid-cleanup if the server hears SIGTERM twice.',
    from: ['persistent-ready-timeout'],
    needs: ['persistent', 'ready', 'timeout'],
    workspace: app({
      srv: {
        command: `trap 'trap - TERM; sleep 0.2; echo done > clean.txt; exit 0' TERM; echo booting; ${LOOP}`,
        persistent: ready,
        timeout: 1,
      },
      e2e: e2e(),
    }),
    steps: [
      {
        run: 'e2e',
        expect: {
          exit: 'fail',
          notRan: ['app#e2e'],
          files: { 'packages/app/clean.txt': 'done\n' },
          within: 20,
        },
      },
    ],
  }),
]
