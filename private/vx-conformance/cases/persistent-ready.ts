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
    why: 'A server is useful to its dependants only once it accepts connections, and the ready line is how it says so. Starting the dependant as soon as the process spawns sends e2e tests to a port that is not open yet. That gives failures that come and go with machine speed, the worst kind to debug in CI.',
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
    why: 'A server that exits non-zero before it is ready has failed to start. Its dependants need it, so they must not start, and the run must fail rather than wait for a line that can never come. Otherwise CI either hangs until its own timeout or runs tests against nothing.',
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
    why: 'A command that does not exist fails at once, and the run should report it at once. Waiting for a ready line from a process that never started hides a clear error, like a missing install or a typo, behind a hang or a timeout. The developer should see the real cause in seconds.',
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
    why: 'A task that exits 0 before its ready line did its work and ended cleanly. Some setup steps, like seeding a database, are declared like a server but finish on their own. There is no server left to wait for and nothing failed, so its dependants run; failing or hanging would punish a task that succeeded.',
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
    why: 'Ctrl-C during a server’s start-up means the user no longer wants the run. The starting server must be ended, not left booting in the background, and none of its dependants may start. Otherwise the stop launches the very tests it was meant to cancel.',
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
    why: 'Readiness only counts while the run is still going. A server may print its ready line from its shutdown handler, after the user pressed Ctrl-C. Starting dependants on that line would launch new work after the stop, against a server that is about to exit.',
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
    why: 'A server that is alive but never prints its ready line will never be useful to its dependants. Without a limit it holds the run open for good, and in CI that is a job that hangs until it is cancelled. At its time limit the run fails with a clear reason, and the server is killed, not left running.',
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
    why: 'For a server, the time limit bounds the wait for its ready line, not its life. A dev server is meant to keep running while the tasks that use it do. Killing it once the limit passes would pull it from under the tests mid-run and fail them for no fault of their own.',
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
    why: 'A time limit must hold even for a server that ignores SIGTERM. Without escalating to SIGKILL, the server stays up and the run waits on it past its limit, which is the hang the limit was set to prevent. The run fails at the limit and leaves nothing running.',
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
    why: 'A server that never became ready has failed, however it exits. Many servers exit 0 on SIGTERM as their graceful shutdown, so the exit code after the time limit’s kill says nothing about readiness. Read as success, the run would go green with its dependants never run and nothing tested.',
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
    why: 'At its time limit a never-ready server must die with everything it started. Its shell exits on SIGTERM at once, while a child that ignores SIGTERM keeps running unless the runner kills the whole tree. That child would hold the server’s port into the next run, which then fails to bind.',
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
    why: 'Killing a server at its time limit should still let its cleanup finish. Many handlers run once and reset, so a second SIGTERM arriving during cleanup kills the server half way. A runner should send the signal once, wait a grace period, and only then use SIGKILL.',
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
