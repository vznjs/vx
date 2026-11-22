// Run modes drawn from the rivals' own tests: Turborepo's watch_test.rs
// (watch_file_change_reruns_affected_package), Nx's e2e watch.test.ts (should
// detect files created in newly created directories, should watch for global
// workspace file changes) and run.test.ts (readyWhen probes), Nix's
// tests/functional (linux-sandbox.sh, build-dry.sh), moon's exec_test.rs
// (option_forces_cache_to_write_only, retries_on_failure_till_count) and
// dry_run_test.rs of Turborepo. Each case holds one mode to the outcome a
// user of any tool expects from it.
import {
  defineCase,
  type Case,
  type TaskSpec,
  type WatchPhase,
  type WorkspaceSpec,
} from '../src/spec.ts'
import { CONCAT, chainProject, one } from './shapes.ts'

const OUT = 'packages/app/dist/out.txt'
const A = 'packages/a'

const build = (command = CONCAT, extra: Partial<TaskSpec> = {}): TaskSpec => ({
  command,
  inputs: ['src/**'],
  outputs: ['dist/**'],
  ...extra,
})

const app = (files: Record<string, string> = {}, task: Partial<TaskSpec> = {}): WorkspaceSpec => ({
  projects: {
    app: { tasks: { build: build(task.command, task) }, files: { 'src/a.txt': 'a1\n', ...files } },
  },
})

const first: WatchPhase = { expect: { ran: ['app#build'], files: { [OUT]: 'a1\n' } } }

function watch(
  id: string,
  kind: Case['kind'],
  title: string,
  why: string,
  workspace: WorkspaceSpec,
  phases: WatchPhase[],
  from: string[] = ['watch-loop', 'watch-rules'],
): Case {
  return defineCase({
    id: `watch/${id}`,
    category: 'watch',
    kind,
    title,
    why,
    from,
    needs: ['watch'],
    workspace,
    steps: [{ watch: 'build', phases }],
  })
}

/** An isolated build: reads only its inputs, writes only its outputs. */
const iso = (command: string, sandbox: TaskSpec['sandbox'] = {}): TaskSpec =>
  build(command, { sandbox })

function sandboxCase(
  id: string,
  title: string,
  why: string,
  workspace: WorkspaceSpec,
  exit: 0 | 'fail',
  files: Record<string, string | null> = {},
): Case {
  return defineCase({
    id: `sandbox/${id}`,
    category: 'sandbox',
    kind: 'correctness',
    title,
    why,
    from: ['sandbox-grants.unsafe', 'sandbox-hidden-reads.unsafe'],
    needs: ['sandbox'],
    workspace,
    steps: [{ run: 'build', expect: { exit, files } }],
  })
}

export default [
  watch(
    'executable-bit-reruns',
    'correctness',
    'Making a source executable while watching runs the task again',
    'A file’s mode is part of what a task can read: a packager keeps it, a check tests it. A watch that hears only content changes misses a `chmod`, and the output keeps saying the script is not executable.',
    app(
      {},
      {
        command:
          'mkdir -p dist && { cat src/a.txt; test -x src/a.txt && echo x || echo -; } > dist/out.txt',
      },
    ),
    [
      { expect: { ran: ['app#build'], files: { [OUT]: 'a1\n-\n' } } },
      {
        sh: 'chmod +x packages/app/src/a.txt',
        expect: { ran: ['app#build'], files: { [OUT]: 'a1\nx\n' } },
      },
    ],
    ['watch-mode-change', 'watch-loop'],
  ),

  watch(
    'link-retargeted-reruns',
    'correctness',
    'Pointing a source link at another file while watching rebuilds with that file',
    'The task reads through the link, so retargeting it changes what the task reads without writing any file. A watch that hears only file writes never sees it. The output holds the new target’s content.',
    app(
      { 'shared/one.txt': 'one\n', 'shared/two.txt': 'two\n' },
      { command: 'mkdir -p dist && cat src/l.txt > dist/out.txt' },
    ),
    [
      {
        sh: 'ln -sfn ../shared/one.txt packages/app/src/l.txt',
        expect: { ran: ['app#build'], files: { [OUT]: 'one\n' } },
      },
      {
        sh: 'ln -sfn ../shared/two.txt packages/app/src/l.txt',
        expect: { ran: ['app#build'], files: { [OUT]: 'two\n' } },
      },
    ],
    ['watch-symlink-retarget', 'watch-linked-input'],
  ),

  watch(
    'renamed-input-reruns',
    'correctness',
    'Renaming a source while watching rebuilds without the old name',
    'A rename is a delete and a create to the filesystem. The watch must act on both: the old name gone, the new one read. A watch that handles only one side builds with a missing or a doubled file.',
    app({ 'src/b.txt': 'b1\n' }, { command: 'mkdir -p dist && ls src > dist/out.txt' }),
    [
      { expect: { ran: ['app#build'], files: { [OUT]: 'a.txt\nb.txt\n' } } },
      {
        sh: 'mv packages/app/src/b.txt packages/app/src/c.txt',
        expect: { ran: ['app#build'], files: { [OUT]: 'a.txt\nc.txt\n' } },
      },
    ],
  ),

  watch(
    'dot-directory-input-reruns',
    'correctness',
    'Editing a declared input under a dot directory while watching rebuilds',
    'Config often lives under dot directories (`.config`, `.storybook`). A watch that skips hidden directories for speed misses edits there even when the task declares them, and the build keeps the old config.',
    app(
      { '.config/c.txt': 'c1\n' },
      {
        command: 'mkdir -p dist && cat src/a.txt .config/c.txt > dist/out.txt',
        inputs: ['src/**', '.config/**'],
      },
    ),
    [
      { expect: { ran: ['app#build'], files: { [OUT]: 'a1\nc1\n' } } },
      {
        write: { 'packages/app/.config/c.txt': 'c2\n' },
        expect: { ran: ['app#build'], files: { [OUT]: 'a1\nc2\n' } },
      },
    ],
  ),

  watch(
    'chain-bottom-edit-rebuilds-every-link',
    'correctness',
    'An edit at the bottom of a three-project chain while watching rebuilds every link, in order',
    'A change deep in the graph reaches everything built on it. The watch must rebuild the whole chain bottom up, each link after the one below it. Rebuilding only the edited project, or the chain out of order, leaves the top built from stale output.',
    {
      projects: {
        lib: chainProject('lib'),
        mid: chainProject('mid', ['lib']),
        app: chainProject('app', ['mid']),
      },
    },
    [
      { expect: { ran: ['lib#build', 'mid#build', 'app#build'] } },
      {
        write: { 'packages/lib/src/a.txt': 'lib2\n' },
        expect: {
          ran: ['lib#build', 'mid#build', 'app#build'],
          order: [
            ['lib#build', 'mid#build'],
            ['mid#build', 'app#build'],
          ],
          files: { [OUT]: 'lib2\nmid\napp\n' },
        },
      },
    ],
    ['watch-loop', 'watch-loop-members'],
  ),

  watch(
    'two-projects-edited-at-once',
    'correctness',
    'Edits to two unrelated projects at once while watching rebuild both',
    'A search-and-replace touches many projects in one go. Each edited project must rebuild; a watch that handles only the first event of a burst leaves the other stale.',
    { projects: { app: chainProject('app'), docs: chainProject('docs') } },
    [
      { expect: { ran: ['app#build', 'docs#build'] } },
      {
        write: { 'packages/app/src/a.txt': 'app2\n', 'packages/docs/src/a.txt': 'docs2\n' },
        expect: {
          ran: ['app#build', 'docs#build'],
          files: { [OUT]: 'app2\n', 'packages/docs/dist/out.txt': 'docs2\n' },
        },
      },
    ],
  ),

  watch(
    'input-glob-widened-reruns',
    'correctness',
    'Widening a task’s inputs while watching rebuilds with the newly covered files',
    'A config edit that adds a directory to the inputs changes what keys the task and, here, what it reads. The watch must take the new config and rebuild. Keeping the old inputs ignores both the config edit and every later edit to the new directory.',
    app({ 'extra/e.txt': 'e1\n' }, { command: 'mkdir -p dist && cat src/a.txt > dist/out.txt' }),
    [
      first,
      {
        configure: (ws) => ({
          ...ws,
          projects: {
            app: {
              ...ws.projects['app']!,
              tasks: {
                build: build('mkdir -p dist && cat src/a.txt extra/e.txt > dist/out.txt', {
                  inputs: ['src/**', 'extra/**'],
                }),
              },
            },
          },
        }),
        expect: { ran: ['app#build'], files: { [OUT]: 'a1\ne1\n' } },
      },
      {
        write: { 'packages/app/extra/e.txt': 'e2\n' },
        expect: { ran: ['app#build'], files: { [OUT]: 'a1\ne2\n' } },
      },
    ],
    ['watch-loop', 'watch-loop-edits'],
  ),

  watch(
    'deleted-directory-of-inputs-reruns',
    'correctness',
    'Deleting a whole directory of sources while watching rebuilds without it',
    'Removing a feature folder deletes many files under one directory event. The watch must rebuild without them. A watch that hears only file events, not the directory’s removal, keeps the old build.',
    app(
      { 'src/f/x.txt': 'x\n', 'src/f/y.txt': 'y\n' },
      { command: 'mkdir -p dist && find src -type f | sort > dist/out.txt' },
    ),
    [
      { expect: { ran: ['app#build'], files: { [OUT]: 'src/a.txt\nsrc/f/x.txt\nsrc/f/y.txt\n' } } },
      {
        sh: 'rm -rf packages/app/src/f',
        expect: { ran: ['app#build'], files: { [OUT]: 'src/a.txt\n' } },
      },
    ],
  ),

  // linux-sandbox.sh: a build sees its inputs and nothing else of the user's
  sandboxCase(
    'parent-relative-read-fails',
    'An isolated task that reads a workspace file through `../..` fails',
    'A relative path out of the project reaches files the task never declared, such as the root’s config. Isolation that checks only paths under the project lets `../../` through. The read must fail, so the missing input is found now rather than after a stale replay.',
    {
      projects: {
        a: {
          tasks: { build: iso('mkdir -p dist && cat ../../secret.txt > dist/out.txt') },
          files: { 'src/a.txt': 'a\n' },
        },
      },
      files: { 'secret.txt': 's\n' },
    },
    'fail',
  ),

  sandboxCase(
    'root-manifest-read-fails',
    'An isolated task that reads the workspace’s root package.json without declaring it fails',
    'Tools read the root manifest for versions and settings, and it changes often. An isolated task that reads it undeclared would replay a result built from an older manifest. The read must fail until the task declares it.',
    {
      projects: {
        a: {
          tasks: { build: iso('mkdir -p dist && cat ../../package.json > dist/out.txt') },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    'fail',
  ),

  sandboxCase(
    'git-directory-read-fails',
    'An isolated task that reads the repository’s `.git` directory fails',
    'Git’s directory holds every commit, ref and config, and changes on every commit. A task that reads it (a version stamp from `HEAD`) depends on something it never declared, and its result goes stale on the next commit. The read must fail.',
    {
      projects: {
        a: {
          tasks: { build: iso('mkdir -p dist && cat ../../.git/HEAD > dist/out.txt') },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    'fail',
  ),

  sandboxCase(
    'non-dependency-output-read-fails',
    'An isolated task that reads the output of a project it does not depend on fails',
    'Only what a task depends on is ordered before it and keys it. Reading another project’s build output races that project’s task and replays stale bytes when it changes. The read must fail.',
    {
      projects: {
        lib: {
          tasks: { build: build('mkdir -p dist && echo l > dist/out.txt') },
          files: { 'src/a.txt': 'l\n' },
        },
        a: {
          tasks: { build: iso('mkdir -p dist && cat ../lib/dist/out.txt > dist/out.txt') },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    'fail',
  ),

  sandboxCase(
    'granted-write-passes',
    'An isolated task may write a file it is granted beyond its outputs',
    'Some tools insist on writing a log or a lock beside their output, and the user grants that path on purpose. A granted write is a decision, not a leak. Failing it forces isolation off for a task that is otherwise correct.',
    one(
      iso('mkdir -p dist && cat src/a.txt > dist/out.txt && echo log > tool.log', {
        write: ['tool.log'],
      }),
    ),
    0,
    { [`${A}/dist/out.txt`]: 'a\n' },
  ),

  sandboxCase(
    'write-to-other-project-output-fails',
    'An isolated task that writes into another project’s output directory fails',
    'Writing into another project’s `dist` corrupts that project’s cached result: its next replay restores bytes this task overwrote, or keeps them. The write must fail and leave the other project as it was.',
    {
      projects: {
        lib: {
          tasks: { build: build('mkdir -p dist && echo l > dist/out.txt') },
          files: { 'src/a.txt': 'l\n' },
        },
        a: {
          deps: ['lib'],
          tasks: {
            build: iso(
              'mkdir -p dist ../lib/dist && echo x > ../lib/dist/out.txt && echo a > dist/out.txt',
              {},
            ),
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    'fail',
  ),

  sandboxCase(
    'link-written-out-then-read-fails',
    'An isolated task cannot read an undeclared file through a link it creates itself',
    'A task can make a symlink in its own output pointing anywhere, then read through it. Isolation that checks the path the task opened, not where it leads, lets that read through. The read must fail.',
    {
      projects: {
        a: {
          tasks: {
            build: iso('mkdir -p dist && ln -s ../config.txt dist/l && cat dist/l > dist/out.txt'),
          },
          files: { 'src/a.txt': 'a\n', 'config.txt': 'c\n' },
        },
      },
    },
    'fail',
  ),

  sandboxCase(
    'outside-network-refused',
    'An isolated task with no network grant cannot resolve or reach a host outside the machine',
    'A task that downloads during a build depends on a server’s answer, which no key holds. Without a network grant the connection must fail, so the download is found and declared rather than cached as if it were a pure function of the inputs.',
    one(
      iso(
        'mkdir -p dist && { getent hosts example.com || nc -z -w 2 1.1.1.1 80; } && echo reached > dist/out.txt',
      ),
    ),
    'fail',
  ),

  sandboxCase(
    'user-config-hidden',
    'An isolated task cannot read the user’s `~/.npmrc`',
    'A user’s package-manager config holds registry tokens and settings that differ between machines. A task that reads it undeclared builds differently on each machine under one key, and can leak the token into an output. The read must fail.',
    {
      projects: {
        a: {
          tasks: { build: iso('mkdir -p dist && cat "$HOME/.npmrc" > dist/out.txt') },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    'fail',
  ),

  // build-dry.sh: a dry run builds nothing
  defineCase({
    id: 'cache/dry-run-of-a-failing-task-succeeds',
    category: 'cache',
    kind: 'correctness',
    title: 'Planning a run of a task that would fail runs nothing and succeeds',
    why: 'A dry run answers what would run, not whether it would pass. Running the command to find out defeats the point and can have side effects. The plan succeeds, the task’s command never runs, and the real run still fails.',
    from: ['run-option-shapes', 'show-select'],
    needs: ['dry-run'],
    workspace: one(build('exit 1')),
    steps: [
      { run: 'build', dry: true, expect: { exit: 0, notRan: ['a#build'] } },
      { run: 'build', expect: { exit: 'fail' } },
    ],
  }),

  defineCase({
    id: 'cache/dry-run-keeps-existing-outputs',
    category: 'cache',
    kind: 'correctness',
    title: 'Planning a run leaves outputs already on disk as they were',
    why: 'A tool may clear a task’s outputs before running it. A dry run runs nothing, so it must clear nothing either. A plan that wipes `dist` leaves the user with no build after asking only what would run.',
    from: ['run-option-shapes', 'output-wipe-guard'],
    needs: ['dry-run'],
    workspace: one(build()),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/src/a.txt`]: 'b\n' } },
      {
        run: 'build',
        dry: true,
        expect: { exit: 0, notRan: ['a#build'], files: { [`${A}/dist/out.txt`]: 'a\n' } },
      },
    ],
  }),

  defineCase({
    id: 'cache/dry-run-then-real-run-builds',
    category: 'cache',
    kind: 'correctness',
    title: 'A real run after a planned one still builds what changed',
    why: 'A dry run must save nothing, including no record that the task is up to date. A tool that marks the task done while planning makes the next real run replay or skip it. The real run builds the new content.',
    from: ['run-option-shapes', 'run-store'],
    needs: ['dry-run'],
    workspace: one(build()),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/src/a.txt`]: 'b\n' } },
      { run: 'build', dry: true, expect: { exit: 0 } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['a#build'], files: { [`${A}/dist/out.txt`]: 'b\n' } },
      },
    ],
  }),

  // exec_test.rs option_forces_cache_to_write_only
  defineCase({
    id: 'cache/forced-run-of-chain-runs-every-link',
    category: 'cache',
    kind: 'correctness',
    title: 'A forced run of a project runs its dependencies too, past their cache entries',
    why: 'Forcing is how a user rules out the cache when a result looks wrong. A tool that forces only the requested task replays its dependencies, and the suspect could be there. Every task in the run runs.',
    from: ['run-option-shapes', 'cache'],
    needs: ['force'],
    workspace: { projects: { lib: chainProject('lib'), app: chainProject('app', ['lib']) } },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      {
        run: 'build',
        projects: ['app'],
        force: true,
        expect: { exit: 0, ran: ['lib#build', 'app#build'] },
      },
    ],
  }),

  defineCase({
    id: 'cache/read-only-run-keeps-entries',
    category: 'cache',
    kind: 'efficiency',
    title: 'A read-only run leaves the entries already saved, so the next run still replays',
    why: 'Reading the cache without writing it must not prune or replace what is there. A tool that evicts while reading, or marks entries stale, costs the next normal run a rebuild it already paid for. The run after replays.',
    from: ['run-option-shapes', 'cache'],
    needs: ['read-only-cache'],
    workspace: one(build()),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { run: 'build', readOnlyCache: true, expect: { exit: 0, notRan: ['a#build'] } },
      { write: { [`${A}/dist`]: null } },
      {
        run: 'build',
        expect: { exit: 0, notRan: ['a#build'], files: { [`${A}/dist/out.txt`]: 'a\n' } },
      },
    ],
  }),

  defineCase({
    id: 'cache/read-only-miss-saved-by-next-run',
    category: 'cache',
    kind: 'correctness',
    title: 'A task a read-only run built is built and saved by the next normal run',
    why: 'A read-only run saves nothing, so it must also record nothing that makes a later run skip the task. The next normal run must still build it and save it, and the one after replays.',
    from: ['run-option-shapes', 'cache'],
    needs: ['read-only-cache'],
    workspace: one(build()),
    steps: [
      { run: 'build', readOnlyCache: true, expect: { exit: 0, ran: ['a#build'] } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
    ],
  }),

  // exec_test.rs retries_on_failure_till_count
  defineCase({
    id: 'failure/dependant-waits-for-a-retried-dependency',
    category: 'failure',
    kind: 'correctness',
    title:
      'A dependant starts only after its dependency’s retry passes, and builds on that attempt',
    why: 'A flaky dependency that passes on its second attempt is a passing dependency. Its dependant must wait for the attempt that passed, not start when the first one failed, and must read what that attempt wrote. The dependant runs after it and sees the good output.',
    from: ['run-outcome-retry-timeout-properties', 'scheduler'],
    needs: ['retries'],
    workspace: {
      projects: {
        lib: {
          tasks: {
            build: build(
              'mkdir -p dist && if [ -f ../../.home/tried ]; then echo good > dist/out.txt; else touch ../../.home/tried; echo bad > dist/out.txt; exit 1; fi',
              { retries: 1 },
            ),
          },
          files: { 'src/a.txt': 'l\n' },
        },
        app: chainProject('app', ['lib']),
      },
    },
    steps: [
      {
        run: 'build',
        expect: { exit: 0, order: [['lib#build', 'app#build']], files: { [OUT]: 'good\napp\n' } },
      },
    ],
  }),

  defineCase({
    id: 'failure/timed-out-dependency-skips-dependants',
    category: 'failure',
    kind: 'correctness',
    title: 'A dependency killed at its time limit keeps its dependants from running',
    why: 'A timeout is a failure: the dependency never finished, and whatever it wrote is partial. A dependant started on that partial output builds something no successful run would. The run fails and the dependant does not run.',
    from: ['run-outcome-retry-timeout-properties', 'run-failures-store'],
    needs: ['timeout'],
    workspace: {
      projects: {
        lib: {
          tasks: {
            build: build('mkdir -p dist && echo partial > dist/out.txt && sleep 30', {
              timeout: 1,
            }),
          },
          files: { 'src/a.txt': 'l\n' },
        },
        app: chainProject('app', ['lib']),
      },
    },
    steps: [{ run: 'build', expect: { exit: 'fail', notRan: ['app#build'], within: 25 } }],
  }),

  defineCase({
    id: 'failure/each-retry-gets-its-own-time-limit',
    category: 'failure',
    kind: 'correctness',
    title: 'A task that times out once and passes quickly on its retry passes',
    why: 'A time limit bounds one attempt. A retry is a new attempt with the whole limit again. A tool that counts the limit across attempts kills the retry that would have passed. The run passes, and the passing attempt’s output is what is left.',
    from: ['run-outcome-retry-timeout-properties', 'timeout-exit-race.unsafe'],
    needs: ['retries', 'timeout'],
    workspace: one(
      build(
        'mkdir -p dist && if [ -f ../../.home/tried ]; then echo fast > dist/out.txt; else touch ../../.home/tried; sleep 30; fi',
        { retries: 1, timeout: 2 },
      ),
    ),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [`${A}/dist/out.txt`]: 'fast\n' }, within: 25 } },
    ],
  }),

  // run.test.ts readyWhen: a log marker the server prints
  defineCase({
    id: 'graph/ready-line-on-stderr-releases-dependants',
    category: 'graph',
    kind: 'correctness',
    title:
      'A server that prints its ready line on its error stream still releases what waits for it',
    why: 'Many dev servers log to stderr, ready line included. A tool that looks for the line on stdout alone waits forever, and the tasks behind the server never start. The dependant runs once the line appears.',
    from: ['persistent', 'held-server-output'],
    needs: ['persistent', 'ready'],
    workspace: {
      projects: {
        srv: {
          tasks: {
            dev: {
              command: 'echo booting; echo listening >&2; sleep 60',
              persistent: { ready: 'listening' },
              inputs: ['src/**'],
            },
          },
          files: { 'src/a.txt': 's\n' },
        },
        e2e: {
          tasks: {
            test: { command: 'true', dependsOn: ['srv#dev'], inputs: ['src/**'], outputs: [] },
          },
          files: { 'src/a.txt': 'e\n' },
        },
      },
    },
    steps: [
      {
        run: 'test',
        projects: ['e2e'],
        expect: { exit: 0, ran: ['e2e#test'], within: 40, alone: true },
      },
    ],
  }),

  defineCase({
    id: 'graph/ready-line-in-two-writes-releases-dependants',
    category: 'graph',
    kind: 'correctness',
    title: 'A ready line the server writes in two pieces still releases what waits for it',
    why: 'A server’s output arrives in chunks of any size: a line can be split across two writes. A tool that matches each chunk alone misses the line, and the tasks behind the server never start. The dependant runs once the whole line is out.',
    from: ['persistent', 'held-server-output'],
    needs: ['persistent', 'ready'],
    workspace: {
      projects: {
        srv: {
          tasks: {
            dev: {
              command: "printf 'liste'; sleep 0.5; printf 'ning\\n'; sleep 60",
              persistent: { ready: 'listening' },
              inputs: ['src/**'],
            },
          },
          files: { 'src/a.txt': 's\n' },
        },
        e2e: {
          tasks: {
            test: { command: 'true', dependsOn: ['srv#dev'], inputs: ['src/**'], outputs: [] },
          },
          files: { 'src/a.txt': 'e\n' },
        },
      },
    },
    steps: [
      {
        run: 'test',
        projects: ['e2e'],
        expect: { exit: 0, ran: ['e2e#test'], within: 40, alone: true },
      },
    ],
  }),

  // exec_test.rs passes_args_through_when_ran_in_project_root
  defineCase({
    id: 'env/args-reach-task-run-from-its-directory',
    category: 'env',
    kind: 'correctness',
    title: 'Args forwarded to a run started inside a project reach that project’s task',
    why: 'Running from inside a project selects it, and the args after `--` are for its command. A tool that drops them, or parses them as its own flags, runs the task without what the user typed. The command sees each arg.',
    from: ['forward-args-verbatim', 'member-cwd'],
    workspace: one(
      build('mkdir -p dist && printf "%s\\n" "$@" > dist/out.txt', { takesArgs: true }),
    ),
    steps: [
      {
        run: 'build',
        cwd: A,
        args: ['--mode', 'prod'],
        expect: { exit: 0, files: { [`${A}/dist/out.txt`]: '--mode\nprod\n' } },
      },
    ],
  }),
]
