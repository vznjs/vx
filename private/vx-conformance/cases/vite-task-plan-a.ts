// Outcomes drawn from Vite Task's task-plan snapshots (batch A): edges
// named twice, explicit edges chained across projects, a negated directory
// with a trailing slash, non-ASCII commands and args, and excludes alone.
import { defineCase, type ProjectSpec, type TaskSpec, type WorkspaceSpec } from '../src/spec.ts'
import { out } from './shapes.ts'

/** Writes a mark of its own to dist/<name>.txt. */
const mark = (name: string, dependsOn: string[] = [], extra: Partial<TaskSpec> = {}): TaskSpec => ({
  command: `mkdir -p dist && echo ${name} > dist/${name}.txt`,
  inputs: ['src/**'],
  outputs: [`dist/${name}.txt`],
  ...(dependsOn.length > 0 ? { dependsOn } : {}),
  ...extra,
})

const proj = (tasks: Record<string, TaskSpec>, deps: string[] = []): ProjectSpec => ({
  deps,
  tasks,
  files: { 'src/a.txt': 'x\n' },
})

/** app → lib → core, cli → core, and utils alone; every project checks its own source. */
const filtered = (): WorkspaceSpec => {
  const check = (deps: string[] = []): ProjectSpec => ({
    deps,
    tasks: { check: { command: 'true', inputs: ['src/**'] } },
    files: { 'src/a.txt': 'x\n' },
  })
  return {
    projects: {
      app: check(['lib', 'utils']),
      lib: check(['core']),
      cli: check(['core']),
      core: check(),
      utils: check(),
    },
  }
}

const ALL = ['app', 'lib', 'cli', 'core', 'utils']

export default [
  defineCase({
    id: 'graph/caret-and-explicit-edge-run-once',
    category: 'graph',
    kind: 'correctness',
    title: 'A dependency reached by `^build` and by `b#build` builds once, first',
    why: 'Naming one task twice, once through the package graph and once by its full name, asks for the same work twice. It must run once and finish before the task that needs it. Two runs of it waste time and can rewrite its output while the dependant reads it; dropping either edge can start the dependant early.',
    from: ['task-graph', 'task-graph-properties'],
    workspace: {
      projects: {
        b: {
          tasks: {
            build: {
              command: 'mkdir -p dist && cat src/a.txt > dist/out.txt',
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'b\n' },
        },
        a: {
          deps: ['b'],
          tasks: {
            build: {
              command: 'mkdir -p dist && cat ../b/dist/out.txt src/a.txt > dist/out.txt',
              dependsOn: ['^build', 'b#build'],
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
        projects: ['a'],
        expect: {
          exit: 0,
          ran: ['b#build', 'a#build'],
          order: [['b#build', 'a#build']],
          files: { [out('a')]: 'b\na\n' },
        },
      },
      // The marks hold one start per execution; a second b#build would fail the run's once-only check.
    ],
  }),

  defineCase({
    id: 'graph/explicit-edges-chain-across-projects',
    category: 'graph',
    kind: 'correctness',
    title: 'Explicit `project#task` edges chain: each one’s own edges run first, and nothing else',
    why: 'An explicit edge names a task, and that task brings its own dependsOn with it. deploy needs utils#lint, which needs core#build and utils#build, so all of them run first, in that order. A runner that follows only the first hop lints against a core that was never built; one that pulls in core#clean or the tests runs work nobody named.',
    from: ['task-graph', 'task-edge-selection'],
    workspace: {
      projects: {
        core: proj({
          build: mark('build'),
          clean: mark('clean'),
          test: mark('test'),
          lint: mark('lint', ['core#clean']),
        }),
        utils: proj(
          {
            build: mark('build'),
            test: mark('test'),
            lint: mark('lint', ['core#build', 'utils#build']),
          },
          ['core'],
        ),
        app: proj(
          {
            build: mark('build'),
            test: mark('test'),
            deploy: mark('deploy', ['app#build', 'app#test', 'utils#lint'], { cache: false }),
          },
          ['utils'],
        ),
      },
    },
    steps: [
      {
        run: 'deploy',
        expect: {
          exit: 0,
          ran: ['app#build', 'app#test', 'utils#lint', 'core#build', 'utils#build', 'app#deploy'],
          notRan: ['core#clean', 'core#lint', 'core#test', 'utils#test'],
          order: [
            ['core#build', 'utils#lint'],
            ['utils#build', 'utils#lint'],
            ['utils#lint', 'app#deploy'],
            ['app#build', 'app#deploy'],
            ['app#test', 'app#deploy'],
          ],
          files: { 'packages/core/dist/clean.txt': null },
        },
      },
    ],
  }),

  defineCase({
    id: 'inputs/negated-trailing-slash-directory',
    category: 'inputs',
    kind: 'efficiency',
    title:
      'A negation with a trailing slash, `!src/gen/`, takes that directory’s tree out of the key',
    why: 'A trailing slash only says the path is a directory: `!src/gen/` takes back every file under it, as `src/` keys every file under src. Read as a bare pattern, it matches nothing and the generated files stay in the key. Each regeneration then reruns a task the user excluded them from, while edits outside it must still rerun.',
    from: ['inputs-resolution'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command: 'mkdir -p dist && cat src/a.txt > dist/out.txt',
              inputs: ['src/', '!src/gen/'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'a\n', 'src/gen/deep/g.txt': 'g\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { write: { 'packages/a/src/gen/deep/g.txt': 'g2\n' } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'], files: { [out('a')]: 'a\n' } } },
      { write: { 'packages/a/src/a.txt': 'a2\n' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'a2\n' } } },
    ],
  }),

  defineCase({
    id: 'cache/non-ascii-command-edit-reruns',
    category: 'cache',
    kind: 'correctness',
    title:
      'A command of multi-byte characters runs byte-exact, and changing its last character runs it again',
    why: 'A command is text of any script, and `echo ああ` must print exactly that. A runner that counts characters as bytes cuts the command inside a character or drops its tail, so the shell runs something else, or two commands differing only at the end share one key. The edit then replays the old output under a green run.',
    from: ['task-hash-derive', 'forward-args-verbatim'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command:
                'mkdir -p dist && echo ああ > dist/out.txt && FOO=é sh -c \'echo "$FOO" 🎉 done\' >> dist/out.txt',
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
        expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'ああ\né 🎉 done\n' } },
      },
      { write: { 'packages/a/dist': null } },
      {
        run: 'build',
        expect: { exit: 0, notRan: ['a#build'], files: { [out('a')]: 'ああ\né 🎉 done\n' } },
      },
      {
        configure: (ws) => ({
          ...ws,
          projects: {
            a: {
              ...ws.projects['a']!,
              tasks: {
                build: {
                  command:
                    'mkdir -p dist && echo ああ > dist/out.txt && FOO=é sh -c \'echo "$FOO" 🎉 dona\' >> dist/out.txt',
                  inputs: ['src/**'],
                  outputs: ['dist/**'],
                },
              },
            },
          },
        }),
      },
      {
        run: 'build',
        expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'ああ\né 🎉 dona\n' } },
      },
      {
        configure: (ws) => ({
          ...ws,
          projects: {
            a: {
              ...ws.projects['a']!,
              tasks: {
                build: {
                  command:
                    'mkdir -p dist && echo あい > dist/out.txt && FOO=é sh -c \'echo "$FOO" 🎉 dona\' >> dist/out.txt',
                  inputs: ['src/**'],
                  outputs: ['dist/**'],
                },
              },
            },
          },
        }),
      },
      {
        run: 'build',
        expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'あい\né 🎉 dona\n' } },
      },
    ],
  }),

  defineCase({
    id: 'cache/non-ascii-args-forwarded-and-keyed',
    category: 'cache',
    kind: 'correctness',
    title:
      'A forwarded arg of multi-byte characters reaches the command byte-exact and keys the task',
    why: 'Args forwarded to a task are its input as much as its files are. An emoji must reach the command as the same bytes the user typed, and a different emoji is a different run. A runner that mangles or truncates the arg feeds the command something else, or replays the result of one arg for another.',
    from: ['forward-args-verbatim', 'task-hash-derive'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command: `mkdir -p dist && printf '<%s>' "$@" > dist/out.txt`,
              takesArgs: true,
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
        args: ['🎉'],
        expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: '<🎉>' } },
      },
      {
        run: 'build',
        args: ['🎊'],
        expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: '<🎊>' } },
      },
      {
        run: 'build',
        args: ['ああ'],
        expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: '<ああ>' } },
      },
      { run: 'build', args: ['🎉'], expect: { exit: 0, files: { [out('a')]: '<🎉>' } } },
    ],
  }),

  defineCase({
    id: 'graph/select-two-excludes',
    category: 'graph',
    kind: 'correctness',
    title: 'Two excludes alone each take their project out of every project',
    why: 'An exclude given with no include takes from the whole workspace, and a second exclude takes from that same set. A runner that lets the second exclude replace the first, or reads it as an include, runs a project the user ruled out. That can be the slow or broken project the excludes were there to skip.',
    from: ['filter', 'filter-properties'],
    needs: ['filter'],
    workspace: filtered(),
    steps: [
      {
        run: 'check',
        select: [
          { name: 'app', exclude: true },
          { name: 'core', exclude: true },
        ],
        expect: {
          exit: 0,
          ran: ['lib#check', 'cli#check', 'utils#check'],
          notRan: ['app#check', 'core#check'],
        },
      },
    ],
  }),

  defineCase({
    id: 'graph/select-exclude-matching-nothing',
    category: 'graph',
    kind: 'correctness',
    title: 'An exclude alone that names no project runs every project, or refuses',
    why: 'Excluding a project that does not exist leaves the whole workspace: nothing was taken out. Refusing the run as a likely typo is also fair, before anything starts. Running nothing and exiting 0 is not: CI goes green having checked no project at all.',
    from: ['filter', 'filter-properties'],
    needs: ['filter'],
    workspace: filtered(),
    steps: [
      {
        run: 'check',
        select: [{ name: 'nonexistent', exclude: true }],
        expect: { exit: 0, ran: ALL.map((p) => `${p}#check`), orRefused: true },
      },
    ],
  }),
]
