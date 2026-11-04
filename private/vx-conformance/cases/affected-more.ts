// `affected` against more of what a change can be: renames and moves,
// projects added, moved, deleted and nested, odd file names, bases that are
// no commit, task edges inside and across projects, root inputs and links.
// Also the selection rules the same vx tests pin beside it.
import {
  defineCase,
  type ProjectSpec,
  type Step,
  type TaskSpec,
  type WorkspaceSpec,
} from '../src/spec.ts'

/** A cached task over every file of its project. */
const ALL_FILES: TaskSpec = { command: 'true', inputs: ['**'], outputs: [] }

/** Projects each with one `test` over all its files, and nothing between them. */
function each(names: string[], dirs: Record<string, string> = {}): WorkspaceSpec {
  return {
    projects: Object.fromEntries(
      names.map((n): [string, ProjectSpec] => [
        n,
        {
          tasks: { test: ALL_FILES },
          files: { 'own.txt': `${n}\n` },
          ...(dirs[n] ? { dir: dirs[n] } : {}),
        },
      ]),
    ),
  }
}

const tests = (...names: string[]) => names.map((n) => `${n}#test`)

/** The root package.json the harness writes, with these member directories. */
function rootManifest(dirs: string[]): string {
  return JSON.stringify(
    {
      name: 'conformance',
      private: true,
      packageManager: `bun@${Bun.version}`,
      workspaces: dirs,
    },
    null,
    2,
  )
}

/** A member's package.json as the harness writes it. */
function manifest(name: string): string {
  return JSON.stringify({ name, version: '0.0.0', private: true, dependencies: {} }, null, 2)
}

/** Adds a field to a package.json in place, keeping what an adapter wrote there. */
const describePackage = (file: string): Step => ({
  sh: `sed -i 's/"private": true/"private": true, "description": "changed"/' ${file}`,
})

/** Turns the committed `packages/<dir>` into a submodule of a repository holding the same files. */
function submodule(dir: string): string {
  const up = `.home/up-${dir.replaceAll('/', '-')}`
  return [
    `mkdir -p ${up}`,
    `cp -R packages/${dir}/. ${up}/`,
    `git -C ${up} init -q -b main`,
    `git -C ${up} add -A`,
    `git -C ${up} commit -qm up`,
    `git rm -rq --cached packages/${dir}`,
    `rm -rf packages/${dir}`,
    `git -c protocol.file.allow=always submodule add -q "$PWD/${up}" packages/${dir}`,
    `git commit -qm submodule`,
  ].join(' && ')
}

/** Commits `vendor/<dir>` as its own repository, which the workspace records as one path. */
function embed(dir: string): string {
  return [
    `git rm -rq --cached vendor/${dir}`,
    `git -C vendor/${dir} init -q`,
    `git -C vendor/${dir} add -A`,
    `git -C vendor/${dir} commit -qm v`,
    `git add vendor/${dir}`,
    `git commit -qm gitlink`,
  ].join(' && ')
}

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

/**
 * lib ← app, and tool alone. `build` leaves out the `*.test.txt` sources
 * `test` reads; `style` is cached over the sources; `lint` is never cached.
 */
function edges(build: Partial<TaskSpec> = {}): WorkspaceSpec {
  const project = (name: string, deps: string[] = []): ProjectSpec => ({
    deps,
    tasks: {
      build: {
        command: `mkdir -p dist && cat ${deps.map((d) => `../${d}/dist/out.txt `).join('')}src/index.txt > dist/out.txt`,
        dependsOn: ['^build'],
        inputs: ['src/**', '!src/**/*.test.txt'],
        outputs: ['dist/**'],
        ...build,
      },
      test: {
        command: 'cat src/index.test.txt',
        dependsOn: ['build'],
        inputs: ['src/**'],
        outputs: [],
      },
      style: { command: 'true', inputs: ['src/**'], outputs: [] },
      lint: { command: 'true', cache: false },
    },
    files: {
      'src/index.txt': `${name}\n`,
      'src/index.test.txt': `${name} test\n`,
      'README.md': `${name}\n`,
    },
  })
  return {
    projects: { lib: project('lib'), app: project('app', ['lib']), tool: project('tool') },
  }
}

const editLib = (file = 'index.txt'): Step[] => [
  { write: { [`packages/lib/src/${file}`]: 'lib2\n' } },
  { commit: `lib ${file}` },
]

/** `app` reads the files under `shared/`, the workspace root's, through its build. */
function sharedReader(extra: Record<string, TaskSpec> = {}): WorkspaceSpec {
  return {
    projects: {
      app: {
        tasks: {
          build: {
            command: 'mkdir -p dist && cat ../../shared/schema.txt > dist/out.txt',
            inputs: ['src/**'],
            rootInputs: ['shared/**'],
            outputs: ['dist/**'],
          },
          ...extra,
        },
        files: { 'src/index.txt': 'app\n' },
      },
    },
    files: { 'shared/schema.txt': 'v1\n' },
  }
}

/**
 * One project's tasks as a diamond: top → left, right; left → base;
 * right → seed, base; side → left. Only `seed` reads zero.txt.
 */
function diamond(): WorkspaceSpec {
  const on = (deps: string[], input = 'other.txt'): TaskSpec => ({
    command: 'true',
    dependsOn: deps,
    inputs: [input],
    outputs: [],
  })
  return {
    projects: {
      app: {
        tasks: {
          top: on(['left', 'right']),
          left: on(['base']),
          right: on(['seed', 'base']),
          base: on([]),
          seed: on([], 'zero.txt'),
          side: on(['left']),
        },
        files: { 'zero.txt': '0\n', 'other.txt': 'o\n' },
      },
    },
  }
}

/** The workspace root as a project (`root`, over tools/) and members, each build never cached. */
function rootAndMembers(members: string[]): WorkspaceSpec {
  return {
    projects: {
      root: {
        dir: '.',
        tasks: { build: { command: 'cat tools/gen.txt', cache: false } },
        files: { 'tools/gen.txt': 'one\n' },
      },
      ...Object.fromEntries(
        members.map((m): [string, ProjectSpec] => [
          m,
          {
            tasks: { build: { command: 'true', cache: false } },
            files: { 'src/deep/x.txt': `${m}\n` },
          },
        ]),
      ),
    },
  }
}

export default [
  // --- What a change is: files, names, renames, the index ---

  defineCase({
    id: 'affected/changes-in-two-projects',
    category: 'affected',
    kind: 'correctness',
    title: 'Edits in two projects select both',
    from: ['affected'],
    needs: ['affected'],
    workspace: each(['a', 'b', 'c']),
    steps: [
      { write: { 'packages/a/own.txt': 'a2\n', 'packages/b/own.txt': 'b2\n' } },
      {
        affected: 'test',
        base: 'HEAD',
        expect: { exit: 0, ran: tests('a', 'b'), notRan: tests('c') },
      },
    ],
  }),

  defineCase({
    id: 'affected/staged-change',
    category: 'affected',
    kind: 'correctness',
    title: 'A change staged in git’s index but not committed counts as a change',
    from: ['affected'],
    needs: ['affected'],
    workspace: each(['a', 'b']),
    steps: [
      { write: { 'packages/a/own.txt': 'a2\n' } },
      { sh: 'git add -A' },
      { affected: 'test', base: 'HEAD', expect: { exit: 0, ran: tests('a'), notRan: tests('b') } },
    ],
  }),

  defineCase({
    id: 'affected/uncommitted-delete',
    category: 'affected',
    kind: 'correctness',
    title: 'A file deleted from the working tree, not committed, selects its project',
    from: ['affected'],
    needs: ['affected'],
    workspace: each(['a', 'b']),
    steps: [
      { write: { 'packages/b/own.txt': null } },
      { affected: 'test', base: 'HEAD', expect: { exit: 0, ran: tests('b'), notRan: tests('a') } },
    ],
  }),

  defineCase({
    id: 'affected/rename-within-project',
    category: 'affected',
    kind: 'correctness',
    title: 'A file renamed inside a project selects that project alone',
    why: 'The project’s file set changed: a task reading `*` sees a new name.',
    from: ['affected', 'affected-moves'],
    needs: ['affected'],
    workspace: each(['a', 'b', 'c']),
    steps: [
      { sh: 'git mv packages/c/own.txt packages/c/renamed.txt' },
      { commit: 'rename' },
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, ran: tests('c'), notRan: tests('a', 'b') },
      },
    ],
  }),

  defineCase({
    id: 'affected/move-between-projects',
    category: 'affected',
    kind: 'correctness',
    title: 'A file moved from one project to another, not yet committed, selects both',
    why: 'One project lost an input and the other gained one: a rename detected as one change still touches two projects.',
    from: ['affected'],
    needs: ['affected'],
    workspace: each(['a', 'b', 'c']),
    steps: [
      { sh: 'git mv packages/c/own.txt packages/b/moved.txt' },
      {
        affected: 'test',
        base: 'HEAD',
        expect: { exit: 0, ran: tests('b', 'c'), notRan: tests('a') },
      },
    ],
  }),

  defineCase({
    id: 'affected/committed-move-between-projects',
    category: 'affected',
    kind: 'correctness',
    title: 'A committed move of a file from one project to another selects both',
    why: 'One project lost an input and the other gained one: a rename detected as one change still touches two projects.',
    from: ['affected-moves'],
    needs: ['affected'],
    workspace: each(['a', 'b', 'c']),
    steps: [
      { sh: 'git mv packages/c/own.txt packages/b/moved.txt' },
      { commit: 'move' },
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, ran: tests('b', 'c'), notRan: tests('a') },
      },
    ],
  }),

  defineCase({
    id: 'affected/non-ascii-file-name',
    category: 'affected',
    kind: 'correctness',
    title: 'A new file with a non-ASCII name selects its project',
    why: 'git quotes such a name in its plain output; read unquoted, the path belongs to no project.',
    from: ['affected'],
    needs: ['affected'],
    workspace: each(['a', 'b']),
    steps: [
      { write: { 'packages/a/café.txt': 'v1\n' } },
      { affected: 'test', base: 'HEAD', expect: { exit: 0, ran: tests('a'), notRan: tests('b') } },
      { commit: 'café' },
      { write: { 'packages/a/café.txt': 'v2\n' } },
      { affected: 'test', base: 'HEAD', expect: { exit: 0, ran: tests('a'), notRan: tests('b') } },
    ],
  }),

  defineCase({
    id: 'affected/quote-backslash-file-name',
    category: 'affected',
    kind: 'correctness',
    title: 'A changed file whose name holds a quote or a backslash selects its project',
    from: ['affected'],
    needs: ['affected'],
    workspace: each(['a', 'b']),
    steps: [
      { write: { 'packages/b/we"ird\\name.txt': 'v1\n' } },
      { affected: 'test', base: 'HEAD', expect: { exit: 0, ran: tests('b'), notRan: tests('a') } },
      { commit: 'weird' },
      { write: { 'packages/b/we"ird\\name.txt': 'v2\n' } },
      { affected: 'test', base: 'HEAD', expect: { exit: 0, ran: tests('b'), notRan: tests('a') } },
    ],
  }),

  defineCase({
    id: 'affected/ignored-files-select-nothing',
    category: 'affected',
    kind: 'efficiency',
    title: 'New files git ignores, an install among them, select nothing',
    from: ['affected'],
    needs: ['affected'],
    workspace: {
      projects: {
        ...each(['a', 'b']).projects,
        a: { tasks: { test: ALL_FILES }, files: { 'own.txt': 'a\n', '.gitignore': 'ignored/\n' } },
      },
    },
    steps: [
      {
        write: {
          'packages/a/ignored/blob.bin': 'junk',
          'packages/a/node_modules/dep/index.js': 'x',
        },
      },
      { affected: 'test', base: 'HEAD', expect: { exit: 0, notRan: tests('a', 'b') } },
    ],
  }),

  defineCase({
    id: 'affected/tracked-file-under-node-modules',
    category: 'affected',
    kind: 'correctness',
    title: 'An edit to a file committed under a `node_modules` directory selects its project',
    why: 'Committed, it is a source like any other: only an untracked install is the package manager’s.',
    from: ['affected'],
    needs: ['affected'],
    workspace: each(['a', 'b']),
    steps: [
      { write: { 'packages/b/fixtures/node_modules/dep/index.js': 'v1' } },
      { sh: 'git add -f packages/b/fixtures && git commit -qm fixture' },
      { write: { 'packages/b/fixtures/node_modules/dep/index.js': 'v2' } },
      { affected: 'test', base: 'HEAD', expect: { exit: 0, ran: tests('b'), notRan: tests('a') } },
    ],
  }),

  defineCase({
    id: 'affected/sibling-prefix-dirs',
    category: 'affected',
    kind: 'correctness',
    title: 'A change in `app-e2e` selects it, not `app` or `app-e2e-utils` beside it',
    why: 'A directory owns a path only up to a `/`: `packages/app` is no prefix of `packages/app-e2e/x`.',
    from: ['affected'],
    needs: ['affected'],
    workspace: each(['app', 'app-e2e', 'app-e2e-utils']),
    steps: [
      { write: { 'packages/app-e2e/own.txt': 'changed\n' } },
      {
        affected: 'test',
        base: 'HEAD',
        expect: { exit: 0, ran: tests('app-e2e'), notRan: tests('app', 'app-e2e-utils') },
      },
    ],
  }),

  defineCase({
    id: 'affected/nested-project-owns-its-files',
    category: 'affected',
    kind: 'efficiency',
    title: 'A project nested in another owns its files: an edit there selects it, not its parent',
    from: ['affected', 'affected-moves'],
    needs: ['affected'],
    workspace: each(['outer', 'inner'], { inner: 'packages/outer/inner' }),
    steps: [
      { write: { 'packages/outer/inner/own.txt': 'inner2\n' } },
      { commit: 'inner' },
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, ran: tests('inner'), notRan: tests('outer') },
      },
      { write: { 'packages/outer/own.txt': 'outer2\n' } },
      { commit: 'outer' },
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, ran: tests('outer'), notRan: tests('inner') },
      },
    ],
  }),

  defineCase({
    id: 'affected/many-commits',
    category: 'affected',
    kind: 'correctness',
    title: 'A base fifty commits back selects what those commits changed, and nothing else',
    from: ['affected'],
    needs: ['affected'],
    workspace: each(['a', 'b']),
    steps: [
      {
        sh: 'for i in $(seq 1 50); do echo "$i" > packages/b/own.txt && git commit -qam "b $i"; done',
      },
      {
        affected: 'test',
        base: 'HEAD~50',
        expect: { exit: 0, ran: tests('b'), notRan: tests('a') },
      },
    ],
  }),

  defineCase({
    id: 'affected/six-thousand-files',
    category: 'affected',
    kind: 'correctness',
    title:
      'A commit of six thousand long-named files, over a megabyte of paths, selects its project',
    why: 'A diff that outgrows a fixed output buffer must not fail the run or select everything.',
    from: ['affected'],
    needs: ['affected'],
    workspace: each(['a', 'b']),
    steps: [
      {
        sh: 'mkdir -p packages/b/gen && L=$(printf "x%.0s" $(seq 1 160)) && for i in $(seq 1 6000); do echo "$i" > "packages/b/gen/$L-$i.txt"; done',
      },
      { commit: 'generated' },
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, ran: tests('b'), notRan: tests('a') },
      },
    ],
  }),

  // --- Projects added, moved and deleted ---

  defineCase({
    id: 'affected/deleted-project',
    category: 'affected',
    kind: 'efficiency',
    title: 'Deleting a whole project selects none of the projects that remain',
    why: 'Nothing the remaining projects read changed; the deleted one has no task left to run.',
    from: ['affected', 'affected-moves', 'vx-lockfile/deleted-project'],
    needs: ['affected'],
    workspace: each(['a', 'b']),
    steps: [
      { sh: 'git rm -rq packages/a && rm -rf packages/a' },
      { write: { 'package.json': rootManifest(['packages/b']) } },
      { install: true },
      { configure: (ws) => ({ ...ws, projects: { b: ws.projects['b']! } }) },
      { commit: 'drop a' },
      { affected: 'test', base: 'HEAD~1', expect: { exit: 0, notRan: tests('b') } },
    ],
  }),

  defineCase({
    id: 'affected/moved-project',
    category: 'affected',
    kind: 'correctness',
    title: 'A project moved to another directory is selected where it now lives',
    from: ['affected-moves'],
    needs: ['affected'],
    workspace: each(['a', 'b', 'c']),
    steps: [
      { sh: 'git mv packages/c packages/cc' },
      { write: { 'package.json': rootManifest(['packages/a', 'packages/b', 'packages/cc']) } },
      { install: true },
      {
        configure: (ws) => ({
          ...ws,
          projects: { ...ws.projects, c: { ...ws.projects['c']!, dir: 'packages/cc' } },
        }),
      },
      { commit: 'move c' },
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, ran: tests('c'), notRan: tests('a', 'b') },
      },
    ],
  }),

  defineCase({
    id: 'affected/new-nested-project-selects-parent',
    category: 'affected',
    kind: 'correctness',
    title: 'Making a directory inside a project a project of its own selects both',
    why: 'The outer project’s files stop at the new one: what its task over `**` reads changed.',
    from: ['affected'],
    needs: ['affected'],
    workspace: {
      projects: {
        a: { tasks: { test: ALL_FILES }, files: { 'own.txt': 'a\n', 'sub/data.txt': 'data\n' } },
        b: { tasks: { test: ALL_FILES }, files: { 'own.txt': 'b\n' } },
      },
    },
    steps: [
      { write: { 'packages/a/sub/package.json': manifest('sub') } },
      {
        write: { 'package.json': rootManifest(['packages/a', 'packages/b', 'packages/a/sub']) },
      },
      { install: true },
      {
        configure: (ws) => ({
          ...ws,
          projects: { ...ws.projects, sub: { dir: 'packages/a/sub', tasks: { test: ALL_FILES } } },
        }),
      },
      { commit: 'sub' },
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, ran: tests('a', 'sub'), notRan: tests('b') },
      },
    ],
  }),

  // --- Bases that are no plain commit ---

  defineCase({
    id: 'affected/unknown-base',
    category: 'affected',
    kind: 'correctness',
    title: 'A base that names no commit fails the run or runs everything, never nothing',
    why: 'Running nothing over a typo is a green CI job that checked nothing.',
    from: ['affected'],
    needs: ['affected'],
    workspace: each(['a', 'b']),
    steps: [
      { write: { 'packages/a/own.txt': 'a2\n' } },
      {
        affected: 'test',
        base: 'no-such-branch',
        expect: { ran: tests('a', 'b'), orRefused: true },
      },
    ],
  }),

  defineCase({
    id: 'affected/option-like-base',
    category: 'affected',
    kind: 'correctness',
    title: 'A base spelled like a git option is never passed to git as one',
    why: '`git diff --output=<file>` writes a file: a base from a CI variable must not reach git as an option.',
    from: ['affected'],
    needs: ['affected'],
    workspace: each(['a', 'b']),
    steps: [
      {
        affected: 'test',
        base: '--output=injected.txt',
        expect: { files: { 'injected.txt': null } },
      },
    ],
  }),

  defineCase({
    id: 'affected/base-naming-a-path',
    category: 'affected',
    kind: 'efficiency',
    title: 'A base naming a directory inside a commit (`HEAD:packages`) selects nothing unchanged',
    why: 'Its paths lack the `packages/` prefix: compared as a commit, every project looks changed.',
    from: ['affected'],
    needs: ['affected'],
    workspace: each(['a', 'b']),
    steps: [{ affected: 'test', base: 'HEAD:packages', expect: { notRan: tests('a', 'b') } }],
  }),

  defineCase({
    id: 'affected/exclusion-base',
    category: 'affected',
    kind: 'efficiency',
    title: 'A base written as an exclusion (`^main`) selects nothing only the base branch changed',
    why: 'Read as `main` itself, main’s own later commits look like this branch’s change.',
    from: ['affected'],
    needs: ['affected'],
    workspace: each(['a', 'b']),
    steps: [...DIVERGED, { affected: 'test', base: '^main', expect: { notRan: tests('b') } }],
  }),

  defineCase({
    id: 'affected/broken-repository',
    category: 'affected',
    kind: 'correctness',
    title: 'When git cannot diff the base, the run fails or runs everything, never nothing',
    why: 'An unreadable diff is no empty one: running nothing is a green CI job over a broken checkout.',
    from: ['affected'],
    needs: ['affected'],
    workspace: each(['a', 'b']),
    steps: [
      {
        // The commit still resolves; its tree is gone, so `git diff HEAD` fails.
        sh: 'T=$(git rev-parse "HEAD^{tree}") && rm ".git/objects/$(echo "$T" | cut -c1-2)/$(echo "$T" | cut -c3-)" && ! git diff --quiet HEAD 2>/dev/null',
      },
      { write: { 'packages/a/own.txt': 'a2\n' } },
      {
        affected: 'test',
        base: 'HEAD',
        expect: { ran: tests('a', 'b'), orRefused: true },
      },
    ],
  }),

  // --- Nested repositories ---

  defineCase({
    id: 'affected/submodule-diff-ignored',
    category: 'affected',
    kind: 'correctness',
    title: 'An edit or a bump in a submodule selects its project though git is set to ignore it',
    why: '`diff.ignoreSubmodules` quiets git’s diff; the task still reads the files.',
    from: ['affected'],
    needs: ['affected'],
    workspace: each(['a', 'sub']),
    steps: [
      { sh: submodule('sub') },
      { sh: 'git config diff.ignoreSubmodules all' },
      { write: { 'packages/sub/own.txt': 'sub2\n' } },
      {
        affected: 'test',
        base: 'HEAD',
        expect: { exit: 0, ran: tests('sub'), notRan: tests('a') },
      },
      {
        // New bytes, so the bump is not the edit the run above cached.
        sh: 'echo sub3 > packages/sub/own.txt && git config --unset diff.ignoreSubmodules && git -C packages/sub commit -qam bump && git add packages/sub && git commit -qm bump && git config diff.ignoreSubmodules all',
      },
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, ran: tests('sub'), notRan: tests('a') },
      },
    ],
  }),

  // --- Task edges: what a change reaches ---

  defineCase({
    id: 'affected/test-file-edit-skips-dependents',
    category: 'affected',
    kind: 'efficiency',
    title: 'An edit to a file only the project’s own `test` reads leaves its dependents’ tests out',
    why: '`build` leaves the file out, so nothing a dependent builds on changed.',
    from: ['affected-dependents'],
    needs: ['affected'],
    workspace: edges(),
    steps: [
      ...editLib('index.test.txt'),
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, ran: ['lib#test'], notRan: ['app#test', 'tool#test'] },
      },
    ],
  }),

  defineCase({
    id: 'affected/change-reaching-no-requested-task',
    category: 'affected',
    kind: 'efficiency',
    title: 'A change no requested task reads runs nothing and succeeds',
    from: ['affected-dependents'],
    needs: ['affected'],
    workspace: edges(),
    steps: [
      ...editLib('index.test.txt'),
      {
        affected: 'build',
        base: 'HEAD~1',
        expect: { exit: 0, notRan: ['lib#build', 'app#build', 'tool#build'] },
      },
    ],
  }),

  defineCase({
    id: 'affected/unchanged-dependency-still-built',
    category: 'affected',
    kind: 'correctness',
    title: 'An affected project’s build gets its unchanged dependency’s build first, from cold',
    why: 'The dependency was not affected, but the affected build reads its output: leaving it out fails the build.',
    from: ['affected-dependents'],
    needs: ['affected'],
    workspace: edges(),
    steps: [
      { write: { 'packages/app/src/index.txt': 'app2\n' } },
      { commit: 'app' },
      {
        affected: 'build',
        base: 'HEAD~1',
        expect: {
          exit: 0,
          order: [['lib#build', 'app#build']],
          notRan: ['tool#build'],
          files: { 'packages/app/dist/out.txt': 'lib\napp2\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'affected/dot-slash-input-glob',
    category: 'affected',
    kind: 'correctness',
    title: 'An input glob spelled `./src/**` selects on an edit under src/',
    from: ['affected-dependents'],
    needs: ['affected'],
    workspace: edges({ inputs: ['./src/**', '!./src//**/*.test.txt'] }),
    steps: [
      ...editLib(),
      {
        affected: 'build',
        base: 'HEAD~1',
        expect: { exit: 0, ran: ['lib#build', 'app#build'], notRan: ['tool#build'] },
      },
    ],
  }),

  defineCase({
    id: 'affected/dot-slash-exclude-glob',
    category: 'affected',
    kind: 'efficiency',
    title: 'A file an input’s `!./src//**` exclude leaves out selects nothing',
    from: ['affected-dependents'],
    needs: ['affected'],
    workspace: edges({ inputs: ['./src/**', '!./src//**/*.test.txt'] }),
    steps: [
      ...editLib('index.test.txt'),
      {
        affected: 'build',
        base: 'HEAD~1',
        expect: { exit: 0, notRan: ['lib#build', 'app#build', 'tool#build'] },
      },
    ],
  }),

  defineCase({
    id: 'affected/bare-directory-input',
    category: 'affected',
    kind: 'correctness',
    title: 'An input naming a bare directory (`src`) selects on an edit under it',
    why: 'A directory as an input means what is in it; the key reads it that way.',
    from: ['affected-dependents'],
    needs: ['affected'],
    workspace: edges({ inputs: ['src', '!src/**/*.test.txt'] }),
    steps: [
      ...editLib(),
      {
        affected: 'build',
        base: 'HEAD~1',
        expect: { exit: 0, ran: ['lib#build', 'app#build'], notRan: ['tool#build'] },
      },
    ],
  }),

  defineCase({
    id: 'affected/aggregate-task-kept',
    category: 'affected',
    kind: 'correctness',
    title: 'A task that only aggregates others runs when a task it depends on is affected',
    from: ['affected-dependents', 'affected-dry-reasons'],
    needs: ['affected'],
    workspace: (() => {
      const ws = edges()
      const app = ws.projects['app']!
      app.tasks = { ...app.tasks, all: { command: 'true', dependsOn: ['build'] } }
      return ws
    })(),
    steps: [
      ...editLib(),
      { affected: 'all', base: 'HEAD~1', expect: { exit: 0, ran: ['app#all'] } },
    ],
  }),

  defineCase({
    id: 'affected/aggregate-task-unreached',
    category: 'affected',
    kind: 'efficiency',
    title: 'A task that only aggregates others is left out when nothing it depends on changed',
    from: ['affected-dependents'],
    needs: ['affected'],
    workspace: (() => {
      const ws = edges()
      const app = ws.projects['app']!
      app.tasks = { ...app.tasks, all: { command: 'true', dependsOn: ['build'] } }
      return ws
    })(),
    steps: [
      { write: { 'packages/tool/src/index.txt': 'tool2\n' } },
      { commit: 'tool' },
      { affected: 'all', base: 'HEAD~1', expect: { exit: 0, notRan: ['app#all'] } },
    ],
  }),

  defineCase({
    id: 'affected/task-named-like-object-member',
    category: 'affected',
    kind: 'correctness',
    title: 'A task named `toString` is declared only where it is written',
    why: 'Every object inherits a `toString`; a project that never declared the task must not read as declaring it.',
    from: ['affected-dependents'],
    needs: ['affected'],
    workspace: (() => {
      const ws = edges()
      ws.projects['tool']!.tasks = { toString: { command: 'true', inputs: ['**'], outputs: [] } }
      return ws
    })(),
    steps: [
      ...editLib(),
      { affected: 'toString', base: 'HEAD~1', expect: { exit: 0, notRan: ['tool#toString'] } },
    ],
  }),

  defineCase({
    id: 'affected/uncached-task-reads-whole-project',
    category: 'affected',
    kind: 'correctness',
    title: 'Any change in a project selects its task that is never cached',
    why: 'A task that is never cached declares no inputs: any file of its project may be what it reads.',
    from: ['affected-dependents', 'affected-dry-reasons'],
    needs: ['affected'],
    workspace: edges(),
    steps: [
      { write: { 'packages/lib/README.md': 'docs\n' } },
      { commit: 'readme' },
      {
        affected: 'lint',
        base: 'HEAD~1',
        expect: { exit: 0, ran: ['lib#lint'], notRan: ['tool#lint'] },
      },
    ],
  }),

  defineCase({
    id: 'affected/dependent-without-task-edge',
    category: 'affected',
    kind: 'efficiency',
    title: 'A dependent whose task waits on nothing of the change is left out',
    why: 'Its build declares no edge to the dependency’s build and reads none of its files.',
    from: ['affected-dependents'],
    needs: ['affected'],
    workspace: (() => {
      const ws = edges()
      const app = ws.projects['app']!
      app.tasks = { build: { command: 'true', inputs: ['src/**'], outputs: [] } }
      return ws
    })(),
    steps: [
      ...editLib(),
      {
        affected: 'build',
        base: 'HEAD~1',
        expect: { exit: 0, ran: ['lib#build'], notRan: ['app#build'] },
      },
    ],
  }),

  defineCase({
    id: 'affected/edge-free-task-stays-put',
    category: 'affected',
    kind: 'efficiency',
    title: 'A task with no edge to other projects runs only where the change is',
    why: 'app’s `style` reads app’s sources alone; lib’s edit changes nothing it reads.',
    from: ['parity-nx'],
    needs: ['affected'],
    workspace: edges(),
    steps: [
      ...editLib(),
      {
        affected: 'style',
        base: 'HEAD~1',
        expect: { exit: 0, ran: ['lib#style'], notRan: ['app#style', 'tool#style'] },
      },
    ],
  }),

  defineCase({
    id: 'affected/task-diamond-reached',
    category: 'affected',
    kind: 'correctness',
    title: 'A task reaches a change through either arm of a diamond of task edges',
    from: ['affected-tasks'],
    needs: ['affected'],
    workspace: diamond(),
    steps: [
      { write: { 'packages/app/zero.txt': '1\n' } },
      { commit: 'zero' },
      { affected: 'top', base: 'HEAD~1', expect: { exit: 0, ran: ['app#top', 'app#seed'] } },
    ],
  }),

  defineCase({
    id: 'affected/task-diamond-unreached',
    category: 'affected',
    kind: 'efficiency',
    title: 'A task whose edges never reach the changed task is left out',
    from: ['affected-tasks'],
    needs: ['affected'],
    workspace: diamond(),
    steps: [
      { write: { 'packages/app/zero.txt': '1\n' } },
      { commit: 'zero' },
      {
        affected: 'side',
        base: 'HEAD~1',
        expect: { exit: 0, notRan: ['app#side', 'app#left', 'app#base'] },
      },
    ],
  }),

  // --- Root inputs and links ---

  defineCase({
    id: 'affected/root-input-selects-reader',
    category: 'affected',
    kind: 'correctness',
    title: 'A change to a root file a task names as an input selects that task',
    why: 'The file is in no project, but the task’s result depends on it.',
    from: ['affected-workspace-files'],
    needs: ['affected'],
    workspace: sharedReader(),
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['app#build'] } },
      { write: { 'shared/schema.txt': 'v2\n' } },
      { commit: 'schema' },
      {
        affected: 'build',
        base: 'HEAD~1',
        expect: { exit: 0, ran: ['app#build'], files: { 'packages/app/dist/out.txt': 'v2\n' } },
      },
    ],
  }),

  defineCase({
    id: 'affected/root-input-in-another-project',
    category: 'affected',
    kind: 'correctness',
    title: 'A file in one project that another names as a root input selects both',
    from: ['affected-workspace-files'],
    needs: ['affected'],
    workspace: {
      projects: {
        app: {
          tasks: { build: ALL_FILES },
          files: { 'data.json': '{"v":1}\n' },
        },
        tool: {
          tasks: {
            build: {
              command: 'cat ../app/data.json',
              inputs: [],
              rootInputs: ['packages/app/data.json'],
              outputs: [],
            },
          },
        },
      },
    },
    steps: [
      { write: { 'packages/app/data.json': '{"v":2}\n' } },
      { commit: 'data' },
      {
        affected: 'build',
        base: 'HEAD~1',
        expect: { exit: 0, ran: ['app#build', 'tool#build'] },
      },
    ],
  }),

  defineCase({
    id: 'affected/root-manifest-edit',
    category: 'affected',
    kind: 'efficiency',
    title: 'Editing the root package.json in a way no task reads selects nothing',
    why: 'A description changes no task’s inputs, no dependency and no command.',
    from: ['affected-workspace-files'],
    needs: ['affected'],
    workspace: sharedReader(),
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['app#build'] } },
      describePackage('package.json'),
      { commit: 'root manifest' },
      { affected: 'build', base: 'HEAD~1', expect: { exit: 0, notRan: ['app#build'] } },
    ],
  }),

  defineCase({
    id: 'affected/root-input-not-uncached-sibling',
    category: 'affected',
    kind: 'efficiency',
    title: 'A root file one task reads does not select its project’s other, never-cached task',
    why: 'Only the build names the root file; the lint reads its own project, which did not change.',
    from: ['affected-workspace-files'],
    needs: ['affected'],
    workspace: sharedReader({ lint: { command: 'true', cache: false } }),
    steps: [
      { write: { 'shared/schema.txt': 'v2\n' } },
      { commit: 'schema' },
      { affected: 'lint', base: 'HEAD~1', expect: { exit: 0, notRan: ['app#lint'] } },
      { affected: 'build', base: 'HEAD~1', expect: { exit: 0, ran: ['app#build'] } },
      { write: { 'packages/app/src/index.txt': 'app2\n' } },
      { commit: 'app' },
      { affected: 'lint', base: 'HEAD~1', expect: { exit: 0, ran: ['app#lint'] } },
    ],
  }),

  defineCase({
    id: 'affected/root-input-selects-its-task-only',
    category: 'affected',
    kind: 'efficiency',
    title: 'Each task’s own root config file selects that task, not its sibling',
    from: ['affected-workspace-files'],
    needs: ['affected'],
    workspace: {
      projects: {
        app: {
          tasks: {
            build: { command: 'true', inputs: ['src/**'], rootInputs: ['build.cfg'], outputs: [] },
            test: { command: 'true', inputs: ['src/**'], rootInputs: ['test.cfg'], outputs: [] },
          },
          files: { 'src/index.txt': 'app\n' },
        },
      },
      files: { 'build.cfg': 'b1\n', 'test.cfg': 't1\n', 'other.cfg': 'o1\n' },
    },
    steps: [
      { write: { 'test.cfg': 't2\n' } },
      { commit: 'test config' },
      { affected: 'build', base: 'HEAD~1', expect: { exit: 0, notRan: ['app#build'] } },
      { affected: 'test', base: 'HEAD~1', expect: { exit: 0, ran: ['app#test'] } },
      { write: { 'other.cfg': 'o2\n' } },
      { commit: 'other' },
      { affected: 'test', base: 'HEAD~1', expect: { exit: 0, notRan: ['app#test'] } },
    ],
  }),

  defineCase({
    id: 'affected/root-input-in-nested-repo',
    category: 'affected',
    kind: 'correctness',
    title: 'An edit inside a nested repository a root input reaches selects the task naming it',
    why: 'git reports the nested repository as one path, never the files inside that the task reads.',
    from: ['affected-workspace-files'],
    needs: ['affected'],
    workspace: {
      projects: Object.fromEntries(
        [
          ['tool', 'vendor/sub/**'],
          ['gen', 'vendor/*/f.txt'],
          ['fresh', 'vendor/new/**'],
        ].map(([name, glob]): [string, ProjectSpec] => [
          name!,
          { tasks: { build: { command: 'true', inputs: [], rootInputs: [glob!], outputs: [] } } },
        ]),
      ),
      files: { 'vendor/sub/f.txt': '1\n' },
    },
    steps: [
      { sh: embed('sub') },
      {
        affected: 'build',
        base: 'HEAD',
        expect: { exit: 0, notRan: ['tool#build', 'gen#build', 'fresh#build'] },
      },
      { write: { 'vendor/sub/f.txt': '2\n' } },
      {
        affected: 'build',
        base: 'HEAD',
        expect: { exit: 0, ran: ['tool#build', 'gen#build'], notRan: ['fresh#build'] },
      },
      { write: { 'vendor/sub/f.txt': '1\n', 'vendor/new/x.txt': 'x\n' } },
      { sh: 'git -C vendor/new init -q' },
      {
        affected: 'build',
        base: 'HEAD',
        expect: { exit: 0, ran: ['fresh#build'], notRan: ['tool#build'] },
      },
    ],
  }),

  defineCase({
    id: 'affected/glob-through-project-dir-link',
    category: 'affected',
    kind: 'correctness',
    title: 'An edit behind a directory link selects a task whose `src/**/*.txt` reaches through it',
    from: ['affected-workspace-files'],
    needs: ['affected'],
    workspace: {
      projects: {
        app: {
          tasks: {
            txt: { command: 'true', inputs: ['src/**/*.txt'], outputs: [] },
            md: { command: 'true', inputs: ['src/*.md'], outputs: [] },
          },
          files: { 'src/a.txt': 'a\n', 'src/a.md': 'a\n' },
        },
      },
      files: { 'linked/b.txt': '1\n' },
    },
    steps: [
      { link: { 'packages/app/src/v': '../../../linked' } },
      { commit: 'link' },
      { write: { 'linked/b.txt': '2\n' } },
      { commit: 'edit behind the link' },
      { affected: 'txt', base: 'HEAD~1', expect: { exit: 0, ran: ['app#txt'] } },
    ],
  }),

  defineCase({
    id: 'affected/glob-short-of-dir-link',
    category: 'affected',
    kind: 'efficiency',
    title: 'An edit behind a directory link leaves out a task whose glob stops above it',
    why: '`src/*.md` reads no file inside `src/v/`.',
    from: ['affected-workspace-files'],
    needs: ['affected'],
    workspace: {
      projects: {
        app: {
          tasks: {
            txt: { command: 'true', inputs: ['src/**/*.txt'], outputs: [] },
            md: { command: 'true', inputs: ['src/*.md'], outputs: [] },
          },
          files: { 'src/a.txt': 'a\n', 'src/a.md': 'a\n' },
        },
      },
      files: { 'linked/b.txt': '1\n' },
    },
    steps: [
      { link: { 'packages/app/src/v': '../../../linked' } },
      { commit: 'link' },
      { write: { 'linked/b.txt': '2\n' } },
      { commit: 'edit behind the link' },
      { affected: 'md', base: 'HEAD~1', expect: { exit: 0, notRan: ['app#md'] } },
    ],
  }),

  defineCase({
    id: 'affected/root-glob-through-dir-link',
    category: 'affected',
    kind: 'correctness',
    title:
      'An edit behind a root directory link selects a task whose root input reaches through it',
    from: ['affected-workspace-files'],
    needs: ['affected'],
    workspace: {
      projects: {
        app: {
          tasks: {
            txt: { command: 'true', inputs: [], rootInputs: ['shared/**/*.txt'], outputs: [] },
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
      files: { 'linked/b.txt': '1\n', 'shared/a.txt': 'a\n' },
    },
    steps: [
      { link: { 'shared/v': '../linked' } },
      { commit: 'link' },
      { write: { 'linked/b.txt': '2\n' } },
      { commit: 'edit behind the link' },
      { affected: 'txt', base: 'HEAD~1', expect: { exit: 0, ran: ['app#txt'] } },
    ],
  }),

  // --- Selection the same tests pin ---

  defineCase({
    id: 'graph/exclude-keeps-root-project',
    category: 'graph',
    kind: 'correctness',
    title: 'An exclude alone keeps the workspace-root project, as it keeps every other member',
    from: ['root-project'],
    needs: ['filter'],
    workspace: rootAndMembers(['b', 'c']),
    steps: [
      {
        run: 'build',
        select: [{ name: 'c', exclude: true }],
        expect: { exit: 0, ran: ['root#build', 'b#build'], notRan: ['c#build'] },
      },
    ],
  }),

  defineCase({
    id: 'graph/selected-project-lacks-task',
    category: 'graph',
    kind: 'correctness',
    title: 'Running a task in a named project that does not declare it fails',
    why: 'The user named the scope: a run that does nothing there and exits 0 hides a typo.',
    from: ['affected-sparse-tasks'],
    needs: ['filter'],
    workspace: {
      projects: {
        app: { tasks: { test: ALL_FILES }, files: { 'own.txt': 'app\n' } },
        docs: { tasks: { lint: ALL_FILES }, files: { 'own.txt': 'docs\n' } },
      },
    },
    steps: [{ run: 'test', projects: ['docs'], expect: { exit: 'fail', notRan: ['app#test'] } }],
  }),

  defineCase({
    id: 'graph/selected-projects-some-lack-task',
    category: 'graph',
    kind: 'correctness',
    title: 'Running a task in named projects runs it where declared; one that lacks it is no error',
    from: ['affected-sparse-tasks'],
    needs: ['filter'],
    workspace: {
      projects: {
        app: { tasks: { test: ALL_FILES }, files: { 'own.txt': 'app\n' } },
        docs: { tasks: { lint: ALL_FILES }, files: { 'own.txt': 'docs\n' } },
      },
    },
    steps: [{ run: 'test', projects: ['docs', 'app'], expect: { exit: 0, ran: ['app#test'] } }],
  }),
]
