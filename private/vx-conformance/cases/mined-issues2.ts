// Cases drawn from bugs Turborepo, Nx and moon users reported and the
// projects fixed (a second pass over closed issues, after mined-issues.ts).
// Each names its issue above it and holds any task runner to the outcome
// the fix restored.
import { defineCase, type Case, type ProjectSpec, type WorkspaceSpec } from '../src/spec.ts'
import { CONCAT, one, out } from './shapes.ts'

/** A project's package.json, its dependencies as written. */
function manifest(name: string, deps: Record<string, string> = {}): string {
  return JSON.stringify({ name, version: '0.0.0', private: true, dependencies: deps }, null, 2)
}

/** The root package.json for members `dirs`, with fields a case adds. */
function rootManifest(dirs: string[], extra: object = {}): string {
  return JSON.stringify(
    {
      name: 'conformance',
      private: true,
      packageManager: `bun@${Bun.version}`,
      workspaces: dirs,
      ...extra,
    },
    null,
    2,
  )
}

/** A local package `name` at `vendor/<dir>` holding v.txt = `<dir>`. */
function vendored(dir: string, name: string): Record<string, string> {
  return {
    [`vendor/${dir}/package.json`]: JSON.stringify({ name, version: '1.0.0' }),
    [`vendor/${dir}/v.txt`]: `${dir}\n`,
  }
}

/** A project whose build writes `command`'s stdout to dist/out.txt, keyed on src/**. */
function reader(name: string, deps: Record<string, string>, command: string): ProjectSpec {
  return {
    tasks: {
      build: {
        command: `mkdir -p dist && ${command} > dist/out.txt`,
        inputs: ['src/**'],
        outputs: ['dist/**'],
      },
    },
    files: { 'package.json': manifest(name, deps), 'src/a.txt': `${name}\n` },
  }
}

/** a and c take the local package x, b takes nothing external. */
function takers(): WorkspaceSpec {
  return {
    projects: {
      a: reader(
        'a',
        { x: 'file:../../vendor/x' },
        '{ cat src/a.txt; cat node_modules/x/v.txt 2>/dev/null || echo none; }',
      ),
      b: reader('b', {}, 'cat src/a.txt'),
      c: reader('c', { x: 'file:../../vendor/x' }, 'cat src/a.txt node_modules/x/v.txt'),
    },
    files: vendored('x', 'x'),
  }
}

/** A patch of x's v.txt from `x` to `text`, as `bun patch --commit` writes one. */
const patch = (text: string) =>
  `diff --git a/v.txt b/v.txt\n--- a/v.txt\n+++ b/v.txt\n@@ -1 +1 @@\n-x\n+${text}\n`

const PATCH_FILE = 'patches/x@..%2F..%2Fvendor%2Fx.tgz.patch'

export default [
  // nx #32610 "nx does not create file cache for tasks named `dev`".
  defineCase({
    id: 'cache/tasks-named-dev-and-start-replay',
    category: 'cache',
    kind: 'efficiency',
    title: 'Cached tasks named `dev` and `start` replay like any other task',
    why: 'A task’s name is the user’s label, not a statement about what it does. Names like `dev` and `start` often belong to dev servers, but here they are plain builds the user marked cacheable. A runner that treats those names as long-running and never stores them reruns work the user asked it to keep.',
    from: ['cache'],
    workspace: {
      projects: {
        a: {
          tasks: {
            dev: {
              command: 'mkdir -p dev && cat src/a.txt > dev/out.txt',
              inputs: ['src/**'],
              outputs: ['dev/**'],
            },
            start: {
              command: 'mkdir -p start && cat src/a.txt > start/out.txt',
              inputs: ['src/**'],
              outputs: ['start/**'],
            },
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    steps: [
      { run: 'dev', also: ['start'], expect: { exit: 0, ran: ['a#dev', 'a#start'] } },
      { write: { 'packages/a/dev/out.txt': null, 'packages/a/start/out.txt': null } },
      {
        run: 'dev',
        also: ['start'],
        expect: {
          exit: 0,
          notRan: ['a#dev', 'a#start'],
          files: { 'packages/a/dev/out.txt': 'a\n', 'packages/a/start/out.txt': 'a\n' },
        },
      },
    ],
    needs: ['multi-task'],
  }),

  // nx #30617 "Input and output glob patterns throw error: error parsing glob
  // 'a}{b': unclosed alternate group".
  defineCase({
    id: 'inputs/close-brace-before-open-brace-is-a-name',
    category: 'inputs',
    kind: 'correctness',
    title: 'An input `src/a}{b.txt` keys the file of that name',
    why: 'A `}` before any `{` closes nothing, and a `{` with no `}` after it opens nothing, so both are plain characters of the name. File names carry braces from templating tools and copied paths. A runner that rejects the pattern, or reads it as a broken alternative that matches nothing, either fails the run or replays a build of an edited file.',
    from: ['contract-task-globs'],
    workspace: one(
      { command: CONCAT, inputs: ['src/a}{b.txt'], outputs: ['dist/**'] },
      { 'src/a}{b.txt': 'one\n' },
    ),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'one\n' } } },
      { write: { 'packages/a/src/a}{b.txt': 'two\n' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'two\n' } } },
    ],
  }),

  // moon #2214 "Reverting creating a new project does not remove it from moon's cache".
  defineCase({
    id: 'graph/removed-dependency-project-is-not-brought-back',
    category: 'graph',
    kind: 'correctness',
    title:
      'Once a new dependency project is deleted again, the next run builds without it and does not bring it back',
    why: 'Undoing a change is ordinary: a project added on a branch and then thrown away is gone. The run after it must plan from the workspace as it stands now. A runner that remembers the deleted project from an earlier graph either fails on a dependency that no longer exists or writes its directory back.',
    from: ['discover-stage', 'vx-lockfile/deleted-project'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command: 'echo a > a.txt',
              inputs: ['src/**'],
              outputs: ['a.txt'],
              dependsOn: ['^build'],
            },
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    steps: [
      {
        write: {
          'package.json': rootManifest(['packages/a', 'packages/b']),
          'packages/a/package.json': manifest('a', { b: 'workspace:*' }),
          'packages/b/package.json': manifest('b'),
          'packages/b/src/b.txt': 'b\n',
        },
      },
      { install: true },
      {
        configure: (ws) => ({
          ...ws,
          projects: {
            a: { ...ws.projects['a']!, deps: ['b'] },
            b: {
              tasks: {
                build: { command: 'echo b > b.txt', inputs: ['src/**'], outputs: ['b.txt'] },
              },
              files: { 'src/b.txt': 'b\n' },
            },
          },
        }),
      },
      { install: true },
      {
        run: 'build',
        expect: { exit: 0, ran: ['b#build', 'a#build'], order: [['b#build', 'a#build']] },
      },
      { sh: 'rm -rf packages/b' },
      {
        write: {
          'package.json': rootManifest(['packages/a']),
          'packages/a/package.json': manifest('a'),
        },
      },
      { install: true },
      { configure: (ws) => ({ ...ws, projects: { a: { ...ws.projects['a']!, deps: [] } } }) },
      {
        run: 'build',
        expect: {
          exit: 0,
          notRan: ['b#build'],
          files: { 'packages/b/b.txt': null, 'packages/b/src/b.txt': null },
        },
      },
      { check: { missing: ['packages/b'] } },
    ],
  }),

  // nx #37889 "Failing task reported as 'Successfully ran' (exit 0) when the
  // daemon stops on a `.gitignore` change mid-run".
  defineCase({
    id: 'failure/task-editing-gitignore-still-fails',
    category: 'failure',
    kind: 'correctness',
    title: 'A task that edits the root .gitignore and then fails still fails the run',
    why: 'Tools write ignore rules: a generator adds its output folder, a setup step adds a cache directory. A change to which files git ignores is not a reason to stop judging the task’s exit code. A run that loses track of the failure and reports success lets a broken build through CI.',
    from: ['failure-mode'],
    workspace: one({
      command: 'echo gen >> ../../.gitignore && exit 3',
      inputs: ['src/**'],
      outputs: [],
    }),
    steps: [{ run: 'build', expect: { exit: 'fail', ran: ['a#build'] } }],
  }),

  // turbo #14839 "Editing a Bun patch file (`patchedDependencies`) does not
  // change the task hash".
  defineCase({
    id: 'inputs/dependency-patch-edit-reruns-its-reader',
    category: 'inputs',
    kind: 'correctness',
    title:
      'Editing the patch applied to an installed package, and installing, runs the task reading it again',
    why: 'A patch is part of the installed package: after the install, the files the task reads hold the patched bytes. The lockfile names the patch file but not what it says, so a key built only from the lockfile sees nothing change. The task must run again, or it replays a build of the old patch.',
    from: ['vx-lockfile/bun-patch-precise'],
    workspace: {
      projects: { a: reader('a', {}, 'cat node_modules/x/v.txt') },
      files: vendored('x', 'x'),
    },
    steps: [
      {
        sh: 'mkdir -p vendor/t/package && cp vendor/x/* vendor/t/package/ && tar -czf vendor/x.tgz -C vendor/t package && rm -rf vendor/t',
      },
      { write: { 'packages/a/package.json': manifest('a', { x: 'file:../../vendor/x.tgz' }) } },
      {
        write: {
          'package.json': rootManifest(['packages/a'], {
            patchedDependencies: { 'x@../../vendor/x.tgz': PATCH_FILE },
          }),
          [PATCH_FILE]: patch('one'),
        },
      },
      { install: true },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'one\n' } } },
      { write: { [PATCH_FILE]: patch('two') } },
      { install: true },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'two\n' } } },
    ],
  }),

  // Hardening finds a250661 and 0e6ad51: a run between a pull that edits or
  // adds a patch and the install built against the old copy, under the key
  // of the new patch, and replayed it after the install.
  defineCase({
    id: 'inputs/patch-edit-built-before-install-not-replayed',
    category: 'inputs',
    kind: 'correctness',
    title:
      'A build run after a patch edit but before the install is not replayed once the install applies it',
    why: 'A pull can change a patch file while the installed package still holds the old patched bytes. A build run then reads the old bytes, but the patch file it is keyed on is already the new one. Stored under that key, the old build comes back after the install, so the patch looks applied when it is not. The tool must refuse to build on the stale install, or keep that result out of the cache.',
    from: ['vx-lockfile/bun-patch-installed'],
    workspace: {
      projects: { a: reader('a', {}, 'cat node_modules/x/v.txt') },
      files: vendored('x', 'x'),
    },
    steps: [
      {
        sh: 'mkdir -p vendor/t/package && cp vendor/x/* vendor/t/package/ && tar -czf vendor/x.tgz -C vendor/t package && rm -rf vendor/t',
      },
      { write: { 'packages/a/package.json': manifest('a', { x: 'file:../../vendor/x.tgz' }) } },
      {
        write: {
          'package.json': rootManifest(['packages/a'], {
            patchedDependencies: { 'x@../../vendor/x.tgz': PATCH_FILE },
          }),
          [PATCH_FILE]: patch('one'),
        },
      },
      { install: true },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'one\n' } } },
      { write: { [PATCH_FILE]: patch('two') } },
      { run: 'build', expect: { exit: 0, orRefused: true } },
      { install: true },
      { write: { 'packages/a/dist': null } },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'two\n' } } },
    ],
  }),

  defineCase({
    id: 'inputs/first-patch-built-before-install-not-replayed',
    category: 'inputs',
    kind: 'correctness',
    title:
      'A build run after a first patch is added but before the install is not replayed once the install applies it',
    why: 'A pull that adds a patch leaves the unpatched package installed until the next install. A build run in between reads the unpatched bytes under a key that already names the patch. Stored, it comes back after the install and hides the patch entirely. The tool must refuse to build on the stale install, or keep that result out of the cache.',
    from: ['vx-lockfile/bun-patch-installed'],
    workspace: {
      projects: { a: reader('a', {}, 'cat node_modules/x/v.txt') },
      files: vendored('x', 'x'),
    },
    steps: [
      {
        sh: 'mkdir -p vendor/t/package && cp vendor/x/* vendor/t/package/ && tar -czf vendor/x.tgz -C vendor/t package && rm -rf vendor/t',
      },
      { write: { 'packages/a/package.json': manifest('a', { x: 'file:../../vendor/x.tgz' }) } },
      { write: { 'package.json': rootManifest(['packages/a']) } },
      { install: true },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'x\n' } } },
      {
        write: {
          'package.json': rootManifest(['packages/a'], {
            patchedDependencies: { 'x@../../vendor/x.tgz': PATCH_FILE },
          }),
          [PATCH_FILE]: patch('one'),
        },
      },
      { run: 'build', expect: { exit: 0, orRefused: true } },
      { install: true },
      { write: { 'packages/a/dist': null } },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'one\n' } } },
    ],
  }),

  // nx #37783 "projectsAffectedByDependencyUpdates: 'auto' marks every project
  // when a package is removed from the lockfile".
  defineCase({
    id: 'inputs/removed-dependency-reruns-only-its-project',
    category: 'inputs',
    kind: 'correctness',
    title:
      'Removing an external dependency from one project runs that project’s task again, and no other',
    why: 'The project that dropped the package no longer has it installed, so what its task reads changed. The project that still takes the same package installs exactly what it did before. Rerunning it, or every project, because the lockfile lost an entry wastes the run on work that cannot differ.',
    from: ['vx-lockfile/closure-per-project'],
    workspace: takers(),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'a\nx\n' } } },
      { write: { 'packages/a/package.json': manifest('a') } },
      { install: true },
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['a#build'],
          notRan: ['b#build', 'c#build'],
          files: { [out('a')]: 'a\nnone\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'affected/removed-dependency-selects-only-its-project',
    category: 'affected',
    kind: 'efficiency',
    title: 'A committed removal of one project’s external dependency selects that project alone',
    why: 'Only the project that dropped the package installs anything different. Another project still taking the same package, and one that never took it, are untouched. Selecting every project because the lockfile changed turns a dependency cleanup into a full CI run.',
    from: ['vx-lockfile/closure-per-project', 'affected'],
    needs: ['affected'],
    workspace: takers(),
    steps: [
      { write: { 'packages/a/package.json': manifest('a') } },
      { install: true },
      { commit: 'drop x from a' },
      {
        affected: 'build',
        base: 'HEAD~1',
        expect: { exit: 0, ran: ['a#build'], notRan: ['b#build', 'c#build'] },
      },
    ],
  }),

  defineCase({
    id: 'affected/added-dependency-selects-only-its-project',
    category: 'affected',
    kind: 'efficiency',
    title: 'A committed new external dependency of one project selects that project alone',
    why: 'Adding a package changes what that one project installs. The project that already took the same package resolves it exactly as before, and a project without it is untouched. A lockfile change is a change to the projects whose dependencies it holds, not to all of them.',
    from: ['vx-lockfile/closure-per-project', 'affected'],
    needs: ['affected'],
    workspace: takers(),
    steps: [
      { write: { 'packages/b/package.json': manifest('b', { x: 'file:../../vendor/x' }) } },
      { install: true },
      { commit: 'add x to b' },
      {
        affected: 'build',
        base: 'HEAD~1',
        expect: { exit: 0, ran: ['b#build'], notRan: ['a#build', 'c#build'] },
      },
    ],
  }),
] satisfies Case[]
