// `affected` mined from the rivals’ change detection: Turborepo’s
// affected_test / affected_rdeps_test and turborepo-scm, Nx’s touched-project
// locators, moon’s affected tracker, and vx’s own affected-*.test.ts. Graph
// shapes, file kinds and names, git states and user git config, bases, and
// workspace edits that change the graph rather than a source.
import {
  defineCase,
  type Case,
  type ProjectSpec,
  type Step,
  type TaskSpec,
  type WorkspaceSpec,
} from '../src/spec.ts'
import { chainBuild } from './shapes.ts'

/** A cached task over every file of its project. */
const ALL_FILES: TaskSpec = { command: 'true', inputs: ['**'], outputs: [] }

/** Each project's `test`: its own sources, after its own build. */
const TEST: TaskSpec = {
  command: 'cat src/a.txt',
  dependsOn: ['build'],
  inputs: ['src/**'],
  outputs: [],
}

const tests = (...names: string[]) => names.map((n) => `${n}#test`)

/** Projects each with one `test` over all its files, and nothing between them. */
function each(names: string[], over: Record<string, Partial<ProjectSpec>> = {}): WorkspaceSpec {
  return {
    projects: Object.fromEntries(
      names.map((n): [string, ProjectSpec] => [
        n,
        { tasks: { test: ALL_FILES }, files: { 'own.txt': `${n}\n` }, ...over[n] },
      ]),
    ),
  }
}

/** Projects by their dependencies; each builds them first and tests its own sources. */
function graph(deps: Record<string, string[]>, test: TaskSpec = TEST): WorkspaceSpec {
  return {
    projects: Object.fromEntries(
      Object.entries(deps).map(([n, d]): [string, ProjectSpec] => [
        n,
        {
          deps: d,
          tasks: { build: chainBuild(d), test },
          files: { 'src/a.txt': `${n}\n` },
        },
      ]),
    ),
  }
}

/** lib ← app, and docs on its own. */
const libApp = () => graph({ lib: [], app: ['lib'], docs: [] })

/**
 * `a` with a `test` over `inputs` and a `lint` over all its files, so every
 * path of `a` is some task's input; `b` with a `test` over all its files.
 */
function reader(inputs: string[], files: Record<string, string>): WorkspaceSpec {
  return {
    projects: {
      a: { tasks: { test: { command: 'true', inputs, outputs: [] }, lint: ALL_FILES }, files },
      b: { tasks: { test: ALL_FILES }, files: { 'own.txt': 'b\n' } },
    },
  }
}

const edit = (file: string, text: string): Step[] => [
  { write: { [file]: text } },
  { commit: `edit ${file}` },
]

/** `feat` changed `a`, then `main` changed `b`; `feat` is checked out. */
const DIVERGED: Step[] = [
  { sh: 'git checkout -qb feat' },
  { write: { 'packages/a/own.txt': 'a2\n' } },
  { commit: 'feat: a' },
  { sh: 'git checkout -q main' },
  { write: { 'packages/b/own.txt': 'b2\n' } },
  { commit: 'main: b' },
  { sh: 'git checkout -q feat' },
]

/** The root package.json the harness writes, with these member directories. */
function rootManifest(dirs: string[]): string {
  return JSON.stringify(
    { name: 'conformance', private: true, packageManager: `bun@${Bun.version}`, workspaces: dirs },
    null,
    2,
  )
}

/** A member's package.json as the harness writes it. */
function manifest(name: string, deps: string[] = []): string {
  return JSON.stringify(
    {
      name,
      version: '0.0.0',
      private: true,
      dependencies: Object.fromEntries(deps.map((d) => [d, 'workspace:*'])),
    },
    null,
    2,
  )
}

/** Sets a project's dependencies in the spec, keeping its tasks. */
const withDeps =
  (name: string, deps: string[]) =>
  (ws: WorkspaceSpec): WorkspaceSpec => {
    const p = ws.projects[name]!
    return {
      ...ws,
      projects: {
        ...ws.projects,
        [name]: { ...p, deps, tasks: { ...p.tasks, build: chainBuild(deps) } },
      },
    }
  }

/** `app` reads every root `shared/*.txt` through its build. */
function sharedReader(): WorkspaceSpec {
  return {
    projects: {
      app: {
        tasks: {
          build: {
            command: 'cat ../../shared/*.txt',
            inputs: ['src/**'],
            rootInputs: ['shared/**'],
            outputs: [],
          },
        },
        files: { 'src/index.txt': 'app\n' },
      },
      other: { tasks: { build: ALL_FILES }, files: { 'own.txt': 'o\n' } },
    },
    files: { 'shared/one.txt': '1\n', 'shared/two.txt': '2\n' },
  }
}

export default [
  // --- Graph shapes: how far a change reaches ---

  // moon crates/affected affected_tracker: dependents at every depth; Turborepo affected_rdeps_test.
  defineCase({
    id: 'affected/chain-change-reaches-top',
    category: 'affected',
    kind: 'correctness',
    title: 'A change at the bottom of a five-project chain selects every project above it',
    why: 'Each project in a chain builds on the one below, so a change at the bottom can break the top as surely as the next one up. The walk over dependents must keep going to the end, not stop after one hop. A tool that only adds direct dependents leaves three of the five projects untested.',
    from: ['affected-tasks', 'affected-dependents'],
    needs: ['affected'],
    workspace: graph({ a: [], b: ['a'], c: ['b'], d: ['c'], e: ['d'] }),
    steps: [
      ...edit('packages/a/src/a.txt', 'a2\n'),
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, ran: tests('a', 'b', 'c', 'd', 'e') },
      },
    ],
  }),

  // moon affected_tracker: dependents only, never dependencies.
  defineCase({
    id: 'affected/chain-middle-change-goes-up',
    category: 'affected',
    kind: 'efficiency',
    title: 'A change in the middle of a chain selects the projects above it, not those below',
    why: 'A change can only reach projects built on top of it. The projects below the edited one do not read it, so their tests have the same result as before. Their builds may still run so the edited project has what it needs, but selecting their tests too reruns checks nothing could have changed.',
    from: ['affected-tasks', 'affected-dependents'],
    needs: ['affected'],
    workspace: graph({ a: [], b: ['a'], c: ['b'], d: ['c'], e: ['d'] }),
    steps: [
      ...edit('packages/c/src/a.txt', 'c2\n'),
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, ran: tests('c', 'd', 'e'), notRan: tests('a', 'b') },
      },
    ],
  }),

  // vx affected-tasks "a diamond reaches through either arm", at the project level.
  defineCase({
    id: 'affected/project-diamond-base-change',
    category: 'affected',
    kind: 'correctness',
    title: 'A change at the base of a diamond of projects selects both arms and the top',
    why: 'In a diamond, the top reaches the base through two arms. A change at the base reaches every project in it. A walk that marks the top as seen through one arm and then skips the other arm, or that stops at the first visited project, leaves part of the diamond untested.',
    from: ['affected-tasks'],
    needs: ['affected'],
    workspace: graph({ base: [], left: ['base'], right: ['base'], top: ['left', 'right'] }),
    steps: [
      ...edit('packages/base/src/a.txt', 'base2\n'),
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, ran: tests('base', 'left', 'right', 'top') },
      },
    ],
  }),

  defineCase({
    id: 'affected/project-diamond-arm-change',
    category: 'affected',
    kind: 'efficiency',
    title: 'A change in one arm of a diamond selects that arm and the top, not the other arm',
    why: 'The other arm and the base sit beside or below the change, so nothing they read differs. Only the edited arm and the projects built on it can see the edit. Selecting the whole diamond because the projects are related reruns two projects whose results are already known.',
    from: ['affected-tasks'],
    needs: ['affected'],
    workspace: graph({ base: [], left: ['base'], right: ['base'], top: ['left', 'right'] }),
    steps: [
      ...edit('packages/left/src/a.txt', 'left2\n'),
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, ran: tests('left', 'top'), notRan: tests('right', 'base') },
      },
    ],
  }),

  // Turborepo affected_rdeps_test test_affected_includes_reverse_deps.
  defineCase({
    id: 'affected/fan-out-dependents',
    category: 'affected',
    kind: 'correctness',
    title:
      'A change in a library six projects use selects all six and leaves the unrelated one out',
    why: 'A shared library is where one edit reaches the most code. Every project that depends on it must be selected, however many there are, and a project that does not use it must not be. Missing even one dependent lets a breaking library change merge with a red project nobody ran.',
    from: ['affected-dependents'],
    needs: ['affected'],
    workspace: graph({
      lib: [],
      u1: ['lib'],
      u2: ['lib'],
      u3: ['lib'],
      u4: ['lib'],
      u5: ['lib'],
      u6: ['lib'],
      alone: [],
    }),
    steps: [
      ...edit('packages/lib/src/a.txt', 'lib2\n'),
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: {
          exit: 0,
          ran: tests('lib', 'u1', 'u2', 'u3', 'u4', 'u5', 'u6'),
          notRan: tests('alone'),
        },
      },
    ],
  }),

  defineCase({
    id: 'affected/fan-in-one-dependency-changed',
    category: 'affected',
    kind: 'efficiency',
    title: 'When one of an app’s three dependencies changes, its two siblings stay out',
    why: 'The app depends on all three libraries, but the other two libraries do not depend on the changed one. Their tests read nothing that changed. Selecting every dependency of an affected project, rather than every dependent of a changed one, walks the graph the wrong way and reruns them.',
    from: ['affected-dependents'],
    needs: ['affected'],
    workspace: graph({ x: [], y: [], z: [], app: ['x', 'y', 'z'] }),
    steps: [
      ...edit('packages/y/src/a.txt', 'y2\n'),
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, ran: tests('y', 'app'), notRan: tests('x', 'z') },
      },
    ],
  }),

  defineCase({
    id: 'affected/separate-graphs-stay-apart',
    category: 'affected',
    kind: 'efficiency',
    title: 'A change in one of two unconnected chains selects only that chain',
    why: 'Two chains with no edge between them cannot see each other’s changes. A change at the bottom of one selects that chain end to end and nothing of the other. A tool that widens to the whole workspace whenever a change has dependents runs the other chain for no reason.',
    from: ['affected-dependents'],
    needs: ['affected'],
    workspace: graph({ a1: [], a2: ['a1'], a3: ['a2'], b1: [], b2: ['b1'], b3: ['b2'] }),
    steps: [
      ...edit('packages/b1/src/a.txt', 'b1x\n'),
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, ran: tests('b1', 'b2', 'b3'), notRan: tests('a1', 'a2', 'a3') },
      },
    ],
  }),

  // vx affected-sparse-tasks "a ^test edge makes the dependent affected, in the list and the run alike".
  defineCase({
    id: 'affected/test-edge-reaches-dependents',
    category: 'affected',
    kind: 'correctness',
    title:
      'When each test waits on its dependencies’ tests, a change in a library selects its dependents’ tests',
    why: 'Here the dependent’s `test` waits directly on the library’s `test`, with no build in between. That edge is how the change reaches it, and it counts as much as a build edge. A tool that only follows build edges, or only the package graph for one task name, leaves the dependent’s test out.',
    from: ['affected-sparse-tasks'],
    needs: ['affected'],
    workspace: {
      projects: {
        lib: {
          tasks: {
            test: { command: 'true', dependsOn: ['^test'], inputs: ['src/**'], outputs: [] },
          },
          files: { 'src/a.txt': 'lib\n' },
        },
        app: {
          deps: ['lib'],
          tasks: {
            test: { command: 'true', dependsOn: ['^test'], inputs: ['src/**'], outputs: [] },
          },
          files: { 'src/a.txt': 'app\n' },
        },
      },
    },
    steps: [
      ...edit('packages/lib/src/a.txt', 'lib2\n'),
      { affected: 'test', base: 'HEAD~1', expect: { exit: 0, ran: tests('lib', 'app') } },
    ],
  }),

  defineCase({
    id: 'affected/unchanged-dependency-test-runs-first',
    category: 'affected',
    kind: 'correctness',
    title:
      'An affected test that waits on its dependency’s test gets that test run first, unchanged or not',
    why: 'Selection picks which tasks were asked for; the edges each of them declares still hold. The app’s `test` waits on the library’s `test`, so the library’s test must run, or be replayed, before it even though the library did not change. Dropping it runs the app’s test without what it declared it needs.',
    from: ['affected-sparse-tasks', 'affected-dependents'],
    needs: ['affected'],
    workspace: {
      projects: {
        lib: {
          tasks: {
            test: {
              command: 'echo ok > ../../lib-tested',
              dependsOn: ['^test'],
              inputs: ['src/**'],
              cache: false,
            },
          },
          files: { 'src/a.txt': 'lib\n' },
        },
        app: {
          deps: ['lib'],
          tasks: {
            test: {
              command: 'cat ../../lib-tested',
              dependsOn: ['^test'],
              inputs: ['src/**'],
              cache: false,
            },
          },
          files: { 'src/a.txt': 'app\n' },
        },
      },
    },
    steps: [
      ...edit('packages/app/src/a.txt', 'app2\n'),
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, ran: tests('lib', 'app'), order: [['lib#test', 'app#test']] },
      },
    ],
  }),

  // --- What a change can be: file kinds and names ---

  // turborepo-scm: binary diffs list a path like any other.
  defineCase({
    id: 'affected/binary-file-change',
    category: 'affected',
    kind: 'correctness',
    title: 'A changed binary file, such as an image, selects its project',
    why: 'Images, fonts and other binary assets are inputs like any source. git shows no line diff for them, but they changed all the same. A tool that reads changes from a text diff, or skips files git calls binary, leaves the project that bundles the asset untested.',
    from: ['affected'],
    needs: ['affected'],
    workspace: each(['a', 'b']),
    steps: [
      { sh: "printf '\\211PNG\\000\\001\\377' > packages/a/logo.png" },
      { commit: 'logo' },
      { sh: "printf '\\211PNG\\000\\002\\377' > packages/a/logo.png" },
      { commit: 'new logo' },
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, ran: tests('a'), notRan: tests('b') },
      },
    ],
  }),

  // vx affected-unicode "a changed file with a non-ASCII or spaced name selects its project".
  defineCase({
    id: 'affected/spaces-in-file-and-dir-names',
    category: 'affected',
    kind: 'correctness',
    title: 'A changed file with spaces in its name or its directory’s name selects its project',
    why: 'Names with spaces are common in docs, fixtures and assets. A tool that splits git’s output on whitespace turns one such path into several that match no project. The edit is then dropped, untracked or committed, and the project that owns it is not tested.',
    from: ['affected-unicode'],
    needs: ['affected'],
    workspace: each(['a', 'b']),
    steps: [
      { write: { 'packages/a/my notes.txt': 'v1\n', 'packages/a/sub dir/x y.txt': 'v1\n' } },
      { affected: 'test', base: 'HEAD', expect: { exit: 0, ran: tests('a'), notRan: tests('b') } },
      { commit: 'spaced' },
      { write: { 'packages/a/sub dir/x y.txt': 'v2\n' } },
      { commit: 'spaced edit' },
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, ran: tests('a'), notRan: tests('b') },
      },
    ],
  }),

  // vx affected-dry-reasons "a control character in a changed file name is escaped".
  defineCase({
    id: 'affected/control-chars-in-file-name',
    category: 'affected',
    kind: 'correctness',
    title: 'A changed file whose name holds a tab or a newline selects its project',
    why: 'A tab or a newline is legal in a file name on Linux and macOS. git quotes such names in its plain output, and a reader that splits on lines cuts one path into two. Neither half matches a project, so the change disappears unless the tool reads git’s output in its NUL-separated form.',
    from: ['affected-dry-reasons'],
    needs: ['affected'],
    workspace: each(['a', 'b']),
    steps: [
      { write: { 'packages/b/odd\tname\nhere.txt': 'v1\n' } },
      { affected: 'test', base: 'HEAD', expect: { exit: 0, ran: tests('b'), notRan: tests('a') } },
      { commit: 'odd' },
      { write: { 'packages/b/odd\tname\nhere.txt': 'v2\n' } },
      { commit: 'odd edit' },
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, ran: tests('b'), notRan: tests('a') },
      },
    ],
  }),

  // Next.js routes (`[id]`, `(group)`) through glob matching of changed paths.
  defineCase({
    id: 'affected/glob-chars-in-file-name',
    category: 'affected',
    kind: 'correctness',
    title:
      'A changed file named like a route, `[id].txt` or `(group)/page.txt`, selects its project',
    why: 'Frameworks name files with brackets and parentheses, like `[id]` for a dynamic route. When a tool matches the changed path against input globs, those characters must be taken literally on the path side. A matcher that treats the path as a pattern finds no match, and the project whose route changed is skipped.',
    from: ['affected-head-range'],
    needs: ['affected'],
    workspace: reader(['src/**'], { 'src/index.txt': 'a\n' }),
    steps: [
      { write: { 'packages/a/src/[id].txt': 'v1\n', 'packages/a/src/(group)/page.txt': 'v1\n' } },
      { commit: 'routes' },
      { write: { 'packages/a/src/[id].txt': 'v2\n' } },
      { commit: 'id' },
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, ran: tests('a'), notRan: tests('b') },
      },
      { write: { 'packages/a/src/(group)/page.txt': 'v2\n' } },
      { commit: 'group' },
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, ran: tests('a'), notRan: tests('b') },
      },
    ],
  }),

  // --- Input globs as selection reads them ---

  // vx affected-head-range "reads a spelling the way the KEY reads it".
  defineCase({
    id: 'affected/brace-input-glob',
    category: 'affected',
    kind: 'correctness',
    title:
      'An input glob with a brace list, `src/**/*.{txt,md}`, selects on either extension and not on others',
    why: 'Brace lists are a common way to name several extensions in one input glob. Selection must expand them as the cache key does. Read literally, the glob matches nothing and the task is never selected; ignored, it matches every file and the task is selected on edits it does not read.',
    from: ['affected-head-range'],
    needs: ['affected'],
    workspace: reader(['src/**/*.{txt,md}'], { 'src/a.txt': 'a\n' }),
    steps: [
      { write: { 'packages/a/src/data.json': '{}\n' } },
      { affected: 'test', base: 'HEAD', expect: { exit: 0, notRan: tests('a', 'b') } },
      { write: { 'packages/a/src/notes.md': 'notes\n' } },
      { affected: 'test', base: 'HEAD', expect: { exit: 0, ran: tests('a'), notRan: tests('b') } },
    ],
  }),

  defineCase({
    id: 'affected/single-star-input-stays-in-dir',
    category: 'affected',
    kind: 'efficiency',
    title: 'An input glob `*.txt` selects on a top-level file, not on one in a subdirectory',
    why: 'A single `*` matches within one directory; only `**` crosses into subdirectories. A task over `*.txt` does not read `sub/deep.txt`, so editing that file cannot change its result. Reading `*` as `**` during selection reruns the task on edits it never sees.',
    from: ['affected-head-range'],
    needs: ['affected'],
    workspace: reader(['*.txt'], { 'top.txt': 'top\n', 'sub/deep.txt': 'deep\n' }),
    steps: [
      ...edit('packages/a/sub/deep.txt', 'deep2\n'),
      { affected: 'test', base: 'HEAD~1', expect: { exit: 0, notRan: tests('a', 'b') } },
      ...edit('packages/a/top.txt', 'top2\n'),
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, ran: tests('a'), notRan: tests('b') },
      },
    ],
  }),

  // Turborepo affected_test test_task_level_affected_iff_task_hash_changes: ["src", "!src/gen"].
  defineCase({
    id: 'affected/bare-directory-exclude',
    category: 'affected',
    kind: 'efficiency',
    title:
      'An input exclude naming a bare directory, `!src/gen`, keeps edits under it from selecting',
    why: 'An exclude written as a bare directory leaves out the files under it, the same way a bare directory input takes them in. The task does not read `src/gen`, so editing a file there cannot change its result. Applying the exclude only to a path equal to `src/gen` reruns the task on every generated-file edit.',
    from: ['affected-head-range'],
    needs: ['affected'],
    workspace: reader(['src', '!src/gen'], { 'src/index.txt': 'a\n', 'src/gen/out.txt': 'gen\n' }),
    steps: [
      ...edit('packages/a/src/gen/out.txt', 'gen2\n'),
      { affected: 'test', base: 'HEAD~1', expect: { exit: 0, notRan: tests('a', 'b') } },
    ],
  }),

  defineCase({
    id: 'affected/dot-directory-input',
    category: 'affected',
    kind: 'correctness',
    title: 'An edit under a dot directory a task names as an input, `.storybook/**`, selects it',
    why: 'Tool config often lives in dot directories such as `.storybook` or `.config`. When a task names one as an input, an edit there must select the task. A matcher that skips dot paths by default, as many glob libraries do, never selects it, and the task keeps its old result.',
    from: ['affected-head-range'],
    needs: ['affected'],
    workspace: reader(['src/**', '.storybook/**'], {
      'src/a.txt': 'a\n',
      '.storybook/main.txt': 'one\n',
    }),
    steps: [
      ...edit('packages/a/.storybook/main.txt', 'two\n'),
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, ran: tests('a'), notRan: tests('b') },
      },
    ],
  }),

  // turborepo-scm: `git status` reports a new directory, not its files, unless asked for every file.
  defineCase({
    id: 'affected/untracked-new-directory',
    category: 'affected',
    kind: 'correctness',
    title: 'A new untracked directory of sources selects a task whose glob names files in it',
    why: 'By default git reports a whole new directory as one entry, `src/feature/`, not the files inside it. That entry matches no `src/**/*.txt` glob, though the files under it do. A tool must look at the files themselves, or a developer’s new feature folder selects nothing until it is committed.',
    from: ['affected', 'affected-pass-through'],
    needs: ['affected'],
    workspace: reader(['src/**/*.txt'], { 'src/a.txt': 'a\n' }),
    steps: [
      { write: { 'packages/a/src/feature/deep/x.txt': 'x\n' } },
      { affected: 'test', base: 'HEAD', expect: { exit: 0, ran: tests('a'), notRan: tests('b') } },
    ],
  }),

  // --- What git ignores, by every source of ignore rules ---

  // vx affected "ignores untracked files that git excludes".
  defineCase({
    id: 'affected/info-exclude-selects-nothing',
    category: 'affected',
    kind: 'efficiency',
    title: 'A new file ignored through `.git/info/exclude` selects nothing',
    why: 'Developers keep local scratch files out of git with `.git/info/exclude`, which is not committed and not a `.gitignore`. git treats those files as ignored like any other. A tool that reads only `.gitignore` files sees them as new sources and selects the project on every machine that has them.',
    from: ['affected'],
    needs: ['affected'],
    workspace: each(['a', 'b']),
    steps: [
      { sh: "printf 'scratch/\\n' >> .git/info/exclude" },
      { write: { 'packages/a/scratch/notes.txt': 'mine\n' } },
      { affected: 'test', base: 'HEAD', expect: { exit: 0, notRan: tests('a', 'b') } },
    ],
  }),

  defineCase({
    id: 'affected/excludes-file-selects-nothing',
    category: 'affected',
    kind: 'efficiency',
    title: 'A new file ignored through git’s `core.excludesFile` selects nothing',
    why: 'Editor and OS clutter like `.DS_Store` or `*.swp` is usually ignored through a personal excludes file, named by `core.excludesFile`. git treats those files as ignored. A tool that reimplements ignore rules from the `.gitignore` files alone selects projects on one developer’s machine and not another’s.',
    from: ['affected'],
    needs: ['affected'],
    workspace: each(['a', 'b']),
    steps: [
      {
        sh: 'printf \'*.swp\\n\' > .home/excludes && git config core.excludesFile "$PWD/.home/excludes"',
      },
      { write: { 'packages/a/.own.txt.swp': 'editor\n' } },
      { affected: 'test', base: 'HEAD', expect: { exit: 0, notRan: tests('a', 'b') } },
    ],
  }),

  // --- Links and type changes ---

  // vx affected-linked-inputs: a link is a path of its project.
  defineCase({
    id: 'affected/link-retargeted',
    category: 'affected',
    kind: 'correctness',
    title: 'Pointing a link at another file selects the link’s project',
    why: 'Retargeting a link changes what a task reads through it, though neither target file changed. git records it as an edit of the link itself. A tool that only looks at regular files, or hashes only the targets, misses the change and the task keeps reading the old file’s result.',
    from: ['affected-linked-inputs'],
    needs: ['affected'],
    workspace: reader(['src/**'], { 'src/one.txt': 'one\n', 'src/two.txt': 'two\n' }),
    steps: [
      { link: { 'packages/a/src/cur.txt': 'one.txt' } },
      { commit: 'link' },
      { link: { 'packages/a/src/cur.txt': 'two.txt' } },
      { commit: 'retarget' },
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, ran: tests('a'), notRan: tests('b') },
      },
    ],
  }),

  // turborepo-scm: a typechange entry (`T`) in git's diff.
  defineCase({
    id: 'affected/file-replaced-by-link',
    category: 'affected',
    kind: 'correctness',
    title: 'Replacing a file with a link to another file selects its project',
    why: 'Turning a file into a link changes its type and what a task reads through it. git reports this as a type change, a status some parsers do not expect. Dropping that entry leaves the project untested though its input now reads different bytes.',
    from: ['affected-linked-inputs'],
    needs: ['affected'],
    workspace: reader(['src/**'], { 'src/cur.txt': 'old\n', 'src/two.txt': 'two\n' }),
    steps: [
      { link: { 'packages/a/src/cur.txt': 'two.txt' } },
      { commit: 'to link' },
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, ran: tests('a'), notRan: tests('b') },
      },
    ],
  }),

  defineCase({
    id: 'affected/link-replaced-by-file',
    category: 'affected',
    kind: 'correctness',
    title: 'Replacing a link with a regular file selects its project',
    why: 'The reverse type change, a link made a plain file, also changes what the task reads. git reports it as a type change on the same path. Treating it as no change, or only as a change to the old target, leaves the project untested.',
    from: ['affected-linked-inputs'],
    needs: ['affected'],
    workspace: reader(['src/**'], { 'src/two.txt': 'two\n' }),
    steps: [
      { link: { 'packages/a/src/cur.txt': 'two.txt' } },
      { commit: 'link' },
      { sh: 'rm packages/a/src/cur.txt && printf "own\\n" > packages/a/src/cur.txt' },
      { commit: 'to file' },
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, ran: tests('a'), notRan: tests('b') },
      },
    ],
  }),

  // vx affected-flagged "an assume-unchanged file whose directory is now a file".
  defineCase({
    id: 'affected/file-replaced-by-directory',
    category: 'affected',
    kind: 'correctness',
    title: 'Replacing a file with a directory of the same name selects its project',
    why: 'When `src/x` goes from a file to a directory holding files, git reports one deleted path and new paths under it. Both sides belong to the project. A tool that stats the old path and finds a directory, or skips it as no file, can lose the change and leave the project untested.',
    from: ['affected-flagged'],
    needs: ['affected'],
    workspace: reader(['src/**'], { 'src/x': 'file\n' }),
    steps: [
      {
        sh: 'rm packages/a/src/x && mkdir packages/a/src/x && printf "in\\n" > packages/a/src/x/inner.txt',
      },
      { commit: 'dir' },
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, ran: tests('a'), notRan: tests('b') },
      },
    ],
  }),

  // Turborepo affected_test test_task_level_affected_tracked_outputs_match_hashes (Deleted).
  defineCase({
    id: 'affected/last-input-deleted',
    category: 'affected',
    kind: 'correctness',
    title: 'Deleting the only file a task’s inputs match selects that task',
    why: 'When the last input goes away, the task’s input set becomes empty, which is a change like any other. Its result can differ, for example a build with no sources should now fail. A tool that only selects tasks with a matching file still present finds no match and skips it.',
    from: ['affected-moves'],
    needs: ['affected'],
    workspace: reader(['src/**'], { 'src/only.txt': 'a\n', 'README.md': 'a\n' }),
    steps: [
      { sh: 'git rm -q packages/a/src/only.txt' },
      { commit: 'drop source' },
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, ran: tests('a'), notRan: tests('b') },
      },
    ],
  }),

  // vx affected-moves "a change outside every project selects none", for a move.
  defineCase({
    id: 'affected/move-out-of-every-project',
    category: 'affected',
    kind: 'correctness',
    title:
      'Moving a file out of a project to a directory no project owns selects only that project',
    why: 'A move out of a project removes an input from it, so the project must run. The new path belongs to no project, so nothing else is selected. A tool that keys a rename by its destination alone finds no owner and selects nothing.',
    from: ['affected-moves'],
    needs: ['affected'],
    workspace: each(['a', 'b'], { a: { files: { 'own.txt': 'a\n', 'extra.txt': 'extra\n' } } }),
    steps: [
      { sh: 'mkdir -p archive && git mv packages/a/extra.txt archive/extra.txt' },
      { commit: 'archive' },
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, ran: tests('a'), notRan: tests('b') },
      },
    ],
  }),

  // Turborepo affected_rdeps_test test_staged_rename_affects_source_destination_and_reverse_deps.
  defineCase({
    id: 'affected/staged-move-reaches-source-dependents',
    category: 'affected',
    kind: 'correctness',
    title:
      'A staged move out of a library selects the library, its dependents and the project it moved to',
    why: 'The library lost a source, so what its dependents build on changed too. The destination gained one. All three must run: a tool that maps the rename to its destination alone, or that adds dependents only for the destination, leaves the library’s dependents untested.',
    from: ['affected-moves'],
    needs: ['affected'],
    workspace: libApp(),
    steps: [
      ...edit('packages/lib/src/extra.txt', 'a file that moves\n'),
      { sh: 'git mv packages/lib/src/extra.txt packages/docs/src/moved.txt' },
      { affected: 'test', base: 'HEAD', expect: { exit: 0, ran: tests('lib', 'app', 'docs') } },
    ],
  }),

  // --- Git states the working tree can be in ---

  defineCase({
    id: 'affected/empty-commit-selects-nothing',
    category: 'affected',
    kind: 'efficiency',
    title: 'An empty commit since the base selects nothing',
    why: 'A commit with no file changes, as CI retriggers and some merge tools make, changes no input. Comparing the base with it gives an empty diff, so nothing is affected and the run succeeds with nothing to do. Reading the new commit itself as a change runs the whole workspace.',
    from: ['affected-head-range'],
    needs: ['affected'],
    workspace: libApp(),
    steps: [
      { sh: 'git commit -q --allow-empty -m retrigger' },
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, notRan: tests('lib', 'app', 'docs') },
      },
    ],
  }),

  // vx affected-head-range: the working tree is compared with the base, not each step in between.
  defineCase({
    id: 'affected/uncommitted-revert-selects-nothing',
    category: 'affected',
    kind: 'efficiency',
    title: 'A committed edit undone in the working tree, not yet committed, selects nothing',
    why: 'Tasks read the working tree, and here it holds exactly the base’s bytes again. Nothing a task reads differs from the base, so nothing is affected. A tool that adds the base-to-HEAD diff to the HEAD-to-working-tree diff counts the file twice and selects the project and its dependents.',
    from: ['affected-head-range'],
    needs: ['affected'],
    workspace: libApp(),
    steps: [
      ...edit('packages/lib/src/a.txt', 'lib2\n'),
      { write: { 'packages/lib/src/a.txt': 'lib\n' } },
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, notRan: tests('lib', 'app', 'docs') },
      },
    ],
  }),

  defineCase({
    id: 'affected/committed-and-uncommitted-together',
    category: 'affected',
    kind: 'correctness',
    title:
      'A base one commit back selects both what that commit changed and what is still uncommitted',
    why: 'A developer checks a branch that has commits and more edits on top. Both are part of what the tasks will read. Comparing only commits misses the edit in progress, and comparing only the working tree with HEAD misses the commit; either leaves a project untested.',
    from: ['affected-head-range'],
    needs: ['affected'],
    workspace: libApp(),
    steps: [
      ...edit('packages/lib/src/a.txt', 'lib2\n'),
      { write: { 'packages/docs/src/a.txt': 'docs2\n' } },
      { affected: 'test', base: 'HEAD~1', expect: { exit: 0, ran: tests('lib', 'app', 'docs') } },
    ],
  }),

  defineCase({
    id: 'affected/intent-to-add-file',
    category: 'affected',
    kind: 'correctness',
    title: 'A new file marked with `git add -N` selects its project',
    why: 'An intent-to-add entry is in the index with no content, so it is neither untracked nor a normal staged file. git reports it in its own way in status and diff. The file is on disk and tasks read it, so its project must be selected whatever form git uses to report it.',
    from: ['affected-flagged'],
    needs: ['affected'],
    workspace: each(['a', 'b']),
    steps: [
      { write: { 'packages/a/new.txt': 'new\n' } },
      { sh: 'git add -N packages/a/new.txt' },
      { affected: 'test', base: 'HEAD', expect: { exit: 0, ran: tests('a'), notRan: tests('b') } },
    ],
  }),

  // vx affected-base-notes "a rebase stopped on a conflict"; git status `UU` entries.
  defineCase({
    id: 'affected/unmerged-conflict',
    category: 'affected',
    kind: 'correctness',
    title: 'A file left conflicted by a merge selects its project, and no other',
    why: 'A merge that stops on a conflict leaves the file with conflict markers and an unmerged entry in the index. A developer resolving it runs the affected tasks to check their work. The conflicted file is a changed input; a parser that does not expect `UU` entries drops it, or a tool that cannot read the index fails the run.',
    from: ['affected-base-notes'],
    needs: ['affected'],
    workspace: each(['a', 'b']),
    steps: [
      { sh: 'git checkout -qb feat' },
      ...edit('packages/a/own.txt', 'feat\n'),
      { sh: 'git checkout -q main' },
      ...edit('packages/a/own.txt', 'main\n'),
      { sh: 'git merge -q feat >/dev/null 2>&1; test -f .git/MERGE_HEAD' },
      { affected: 'test', base: 'HEAD', expect: { exit: 0, ran: tests('a'), notRan: tests('b') } },
    ],
  }),

  // vx affected-base-notes "a detached HEAD the base branch holds"; CI checks out a commit, not a branch.
  defineCase({
    id: 'affected/detached-head',
    category: 'affected',
    kind: 'correctness',
    title:
      'On a detached HEAD, as CI checks out a commit, a branch base selects what the commit added',
    why: 'Most CI systems check out the commit under test with no branch. The comparison is between that commit and the base, and needs no current branch name. A tool that asks git for the current branch, and fails or falls back to everything without one, breaks every CI run.',
    from: ['affected-base-notes'],
    needs: ['affected'],
    workspace: each(['a', 'b']),
    steps: [
      { sh: 'git checkout -qb feat' },
      ...edit('packages/a/own.txt', 'a2\n'),
      { sh: 'git checkout -q --detach && git branch -qD feat' },
      { affected: 'test', base: 'main', expect: { exit: 0, ran: tests('a'), notRan: tests('b') } },
    ],
  }),

  // --- Bases ---

  defineCase({
    id: 'affected/branch-base-with-slash',
    category: 'affected',
    kind: 'correctness',
    title: 'A base branch with a slash in its name, `release/1.0`, works as a base',
    why: 'Release and team branches are named with slashes, such as `release/1.0` or `team/main`. The name must reach git whole, as a ref. A tool that splits on `/`, or reads the first part as a remote, resolves the wrong commit or none.',
    from: ['affected-shallow'],
    needs: ['affected'],
    workspace: each(['a', 'b']),
    steps: [
      { sh: 'git branch release/1.0' },
      ...edit('packages/b/own.txt', 'b2\n'),
      {
        affected: 'test',
        base: 'release/1.0',
        expect: { exit: 0, ran: tests('b'), notRan: tests('a') },
      },
    ],
  }),

  // Turborepo affected_test test_affected_merge_base_diverged; no merge base at all.
  defineCase({
    id: 'affected/unrelated-history-base',
    category: 'affected',
    kind: 'correctness',
    title:
      'A base with no history in common with HEAD fails the run or runs everything, never nothing',
    why: 'When the base shares no commit with HEAD, as after a history rewrite or with an imported repository, there is no merge base to compare from. The tool cannot say what this branch changed. It must fail or treat everything as changed; treating the missing merge base as no change runs nothing and passes.',
    from: ['affected-shallow'],
    needs: ['affected'],
    workspace: each(['a', 'b']),
    steps: [
      { sh: 'git branch other "$(git commit-tree -m other "$(git mktree </dev/null)")"' },
      { write: { 'packages/a/own.txt': 'a2\n' } },
      { affected: 'test', base: 'other', expect: { ran: tests('a', 'b'), orRefused: true } },
    ],
  }),

  defineCase({
    id: 'affected/base-ahead-of-head',
    category: 'affected',
    kind: 'efficiency',
    title: 'A base that is ahead of HEAD selects nothing this branch did not change',
    why: 'When the base already contains HEAD, as when checking an old branch against a newer main, this branch made no change of its own. The merge base is HEAD itself, so nothing is affected. Diffing straight against the base selects everything main added since, which is not this branch’s work.',
    from: ['affected-shallow'],
    needs: ['affected'],
    workspace: each(['a', 'b']),
    steps: [
      { sh: 'git checkout -qb next' },
      ...edit('packages/b/own.txt', 'b2\n'),
      { sh: 'git checkout -q main' },
      { affected: 'test', base: 'next', expect: { exit: 0, notRan: tests('a', 'b') } },
    ],
  }),

  defineCase({
    id: 'affected/merge-second-parent-base',
    category: 'affected',
    kind: 'correctness',
    title:
      'On a merge commit, the second parent as base selects what the first parent’s side brought',
    why: 'Comparing a merge with its second parent asks what the merge added on top of the merged branch: the other side’s work. That is the project main changed, not the one the branch changed. A tool that always diffs against the first parent, or confuses the two, selects the wrong project.',
    from: ['affected-shallow'],
    needs: ['affected'],
    workspace: each(['a', 'b']),
    steps: [
      ...DIVERGED,
      { sh: 'git checkout -q main && git merge -q --no-ff -m merge feat' },
      {
        affected: 'test',
        base: 'HEAD^2',
        expect: { exit: 0, ran: tests('b'), notRan: tests('a') },
      },
    ],
  }),

  defineCase({
    id: 'affected/rebased-branch',
    category: 'affected',
    kind: 'efficiency',
    title: 'After rebasing a branch onto main, main as base selects only the branch’s own work',
    why: 'A rebase replays the branch’s commits on top of main, so main’s newer commits are now ancestors of HEAD. Comparing with main gives only what the branch adds. A tool that remembers the old fork point, or diffs against the branch’s previous base, also selects what main changed.',
    from: ['affected-shallow'],
    needs: ['affected'],
    workspace: each(['a', 'b']),
    steps: [
      ...DIVERGED,
      { sh: 'git rebase -q main' },
      { affected: 'test', base: 'main', expect: { exit: 0, ran: tests('a'), notRan: tests('b') } },
    ],
  }),

  // vx affected-head-range "reads <base>...HEAD as <base>, and refuses any other range".
  defineCase({
    id: 'affected/three-dot-range-base',
    category: 'affected',
    kind: 'efficiency',
    title: 'A base written as a range, `main...HEAD`, selects only the branch’s work or is refused',
    why: 'CI scripts often pass `origin/main...HEAD`, the range a pull request shows. Read as its start from the merge base, it selects what the branch changed. A tool may refuse a range it does not support, but resolving it to something else and selecting main’s own changes runs the wrong tests.',
    from: ['affected-head-range'],
    needs: ['affected'],
    workspace: each(['a', 'b']),
    steps: [
      ...DIVERGED,
      {
        affected: 'test',
        base: 'main...HEAD',
        expect: { ran: tests('a'), notRan: tests('b'), orRefused: true },
      },
    ],
  }),

  // --- A user's git config ---

  // turborepo-scm parses `git diff` output; a user's config changes its shape.
  defineCase({
    id: 'affected/diff-noprefix-config',
    category: 'affected',
    kind: 'correctness',
    title: 'A repository with `diff.noprefix` set still selects the changed project',
    why: 'Some developers set `diff.noprefix` so diffs show `packages/a/x` instead of `a/packages/a/x`. A tool that parses patch headers and strips a fixed `a/` prefix then reads `ckages/a/x`, which no project owns. Change detection must not depend on how a user likes their diffs printed.',
    from: ['affected'],
    needs: ['affected'],
    workspace: each(['a', 'b']),
    steps: [
      { sh: 'git config diff.noprefix true && git config diff.mnemonicPrefix true' },
      ...edit('packages/a/own.txt', 'a2\n'),
      { write: { 'packages/a/own.txt': 'a3\n' } },
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, ran: tests('a'), notRan: tests('b') },
      },
    ],
  }),

  defineCase({
    id: 'affected/color-always-config',
    category: 'affected',
    kind: 'correctness',
    title: 'A repository with git colors forced on still selects the changed project',
    why: 'Setting `color.ui` to `always` makes git print color codes even into a pipe. A tool that reads git’s plain output then sees paths wrapped in escape sequences that match no project. It must ask git for output that is never colored, or a common terminal setting silently empties every affected run.',
    from: ['affected'],
    needs: ['affected'],
    workspace: each(['a', 'b']),
    steps: [
      {
        sh: 'git config color.ui always && git config color.diff always && git config color.status always',
      },
      ...edit('packages/a/own.txt', 'a2\n'),
      { write: { 'packages/b/new.txt': 'new\n' } },
      { affected: 'test', base: 'HEAD~1', expect: { exit: 0, ran: tests('a', 'b') } },
    ],
  }),

  defineCase({
    id: 'affected/external-diff-config',
    category: 'affected',
    kind: 'correctness',
    title: 'A repository with an external diff tool configured still selects the changed project',
    why: 'Developers point `diff.external` at a visual diff tool. When a tool runs `git diff` without `--no-ext-diff`, git hands the comparison to that program, which prints something else or nothing. Change detection must not run a user’s diff viewer or depend on its output.',
    from: ['affected'],
    needs: ['affected'],
    workspace: each(['a', 'b']),
    steps: [
      { sh: 'git config diff.external true' },
      ...edit('packages/a/own.txt', 'a2\n'),
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, ran: tests('a'), notRan: tests('b') },
      },
    ],
  }),

  defineCase({
    id: 'affected/copy-detection-config',
    category: 'affected',
    kind: 'correctness',
    title:
      'With git’s copy detection on, a file copied into another project selects only that project',
    why: 'With `diff.renames` set to `copies`, git reports a new file that matches an existing one as a copy from it. Only the destination changed; the source is untouched. A parser that does not know copy entries drops them, and one that treats them like renames also selects the source project.',
    from: ['affected-moves'],
    needs: ['affected'],
    workspace: each(['a', 'b'], {
      a: { files: { 'own.txt': 'a\n', 'shared.txt': 'one shared file\n' } },
    }),
    steps: [
      { sh: 'git config diff.renames copies && git config status.renames copies' },
      { sh: 'cp packages/a/shared.txt packages/b/shared.txt && git add -A && git commit -qm copy' },
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, ran: tests('b'), notRan: tests('a') },
      },
    ],
  }),

  defineCase({
    id: 'affected/hidden-untracked-config',
    category: 'affected',
    kind: 'correctness',
    title: 'A new file selects its project though `status.showUntrackedFiles` is off',
    why: 'Large repositories often set `status.showUntrackedFiles=no` to speed up `git status`. That hides new files from a plain status, but the tasks still read them. A tool that relies on default status output then misses every new source file, and its affected runs skip projects with new code.',
    from: ['affected', 'affected-pass-through'],
    needs: ['affected'],
    workspace: each(['a', 'b']),
    steps: [
      { sh: 'git config status.showUntrackedFiles no' },
      { write: { 'packages/a/new.txt': 'new\n' } },
      { affected: 'test', base: 'HEAD', expect: { exit: 0, ran: tests('a'), notRan: tests('b') } },
    ],
  }),

  // vx affected-unicode; the unquoted form of non-ASCII names.
  defineCase({
    id: 'affected/quotepath-off-config',
    category: 'affected',
    kind: 'correctness',
    title: 'A changed non-ASCII file name selects its project when `core.quotePath` is off',
    why: 'Many users outside English set `core.quotePath=false` so git prints names like `über.txt` as they are. A tool that always decodes git’s octal escapes, or always expects quotes around such names, gets these paths wrong. The project must be selected whichever way the user’s git prints names.',
    from: ['affected-unicode'],
    needs: ['affected'],
    workspace: each(['a', 'b']),
    steps: [
      { sh: 'git config core.quotePath false' },
      { write: { 'packages/b/über \\x.txt': 'v1\n' } },
      { affected: 'test', base: 'HEAD', expect: { exit: 0, ran: tests('b'), notRan: tests('a') } },
      { commit: 'über' },
      { write: { 'packages/b/über \\x.txt': 'v2\n' } },
      { commit: 'über edit' },
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, ran: tests('b'), notRan: tests('a') },
      },
    ],
  }),

  // vx affected-gitattributes "a CRLF edit under a committed `* text=auto` selects its project".
  defineCase({
    id: 'affected/crlf-edit-under-text-auto',
    category: 'affected',
    kind: 'correctness',
    title: 'Rewriting a file with CRLF line endings under `* text=auto` selects its project',
    why: 'With `* text=auto`, git normalizes line endings and reports a file rewritten with CRLF as unchanged. The bytes on disk are different, and a task that reads them can give a different result, a parser or a snapshot test among them. Selection must follow what tasks read, not what git would store.',
    from: ['affected-gitattributes'],
    needs: ['affected'],
    workspace: { ...each(['a', 'b']), files: { '.gitattributes': '* text=auto\n' } },
    steps: [
      { write: { 'packages/a/own.txt': 'a\r\n' } },
      { affected: 'test', base: 'HEAD', expect: { exit: 0, ran: tests('a'), notRan: tests('b') } },
    ],
  }),

  defineCase({
    id: 'affected/crlf-edit-under-autocrlf-input',
    category: 'affected',
    kind: 'correctness',
    title:
      'Rewriting a file with CRLF line endings under `core.autocrlf=input` selects its project',
    why: 'With `core.autocrlf=input`, git converts CRLF to LF when storing, so a CRLF rewrite of a file looks clean to `git status`. The task still reads the CRLF bytes from disk. A tool that trusts git’s view of the file reuses a result built from the LF version.',
    from: ['affected-gitattributes'],
    needs: ['affected'],
    workspace: each(['a', 'b']),
    steps: [
      { sh: 'git config core.autocrlf input' },
      { write: { 'packages/a/own.txt': 'a\r\n' } },
      { affected: 'test', base: 'HEAD', expect: { exit: 0, ran: tests('a'), notRan: tests('b') } },
    ],
  }),

  // --- How the repository itself is stored ---

  // turborepo-scm and Nx read refs through git; a tool reading .git/refs/heads by hand does not.
  defineCase({
    id: 'affected/packed-ref-base',
    category: 'affected',
    kind: 'correctness',
    title: 'A base branch whose ref git has packed still works as a base',
    why: 'git moves refs into `.git/packed-refs` on `git gc` or `git pack-refs`, and fresh clones arrive that way. The branch then has no file under `.git/refs/heads`. A tool that resolves a base by reading that directory finds nothing, and either fails or compares with the wrong commit.',
    from: ['affected-shallow'],
    needs: ['affected'],
    workspace: each(['a', 'b']),
    steps: [
      { sh: 'git branch base && git pack-refs --all && ! test -e .git/refs/heads/base' },
      ...edit('packages/b/own.txt', 'b2\n'),
      { affected: 'test', base: 'base', expect: { exit: 0, ran: tests('b'), notRan: tests('a') } },
    ],
  }),

  defineCase({
    id: 'affected/gitfile-repository',
    category: 'affected',
    kind: 'correctness',
    title: 'A checkout whose `.git` is a file pointing elsewhere still selects the changed project',
    why: 'Worktrees, submodules and `--separate-git-dir` checkouts have a `.git` file that names the real repository directory. A tool that opens `.git/` as a directory, to read the index or refs, finds a file and fails or sees no repository. Asking git itself works in every layout.',
    from: ['affected-submodule'],
    needs: ['affected'],
    workspace: each(['a', 'b']),
    steps: [
      {
        sh: 'mv .git .home/repo.git && printf "gitdir: %s\\n" "$PWD/.home/repo.git" > .git && git status -s >/dev/null',
      },
      ...edit('packages/a/own.txt', 'a2\n'),
      { write: { 'packages/b/new.txt': 'new\n' } },
      { affected: 'test', base: 'HEAD~1', expect: { exit: 0, ran: tests('a', 'b') } },
    ],
  }),

  defineCase({
    id: 'affected/split-index-v4',
    category: 'affected',
    kind: 'correctness',
    title: 'A repository using index version 4 and a split index still selects the changed project',
    why: 'Large repositories turn on `core.splitIndex` and index version 4 to keep `git status` fast. The index file then has a different layout and part of it lives in a shared file. A tool that parses the index itself, rather than asking git, misreads it and loses the change.',
    from: ['affected-flagged'],
    needs: ['affected'],
    workspace: each(['a', 'b']),
    steps: [
      { sh: 'git config core.splitIndex true && git update-index --index-version 4 --split-index' },
      { write: { 'packages/a/own.txt': 'a2\n' } },
      { affected: 'test', base: 'HEAD', expect: { exit: 0, ran: tests('a'), notRan: tests('b') } },
    ],
  }),

  defineCase({
    id: 'affected/stale-index-lock',
    category: 'affected',
    kind: 'correctness',
    title: 'A leftover `.git/index.lock`, as a crashed editor leaves, does not stop the selection',
    why: 'An editor or a killed git command can leave `index.lock` behind. Reading what changed needs no write to the index, and `git status` still answers. A tool that refreshes the index as part of its check fails the run, or worse reads the failure as no change and runs nothing.',
    from: ['affected-weak-stat'],
    needs: ['affected'],
    workspace: each(['a', 'b']),
    steps: [
      { write: { 'packages/a/own.txt': 'a2\n' } },
      { sh: ': > .git/index.lock' },
      {
        affected: 'test',
        base: 'HEAD',
        expect: { ran: tests('a'), notRan: tests('b'), orRefused: true },
      },
    ],
  }),

  defineCase({
    id: 'affected/sha256-repository',
    category: 'affected',
    kind: 'correctness',
    title: 'A repository using SHA-256 object names still selects the changed project',
    why: 'git can store objects under SHA-256 names, 64 hex digits instead of 40. A tool that assumes 40-character object names when it reads git’s output cuts every name short. It then fails, or matches nothing and selects nothing.',
    from: ['affected-head-range'],
    needs: ['affected'],
    workspace: each(['a', 'b']),
    steps: [
      {
        sh: 'rm -rf .git && git init -q -b main --object-format=sha256 && git add -A && git commit -qm init && test "$(git rev-parse HEAD | wc -c)" -eq 65',
      },
      ...edit('packages/a/own.txt', 'a2\n'),
      { write: { 'packages/b/own.txt': 'b2\n' } },
      { affected: 'test', base: 'HEAD~1', expect: { exit: 0, ran: tests('a', 'b') } },
    ],
  }),

  // --- Edits to the workspace's shape and task definitions ---

  // Nx touched-projects locator for project config; Turborepo turbo.json in the global hash.
  defineCase({
    id: 'affected/task-definition-change-stays-put',
    category: 'affected',
    kind: 'efficiency',
    title:
      'Changing one project’s task definition leaves projects that neither depend on it nor share it out',
    why: 'A new command for `docs`’s `test` can only change `docs`’s result. Other projects have their own definitions and no edge to it. A tool that treats any edit to the task config as a change to every project turns a one-line config fix into a full CI run.',
    from: ['affected-config-deleted', 'affected-dry-reasons'],
    needs: ['affected'],
    workspace: libApp(),
    steps: [
      {
        configure: (ws) => {
          const docs = ws.projects['docs']!
          const tasks = { ...docs.tasks, test: { ...TEST, command: `${TEST.command} && true` } }
          return { ...ws, projects: { ...ws.projects, docs: { ...docs, tasks } } }
        },
      },
      { commit: 'docs test' },
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, ran: tests('docs'), notRan: tests('lib', 'app') },
      },
    ],
  }),

  // Turborepo affected_test test_affected_tasks_excludes_packages_without_script.
  defineCase({
    id: 'affected/new-task-selected',
    category: 'affected',
    kind: 'correctness',
    title:
      'A task newly added to a project is selected; the same task elsewhere, unchanged, is not',
    why: 'A task that did not exist at the base has never been checked, so it must run. Projects that already had the same task and did not change keep their result. Selecting nothing because no source changed leaves the new task untested; selecting every project with that name reruns known results.',
    from: ['affected-config-deleted'],
    needs: ['affected'],
    workspace: (() => {
      const ws = libApp()
      ws.projects['docs']!.tasks = { ...ws.projects['docs']!.tasks, check: ALL_FILES }
      return ws
    })(),
    steps: [
      {
        configure: (ws) => {
          const app = ws.projects['app']!
          return {
            ...ws,
            projects: {
              ...ws.projects,
              app: { ...app, tasks: { ...app.tasks, check: ALL_FILES } },
            },
          }
        },
      },
      { commit: 'app check' },
      {
        affected: 'check',
        base: 'HEAD~1',
        expect: { exit: 0, ran: ['app#check'], notRan: ['docs#check'] },
      },
    ],
  }),

  defineCase({
    id: 'affected/new-project-on-library',
    category: 'affected',
    kind: 'efficiency',
    title:
      'A new project that depends on a library selects itself, not the library or its other users',
    why: 'A new project must run: nothing about it was ever checked. Adding a dependent does not change the library or anything already built on it. A tool that reads the edited root manifest and lockfile as a change to every project runs the whole workspace for a new package.',
    from: ['affected-config-deleted', 'affected-workspace-files'],
    needs: ['affected'],
    workspace: libApp(),
    steps: [
      {
        write: {
          'packages/extra/package.json': manifest('extra', ['lib']),
          'packages/extra/src/a.txt': 'extra\n',
        },
      },
      {
        write: {
          'package.json': rootManifest([
            'packages/lib',
            'packages/app',
            'packages/docs',
            'packages/extra',
          ]),
        },
      },
      { install: true },
      {
        configure: (ws) => ({
          ...ws,
          projects: {
            ...ws.projects,
            extra: { deps: ['lib'], tasks: { build: chainBuild(['lib']), test: TEST } },
          },
        }),
      },
      { commit: 'extra' },
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, ran: tests('extra'), notRan: tests('lib', 'app', 'docs') },
      },
    ],
  }),

  // Nx touched-projects locator for package.json dependencies.
  defineCase({
    id: 'affected/new-dependency-selects-dependent',
    category: 'affected',
    kind: 'correctness',
    title: 'Adding a workspace dependency to a project selects it, not the dependency',
    why: 'A new dependency changes what the project builds against, even though none of its sources changed. Its tasks now wait on the dependency’s build, so their result can differ. The dependency itself gained a user but read nothing new, so it stays out.',
    from: ['affected-discover-stage', 'affected-dependents'],
    needs: ['affected'],
    workspace: libApp(),
    steps: [
      {
        sh: `sed -i 's/"dependencies": {}/"dependencies": {"lib": "workspace:*"}/' packages/docs/package.json`,
      },
      { install: true },
      { configure: withDeps('docs', ['lib']) },
      { commit: 'docs uses lib' },
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, ran: tests('docs'), notRan: tests('lib', 'app') },
      },
    ],
  }),

  defineCase({
    id: 'affected/dropped-dependency-selects-dependent',
    category: 'affected',
    kind: 'correctness',
    title: 'Removing a workspace dependency from a project selects it',
    why: 'When a project stops depending on a library, it no longer gets the library’s build, and an import of it can now fail. Its sources did not change, but what it builds against did. Selecting nothing leaves a broken project green until the next unrelated edit.',
    from: ['affected-discover-stage', 'affected-config-deleted'],
    needs: ['affected'],
    workspace: libApp(),
    steps: [
      { sh: `sed -i '/"lib": "workspace:\\*"/d' packages/app/package.json` },
      { install: true },
      { configure: withDeps('app', []) },
      { commit: 'app drops lib' },
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, ran: tests('app'), notRan: tests('lib', 'docs') },
      },
    ],
  }),

  defineCase({
    id: 'affected/former-dependent-left-out',
    category: 'affected',
    kind: 'efficiency',
    title: 'Once a project drops a dependency, a later change to that dependency leaves it out',
    why: 'Selection must use the graph as it is now, not as it was at some older commit. After `app` stops depending on `lib`, a change in `lib` cannot reach `app`. A tool that caches the old graph, or reads the dependencies from the base, keeps running `app` for changes it no longer sees.',
    from: ['affected-discover-stage'],
    needs: ['affected'],
    workspace: libApp(),
    steps: [
      { sh: `sed -i '/"lib": "workspace:\\*"/d' packages/app/package.json` },
      { install: true },
      { configure: withDeps('app', []) },
      { commit: 'app drops lib' },
      ...edit('packages/lib/src/a.txt', 'lib2\n'),
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, ran: tests('lib'), notRan: tests('app', 'docs') },
      },
    ],
  }),

  // --- Where a changed path sits ---

  // vx affected "ignores changes outside any project directory".
  defineCase({
    id: 'affected/unowned-files-under-packages',
    category: 'affected',
    kind: 'efficiency',
    title: 'Files under `packages/` that no project owns, beside the projects, select nothing',
    why: 'A README in `packages/`, or a folder there without a manifest, is not part of any project. No task reads it. A tool that matches changed paths to projects by a loose prefix, or that treats every folder under the workspace glob as a project, selects projects for edits none of them can see.',
    from: ['affected'],
    needs: ['affected'],
    workspace: each(['a', 'b']),
    steps: [
      {
        write: {
          'packages/README.md': 'all packages\n',
          'packages/ghost/notes.txt': 'not a project\n',
        },
      },
      { commit: 'notes' },
      { affected: 'test', base: 'HEAD~1', expect: { exit: 0, notRan: tests('a', 'b') } },
    ],
  }),

  // vx affected-workspace-files: a root input glob is a set of paths, not a prefix.
  defineCase({
    id: 'affected/root-input-prefix-sibling',
    category: 'affected',
    kind: 'efficiency',
    title: 'A root input `shared/**` is not selected by an edit to `shared-old/` or `shared.txt`',
    why: 'A root input names a directory, and only files inside it are read. `shared-old/x.txt` and `shared.txt` merely start with the same letters. A tool that tests the changed path with a string prefix selects the task on edits it never reads.',
    from: ['affected-workspace-files'],
    needs: ['affected'],
    workspace: (() => {
      const ws = sharedReader()
      return { ...ws, files: { ...ws.files, 'shared-old/x.txt': 'x\n', 'shared.txt': 's\n' } }
    })(),
    steps: [
      { write: { 'shared-old/x.txt': 'x2\n', 'shared.txt': 's2\n' } },
      { commit: 'siblings' },
      {
        affected: 'build',
        base: 'HEAD~1',
        expect: { exit: 0, notRan: ['app#build', 'other#build'] },
      },
    ],
  }),

  defineCase({
    id: 'affected/root-input-deleted',
    category: 'affected',
    kind: 'correctness',
    title: 'Deleting a root file a task names as an input selects that task',
    why: 'A deleted shared file changes what the reading task sees as much as an edit does. The file belongs to no project, so only the task’s root inputs connect it to the change. A tool that checks root inputs only against files still present finds nothing and skips the task.',
    from: ['affected-workspace-files'],
    needs: ['affected'],
    workspace: sharedReader(),
    steps: [
      { sh: 'git rm -q shared/two.txt' },
      { commit: 'drop two' },
      {
        affected: 'build',
        base: 'HEAD~1',
        expect: { exit: 0, ran: ['app#build'], notRan: ['other#build'] },
      },
    ],
  }),

  defineCase({
    id: 'affected/root-input-new-untracked-file',
    category: 'affected',
    kind: 'correctness',
    title: 'A new untracked file under a task’s root input selects that task',
    why: 'A new shared file under a root input is read by the task right away, before anyone commits it. The run must pick it up from git’s untracked files and match it against root inputs, not only project paths. Otherwise the task that reads `shared/*` is skipped until the file is committed.',
    from: ['affected-workspace-files'],
    needs: ['affected'],
    workspace: sharedReader(),
    steps: [
      { write: { 'shared/three.txt': '3\n' } },
      {
        affected: 'build',
        base: 'HEAD',
        expect: { exit: 0, ran: ['app#build'], notRan: ['other#build'] },
      },
    ],
  }),

  // vx affected-unicode: a project directory a reader must keep whole.
  defineCase({
    id: 'affected/project-dir-with-space',
    category: 'affected',
    kind: 'correctness',
    title: 'A change in a project whose directory name has a space selects it',
    why: 'Project directories are sometimes named with spaces, especially in repositories converted from other tools. The directory must be matched as a whole name. A tool that splits paths on whitespace, or quotes them wrongly when it calls git, selects nothing or the wrong project.',
    from: ['affected-unicode'],
    needs: ['affected'],
    workspace: each(['spaced', 'b'], { spaced: { dir: 'packages/my lib' } }),
    steps: [
      ...edit('packages/my lib/own.txt', 'v2\n'),
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, ran: tests('spaced'), notRan: tests('b') },
      },
    ],
  }),

  defineCase({
    id: 'affected/deep-project-dir',
    category: 'affected',
    kind: 'correctness',
    title: 'A change in a project three directories deep, `apps/web/client`, selects it',
    why: 'Projects do not all sit one level under `packages/`. A tool that maps a changed path to a project by its first two segments finds `apps/web`, which is no project, and drops the change. The owner is the deepest project directory that holds the path.',
    from: ['affected'],
    needs: ['affected'],
    workspace: each(['client', 'b'], { client: { dir: 'apps/web/client' } }),
    steps: [
      ...edit('apps/web/client/own.txt', 'v2\n'),
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, ran: tests('client'), notRan: tests('b') },
      },
    ],
  }),

  defineCase({
    id: 'affected/project-named-unlike-dir',
    category: 'affected',
    kind: 'correctness',
    title: 'A change in `packages/web` selects the project named `@acme/site` that lives there',
    why: 'A project’s name comes from its manifest and often differs from its directory, scoped names especially. The changed path gives a directory; the tool must map it to the project there, not look for a project named after the folder. Matching by name selects nothing and the project goes untested.',
    from: ['affected'],
    needs: ['affected'],
    workspace: each(['@acme/site', 'b'], { '@acme/site': { dir: 'packages/web' } }),
    steps: [
      ...edit('packages/web/own.txt', 'v2\n'),
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, ran: tests('@acme/site'), notRan: tests('b') },
      },
    ],
  }),

  // vx affected-workspace-files "CONTROL: a committed file under its own outputs that changed is an input".
  defineCase({
    id: 'affected/tracked-file-under-outputs',
    category: 'affected',
    kind: 'correctness',
    title:
      'An edit to a committed file under a task’s output directory selects the task when its inputs cover it',
    why: 'Some repositories commit a file inside an output directory, a license or a template that the build keeps. When the task’s inputs cover it, an edit to it changes the task’s key. Treating every path under an output directory as the task’s own leftovers skips a real source change.',
    from: ['affected-workspace-files'],
    needs: ['affected'],
    workspace: {
      projects: {
        a: {
          tasks: {
            test: {
              command: 'mkdir -p dist && cp dist/LICENSE dist/out.txt',
              inputs: ['**'],
              outputs: ['dist/out.txt'],
            },
          },
          files: { 'own.txt': 'a\n', 'dist/LICENSE': 'MIT\n' },
        },
        b: { tasks: { test: ALL_FILES }, files: { 'own.txt': 'b\n' } },
      },
    },
    steps: [
      { sh: 'git add -f packages/a/dist/LICENSE && git commit -qm license' },
      { write: { 'packages/a/dist/LICENSE': 'ISC\n' } },
      { sh: 'git add -f packages/a/dist/LICENSE && git commit -qm relicense' },
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: {
          exit: 0,
          ran: tests('a'),
          notRan: tests('b'),
          files: { 'packages/a/dist/out.txt': 'ISC\n' },
        },
      },
    ],
  }),
] as Case[]

// vx selects more than these changes reach (see the report); kept out of the shipped list.
export const pending: Case[] = [
  defineCase({
    id: 'affected/test-definition-change-skips-dependents',
    category: 'affected',
    kind: 'efficiency',
    title: 'Changing a library’s `test` definition leaves its dependents’ tests out',
    why: 'Dependents reach the library through its build, not its test. A new test command changes the library’s test result only. Selecting the dependents because their library’s config changed reruns their tests, which read the same build as before.',
    from: ['affected-dry-reasons'],
    needs: ['affected'],
    workspace: libApp(),
    steps: [
      {
        configure: (ws) => {
          const lib = ws.projects['lib']!
          const tasks = { ...lib.tasks, test: { ...TEST, command: `${TEST.command} && true` } }
          return { ...ws, projects: { ...ws.projects, lib: { ...lib, tasks } } }
        },
      },
      { commit: 'lib test' },
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, ran: tests('lib'), notRan: tests('app', 'docs') },
      },
    ],
  }),
  // vx affected-gitattributes: only an attribute that changes checked-out bytes selects.
  defineCase({
    id: 'affected/attribute-changing-no-bytes',
    category: 'affected',
    kind: 'efficiency',
    title:
      'A `.gitattributes` rule that changes no checked-out byte, `linguist-generated`, selects nothing',
    why: 'Some attributes only tell other tools how to show a file, such as GitHub’s `linguist-generated` or `-diff`. They change no byte any task reads. Selecting every project because `.gitattributes` changed reruns the whole workspace for a code-review setting.',
    from: ['affected-gitattributes'],
    needs: ['affected'],
    workspace: each(['a', 'b']),
    steps: [
      { write: { '.gitattributes': '*.txt linguist-generated -diff\n' } },
      { commit: 'attrs' },
      { affected: 'test', base: 'HEAD~1', expect: { exit: 0, notRan: tests('a', 'b') } },
    ],
  }),
]
