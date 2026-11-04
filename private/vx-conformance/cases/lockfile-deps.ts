// A task keys on what its project installs: an external dependency the
// lockfile resolves for that project (and for the projects it links). The
// harness installs offline, so every external package here is a local
// directory (`file:` or `link:`), changed by an edit to it or by pointing a
// manifest at another directory and installing again.
import { defineCase, projectDir, type ProjectSpec, type WorkspaceSpec } from '../src/spec.ts'
import { out } from './shapes.ts'

/** A project's package.json, its dependencies as written. */
function manifest(name: string, deps: Record<string, string> = {}): string {
  return JSON.stringify({ name, version: '0.0.0', private: true, dependencies: deps }, null, 2)
}

/** The root package.json, with fields a case adds (root dependencies, overrides). */
function rootManifest(projects: WorkspaceSpec['projects'], extra: object): string {
  return JSON.stringify(
    {
      name: 'conformance',
      private: true,
      packageManager: `bun@${Bun.version}`,
      workspaces: Object.entries(projects).map(([n, p]) => projectDir(n, p)),
      ...extra,
    },
    null,
    2,
  )
}

/** A local package `name` at `vendor/<dir>` holding v.txt = `<dir>`. */
function vendored(dir: string, name: string, deps: Record<string, string> = {}) {
  return {
    [`vendor/${dir}/package.json`]: JSON.stringify({ name, version: '1.0.0', dependencies: deps }),
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

const FROM_CLOSURE = 'vx-lockfile/closure-per-project'

/** a → x, b → y, c → x and the workspace b; the root depends on nothing. */
function closures(): WorkspaceSpec {
  return {
    projects: {
      a: reader('a', { x: 'file:../../vendor/x1' }, 'cat node_modules/x/v.txt'),
      b: reader('b', { y: 'file:../../vendor/y1' }, 'cat node_modules/y/v.txt'),
      c: reader(
        'c',
        { b: 'workspace:*', x: 'file:../../vendor/x1' },
        'cat node_modules/x/v.txt node_modules/b/node_modules/y/v.txt',
      ),
    },
    files: {
      ...vendored('x1', 'x'),
      ...vendored('x2', 'x'),
      ...vendored('y1', 'y'),
      ...vendored('y2', 'y'),
    },
  }
}
const bumpY = [
  { write: { 'packages/b/package.json': manifest('b', { y: 'file:../../vendor/y2' }) } },
  { install: true as const },
]
const bumpX = [
  { write: { 'packages/a/package.json': manifest('a', { x: 'file:../../vendor/x2' }) } },
  {
    write: {
      'packages/c/package.json': manifest('c', { b: 'workspace:*', x: 'file:../../vendor/x2' }),
    },
  },
  { install: true as const },
]

/** lib → dep, a `file:` directory at vendor/dep; other depends on nothing. */
function fileDir(spec = 'file:../../vendor/dep'): WorkspaceSpec {
  return {
    projects: {
      lib: reader('lib', { dep: spec }, 'cat node_modules/dep/*.txt'),
      other: reader('other', {}, 'cat src/a.txt'),
    },
    files: vendored('dep', 'dep'),
  }
}

/** lib → dep, a `file:` directory inside `other`'s own directory; third on its own. */
function extraInProject(): WorkspaceSpec {
  return {
    projects: {
      lib: reader('lib', { dep: 'file:../other/vendor' }, 'cat node_modules/dep/v.txt'),
      other: {
        ...reader('other', {}, 'cat src/a.txt'),
        files: {
          'package.json': manifest('other'),
          'src/a.txt': 'other\n',
          'vendor/package.json': JSON.stringify({ name: 'dep', version: '1.0.0' }),
          'vendor/v.txt': 'v1\n',
        },
      },
      third: reader('third', {}, 'cat src/a.txt'),
    },
  }
}

/**
 * The root depends on the workspace lib; app declares nothing and reads lib
 * through the root: its build (`dist`), or, to ask about keys apart from
 * order, its source (`src`). lib → util.
 */
function rootDep(reads: 'dist' | 'src' = 'dist'): WorkspaceSpec {
  const projects: WorkspaceSpec['projects'] = {
    app: {
      tasks: {
        build: {
          command: `mkdir -p dist && cat ../../node_modules/lib/${reads === 'dist' ? 'dist/out' : 'src/a'}.txt src/a.txt > dist/out.txt`,
          dependsOn: ['^build'],
          inputs: ['src/**'],
          outputs: ['dist/**'],
        },
      },
      files: { 'package.json': manifest('app'), 'src/a.txt': 'app\n' },
    },
    lib: {
      ...reader('lib', { util: 'workspace:*' }, 'cat src/a.txt'),
      tasks: {
        build: {
          command: 'mkdir -p dist && cat src/a.txt > dist/out.txt',
          dependsOn: ['^build'],
          inputs: ['src/**'],
          outputs: ['dist/**'],
        },
      },
    },
    util: {
      tasks: {
        build: {
          command: 'mkdir -p dist && cat src/a.txt > dist/out.txt',
          dependsOn: ['^build'],
          inputs: ['src/**'],
          outputs: ['dist/**'],
        },
      },
      files: { 'package.json': manifest('util'), 'src/a.txt': 'util\n' },
    },
  }
  return {
    projects,
    files: { 'package.json': rootManifest(projects, { devDependencies: { lib: 'workspace:*' } }) },
  }
}

/** b → yy (vendor/y) → z (vendor/z1); a → x on its own. The root may override z. */
function overridden(overrides?: Record<string, string>): WorkspaceSpec {
  const projects: WorkspaceSpec['projects'] = {
    a: reader('a', { x: 'file:../../vendor/x1' }, 'cat node_modules/x/v.txt'),
    b: reader('b', { yy: 'file:../../vendor/y' }, 'cat node_modules/yy/../z/v.txt'),
  }
  return {
    projects,
    files: {
      ...vendored('x1', 'x'),
      ...vendored('y', 'yy', { z: 'file:../z1' }),
      ...vendored('z1', 'z'),
      ...vendored('z2', 'z'),
      'package.json': rootManifest(projects, overrides ? { overrides } : {}),
    },
  }
}
const rootWith = (ws: WorkspaceSpec, extra: object) => rootManifest(ws.projects, extra)

/** The root installs `foo` and `bar` from the named vendor directories; a reads both through the root. */
function rootAliases(foo: string, bar: string): WorkspaceSpec {
  const projects = {
    a: reader('a', {}, 'cat ../../node_modules/foo/v.txt ../../node_modules/bar/v.txt'),
  }
  return {
    projects,
    files: {
      ...vendored('x1', 'x'),
      ...vendored('y1', 'y'),
      'package.json': rootManifest(projects, {
        devDependencies: { foo: `file:./vendor/${foo}`, bar: `file:./vendor/${bar}` },
      }),
    },
  }
}

export default [
  defineCase({
    id: 'inputs/lockfile-dependency-change-reruns',
    category: 'inputs',
    kind: 'correctness',
    title: 'A project’s external dependency changing in the lockfile runs its task again',
    why: 'An installed package is code the task runs or bundles, as much as its own source. When the lockfile resolves a different version for the project, the task’s output can change, so the task must run again. A runner blind to dependencies replays a build made with the old package, and an upgrade or a security fix never reaches what ships.',
    from: [FROM_CLOSURE],
    workspace: closures(),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'x1\n' } } },
      ...bumpX,
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'x2\n' } } },
    ],
  }),

  defineCase({
    id: 'inputs/lockfile-linked-workspace-dependency-change-reruns',
    category: 'inputs',
    kind: 'correctness',
    title:
      'A change to an external dependency of a workspace package a project links runs that project’s task again',
    why: 'What a project can import through a linked workspace package includes that package’s own dependencies. Here `c` reads `y` through `b`, so a new `y` reaches `c` even though `c`’s manifest never names it. A runner that keys `c` only on its direct dependencies replays a build made with the old `y`, and the change ships in `b` but not in `c`.',
    from: [FROM_CLOSURE],
    workspace: closures(),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('c')]: 'x1\ny1\n' } } },
      ...bumpY,
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['b#build', 'c#build'],
          files: { [out('b')]: 'y2\n', [out('c')]: 'x1\ny2\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'inputs/lockfile-change-outside-closure-replays',
    category: 'inputs',
    kind: 'efficiency',
    title: 'A lockfile change no part of a project’s dependencies holds replays its task',
    why: 'A lockfile holds every project’s dependencies, but each task uses only its own project’s share. A change to `y`, which `a` never installs, cannot change `a`’s output. A runner that keys every task on the whole lockfile rebuilds every project after any dependency bump, and in a large repo almost no change replays at all.',
    from: [FROM_CLOSURE],
    workspace: closures(),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      ...bumpY,
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
    ],
  }),

  defineCase({
    id: 'inputs/reinstall-without-change-replays',
    category: 'inputs',
    kind: 'efficiency',
    title: 'Installing again with nothing changed replays every task',
    why: 'An install that resolves the same packages leaves every task’s dependencies as they were. A key built from what is resolved, not from file times or a fresh `node_modules`, stays the same. A runner that reruns after each install throws away the cache on every CI job, since most jobs install first.',
    from: [FROM_CLOSURE],
    workspace: closures(),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { install: true },
      { run: 'build', expect: { exit: 0, notRan: ['a#build', 'b#build', 'c#build'] } },
    ],
  }),

  defineCase({
    id: 'inputs/lockfile-alias-swap-reruns',
    category: 'inputs',
    kind: 'correctness',
    title: 'Swapping which packages two dependency names install runs the task again',
    why: 'The same packages are installed, but the name `foo` now resolves to the other one. A key that collects only the set of installed versions sees no change, though every `import` of `foo` now loads different code. The runner then replays output built with the old mapping. Each dependency name and what it resolves to must count together.',
    from: ['vx-lockfile/dependency-names'],
    workspace: {
      projects: {
        a: reader(
          'a',
          { foo: 'file:../../vendor/x1', bar: 'file:../../vendor/y1' },
          'cat node_modules/foo/v.txt node_modules/bar/v.txt',
        ),
      },
      files: { ...vendored('x1', 'x'), ...vendored('y1', 'y') },
    },
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'x1\ny1\n' } } },
      {
        write: {
          'packages/a/package.json': manifest('a', {
            foo: 'file:../../vendor/y1',
            bar: 'file:../../vendor/x1',
          }),
        },
      },
      { install: true },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'y1\nx1\n' } } },
    ],
  }),

  defineCase({
    id: 'inputs/lockfile-root-alias-swap-reruns',
    category: 'inputs',
    kind: 'correctness',
    title:
      'Swapping which packages two of the root’s dependency names install runs a task reading them',
    why: 'Packages the root installs sit where every project resolves them, so a project can read them without naming them. Swapping which package the root’s `foo` and `bar` install changes what such a project loads. If the root’s dependencies are left out of the key, the task replays output built with the old packages under a green run.',
    from: ['vx-lockfile/dependency-names'],
    workspace: rootAliases('x1', 'y1'),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'x1\ny1\n' } } },
      { write: { 'package.json': rootAliases('y1', 'x1').files!['package.json']! } },
      { install: true },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'y1\nx1\n' } } },
    ],
  }),

  defineCase({
    id: 'inputs/file-dir-dependency-edit-reruns',
    category: 'inputs',
    kind: 'correctness',
    title:
      'An edit inside a local directory dependency runs the task of the project depending on it',
    why: 'A `file:` dependency is a local directory, and the lockfile names only its path. So when a file inside it changes, the lockfile stays the same while the installed code does not. A runner that keys on the lockfile alone replays the old build. The directory’s content is the dependency’s version and must be part of the key.',
    from: ['vx-lockfile/file-dir-dep'],
    workspace: fileDir(),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('lib')]: 'dep\n' } } },
      { write: { 'vendor/dep/v.txt': 'dep v2\n' } },
      { install: true },
      {
        run: 'build',
        expect: { exit: 0, ran: ['lib#build'], files: { [out('lib')]: 'dep v2\n' } },
      },
    ],
  }),

  defineCase({
    id: 'inputs/file-dir-dependency-edit-spares-others',
    category: 'inputs',
    kind: 'efficiency',
    title:
      'An edit inside a local directory dependency replays the projects that do not depend on it',
    why: 'A local directory dependency belongs to the projects that install it, not to the whole workspace. `other` does not depend on it, so an edit there cannot change `other`’s output. Treating the edit as a change for every project reruns unrelated builds each time the vendored code moves, which wastes CI time with nothing gained.',
    from: ['vx-lockfile/file-dir-dep'],
    workspace: fileDir(),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'vendor/dep/v.txt': 'dep v2\n' } },
      { install: true },
      { run: 'build', expect: { exit: 0, notRan: ['other#build'] } },
    ],
  }),

  defineCase({
    id: 'inputs/file-dir-dependency-new-file-reruns',
    category: 'inputs',
    kind: 'correctness',
    title:
      'A file added to a local directory dependency runs the task of the project depending on it',
    why: 'A new file in a local directory dependency is installed with the rest and can be imported, globbed or bundled. The lockfile still names the same path, so only the directory’s file list shows the change. A runner that hashes only the files it saw before replays a build that misses the new file.',
    from: ['vx-lockfile/file-dir-dep'],
    workspace: fileDir(),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'vendor/dep/w.txt': 'new\n' } },
      { install: true },
      {
        run: 'build',
        expect: { exit: 0, ran: ['lib#build'], files: { [out('lib')]: 'dep\nnew\n' } },
      },
    ],
  }),

  defineCase({
    id: 'inputs/file-dir-dependency-linked-file-reruns',
    category: 'inputs',
    kind: 'correctness',
    title: 'An edit to a file a local directory dependency links to runs the task depending on it',
    why: 'A symlink in a local directory dependency installs as the file it points to, so that file is part of the dependency’s content. Editing it changes what the task reads, even though no file inside the directory changed. A runner that hashes the link text rather than its target replays output built from the old file.',
    from: ['vx-lockfile/file-dir-dep'],
    workspace: { ...fileDir(), files: { ...vendored('dep', 'dep'), 'vendor/shared.txt': 's1\n' } },
    steps: [
      { link: { 'vendor/dep/w.txt': '../shared.txt' } },
      { install: true },
      { run: 'build', expect: { exit: 0, files: { [out('lib')]: 'dep\ns1\n' } } },
      { write: { 'vendor/shared.txt': 's2\n' } },
      { install: true },
      {
        run: 'build',
        expect: { exit: 0, ran: ['lib#build'], files: { [out('lib')]: 'dep\ns2\n' } },
      },
    ],
  }),

  defineCase({
    id: 'inputs/file-dir-dependency-own-node-modules-ignored',
    category: 'inputs',
    kind: 'efficiency',
    title:
      'A change in a local directory dependency’s own node_modules replays the task depending on it',
    why: 'An install copies a local directory dependency without its `node_modules`, so files there never reach the project. A change inside it changes nothing the task reads. A runner that hashes it reruns the task whenever the dependency’s own tools install or update, which can be on every run.',
    from: ['vx-lockfile/file-dir-dep'],
    workspace: fileDir(),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'vendor/dep/node_modules/q/index.js': '// q\n' } },
      { run: 'build', expect: { exit: 0, notRan: ['lib#build'] } },
    ],
  }),

  defineCase({
    id: 'inputs/link-dir-dependency-edit-reruns',
    category: 'inputs',
    kind: 'correctness',
    title:
      'An edit inside a `link:` directory dependency runs the task of the project depending on it',
    why: 'A `link:` dependency is a symlink to a directory, so an edit there is live in the project at once, with no install. The lockfile does not change, and the project’s own files do not either. A runner must still key on the linked directory’s content, or it replays the old build while the code it imports has changed.',
    from: ['vx-lockfile/file-dir-dep'],
    workspace: fileDir('link:../../vendor/dep'),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('lib')]: 'dep\n' } } },
      { write: { 'vendor/dep/v.txt': 'dep v2\n' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['lib#build'], files: { [out('lib')]: 'dep v2\n' } },
      },
    ],
  }),

  defineCase({
    id: 'affected/file-dir-dependency-edit-selects-dependent',
    category: 'affected',
    kind: 'correctness',
    title:
      'A committed edit inside a local directory dependency selects the project depending on it',
    why: 'A changed-projects check must follow the same edges a key does. The edit lies under `vendor/`, which belongs to no project, but `lib` installs that directory. If the check only maps changed paths to the project holding them, it finds nothing and CI skips `lib`, so a broken dependency merges untested.',
    from: ['vx-lockfile/file-dir-dep'],
    needs: ['affected'],
    workspace: fileDir(),
    steps: [
      { write: { 'vendor/dep/v.txt': 'dep v2\n' } },
      { commit: 'edit dep' },
      { install: true },
      { affected: 'build', base: 'HEAD~1', expect: { exit: 0, ran: ['lib#build'] } },
    ],
  }),

  defineCase({
    id: 'inputs/file-dep-inside-other-project-reruns',
    category: 'inputs',
    kind: 'correctness',
    title:
      'An edit to a local dependency kept inside another project’s directory runs the task of the project depending on it',
    why: 'A local dependency kept in another project’s directory is still the dependency of the project that installs it. When its content changes, `lib`’s installed copy changes, and `lib`’s build must run again. A runner that counts the files only for the project holding them replays `lib`’s old build.',
    from: ['vx-lockfile/extra-in-project'],
    workspace: extraInProject(),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('lib')]: 'v1\n' } } },
      { write: { 'packages/other/vendor/v.txt': 'v2\n' } },
      { install: true },
      { run: 'build', expect: { exit: 0, ran: ['lib#build'], files: { [out('lib')]: 'v2\n' } } },
    ],
  }),

  defineCase({
    id: 'affected/file-dep-inside-other-project-selects-dependent',
    category: 'affected',
    kind: 'correctness',
    title:
      'A committed edit to a local dependency kept inside another project’s directory selects the project depending on it',
    why: 'The edit is under `other`’s directory, but `lib` is the project that installs it. A changed-projects check that maps a path only to the project holding it selects `other` and skips `lib`. CI then never tests the project the change reaches, and a pull request that breaks `lib` shows green.',
    from: ['vx-lockfile/extra-in-project'],
    needs: ['affected'],
    workspace: extraInProject(),
    steps: [
      { write: { 'packages/other/vendor/v.txt': 'v2\n' } },
      { commit: 'edit dep' },
      { install: true },
      { affected: 'build', base: 'HEAD~1', expect: { exit: 0, ran: ['lib#build'] } },
    ],
  }),

  defineCase({
    id: 'affected/beside-file-dep-selects-owner-only',
    category: 'affected',
    kind: 'efficiency',
    title:
      'A committed edit beside a local dependency, in the project that holds it, selects only that project',
    why: 'Installing a local dependency from another project’s directory claims that directory, not the whole project. An edit to `other`’s source, next to it, reaches only `other`. Selecting `lib` too, or every project, makes each pull request touching `other` run tests that cannot fail from it.',
    from: ['vx-lockfile/extra-in-project'],
    needs: ['affected'],
    workspace: extraInProject(),
    steps: [
      { write: { 'packages/other/src/a.txt': 'other2\n' } },
      { commit: 'edit other' },
      {
        affected: 'build',
        base: 'HEAD~1',
        expect: { exit: 0, ran: ['other#build'], notRan: ['lib#build', 'third#build'] },
      },
    ],
  }),

  defineCase({
    id: 'inputs/link-to-workspace-dependency-change-reruns',
    category: 'inputs',
    kind: 'correctness',
    title:
      'A change to the dependencies of a workspace package linked under another name runs the linking project’s task again',
    why: '`"y": "link:../b"` installs `b` itself, so what `a` imports through `y` is everything `b` reaches. When `b`’s dependency `ms` changes, `a` loads the new `ms` too. A runner that does not follow a link into a workspace package treats `y` as opaque, and replays `a`’s build made with the old `ms`.',
    from: ['vx-lockfile/link-to-workspace'],
    workspace: {
      projects: {
        a: reader('a', { y: 'link:../b' }, 'cat node_modules/y/node_modules/ms/v.txt'),
        b: reader('b', { ms: 'file:../../vendor/ms1' }, 'cat node_modules/ms/v.txt'),
      },
      files: { ...vendored('ms1', 'ms'), ...vendored('ms2', 'ms') },
    },
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'ms1\n' } } },
      { write: { 'packages/b/package.json': manifest('b', { ms: 'file:../../vendor/ms2' }) } },
      { install: true },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'ms2\n' } } },
    ],
  }),

  defineCase({
    id: 'graph/link-to-workspace-is-dependency',
    category: 'graph',
    kind: 'correctness',
    title: 'A workspace package linked under another name is a dependency: its build runs first',
    why: '`"y": "link:../b"` installs the workspace package `b`, just as `"b": "workspace:*"` does. `a` reads `b`’s build, so `b` must build first. A runner that only treats `workspace:` as a link between projects may build both at once, and `a` then reads a missing or old `dist`, failing or shipping stale code.',
    from: ['vx-lockfile/link-to-workspace'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command: 'mkdir -p dist && cat node_modules/y/dist/out.txt src/a.txt > dist/out.txt',
              dependsOn: ['^build'],
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'package.json': manifest('a', { y: 'link:../b' }), 'src/a.txt': 'a\n' },
        },
        b: reader('b', {}, 'cat src/a.txt'),
      },
    },
    steps: [
      {
        run: 'build',
        expect: {
          exit: 0,
          order: [['b#build', 'a#build']],
          files: { [out('a')]: 'b\na\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'inputs/nested-workspace-dependency-change-reruns',
    category: 'inputs',
    kind: 'correctness',
    title:
      'A dependency change of a workspace nested in another’s directory runs the nested project’s task again',
    why: 'A workspace package can sit inside another project’s directory, and it keeps its own dependencies. When `n`’s dependency changes, `n`’s installed code changes, and its task must run again. A runner that finds a project’s dependencies by directory may give them to the outer project, and replay `n`’s old build.',
    from: ['vx-lockfile/npm-nested-workspace'],
    workspace: {
      projects: {
        a: reader('a', {}, 'cat src/a.txt'),
        n: {
          ...reader('n', { d: 'file:../../../../vendor/d1' }, 'cat node_modules/d/v.txt'),
          dir: 'packages/a/packages/n',
        },
      },
      files: { ...vendored('d1', 'd'), ...vendored('d2', 'd') },
    },
    steps: [
      {
        run: 'build',
        expect: { exit: 0, files: { 'packages/a/packages/n/dist/out.txt': 'd1\n' } },
      },
      {
        write: {
          'packages/a/packages/n/package.json': manifest('n', { d: 'file:../../../../vendor/d2' }),
        },
      },
      { install: true },
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['n#build'],
          files: { 'packages/a/packages/n/dist/out.txt': 'd2\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'inputs/nested-workspace-dependency-change-spares-outer',
    category: 'inputs',
    kind: 'efficiency',
    title:
      'A dependency change of a workspace nested in another’s directory replays the outer project’s task',
    why: 'A project inside another’s directory is a project of its own, with its own dependencies. A change to the nested project’s dependency does not touch the outer one, so the outer task should replay. A runner that folds nested manifests into the outer project reruns it on every change of the nested one.',
    from: ['vx-lockfile/npm-nested-workspace'],
    workspace: {
      projects: {
        a: reader('a', {}, 'cat src/a.txt'),
        n: {
          ...reader('n', { d: 'file:../../../../vendor/d1' }, 'cat node_modules/d/v.txt'),
          dir: 'packages/a/packages/n',
        },
      },
      files: { ...vendored('d1', 'd'), ...vendored('d2', 'd') },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      {
        write: {
          'packages/a/packages/n/package.json': manifest('n', { d: 'file:../../../../vendor/d2' }),
        },
      },
      { install: true },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
    ],
  }),

  defineCase({
    id: 'inputs/override-reruns-reaching-project',
    category: 'inputs',
    kind: 'correctness',
    title:
      'An override that forces a different transitive dependency runs the task of the project reaching it',
    why: 'An override in the root manifest can swap a package deep in a project’s dependency tree. Here `b` reaches `z` through `yy`, and the override replaces it. The project’s own manifest is unchanged, so a runner that keys only on direct dependencies replays `b`’s build with the old `z`. The resolved tree is what the task loads.',
    from: ['vx-lockfile/overrides-precise'],
    workspace: overridden(),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('b')]: 'z1\n' } } },
      {
        write: { 'package.json': rootWith(overridden(), { overrides: { z: 'file:./vendor/z2' } }) },
      },
      { install: true },
      { run: 'build', expect: { exit: 0, ran: ['b#build'], files: { [out('b')]: 'z2\n' } } },
    ],
  }),

  defineCase({
    id: 'inputs/override-spares-unreached-project',
    category: 'inputs',
    kind: 'efficiency',
    title: 'An override replays the task of a project that does not reach the overridden package',
    why: 'An override changes only the projects whose dependency tree contains the package it forces. `a` never reaches `z`, so its installed code is the same as before. A runner that treats any change to the root manifest as a change for every project rebuilds the whole workspace for a fix that touches one tree.',
    from: ['vx-lockfile/overrides-precise'],
    workspace: overridden(),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      {
        write: { 'package.json': rootWith(overridden(), { overrides: { z: 'file:./vendor/z2' } }) },
      },
      { install: true },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
    ],
  }),

  defineCase({
    id: 'inputs/override-respelled-same-resolution-replays',
    category: 'inputs',
    kind: 'efficiency',
    title: 'Respelling an override so it resolves the same package replays every task',
    why: 'What a task loads is the package an override resolves to, not how the override is written. `file:./vendor/z2` and `file:vendor/z2` install the same directory. A runner that keys on the manifest text reruns every task after a cosmetic edit. Keying on the resolution keeps the cache, and still sees a real change.',
    from: ['vx-lockfile/overrides-precise'],
    workspace: overridden({ z: 'file:./vendor/z2' }),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('b')]: 'z2\n' } } },
      { write: { 'package.json': rootWith(overridden(), { overrides: { z: 'file:vendor/z2' } }) } },
      { install: true },
      { run: 'build', expect: { exit: 0, notRan: ['a#build', 'b#build'] } },
    ],
  }),

  defineCase({
    id: 'graph/root-workspace-dependency-orders-every-project',
    category: 'graph',
    kind: 'correctness',
    title:
      'A workspace package the root depends on builds before a project that reads it through the root',
    why: 'The root installs a workspace package where every project resolves it, whatever that project’s own manifest says. Here `app` reads `lib`’s build through the root, so `lib` must build first. A runner that orders tasks only by each project’s own manifest may run `app` first, and it then reads a missing or old `dist`.',
    from: ['vx-lockfile/root-workspace-dep'],
    workspace: rootDep(),
    steps: [
      {
        run: 'build',
        expect: {
          exit: 0,
          order: [['lib#build', 'app#build']],
          files: { [out('app')]: 'lib\napp\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'inputs/root-workspace-dependency-change-reruns',
    category: 'inputs',
    kind: 'correctness',
    title:
      'A change to a workspace package the root depends on runs a project reading it through the root again',
    why: 'A package the root depends on is reachable by every project, so a project that reads it depends on it even without naming it. When `lib`’s source changes, `app`’s output changes too. A runner that leaves the root’s workspace dependencies out of `app`’s key replays `app`’s old build.',
    from: ['vx-lockfile/root-workspace-dep'],
    workspace: rootDep('src'),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/lib/src/a.txt': 'lib2\n' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['app#build'], files: { [out('app')]: 'lib2\napp\n' } },
      },
    ],
  }),

  defineCase({
    id: 'graph/root-workspace-dependency-no-cycle',
    category: 'graph',
    kind: 'correctness',
    title: 'A package the root depends on that itself depends on another workspace forms no cycle',
    why: '`util` can reach `lib` through the root, but `lib` depends on `util`. Adding the root’s dependencies as an edge from every project would give `util` an edge back to `lib`, a cycle no manifest wrote. The runner would then refuse to build or pick an order at random. The root’s edge must not point a package at what depends on it.',
    from: ['vx-lockfile/root-workspace-dep'],
    workspace: rootDep(),
    steps: [
      {
        run: 'build',
        projects: ['lib'],
        expect: { exit: 0, ran: ['util#build', 'lib#build'], order: [['util#build', 'lib#build']] },
      },
    ],
  }),

  defineCase({
    id: 'affected/root-workspace-dependency-change-selects-every-reader',
    category: 'affected',
    kind: 'correctness',
    title:
      'A committed change to a workspace package the root depends on selects a project reading it through the root',
    why: 'A changed-projects check must see the same dependencies a build does. `app` reads `lib` through the root, so a change to `lib` reaches `app`. If the check only reads each project’s own manifest it selects `lib` alone, and CI never tests `app` against the change, which then breaks on main.',
    from: ['vx-lockfile/root-workspace-dep'],
    needs: ['affected'],
    workspace: rootDep('src'),
    steps: [
      { write: { 'packages/lib/src/a.txt': 'lib2\n' } },
      { commit: 'change lib' },
      { affected: 'build', base: 'HEAD~1', expect: { exit: 0, ran: ['lib#build', 'app#build'] } },
    ],
  }),
]
