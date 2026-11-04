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

/** A local package `name` beside the repository, at `../outside/<dir>`, holding v.txt = `<dir>`. */
function outsideVendored(dir: string, name: string) {
  return {
    [`${dir}/package.json`]: JSON.stringify({ name, version: '1.0.0' }),
    [`${dir}/v.txt`]: `${dir}\n`,
  }
}

/** From a project's directory to `../outside/<dir>` beside the repository. */
const OUT = '../../../outside'

/** lib → dep (`protocol` + a directory beside the repository); other depends on nothing. */
function outsideDir(protocol: 'file:' | 'link:', dir = 'dep'): WorkspaceSpec {
  return {
    projects: {
      lib: reader('lib', { dep: `${protocol}${OUT}/${dir}` }, 'cat node_modules/dep/*.txt'),
      other: reader('other', {}, 'cat src/a.txt'),
    },
    outside: { ...outsideVendored('dep', 'dep'), ...outsideVendored('dep2', 'dep') },
  }
}

/** a installs `foo` and `bar`, each a `link:` to the named vendor directory. */
function linkAliases(foo: string, bar: string): ProjectSpec {
  return reader(
    'a',
    { foo: `link:../../vendor/${foo}`, bar: `link:../../vendor/${bar}` },
    'cat node_modules/foo/v.txt node_modules/bar/v.txt',
  )
}

export default [
  defineCase({
    id: 'inputs/lockfile-dependency-change-reruns',
    category: 'inputs',
    kind: 'correctness',
    title: 'A project’s external dependency changing in the lockfile runs its task again',
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
    why: 'What a project can import through a linked workspace is that workspace’s dependencies too.',
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
    why: 'The same packages are installed, but `foo` now resolves to the other one.',
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
    why: 'A project resolves the root’s dependencies too: they are installed where every project finds them.',
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
    why: 'The lockfile names only the directory’s path, so its content is what changed.',
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
    why: 'A symlink in the directory installs as the file it names: that file is the dependency’s content.',
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
    why: 'An install copies the directory without its node_modules: nothing the task reads changed.',
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
    why: 'The edit is under `other`’s directory, but `lib` is the project that installs it.',
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
    why: '`"y": "link:../b"` installs b itself: what `a` imports through `y` is everything b reaches.',
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
    why: '`"y": "link:../b"` installs the workspace b, as `"b": "workspace:*"` does.',
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
    why: 'The root installs it where every project resolves it, whatever that project’s own manifest says.',
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
    why: 'util reaches lib through the root, but lib depends on util: an edge back would be a cycle no manifest wrote.',
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
    from: ['vx-lockfile/root-workspace-dep'],
    needs: ['affected'],
    workspace: rootDep('src'),
    steps: [
      { write: { 'packages/lib/src/a.txt': 'lib2\n' } },
      { commit: 'change lib' },
      { affected: 'build', base: 'HEAD~1', expect: { exit: 0, ran: ['lib#build', 'app#build'] } },
    ],
  }),
  // Local directory dependencies beside the repository, and `link:` ones:
  // a link installs nothing, so an edit behind it reaches the task with no
  // install, and the lockfile still names only the path.
  defineCase({
    id: 'inputs/outside-file-dependency-edit-reruns',
    category: 'inputs',
    kind: 'correctness',
    title:
      'An edit inside a `file:` dependency beside the repository runs the task of the project depending on it',
    why: 'The directory is outside the repository: no git status shows the edit, and the lockfile names only its path.',
    from: ['vx-lockfile/file-dir-dep'],
    workspace: outsideDir('file:'),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('lib')]: 'dep\n' } } },
      { write: { '../outside/dep/v.txt': 'dep v2\n' } },
      { install: true },
      {
        run: 'build',
        expect: { exit: 0, ran: ['lib#build'], files: { [out('lib')]: 'dep v2\n' } },
      },
    ],
  }),

  defineCase({
    id: 'inputs/outside-file-dependency-edit-spares-others',
    category: 'inputs',
    kind: 'efficiency',
    title:
      'An edit inside a `file:` dependency beside the repository replays the projects that do not depend on it',
    from: ['vx-lockfile/file-dir-dep'],
    workspace: outsideDir('file:'),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { '../outside/dep/v.txt': 'dep v2\n' } },
      { install: true },
      { run: 'build', expect: { exit: 0, notRan: ['other#build'] } },
    ],
  }),

  defineCase({
    id: 'inputs/outside-file-dependency-retarget-reruns',
    category: 'inputs',
    kind: 'correctness',
    title:
      'Pointing a `file:` dependency at another directory beside the repository runs the task again',
    from: ['vx-lockfile/file-dir-dep', FROM_CLOSURE],
    workspace: outsideDir('file:'),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('lib')]: 'dep\n' } } },
      { write: { 'packages/lib/package.json': manifest('lib', { dep: `file:${OUT}/dep2` }) } },
      { install: true },
      { run: 'build', expect: { exit: 0, ran: ['lib#build'], files: { [out('lib')]: 'dep2\n' } } },
    ],
  }),

  defineCase({
    id: 'inputs/outside-link-dependency-edit-reruns',
    category: 'inputs',
    kind: 'correctness',
    title:
      'An edit inside a `link:` dependency beside the repository runs the task of the project depending on it, with no install',
    why: 'node_modules holds a link to the directory: the edit is what the task reads, and nothing else changed.',
    from: ['vx-lockfile/file-dir-dep'],
    workspace: outsideDir('link:'),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('lib')]: 'dep\n' } } },
      { write: { '../outside/dep/v.txt': 'dep v2\n' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['lib#build'], files: { [out('lib')]: 'dep v2\n' } },
      },
    ],
  }),

  defineCase({
    id: 'inputs/outside-link-dependency-new-file-reruns',
    category: 'inputs',
    kind: 'correctness',
    title:
      'A file added to a `link:` dependency beside the repository runs the task of the project depending on it',
    from: ['vx-lockfile/file-dir-dep'],
    workspace: outsideDir('link:'),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { '../outside/dep/w.txt': 'new\n' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['lib#build'], files: { [out('lib')]: 'dep\nnew\n' } },
      },
    ],
  }),

  defineCase({
    id: 'inputs/outside-link-dependency-edit-spares-others',
    category: 'inputs',
    kind: 'efficiency',
    title:
      'An edit inside a `link:` dependency beside the repository replays the projects that do not depend on it',
    from: ['vx-lockfile/file-dir-dep'],
    workspace: outsideDir('link:'),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { '../outside/dep/v.txt': 'dep v2\n' } },
      { run: 'build', expect: { exit: 0, notRan: ['other#build'] } },
    ],
  }),

  defineCase({
    id: 'inputs/outside-link-dependency-retarget-reruns',
    category: 'inputs',
    kind: 'correctness',
    title:
      'Pointing a `link:` dependency at another directory beside the repository runs the task again',
    from: ['vx-lockfile/file-dir-dep', FROM_CLOSURE],
    workspace: outsideDir('link:'),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('lib')]: 'dep\n' } } },
      { write: { 'packages/lib/package.json': manifest('lib', { dep: `link:${OUT}/dep2` }) } },
      { install: true },
      { run: 'build', expect: { exit: 0, ran: ['lib#build'], files: { [out('lib')]: 'dep2\n' } } },
    ],
  }),

  defineCase({
    id: 'inputs/outside-link-dependency-reinstall-replays',
    category: 'inputs',
    kind: 'efficiency',
    title:
      'Installing again with a `link:` dependency beside the repository unchanged replays the task',
    from: ['vx-lockfile/file-dir-dep'],
    workspace: outsideDir('link:'),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { install: true },
      { run: 'build', expect: { exit: 0, notRan: ['lib#build', 'other#build'] } },
    ],
  }),

  defineCase({
    id: 'inputs/link-dir-dependency-new-file-reruns',
    category: 'inputs',
    kind: 'correctness',
    title:
      'A file added to a `link:` directory dependency runs the task of the project depending on it, with no install',
    from: ['vx-lockfile/file-dir-dep'],
    workspace: fileDir('link:../../vendor/dep'),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'vendor/dep/w.txt': 'new\n' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['lib#build'], files: { [out('lib')]: 'dep\nnew\n' } },
      },
    ],
  }),

  defineCase({
    id: 'inputs/link-dir-dependency-edit-spares-others',
    category: 'inputs',
    kind: 'efficiency',
    title:
      'An edit inside a `link:` directory dependency replays the projects that do not depend on it',
    from: ['vx-lockfile/file-dir-dep'],
    workspace: fileDir('link:../../vendor/dep'),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'vendor/dep/v.txt': 'dep v2\n' } },
      { run: 'build', expect: { exit: 0, notRan: ['other#build'] } },
    ],
  }),

  defineCase({
    id: 'inputs/link-dir-dependency-retarget-reruns',
    category: 'inputs',
    kind: 'correctness',
    title:
      'Pointing a `link:` dependency at another directory in the repository runs the task again',
    from: ['vx-lockfile/file-dir-dep', FROM_CLOSURE],
    workspace: {
      projects: { lib: reader('lib', { x: 'link:../../vendor/x1' }, 'cat node_modules/x/v.txt') },
      files: { ...vendored('x1', 'x'), ...vendored('x2', 'x') },
    },
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('lib')]: 'x1\n' } } },
      { write: { 'packages/lib/package.json': manifest('lib', { x: 'link:../../vendor/x2' }) } },
      { install: true },
      { run: 'build', expect: { exit: 0, ran: ['lib#build'], files: { [out('lib')]: 'x2\n' } } },
    ],
  }),

  defineCase({
    id: 'inputs/link-dep-inside-other-project-reruns',
    category: 'inputs',
    kind: 'correctness',
    title:
      'An edit to a `link:` dependency kept inside another project’s directory runs the task of the project depending on it',
    why: 'The edit is under `other`’s directory, but `lib` is the project that reads it.',
    from: ['vx-lockfile/extra-in-project'],
    workspace: {
      ...extraInProject(),
      projects: {
        ...extraInProject().projects,
        lib: reader('lib', { dep: 'link:../other/vendor' }, 'cat node_modules/dep/v.txt'),
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('lib')]: 'v1\n' } } },
      { write: { 'packages/other/vendor/v.txt': 'v2\n' } },
      { run: 'build', expect: { exit: 0, ran: ['lib#build'], files: { [out('lib')]: 'v2\n' } } },
    ],
  }),

  defineCase({
    id: 'inputs/link-alias-swap-reruns',
    category: 'inputs',
    kind: 'correctness',
    title: 'Swapping which `link:` directories two dependency names point at runs the task again',
    why: 'The same directories are linked, but `foo` now reads the other one.',
    from: ['vx-lockfile/dependency-names'],
    workspace: {
      projects: { a: linkAliases('x1', 'y1') },
      files: { ...vendored('x1', 'x'), ...vendored('y1', 'y') },
    },
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'x1\ny1\n' } } },
      { write: { 'packages/a/package.json': linkAliases('y1', 'x1').files!['package.json']! } },
      { install: true },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'y1\nx1\n' } } },
    ],
  }),

  defineCase({
    id: 'inputs/alias-retarget-reruns',
    category: 'inputs',
    kind: 'correctness',
    title:
      'Pointing a dependency name at another package, the import name unchanged, runs the task again',
    why: 'The task imports `foo` either way; what `foo` is changed.',
    from: ['vx-lockfile/dependency-names'],
    workspace: {
      projects: { a: reader('a', { foo: 'file:../../vendor/x1' }, 'cat node_modules/foo/v.txt') },
      files: { ...vendored('x1', 'x'), ...vendored('y1', 'y') },
    },
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'x1\n' } } },
      { write: { 'packages/a/package.json': manifest('a', { foo: 'file:../../vendor/y1' }) } },
      { install: true },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'y1\n' } } },
    ],
  }),

  defineCase({
    id: 'inputs/outside-link-alias-edit-reruns',
    category: 'inputs',
    kind: 'correctness',
    title:
      'An edit behind a dependency installed under another name, linked from beside the repository, runs the task again',
    from: ['vx-lockfile/dependency-names', 'vx-lockfile/file-dir-dep'],
    workspace: {
      projects: { a: reader('a', { foo: `link:${OUT}/dep` }, 'cat node_modules/foo/v.txt') },
      outside: outsideVendored('dep', 'dep'),
    },
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'dep\n' } } },
      { write: { '../outside/dep/v.txt': 'dep v2\n' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'dep v2\n' } } },
    ],
  }),
]
