// What a task's command runs in: its environment, its shell, the directory
// the runner was started from, and the args a run forwards to it.
import { defineCase, type TaskSpec, type WorkspaceSpec } from '../src/spec.ts'
import { chainProject, one, out } from './shapes.ts'

const keyed: TaskSpec = {
  command: 'mkdir -p dist && printf "%s\\n" "${MODE-unset}" > dist/out.txt',
  inputs: ['src/**'],
  env: ['MODE'],
  outputs: ['dist/**'],
}

/** `one(keyed)` with extra workspace-root files. */
function withRoot(files: Record<string, string>): WorkspaceSpec {
  return { ...one(keyed), files }
}

/** lib ← app, each build reading its dependencies' builds. */
const libApp = (): WorkspaceSpec => ({
  projects: { lib: chainProject('lib'), app: chainProject('app', ['lib']) },
})

/** Prints each forwarded arg as `<arg>` into args.txt. */
const show: TaskSpec = {
  command: `printf '<%s>' "$@" > args.txt`,
  takesArgs: true,
  cache: false,
}
const shown = (args: string[]) => args.map((a) => `<${a}>`).join('')

function argsCase(id: string, title: string, why: string, args: string[]) {
  return defineCase({
    id: `env/${id}`,
    category: 'env',
    kind: 'correctness',
    title,
    why,
    from: ['forward-args-verbatim'],
    needs: ['uncached-task'],
    workspace: { projects: { a: { tasks: { show } } } },
    steps: [
      {
        run: 'show',
        projects: ['a'],
        args,
        expect: { exit: 0, ran: ['a#show'], files: { 'packages/a/args.txt': shown(args) } },
      },
    ],
  })
}

/** A workspace project `fakesh` whose package ships bins named `sh` and `own-tool`; `a` depends on it. */
function shellShadow(task: TaskSpec): WorkspaceSpec {
  return {
    projects: {
      fakesh: {
        files: {
          'package.json': JSON.stringify({
            name: 'fakesh',
            version: '0.0.0',
            private: true,
            bin: { sh: 'sh.sh', 'own-tool': 'tool.sh' },
          }),
          'sh.sh': '#!/bin/sh\necho hijacked\n',
          'tool.sh': '#!/bin/sh\necho tool ran\n',
        },
      },
      a: { deps: ['fakesh'], tasks: { build: task }, files: { 'src/a.txt': 'a\n' } },
    },
  }
}
const binModes = { 'packages/fakesh/sh.sh': 0o755, 'packages/fakesh/tool.sh': 0o755 }

export default [
  defineCase({
    id: 'env/dotenv-not-loaded',
    category: 'env',
    kind: 'correctness',
    title: 'A `.env` file at the workspace root does not set a task’s variable',
    why: 'A task’s environment is the one the shell that started the run gave it. A runner that also reads a `.env` at the root sets values nobody passed, from a file the task never declared. The same command then builds one thing on a laptop that has the file and another on CI that lacks it, and a local secret can end up in a build.',
    from: ['dotenv-isolation'],
    needs: ['env-inputs'],
    workspace: withRoot({ '.env': 'MODE=from-dotenv\n' }),
    steps: [{ run: 'build', expect: { exit: 0, files: { [out('a')]: 'unset\n' } } }],
  }),

  defineCase({
    id: 'env/dotenv-local-and-node-env-not-loaded',
    category: 'env',
    kind: 'correctness',
    title: 'Neither `.env.local` nor the `.env.<NODE_ENV>` file sets a task’s variable',
    why: 'Files such as `.env.local` and `.env.production` are a framework’s convention, not the runner’s. If the runner picks one by `NODE_ENV`, setting one variable silently swaps in a whole file of others. A developer’s local overrides then leak into builds that differ from CI for reasons no config shows. A task that wants these files can load them itself.',
    from: ['dotenv-isolation'],
    needs: ['env-inputs'],
    workspace: withRoot({
      '.env.local': 'MODE=from-local\n',
      '.env.production': 'MODE=from-prod\n',
    }),
    steps: [
      {
        run: 'build',
        env: { NODE_ENV: 'production' },
        expect: { exit: 0, files: { [out('a')]: 'unset\n' } },
      },
    ],
  }),

  defineCase({
    id: 'env/dotenv-in-cwd-not-loaded',
    category: 'env',
    kind: 'correctness',
    title: 'A `.env` in the directory the run starts from does not set a task’s variable',
    why: 'Where a run starts must not change what a task sees. If a `.env` in the current directory were read, the same task run from the root and from inside the project would build two different things. Worse, each could replay the other’s cache entry, since nothing declared says the file was read. The shell’s environment is the only source.',
    from: ['dotenv-isolation', 'member-cwd'],
    needs: ['env-inputs'],
    workspace: {
      projects: {
        a: { tasks: { build: keyed }, files: { 'src/a.txt': 'a\n', '.env': 'MODE=from-dotenv\n' } },
      },
    },
    steps: [
      {
        run: 'build',
        projects: ['a'],
        cwd: 'packages/a',
        expect: { exit: 0, files: { [out('a')]: 'unset\n' } },
      },
    ],
  }),

  defineCase({
    id: 'env/shell-value-beats-dotenv',
    category: 'env',
    kind: 'correctness',
    title: 'With a `.env` present, the value the shell sets is the one the task sees',
    why: 'A value set in the shell is an explicit request for this run; a file on disk is not. If a `.env` overrode it, `MODE=from-shell` on the command line would be silently ignored. CI jobs that set variables per job would build with whatever a committed or leftover `.env` says. The explicit value must win, whether or not the runner reads `.env` at all.',
    from: ['dotenv-isolation'],
    needs: ['env-inputs'],
    workspace: withRoot({ '.env': 'MODE=from-dotenv\n' }),
    steps: [
      {
        run: 'build',
        env: { MODE: 'from-shell' },
        expect: { exit: 0, files: { [out('a')]: 'from-shell\n' } },
      },
    ],
  }),

  defineCase({
    id: 'env/dotenv-edit-not-stale',
    category: 'env',
    kind: 'correctness',
    title: 'Editing a `.env` never replays a result built from its old value',
    why: 'Whatever a runner does with `.env`, it must not replay a result built from a value that has since changed. A runner that loads `.env` into a declared variable has made the file an input, so its key must change when the file does. Otherwise an edit to `.env` replays output built for the old value. A runner that never loads the file passes too.',
    from: ['dotenv-isolation'],
    needs: ['env-inputs'],
    workspace: withRoot({ '.env': 'MODE=one\n' }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { '.env': 'MODE=two\n' } },
      { run: 'build', expect: { exit: 0, filesNot: { [out('a')]: 'one\n' } } },
    ],
  }),

  defineCase({
    id: 'env/dependency-bin-on-path',
    category: 'env',
    kind: 'correctness',
    title: 'A bin a project’s dependency ships is on that project’s task PATH',
    why: 'A project that depends on a package expects to call that package’s bins by name, as package scripts do. The package manager links them into the project’s `node_modules/.bin`, and the task’s PATH must include it. Without it the command fails with command not found, or runs a global copy of the tool at a version the lockfile never pinned.',
    from: ['task-shell'],
    workspace: shellShadow({
      command: 'mkdir -p dist && own-tool > dist/out.txt',
      inputs: ['src/**'],
      outputs: ['dist/**'],
    }),
    steps: [
      { chmod: binModes },
      { run: 'build', projects: ['a'], expect: { exit: 0, files: { [out('a')]: 'tool ran\n' } } },
    ],
  }),

  defineCase({
    id: 'env/dependency-sh-not-the-shell',
    category: 'env',
    kind: 'correctness',
    title: 'A dependency shipping a bin named `sh` does not become the shell that runs the command',
    why: 'The task’s PATH decides what the names in its command resolve to, not which shell parses the command. If a dependency’s bin named `sh` became the shell, any package could take over every command of the projects that depend on it. The real command would not run, yet the task could still exit 0. The shell is the runner’s choice, not a PATH lookup.',
    from: ['task-shell'],
    workspace: shellShadow({
      command: 'mkdir -p dist && echo real > dist/out.txt',
      inputs: ['src/**'],
      outputs: ['dist/**'],
    }),
    steps: [
      { chmod: binModes },
      {
        run: 'build',
        projects: ['a'],
        expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'real\n' } },
      },
    ],
  }),

  defineCase({
    id: 'env/path-delimiter-dir-runs-no-relative-bin',
    category: 'env',
    kind: 'correctness',
    title:
      'A project under a directory holding `:` does not run a file the split PATH entry names relative to it',
    why: 'A directory name is data and must not change how PATH is read. Joined into PATH, `packages/x:y/node_modules/.bin` splits in two at the `:`, and the second half is relative, so it resolves against the task’s directory. A file planted at `y/node_modules/.bin` would then run in place of a real tool. A runner must leave out an entry PATH cannot express.',
    from: ['env-path-delimiter'],
    workspace: {
      projects: {
        app: {
          dir: 'packages/x:y',
          tasks: {
            build: {
              command: '(mytool || true) && mkdir -p dist && echo ok > dist/out.txt',
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: {
            'src/a.txt': 'a\n',
            'y/node_modules/.bin/mytool': '#!/bin/sh\necho planted > pwned\n',
          },
        },
        other: chainProject('other'),
      },
    },
    steps: [
      { chmod: { 'packages/x:y/y/node_modules/.bin/mytool': 0o755 } },
      {
        run: 'build',
        expect: {
          exit: 0,
          files: { 'packages/x:y/dist/out.txt': 'ok\n', 'packages/x:y/pwned': null },
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/from-member-dir-runs-upstream',
    category: 'graph',
    kind: 'correctness',
    title: 'Run from inside a project, its dependencies’ tasks still run first',
    why: 'A task’s dependencies are part of the task, wherever the run starts. Developers often run a task from inside the project they work on. If the runner skipped the dependencies there, the task would build against a missing or old dependency output and fail or come out wrong, while the same command from the root works.',
    from: ['member-cwd'],
    workspace: libApp(),
    steps: [
      {
        run: 'build',
        projects: ['app'],
        cwd: 'packages/app',
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
    id: 'inputs/from-member-dir-upstream-change-reruns',
    category: 'inputs',
    kind: 'correctness',
    title: 'Run from inside a project, a change in its dependency runs it again',
    why: 'A task’s key folds in its dependencies, and the directory the run starts from must not change that. Run from inside the project, a change in a dependency must still reach the task. Otherwise the developer gets a replay built against the old dependency while the same command from the root rebuilds, and tests pass against code that is gone.',
    from: ['member-cwd'],
    workspace: libApp(),
    steps: [
      { run: 'build', projects: ['app'], cwd: 'packages/app', expect: { exit: 0 } },
      { write: { 'packages/lib/src/a.txt': 'lib2\n' } },
      {
        run: 'build',
        projects: ['app'],
        cwd: 'packages/app',
        expect: { exit: 0, ran: ['app#build'], files: { [out('app')]: 'lib2\napp\n' } },
      },
    ],
  }),

  defineCase({
    id: 'outputs/from-subdir-restores-at-each-project',
    category: 'outputs',
    kind: 'correctness',
    title: 'A replay started from a project’s subdirectory restores each output at its own project',
    why: 'Outputs belong to their project, and the directory a run starts from changes none of their paths. A replay that restored relative to the current directory would write `dist` into `packages/app/src` and leave the real `dist` missing. The next step, a bundle or a deploy, would then read nothing or old files while the run reported success.',
    from: ['member-cwd'],
    workspace: libApp(),
    steps: [
      { run: 'build', projects: ['app'], expect: { exit: 0 } },
      { write: { 'packages/app/dist': null, 'packages/lib/dist': null } },
      {
        run: 'build',
        projects: ['app'],
        cwd: 'packages/app/src',
        expect: {
          exit: 0,
          files: {
            [out('app')]: 'lib\napp\n',
            [out('lib')]: 'lib\n',
            'packages/app/src/dist/out.txt': null,
          },
          ifReplayed: { task: 'app#build', files: { [out('app')]: 'lib\napp\n' } },
        },
      },
    ],
  }),

  defineCase({
    id: 'cache/from-member-dir-shares-root-cache',
    category: 'cache',
    kind: 'efficiency',
    title: 'A run from inside a project replays what a run from the root stored',
    why: 'A task’s key comes from its inputs, not from where the run started. A run from inside a project asks for the same work as a run from the root, so it should replay what the root run stored. If the current directory leaked into the key, every developer who changes directory would rebuild the same tasks and store the same result twice.',
    from: ['member-cwd'],
    workspace: libApp(),
    steps: [
      { run: 'build', projects: ['app'], expect: { exit: 0, ran: ['lib#build', 'app#build'] } },
      {
        run: 'build',
        projects: ['app'],
        cwd: 'packages/app',
        expect: { exit: 0, notRan: ['lib#build', 'app#build'] },
      },
    ],
  }),

  argsCase(
    'args-flags-verbatim',
    'Forwarded flags reach the command as written, never parsed and rewritten',
    'Forwarded args belong to the command, and the runner passes them through untouched. A runner that parses flags and writes them back merges repeated flags, re-cases `--fooBar`, and casts `0010` to `10`. The tool then gets a different request from the one typed, and fails or behaves differently with no visible cause.',
    [
      '--x',
      '1',
      '--x',
      '2',
      '--no-y',
      '--z=false',
      '--a.b=1',
      '--fooBar',
      '--foo-bar',
      '0010',
      '1e3',
    ],
  ),

  argsCase(
    'args-shell-text-verbatim',
    'An empty arg, spaces, a newline, quotes and `$HOME` each reach the command as one arg, unexpanded',
    'Each forwarded arg must arrive as exactly one arg with its bytes unchanged. If the runner joins args into a shell string, an empty arg vanishes, `sp ace` becomes two args and `$HOME` expands to a path. A test filter or message passed through the runner then means something else, and text such as `&&` can even start a second command.',
    ['', 'sp ace', 'two\nlines', "it's", '"q"', '{"a":1}', '$HOME', '&&', '-'],
  ),

  argsCase(
    'args-runner-flags-verbatim',
    'Forwarded args that look like the runner’s own flags, and an inner `--`, reach the command',
    'Everything after the first `--` belongs to the task, and the runner reads none of it. A runner that still acts on `--filter`, `--all` or `--base` there changes which tasks run, while the tool that should get them never does. The command looks right and does something else. An inner `--` must reach the command too, since many tools give it a meaning.',
    ['--', '--target', 'foo', '--configuration=x', '--base=foo', '--all', '--filter', 'b'],
  ),

  defineCase({
    id: 'env/args-skip-same-named-dependency',
    category: 'env',
    kind: 'correctness',
    title: 'Forwarded args reach the requested task, not its dependency of the same task name',
    why: 'Args are given for the task that was asked for; a dependency was not asked for, only pulled in. If `--x` also reached `b#show`, a flag meant for one project, such as a watch or update-snapshots flag, would change every dependency sharing the task name. Those tasks could fail on an option they do not accept, or write files nobody asked for.',
    from: ['forward-args-verbatim'],
    needs: ['uncached-task'],
    workspace: {
      projects: {
        a: { deps: ['b'], tasks: { show: { ...show, dependsOn: ['^show'] } } },
        b: { tasks: { show } },
      },
    },
    steps: [
      {
        run: 'show',
        projects: ['a'],
        args: ['--x'],
        expect: {
          exit: 0,
          ran: ['a#show', 'b#show'],
          files: { 'packages/a/args.txt': '<--x>', 'packages/b/args.txt': '<>' },
        },
      },
    ],
  }),
]
