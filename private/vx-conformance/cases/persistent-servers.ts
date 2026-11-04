// Long-running tasks (dev servers): what runs before and beside one, how a
// run that needs one ends, and that it ends with nothing left running.
// Without a ready line a server counts as up once it spawns, so a task
// that needs it waits for the file it writes.
import { defineCase, type TaskSpec, type WorkspaceSpec } from '../src/spec.ts'
import { chainProject } from './shapes.ts'

/** Wait (bounded) for a file, then go on. */
const until = (file: string) =>
  `i=0; until [ -e ${file} ] || [ $i -ge 400 ]; do sleep 0.05; i=$((i+1)); done; [ -e ${file} ]`

/** A server that writes its shell's pid, then runs until stopped. */
const SERVER = 'echo $$ > srv.pid; sleep 60'

const app = (tasks: Record<string, TaskSpec>): WorkspaceSpec => ({
  projects: { app: { tasks, files: { 'src/a.txt': 'app\n' } } },
})

export default [
  defineCase({
    id: 'graph/server-after-its-deps-until-stopped',
    category: 'graph',
    kind: 'correctness',
    title:
      'A dev server starts after its dependencies’ builds and runs until Ctrl-C, which ends it',
    why: 'A dev server serves what its dependencies built, so it starts only after those builds finish. It then runs until the user stops it, because a server has no natural end. Ctrl-C ends it, and the run with it, so the port is free for the next start.',
    from: ['persistent', 'signal-handling'],
    needs: ['persistent'],
    workspace: {
      projects: {
        lib: chainProject('lib'),
        app: {
          deps: ['lib'],
          tasks: {
            dev: {
              command: 'test -f ../lib/dist/out.txt && touch up && sleep 60',
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
        expect: {
          ran: ['lib#build', 'app#dev'],
          order: [['lib#build', 'app#dev']],
          files: { 'packages/app/up': '' },
          within: 30,
          alone: true,
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/server-up-while-its-dependant-runs',
    category: 'graph',
    kind: 'correctness',
    title:
      'A task that needs a server runs while the server is up, and the run ends when the task does',
    why: 'Depending on a server means the task needs it running, as an e2e suite needs a dev server. The server stays up while the task runs, and the run ends when the task does, since nothing else needs the server. Killing the server when the dependant starts, or refusing the edge, leaves no way to express the most common use of a server.',
    from: ['persistent', 'persistent-shutdown'],
    needs: ['persistent'],
    workspace: app({
      srv: { command: SERVER, persistent: true },
      e2e: {
        command: `${until('srv.pid')} && sleep 0.3 && kill -0 $(cat srv.pid) && echo alive > alive.txt`,
        dependsOn: ['srv'],
        cache: false,
      },
    }),
    steps: [
      {
        run: 'e2e',
        expect: {
          exit: 0,
          ran: ['app#srv', 'app#e2e'],
          files: { 'packages/app/alive.txt': 'alive\n' },
          within: 30,
          alone: true,
        },
      },
    ],
  }),

  defineCase({
    id: 'failure/server-stopped-when-its-dependant-fails',
    category: 'failure',
    kind: 'correctness',
    title: 'A run whose task fails beside a server fails promptly and stops the server',
    why: 'Once the task that needs a server fails, the server has nothing left to serve. The run should fail at once and stop the server, not keep going until someone notices. In CI, a server left up after a failure holds the job open until its timeout and buries the real error under a cancelled job.',
    from: ['persistent'],
    needs: ['persistent'],
    workspace: app({
      srv: { command: SERVER, persistent: true },
      e2e: { command: `${until('srv.pid')} && exit 7`, dependsOn: ['srv'], cache: false },
    }),
    steps: [{ run: 'e2e', expect: { exit: 'fail', ran: ['app#e2e'], within: 30, alone: true } }],
  }),

  defineCase({
    id: 'graph/server-cleans-up-when-the-run-ends',
    category: 'graph',
    kind: 'correctness',
    title: 'A server the run no longer needs is asked to stop politely, so its cleanup runs',
    why: 'When a run no longer needs a server, the server should be asked to stop with a catchable signal before anything harsher. That gives it the chance to remove a lock file, flush its log and release its port. A server killed outright with SIGKILL leaves that state behind, and the next start may refuse to run.',
    from: ['persistent-shutdown'],
    needs: ['persistent'],
    workspace: app({
      srv: {
        command: `trap 'echo cleaned > cleaned.txt; exit 0' INT TERM HUP; touch up; while :; do sleep 0.05; done`,
        persistent: true,
      },
      e2e: { command: `${until('up')} && echo ok`, dependsOn: ['srv'], cache: false },
    }),
    steps: [
      {
        run: 'e2e',
        expect: {
          exit: 0,
          files: { 'packages/app/cleaned.txt': 'cleaned\n' },
          within: 30,
          alone: true,
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/server-ignoring-sigterm-does-not-hang-the-end',
    category: 'graph',
    kind: 'correctness',
    title: 'A server that ignores SIGTERM does not keep a finished run from exiting',
    why: 'A finished run must exit even if a server it started will not stop politely. A server that ignores SIGTERM would otherwise hold the run open after its work is done. After a grace period the runner kills it, so CI moves on and no server is left behind.',
    from: ['persistent', 'persistent-shutdown'],
    needs: ['persistent'],
    workspace: app({
      srv: { command: `trap '' INT TERM HUP; touch up; sleep 60`, persistent: true },
      e2e: { command: `${until('up')} && echo ok`, dependsOn: ['srv'], cache: false },
    }),
    steps: [{ run: 'e2e', expect: { exit: 0, within: 30, alone: true } }],
  }),

  defineCase({
    id: 'graph/server-child-ignoring-sigterm-does-not-hang-the-end',
    category: 'graph',
    kind: 'correctness',
    title: 'A server’s own child that ignores SIGTERM does not keep a finished run from exiting',
    why: 'A run is not over until every process it started has ended. With `server & wait`, the shell dies on SIGTERM, but the server it started ignores the signal and keeps the output pipe open. A runner that waits for that pipe to close hangs, and one that never kills the child leaves it running.',
    from: ['task-tree-kill', 'persistent-shutdown'],
    needs: ['persistent'],
    workspace: app({
      srv: {
        command: `sh -c 'trap "" TERM INT HUP; exec sleep 60' & touch up; wait`,
        persistent: true,
      },
      e2e: { command: `${until('up')} && echo ok`, dependsOn: ['srv'], cache: false },
    }),
    steps: [{ run: 'e2e', expect: { exit: 0, within: 30, alone: true } }],
  }),

  defineCase({
    id: 'failure/server-exiting-at-once-fails-the-run',
    category: 'failure',
    kind: 'correctness',
    title: 'A server that exits non-zero as it starts fails the run instead of hanging it',
    why: 'A server that exits non-zero as it starts has failed, and the run should say so. Waiting for a server that is already gone hangs the terminal or the CI job with no visible cause. Failing at once shows the server’s own error output while it is still on screen.',
    from: ['persistent'],
    needs: ['persistent'],
    workspace: app({ dev: { command: 'echo nope; exit 2', persistent: true } }),
    steps: [{ run: 'dev', expect: { exit: 'fail', within: 30 } }],
  }),

  defineCase({
    id: 'failure/server-shell-exit-takes-its-child',
    category: 'failure',
    kind: 'correctness',
    title: 'A server whose shell exits leaves nothing it started holding its port',
    why: 'When a server’s shell exits, everything it started must end with it. A process left behind keeps the port bound, so the next `dev` fails with an address-in-use error that has no visible cause. The run fails, and nothing from it is left running.',
    from: ['persistent'],
    needs: ['persistent'],
    workspace: app({ dev: { command: 'sleep 60 & exit 1', persistent: true } }),
    steps: [{ run: 'dev', expect: { exit: 'fail', within: 30, alone: true } }],
  }),

  defineCase({
    id: 'graph/one-slot-does-not-deadlock',
    category: 'graph',
    kind: 'correctness',
    title: 'At a concurrency of 1 a server’s dependant still runs',
    why: 'A server never exits on its own, so it cannot hold a concurrency slot the way a build does. A scheduler that keeps the only slot for the server until it ends never starts the task that needs it, and the run hangs. Servers run beside the limit so their dependants can still run within it.',
    from: ['persistent'],
    needs: ['persistent'],
    workspace: app({
      srv: { command: SERVER, persistent: true },
      e2e: { command: `${until('srv.pid')} && echo ok`, dependsOn: ['srv'], cache: false },
    }),
    steps: [
      {
        run: 'e2e',
        concurrency: 1,
        expect: { exit: 0, ran: ['app#e2e'], within: 30, alone: true },
      },
    ],
  }),

  defineCase({
    id: 'graph/one-slot-runs-dependants-one-at-a-time',
    category: 'graph',
    kind: 'correctness',
    title: 'At a concurrency of 1 the tasks behind a running server still run one at a time',
    why: 'A concurrency limit is often set to protect a machine or a shared resource, such as a database the tests use. Once a server is up, its dependants must still run within that limit, one at a time at a concurrency of 1. Releasing them all together breaks the limit and can make tests that share state fail.',
    from: ['persistent'],
    needs: ['persistent'],
    workspace: {
      projects: {
        srv: { tasks: { dev: { command: SERVER, persistent: true } } },
        x: {
          tasks: {
            step: {
              command: 'mkdir ../../lock && sleep 0.4 && rmdir ../../lock',
              dependsOn: ['srv#dev'],
              cache: false,
            },
          },
        },
        y: {
          tasks: {
            step: {
              command: 'mkdir ../../lock && sleep 0.4 && rmdir ../../lock',
              dependsOn: ['srv#dev'],
              cache: false,
            },
          },
        },
      },
    },
    steps: [
      {
        run: 'step',
        concurrency: 1,
        expect: { exit: 0, ran: ['x#step', 'y#step'], within: 30, alone: true },
      },
    ],
  }),

  defineCase({
    id: 'graph/server-over-a-server',
    category: 'graph',
    kind: 'correctness',
    title:
      'A server that depends on another server starts after it, and both stay up while a task needs them',
    why: 'An app’s dev server on top of a library’s watcher is a common setup. The app’s server must start after the server it depends on, and both must stay up while a task uses them. Refusing the edge, or starting the app before its upstream, leaves the developer starting the two by hand.',
    from: ['persistent'],
    needs: ['persistent'],
    workspace: {
      projects: {
        lib: { tasks: { dev: { command: SERVER, persistent: true } } },
        app: {
          deps: ['lib'],
          tasks: {
            dev: {
              command: `${until('../lib/srv.pid')} && ${SERVER}`,
              dependsOn: ['^dev'],
              persistent: true,
            },
            e2e: {
              command: `${until('srv.pid')} && sleep 0.3 && kill -0 $(cat ../lib/srv.pid) && kill -0 $(cat srv.pid) && echo both > both.txt`,
              dependsOn: ['dev'],
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
          ran: ['lib#dev', 'app#dev', 'app#e2e'],
          files: { 'packages/app/both.txt': 'both\n' },
          within: 30,
          alone: true,
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/every-selected-server-starts',
    category: 'graph',
    kind: 'correctness',
    title: 'Every server a run selects starts, at a concurrency below their count',
    why: 'Servers never finish, so they cannot wait in line for a concurrency slot that will never free up. If they count against the limit, some of the servers a filter selects never start, and the app that needs them waits forever. Every selected server starts, whatever the limit.',
    from: ['persistent'],
    needs: ['persistent'],
    workspace: {
      projects: {
        ...Object.fromEntries(
          ['p1', 'p2', 'p3', 'p4', 'p5'].map((p) => [
            p,
            { tasks: { dev: { command: `touch ../../started-${p}; sleep 60`, persistent: true } } },
          ]),
        ),
        front: {
          deps: ['p1', 'p2', 'p3', 'p4', 'p5'],
          tasks: {
            dev: {
              command: `${['p1', 'p2', 'p3', 'p4', 'p5'].map((p) => until(`../../started-${p}`)).join(' && ')} && touch ../../started-front; sleep 60`,
              dependsOn: ['^dev'],
              persistent: true,
            },
          },
        },
      },
    },
    steps: [
      {
        run: 'dev',
        concurrency: 2,
        stop: { signal: 'SIGINT', when: 'started-front' },
        expect: {
          ran: ['p1#dev', 'p2#dev', 'p3#dev', 'p4#dev', 'p5#dev', 'front#dev'],
          files: { 'started-front': '' },
          within: 60,
          alone: true,
        },
      },
    ],
  }),

  defineCase({
    id: 'cache/server-not-started-for-cached-dependants',
    category: 'cache',
    kind: 'efficiency',
    title: 'A server only cached tasks need is not started when they all replay',
    why: 'A server is started only to serve the tasks that need it. When all of those tasks replay from the cache, nothing runs against it, so booting it wastes its whole start-up time. Here the server declares it reads no files, so its dependant can be keyed without it, and an edit to the dependant brings the server back.',
    from: ['persistent'],
    needs: ['persistent'],
    workspace: {
      projects: {
        api: {
          tasks: {
            dev: {
              command: 'touch up; echo boot >> ../../boots.log; sleep 60',
              persistent: true,
              inputs: [],
            },
          },
        },
        web: {
          tasks: {
            e2e: {
              command: `${until('../api/up')} && mkdir -p dist && cat src/a.txt > dist/out.txt`,
              dependsOn: ['api#dev'],
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'web\n' },
        },
      },
    },
    steps: [
      {
        run: 'e2e',
        projects: ['web'],
        expect: { exit: 0, ran: ['api#dev', 'web#e2e'], within: 30 },
      },
      {
        run: 'e2e',
        projects: ['web'],
        expect: { exit: 0, notRan: ['api#dev', 'web#e2e'], within: 30, alone: true },
      },
      { write: { 'packages/web/src/a.txt': 'edited\n' } },
      {
        run: 'e2e',
        projects: ['web'],
        expect: {
          exit: 0,
          ran: ['api#dev', 'web#e2e'],
          files: { 'packages/web/dist/out.txt': 'edited\n' },
          within: 30,
        },
      },
    ],
  }),

  defineCase({
    id: 'failure/server-death-skips-what-needs-it',
    category: 'failure',
    kind: 'correctness',
    title:
      'A server that dies mid-run keeps the tasks that need it from starting, and fails the run',
    why: 'A task that needs a server cannot give a real result once the server is gone. Run anyway, it either fails with an unrelated connection error or passes against nothing. The run should skip what still needs the server and fail, so the server’s death is the error the developer sees.',
    from: ['server-crash-fail-fast', 'server-crash-through-group'],
    needs: ['persistent'],
    workspace: app({
      srv: {
        command: 'echo $$ > srv.pid; while [ ! -f stop ]; do sleep 0.02; done; exit 7',
        persistent: true,
      },
      a: {
        command: `${until('srv.pid')} && touch stop && while kill -0 $(cat srv.pid) 2>/dev/null; do sleep 0.02; done`,
        dependsOn: ['srv'],
        cache: false,
      },
      c: { command: 'touch c.ran', dependsOn: ['srv', 'a'], cache: false },
    }),
    steps: [
      {
        run: 'c',
        expect: {
          exit: 'fail',
          notRan: ['app#c'],
          files: { 'packages/app/c.ran': null },
          within: 30,
          alone: true,
        },
      },
    ],
  }),

  defineCase({
    id: 'failure/stop-before-the-server-starts',
    category: 'failure',
    kind: 'correctness',
    title: 'Ctrl-C before a server’s turn leaves it unstarted',
    why: 'After Ctrl-C, no new task should start, servers included. A server spawned after the stop comes up after the teardown has run, so nothing ends it. It then holds the run open, or keeps running in the background with its port taken.',
    from: ['persistent-stop-before-spawn', 'stop-signal-before-spawn'],
    needs: ['persistent'],
    workspace: app({
      build: { command: 'touch started; sleep 60', cache: false },
      dev: { command: 'echo up > up.txt; sleep 60', dependsOn: ['build'], persistent: true },
    }),
    steps: [
      {
        run: 'dev',
        stop: { signal: 'SIGINT', when: 'packages/app/started' },
        expect: {
          exit: 'fail',
          notRan: ['app#dev'],
          files: { 'packages/app/up.txt': null },
          within: 30,
          alone: true,
        },
      },
    ],
  }),

  ...(
    [
      [
        'SIGINT',
        'A server should receive the signal the user sent, unchanged. Dev servers often bind their shutdown to SIGINT, the Ctrl-C signal, to close connections and remove temp files. If the runner forwards it as SIGTERM or SIGKILL, that hook never runs and the server’s state is left behind for the next start.',
      ],
      [
        'SIGTERM',
        'A server should receive SIGTERM as SIGTERM. Containers and CI agents send it to ask for a graceful shutdown, and servers bind their drain and cleanup code to it. Forwarded as another signal, that code is skipped, and open connections, lock files or temp files are left as they were.',
      ],
    ] as const
  ).map(([signal, why]) =>
    defineCase({
      id: `failure/${signal.toLowerCase()}-reaches-server-as-itself`,
      category: 'failure',
      kind: 'correctness',
      title: `${signal} to the run reaches a running server as ${signal}`,
      why,
      from: ['signal-handling'],
      needs: ['persistent'],
      workspace: app({
        dev: {
          command: `trap 'echo SIGINT > got.txt; exit 0' INT; trap 'echo SIGTERM > got.txt; exit 0' TERM; touch up; while :; do sleep 0.05; done`,
          persistent: true,
        },
      }),
      steps: [
        {
          run: 'dev',
          stop: { signal, when: 'packages/app/up' },
          expect: { files: { 'packages/app/got.txt': `${signal}\n` }, within: 30, alone: true },
        },
      ],
    }),
  ),

  defineCase({
    id: 'failure/stop-reaps-a-server-child-that-ignores-it',
    category: 'failure',
    kind: 'correctness',
    title: 'Ctrl-C ends a server’s own child that traps every signal it can',
    why: 'Ctrl-C must end everything a server started, even a child that traps every signal it can. Such a child would otherwise outlive the run, keep its port and keep printing into the terminal. After a grace period the runner kills it with SIGKILL, which cannot be trapped.',
    from: ['signal-handling'],
    needs: ['persistent'],
    workspace: app({
      dev: {
        command: `sh -c 'trap "" TERM INT HUP; exec sleep 60' & touch up; wait`,
        persistent: true,
      },
    }),
    steps: [
      {
        run: 'dev',
        stop: { signal: 'SIGINT', when: 'packages/app/up' },
        expect: { within: 30, alone: true },
      },
    ],
  }),
]
