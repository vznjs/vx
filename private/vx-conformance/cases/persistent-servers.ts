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
    why: 'An e2e suite against a dev server is the reason to depend on one; killing the server when the dependant starts (nx#27986), or refusing the edge, leaves no way to say it.',
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
    why: 'A server that is SIGKILLed outright cannot remove its lock file, flush its log or release its port cleanly.',
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
    why: '`server & wait`: the shell dies on SIGTERM, the server it started ignores it and holds the output pipe (nx#8286).',
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
    why: 'A server never exits: a scheduler that holds its one slot until it does never starts the task that needs it.',
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
    why: 'Once the server was up, its dependants ran together past the limit (nx#31494, nx#34117).',
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
    why: 'An app’s dev server over a library’s watcher is the common shape; refusing the edge or starting the app without its upstream breaks it (turborepo#8484).',
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
    why: 'Servers never finish, so they cannot wait for a slot: some of a filter’s servers never started (turborepo#4107).',
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
    why: 'Booting a dev server for a run that runs nothing against it costs its whole start-up time (X-59). The server declares it reads no files, so its dependant can be keyed.',
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
    why: 'Built against a dead server, the dependant reads as a pass or fails for the wrong reason; the run must say the server died.',
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
    why: 'A server spawned after the stop comes up after the teardown and holds the run open.',
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

  ...(['SIGINT', 'SIGTERM'] as const).map((signal) =>
    defineCase({
      id: `failure/${signal.toLowerCase()}-reaches-server-as-itself`,
      category: 'failure',
      kind: 'correctness',
      title: `${signal} to the run reaches a running server as ${signal}`,
      why: 'A server’s shutdown hook bound to one signal runs only if that signal arrives (turborepo#444, #12652, nx#23585).',
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
    why: 'The child of a continuous task, trapping TERM, INT and HUP, outlived Ctrl-C (nx#33460, nx#32438).',
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
