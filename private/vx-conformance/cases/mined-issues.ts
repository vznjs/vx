// Cases drawn from bugs Turborepo, Nx, moon and Vite Task fixed: each names
// the issue, pull request or changelog line above it, and holds any task
// runner to the outcome the fix restored.
import { defineCase, type Case, type Stop, type TaskSpec } from '../src/spec.ts'
import { CONCAT, chainBuild, chainProject, one, out } from './shapes.ts'

const build = (extra: Partial<TaskSpec> = {}): TaskSpec => ({
  command: CONCAT,
  inputs: ['src/**'],
  outputs: ['dist/**'],
  ...extra,
})

/** Wait (bounded) for a file, then go on. */
const until = (file: string) =>
  `i=0; until [ -e ${file} ] || [ $i -ge 400 ]; do sleep 0.05; i=$((i+1)); done; [ -e ${file} ]`

const A = 'packages/a/src/a.txt'

/** A build of `lib` that fails while its source says `fail`. */
const FAILABLE = 'grep -qv fail src/a.txt && mkdir -p dist && cat src/*.txt > dist/out.txt'

export default [
  // moon 1.x: "Fixed an issue where `NO_COLOR` or `FORCE_COLOR` would be
  // overwritten for task child processes", and "`NO_COLOR` and `FORCE_COLOR`
  // being unexpectedly set in some situations".
  defineCase({
    id: 'env/no-color-reaches-task-without-force-color',
    category: 'env',
    kind: 'correctness',
    title: 'A run under `NO_COLOR=1` hands the task `NO_COLOR` and no `FORCE_COLOR` it never set',
    why: '`NO_COLOR` is the user asking every program for plain text. A runner that passes the variable on but also invents a `FORCE_COLOR` for the task wins over it, since most color libraries check `FORCE_COLOR` first. The task should see exactly what the user’s environment holds: `NO_COLOR` set, `FORCE_COLOR` absent.',
    from: ['colors', 'env'],
    needs: ['pass-through-env'],
    workspace: one({
      command: 'echo "${NO_COLOR-unset} ${FORCE_COLOR-unset}" > color.txt',
      passThrough: ['NO_COLOR', 'FORCE_COLOR'],
      cache: false,
    }),
    steps: [
      {
        run: 'build',
        env: { NO_COLOR: '1' },
        expect: { exit: 0, files: { 'packages/a/color.txt': '1 unset\n' } },
      },
    ],
  }),

  // moon 2.6.3: "Fixed an issue where a task that stopped before running its
  // command, because another task failed ..., would be cached on the next
  // run, reusing outputs from its previous inputs."
  defineCase({
    id: 'failure/skipped-dependant-builds-its-new-sources-once-unblocked',
    category: 'failure',
    kind: 'correctness',
    title:
      'A project skipped because its dependency failed builds its edited sources once the dependency is fixed',
    why: 'A task skipped behind a failure never ran on its new sources, so nothing about that skip may stand for a result. Once the dependency is fixed, the next run has to build the edited project. A tool that recorded the skipped task as done under its new inputs replays the build of its old sources instead.',
    from: ['failure-mode'],
    workspace: {
      projects: {
        lib: { tasks: { build: build({ command: FAILABLE }) }, files: { 'src/a.txt': 'lib\n' } },
        app: chainProject('app', ['lib']),
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['lib#build', 'app#build'] } },
      { write: { 'packages/lib/src/a.txt': 'fail\n', 'packages/app/src/a.txt': 'app2\n' } },
      { run: 'build', expect: { exit: 'fail', notRan: ['app#build'] } },
      { write: { 'packages/lib/src/a.txt': 'lib\n' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['app#build'], files: { [out('app')]: 'lib\napp2\n' } },
      },
    ],
  }),

  // moon 2.3: "tasks that depend on a persistent task would still run when
  // the persistent task was skipped (because one of its own dependencies
  // failed), when failures don't abort the pipeline".
  defineCase({
    id: 'failure/server-skipped-by-failed-build-starts-no-user',
    category: 'failure',
    kind: 'correctness',
    title:
      'A test whose server was skipped behind a failed build does not run, and the rest still does',
    why: 'A server that never started cannot serve the test that needs it. Skipping the server because its build failed has to skip the test too, or the test runs against nothing and fails with a confusing connection error, or passes against a stale server. Work that needs neither still runs, as with any failure.',
    from: ['failure-mode'],
    needs: ['persistent'],
    workspace: {
      projects: {
        lib: { tasks: { build: build({ command: 'exit 1' }) }, files: { 'src/a.txt': 'lib\n' } },
        app: {
          tasks: {
            serve: { command: 'touch up; sleep 60', dependsOn: ['lib#build'], persistent: true },
            test: { command: 'touch test.ran', dependsOn: ['serve'], cache: false },
          },
          files: { 'src/a.txt': 'app\n' },
        },
        docs: { tasks: { test: { command: 'touch test.ran', cache: false } } },
      },
    },
    steps: [
      {
        run: 'test',
        expect: {
          exit: 'fail',
          ran: ['docs#test'],
          notRan: ['app#test'],
          files: { 'packages/app/test.ran': null, 'packages/app/up': null },
          within: 30,
          alone: true,
        },
      },
    ],
  }),

  // moon 1.x: "Fixed an issue when `ctrl+c`ing multiple persistent tasks
  // would sometimes leave them running in the background."
  defineCase({
    id: 'failure/stop-ends-two-servers-at-once',
    category: 'failure',
    kind: 'correctness',
    title: 'Ctrl-C with two dev servers running ends both, and leaves neither in the background',
    why: 'Running two dev servers side by side, an API and a web app, is the usual reason to start a task runner in the morning. One Ctrl-C has to end both. A server left behind keeps its port, so the next start fails with the address in use and the user hunts for a process they cannot see.',
    from: ['signal-handling'],
    needs: ['persistent'],
    workspace: {
      projects: {
        api: { tasks: { dev: { command: 'touch up; sleep 60', persistent: true } } },
        web: {
          tasks: {
            dev: { command: `${until('../api/up')} && touch up; sleep 60`, persistent: true },
          },
        },
      },
    },
    steps: [
      {
        run: 'dev',
        stop: { signal: 'SIGINT', when: 'packages/web/up' } satisfies Stop,
        expect: { within: 20, alone: true },
      },
    ],
  }),

  // moon 1.x: "Fixed an issue where moon would attempt to execute a folder
  // if it has the same name as the current shell."
  defineCase({
    id: 'env/folders-named-like-the-shell-run-nothing',
    category: 'env',
    kind: 'correctness',
    title:
      'Folders named `sh` and `bash` in the project and the root do not stop a command from running',
    why: 'A `bash` folder of shell scripts, or an `sh` folder of helpers, is an ordinary thing to keep in a repository. The runner finds its shell on the PATH, not in the directory a task runs in. A runner that resolves `sh` against the working directory tries to execute the folder and fails every task of that project.',
    from: ['task-shell'],
    workspace: {
      projects: {
        a: {
          tasks: { build: build() },
          files: { 'src/a.txt': 'a\n', 'sh/run.sh': 'echo\n', 'bash/run.sh': 'echo\n' },
        },
      },
      files: { 'sh/x.sh': 'echo\n', 'bash/x.sh': 'echo\n' },
    },
    steps: [{ run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'a\n' } } }],
  }),

  // nx #37024 "keep continuous dependencies reached through a project
  // without the target".
  defineCase({
    id: 'graph/server-reached-through-project-without-it',
    category: 'graph',
    kind: 'correctness',
    title:
      'A test waiting on its dependencies’ servers waits for one reached through a project with no server',
    why: '`^serve` means the servers of everything the project builds on, as `^build` passes through a middle package that has no build. Here `app` uses `lib` only through `mid`, which serves nothing. A tool that stops at `mid` starts the test with no server up, and the test fails or hits whatever stale server holds the port.',
    from: ['persistent'],
    needs: ['persistent', 'ready'],
    workspace: {
      projects: {
        lib: {
          tasks: {
            serve: {
              command: 'sleep 0.5; touch up; echo serving; sleep 60',
              persistent: { ready: 'serving' },
            },
          },
        },
        mid: { deps: ['lib'], files: { 'src/a.txt': 'mid\n' } },
        app: {
          deps: ['mid'],
          tasks: {
            test: {
              command: 'test -f ../lib/up && touch test.ran',
              dependsOn: ['^serve'],
              cache: false,
            },
          },
        },
      },
    },
    steps: [
      {
        run: 'test',
        projects: ['app'],
        expect: { exit: 0, files: { 'packages/app/test.ran': '' }, within: 30, alone: true },
      },
    ],
  }),

  // turborepo #7175 "fix: tasks with no newline": the last line a task
  // printed without a newline went missing.
  defineCase({
    id: 'failure/failing-task-last-line-without-newline-shows',
    category: 'failure',
    kind: 'correctness',
    title: 'The error a failing task prints with no newline after it still shows',
    why: 'Plenty of programs end on a line with no newline: a `printf` error, a progress line cut short, a JSON blob. When the task fails, that last line is usually the reason. A tool that splits output on newlines and drops the unfinished tail hides the one line the developer needed.',
    from: ['failed-output-whole'],
    workspace: one({
      command: "printf 'error: 3 files missing'; exit 1",
      inputs: ['src/**'],
      outputs: [],
    }),
    steps: [{ run: 'build', expect: { exit: 'fail', output: ['error: 3 files missing'] } }],
  }),
  // turborepo #12445 "Skip Unix domain sockets and other special files during
  // file hashing".
  defineCase({
    id: 'inputs/unix-socket-under-glob-no-hang',
    category: 'inputs',
    kind: 'correctness',
    title: 'A Unix socket left under an input glob neither hangs nor fails the run',
    why: 'Dev servers, language servers and test runners leave socket files behind in the tree they work in. A socket has no bytes to hash; opening it to read blocks or fails. The run should key the real files around it and go on, and replay when nothing else changed.',
    from: ['unlistable-input-dir'],
    workspace: one(build()),
    steps: [
      {
        sh: `python3 -c "import socket; s = socket.socket(socket.AF_UNIX); s.bind('packages/a/src/dev.sock')"`,
      },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], within: 30 } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'], within: 30 } },
      { write: { [A]: 'a2\n' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'a2\n' } } },
    ],
  }),

  // turborepo #14164 "Respect negated global dependencies in affected detection".
  defineCase({
    id: 'affected/root-input-negation-selects-nothing',
    category: 'affected',
    kind: 'efficiency',
    title: 'A change to a root file a task’s root inputs take back with `!` selects nothing',
    why: 'Root inputs `config/**` with `!config/CHANGELOG.md` say the task reads the config folder except its changelog. Editing only the changelog cannot change the task’s result, and a plain run replays it. An affected run that matches the positive pattern and forgets the negation sends the whole task to CI for a notes edit.',
    from: ['affected-workspace-files'],
    needs: ['affected'],
    workspace: {
      projects: {
        app: {
          tasks: {
            build: build({ rootInputs: ['config/**', '!config/CHANGELOG.md'] }),
          },
          files: { 'src/a.txt': 'app\n' },
        },
      },
      files: { 'config/base.json': '{}\n', 'config/CHANGELOG.md': 'one\n' },
    },
    steps: [
      { write: { 'config/CHANGELOG.md': 'two\n' } },
      { commit: 'notes' },
      { affected: 'build', base: 'HEAD~1', expect: { exit: 0, notRan: ['app#build'] } },
    ],
  }),

  // moon 1.x: "Fixed an issue where a task with explicit no inputs
  // (`inputs: []`) would always be marked as affected."
  defineCase({
    id: 'affected/task-with-empty-inputs-not-selected',
    category: 'affected',
    kind: 'efficiency',
    title: 'An edit in a project does not select its task that declares no inputs at all',
    why: '`inputs: []` says the task reads no file of the project: a deploy notifier, a check against a remote service. A plain run replays it after any edit. An affected run that treats an empty list as “everything” selects it on every change, the opposite of what the user wrote.',
    from: ['affected-tasks'],
    needs: ['affected'],
    workspace: {
      projects: {
        app: {
          tasks: {
            build: build(),
            ping: { command: 'echo ping > ping.txt', inputs: [], outputs: ['ping.txt'] },
          },
          files: { 'src/a.txt': 'app\n' },
        },
      },
    },
    steps: [
      { write: { 'packages/app/src/a.txt': 'app2\n' } },
      { commit: 'edit' },
      { affected: 'ping', base: 'HEAD~1', expect: { exit: 0, notRan: ['app#ping'] } },
    ],
  }),

  // moon 1.x: "Fixed an issue where project and workspace inputs of the same
  // file path would be unexpectedly deduped."
  defineCase({
    id: 'inputs/project-and-root-file-of-one-name-both-key',
    category: 'inputs',
    kind: 'correctness',
    title: 'A project input and a root input with the same name each key the task',
    why: '`settings.txt` in the project and `settings.txt` at the root are two files that happen to share a name. A task that reads both has to rerun when either changes. A tool that merges inputs by their written path keeps one of them, and an edit to the other replays a build of the old config.',
    from: ['workspace-root-file'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: build({
              command: 'mkdir -p dist && cat ../../settings.txt settings.txt > dist/out.txt',
              inputs: ['settings.txt'],
              rootInputs: ['settings.txt'],
            }),
          },
          files: { 'settings.txt': 'project\n' },
        },
      },
      files: { 'settings.txt': 'root\n' },
    },
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { write: { 'settings.txt': 'root2\n' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'root2\nproject\n' } },
      },
      { write: { 'packages/a/settings.txt': 'project2\n' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'root2\nproject2\n' } },
      },
    ],
  }),

  // turborepo #14898 "Restore cache files without temporary names".
  defineCase({
    id: 'outputs/restore-leaves-no-temporary-files',
    category: 'outputs',
    kind: 'correctness',
    title:
      'A replay into an emptied output folder leaves exactly the stored files, nothing named in between',
    why: 'A tool may write each restored file under a scratch name and rename it into place. If a rename is skipped or fails, `dist` holds files no build ever made, and a bundler or a `files` glob in package.json ships them. After a replay the folder should list the stored names and no others.',
    from: ['restore-staging'],
    workspace: one(
      build({
        command: 'mkdir -p dist/sub && cp src/a.txt dist/a.js && cp src/a.txt dist/sub/b.js',
      }),
    ),
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { sh: 'rm -rf packages/a/dist' },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
      {
        sh: '[ "$(cd packages/a/dist && find . | sort | tr "\\n" " ")" = ". ./a.js ./sub ./sub/b.js " ]',
      },
    ],
  }),

  // nx #26244 "handle relative paths after {projectRoot} in outputs".
  defineCase({
    id: 'config/output-climb-and-return-restored-or-refused',
    category: 'config',
    kind: 'correctness',
    title: 'An output `build/../dist/**` stores and restores `dist`, or is refused',
    why: 'The pattern climbs into `build` and back out, so it names `dist/**` inside the project. A tool that matches it as text against the files it walks finds nothing, saves an empty entry and replays a hit that restores no file. Normalising it, or refusing the `..`, is right; a hit with `dist` missing is not.',
    from: ['dot-slash-globs'],
    workspace: one(build({ outputs: ['build/../dist/**'] })),
    steps: [
      { run: 'build', expect: { exit: 0, orRefused: true } },
      { write: { [out('a')]: null } },
      {
        run: 'build',
        expect: {
          exit: 0,
          ifReplayed: { task: 'a#build', files: { [out('a')]: 'a\n' } },
          orRefused: true,
        },
      },
    ],
  }),
  // turborepo #14489 "Prevent Git index refresh during dirty hash collection".
  defineCase({
    id: 'inputs/run-leaves-the-git-index-alone',
    category: 'inputs',
    kind: 'correctness',
    title: 'A run over files whose timestamps changed leaves git’s index file as it was',
    why: 'Asking git which files changed refreshes and rewrites `.git/index` when timestamps moved, as a checkout or a formatter leaves them. A runner that does that while the user runs `git commit` or a rebase in another terminal races them for `index.lock`, and their command fails. Reading the tree should leave the repository’s own files untouched.',
    from: ['git-optional-locks'],
    workspace: one(build(), { 'src/a.txt': 'a\n', 'src/b.txt': 'b\n' }),
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      {
        sh: 'touch -d "2001-01-01" packages/a/src/*.txt && mkdir -p .home && cksum < .git/index > .home/index',
      },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
      { sh: '[ "$(cksum < .git/index)" = "$(cat .home/index)" ]' },
    ],
  }),

  // turborepo #14807 "Restore cached symlinks when outputs are already on disk".
  defineCase({
    id: 'outputs/deleted-link-beside-intact-files-restored',
    category: 'outputs',
    kind: 'correctness',
    title:
      'An output link deleted on its own comes back, though the files beside it are still there',
    why: 'A tool that skips the restore when the output files it checks are already in place has to count links among them. Here only `dist/latest.js`, a link to `index.js`, is gone. Calling the outputs intact because `index.js` is there leaves the link missing, and whatever loads `latest.js` breaks after a green run.',
    from: ['restore-in-place', 'output-links'],
    workspace: one(
      build({
        command: 'mkdir -p dist && cp src/a.txt dist/index.js && ln -sf index.js dist/latest.js',
      }),
    ),
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { sh: 'rm packages/a/dist/latest.js' },
      { run: 'build', expect: { exit: 0 } },
      { check: { links: { 'packages/a/dist/latest.js': 'index.js' } } },
    ],
  }),

  // moon 1.x: "Fixed an issue where the shell could not be detected, and would
  // potentially hang."
  defineCase({
    id: 'env/unusable-login-shell-still-runs-tasks',
    category: 'env',
    kind: 'correctness',
    title: 'A `SHELL` naming a program that is not installed does not stop or hang a run',
    why: '`SHELL` is the user’s login shell, set by their account or left over from another machine in a container image. A task command is POSIX shell, run by `sh` from the PATH, whatever the user logs in with. A runner that starts tasks through `$SHELL` fails every one when it names nothing, or hangs probing for it.',
    from: ['task-shell'],
    workspace: one(build()),
    steps: [
      {
        run: 'build',
        env: { SHELL: '/nonexistent/bin/fish' },
        expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'a\n' }, within: 30 },
      },
    ],
  }),

  // vite-task #937: "Tasks that read the task cache folder ... now hit the
  // cache. `vp run` changes that folder after every run ... from then on those
  // tasks missed every time".
  defineCase({
    id: 'cache/root-task-over-everything-replays-without-ignore-rules',
    category: 'cache',
    kind: 'efficiency',
    title:
      'A root task reading every file replays, though the repository ignores none of the runner’s files',
    why: 'Not every repository lists a task runner’s state folder in `.gitignore`, and a root task such as a format check reads everything. The runner writes its cache, logs and lock files after each run. Counting its own writes as edits makes such a task miss on every run, forever.',
    from: ['output-never-dotvx', 'cache-dir-in-outputs'],
    workspace: {
      projects: {
        root: {
          dir: '.',
          tasks: { check: { command: 'ls -aR . > /dev/null', inputs: ['**'], outputs: [] } },
          files: { 'notes.txt': 'n\n' },
        },
        a: { files: { 'src/a.txt': 'a\n' } },
      },
      // The harness’s marker files only: nothing of any runner.
      files: { '.gitignore': 'node_modules\n.home\n.ran\n.left\n.stop-watch\n' },
    },
    steps: [
      { run: 'check', expect: { exit: 0, ran: ['root#check'] } },
      { run: 'check', expect: { exit: 0, notRan: ['root#check'] } },
      { run: 'check', expect: { exit: 0, notRan: ['root#check'] } },
    ],
  }),

  // turborepo #7196 "keep stdin open for persistent tasks", again in #11793,
  // #12394 and #12972: Tailwind’s and esbuild’s watchers quit when their
  // input ends.
  defineCase({
    id: 'graph/server-reading-its-input-keeps-running',
    category: 'graph',
    kind: 'correctness',
    title:
      'A dev server that quits when its input ends keeps running while the runner’s input stays open',
    why: 'Tailwind’s watcher and esbuild’s server stop as soon as their input stream ends, so that closing the terminal ends them. Under a runner whose own input is still open, such a server must not see an end it was never sent. A runner that gives servers an empty input ends them at once, and the test that needs one runs against nothing.',
    from: ['persistent', 'keep-alive'],
    needs: ['persistent'],
    workspace: {
      projects: {
        app: {
          tasks: {
            dev: { command: 'touch up; cat > /dev/null; touch ended', persistent: true },
            e2e: {
              command: `${until('up')} && sleep 1 && [ ! -e ended ] && touch e2e.ran`,
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
        openStdin: true,
        expect: { exit: 0, files: { 'packages/app/e2e.ran': '' }, within: 20, alone: true },
      },
    ],
  }),
  // nx #37762 "keep run-commands output written right before a command
  // exits": `echo OUT-LINE; echo ERR-LINE >&2; exit 1` lost its lines.
  defineCase({
    id: 'failure/failing-task-shows-both-streams-printed-as-it-exits',
    category: 'failure',
    kind: 'correctness',
    title: 'A task that prints one line to each stream and fails at once shows both lines',
    why: 'A compiler or a linter prints its error and exits in the same breath, often on the error stream. A runner that takes the exit as the end of the task, before it has drained both pipes, loses exactly those last lines. The failure then shows no reason at all.',
    from: ['failed-output-whole', 'raw-output-bytes'],
    workspace: one({
      command: 'echo out-line-7d1; echo err-line-7d1 >&2; exit 1',
      inputs: ['src/**'],
      outputs: [],
    }),
    steps: [{ run: 'build', expect: { exit: 'fail', output: ['out-line-7d1', 'err-line-7d1'] } }],
  }),

  // nx #18643 "set consistent working directory when calculating runtime
  // hash inputs".
  defineCase({
    id: 'inputs/runtime-command-runs-at-the-root-from-any-folder',
    category: 'inputs',
    kind: 'correctness',
    title:
      'A command that keys a task gives the same answer when the run starts inside the project',
    why: 'A key command such as `cat tools/version.txt` is written against the workspace root. Run from wherever the user stands, it fails or reads another file, and the same task gets a different key in each folder. The run from inside the project should replay what the root run stored.',
    from: ['runtime-inputs', 'member-cwd'],
    needs: ['runtime-inputs'],
    workspace: {
      projects: {
        a: {
          tasks: { build: build({ runtime: ['cat tools/version.txt'] }) },
          files: { 'src/a.txt': 'a\n' },
        },
      },
      files: { 'tools/version.txt': 'v1\n' },
    },
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { run: 'build', cwd: 'packages/a', expect: { exit: 0, notRan: ['a#build'] } },
      { write: { 'tools/version.txt': 'v2\n' } },
      { run: 'build', cwd: 'packages/a', expect: { exit: 0, ran: ['a#build'] } },
    ],
  }),
  // turborepo #14976 "Preserve exclude-self for unbraced location filters":
  // `...^./packages/utils` ran utils itself.
  defineCase({
    id: 'graph/select-dir-only-dependents',
    category: 'graph',
    kind: 'correctness',
    title: 'Only the dependents of a project picked by its folder leaves that project out',
    why: 'Asking for the dependents of the project in `packages/utils`, without it, is how a user checks what a change could break after building the library by hand. Naming the project by its folder instead of its name must mean the same. A tool that drops the “without it” for a folder selector runs the library too, the one thing the user left out.',
    from: ['filter', 'select'],
    needs: ['filter', 'select-walk', 'select-dir'],
    workspace: {
      projects: Object.fromEntries(
        (
          [
            ['utils', []],
            ['ui', ['utils']],
            ['app', ['ui']],
            ['lib', []],
          ] as const
        ).map(([name, deps]) => [
          name,
          {
            deps: [...deps],
            tasks: { check: { command: 'true', inputs: ['src/**'] } },
            files: { 'src/a.txt': `${name}\n` },
          },
        ]),
      ),
    },
    steps: [
      {
        run: 'check',
        select: [{ dir: 'packages/utils', with: 'dependents', self: false }],
        expect: { exit: 0, ran: ['ui#check', 'app#check'], notRan: ['utils#check', 'lib#check'] },
      },
    ],
  }),

  // nx #37550 "stop readyWhen logMatches from matching Nx command lines": a
  // runner that echoes the command into the output it watches matched
  // `--port 3000` before the server listened.
  defineCase({
    id: 'graph/ready-text-in-the-server-command-does-not-release',
    category: 'graph',
    kind: 'correctness',
    title:
      'A ready text that also appears in the server’s own command does not release its dependants early',
    why: 'A ready text is often a port, and the port is often in the command: `serve --port 3000`, ready on `3000`. A runner that prints the command line into the output it watches for the ready text finds it before the server has printed anything. The test then starts against a server that is not listening yet.',
    from: ['ready-wait-notice', 'persistent'],
    needs: ['persistent', 'ready'],
    workspace: {
      projects: {
        app: {
          tasks: {
            serve: {
              command: 'sleep 1.5; touch up; echo listening-port-3417; sleep 60',
              persistent: { ready: 'listening-port-3417' },
            },
            e2e: { command: '[ -e up ] && touch e2e.ran', dependsOn: ['serve'], cache: false },
          },
        },
      },
    },
    steps: [
      {
        run: 'e2e',
        expect: { exit: 0, files: { 'packages/app/e2e.ran': '' }, within: 30, alone: true },
      },
    ],
  }),

  // nx #33492 "propagate continuous task failures to dependent tasks": with a
  // continuous task over another, the dependency’s exit left the dependent
  // running forever.
  defineCase({
    id: 'failure/server-whose-backing-server-dies-is-stopped',
    category: 'failure',
    kind: 'correctness',
    title: 'A dev server whose API server dies is stopped, and the run fails instead of running on',
    why: 'A web dev server that proxies to an API server is useless once the API is gone. The API’s crash is the error the developer needs, and nothing else will ever end the web server. A runner that only marks the API failed keeps the web server up forever, and the run never ends.',
    from: ['server-crash-fail-fast', 'server-chain'],
    needs: ['persistent'],
    workspace: {
      projects: {
        app: {
          tasks: {
            api: { command: 'touch api.up; sleep 1; exit 1', persistent: true },
            web: { command: 'touch web.up; sleep 60', dependsOn: ['api'], persistent: true },
          },
        },
      },
    },
    steps: [{ run: 'web', expect: { exit: 'fail', within: 30, alone: true } }],
  }),
  // nx #37264: with outputs `target/test-classes` and
  // `!target/test-classes/**/*.class`, the walked directories were copied
  // whole, so the excluded files were stored and restored anyway.
  defineCase({
    id: 'config/output-directory-with-negation-leaves-excluded-files',
    category: 'config',
    kind: 'correctness',
    title:
      'An output naming a directory beside a `!` pattern under it never restores what the `!` takes back',
    why: 'Outputs `target/classes` with `!target/classes/**/*.tmp` keep scratch files out of the cache. A tool that stores the folders it walks as whole folders stores the scratch files with them, and every replay brings them back. Restoring the directory without them, or refusing the pair, is right; restoring them is not.',
    from: ['negated-outputs', 'output-dirs'],
    workspace: one(
      build({
        command:
          'mkdir -p target/classes/com && cp src/a.txt target/classes/com/A.class && echo scratch > target/classes/com/A.tmp',
        outputs: ['target/classes', '!target/classes/**/*.tmp'],
      }),
    ),
    steps: [
      { run: 'build', expect: { exit: 0, orRefused: true } },
      { sh: 'rm -rf packages/a/target' },
      {
        run: 'build',
        expect: {
          exit: 0,
          orRefused: true,
          ifReplayed: {
            task: 'a#build',
            files: {
              'packages/a/target/classes/com/A.class': 'a\n',
              'packages/a/target/classes/com/A.tmp': null,
            },
          },
        },
      },
    ],
  }),

  // turborepo #13756 "Respect gitignore without git metadata", and #13690
  // "Apply nested parent gitignore patterns in manual hashing".
  defineCase({
    id: 'inputs/gitignored-file-without-git-replays',
    category: 'inputs',
    kind: 'efficiency',
    title:
      'In a workspace that is not a git repository, an edit to a file `.gitignore` names replays the task',
    why: 'A source tarball or a Docker build context often keeps its `.gitignore` but drops `.git`. The ignore file still says what is local state: logs, caches, editor files. A tool that keys every file once git is missing reruns the task whenever a log under its sources changes.',
    from: ['no-git-on-path', 'ignored-inputs'],
    needs: ['without-git'],
    workspace: one(build(), {
      'src/a.txt': 'a\n',
      'src/debug.log': 'one\n',
      '.gitignore': '*.log\n',
    }),
    steps: [
      { sh: 'rm -rf .git' },
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { write: { 'packages/a/src/debug.log': 'two\n' } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
      { write: { [A]: 'a2\n' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
    ],
  }),
  // turborepo #14156 "Treat root internal dependency changes as global":
  // a change to a package the root depends on must reach the root’s tasks.
  defineCase({
    id: 'affected/library-change-reaches-the-root-package-using-it',
    category: 'affected',
    kind: 'correctness',
    title:
      'A change in a library the root package depends on selects the root’s task, and not an unrelated project',
    why: 'The root package is a project like any other: a root task that bundles or checks the libraries the root depends on is their dependent. A selection that treats the root as outside the graph leaves its task out, and the bundle ships the old library. Treating the change as touching everything goes too far the other way and rebuilds `docs`, which uses nothing that changed.',
    from: ['affected-dependents', 'root-project'],
    needs: ['affected'],
    workspace: {
      projects: {
        root: {
          dir: '.',
          deps: ['lib'],
          tasks: {
            build: {
              command: 'mkdir -p dist && cat packages/lib/dist/out.txt tools/*.txt > dist/root.txt',
              dependsOn: ['^build'],
              inputs: ['tools/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'tools/x.txt': 'root\n' },
        },
        lib: chainProject('lib'),
        docs: chainProject('docs'),
      },
    },
    steps: [
      { write: { 'packages/lib/src/a.txt': 'lib2\n' } },
      { commit: 'lib' },
      {
        affected: 'build',
        base: 'HEAD~1',
        expect: {
          exit: 0,
          ran: ['lib#build', 'root#build'],
          notRan: ['docs#build'],
          files: { 'dist/root.txt': 'lib2\nroot\n' },
        },
      },
    ],
  }),
  // turborepo #13056 "Strip special mode bits from cache restore".
  defineCase({
    id: 'outputs/setuid-bit-not-restored',
    category: 'outputs',
    kind: 'correctness',
    title:
      'A replay brings back a set-user-ID program as a plain executable, without the special bit',
    why: 'A cache entry can come from another machine or another user, so what it restores must not grant privileges. A setuid bit on a restored program runs it as its owner, the user who restored it, whoever invokes it. The file and its executable bits come back; the set-user-ID bit does not.',
    from: ['restore-umask', 'archive-security'],
    workspace: one(
      build({
        command: `mkdir -p dist && printf '#!/bin/sh\\necho hi\\n' > dist/tool && chmod 4755 dist/tool`,
      }),
    ),
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { write: { 'packages/a/dist/tool': null } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
      { check: { executable: ['packages/a/dist/tool'] } },
      { sh: '[ ! -u packages/a/dist/tool ]' },
    ],
  }),
  // moon 1.x: "Fixed a regression that didn't allow identifiers to start
  // with a non-alphanumeric character."
  defineCase({
    id: 'config/task-name-starting-with-underscore',
    category: 'config',
    kind: 'correctness',
    title: 'A task named `_prepare` runs when asked for, and a dependsOn naming it runs it first',
    why: 'A leading underscore is a common way to mark a helper task nobody should run by hand, as `_` marks private names in code. It is still a plain name. A tool whose name rules demand a letter or digit first refuses the whole config, or drops the edge and builds before the preparation ran.',
    from: ['cli-task-names', 'reserved-names'],
    workspace: {
      projects: {
        a: {
          tasks: {
            _prepare: {
              command: 'echo prep > prep.txt',
              inputs: ['src/**'],
              outputs: ['prep.txt'],
            },
            build: {
              command: 'mkdir -p dist && cat prep.txt src/a.txt > dist/out.txt',
              dependsOn: ['_prepare'],
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
        expect: {
          exit: 0,
          ran: ['a#_prepare', 'a#build'],
          order: [['a#_prepare', 'a#build']],
          files: { [out('a')]: 'prep\na\n' },
        },
      },
      { run: '_prepare', expect: { exit: 0, notRan: ['a#build'] } },
    ],
  }),

  // turborepo #12540 "Validate engine concurrency after task-level
  // filtering": servers outside the run counted against the limit.
  defineCase({
    id: 'graph/unselected-servers-do-not-count-against-concurrency',
    category: 'graph',
    kind: 'correctness',
    title:
      'Starting one project’s dev server at a concurrency of 2 works, though three projects have one',
    why: 'Every app in a monorepo has a `dev` task, and a developer starts the one they work on. The servers of the other apps are not in the run, so they take no slot. A tool that counts every declared server against the limit refuses the run, or asks for a concurrency the run never needs.',
    from: ['run-concurrency', 'persistent'],
    needs: ['persistent'],
    workspace: {
      projects: Object.fromEntries(
        ['app', 'web', 'api'].map((name) => [
          name,
          { tasks: { dev: { command: 'touch up; sleep 60', persistent: true } } },
        ]),
      ),
    },
    steps: [
      {
        run: 'dev',
        projects: ['app'],
        concurrency: 2,
        stop: { signal: 'SIGINT', when: 'packages/app/up' },
        expect: {
          files: { 'packages/app/up': '', 'packages/web/up': null, 'packages/api/up': null },
          within: 20,
          alone: true,
        },
      },
    ],
  }),
] as Case[]

// vx fails these; each is a vx bug, not a wrong case (see the comment above it).
export const pending: Case[] = [
  // nx #37836 "depend on the project a link: dependency points into".
  // vx: `vx lock` stops with "bun.lock is out of date: it does not list
  // packages/app's dependency on lib", though bun.lock lists `"lib":
  // "link:../lib"` under packages/app and `"app/lib": ["lib@link:./packages/lib"]`.
  defineCase({
    id: 'graph/link-dependency-on-a-workspace-package-builds-it-first',
    category: 'graph',
    kind: 'correctness',
    title: 'A project that names a workspace package as `link:../lib` builds after it',
    why: 'Some repositories point at a sibling package by path, `link:../lib`, instead of `workspace:*`, often left over from before the workspace existed. The install still links the sibling, and the app imports its build. A tool that draws edges only from `workspace:` versions misses this one, and builds the app before the library or against its old output.',
    from: ['package-graph', 'vx-lockfile/file-dir-dep'],
    needs: ['package-manager'],
    workspace: {
      projects: {
        lib: chainProject('lib'),
        app: { tasks: { build: chainBuild(['lib']) }, files: { 'src/a.txt': 'app\n' } },
      },
    },
    steps: [
      {
        write: {
          'packages/app/package.json': JSON.stringify(
            { name: 'app', version: '0.0.0', private: true, dependencies: { lib: 'link:../lib' } },
            null,
            2,
          ),
        },
      },
      // The manifest is written again, so a tool that keeps its scripts there gets them back.
      { configure: (ws) => ws },
      { install: true },
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
]
