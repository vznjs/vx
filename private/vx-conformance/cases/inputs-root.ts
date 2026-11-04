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
    why: 'Shared files at the workspace root, such as a base config, often shape a task as much as its own sources. A root input says the task reads them. If an edit there kept the old key, every project built from that config would replay output made under the old one.',
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
    why: 'A task is keyed on what it declares, nothing more. A root file no root input names, or another project’s file, is not what this task reads. Keying the whole workspace would rerun every task on any edit anywhere, and the cache would rarely hit. Explicit inputs are what make a hit trustworthy.',
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
    why: 'A root input is a workspace-relative path, and it can point into another project’s directory on purpose, for shared data. The declaration is explicit, so the file is an input. Ignoring it replays output built from the old file, though the user said the task reads it.',
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
    why: 'Ignored files are local state, and a broad root glob such as `shared/**` skips them like any other glob. An ignored scratch file in a shared directory is not part of the config. Keying it reruns tasks on local changes and gives the same commit different keys on different machines.',
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
    why: 'A negated root input takes files back from the root globs, just as a negation does for project inputs. The user said this file does not affect the task. Keying it anyway reruns the task, and every task sharing the glob, whenever the file changes. A negation means the same at the root as anywhere else.',
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
    why: 'A root input naming a directory means every file in its tree, as a project input does. A tool that matches only the directory entry keys nothing inside. Edits deep in the shared directory then replay output built from the old files. Naming a shared directory is the plainest way to say a task reads it.',
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
    why: 'A broad glob skips ignored files, but a root input that names one asks for it. A generated file at the workspace root, ignored by git, can be exactly what the task reads. Skipping it replays a result built from the old content. Explicit config beats the default skip rules.',
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
    why: 'A root input glob can cover a file the same task writes at the root. Keying a task on what it wrote moves its key after every run, so it never replays. Declared outputs must be cut out of the inputs, at the root as in the project. An output is never its own task’s input.',
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
    why: 'A root input over the task’s own project also covers its outputs, here a timestamp it writes. If that file keyed the task, every run would change the key and nothing would ever replay. The task’s declared outputs stay out of its key, whichever glob reaches them.',
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
    why: 'An output declared at the workspace root, such as generated API types, is part of the task’s result. A replay must put it back where the task wrote it. Restoring only the project’s outputs reports a hit while the root file stays missing, and the next step fails or reads an old copy.',
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
    why: 'Escaped brackets in a root input name a literal directory such as `[id]`, as they do in a project input. Read as a class, `\\[id\\]` matches `i` or `d` instead and never the route. Edits to the route then replay output built from the old page. The escape is how a bracketed name is written at all.',
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
    why: 'A task is keyed on its inputs whether it caches or not, and a dependant folds that key into its own. Here the dependency writes a file from `API_URL`. If its key ignored the variable because it never caches, the dependant would replay output built for the old URL.',
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
    why: 'An uncached dependency always runs, but its key is still defined by what it declares. With `API_URL` unchanged, that key is unchanged, so the dependant can replay. Treating every uncached task as changed would rerun its whole downstream tree on every run.',
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
    why: 'An uncached dependency still has a key made of its declared inputs, root files included, and the cached task after it folds that key. Here the dependency copies a shared schema. If its root input were ignored because it does not cache, the dependant would replay output built from the old schema.',
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
    why: 'A task that lists no inputs is not cached: nothing says what it read, so its key is unknown, not unchanged. A default guess misses the root file this dependency copies. A dependant that folds the guess replays output built from the old schema; running it again is the safe answer.',
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
    why: 'Empty inputs is a declaration: the dependency is keyed on its command and config alone. Unlike a task that lists nothing, it states that no file affects it. The dependant can then replay, rather than rerun on every run only because its dependency never caches.',
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
    why: 'A dependency’s key carries its inputs to the tasks after it, inside one project as across projects. Here `test` lists only `package.json` and reads the fixtures through the `fixtures` task’s output. Only that dependency’s key can carry the fixture edit; without it, tests replay against old fixtures.',
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
    why: 'A file outside the dependency’s inputs, like `fixtures.txt` beside `fixtures/`, changes neither the dependency’s key nor the dependant’s. Both should replay. Rerunning on a name that only resembles an input wastes the run. Inputs are matched by path, not by name likeness, and the dependant inherits only the dependency’s key.',
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
    why: 'A tool that clears a task’s outputs before running it must not delete a committed file another task reads in parallel. Here `index.json` is both committed source and a declared output. Deleting it mid-run makes the reader fail or read nothing, a failure that depends on timing and is hard to reproduce.',
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
