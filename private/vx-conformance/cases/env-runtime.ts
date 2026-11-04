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

const DOTENV_WHY =
  'The run’s environment is the one the shell gave it: a file the task never declares reading sets a value no one passed, decided by where the runner happens to look.'

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

function argsCase(id: string, title: string, args: string[], why?: string) {
  return defineCase({
    id: `env/${id}`,
    category: 'env',
    kind: 'correctness',
    title,
    ...(why ? { why } : {}),
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
    why: DOTENV_WHY,
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
    why: DOTENV_WHY,
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
    why: DOTENV_WHY,
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
    why: 'A runner that loads `.env` into a declared variable must key on it; one that does not load it is right too.',
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
    why: 'The task’s PATH decides what its command resolves, not which shell parses the command.',
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
    why: 'Its `node_modules/.bin` joined into PATH splits in two at the `:`; the second half is relative, so it resolves against the task’s directory.',
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
    why: 'Outputs belong to their project; the directory the run starts from changes none of their paths.',
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
    'A runner that parses forwarded flags and writes them back merges repeats, re-cases names, and casts `0010` to `10`.',
  ),

  argsCase(
    'args-shell-text-verbatim',
    'An empty arg, spaces, a newline, quotes and `$HOME` each reach the command as one arg, unexpanded',
    ['', 'sp ace', 'two\nlines', "it's", '"q"', '{"a":1}', '$HOME', '&&', '-'],
  ),

  argsCase(
    'args-runner-flags-verbatim',
    'Forwarded args that look like the runner’s own flags, and an inner `--`, reach the command',
    ['--', '--target', 'foo', '--configuration=x', '--base=foo', '--all', '--filter', 'b'],
    'Everything after the first `--` belongs to the task: the runner reads none of it.',
  ),

  defineCase({
    id: 'env/args-skip-same-named-dependency',
    category: 'env',
    kind: 'correctness',
    title: 'Forwarded args reach the requested task, not its dependency of the same task name',
    why: 'The args were given for the task asked for; the dependency was not asked for, only pulled in.',
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
