// Mined from Nx’s own suites: the e2e tests in e2e/nx/src (run, cache,
// affected-tasks, the includeIgnored filesets) and the task runner’s specs
// in packages/nx/src/tasks-runner (create-task-graph, task-orchestrator,
// run-command, utils). Each case keeps the outcome Nx guards and drops Nx’s
// own terms: what keys a task, what an unkeyed edge or a server edge
// reaches, what a failure skips, and what a root project’s outputs hold.
import { defineCase, MEET, type Case, type WorkspaceSpec } from '../src/spec.ts'
import { one } from './shapes.ts'

/** Wait (bounded) for a file, then go on. */
const until = (file: string) =>
  `i=0; until [ -e ${file} ] || [ $i -ge 400 ]; do sleep 0.05; i=$((i+1)); done; [ -e ${file} ]`

/** lib’s cached build, web’s dev server built on it by an explicit edge, and the suite testing web. */
function suiteOverServer(): WorkspaceSpec {
  return {
    projects: {
      lib: {
        tasks: {
          build: {
            command: 'mkdir -p dist && cat src/a.txt > dist/out.txt',
            inputs: ['src/**'],
            outputs: ['dist/**'],
          },
        },
        files: { 'src/a.txt': 'lib\n' },
      },
      web: {
        tasks: {
          serve: {
            command: 'touch up; sleep 60',
            dependsOn: ['lib#build'],
            inputs: ['src/**'],
            persistent: true,
          },
        },
        files: { 'src/a.txt': 'web\n' },
      },
      suite: {
        tasks: {
          e2e: {
            command: `${until('../web/up')} && cat src/a.txt`,
            dependsOn: ['web#serve'],
            inputs: ['src/**'],
            outputs: [],
          },
        },
        files: { 'src/a.txt': 'suite\n' },
      },
      docs: {
        tasks: { e2e: { command: 'cat src/a.txt', inputs: ['src/**'], outputs: [] } },
        files: { 'src/a.txt': 'docs\n' },
      },
    },
  }
}

export default [
  // packages/nx/src/tasks-runner/utils.spec.ts “task overrides hash”: unlike named options, positional args are ordered.
  defineCase({
    id: 'cache/args-order-keys-the-task',
    category: 'cache',
    kind: 'correctness',
    title: 'The same forwarded args in another order run the task again',
    why: 'Positional args mean what their place says: `cp a b` and `cp b a` are different commands. A key that sorts the args, or folds them as a set, replays the first order’s output for the second. Here the task writes its args in order, so a replay leaves the wrong order on disk.',
    from: ['forward-args-verbatim', 'task-hash'],
    workspace: one({
      command: 'mkdir -p dist && echo "$@" > dist/out.txt',
      takesArgs: true,
      inputs: ['src/**'],
      outputs: ['dist/**'],
    }),
    steps: [
      {
        run: 'build',
        projects: ['a'],
        args: ['x', 'y'],
        expect: { exit: 0, ran: ['a#build'], files: { 'packages/a/dist/out.txt': 'x y\n' } },
      },
      {
        run: 'build',
        projects: ['a'],
        args: ['y', 'x'],
        expect: { exit: 0, ran: ['a#build'], files: { 'packages/a/dist/out.txt': 'y x\n' } },
      },
    ],
  }),

  // e2e/nx/src/run.test.ts “should forward %args properly with quotes”.
  defineCase({
    id: 'cache/one-spaced-arg-is-not-two-args',
    category: 'cache',
    kind: 'correctness',
    title: 'One forwarded arg holding a space and two args without it key the task apart',
    why: '`"x y"` is one argument and `x y` is two, and a command can tell them apart. A key that joins the args with spaces gives both the same key and replays the wrong result. Each must keep its own entry, so going back to the first replays the first.',
    from: ['forward-args-verbatim', 'task-hash'],
    workspace: one({
      command: `mkdir -p dist && printf '%s|' "$@" > dist/out.txt`,
      takesArgs: true,
      inputs: ['src/**'],
      outputs: ['dist/**'],
    }),
    steps: [
      {
        run: 'build',
        projects: ['a'],
        args: ['x y'],
        expect: { exit: 0, ran: ['a#build'], files: { 'packages/a/dist/out.txt': 'x y|' } },
      },
      {
        run: 'build',
        projects: ['a'],
        args: ['x', 'y'],
        expect: { exit: 0, ran: ['a#build'], files: { 'packages/a/dist/out.txt': 'x|y|' } },
      },
      {
        run: 'build',
        projects: ['a'],
        args: ['x y'],
        expect: { exit: 0, notRan: ['a#build'], files: { 'packages/a/dist/out.txt': 'x y|' } },
      },
    ],
  }),

  // e2e/nx/src/include-ignored-cache-utils.ts “should follow deletes and moves under a gitignored directory”.
  defineCase({
    id: 'inputs/gitignored-directory-deletes-and-moves',
    category: 'inputs',
    kind: 'correctness',
    title:
      'Under a gitignored input directory, a deleted file, a moved folder and a deleted folder each run the task again',
    why: 'Generated directories are gitignored, so git cannot tell the tool what changed in them; the tool has to look. A file gone, a folder renamed and a folder removed each change what the task reads. Moving the folder back restores the exact inputs of an earlier run, so that run’s result replays.',
    from: ['ignored-inputs', 'inputs-moved'],
    workspace: {
      projects: {
        a: {
          tasks: { build: { command: 'true', inputs: ['gen/**/*.json'], outputs: [] } },
          files: {
            'gen/a.json': '"a"\n',
            'gen/sub/b.json': '"b"\n',
            'gen/sub/c.json': '"c"\n',
            'gen/notes.md': 'not an input\n',
          },
        },
      },
      files: { '.gitignore': 'packages/a/gen\n' },
    },
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { write: { 'packages/a/gen/notes.md': 'still not an input\n' } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
      { write: { 'packages/a/gen/a.json': null } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { sh: 'mv packages/a/gen/sub packages/a/gen/moved' },
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { sh: 'mv packages/a/gen/moved packages/a/gen/sub' },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
      { sh: 'rm -rf packages/a/gen/sub' },
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
    ],
  }),

  // e2e/nx/src/include-ignored-cache-utils.ts “should hash a generated input after the task that writes it”.
  defineCase({
    id: 'cache/unkeyed-reader-of-generated-file-keyed-after-the-generator',
    category: 'cache',
    kind: 'correctness',
    title:
      'A task keyed only on a file its prerequisite generates runs again when the generator’s source changes',
    why: 'The reader is not keyed on the generator, only on the generated file, and that file is only new once the generator has run. A tool that derives every key before any task runs reads last run’s generated file and replays a stale result. The reader’s key must be taken after its prerequisite has written what it reads.',
    from: ['unkeyed-upstream', 'upstream'],
    needs: ['dependency-inputs-off'],
    workspace: {
      projects: {
        a: {
          tasks: {
            codegen: {
              command: 'mkdir -p gen && cat schema.txt > gen/out.txt',
              inputs: ['schema.txt'],
              outputs: ['gen/**'],
            },
            build: {
              command: 'mkdir -p dist && cat gen/out.txt > dist/out.txt',
              dependsOn: ['codegen'],
              dependencyInputs: false,
              inputs: ['gen/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'schema.txt': 'v1\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, files: { 'packages/a/dist/out.txt': 'v1\n' } } },
      { run: 'build', expect: { exit: 0, notRan: ['a#codegen', 'a#build'] } },
      { write: { 'packages/a/schema.txt': 'v2\n' } },
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['a#codegen', 'a#build'],
          files: { 'packages/a/dist/out.txt': 'v2\n' },
        },
      },
      { run: 'build', expect: { exit: 0, notRan: ['a#codegen', 'a#build'] } },
    ],
  }),

  // packages/nx/src/tasks-runner/create-task-graph.spec.ts “dependsOn with inputs: false”: the edge to a server.
  defineCase({
    id: 'cache/server-source-change-replays-unkeyed-test',
    category: 'cache',
    kind: 'efficiency',
    title:
      'A test that waits for a dev server but is not keyed on it replays when only the server’s sources change',
    why: 'Saying a task is not keyed on its dependency is a promise that the dependency cannot change its result: the test needs the server up, not its source. With only the server’s source changed, the test’s own inputs are the same, so it replays. Nothing then needs the server, so it does not start.',
    from: ['exclude-dependencies-key', 'keyless-through-server'],
    needs: ['persistent', 'dependency-inputs-off'],
    workspace: {
      projects: {
        api: {
          tasks: { dev: { command: 'touch up; sleep 60', persistent: true, inputs: ['src/**'] } },
          files: { 'src/a.txt': 'api\n' },
        },
        web: {
          tasks: {
            e2e: {
              command: `${until('../api/up')} && mkdir -p dist && cat src/a.txt > dist/out.txt`,
              dependsOn: ['api#dev'],
              dependencyInputs: false,
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'web\n' },
        },
      },
    },
    steps: [
      { run: 'e2e', projects: ['web'], expect: { exit: 0, ran: ['web#e2e'], within: 30 } },
      { write: { 'packages/api/src/a.txt': 'api2\n' } },
      {
        run: 'e2e',
        projects: ['web'],
        expect: { exit: 0, notRan: ['web#e2e', 'api#dev'], within: 30, alone: true },
      },
    ],
  }),

  // --- What affected reaches ---

  // e2e/nx/src/affected-tasks.test.ts “continuous dependencies: selects the suite when the library it exercises changes”.
  defineCase({
    id: 'affected/server-edge-reaches-the-suite',
    category: 'affected',
    kind: 'correctness',
    title:
      'A library change selects the e2e suite whose dev server is built on that library, with no package dependency between them',
    why: 'The suite tests the server and the server is built from the library, so a library change can break the suite. The path runs only through task edges, two of them, one into a server. A selection that walks package dependencies, or stops at the server, leaves the one test that would catch the break out of the run.',
    from: ['affected-tasks', 'task-edge-selection'],
    needs: ['affected', 'persistent'],
    workspace: suiteOverServer(),
    steps: [
      { write: { 'packages/lib/src/a.txt': 'lib2\n' } },
      { commit: 'edit lib' },
      {
        affected: 'e2e',
        base: 'HEAD~1',
        expect: { exit: 0, ran: ['suite#e2e'], notRan: ['docs#e2e'], within: 30 },
      },
    ],
  }),

  // --- Graph and failure ---

  // packages/nx/src/tasks-runner/create-task-graph.spec.ts “should not conflate dependencies of dummy tasks”.
  defineCase({
    id: 'failure/taskless-bridge-failure-skips-only-its-top',
    category: 'failure',
    kind: 'correctness',
    title:
      'A failed build reached through one project without a build skips only the project above that bridge',
    why: 'Two apps each reach a library through a middle project that has no build. The middle projects are only bridges: each app waits for its own library and nothing else. A tool that merges the bridges into one stand-in makes both apps wait on both libraries, so one library’s failure wrongly skips the other app.',
    from: ['task-graph', 'run-failures-store'],
    workspace: {
      projects: {
        x: { tasks: { build: { command: 'exit 1', cache: false } } },
        y: {
          tasks: { build: { command: 'mkdir -p dist && echo y > dist/out.txt', cache: false } },
        },
        m1: { deps: ['x'], files: { 'a.txt': 'm1\n' } },
        m2: { deps: ['y'], files: { 'a.txt': 'm2\n' } },
        a: {
          deps: ['m1'],
          tasks: { build: { command: 'echo a > out.txt', dependsOn: ['^build'], cache: false } },
        },
        b: {
          deps: ['m2'],
          tasks: {
            build: {
              command: 'cat ../y/dist/out.txt > out.txt',
              dependsOn: ['^build'],
              cache: false,
            },
          },
        },
      },
    },
    steps: [
      {
        run: 'build',
        expect: {
          exit: 'fail',
          ran: ['y#build', 'b#build'],
          notRan: ['a#build'],
          order: [['y#build', 'b#build']],
          files: { 'packages/b/out.txt': 'y\n', 'packages/a/out.txt': null },
        },
      },
    ],
  }),

  // packages/nx/src/tasks-runner/run-command.spec.ts “runs more run-commands tasks at once than the default listener limit allows”.
  defineCase({
    id: 'graph/twelve-tasks-at-once',
    category: 'graph',
    kind: 'efficiency',
    title: 'At a concurrency of 12, twelve independent tasks all run at the same time',
    why: 'A limit of twelve means twelve tasks may run together, and a big machine asks for it. A runner that hits an internal cap first, such as a limit on listeners or pipes, quietly runs fewer at once and the run takes longer. Each task here waits until all twelve have started.',
    from: ['run-concurrency', 'scheduler'],
    workspace: {
      projects: Object.fromEntries(
        Array.from({ length: 12 }, (_, i) => {
          const m = `../../${MEET}`
          const names = Array.from({ length: 12 }, (_, j) => `p${j}`)
          const wait = names.map((p) => `[ -e ${m}/${p} ]`).join(' && ')
          return [
            `p${i}`,
            {
              tasks: {
                work: {
                  command: `mkdir -p ${m} && touch ${m}/p${i}; i=0; until { ${wait}; } || [ $i -ge 300 ]; do sleep 0.05; i=$((i+1)); done; if ${wait}; then echo together; else echo apart; fi > out.txt`,
                  cache: false,
                },
              },
            },
          ]
        }),
      ),
    },
    steps: [
      {
        run: 'work',
        concurrency: 12,
        expect: {
          exit: 0,
          files: Object.fromEntries(
            Array.from({ length: 12 }, (_, i) => [`packages/p${i}/out.txt`, 'together\n']),
          ),
          within: 60,
        },
      },
    ],
  }),

  // e2e/nx/src/run.test.ts “should see a log marker the server prints as soon as it starts”.
  defineCase({
    id: 'graph/ready-line-printed-at-once-releases',
    category: 'graph',
    kind: 'correctness',
    title:
      'A server that prints its ready line as its very first output still releases what waits for it',
    why: 'Nothing replays a server’s earlier output, so a matcher that starts listening a moment after the spawn misses a line printed at once. The server is up, and its dependants wait forever for a line that already came. The ready line counts from the first byte the server writes.',
    from: ['persistent', 'ready-wait-notice'],
    needs: ['persistent', 'ready'],
    workspace: {
      projects: {
        app: {
          tasks: {
            srv: {
              command: 'touch booted; echo Listening on 3000; exec sleep 60',
              persistent: { ready: 'Listening on' },
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

  // --- Outputs ---

  // e2e/nx/src/cache.test.ts “should handle outputs with globs and directories containing symlinks” (nrwl/nx#34013).
  defineCase({
    id: 'outputs/link-in-dir-output-beside-file-glob',
    category: 'outputs',
    kind: 'correctness',
    title:
      'Outputs mixing a file pattern and two directory trees, one holding a symlink, cache and come back whole',
    why: 'A Next.js build leaves manifests matched by `*.json` beside standalone and server trees, and the standalone tree holds links. Storing the file pattern and the trees as separate pieces once made the store trip over the link and fail the save. Every piece, the link included, must be stored, replayed with the outputs intact, and restored once deleted.',
    from: ['output-glob-links', 'output-links'],
    workspace: one(
      {
        command: [
          'rm -rf .next',
          'mkdir -p .next/standalone/real .next/server',
          'echo "{}" > .next/build-manifest.json',
          'echo "[]" > .next/routes-manifest.json',
          'echo index > .next/standalone/real/index.js',
          'echo server > .next/standalone/server.js',
          'ln -s real/index.js .next/standalone/linked-entry.js',
          'echo app > .next/server/app.js',
        ].join(' && '),
        inputs: ['src/**'],
        outputs: ['.next/*.json', '.next/standalone/**', '.next/server/**'],
      },
      { 'src/a.txt': 'a\n' },
    ),
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
      { sh: 'rm -rf packages/a/.next' },
      {
        run: 'build',
        expect: {
          exit: 0,
          notRan: ['a#build'],
          files: {
            'packages/a/.next/build-manifest.json': '{}\n',
            'packages/a/.next/routes-manifest.json': '[]\n',
            'packages/a/.next/standalone/real/index.js': 'index\n',
            'packages/a/.next/standalone/server.js': 'server\n',
            'packages/a/.next/server/app.js': 'app\n',
          },
        },
      },
      { check: { links: { 'packages/a/.next/standalone/linked-entry.js': 'real/index.js' } } },
    ],
  }),
  // packages/nx/src/tasks-runner/create-task-graph.spec.ts “dependsOn with inputs: false: carries the option through a project without the target”.
  defineCase({
    id: 'cache/unkeyed-edge-through-taskless-project-replays',
    category: 'cache',
    kind: 'efficiency',
    title:
      'A build not keyed on its dependencies replays when a library it reaches through a project without a build changes',
    why: 'The app reaches the library’s build through a middle project that has no build of its own, and the app was told not to key on what it depends on. Passing through a project without the task does not turn that edge back into a keyed one. The library rebuilds, and the app, whose own sources are the same, replays.',
    from: ['unkeyed-upstream', 'exclude-dependencies-key'],
    needs: ['dependency-inputs-off'],
    workspace: {
      projects: {
        lib: {
          tasks: {
            build: {
              command: 'mkdir -p dist && cat src/a.txt > dist/out.txt',
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'lib\n' },
        },
        mid: { deps: ['lib'], files: { 'a.txt': 'mid\n' } },
        app: {
          deps: ['mid'],
          tasks: {
            build: {
              command: 'mkdir -p dist && cat src/a.txt > dist/out.txt',
              dependsOn: ['^build'],
              dependencyInputs: false,
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'app\n' },
        },
      },
    },
    steps: [
      {
        run: 'build',
        expect: { exit: 0, ran: ['lib#build', 'app#build'], order: [['lib#build', 'app#build']] },
      },
      { write: { 'packages/lib/src/a.txt': 'lib2\n' } },
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['lib#build'],
          notRan: ['app#build'],
          files: { 'packages/lib/dist/out.txt': 'lib2\n', 'packages/app/dist/out.txt': 'app\n' },
        },
      },
    ],
  }),

  // packages/nx/src/tasks-runner/task-orchestrator.spec.ts “should run a deferred task behind both a cache miss and a non-cacheable task in the first wave”.
  defineCase({
    id: 'cache/unkeyed-dependant-of-uncached-task-replays',
    category: 'cache',
    kind: 'efficiency',
    title:
      'A cached task behind a never-cached prerequisite replays when it is not keyed on that prerequisite',
    why: 'A never-cached prerequisite runs on every run, and a tool that cannot tell what it changed may refuse to replay what depends on it. Here the dependant was told not to key on its prerequisites, and its own sources are the same. The prerequisite runs, as it always does, and the dependant replays.',
    from: ['uncached-upstream-key', 'unkeyed-upstream'],
    needs: ['uncached-task', 'dependency-inputs-off'],
    workspace: {
      projects: {
        a: {
          tasks: {
            prepare: { command: 'date +%s%N > ../../stamp.txt', cache: false },
            build: {
              command: 'mkdir -p dist && cat src/a.txt > dist/out.txt',
              dependsOn: ['prepare'],
              dependencyInputs: false,
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    steps: [
      {
        run: 'build',
        expect: { exit: 0, ran: ['a#prepare', 'a#build'], order: [['a#prepare', 'a#build']] },
      },
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['a#prepare'],
          notRan: ['a#build'],
          files: { 'packages/a/dist/out.txt': 'a\n' },
        },
      },
    ],
  }),

  // packages/nx/src/tasks-runner/utils.spec.ts “negated outputs: should keep the negation on a root project, where {projectRoot} interpolates to nothing”.
  defineCase({
    id: 'outputs/root-project-negated-output-left-out',
    category: 'outputs',
    kind: 'correctness',
    title: 'The root project’s `!` output entry keeps that folder out of what a replay brings back',
    why: 'When the repository root is itself a project, its outputs are paths with no directory in front. A negation there still names a path under the root project. A tool that loses the `!` while joining it to an empty project path stores the scratch folder with the build, or refuses the pattern, and the replay brings back files the user took out.',
    from: ['negated-outputs', 'root-project'],
    workspace: {
      projects: {
        other: { files: { 'src/x.txt': 'x\n' } },
        root: {
          dir: '.',
          tasks: {
            build: {
              command:
                'mkdir -p dist/cache && cat src/in.txt > dist/app.txt && echo scratch > dist/cache/tmp.txt',
              inputs: ['src/**'],
              outputs: ['dist/**', '!dist/cache/**'],
            },
          },
          files: { 'src/in.txt': 'root\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, files: { 'dist/app.txt': 'root\n' } } },
      { sh: 'rm -rf dist' },
      {
        run: 'build',
        expect: {
          exit: 0,
          notRan: ['root#build'],
          files: { 'dist/app.txt': 'root\n', 'dist/cache/tmp.txt': null },
        },
      },
    ],
  }),
] satisfies Case[]

// vx fails these; each is a vx bug, not a wrong case (see the report).
export const pending: Case[] = [
  // packages/nx/src/tasks-runner/create-task-graph.spec.ts “dependsOn with inputs: false: records the edge but still runs the dependency”.
  defineCase({
    id: 'affected/unkeyed-dependant-left-out',
    category: 'affected',
    kind: 'efficiency',
    title: 'A library change leaves out the app’s test that is not keyed on the library',
    why: 'The app’s test waits for the library’s build but is declared not keyed on it, so the library cannot change its result. Selecting it because the projects are linked reruns a test whose answer is already known. The library’s own test still runs.',
    from: ['affected-tasks', 'unkeyed-upstream'],
    needs: ['affected', 'dependency-inputs-off'],
    workspace: {
      projects: {
        lib: {
          tasks: {
            build: {
              command: 'mkdir -p dist && cat src/a.txt > dist/out.txt',
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
            test: { command: 'cat src/a.txt', inputs: ['src/**'], outputs: [] },
          },
          files: { 'src/a.txt': 'lib\n' },
        },
        app: {
          deps: ['lib'],
          tasks: {
            test: {
              command: 'cat src/a.txt',
              dependsOn: ['^build'],
              dependencyInputs: false,
              inputs: ['src/**'],
              outputs: [],
            },
          },
          files: { 'src/a.txt': 'app\n' },
        },
      },
    },
    steps: [
      { write: { 'packages/lib/src/a.txt': 'lib2\n' } },
      { commit: 'edit lib' },
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, ran: ['lib#test'], notRan: ['app#test'] },
      },
    ],
  }),
]
