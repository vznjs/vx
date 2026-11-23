// Outcomes drawn from Turborepo's Rust integration tests (vercel/turborepo
// crates/turborepo/tests/*.rs) that no earlier case carried: a repository
// that is one package, the root package beside its members, what the root's
// own dependencies key, and a root input seen through a project without the
// task. Each case's comment names the test it ports.
import { defineCase, type Case, type ProjectSpec, type TaskSpec } from '../src/spec.ts'
import { chainProject, out } from './shapes.ts'

const build = (command: string, extra: Partial<TaskSpec> = {}): TaskSpec => ({
  command,
  inputs: ['src/**'],
  outputs: ['dist/**'],
  ...extra,
})

/** A repository that is one package: the root, with no members. */
const single = (tasks: Record<string, TaskSpec>, files: Record<string, string>) => ({
  projects: { app: { dir: '.', tasks, files } satisfies ProjectSpec },
})

const ROOT_BUILD: TaskSpec = {
  command: 'mkdir -p dist && cat tools/*.txt > dist/root.txt',
  dependsOn: ['^build'],
  inputs: ['tools/**'],
  outputs: ['dist/**'],
}

/** The root package depending on `util`, beside `another`, which depends on nothing. */
const rootDeps = () => ({
  projects: {
    root: {
      dir: '.',
      deps: ['util'],
      tasks: { build: ROOT_BUILD },
      files: { 'tools/x.txt': 'root\n' },
    },
    util: chainProject('util'),
    another: chainProject('another'),
  },
})

export default [
  // single_package_run_test.rs test_single_package_build_npm
  defineCase({
    id: 'graph/single-package-repo-runs-and-replays',
    category: 'graph',
    kind: 'correctness',
    title:
      'A repository that is one package, with no workspace members, runs its task and replays it',
    why: 'Plenty of repositories are a single package: a library, a CLI, a site. A task runner must treat the root package as a project when there is nothing else, not refuse it for lacking members. Turborepo runs a separate single-package mode for this. The first run builds, the second replays the stored result.',
    from: ['root-project', 'cache'],
    workspace: single(
      { build: build('mkdir -p dist && cat src/*.txt > dist/out.txt') },
      { 'src/a.txt': 'one\n' },
    ),
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['app#build'], files: { 'dist/out.txt': 'one\n' } } },
      {
        run: 'build',
        expect: { exit: 0, notRan: ['app#build'], files: { 'dist/out.txt': 'one\n' } },
      },
    ],
  }),

  // single_package_with_deps_test.rs test_with_deps_run_and_cache
  defineCase({
    id: 'graph/single-package-own-prerequisite-runs-first',
    category: 'graph',
    kind: 'correctness',
    title:
      'In a one-package repository, a task runs after the task of its own it depends on, and both replay',
    why: 'A single package still has steps that build on each other: a code generator before the build. With no members there is no project graph to lean on, only the task edge. The generator must finish before the build reads what it wrote, and both must be stored, so the next run replays the pair.',
    from: ['root-project', 'graph-order'],
    workspace: single(
      {
        prepare: {
          command: 'mkdir -p gen && cat prep/*.txt > gen/prep.txt',
          inputs: ['prep/**'],
          outputs: ['gen/**'],
        },
        build: build('mkdir -p dist && cat gen/prep.txt src/*.txt > dist/out.txt', {
          dependsOn: ['prepare'],
        }),
      },
      { 'prep/p.txt': 'prep\n', 'src/a.txt': 'one\n' },
    ),
    steps: [
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['app#prepare', 'app#build'],
          order: [['app#prepare', 'app#build']],
          files: { 'dist/out.txt': 'prep\none\n' },
        },
      },
      { write: { 'gen/prep.txt': null, 'dist/out.txt': null } },
      {
        run: 'build',
        expect: {
          exit: 0,
          notRan: ['app#prepare', 'app#build'],
          files: { 'gen/prep.txt': 'prep\n', 'dist/out.txt': 'prep\none\n' },
        },
      },
      { write: { 'prep/p.txt': 'prep 2\n' } },
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['app#prepare', 'app#build'],
          files: { 'dist/out.txt': 'prep 2\none\n' },
        },
      },
    ],
  }),

  // single_package_dry_run_test.rs test_single_package_dry_run
  defineCase({
    id: 'graph/single-package-dry-run-runs-nothing',
    category: 'graph',
    kind: 'correctness',
    title: 'Planning a run in a one-package repository runs nothing and writes nothing',
    why: 'A planned run answers what would run without doing it. In a one-package repository the plan still covers the task and the step before it. Running either one, or writing their outputs, turns a question into a build the user did not ask for. The tree stays as it was.',
    from: ['root-project', 'dry-no-writes'],
    needs: ['dry-run'],
    workspace: single(
      {
        prepare: {
          command: 'mkdir -p gen && cat prep/*.txt > gen/prep.txt',
          inputs: ['prep/**'],
          outputs: ['gen/**'],
        },
        build: build('mkdir -p dist && cat gen/prep.txt src/*.txt > dist/out.txt', {
          dependsOn: ['prepare'],
        }),
      },
      { 'prep/p.txt': 'prep\n', 'src/a.txt': 'one\n' },
    ),
    steps: [
      {
        run: 'build',
        dry: true,
        expect: {
          exit: 0,
          notRan: ['app#prepare', 'app#build'],
          files: { 'gen/prep.txt': null, 'dist/out.txt': null },
        },
      },
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['app#prepare', 'app#build'],
          files: { 'dist/out.txt': 'prep\none\n' },
        },
      },
    ],
  }),

  // single_package_run_test.rs: the build's own inputs key it in single-package mode
  defineCase({
    id: 'inputs/single-package-keys-only-declared-files',
    category: 'inputs',
    kind: 'correctness',
    title:
      'In a one-package repository, an edit outside the task’s inputs replays and an edit inside runs it',
    why: 'When the project is the whole repository, every file of the repository is a file of the project. A tool that keys the root package by everything under it reruns on a README edit. One that keys nothing replays a stale build after a source edit. The declared inputs decide, as they do for a member.',
    from: ['root-project', 'inputs'],
    workspace: single(
      { build: build('mkdir -p dist && cat src/*.txt > dist/out.txt') },
      { 'src/a.txt': 'one\n', 'README.md': 'readme\n' },
    ),
    steps: [
      { run: 'build', expect: { exit: 0, files: { 'dist/out.txt': 'one\n' } } },
      { write: { 'README.md': 'readme 2\n' } },
      { run: 'build', expect: { exit: 0, notRan: ['app#build'] } },
      { write: { 'src/a.txt': 'two\n' } },
      { run: 'build', expect: { exit: 0, ran: ['app#build'], files: { 'dist/out.txt': 'two\n' } } },
    ],
  }),

  // single_package_dry_run_test.rs test_single_package_no_config_run_bypasses_cache
  defineCase({
    id: 'cache/single-package-uncached-task-runs-every-time',
    category: 'cache',
    kind: 'correctness',
    title: 'In a one-package repository, a task marked never cached runs on every run',
    why: 'A task that must not be replayed, a deploy or a check against a live service, is marked so. In a one-package repository that mark must hold as it does for a member. Replaying it skips the very work the user asked to happen each time. Both runs run it.',
    from: ['root-project', 'cache'],
    needs: ['uncached-task'],
    workspace: single(
      { check: { command: 'echo checked >> checks.log', inputs: ['src/**'], cache: false } },
      { 'src/a.txt': 'one\n' },
    ),
    steps: [
      { run: 'check', expect: { exit: 0, ran: ['app#check'] } },
      {
        run: 'check',
        expect: { exit: 0, ran: ['app#check'], files: { 'checks.log': 'checked\nchecked\n' } },
      },
    ],
  }),

  // filter_run_test.rs test_no_filter_includes_root_tasks
  defineCase({
    id: 'graph/whole-run-includes-root-project-task',
    category: 'graph',
    kind: 'correctness',
    title: 'A run with no selection runs the root package’s task beside its members’',
    why: 'The root package is a project too: a repository-wide lint or a docs build often lives there. A run over every project that skips the root leaves that work undone while reporting success. Turborepo’s test pins that an unfiltered run takes the root’s task. Both the root’s and the member’s task run.',
    from: ['root-project', 'filter'],
    workspace: {
      projects: {
        root: {
          dir: '.',
          tasks: { build: { ...ROOT_BUILD, dependsOn: [] } },
          files: { 'tools/x.txt': 'root\n' },
        },
        a: chainProject('a'),
      },
    },
    steps: [
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['root#build', 'a#build'],
          files: { 'dist/root.txt': 'root\n', [out('a')]: 'a\n' },
        },
      },
    ],
  }),

  // filter_run_test.rs test_include_filter_excludes_root_tasks
  defineCase({
    id: 'graph/select-member-leaves-root-project-task',
    category: 'graph',
    kind: 'efficiency',
    title: 'Selecting one member does not run the root package’s task of the same name',
    why: 'The root package holds every member on disk, but it is a project of its own, not their parent in the graph. A selection of `a` asks for `a` and what it depends on. Running the root’s build as well, because its folder holds `a`, does work nobody asked for, and a root build is often the slowest one.',
    from: ['root-project', 'filter'],
    needs: ['filter'],
    workspace: {
      projects: {
        root: {
          dir: '.',
          tasks: { build: { ...ROOT_BUILD, dependsOn: [] } },
          files: { 'tools/x.txt': 'root\n' },
        },
        a: chainProject('a'),
      },
    },
    steps: [
      {
        run: 'build',
        projects: ['a'],
        expect: {
          exit: 0,
          ran: ['a#build'],
          notRan: ['root#build'],
          files: { 'dist/root.txt': null },
        },
      },
    ],
  }),

  // run_caching.rs test_root_deps_caching: `--filter=...util` takes the root
  defineCase({
    id: 'graph/select-dependents-reaches-root-project',
    category: 'graph',
    kind: 'correctness',
    title: 'Selecting a library with its dependents takes the root package that depends on it',
    why: 'A root package that lists a workspace library in its dependencies is that library’s dependent like any member. A walk to dependents that stops at the members leaves out the root’s task, which then misses the library change it reads. The walk takes `util` and the root, and leaves `another`, which uses nothing of `util`.',
    from: ['root-project', 'filter'],
    needs: ['select-walk'],
    workspace: rootDeps(),
    steps: [
      {
        run: 'build',
        select: [{ name: 'util', with: 'dependents' }],
        expect: {
          exit: 0,
          ran: ['util#build', 'root#build'],
          notRan: ['another#build'],
          order: [['util#build', 'root#build']],
        },
      },
    ],
  }),

  // run_caching.rs test_root_deps_caching: the root's dependencies build first
  defineCase({
    id: 'graph/select-root-with-dependencies',
    category: 'graph',
    kind: 'correctness',
    title:
      'Selecting the root package with its dependencies builds the libraries it depends on first',
    why: 'The root package’s dependencies are workspace projects, and a root build that bundles them needs them built. Selecting the root with its dependencies must walk from the root as from any project. It builds `util` before the root and leaves `another`, which the root does not depend on.',
    from: ['root-project', 'filter'],
    needs: ['select-walk'],
    workspace: rootDeps(),
    steps: [
      {
        run: 'build',
        select: [{ name: 'root', with: 'dependencies' }],
        expect: {
          exit: 0,
          ran: ['util#build', 'root#build'],
          notRan: ['another#build'],
          order: [['util#build', 'root#build']],
        },
      },
    ],
  }),

  // run_caching.rs test_root_deps_caching: Turborepo makes the root's
  // dependencies everyone's (`--filter=another...` takes util)
  defineCase({
    id: 'graph/root-dependency-is-not-every-members-dependency',
    category: 'graph',
    kind: 'efficiency',
    title: 'A member that does not depend on a library the root depends on does not build it first',
    why: 'The root package depending on `util` says the root needs `util`, nothing about `another`. Turborepo folds the root’s workspace dependencies into every package, so `another` with its dependencies builds `util` too. That is work the manifests never asked for. Selecting `another` with its dependencies runs `another` alone.',
    from: ['root-project', 'filter'],
    needs: ['select-walk'],
    workspace: rootDeps(),
    steps: [
      {
        run: 'build',
        select: [{ name: 'another', with: 'dependencies' }],
        expect: { exit: 0, ran: ['another#build'], notRan: ['util#build', 'root#build'] },
      },
    ],
  }),

  // run_caching.rs test_root_deps_caching: a root dependency's edit misses every task in Turborepo
  defineCase({
    id: 'inputs/root-dependency-edit-spares-unrelated-member',
    category: 'inputs',
    kind: 'efficiency',
    title:
      'An edit in a library the root depends on reruns the root’s task and leaves an unrelated member replayed',
    why: 'Turborepo puts the root’s workspace dependencies in the global hash, so touching `util` misses the build of every package. `another` reads nothing of `util`, and nothing in any manifest links them. Rebuilding it costs a full task for an edit it cannot see. `util` and the root rebuild; `another` replays.',
    from: ['root-project', 'hash-chain'],
    workspace: rootDeps(),
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['util#build', 'another#build', 'root#build'] } },
      { write: { 'packages/util/src/a.txt': 'util 2\n' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['util#build', 'root#build'], notRan: ['another#build'] },
      },
    ],
  }),

  // global_inputs_test.rs test_global_inputs_exclusion_not_defeated_by_phantom_dependency_tasks
  defineCase({
    id: 'inputs/root-input-not-keyed-through-taskless-dependency',
    category: 'inputs',
    kind: 'efficiency',
    title:
      'A root file one project’s task reads does not rerun another project that reaches a dependency without the task',
    why: '`b` waits on its dependencies’ builds, but `shared` has none, so nothing is built there. Turborepo once gave that empty step a key of its own, global inputs included, so a root file only `a` reads reached `b` through it. An empty step reads nothing and keys nothing. Changing the file reruns `a` and replays `b`.',
    from: ['workspace-files', 'hash-chain'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: build('mkdir -p dist && cat ../../config.txt src/*.txt > dist/out.txt', {
              rootInputs: ['config.txt'],
            }),
          },
          files: { 'src/a.txt': 'a\n' },
        },
        shared: { files: { 'src/s.txt': 'shared\n' } },
        b: {
          deps: ['shared'],
          tasks: {
            build: build('mkdir -p dist && cat src/*.txt > dist/out.txt', {
              dependsOn: ['^build'],
            }),
          },
          files: { 'src/b.txt': 'b\n' },
        },
      },
      files: { 'config.txt': 'v1\n' },
    },
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build', 'b#build'] } },
      { write: { 'config.txt': 'v2\n' } },
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['a#build'],
          notRan: ['b#build'],
          files: { [out('a')]: 'v2\na\n' },
        },
      },
    ],
  }),

  // single_package_run_test.rs: outputs of a one-package repository land at the repository root
  defineCase({
    id: 'outputs/single-package-deleted-output-restored',
    category: 'outputs',
    kind: 'correctness',
    title:
      'In a one-package repository, a deleted output comes back at the repository root on a replay',
    why: 'In a one-package repository the project folder is the repository root, so outputs live beside `.git` and the tool’s own files. A tool that places restored files relative to a members folder, or skips restoring at the root, leaves the build missing after a replay. The file comes back where the task wrote it, with its bytes.',
    from: ['root-project', 'output-flow'],
    workspace: single(
      { build: build('mkdir -p dist/sub && cat src/*.txt > dist/sub/out.txt') },
      { 'src/a.txt': 'one\n' },
    ),
    steps: [
      { run: 'build', expect: { exit: 0, files: { 'dist/sub/out.txt': 'one\n' } } },
      { write: { dist: null } },
      {
        run: 'build',
        expect: { exit: 0, notRan: ['app#build'], files: { 'dist/sub/out.txt': 'one\n' } },
      },
    ],
  }),

  // single_package_dry_run_test.rs: a one-package task keyed on a variable (single_package_hashes)
  defineCase({
    id: 'env/single-package-declared-variable-keys',
    category: 'env',
    kind: 'correctness',
    title:
      'In a one-package repository, a declared variable reaches the task and a new value runs it again',
    why: 'A one-package build reads its mode from the environment as any project does. If the root package’s task skips the variable when keying, a production build replays a development result. The value must reach the command and key it. The second run, with a new value, builds again and writes the new value.',
    from: ['root-project', 'env'],
    needs: ['env-inputs'],
    workspace: single(
      {
        build: build('mkdir -p dist && printf "%s\\n" "$MODE" > dist/out.txt', { env: ['MODE'] }),
      },
      { 'src/a.txt': 'one\n' },
    ),
    steps: [
      {
        run: 'build',
        env: { MODE: 'dev' },
        expect: { exit: 0, files: { 'dist/out.txt': 'dev\n' } },
      },
      {
        run: 'build',
        env: { MODE: 'prod' },
        expect: { exit: 0, ran: ['app#build'], files: { 'dist/out.txt': 'prod\n' } },
      },
      {
        run: 'build',
        env: { MODE: 'dev' },
        expect: { exit: 0, notRan: ['app#build'], files: { 'dist/out.txt': 'dev\n' } },
      },
    ],
  }),

  // missing_tasks_test.rs test_single_missing_task, in a one-package repository
  defineCase({
    id: 'failure/single-package-unknown-task-fails',
    category: 'failure',
    kind: 'correctness',
    title: 'In a one-package repository, asking for a task the package does not declare fails',
    why: 'A typo in a task name must not look like success. With no members there is no other project to run it in, so the run has nothing to do. A tool that exits 0 with nothing run lets CI pass a test job that tested nothing. The run fails and runs nothing.',
    from: ['root-project', 'cli-task-names'],
    workspace: single(
      { build: build('mkdir -p dist && cat src/*.txt > dist/out.txt') },
      { 'src/a.txt': 'one\n' },
    ),
    steps: [{ run: 'tset', expect: { exit: 'fail', notRan: ['app#build'] } }],
  }),

  // single_package_with_deps_test.rs: the step before the build fails
  defineCase({
    id: 'failure/single-package-failing-prerequisite-skips-task',
    category: 'failure',
    kind: 'correctness',
    title:
      'In a one-package repository, a failing step before the build fails the run and the build never runs',
    why: 'The build reads what its prerequisite writes, so building after that step failed reads nothing or an old file. In a one-package repository the task edge is all that orders them. The run fails, the build does not start, and no output of it appears.',
    from: ['root-project', 'failure-mode'],
    workspace: single(
      {
        prepare: { command: 'exit 3', inputs: ['prep/**'], outputs: [] },
        build: build('mkdir -p dist && cat src/*.txt > dist/out.txt', { dependsOn: ['prepare'] }),
      },
      { 'prep/p.txt': 'prep\n', 'src/a.txt': 'one\n' },
    ),
    steps: [
      {
        run: 'build',
        expect: {
          exit: 'fail',
          notRan: ['app#build'],
          files: { 'dist/out.txt': null },
        },
      },
    ],
  }),

  // single_package_run_test.rs: args after `--` in a one-package repository
  defineCase({
    id: 'graph/single-package-forwarded-args-reach-task',
    category: 'graph',
    kind: 'correctness',
    title: 'In a one-package repository, args given to the run reach the task’s command',
    why: 'A one-package repository runs one project, so forwarding args is unambiguous: `test -- --watch=false` means the package’s test. A tool that drops them, or hands them to the step before, runs the command the user did not ask for. The args reach the requested task as written.',
    from: ['root-project', 'forward-args-verbatim'],
    workspace: single(
      {
        build: build('mkdir -p dist && printf "%s\\n" "$@" > dist/out.txt', { takesArgs: true }),
      },
      { 'src/a.txt': 'one\n' },
    ),
    steps: [
      {
        run: 'build',
        args: ['--mode', 'two words'],
        expect: { exit: 0, files: { 'dist/out.txt': '--mode\ntwo words\n' } },
      },
    ],
  }),

  // affected_test.rs test_affected_run_with_file_change, in a one-package repository
  defineCase({
    id: 'affected/single-package-change-selects-the-package',
    category: 'affected',
    kind: 'correctness',
    title:
      'In a one-package repository, an affected run runs nothing with no change and runs the task after one',
    why: 'Every file of a one-package repository belongs to its one project. With no change since the base the run has nothing to do and must succeed. After a committed source edit the package is changed and its task runs. A tool that only maps changes onto workspace members selects nothing ever.',
    from: ['root-project', 'affected'],
    needs: ['affected'],
    workspace: single(
      { build: build('mkdir -p dist && cat src/*.txt > dist/out.txt') },
      { 'src/a.txt': 'one\n' },
    ),
    steps: [
      { affected: 'build', base: 'HEAD', expect: { exit: 0, notRan: ['app#build'] } },
      { write: { 'src/a.txt': 'two\n' } },
      { commit: 'edit' },
      {
        affected: 'build',
        base: 'HEAD~1',
        expect: { exit: 0, ran: ['app#build'], files: { 'dist/out.txt': 'two\n' } },
      },
    ],
  }),

  // run_caching.rs test_root_deps_caching: a failing root dependency
  defineCase({
    id: 'failure/root-dependency-failure-skips-root-task',
    category: 'failure',
    kind: 'correctness',
    title:
      'A library the root package depends on failing skips the root’s task and lets an unrelated member build',
    why: 'The root’s build waits on its dependencies like any project’s, so it must not run over a library that just failed. A member that does not depend on that library has nothing to wait for and should build. The run fails, the root’s task does not start, and `another` still builds.',
    from: ['root-project', 'failure-mode'],
    workspace: {
      projects: {
        root: {
          dir: '.',
          deps: ['util'],
          tasks: { build: ROOT_BUILD },
          files: { 'tools/x.txt': 'root\n' },
        },
        // util fails only once another has built, so the case does not race a tool that stops at a failure.
        util: {
          tasks: {
            build: build(
              'i=0; while [ ! -e ../another/dist/out.txt ] && [ $i -lt 400 ]; do sleep 0.05; i=$((i+1)); done; sleep 0.2; exit 1',
            ),
          },
          files: { 'src/a.txt': 'util\n' },
        },
        another: chainProject('another'),
      },
    },
    steps: [
      {
        run: 'build',
        expect: {
          exit: 'fail',
          ran: ['another#build'],
          notRan: ['root#build'],
          files: { 'dist/root.txt': null, [out('another')]: 'another\n' },
        },
      },
    ],
  }),

  // run_caching.rs test_tracked_outputs_invalidate_cache_and_preserve_committed_edits
  defineCase({
    id: 'outputs/restore-beside-committed-file-keeps-its-edit',
    category: 'outputs',
    kind: 'correctness',
    title:
      'Restoring a deleted build file into an output folder keeps a committed file there as last committed',
    why: 'A license or a checked-in asset often sits in the output folder, committed, and the task never writes it. When the build file is deleted and the run replays, the restore writes into that folder. A restore that unpacks the whole stored folder puts the old copy of the committed file back, and `git diff` shows an edit nobody made. The build file comes back and the committed file keeps its new text.',
    from: ['stale-hit-git', 'output-flow'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command: 'mkdir -p out && cat src/*.txt > out/out.txt',
              inputs: ['src/**'],
              outputs: ['out/**'],
            },
          },
          files: {
            'src/a.txt': 'a\n',
            'out/LICENSE': 'license v1\n',
            '.gitignore': 'out/out.txt\n',
          },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, files: { 'packages/a/out/out.txt': 'a\n' } } },
      { write: { 'packages/a/out/LICENSE': 'license v2\n' } },
      { commit: 'license v2' },
      { write: { 'packages/a/out/out.txt': null } },
      {
        run: 'build',
        expect: {
          exit: 0,
          files: { 'packages/a/out/out.txt': 'a\n', 'packages/a/out/LICENSE': 'license v2\n' },
        },
      },
    ],
  }),

  // affected_test.rs test_task_level_affected_iff_task_hash_changes: ["src/index.ts", "!src/**"]
  defineCase({
    id: 'affected/file-named-after-negated-folder-selects',
    category: 'affected',
    kind: 'correctness',
    title:
      'A file named outright as an input, beside an exclude of its whole folder, selects the task when it changes',
    why: 'An input list such as `src/index.txt` and `!src/**` says: of `src`, read only this file. Turborepo’s test pins that an edit to the named file still selects the task. A matcher that lets the folder exclude win drops the one file the task reads, and the affected run skips a task whose result just changed. A tool may refuse the list outright instead.',
    from: ['affected-head-range', 'inputs-resolution'],
    needs: ['affected'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: build('mkdir -p dist && cat src/index.txt > dist/out.txt', {
              inputs: ['src/index.txt', '!src/**'],
            }),
          },
          files: { 'src/index.txt': 'one\n', 'src/other.txt': 'other\n' },
        },
      },
    },
    steps: [
      { write: { 'packages/a/src/index.txt': 'two\n' } },
      { commit: 'edit' },
      {
        affected: 'build',
        base: 'HEAD~1',
        expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'two\n' }, orRefused: true },
      },
    ],
  }),

  // single_package_run_test.rs: two tasks asked for in one run of a one-package repository
  defineCase({
    id: 'graph/single-package-two-tasks-in-one-run',
    category: 'graph',
    kind: 'correctness',
    title: 'In a one-package repository, a run asking for two tasks runs both',
    why: '`lint` and `build` side by side is the usual CI line, in a single package as in a monorepo. A tool that takes only the first name, or reads the second as a project to select, runs half of what was asked and reports success. Both tasks run and leave their files.',
    from: ['root-project', 'cli-task-names'],
    needs: ['multi-task'],
    workspace: single(
      {
        build: build('mkdir -p dist && cat src/*.txt > dist/out.txt'),
        lint: {
          command: 'mkdir -p lint && cat src/*.txt > lint/report.txt',
          inputs: ['src/**'],
          outputs: ['lint/**'],
        },
      },
      { 'src/a.txt': 'one\n' },
    ),
    steps: [
      {
        run: 'build',
        also: ['lint'],
        expect: {
          exit: 0,
          ran: ['app#build', 'app#lint'],
          files: { 'dist/out.txt': 'one\n', 'lint/report.txt': 'one\n' },
        },
      },
    ],
  }),

  // single_package_*_test.rs: a fixture folder with its own package.json in a one-package repository
  defineCase({
    id: 'inputs/single-package-fixture-folder-with-manifest-keys-the-task',
    category: 'inputs',
    kind: 'correctness',
    title:
      'In a one-package repository, an edit in a fixture folder that holds its own package.json runs the task reading it',
    why: 'Test fixtures are often small packages, each with a package.json, inside a repository that lists no workspaces. Such a folder is not a project, so its files belong to the package around it. A tool that takes every package.json as a project boundary drops the fixture from the task’s inputs and replays tests built from the old fixture.',
    from: ['root-project', 'nested-input'],
    workspace: single(
      {
        test: {
          command: 'mkdir -p dist && cat fixtures/demo/data.txt > dist/out.txt',
          inputs: ['fixtures/**'],
          outputs: ['dist/**'],
        },
      },
      {
        'fixtures/demo/package.json': '{ "name": "demo-fixture", "version": "1.0.0" }\n',
        'fixtures/demo/data.txt': 'one\n',
      },
    ),
    steps: [
      { run: 'test', expect: { exit: 0, ran: ['app#test'], files: { 'dist/out.txt': 'one\n' } } },
      { write: { 'fixtures/demo/data.txt': 'two\n' } },
      { run: 'test', expect: { exit: 0, ran: ['app#test'], files: { 'dist/out.txt': 'two\n' } } },
    ],
  }),

  // single_package_run_test.rs, under watch (watch_test.rs runs monorepos only)
  defineCase({
    id: 'watch/single-package-edit-rebuilds',
    category: 'watch',
    kind: 'correctness',
    title: 'In a one-package repository, editing a source while watching rebuilds it',
    why: 'A watch over a single package watches the whole repository root, `.git` and the tool’s own files included. It must still react to a source edit and ignore its own writes. A watch that only follows member folders never fires here, and the user keeps testing the first build.',
    from: ['root-project', 'watch-loop'],
    needs: ['watch'],
    workspace: single(
      { build: build('mkdir -p dist && cat src/*.txt > dist/out.txt') },
      { 'src/a.txt': 'one\n' },
    ),
    steps: [
      {
        watch: 'build',
        phases: [
          { expect: { ran: ['app#build'], files: { 'dist/out.txt': 'one\n' } } },
          {
            write: { 'src/a.txt': 'two\n' },
            expect: { ran: ['app#build'], files: { 'dist/out.txt': 'two\n' } },
          },
        ],
      },
    ],
  }),

  // big_status_test.rs test_large_git_status_with_spaces
  defineCase({
    id: 'inputs/hundred-untracked-names-with-spaces-each-keyed',
    category: 'inputs',
    kind: 'correctness',
    title:
      'With a hundred new files named with spaces under the inputs, editing one of them runs the task again',
    why: 'Git quotes and splits a long status listing in ways a careless parser gets wrong, and spaces in names are where it breaks first. Turborepo’s test counts that a hundred untracked spaced names all reach the task’s inputs. A tool that loses some of them replays a stale build when one of the lost files changes.',
    from: ['git-enum-unicode', 'inputs'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: build('mkdir -p dist && cat src/*.txt | wc -l | tr -d " " > dist/out.txt'),
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    steps: [
      {
        sh: 'for i in $(seq 1 100); do printf "x\\n" > "packages/a/src/with spaces $i.txt"; done',
      },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: '101\n' } } },
      { write: { 'packages/a/src/with spaces 73.txt': 'x\ny\n' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: '102\n' } } },
    ],
  }),

  // single_package_run_test.rs: the one package selected by its name
  defineCase({
    id: 'graph/single-package-selected-by-its-name',
    category: 'graph',
    kind: 'correctness',
    title: 'In a one-package repository, selecting the package by its name runs its task',
    why: 'Scripts and CI templates select by name, and the same template often serves single packages and monorepos. In a one-package repository the name in package.json is the one project’s name. A tool that refuses the selection, or matches nothing and exits 0, breaks the shared template.',
    from: ['root-project', 'filter'],
    needs: ['filter'],
    workspace: single(
      { build: build('mkdir -p dist && cat src/*.txt > dist/out.txt') },
      { 'src/a.txt': 'one\n' },
    ),
    steps: [
      {
        run: 'build',
        projects: ['app'],
        expect: { exit: 0, ran: ['app#build'], files: { 'dist/out.txt': 'one\n' } },
      },
    ],
  }),

  // filter_run_test.rs: the root package holds every member's folder, not their tasks
  defineCase({
    id: 'graph/root-caret-without-dependencies-runs-alone',
    category: 'graph',
    kind: 'efficiency',
    title:
      'The root package’s task that waits on its dependencies’ builds runs alone when the root depends on nothing',
    why: 'The root package’s folder holds every member, but its manifest lists no workspace dependency. Its `^build` therefore names no project. A tool that treats the root as depending on everything under it builds every member first, which for a root lint or docs task is the whole repository for nothing.',
    from: ['root-project', 'graph-order'],
    needs: ['filter'],
    workspace: {
      projects: {
        root: { dir: '.', tasks: { build: ROOT_BUILD }, files: { 'tools/x.txt': 'root\n' } },
        a: chainProject('a'),
        b: chainProject('b'),
      },
    },
    steps: [
      {
        run: 'build',
        projects: ['root'],
        expect: {
          exit: 0,
          ran: ['root#build'],
          notRan: ['a#build', 'b#build'],
          files: { 'dist/root.txt': 'root\n' },
        },
      },
    ],
  }),

  // run_caching.rs test_root_deps_caching: the root's key folds only what it depends on
  defineCase({
    id: 'inputs/member-edit-outside-root-dependencies-replays-root-task',
    category: 'inputs',
    kind: 'efficiency',
    title:
      'An edit in a member the root package does not depend on replays the root’s task that waits on its dependencies',
    why: 'The root’s build waits on `util`, so a change in `util` must reach it. `another` is in the repository but not in the root’s dependencies, so its edits cannot change what the root reads. A tool that folds every member into the root’s key rebuilds the root on each member edit. `another` rebuilds; the root and `util` replay.',
    from: ['root-project', 'hash-chain'],
    workspace: rootDeps(),
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['util#build', 'another#build', 'root#build'] } },
      { write: { 'packages/another/src/a.txt': 'another 2\n' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['another#build'], notRan: ['util#build', 'root#build'] },
      },
    ],
  }),
] satisfies Case[]
