// Outcomes drawn from Nix's functional tests (timeout.sh, fixed.sh,
// check.sh, multiple-outputs.sh, dependencies.sh, structured-attrs.sh) and
// from Vite Task's crates (the execution graph, the env rules, the e2e
// fixtures on fail-fast and topological runs) that no earlier case carried.
// Each is said as what runs, what fails and what is left on disk.
import { defineCase, MEET, type TaskSpec, type WorkspaceSpec } from '../src/spec.ts'
import { chainBuild, chainProject, out } from './shapes.ts'

const a = (tasks: Record<string, TaskSpec>, files: Record<string, string> = {}): WorkspaceSpec => ({
  projects: { a: { tasks, files: { 'in.txt': 'in\n', ...files } } },
})

/** The case's shared scratch, seen from a project directory. */
const M = `../../${MEET}`

/** Fails on its first attempt, passes on every later one. */
const flaky = (then: string) => `if [ -f flag ]; then ${then}; else touch flag; exit 1; fi`

/** A member's package.json as the harness writes it, with other dependency fields. */
const manifest = (name: string, fields: Record<string, Record<string, string>> = {}) =>
  JSON.stringify({ name, version: '0.0.0', private: true, dependencies: {}, ...fields }, null, 2)

/** The root package.json the harness writes, with these member directories. */
const rootManifest = (dirs: string[]) =>
  JSON.stringify(
    { name: 'conformance', private: true, packageManager: `bun@${Bun.version}`, workspaces: dirs },
    null,
    2,
  )

/** Writes the two files a pinned-output task is judged by, in one tree. */
const TWO_TREES: TaskSpec = {
  command:
    'mkdir -p dist types && cat src/a.txt > dist/out.txt && echo "types of $(cat src/a.txt)" > types/out.d.txt',
  inputs: ['src/**'],
  outputs: ['dist/**', 'types/**'],
}

/** Reads the dependency’s output if there is one, then its own source. */
const TOLERANT: TaskSpec = {
  command:
    'mkdir -p dist && { cat ../lib/dist/out.txt 2>/dev/null; cat src/a.txt; } > dist/out.txt',
  dependsOn: ['^build'],
  inputs: ['src/**'],
  outputs: ['dist/**'],
}

/** Builds from its own source only, after its dependencies. */
const OWN: TaskSpec = {
  command: 'mkdir -p dist && cat src/a.txt > dist/out.txt',
  dependsOn: ['^build'],
  inputs: ['src/**'],
  outputs: ['dist/**'],
}

export default [
  // Nix tests/functional/timeout.sh: `infiniteLoop` prints dots for ever and
  // still times out under `--timeout 2`.
  defineCase({
    id: 'failure/timeout-fires-on-a-task-that-keeps-printing',
    category: 'failure',
    kind: 'correctness',
    title: 'A task that keeps printing is still killed at its time limit',
    why: 'A time limit counts wall-clock time, not silence. A task stuck in a loop that prints a progress line every few milliseconds is as hung as one that prints nothing. A runner that resets the clock on each line, mixing up a time limit with an idle limit, lets that loop hold the run and the CI job for good.',
    from: ['task-timeout', 'timeout-bounds'],
    needs: ['timeout'],
    workspace: a({
      spin: {
        command: 'echo started > out.txt; while :; do echo tick; sleep 0.05; done',
        timeout: 1,
        inputs: ['in.txt'],
        outputs: ['out.txt'],
      },
    }),
    steps: [
      { run: 'spin', expect: { exit: 'fail', within: 20, alone: true } },
      { run: 'spin', expect: { exit: 'fail', ran: ['a#spin'], within: 20, alone: true } },
    ],
  }),

  // Nix tests/functional/timeout.sh: `closeLog` sends its output to
  // /dev/null and sleeps; `max-silent-time` must still end it.
  defineCase({
    id: 'failure/idle-timeout-kills-a-task-that-closed-its-output',
    category: 'failure',
    kind: 'correctness',
    title: 'A task that sends its output to /dev/null and hangs is killed at its idle limit',
    why: 'An idle limit is there to end a task that has stopped making progress. A task that points its own output at /dev/null and then hangs prints nothing from that moment, so it is idle. A runner that only watches for silence while the output pipe is open, and waits for the pipe to close otherwise, never fires the limit on it.',
    from: ['task-timeout'],
    needs: ['idle-timeout'],
    workspace: a({ quiet: { command: 'echo hi; exec >/dev/null 2>&1; sleep 60', idleTimeout: 2 } }),
    steps: [{ run: 'quiet', expect: { exit: 'fail', within: 30, alone: true } }],
  }),

  // Nix tests/functional/timeout.sh: `max-silent-time` counts any log
  // output, and a build's log is both of its streams.
  defineCase({
    id: 'failure/idle-timeout-spared-by-error-stream-output',
    category: 'failure',
    kind: 'correctness',
    title: 'A task that prints only to its error stream outlives its idle limit',
    why: 'Many tools write their progress to stderr and keep stdout for results. A task doing that is busy, and it says so on the stream it has. A runner that watches only stdout for signs of life kills such tasks while they work.',
    from: ['task-timeout'],
    needs: ['idle-timeout'],
    workspace: a({
      busy: {
        command: 'for i in 1 2 3 4 5 6; do echo tick >&2; sleep 0.5; done; echo done > out.txt',
        idleTimeout: 2,
      },
    }),
    steps: [{ run: 'busy', expect: { exit: 0, files: { 'packages/a/out.txt': 'done\n' } } }],
  }),

  // Nix tests/functional/timeout.nix: the builder prints with `echo -n`,
  // dots and no newline.
  defineCase({
    id: 'failure/idle-timeout-spared-by-output-without-newlines',
    category: 'failure',
    kind: 'correctness',
    title: 'A task that prints dots with no newline outlives its idle limit',
    why: 'A progress bar prints a character at a time and ends the line only when it is done. Those bytes are output, so the task is not idle. A runner that counts only finished lines sees nothing until the bar ends and kills a task that was working all along.',
    from: ['task-timeout'],
    needs: ['idle-timeout'],
    workspace: a({
      dots: {
        command: 'for i in 1 2 3 4 5 6; do printf .; sleep 0.5; done; echo done > out.txt',
        idleTimeout: 2,
      },
    }),
    steps: [{ run: 'dots', expect: { exit: 0, files: { 'packages/a/out.txt': 'done\n' } } }],
  }),

  // Nix tests/functional/timeout.sh: a builder's children write to the same
  // log as the builder.
  defineCase({
    id: 'failure/idle-timeout-spared-by-a-child-printing',
    category: 'failure',
    kind: 'correctness',
    title: 'A task whose background child prints while the task waits outlives its idle limit',
    why: 'A task is its whole process tree, and its output is what any of those processes print. A script that starts a worker and waits for it says nothing itself, while the worker reports progress. A runner that counts only what the top process writes kills the task in the middle of its work.',
    from: ['task-timeout'],
    needs: ['idle-timeout'],
    workspace: a({
      parent: {
        command:
          "sh -c 'for i in 1 2 3 4 5 6; do echo tick; sleep 0.5; done' & wait; echo done > out.txt",
        idleTimeout: 2,
      },
    }),
    steps: [{ run: 'parent', expect: { exit: 0, files: { 'packages/a/out.txt': 'done\n' } } }],
  }),

  // Nix tests/functional/timeout.sh: `silent` is killed by `max-silent-time`
  // and reported as a failed build, never registered.
  defineCase({
    id: 'failure/idle-timed-out-dependency-skips-dependants',
    category: 'failure',
    kind: 'correctness',
    title:
      'A dependency killed at its idle limit keeps its dependants from running, and is run again next time',
    why: 'A task killed for going silent did not finish, so it failed like any other. What depends on it must not run on its missing output, and nothing of it may be cached. The next run starts it again rather than replaying a result it never produced.',
    from: ['task-timeout', 'failure-mode'],
    needs: ['idle-timeout'],
    workspace: {
      projects: {
        lib: {
          tasks: {
            build: {
              command: 'mkdir -p dist && echo partial > dist/out.txt && sleep 60',
              idleTimeout: 1,
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'lib\n' },
        },
        app: chainProject('app', ['lib']),
      },
    },
    steps: [
      {
        run: 'build',
        expect: {
          exit: 'fail',
          notRan: ['app#build'],
          files: { [out('app')]: null },
          within: 30,
          alone: true,
        },
      },
      {
        run: 'build',
        expect: { exit: 'fail', ran: ['lib#build'], notRan: ['app#build'], within: 30 },
      },
    ],
  }),

  // Nix tests/functional/timeout.sh: the silent builder is `touch $out;
  // sleep 60`: it did work, then went quiet.
  defineCase({
    id: 'failure/idle-timeout-counts-silence-after-output',
    category: 'failure',
    kind: 'correctness',
    title: 'A task that prints a line and then hangs is killed at its idle limit',
    why: 'Most hung tasks printed something first: a banner, a version, the first steps of a build. The idle limit counts from the last output, not from the start. A runner that disarms the limit once a task has printed anything never catches the hang that matters.',
    from: ['task-timeout'],
    needs: ['idle-timeout'],
    workspace: a({ hang: { command: 'echo starting; sleep 60', idleTimeout: 2 } }),
    steps: [{ run: 'hang', expect: { exit: 'fail', within: 30, alone: true } }],
  }),

  // Vite Task crates/vt_bin/tests/e2e_snapshots/fixtures/ctrl_c:
  // ctrl_c_prevents_caching, said of a task a fail-fast run stops.
  defineCase({
    id: 'failure/fail-fast-stopped-task-exiting-0-saves-nothing',
    category: 'failure',
    kind: 'correctness',
    title: 'A task a fail-fast run stops, which traps the stop and exits 0, is not cached',
    why: 'Many programs answer SIGTERM with a clean shutdown and exit 0. When a fail-fast run stops one of them, its exit code says nothing about the work, which was cut short. Read as a success, its half-written output would be cached and replayed as a finished build on the next run.',
    from: ['fail-fast', 'failure-cache-properties'],
    needs: ['fail-fast'],
    workspace: {
      projects: {
        lib: {
          tasks: {
            build: {
              command: `i=0; while [ ! -e ${M}/started ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done; exit 1`,
              cache: false,
            },
          },
        },
        app: {
          tasks: {
            build: {
              command: `trap 'echo TRAPPED >> out.txt; exit 0' TERM; echo PARTIAL > out.txt; mkdir -p ${M}; touch ${M}/started; sleep 60 & wait; echo COMPLETE >> out.txt`,
              inputs: ['in.txt'],
              outputs: ['out.txt'],
            },
          },
          files: { 'in.txt': 'in\n' },
        },
      },
    },
    steps: [
      { run: 'build', concurrency: 2, failFast: true, expect: { exit: 'fail', within: 30 } },
      { sh: `rm -f ${MEET}/started` },
      {
        run: 'build',
        concurrency: 2,
        failFast: true,
        expect: { exit: 'fail', ran: ['app#build'], within: 30 },
      },
    ],
  }),

  // Nix tests/functional/structured-attrs.sh (#16603): what a build is given
  // reaches it as written on every attempt.
  defineCase({
    id: 'failure/retry-gets-the-same-forwarded-args',
    category: 'failure',
    kind: 'correctness',
    title: 'A retried task gets the args forwarded to the run again, each one whole',
    why: 'A retry must run the same command the first attempt ran. Args forwarded to the run are part of that command: a flag, a value with a space in it. A retry that drops them, or splits them again, runs a different test than the one that failed, and its pass means nothing.',
    from: ['retries', 'flaky-retry'],
    needs: ['retries'],
    workspace: a({
      test: {
        command: flaky(`printf '%s|' "$@" > out.txt`),
        retries: 1,
        takesArgs: true,
        inputs: ['in.txt'],
        outputs: ['out.txt'],
      },
    }),
    steps: [
      {
        run: 'test',
        projects: ['a'],
        args: ['--mode', 'two words'],
        expect: { exit: 0, files: { 'packages/a/out.txt': '--mode|two words|' } },
      },
    ],
  }),

  defineCase({
    id: 'failure/zero-retries-runs-once',
    category: 'failure',
    kind: 'correctness',
    title: 'A task given zero retries runs once and fails',
    why: 'Zero retries means no retry. A runner that reads 0 as unset and falls back to some default retry count runs a failing deploy or migration again when the user said not to. The count is the number of extra attempts, and here there are none.',
    from: ['retries'],
    needs: ['retries'],
    workspace: a({ t: { command: 'echo x >> attempts.txt; exit 1', retries: 0 } }),
    steps: [{ run: 't', expect: { exit: 'fail', files: { 'packages/a/attempts.txt': 'x\n' } } }],
  }),

  // Vite Task crates/vt_bin/tests/e2e_snapshots/fixtures/exit_codes:
  // dependency_failure_fast_fails_dependents, for a task that is never cached.
  defineCase({
    id: 'failure/never-cached-dependant-of-a-failure-does-not-run',
    category: 'failure',
    kind: 'correctness',
    title: 'A never-cached task does not run when its dependency fails',
    why: 'A task that is never cached is one that must always run, such as a deploy or a smoke test. It still needs what it depends on. A runner that treats uncached tasks as always ready runs the deploy on a build that just failed.',
    from: ['failure-mode', 'uncached-no-lookup'],
    needs: ['uncached-task'],
    workspace: {
      projects: {
        lib: { tasks: { build: { command: 'exit 1' } } },
        app: {
          deps: ['lib'],
          tasks: {
            build: { command: 'echo ran > out.txt', dependsOn: ['^build'], cache: false },
          },
        },
      },
    },
    steps: [
      {
        run: 'build',
        expect: { exit: 'fail', notRan: ['app#build'], files: { 'packages/app/out.txt': null } },
      },
    ],
  }),

  // Vite Task crates/vt_bin/tests/e2e_snapshots/fixtures/exit_codes:
  // dependents are skipped, never run or restored, once a dependency fails.
  defineCase({
    id: 'failure/dependant-of-a-failing-uncached-task-not-restored',
    category: 'failure',
    kind: 'correctness',
    title: 'A cached task is not restored when the never-cached task it depends on fails',
    why: 'A never-cached task, like a code generator or a fetch, can fail on a run whose inputs did not change. The task built on it has a stored result for those inputs, but its dependency just failed, so this run has nothing to build on. Restoring the stored result anyway hides the failure behind outputs that look fresh.',
    from: ['uncached-upstream-key', 'failure-mode'],
    needs: ['uncached-task', 'pass-through-env'],
    workspace: {
      projects: {
        lib: {
          tasks: { build: { command: 'test -z "$BREAK"', cache: false, passThrough: ['BREAK'] } },
        },
        app: { deps: ['lib'], tasks: { build: OWN }, files: { 'src/a.txt': 'app\n' } },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('app')]: 'app\n' } } },
      { write: { 'packages/app/dist': null } },
      {
        run: 'build',
        env: { BREAK: '1' },
        expect: { exit: 'fail', notRan: ['app#build'], files: { [out('app')]: null } },
      },
    ],
  }),

  // Vite Task crates/vt_plan/src/execution_graph.rs:
  // disconnected_with_cycle_in_one_component.
  defineCase({
    id: 'graph/cycle-in-one-island-runs-nothing',
    category: 'graph',
    kind: 'correctness',
    title:
      'A task cycle in one part of the workspace fails the run before any task runs, even in parts free of it',
    why: 'A graph with a cycle cannot be ordered, so the run is refused as a whole. Running the parts that happen to be free of the cycle first gives a run that is half done and still red, with outputs that look like progress. The user fixes the cycle, then runs everything.',
    from: ['task-graph', 'graph-order'],
    workspace: {
      projects: {
        x: { tasks: { build: { command: 'echo x > out.txt', dependsOn: ['y#build'] } } },
        y: { tasks: { build: { command: 'echo y > out.txt', dependsOn: ['x#build'] } } },
        z: { tasks: { build: { command: 'echo z > out.txt' } } },
      },
    },
    steps: [
      {
        run: 'build',
        expect: {
          exit: 'fail',
          notRan: ['x#build', 'y#build', 'z#build'],
          files: { 'packages/z/out.txt': null },
        },
      },
    ],
  }),

  // Nix tests/functional/dependencies.sh: what a derivation depends on is
  // part of it; change the edges and the build follows them.
  defineCase({
    id: 'graph/reversed-dependency-flips-order',
    category: 'graph',
    kind: 'correctness',
    title:
      'Turning a dependency around builds the two projects in the new order, each on the other’s fresh output',
    why: 'When `b` stops depending on `a` and `a` starts depending on `b`, the order must flip. A runner that keeps an old package graph builds `a` first again, against a `b` that is not there yet. Each project’s output must reflect the new edge: replaying either old result leaves the content the wrong way round.',
    from: ['package-graph', 'vx-lockfile/dependency-section'],
    needs: ['package-manager'],
    workspace: {
      projects: { a: chainProject('a'), b: chainProject('b', ['a']) },
    },
    steps: [
      {
        run: 'build',
        expect: { exit: 0, order: [['a#build', 'b#build']], files: { [out('b')]: 'a\nb\n' } },
      },
      {
        write: {
          'packages/a/package.json': manifest('a', { dependencies: { b: 'workspace:*' } }),
          'packages/b/package.json': manifest('b'),
        },
      },
      { install: true },
      {
        configure: (ws) => ({
          ...ws,
          projects: { a: chainProject('a', ['b']), b: chainProject('b') },
        }),
      },
      {
        run: 'build',
        expect: {
          exit: 0,
          order: [['b#build', 'a#build']],
          files: { [out('a')]: 'b\na\n', [out('b')]: 'b\n' },
        },
      },
    ],
  }),

  // Nix tests/functional/dependencies.sh: an input that is itself a
  // derivation's output is built first, whatever names it.
  defineCase({
    id: 'graph/explicit-edge-against-package-direction-runs',
    category: 'graph',
    kind: 'correctness',
    title: 'A library’s build that needs a generator in the app depending on it runs in between',
    why: 'The app depends on the library as a package, and the library’s build names the app’s generator. The tasks still form a straight line: generator, library build, app build. A runner that folds tasks into a project graph sees a loop between two projects and refuses a run that has a valid order.',
    from: ['task-graph', 'task-edge-selection'],
    workspace: {
      projects: {
        lib: {
          tasks: {
            build: {
              command: 'mkdir -p dist && cat ../app/gen/g.txt src/a.txt > dist/out.txt',
              dependsOn: ['app#gen'],
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'lib\n' },
        },
        app: {
          deps: ['lib'],
          tasks: {
            gen: {
              command: 'mkdir -p gen && echo gen > gen/g.txt',
              inputs: [],
              outputs: ['gen/**'],
            },
            build: chainBuild(['lib']),
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
          order: [
            ['app#gen', 'lib#build'],
            ['lib#build', 'app#build'],
          ],
          files: { [out('app')]: 'gen\nlib\napp\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/dev-workspace-dependency-orders-and-keys',
    category: 'graph',
    kind: 'correctness',
    title:
      'A workspace package named only as a dev dependency is built first, and an edit to it runs the consumer again',
    why: 'A build tool, a test helper or a shared config is usually a dev dependency, and the consumer’s build reads it all the same. Whether a package ships the dependency to users changes nothing about the build order. Leaving dev dependencies out of the graph builds the consumer against a stale or missing helper.',
    from: ['package-graph', 'vx-lockfile/dependency-section'],
    needs: ['package-manager'],
    workspace: {
      projects: {
        lib: chainProject('lib'),
        app: {
          tasks: { build: chainBuild(['lib']) },
          files: {
            'src/a.txt': 'app\n',
            'package.json': manifest('app', { devDependencies: { lib: 'workspace:*' } }),
          },
        },
      },
    },
    steps: [
      {
        run: 'build',
        projects: ['app'],
        expect: {
          exit: 0,
          order: [['lib#build', 'app#build']],
          files: { [out('app')]: 'lib\napp\n' },
        },
      },
      { write: { 'packages/lib/src/a.txt': 'lib2\n' } },
      {
        run: 'build',
        projects: ['app'],
        expect: {
          exit: 0,
          ran: ['lib#build', 'app#build'],
          files: { [out('app')]: 'lib2\napp\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/optional-workspace-dependency-orders-and-keys',
    category: 'graph',
    kind: 'correctness',
    title:
      'A workspace package named only as an optional dependency is built first, and an edit to it runs the consumer again',
    why: 'Inside a workspace an optional dependency is linked like any other, so the consumer’s build reads it. Optional only means an install from a registry may skip it. A runner that drops these edges builds the consumer first, or replays it after the package changed.',
    from: ['package-graph', 'vx-lockfile/dependency-section'],
    needs: ['package-manager'],
    workspace: {
      projects: {
        lib: chainProject('lib'),
        app: {
          tasks: { build: chainBuild(['lib']) },
          files: {
            'src/a.txt': 'app\n',
            'package.json': manifest('app', { optionalDependencies: { lib: 'workspace:*' } }),
          },
        },
      },
    },
    steps: [
      {
        run: 'build',
        projects: ['app'],
        expect: {
          exit: 0,
          order: [['lib#build', 'app#build']],
          files: { [out('app')]: 'lib\napp\n' },
        },
      },
      { write: { 'packages/lib/src/a.txt': 'lib2\n' } },
      {
        run: 'build',
        projects: ['app'],
        expect: {
          exit: 0,
          ran: ['lib#build', 'app#build'],
          files: { [out('app')]: 'lib2\napp\n' },
        },
      },
    ],
  }),

  // Nix tests/functional/dependencies.sh: an input no longer named is no
  // longer built for the derivation.
  defineCase({
    id: 'graph/removed-package-dependency-no-longer-pulled',
    category: 'graph',
    kind: 'efficiency',
    title: 'Once an app no longer depends on a library, running the app does not build the library',
    why: 'Running one project runs what it depends on now, not what it used to. After the dependency is removed from the manifest, the library is just another project. A runner holding an old graph rebuilds it every time the app runs, though nothing reads it.',
    from: ['package-graph', 'vx-lockfile/deleted-project'],
    needs: ['package-manager'],
    workspace: {
      projects: {
        lib: chainProject('lib'),
        app: { deps: ['lib'], tasks: { build: OWN }, files: { 'src/a.txt': 'app\n' } },
      },
    },
    steps: [
      { run: 'build', projects: ['app'], expect: { exit: 0, ran: ['lib#build', 'app#build'] } },
      {
        write: {
          'packages/app/package.json': manifest('app'),
          'packages/lib/src/a.txt': 'lib2\n',
        },
      },
      { install: true },
      {
        configure: (ws) => ({
          ...ws,
          projects: { ...ws.projects, app: { ...ws.projects['app']!, deps: [] } },
        }),
      },
      { run: 'build', projects: ['app'], expect: { exit: 0, notRan: ['lib#build'] } },
    ],
  }),

  // Nix tests/functional/dependencies.sh: the derivation's inputs are named
  // by what they are, so renaming one only changes how it is named.
  defineCase({
    id: 'graph/renamed-dependency-still-builds-first',
    category: 'graph',
    kind: 'correctness',
    title: 'A dependency renamed in both manifests still builds before the project that needs it',
    why: 'Renaming a package is a common refactor, and the app’s manifest is updated to the new name in the same change. The edge is the same edge under a new name. A runner that keys its graph on the old name loses the edge and builds the app against a library that has not been rebuilt.',
    from: ['package-graph', 'vx-lockfile/dependency-names'],
    needs: ['package-manager'],
    workspace: {
      projects: { lib: chainProject('lib'), app: chainProject('app', ['lib']) },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      {
        write: {
          'packages/lib/package.json': manifest('core'),
          'packages/app/package.json': manifest('app', { dependencies: { core: 'workspace:*' } }),
          'packages/lib/src/a.txt': 'core\n',
        },
      },
      { install: true },
      {
        configure: (ws) => ({
          ...ws,
          projects: {
            core: { ...ws.projects['lib']!, dir: 'packages/lib' },
            app: { ...ws.projects['app']!, deps: ['core'] },
          },
        }),
      },
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['core#build', 'app#build'],
          order: [['core#build', 'app#build']],
          files: { [out('app')]: 'core\napp\n' },
        },
      },
    ],
  }),

  // Vite Task crates/vt_plan/tests/plan_snapshots/fixtures/transitive_skip_intermediate
  // and the `--only` family: what is skipped is not judged.
  defineCase({
    id: 'graph/only-ignores-a-broken-dependency',
    category: 'graph',
    kind: 'correctness',
    title: 'Skipping dependencies runs the selected task though its dependency would fail',
    why: 'Skipping dependencies is how a user reruns one task against what is already on disk, often because something below it is broken right now. The broken dependency is not part of that run. A runner that still runs it, or fails the run because of it, takes away the one way to test the task alone.',
    from: ['task-selection', 'frozen-selection'],
    workspace: {
      projects: {
        lib: { tasks: { build: { command: 'exit 1' } } },
        app: {
          deps: ['lib'],
          tasks: { build: { command: 'echo app > out.txt', dependsOn: ['^build'] } },
        },
      },
    },
    steps: [
      {
        run: 'build',
        projects: ['app'],
        only: true,
        expect: {
          exit: 0,
          ran: ['app#build'],
          notRan: ['lib#build'],
          files: { 'packages/app/out.txt': 'app\n' },
        },
      },
    ],
  }),

  // Nix tests/functional/dependencies.sh: a derivation that starts taking
  // another as input builds it first, and is itself a new build.
  defineCase({
    id: 'graph/dependency-gaining-the-task-builds-first-and-reruns',
    category: 'graph',
    kind: 'correctness',
    title:
      'A dependency that gains a build task builds before the app, and the app runs again on its output',
    why: 'Until the library has a build, the app’s `^build` reaches nothing there. Once it gets one, the app depends on that build: it must run first, and the app must run again on what it wrote. Replaying the app’s earlier result ships a build made before the library produced anything.',
    from: ['task-graph', 'task-edge-selection'],
    workspace: {
      projects: {
        lib: { files: { 'src/a.txt': 'lib\n' } },
        app: { deps: ['lib'], tasks: { build: TOLERANT }, files: { 'src/a.txt': 'app\n' } },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('app')]: 'app\n' } } },
      {
        configure: (ws) => ({
          ...ws,
          projects: { ...ws.projects, lib: chainProject('lib') },
        }),
      },
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['lib#build', 'app#build'],
          order: [['lib#build', 'app#build']],
          files: { [out('app')]: 'lib\napp\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/dependency-gaining-a-failing-task-stops-the-app',
    category: 'graph',
    kind: 'correctness',
    title:
      'A dependency that gains a build which fails keeps the app built on it from running or replaying',
    why: 'Once the library has a build, the app depends on it, and this run’s library build failed. The app’s stored result was made before that build existed, so it says nothing about the app on top of it. Running or restoring the app hides a failure the new edge was added to catch.',
    from: ['task-graph', 'failure-mode'],
    workspace: {
      projects: {
        lib: { files: { 'src/a.txt': 'lib\n' } },
        app: { deps: ['lib'], tasks: { build: TOLERANT }, files: { 'src/a.txt': 'app\n' } },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/app/dist': null } },
      {
        configure: (ws) => ({
          ...ws,
          projects: {
            ...ws.projects,
            lib: { ...ws.projects['lib']!, tasks: { build: { command: 'exit 1' } } },
          },
        }),
      },
      {
        run: 'build',
        expect: { exit: 'fail', notRan: ['app#build'], files: { [out('app')]: null } },
      },
    ],
  }),

  // Nix tests/functional/dependencies.sh: what is built is what the
  // expression names now; a dropped package is not built.
  defineCase({
    id: 'graph/deleted-project-no-longer-runs',
    category: 'graph',
    kind: 'correctness',
    title: 'A project deleted from the workspace is no longer run, and the rest still build',
    why: 'Deleting a package is an ordinary cleanup. The next run must see the workspace as it is: the remaining projects build and the deleted one is gone. A runner that keeps an old project list tries to run a task in a directory that no longer exists, or restores its outputs into a recreated folder.',
    from: ['package-graph', 'vx-lockfile/deleted-project'],
    needs: ['package-manager'],
    workspace: { projects: { a: chainProject('a'), b: chainProject('b') } },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { sh: 'rm -rf packages/b' },
      { write: { 'package.json': rootManifest(['packages/a']) } },
      { install: true },
      { configure: (ws) => ({ ...ws, projects: { a: ws.projects['a']! } }) },
      {
        run: 'build',
        expect: { exit: 0, files: { [out('a')]: 'a\n', [out('b')]: null, 'packages/b': null } },
      },
    ],
  }),

  defineCase({
    id: 'graph/dependency-by-version-range-orders-and-keys',
    category: 'graph',
    kind: 'correctness',
    title:
      'A workspace package named by a version range its version meets is built first, and an edit to it runs the consumer again',
    why: 'A package manager links a workspace package for any range its version satisfies, not only for `workspace:*`. Many repos predate the protocol and name siblings by version. The consumer reads the linked sibling, so the sibling must build first and its edits must run the consumer again.',
    from: ['package-graph', 'vx-lockfile/dependency-names'],
    needs: ['package-manager'],
    workspace: {
      projects: {
        lib: chainProject('lib'),
        app: {
          tasks: { build: chainBuild(['lib']) },
          files: {
            'src/a.txt': 'app\n',
            'package.json': manifest('app', { dependencies: { lib: '^0.0.0' } }),
          },
        },
      },
    },
    steps: [
      {
        run: 'build',
        projects: ['app'],
        expect: {
          exit: 0,
          order: [['lib#build', 'app#build']],
          files: { [out('app')]: 'lib\napp\n' },
        },
      },
      { write: { 'packages/lib/src/a.txt': 'lib2\n' } },
      {
        run: 'build',
        projects: ['app'],
        expect: {
          exit: 0,
          ran: ['lib#build', 'app#build'],
          files: { [out('app')]: 'lib2\napp\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'cache/new-project-builds-and-the-rest-replay',
    category: 'cache',
    kind: 'efficiency',
    title: 'Adding a project to the workspace builds it, and the projects already built replay',
    why: 'A new package changes the workspace list and the lockfile, but nothing any existing project builds from. Only the new project has work to do. A runner that keys every task on the whole workspace’s manifest or lockfile rebuilds the monorepo each time someone adds a package.',
    from: ['package-graph', 'vx-lockfile/closure-per-project'],
    needs: ['package-manager'],
    workspace: { projects: { a: chainProject('a'), b: chainProject('b') } },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      {
        write: {
          'packages/c/package.json': manifest('c'),
          'packages/c/src/a.txt': 'c\n',
          'package.json': rootManifest(['packages/a', 'packages/b', 'packages/c']),
        },
      },
      { install: true },
      {
        configure: (ws) => ({ ...ws, projects: { ...ws.projects, c: chainProject('c') } }),
      },
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['c#build'],
          notRan: ['a#build', 'b#build'],
          files: { [out('c')]: 'c\n' },
        },
      },
    ],
  }),

  // Nix tests/functional/fixed.sh: `bad` has the wrong hash and fails, and
  // nothing built on it is built.
  defineCase({
    id: 'outputs/checksum-mismatch-skips-dependants',
    category: 'outputs',
    kind: 'correctness',
    title: 'An output that fails its pinned checksum keeps the tasks built on it from running',
    why: 'A pinned checksum guards everything downstream from the wrong bytes: a toolchain, a vendored archive. When the bytes are wrong the task has failed, whatever its exit code was. A dependant that runs anyway builds on exactly the bytes the pin was there to stop.',
    from: ['artifact-checksum', 'failure-mode'],
    needs: ['output-checksum'],
    workspace: {
      projects: {
        lib: {
          tasks: {
            build: {
              command: 'echo drifted > out.txt',
              inputs: ['in.txt'],
              outputs: ['out.txt'],
              checksum: { file: 'out.txt', text: 'pinned\n' },
            },
          },
          files: { 'in.txt': 'in\n' },
        },
        app: {
          deps: ['lib'],
          tasks: {
            build: {
              command: 'cat ../lib/out.txt > out.txt',
              dependsOn: ['^build'],
              inputs: [],
              outputs: ['out.txt'],
            },
          },
        },
      },
    },
    steps: [
      {
        run: 'build',
        expect: { exit: 'fail', notRan: ['app#build'], files: { 'packages/app/out.txt': null } },
      },
    ],
  }),

  // Nix tests/functional/check.sh: `hashmismatch` fails with 102, and a
  // second build fails the same way.
  defineCase({
    id: 'outputs/checksum-mismatch-never-replayed',
    category: 'outputs',
    kind: 'correctness',
    title:
      'A task that failed its pinned checksum fails again on the next run instead of replaying',
    why: 'A checksum failure is a failure, and failures are never cached. If the wrong bytes were stored, the next run would replay them as a pass, and the pin would hold only once. The task must run and be judged again every time until its bytes match.',
    from: ['artifact-checksum', 'failure-cache-properties'],
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
      { run: 'fetch', expect: { exit: 'fail', ran: ['a#fetch'] } },
    ],
  }),

  // Nix tests/functional/fixed.sh: `good` builds, and asking again finds the
  // valid path without building it.
  defineCase({
    id: 'outputs/checksum-pinned-output-replays-and-restores',
    category: 'outputs',
    kind: 'correctness',
    title:
      'A task whose output matches its pinned checksum replays, and its deleted output comes back',
    why: 'A pin is a check on the bytes, not a reason to skip the cache. Once the output matched, the stored result is exactly the pinned file. Running the fetch again on every run wastes the download, and failing to restore the file breaks the tasks that read it.',
    from: ['artifact-checksum', 'artifact-roundtrip'],
    needs: ['output-checksum'],
    workspace: a({
      fetch: {
        command: 'mkdir -p dist && echo pinned > dist/tool.txt',
        inputs: ['in.txt'],
        outputs: ['dist/**'],
        checksum: { file: 'dist/tool.txt', text: 'pinned\n' },
      },
    }),
    steps: [
      { run: 'fetch', expect: { exit: 0, files: { 'packages/a/dist/tool.txt': 'pinned\n' } } },
      { write: { 'packages/a/dist': null } },
      {
        run: 'fetch',
        expect: { exit: 0, notRan: ['a#fetch'], files: { 'packages/a/dist/tool.txt': 'pinned\n' } },
      },
    ],
  }),

  // Nix tests/functional/check.sh: `hashmismatch` passes once the file it
  // fetches holds the pinned bytes, whatever else changed.
  defineCase({
    id: 'outputs/checksum-judges-the-bytes-not-the-inputs',
    category: 'outputs',
    kind: 'correctness',
    title:
      'A pinned output fails on sources that give other bytes, and passes on any sources that give the pinned ones',
    why: 'The pin is on what the task writes, not on what it reads. Sources that produce other bytes fail the task though it exits 0. An edit that still produces the pinned bytes, like a change of letter case the task normalises away, passes like the first good build did.',
    from: ['artifact-checksum'],
    needs: ['output-checksum'],
    workspace: a(
      {
        build: {
          command: 'tr a-z A-Z < src/a.txt > out.txt',
          inputs: ['src/**'],
          outputs: ['out.txt'],
          checksum: { file: 'out.txt', text: 'HELLO\n' },
        },
      },
      { 'src/a.txt': 'help\n' },
    ),
    steps: [
      { run: 'build', expect: { exit: 'fail' } },
      { write: { 'packages/a/src/a.txt': 'hello\n' } },
      { run: 'build', expect: { exit: 0, files: { 'packages/a/out.txt': 'HELLO\n' } } },
      { write: { 'packages/a/src/a.txt': 'HeLlo\n' } },
      { run: 'build', expect: { exit: 0, files: { 'packages/a/out.txt': 'HELLO\n' } } },
    ],
  }),

  // Nix tests/functional/fixed.sh: a fixed-output build that produces no
  // output fails.
  defineCase({
    id: 'outputs/checksum-file-not-written-fails',
    category: 'outputs',
    kind: 'correctness',
    title: 'A task that never writes its pinned output fails',
    why: 'A pin says this file must exist with these bytes. A task that exits 0 without writing it has not produced what it promised, and a missing file has no checksum to match. Passing it lets every dependant fail later, far from the cause.',
    from: ['artifact-checksum', 'cache-declaration-warnings'],
    needs: ['output-checksum'],
    workspace: a({
      fetch: {
        command: 'echo nothing written',
        inputs: ['in.txt'],
        outputs: ['out.txt'],
        checksum: { file: 'out.txt', text: 'pinned\n' },
      },
    }),
    steps: [{ run: 'fetch', expect: { exit: 'fail', files: { 'packages/a/out.txt': null } } }],
  }),

  // Nix tests/functional/check.sh: a hash is over every byte; `echo -n`
  // and `echo` give two different files.
  defineCase({
    id: 'outputs/checksum-trailing-newline-counts',
    category: 'outputs',
    kind: 'correctness',
    title: 'An output that differs from its pin only by a missing final newline fails',
    why: 'A checksum is over every byte, and a newline is a byte. A file missing its last newline is a different file to a parser, a signature check or a diff. A runner that trims whitespace before comparing passes bytes the pin does not allow.',
    from: ['artifact-checksum'],
    needs: ['output-checksum'],
    workspace: a({
      fetch: {
        command: 'printf pinned > out.txt',
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

  // Nix tests/functional/check.sh: `echo -n > dummy` gives an empty file,
  // whose pinned hash then passes.
  defineCase({
    id: 'outputs/checksum-pins-an-empty-file',
    category: 'outputs',
    kind: 'correctness',
    title: 'An output pinned as an empty file fails when it holds anything and passes when empty',
    why: 'An empty file is a valid output with a checksum of its own, like an empty lock or marker file. Its pin must hold exactly: one byte fails, empty passes. A runner that treats an empty pin as no pin passes whatever the task writes.',
    from: ['artifact-checksum'],
    needs: ['output-checksum'],
    workspace: a({
      mark: {
        command: 'echo x > out.txt',
        inputs: ['in.txt'],
        outputs: ['out.txt'],
        checksum: { file: 'out.txt', text: '' },
      },
    }),
    steps: [
      { run: 'mark', expect: { exit: 'fail' } },
      {
        configure: (ws) => {
          ws.projects['a']!.tasks!['mark']!.command = ': > out.txt'
          return ws
        },
      },
      { run: 'mark', expect: { exit: 0, files: { 'packages/a/out.txt': '' } } },
    ],
  }),

  // Nix tests/functional/fixed.sh: `parallelSame`, two builds that produce
  // the same pinned output at once.
  defineCase({
    id: 'outputs/checksum-two-projects-same-bytes-keep-their-own-files',
    category: 'outputs',
    kind: 'correctness',
    title: 'Two projects pinned to the same bytes both pass, each with its own file',
    why: 'Two projects can vendor the same file, and so share a pin. Their outputs are the same bytes but live in two places. A runner that stores pinned results by content and restores one of them only once, or builds one and skips the other, leaves a project without its file.',
    from: ['artifact-checksum', 'cache-store'],
    needs: ['output-checksum'],
    workspace: {
      projects: Object.fromEntries(
        ['a', 'b'].map((n) => [
          n,
          {
            tasks: {
              fetch: {
                command: 'echo same > out.txt',
                inputs: ['in.txt'],
                outputs: ['out.txt'],
                checksum: { file: 'out.txt', text: 'same\n' },
              },
            },
            files: { 'in.txt': `${n}\n` },
          },
        ]),
      ),
    },
    steps: [
      {
        run: 'fetch',
        expect: {
          exit: 0,
          ran: ['a#fetch', 'b#fetch'],
          files: { 'packages/a/out.txt': 'same\n', 'packages/b/out.txt': 'same\n' },
        },
      },
      { write: { 'packages/a/out.txt': null, 'packages/b/out.txt': null } },
      {
        run: 'fetch',
        expect: {
          exit: 0,
          files: { 'packages/a/out.txt': 'same\n', 'packages/b/out.txt': 'same\n' },
        },
      },
    ],
  }),

  // Nix tests/functional/dependencies.sh: `fod_input`, a fixed-output build
  // another build takes as input.
  defineCase({
    id: 'outputs/checksum-pinned-output-reaches-dependant',
    category: 'outputs',
    kind: 'correctness',
    title: 'A task built on a pinned output reads the pinned bytes',
    why: 'A pin is most often on something other tasks consume: a fetched tool, a vendored file. Once it passes, its output must be where the dependant looks for it, as any dependency’s is. A runner that checks the pin but keeps the file aside leaves the dependant with nothing to read.',
    from: ['artifact-checksum', 'restore-in-place'],
    needs: ['output-checksum'],
    workspace: {
      projects: {
        lib: {
          tasks: {
            build: {
              command: 'echo tool > out.txt',
              inputs: ['in.txt'],
              outputs: ['out.txt'],
              checksum: { file: 'out.txt', text: 'tool\n' },
            },
          },
          files: { 'in.txt': 'in\n' },
        },
        app: {
          deps: ['lib'],
          tasks: {
            build: {
              command: 'mkdir -p dist && cat ../lib/out.txt src/a.txt > dist/out.txt',
              dependsOn: ['^build'],
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'app\n' },
        },
      },
    },
    steps: [{ run: 'build', expect: { exit: 0, files: { [out('app')]: 'tool\napp\n' } } }],
  }),

  // Nix tests/functional/multiple-outputs.sh: building `a` gives
  // `result-first`, and no `result-second` until that output is asked for.
  defineCase({
    id: 'outputs/hit-restores-only-the-requested-tasks-outputs',
    category: 'outputs',
    kind: 'correctness',
    title:
      'Replaying one task of a project restores its outputs and not those of the project’s other task',
    why: 'A replay restores what the requested task wrote. Its sibling task was not asked for, and its outputs are not part of this run. A runner that restores everything stored for the project writes files the user just deleted on purpose, from a task that never ran.',
    from: ['restore-declared-only', 'task-artifacts'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command: 'mkdir -p dist && echo build > dist/out.txt',
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
            docs: {
              command: 'mkdir -p site && echo docs > site/index.txt',
              inputs: ['src/**'],
              outputs: ['site/**'],
            },
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { run: 'docs', expect: { exit: 0 } },
      { write: { 'packages/a/dist': null, 'packages/a/site': null } },
      {
        run: 'build',
        expect: {
          exit: 0,
          notRan: ['a#build'],
          files: { 'packages/a/dist/out.txt': 'build\n', 'packages/a/site/index.txt': null },
        },
      },
    ],
  }),

  // Nix tests/functional/check.sh: a `--check` that finds the build
  // nondeterministic (104) registers nothing new.
  defineCase({
    id: 'cache/check-run-failure-keeps-the-stored-result',
    category: 'cache',
    kind: 'correctness',
    title: 'A check run that finds a task nondeterministic leaves the first stored result in place',
    why: 'A check run is a test of the cache, not a write to it. When it finds the rebuild differs, the stored result is still what the run that saved it produced. A check that swaps in its own rebuild changes what every later run replays, as a side effect of looking.',
    from: ['cache', 'artifact-roundtrip'],
    needs: ['determinism-check'],
    workspace: a({
      count: {
        command: `mkdir -p ${M}; n=$(cat ${M}/n 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${M}/n; echo $n > out.txt`,
        inputs: ['in.txt'],
        outputs: ['out.txt'],
      },
    }),
    steps: [
      { run: 'count', expect: { exit: 0, files: { 'packages/a/out.txt': '1\n' } } },
      { run: 'count', verify: true, expect: { exit: 'fail' } },
      { write: { 'packages/a/out.txt': null } },
      {
        run: 'count',
        expect: { exit: 0, notRan: ['a#count'], files: { 'packages/a/out.txt': '1\n' } },
      },
    ],
  }),

  // Nix tests/functional/check.sh (#13293): checking one output of a
  // derivation works after another output was deleted.
  defineCase({
    id: 'cache/check-run-after-one-of-two-output-trees-deleted-passes',
    category: 'cache',
    kind: 'correctness',
    title: 'A check run passes a reproducible task after one of its two output trees was deleted',
    why: 'A check compares a fresh rebuild with what the cache stored. What happens to be on disk at the time does not matter: a deleted tree is not a difference in the build. A check that compares against the working tree, or chokes on the missing half, fails a task that is perfectly reproducible.',
    from: ['cache', 'restore-in-place'],
    needs: ['determinism-check'],
    workspace: a({ build: TWO_TREES }, { 'src/a.txt': 'a\n' }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/a/types': null } },
      { run: 'build', verify: true, expect: { exit: 0 } },
    ],
  }),

  // Nix tests/functional/check.sh: `nondeterministic` writes `date` into its
  // output; one varying file is enough to fail the check.
  defineCase({
    id: 'cache/check-run-catches-a-difference-in-a-second-tree',
    category: 'cache',
    kind: 'correctness',
    title: 'A check run fails a task whose first output tree is stable and whose second differs',
    why: 'Every declared output is part of the result a hit replays. A timestamp or a random id in a side file, a source map or a manifest, makes hits differ by machine as much as one in the main file. A check that compares only the first tree passes a task that is not reproducible.',
    from: ['cache', 'artifact-roundtrip'],
    needs: ['determinism-check'],
    workspace: a({
      build: {
        command:
          'mkdir -p dist meta && echo same > dist/out.txt && od -An -N8 -tx8 /dev/urandom > meta/id.txt',
        inputs: ['in.txt'],
        outputs: ['dist/**', 'meta/**'],
      },
    }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { run: 'build', verify: true, expect: { exit: 'fail' } },
    ],
  }),

  // Nix tests/functional/dependencies.sh: a new input changes the
  // derivation, which builds the input first, then itself again.
  defineCase({
    id: 'cache/new-package-dependency-builds-it-first-and-reruns',
    category: 'cache',
    kind: 'correctness',
    title: 'Adding a workspace dependency to an app builds it first and runs the app again',
    why: 'Adding a dependency changes what the app builds against, though none of the app’s sources changed. The new dependency must build first, and the app must run again to pick it up. Replaying the app’s old result ships a build that never saw the package the user just added.',
    from: ['package-graph', 'vx-lockfile/transitive-workspace'],
    needs: ['package-manager'],
    workspace: {
      projects: {
        lib: chainProject('lib'),
        app: { tasks: { build: TOLERANT }, files: { 'src/a.txt': 'app\n' } },
      },
    },
    steps: [
      {
        run: 'build',
        projects: ['app'],
        expect: { exit: 0, notRan: ['lib#build'], files: { [out('app')]: 'app\n' } },
      },
      {
        write: {
          'packages/app/package.json': manifest('app', { dependencies: { lib: 'workspace:*' } }),
        },
      },
      { install: true },
      {
        configure: (ws) => ({
          ...ws,
          projects: { ...ws.projects, app: { ...ws.projects['app']!, deps: ['lib'] } },
        }),
      },
      {
        run: 'build',
        projects: ['app'],
        expect: {
          exit: 0,
          ran: ['lib#build', 'app#build'],
          order: [['lib#build', 'app#build']],
          files: { [out('app')]: 'lib\napp\n' },
        },
      },
    ],
  }),

  // Nix tests/functional/multiple-outputs.sh: output paths follow the
  // derivation, wherever its result link points.
  defineCase({
    id: 'cache/project-moved-restores-in-its-new-place',
    category: 'cache',
    kind: 'correctness',
    title: 'A project moved to another directory gets its outputs in the new directory',
    why: 'After a move the project’s tasks run from its new place, and that is where their outputs belong. The runner may replay the stored result or run the task again, but the files must land under the new directory. Restoring them to the old path leaves the moved project without a build and puts files back in a directory that is gone.',
    from: ['cache-store-moved', 'inputs-moved'],
    needs: ['package-manager'],
    workspace: { projects: { a: chainProject('a'), b: chainProject('b') } },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { sh: 'mkdir -p libs && mv packages/a libs/a && rm -rf libs/a/dist' },
      { write: { 'package.json': rootManifest(['libs/a', 'packages/b']) } },
      { install: true },
      {
        configure: (ws) => ({
          ...ws,
          projects: { ...ws.projects, a: { ...ws.projects['a']!, dir: 'libs/a' } },
        }),
      },
      {
        run: 'build',
        expect: {
          exit: 0,
          files: { 'libs/a/dist/out.txt': 'a\n', [out('a')]: null, [out('b')]: 'b\n' },
        },
      },
    ],
  }),

  // Nix tests/functional/multiple-outputs.sh: each output is found by what
  // built it, never by the place it was last seen.
  defineCase({
    id: 'cache/two-projects-swap-directories-keep-their-own-results',
    category: 'cache',
    kind: 'correctness',
    title: 'Two projects that swap directories each get their own result in their new place',
    why: 'When two projects trade places, each directory now holds the other project. A runner that pairs stored results with directories restores the old occupant’s files over the new one’s sources. Whatever is replayed or rebuilt, each directory must end up with the output of the project that lives there now.',
    from: ['cache-store-moved', 'inputs-moved'],
    needs: ['package-manager'],
    workspace: { projects: { a: chainProject('a'), b: chainProject('b') } },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      {
        sh: 'mv packages/a packages/t && mv packages/b packages/a && mv packages/t packages/b && rm -rf packages/a/dist packages/b/dist',
      },
      { install: true },
      {
        configure: (ws) => ({
          ...ws,
          projects: {
            a: { ...ws.projects['a']!, dir: 'packages/b' },
            b: { ...ws.projects['b']!, dir: 'packages/a' },
          },
        }),
      },
      {
        run: 'build',
        expect: { exit: 0, files: { [out('a')]: 'b\n', [out('b')]: 'a\n' } },
      },
    ],
  }),

  defineCase({
    id: 'cache/forced-run-with-dependencies-skipped-runs-only-the-task',
    category: 'cache',
    kind: 'correctness',
    title: 'A forced run that skips dependencies runs the selected task alone',
    why: 'Forcing says ignore the cache for what this run runs; skipping dependencies says what it runs. Together they rebuild one task against what is on disk, a common way to retry a suspect build. A runner that lets the force reach the skipped dependencies rebuilds the whole chain the user left out.',
    from: ['run-option-shapes', 'frozen-selection'],
    needs: ['force'],
    workspace: { projects: { lib: chainProject('lib'), app: chainProject('app', ['lib']) } },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      {
        run: 'build',
        projects: ['app'],
        only: true,
        force: true,
        expect: { exit: 0, ran: ['app#build'], notRan: ['lib#build'] },
      },
    ],
  }),

  defineCase({
    id: 'cache/read-only-chain-builds-on-restored-dependency',
    category: 'cache',
    kind: 'correctness',
    title: 'A read-only run restores a stored dependency and builds the changed project on it',
    why: 'A read-only cache, as a pull-request job often uses, still replays what it can. The dependency’s result is stored, so it comes back to disk, and the changed project builds on it. A runner that skips the restore when it may not write leaves the dependant reading a missing file.',
    from: ['plugin-read-only', 'restore-in-place'],
    needs: ['read-only-cache'],
    workspace: { projects: { lib: chainProject('lib'), app: chainProject('app', ['lib']) } },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/lib/dist': null, 'packages/app/src/a.txt': 'app2\n' } },
      {
        run: 'build',
        readOnlyCache: true,
        expect: {
          exit: 0,
          ran: ['app#build'],
          notRan: ['lib#build'],
          files: { [out('lib')]: 'lib\n', [out('app')]: 'lib\napp2\n' },
        },
      },
    ],
  }),

  // Nix tests/functional/build-dry.sh: `--dry-run` creates no output link.
  defineCase({
    id: 'cache/dry-run-restores-nothing',
    category: 'cache',
    kind: 'correctness',
    title: 'Planning a run does not restore a stored task’s deleted outputs',
    why: 'A planned run reports what would happen and changes nothing. Restoring outputs is a change: files appear that the user deleted. A dry run that restores leaves the tree different from before the plan, so the plan was not a dry run at all.',
    from: ['dry-no-writes', 'timing-dry'],
    needs: ['dry-run'],
    workspace: { projects: { a: chainProject('a') } },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/a/dist': null } },
      { run: 'build', dry: true, expect: { exit: 0, files: { [out('a')]: null } } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'], files: { [out('a')]: 'a\n' } } },
    ],
  }),

  // Vite Task crates/vt_plan/tests/plan_snapshots/fixtures/parallel_and_concurrency:
  // concurrency is a setting of the run, not of a task.
  defineCase({
    id: 'cache/run-options-do-not-key',
    category: 'cache',
    kind: 'efficiency',
    title: 'A run at a concurrency of one, or asked to fail fast, replays what a plain run stored',
    why: 'How many tasks run at once and whether the run stops at the first failure change how the run is scheduled, not what any task produces. A runner that folds them into the key misses the whole cache whenever a user debugs with one task at a time, or CI switches to fail fast.',
    from: ['run-option-shapes', 'run-concurrency'],
    needs: ['fail-fast'],
    workspace: { projects: { lib: chainProject('lib'), app: chainProject('app', ['lib']) } },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { run: 'build', concurrency: 1, expect: { exit: 0, notRan: ['lib#build', 'app#build'] } },
      { run: 'build', failFast: true, expect: { exit: 0, notRan: ['lib#build', 'app#build'] } },
    ],
  }),

  defineCase({
    id: 'cache/second-task-asked-for-shares-entry',
    category: 'cache',
    kind: 'efficiency',
    title: 'A task stored by a run of it alone replays when a run asks for it beside another task',
    why: 'Which other tasks share a run says nothing about what one task produces. A build stored by `build` alone is the same build when the run asks for `lint` and `build`. Keying on the set of requested tasks makes every new combination start cold.',
    from: ['task-selection', 'selection-graph-reuse'],
    needs: ['multi-task'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: chainBuild([]),
            lint: {
              command: 'cat src/a.txt > lint.txt',
              inputs: ['src/**'],
              outputs: ['lint.txt'],
            },
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { run: 'lint', also: ['build'], expect: { exit: 0, ran: ['a#lint'], notRan: ['a#build'] } },
    ],
  }),

  defineCase({
    id: 'cache/forced-dependency-leaves-dependant-replaying',
    category: 'cache',
    kind: 'efficiency',
    title:
      'Forcing a library to rebuild with unchanged sources lets the app on it replay next time',
    why: 'A forced rebuild of the same sources is the same build: the inputs, and so the keys of everything above it, did not change. A runner that keys dependants on the time the dependency last ran, or on its fresh file stamps, rebuilds the whole stack after every forced rebuild of one package.',
    from: ['uncached-upstream-key', 'restore-mtime'],
    needs: ['force'],
    workspace: { projects: { lib: chainProject('lib'), app: chainProject('app', ['lib']) } },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { run: 'build', projects: ['lib'], force: true, expect: { exit: 0, ran: ['lib#build'] } },
      { run: 'build', expect: { exit: 0, notRan: ['lib#build', 'app#build'] } },
    ],
  }),

  // Nix tests/functional/structured-attrs.sh (#16603): `testAttr = "printf
  // %s"` must reach the build as written.
  defineCase({
    id: 'env/percent-format-text-in-value-reaches-verbatim',
    category: 'env',
    kind: 'correctness',
    title:
      'A declared value holding `%s` and `%%` reaches the task as written, and `%%` keys apart from `%`',
    why: 'A value like `printf %s` or `100%%` is text, and the task must see each byte. A runner that passes values through a format function turns `%%` into `%` and fills or drops `%s`. Then two different values reach the task as one, and the cache replays one for the other.',
    from: ['env', 'env-properties'],
    needs: ['env-inputs'],
    workspace: a({
      build: {
        command: `printf '%s' "$MSG" > out.txt`,
        env: ['MSG'],
        inputs: ['in.txt'],
        outputs: ['out.txt'],
      },
    }),
    steps: [
      {
        run: 'build',
        env: { MSG: 'printf %s %d 100%%' },
        expect: { exit: 0, files: { 'packages/a/out.txt': 'printf %s %d 100%%' } },
      },
      {
        run: 'build',
        env: { MSG: 'printf %s %d 100%' },
        expect: { exit: 0, ran: ['a#build'], files: { 'packages/a/out.txt': 'printf %s %d 100%' } },
      },
    ],
  }),

  // Vite Task crates/vt_plan/src/envs.rs:
  // test_force_color_passthrough_when_user_opts_in_via_fingerprinted.
  defineCase({
    id: 'env/declared-color-variables-reach-as-set',
    category: 'env',
    kind: 'correctness',
    title: 'Declared `FORCE_COLOR` and `NO_COLOR` reach the task as the user set them, and key it',
    why: 'Runners like to set colour variables themselves so that captured output stays coloured. A user who declares them has said their value matters to the task, as it does for a snapshot test of terminal output. Overriding them hands the task a value nobody set, and a change of value must still run it again.',
    from: ['env', 'env-properties'],
    needs: ['env-inputs'],
    workspace: a({
      build: {
        command: `printf '%s|%s' "\${FORCE_COLOR-unset}" "\${NO_COLOR-unset}" > out.txt`,
        env: ['FORCE_COLOR', 'NO_COLOR'],
        inputs: ['in.txt'],
        outputs: ['out.txt'],
      },
    }),
    steps: [
      {
        run: 'build',
        env: { FORCE_COLOR: '0', NO_COLOR: '1' },
        expect: { exit: 0, files: { 'packages/a/out.txt': '0|1' } },
      },
      {
        run: 'build',
        env: { FORCE_COLOR: '2', NO_COLOR: '1' },
        expect: { exit: 0, ran: ['a#build'], files: { 'packages/a/out.txt': '2|1' } },
      },
    ],
  }),

  // Nix tests/functional/structured-attrs.sh (#16603), said of args: what
  // the user types reaches the command, never a format string.
  defineCase({
    id: 'env/args-percent-text-verbatim',
    category: 'env',
    kind: 'correctness',
    title: 'Forwarded args holding `%s`, `%d` and `%%` reach the command as typed',
    why: 'An arg like `--format=%s` or a test filter with `%` in it is text for the program. A runner that builds the command line through a format function fills `%s`, drops `%d` or halves `%%`. The program then gets an argument the user never typed.',
    from: ['forward-args-verbatim', 'cli-arg-hygiene'],
    workspace: a({
      test: {
        command: `printf '%s|' "$@" > out.txt`,
        takesArgs: true,
        inputs: ['in.txt'],
        outputs: ['out.txt'],
      },
    }),
    steps: [
      {
        run: 'test',
        projects: ['a'],
        args: ['--format=%s', '%d', '100%%'],
        expect: { exit: 0, files: { 'packages/a/out.txt': '--format=%s|%d|100%%|' } },
      },
    ],
  }),
]
