// Inputs and outputs anchored at the workspace root (a shared config, a
// sibling project's data, a generated file at the top), and what a task's
// key carries to the tasks that depend on it.
import { defineCase, type ProjectSpec, type TaskSpec } from '../src/spec.ts'
import { out } from './shapes.ts'

/** Project `a`'s cached build: its `src/**` and `rootInputs`, copying `read` into dist/out.txt. */
function readsRoot(rootInputs: string[], read: string, extra: Partial<TaskSpec> = {}): TaskSpec {
  return {
    command: `mkdir -p dist && cat ${read} > dist/out.txt`,
    inputs: ['src/**'],
    rootInputs,
    outputs: ['dist/**'],
    ...extra,
  }
}

/** The harness's root .gitignore, plus `extra`. */
const ignoring = (...extra: string[]): string =>
  ['node_modules', '.home', '.ran', '.turbo', '.nx', '.vx/cache', 'dist', ...extra, ''].join('\n')

const a = (task: TaskSpec, files: Record<string, string> = {}): ProjectSpec => ({
  tasks: { build: task },
  files: { 'src/a.txt': 'a\n', ...files },
})

/** b#build depends on a#gen and copies src/gen.txt, which gen writes and git ignores. */
function genThenBuild(gen: TaskSpec): Record<string, ProjectSpec> {
  return {
    a: { tasks: { gen } },
    b: {
      tasks: {
        build: {
          command: 'cat src/gen.txt > out.txt',
          dependsOn: ['a#gen'],
          inputs: ['src/**'],
          outputs: ['out.txt'],
        },
      },
      files: { 'src/.keep': '', '.gitignore': 'out.txt\nsrc/gen.txt\n' },
    },
  }
}

export default [
  defineCase({
    id: 'inputs/root-file-input',
    category: 'inputs',
    kind: 'correctness',
    title: 'Editing a declared file at the workspace root runs the task again',
    from: ['workspace-files'],
    workspace: {
      projects: { a: a(readsRoot(['shared/**'], '../../shared/cfg.txt')) },
      files: { 'shared/cfg.txt': 'v1\n' },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'shared/cfg.txt': 'v2\n' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'v2\n' } } },
    ],
  }),

  defineCase({
    id: 'inputs/root-input-undeclared-file',
    category: 'inputs',
    kind: 'efficiency',
    title: 'A root file no root input names changes nothing',
    from: ['workspace-files'],
    workspace: {
      projects: {
        a: a(readsRoot(['shared/**'], '../../shared/cfg.txt')),
        b: { files: { 'data/d.txt': 'v1\n' } },
      },
      files: { 'shared/cfg.txt': 'v1\n', 'other.txt': 'o\n' },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/b/data/d.txt': 'v2\n', 'other.txt': 'o2\n' } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
    ],
  }),

  defineCase({
    id: 'inputs/root-input-into-sibling-project',
    category: 'inputs',
    kind: 'correctness',
    title: 'A root input reaching into another project’s directory keys that file',
    from: ['workspace-files', 'inputs-resolution'],
    workspace: {
      projects: {
        a: a(readsRoot(['packages/b/data/**'], '../b/data/d.txt')),
        b: { files: { 'data/d.txt': 'v1\n' } },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/b/data/d.txt': 'v2\n' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'v2\n' } } },
    ],
  }),

  defineCase({
    id: 'inputs/root-input-gitignored',
    category: 'inputs',
    kind: 'efficiency',
    title: 'A gitignored file under a root input glob changes nothing',
    from: ['workspace-files'],
    workspace: {
      projects: { a: a(readsRoot(['shared/**'], '../../shared/cfg.txt')) },
      files: {
        'shared/cfg.txt': 'v1\n',
        'shared/ignored.txt': 'one\n',
        'shared/.gitignore': 'ignored.txt\n',
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'shared/ignored.txt': 'two\n' } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
    ],
  }),

  defineCase({
    id: 'inputs/root-input-negation',
    category: 'inputs',
    kind: 'efficiency',
    title: 'A `!` root input takes a root file back',
    from: ['workspace-files'],
    workspace: {
      projects: {
        a: a(readsRoot(['shared/**', '!shared/config.json'], '../../shared/extra.json')),
      },
      files: { 'shared/config.json': '{}', 'shared/extra.json': '{}' },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'shared/config.json': '{"a":1}' } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
    ],
  }),

  defineCase({
    id: 'inputs/root-input-bare-directory',
    category: 'inputs',
    kind: 'correctness',
    title: 'A root input naming a directory keys every file in its tree',
    from: ['workspace-files', 'inputs-resolution'],
    workspace: {
      projects: { a: a(readsRoot(['shared'], '../../shared/deep/x.txt')) },
      files: { 'shared/deep/x.txt': 'v1\n' },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'shared/deep/x.txt': 'v2\n' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'v2\n' } } },
    ],
  }),

  defineCase({
    id: 'inputs/root-input-gitignored-named',
    category: 'inputs',
    kind: 'correctness',
    title: 'A gitignored root file named outright in the root inputs is an input',
    why: 'A broad glob skips ignored files; an entry that names one asks for it.',
    from: ['inputs-resolution'],
    workspace: {
      projects: { a: a(readsRoot(['shared-gen.txt'], '../../shared-gen.txt')) },
      files: { 'shared-gen.txt': 'v1\n', '.gitignore': ignoring('shared-gen.txt') },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'shared-gen.txt': 'v2\n' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'v2\n' } } },
    ],
  }),

  defineCase({
    id: 'inputs/root-output-not-own-input',
    category: 'inputs',
    kind: 'efficiency',
    title: 'A root file the task writes is not its own input, though a root input glob covers it',
    why: 'Keying a task on what it wrote moves its key after every run, so it never replays.',
    from: ['workspace-files', 'inputs-resolution'],
    workspace: {
      projects: {
        a: a(
          readsRoot(['shared/**'], '../../shared/cfg.txt', {
            command:
              'mkdir -p dist && cat ../../shared/cfg.txt > dist/out.txt && date +%s%N > ../../shared/gen.txt',
            rootOutputs: ['shared/gen.txt'],
          }),
        ),
      },
      files: { 'shared/cfg.txt': 'v1\n' },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
    ],
  }),

  defineCase({
    id: 'inputs/project-output-not-root-input',
    category: 'inputs',
    kind: 'efficiency',
    title: 'A root input glob over the task’s own project does not key its own outputs',
    from: ['inputs-resolution'],
    workspace: {
      projects: {
        a: a({
          command: 'mkdir -p gen && date +%s%N > gen/stamp.txt',
          inputs: ['src/**'],
          rootInputs: ['packages/a/**'],
          outputs: ['gen/**'],
        }),
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
    ],
  }),

  defineCase({
    id: 'outputs/root-output-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'An output at the workspace root is restored there on a replay',
    from: ['workspace-files'],
    workspace: {
      projects: {
        a: a({
          command:
            'mkdir -p ../../generated && cat src/a.txt > ../../generated/api.txt && echo done > out.txt',
          inputs: ['src/**'],
          outputs: ['out.txt'],
          rootOutputs: ['generated/**'],
        }),
      },
      files: { '.gitignore': ignoring('generated') },
    },
    steps: [
      { run: 'build', expect: { exit: 0, files: { 'generated/api.txt': 'a\n' } } },
      { write: { generated: null } },
      { run: 'build', expect: { exit: 0, files: { 'generated/api.txt': 'a\n' } } },
    ],
  }),

  defineCase({
    id: 'inputs/root-input-escaped-route',
    category: 'inputs',
    kind: 'correctness',
    title: 'A root input `packages/a/app/\\[id\\]/**` keys the route directory named `[id]`',
    from: ['task-glob-brackets'],
    workspace: {
      projects: {
        a: a(readsRoot(['packages/a/app/\\[id\\]/**'], '"app/[id]/page.js"'), {
          'app/[id]/page.js': 'v1\n',
        }),
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/a/app/[id]/page.js': 'v2\n' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'v2\n' } } },
    ],
  }),

  defineCase({
    id: 'inputs/uncached-upstream-env',
    category: 'inputs',
    kind: 'correctness',
    needs: ['env-inputs', 'uncached-task'],
    title: 'A variable keying an uncached dependency reruns its cached dependant when it changes',
    why: 'A task is keyed on its inputs whether it caches or not, and a dependant folds that key.',
    from: ['task-level-inputs'],
    workspace: {
      projects: genThenBuild({
        command: 'echo "api=$API_URL" > ../b/src/gen.txt',
        inputs: [],
        env: ['API_URL'],
        cache: false,
      }),
    },
    steps: [
      {
        run: 'build',
        projects: ['b'],
        env: { API_URL: 'one' },
        expect: { exit: 0, files: { 'packages/b/out.txt': 'api=one\n' } },
      },
      {
        run: 'build',
        projects: ['b'],
        env: { API_URL: 'two' },
        expect: { exit: 0, ran: ['b#build'], files: { 'packages/b/out.txt': 'api=two\n' } },
      },
    ],
  }),

  defineCase({
    id: 'inputs/uncached-upstream-env-unchanged',
    category: 'inputs',
    kind: 'efficiency',
    needs: ['env-inputs', 'uncached-task'],
    title: 'An uncached dependency keyed on an unchanged variable lets its dependant replay',
    from: ['task-level-inputs'],
    workspace: {
      projects: genThenBuild({
        command: 'echo "api=$API_URL" > ../b/src/gen.txt',
        inputs: [],
        env: ['API_URL'],
        cache: false,
      }),
    },
    steps: [
      { run: 'build', projects: ['b'], env: { API_URL: 'two' }, expect: { exit: 0 } },
      {
        run: 'build',
        projects: ['b'],
        env: { API_URL: 'two' },
        expect: { exit: 0, notRan: ['b#build'], files: { 'packages/b/out.txt': 'api=two\n' } },
      },
    ],
  }),

  defineCase({
    id: 'inputs/uncached-upstream-root-file',
    category: 'inputs',
    kind: 'correctness',
    needs: ['uncached-task'],
    title: 'A root file keying an uncached dependency reruns its cached dependant when edited',
    from: ['task-level-inputs'],
    workspace: {
      projects: genThenBuild({
        command: 'cp ../../shared/schema.txt ../b/src/gen.txt',
        inputs: [],
        rootInputs: ['shared/schema.txt'],
        cache: false,
      }),
      files: { 'shared/schema.txt': 'SCHEMA1\n' },
    },
    steps: [
      { run: 'build', projects: ['b'], expect: { exit: 0 } },
      { write: { 'shared/schema.txt': 'SCHEMA2\n' } },
      { commit: 's2' },
      {
        run: 'build',
        projects: ['b'],
        expect: { exit: 0, ran: ['b#build'], files: { 'packages/b/out.txt': 'SCHEMA2\n' } },
      },
    ],
  }),

  defineCase({
    id: 'inputs/uncached-upstream-unlisted-file',
    category: 'inputs',
    kind: 'correctness',
    needs: ['uncached-task'],
    title:
      'An uncached dependency that lists no inputs never lets its dependant replay a stale result',
    why: 'Nothing says what the dependency read, so its key is unknown, not unchanged: a default guess misses the root file it copies.',
    from: ['task-level-inputs'],
    workspace: {
      projects: genThenBuild({
        command: 'cp ../../shared/schema.txt ../b/src/gen.txt',
        cache: false,
      }),
      files: { 'shared/schema.txt': 'SCHEMA1\n' },
    },
    steps: [
      { run: 'build', projects: ['b'], expect: { exit: 0 } },
      { write: { 'shared/schema.txt': 'SCHEMA2\n' } },
      { commit: 's2' },
      {
        run: 'build',
        projects: ['b'],
        expect: { exit: 0, files: { 'packages/b/out.txt': 'SCHEMA2\n' } },
      },
    ],
  }),

  defineCase({
    id: 'inputs/uncached-upstream-empty-inputs',
    category: 'inputs',
    kind: 'efficiency',
    needs: ['uncached-task'],
    title: 'An uncached dependency declaring empty inputs lets its dependant replay',
    why: 'Empty inputs is a declaration: the dependency is keyed on its command alone.',
    from: ['task-level-inputs'],
    workspace: {
      projects: genThenBuild({
        command: 'cp ../../shared/schema.txt ../b/src/gen.txt',
        inputs: [],
        cache: false,
      }),
      files: { 'shared/schema.txt': 'SCHEMA1\n' },
    },
    steps: [
      { run: 'build', projects: ['b'], expect: { exit: 0 } },
      { run: 'build', projects: ['b'], expect: { exit: 0, notRan: ['b#build'] } },
    ],
  }),

  defineCase({
    id: 'inputs/same-project-dependency-key',
    category: 'inputs',
    kind: 'correctness',
    title: 'A file keying a same-project dependency reruns the task that depends on it',
    why: 'The dependant reads nothing of the dependency’s inputs itself; only the dependency’s key can carry the change.',
    from: ['keyed-group-config'],
    workspace: {
      projects: {
        a: {
          tasks: {
            fixtures: {
              command: 'mkdir -p gen && cat fixtures/one.json > gen/f.json',
              inputs: ['fixtures/**'],
              outputs: ['gen/**'],
            },
            test: {
              command: 'mkdir -p dist && cat gen/f.json > dist/out.txt',
              dependsOn: ['fixtures'],
              inputs: ['package.json'],
              outputs: ['dist/**'],
            },
          },
          files: {
            'fixtures/one.json': '1\n',
            'fixtures.txt': 'outside\n',
            '.gitignore': 'gen/\n',
          },
        },
      },
    },
    steps: [
      { run: 'test', expect: { exit: 0 } },
      { write: { 'packages/a/fixtures/one.json': '2\n' } },
      { run: 'test', expect: { exit: 0, ran: ['a#test'], files: { [out('a')]: '2\n' } } },
    ],
  }),

  defineCase({
    id: 'inputs/same-project-dependency-outside',
    category: 'inputs',
    kind: 'efficiency',
    title: 'A file outside a same-project dependency’s inputs does not rerun its dependant',
    from: ['keyed-group-config'],
    workspace: {
      projects: {
        a: {
          tasks: {
            fixtures: {
              command: 'mkdir -p gen && cat fixtures/one.json > gen/f.json',
              inputs: ['fixtures/**'],
              outputs: ['gen/**'],
            },
            test: {
              command: 'mkdir -p dist && cat gen/f.json > dist/out.txt',
              dependsOn: ['fixtures'],
              inputs: ['package.json'],
              outputs: ['dist/**'],
            },
          },
          files: {
            'fixtures/one.json': '1\n',
            'fixtures.txt': 'outside\n',
            '.gitignore': 'gen/\n',
          },
        },
      },
    },
    steps: [
      { run: 'test', expect: { exit: 0 } },
      { write: { 'packages/a/fixtures.txt': 'edited\n' } },
      { run: 'test', expect: { exit: 0, notRan: ['a#fixtures', 'a#test'] } },
    ],
  }),

  defineCase({
    id: 'inputs/committed-file-under-running-output',
    category: 'inputs',
    kind: 'correctness',
    title:
      'A committed file another task declares as its output stays readable while that task runs',
    why: 'A tool that clears a task’s outputs before running it must not delete a committed file a parallel task reads.',
    from: ['cleaned-tracked-reader'],
    workspace: {
      projects: {
        metadata: {
          tasks: {
            build: {
              command: 'sleep 1 && echo v2 > index.json',
              inputs: ['src.txt'],
              outputs: ['index.json'],
            },
          },
          files: { 'src.txt': 's', 'index.json': 'v1\n' },
        },
        core: {
          tasks: {
            build: {
              command: 'sleep 0.3 && cat ../metadata/index.json > out.txt',
              inputs: ['src.txt'],
              outputs: ['out.txt'],
            },
          },
          files: { 'src.txt': 's', '.gitignore': 'out.txt\n' },
        },
      },
    },
    steps: [
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['metadata#build', 'core#build'],
          files: { 'packages/metadata/index.json': 'v2\n' },
        },
      },
    ],
  }),
]
