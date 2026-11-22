// Guards a run puts around a task: every declared output written, a task
// that never overlaps another, a hung task killed for its silence, an
// output pinned by checksum, a rebuild that proves a cached result, a
// server ready once its port opens.
import { defineCase, type TaskSpec, type WorkspaceSpec } from '../src/spec.ts'

const a = (tasks: Record<string, TaskSpec>): WorkspaceSpec => ({
  projects: { a: { tasks, files: { 'in.txt': 'in\n' } } },
})

/** Fails into `overlap.txt` at the root when another holder of the lock is inside. */
const HOLD =
  'if [ -e ../../held ]; then echo overlap >> ../../overlap.txt; fi; touch ../../held; sleep 1; rm -f ../../held; echo done > done.txt'

export default [
  defineCase({
    id: 'outputs/declared-output-never-written-fails',
    category: 'outputs',
    kind: 'correctness',
    title: 'A task that exits 0 but never writes a declared output fails, and nothing is cached',
    why: 'A declared output that matches no file after the command means the build did not do its job: the output path is wrong, or the tool skipped its emit. Treated as a success, the empty result is cached and every later run reports a hit that restores nothing. Failing the task says so where CI shows it, and the next run tries again.',
    from: ['missing-outputs', 'cache-declaration-warnings'],
    workspace: a({
      build: { command: 'echo built', inputs: ['in.txt'], outputs: ['dist/**'] },
    }),
    steps: [
      { run: 'build', expect: { exit: 'fail' } },
      { run: 'build', expect: { exit: 'fail', ran: ['a#build'] } },
    ],
  }),

  defineCase({
    id: 'outputs/optional-output-left-unwritten-passes',
    category: 'outputs',
    kind: 'correctness',
    title:
      'An output marked optional may be left unwritten: the task passes and its other outputs are cached',
    why: 'Some outputs exist only some of the time, like a coverage report a test run writes only when asked. Marking such an output optional keeps the strict check on every other output while this one may be absent. The run passes, the outputs that were written are cached, and the next run replays them.',
    from: ['missing-outputs'],
    needs: ['optional-outputs'],
    workspace: a({
      test: {
        command: 'mkdir -p dist && echo built > dist/a.txt',
        inputs: ['in.txt'],
        outputs: ['dist/**'],
        optionalOutputs: ['coverage/**'],
      },
    }),
    steps: [
      { run: 'test', expect: { exit: 0, files: { 'packages/a/dist/a.txt': 'built\n' } } },
      { write: { 'packages/a/dist/a.txt': null } },
      {
        run: 'test',
        expect: { exit: 0, notRan: ['a#test'], files: { 'packages/a/dist/a.txt': 'built\n' } },
      },
    ],
  }),

  defineCase({
    id: 'graph/mutex-tasks-never-overlap',
    category: 'graph',
    kind: 'correctness',
    title: 'Two tasks that share one resource never run at the same time',
    why: 'Tasks that share one port, one database or one emulator break each other when they overlap, and the break comes and goes with timing. Lowering the whole run to one task at a time fixes it at the cost of every other task. Naming the shared resource on those tasks keeps them apart while everything else still runs in parallel.',
    from: ['run-concurrency'],
    needs: ['mutex'],
    workspace: {
      projects: {
        a: { tasks: { db: { command: HOLD, cache: false, mutex: 'db' } } },
        b: { tasks: { db: { command: HOLD, cache: false, mutex: 'db' } } },
      },
    },
    steps: [
      {
        run: 'db',
        expect: {
          exit: 0,
          ran: ['a#db', 'b#db'],
          files: {
            'overlap.txt': null,
            'packages/a/done.txt': 'done\n',
            'packages/b/done.txt': 'done\n',
          },
        },
      },
    ],
  }),

  defineCase({
    id: 'failure/idle-timeout-kills-a-silent-task',
    category: 'failure',
    kind: 'correctness',
    title: 'A task that prints nothing past its idle limit is killed and fails the run',
    why: 'A hung test often stops printing long before any wall-clock limit would end it, and that limit has to be generous enough for the slowest healthy run. A limit on silence ends the hung task early while a long task that keeps reporting progress runs on. The run fails, so CI shows the hang instead of waiting out its own timeout.',
    from: ['task-timeout'],
    needs: ['idle-timeout'],
    workspace: a({
      hang: {
        command: 'echo started; echo started > out.txt; sleep 60; echo done > out.txt',
        idleTimeout: 2,
        inputs: ['in.txt'],
        outputs: ['out.txt'],
      },
    }),
    steps: [{ run: 'hang', expect: { exit: 'fail', within: 30, alone: true } }],
  }),

  defineCase({
    id: 'failure/idle-timeout-spares-a-task-that-prints',
    category: 'failure',
    kind: 'correctness',
    title: 'A task that keeps printing outlives its idle limit and succeeds',
    why: 'An idle limit measures silence, not length. A task that runs longer than the limit but prints along the way is working and must succeed. A runner that read the limit as a wall-clock one would kill healthy long builds.',
    from: ['task-timeout'],
    needs: ['idle-timeout'],
    workspace: a({
      long: {
        command: 'for i in 1 2 3 4 5 6 7 8; do echo tick $i; sleep 0.5; done; echo done > out.txt',
        idleTimeout: 2,
        inputs: ['in.txt'],
        outputs: ['out.txt'],
      },
    }),
    steps: [
      { run: 'long', expect: { exit: 0, files: { 'packages/a/out.txt': 'done\n' }, within: 30 } },
    ],
  }),

  defineCase({
    id: 'outputs/checksum-mismatch-fails',
    category: 'outputs',
    kind: 'correctness',
    title:
      'An output pinned by checksum fails the task when its bytes differ, and passes when they match',
    why: 'A pinned checksum says exactly which bytes a task must produce, as a downloaded toolchain or a vendored archive should. A build that writes anything else is wrong, however it exits, and caching it would spread the wrong bytes. Once the bytes match, the task passes.',
    from: ['artifact-roundtrip'],
    needs: ['output-checksum'],
    workspace: a({
      fetch: {
        command: 'echo drifted > out.txt',
        inputs: ['in.txt'],
        outputs: ['out.txt'],
        checksum: { file: 'out.txt', text: 'pinned\n' },
      },
    }),
    steps: [
      { run: 'fetch', expect: { exit: 'fail' } },
      {
        configure: (ws) => {
          ws.projects['a']!.tasks!['fetch']!.command = 'echo pinned > out.txt'
          return ws
        },
      },
      { run: 'fetch', expect: { exit: 0, files: { 'packages/a/out.txt': 'pinned\n' } } },
    ],
  }),

  defineCase({
    id: 'cache/check-run-catches-a-nondeterministic-task',
    category: 'cache',
    kind: 'correctness',
    title: 'A check run rebuilds a cached task and fails when its bytes come out different',
    why: 'A cache is only as good as the tasks it stores: one whose output changes from run to run makes every hit a guess about which build you got. A check run rebuilds the cached task and compares, so the nondeterminism shows up as a failure in one place. Without it, it shows up as builds that differ by machine.',
    from: ['cache'],
    needs: ['determinism-check'],
    workspace: a({
      stamp: {
        command: 'od -An -N8 -tx8 /dev/urandom > out.txt',
        inputs: ['in.txt'],
        outputs: ['out.txt'],
      },
    }),
    steps: [
      { run: 'stamp', expect: { exit: 0 } },
      { run: 'stamp', verify: true, expect: { exit: 'fail' } },
    ],
  }),

  defineCase({
    id: 'cache/check-run-passes-a-reproducible-task',
    category: 'cache',
    kind: 'correctness',
    title: 'A check run passes a cached task that rebuilds to the same bytes',
    why: 'A check run is meant to prove a cached result, and a reproducible task must pass it. A check that failed reproducible tasks too, by comparing timestamps or paths, would be switched off and catch nothing.',
    from: ['cache'],
    needs: ['determinism-check'],
    workspace: a({
      same: { command: 'echo same > out.txt', inputs: ['in.txt'], outputs: ['out.txt'] },
    }),
    steps: [
      { run: 'same', expect: { exit: 0 } },
      { run: 'same', verify: true, expect: { exit: 0, files: { 'packages/a/out.txt': 'same\n' } } },
    ],
  }),

  defineCase({
    id: 'graph/dependant-waits-for-port',
    category: 'graph',
    kind: 'correctness',
    title: 'A task that needs a server starts only once the server accepts connections on its port',
    why: 'Many servers print nothing reliable when they are ready, but every one of them opens its port. Waiting for the port means a dependant never meets a closed socket, whatever the server logs. Starting the dependant as soon as the process spawns gives e2e failures that come and go with machine speed.',
    from: ['persistent'],
    needs: ['persistent', 'ready-port'],
    workspace: {
      projects: {
        app: {
          files: { 'src/a.txt': 'app\n' },
          tasks: {
            srv: {
              // It prints nothing, and marks itself up only once its port is open.
              command: `sleep 1; exec bun -e "Bun.serve({ port: 41731, hostname: '127.0.0.1', fetch: () => new Response('ok') }); require('node:fs').writeFileSync('booted', '')"`,
              persistent: { port: 41731 },
            },
            e2e: {
              command: 'test -f booted && echo ran > e2e.txt',
              dependsOn: ['srv'],
              cache: false,
            },
          },
        },
      },
    },
    steps: [
      {
        run: 'e2e',
        expect: { exit: 0, files: { 'packages/app/e2e.txt': 'ran\n' }, within: 30, alone: true },
      },
    ],
  }),
]
