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
    why: 'A change set is the union of every file it touched, so each project with an edited file must be selected. Stopping at the first project found, or picking one, leaves the other untested. The project left out is then free to ship broken from the same pull request.',
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
    why: 'Files staged with `git add` are on disk and about to be committed, so tasks read them like any other edit. A comparison that looks only at the working tree against the index, or only at commits, misses them. A developer who stages before checking would see an empty run and commit untested work.',
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
    why: 'A file removed from the working tree is gone for every task that reads the project, even before the delete is committed. Its project must be selected, since an import or fixture it held may now be missing. Seeing only edits and new files would let a breaking delete pass a local check.',
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
    why: 'A rename changes the project’s file set: a task over `*` sees a new name, and an import of the old path now fails. The project must be selected, but nothing outside it changed, so other projects stay out. Missing the rename hides a broken import; selecting everything wastes the run.',
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
    why: 'Moving a file out of one project and into another changes both: one lost an input, the other gained one. git may report the move as a single rename, but its two paths belong to two projects. Selecting only the target leaves the source untested after it lost a file it may still need.',
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
    why: 'Once committed, a move between projects still changes both: one lost an input, the other gained one. git’s diff may fold the move into a single rename entry, but both of its paths must be checked against projects. Counting only the new path leaves the project that lost the file untested.',
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
    why: 'A file name with accented or other non-ASCII letters is as much a source as any other. By default git quotes and escapes such names in its plain output, so a reader that takes them literally gets a path that matches no project. The change is then dropped and the project’s tests do not run.',
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
    why: 'A quote or a backslash in a file name is legal and does occur, for example in generated test fixtures. git escapes these characters in its plain output, so a naive reader sees a path no project owns. The edit is then silently dropped, and a broken project passes as unaffected.',
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
    why: 'Files git ignores, such as an installed `node_modules` or a local build cache, are local state, not changes to the source. Counting them would select a project after every install, on every machine differently. Affected runs would then select much more than the change touched, and their selection would depend on whose machine ran them.',
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
    why: 'A file committed to the repository is a source, even if it sits under a directory named `node_modules`, as test fixtures often do. Only an untracked install there is the package manager’s local state. Skipping the committed file by its path would hide an edit that its project’s tests read.',
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
    why: 'A project owns a path only when the path continues with a `/` after the project’s directory. Matching on a bare string prefix makes `packages/app` claim `packages/app-e2e/x`, so an edit there also selects `app`. Worse, a longest-prefix bug can give the file to the wrong project and skip the one that changed.',
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
    why: 'When one project sits inside another, each file belongs to the innermost project that holds it. An edit in the inner project should not select the outer one, and the reverse holds too. Otherwise every change to the inner project reruns the outer project’s tasks, which never read those files.',
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
    why: 'A base far back, as on a long-lived branch, must select exactly what the commits since then changed. A tool that gives up past some depth and selects everything turns long branches into full runs. One that reads only the last commit misses earlier changes and leaves them untested.',
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
    why: 'Large commits happen: generated code, vendored packages, a mass rename. A diff whose list of paths outgrows a fixed output buffer must still be read in full. Failing the run blocks the merge for no real reason, and falling back to everything wastes the run on projects the commit never touched.',
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
    why: 'When a whole project is deleted, the projects that remain read none of its files, so nothing they depend on changed. The deleted project has no task left to run. Selecting every project because the workspace list changed makes a cleanup pull request cost a full CI run.',
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
    why: 'A project that moves to another directory is still that project, and its tasks now run from its new place. Its files all changed paths, so it must be selected. Matching the old path finds nothing and skips the project, leaving the move, and any path it broke, untested.',
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
    why: 'When a directory inside a project becomes a project of its own, the outer project stops owning those files. A task over the outer project’s `**` now reads less, so its result can change. Selecting only the new project misses that the parent’s inputs shrank, which can hide a broken reference.',
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
    why: 'A base that names no commit, often a typo or a branch the CI checkout did not fetch, means the tool cannot know what changed. It must fail the run or run everything, never treat the unknown diff as empty. Running nothing turns the job green while it checked nothing at all.',
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
    why: 'The base often comes from a CI variable or a pull request field, so it is input the tool must not trust. A base spelled like `--output=<file>` must be treated as a revision, never handed to git as an option. Passed through, it makes git write or overwrite a file in the checkout.',
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
    why: 'A base like `HEAD:packages` names a directory inside a commit, not a commit, and its paths lack the `packages/` prefix. Compared as if it were a commit, every project looks changed and the whole workspace runs. The tool should resolve what the base means, or refuse it, rather than widen the selection.',
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
    why: 'A base written as `^main` asks for what this branch has that main does not. Reading it as `main` itself counts main’s own later commits as this branch’s change. A pull request would then rerun the tests of projects only main touched, which is time spent on code this branch did not change.',
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
    why: 'If git cannot read the diff, for example because an object is missing from a damaged clone, the tool does not know what changed. An unreadable diff is not an empty one. It must fail or run everything; running nothing turns a broken checkout into a green job that checked nothing.',
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
    why: 'A user may set `diff.ignoreSubmodules` to quiet git’s diff, but the task still reads the submodule’s files. An edit inside the submodule, or a bump to a new commit, changes what the task sees. Trusting the quieted diff skips the project, and its tests do not run on the new code.',
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
    why: 'Dependents reach a project only through the tasks they wait on, here its `build`. When the edited file is one only the project’s own `test` reads, and `build` excludes it, nothing a dependent builds on changed. Rerunning the dependents’ tests on every test-file edit wastes CI time for no new result.',
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
    why: 'An affected run answers which of the requested tasks the change can reach. If the change only touches files those tasks do not read, the right answer is an empty run that succeeds. Running the tasks anyway wastes time; failing turns a harmless change into a red build.',
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
    why: 'Selection decides which tasks the user asked for; it does not remove the tasks they need first. An affected build reads its dependency’s output, so that dependency must be built, or restored, before it even though it did not change. Leaving it out fails the build on a clean machine, or reads a stale output left on disk.',
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
    why: 'Users write input globs as `./src/**` as often as `src/**`, and both mean the same files. A matcher that compares the changed path with the literal pattern finds no match for the `./` form. The edit is then missed, and the task and its dependents do not run on the new source.',
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
    why: 'An exclude is part of what a task declares it reads, whatever its spelling. `!./src//**/*.test.txt` excludes the same files as `!src/**/*.test.txt`, so an edit to one of them reaches nothing. Failing to apply the exclude reruns the task and its dependents for a file it does not read.',
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
    why: 'Naming a directory such as `src` as an input means the files in it, and the cache key already reads it that way. Selection must use the same meaning, or an edit under the directory selects nothing. The task and its dependents would then not run, even though their cache key changed.',
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
    why: 'A task with no command of its own often groups others, like an `all` or `ci` task. It is affected whenever a task it waits on is affected. Dropping it because it reads no files would leave the grouped work out of the affected run, and CI would not check what the change reached.',
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
    why: 'A task that only groups others is affected only through them. When nothing it waits on can see the change, it has nothing to do. Selecting it anyway, because it reads no files of its own, runs all the grouped work on changes that never reach it.',
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
    why: 'A task can be named anything, including `toString` or `constructor`. Looking it up on a plain object finds the inherited member in every project, so projects that never declared the task appear to have it. The run then schedules tasks that do not exist, or fails on them.',
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
    why: 'A task that is never cached declares no inputs, so the tool cannot know which of its project’s files it reads. Any change in its project must select it, since any file may matter. Guessing a narrower set would skip a lint or check that the edit can make fail.',
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
    why: 'A project dependency alone does not make every task depend on the other project. If the dependent’s build declares no edge to the dependency’s build and reads none of its files, the change cannot reach it. Selecting it anyway reruns work whose result is already known.',
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
    why: 'A task with no edge to other projects reads only its own project’s files. A change in `lib` cannot alter what `app`’s `style` sees. Running it in every dependent project because of the package graph spends CI time on checks whose result is already known.',
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
    why: 'Task edges can form a diamond, where a task reaches a changed one through only one of two paths. The task must be selected if any path leads to the change. Following just one arm, or stopping at the first visited node, misses the task and leaves its result unchecked.',
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
    why: 'A task is affected only if one of its edges leads to a changed task. Tasks that share a project or a parent with the change are not enough. Selecting all of a project’s tasks when one of them changed reruns work that cannot see the edit, here `side`, `left` and `base`.',
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
    why: 'A file at the workspace root belongs to no project, but a task that names it as an input depends on it. Shared config and schemas often live there. If a change to it selects nothing, the tasks that read it are skipped and their output stays built against the old file.',
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
    why: 'A task may read a file inside another project, declared as a root input. A change to that file affects both the project that owns it and the task that reads it. Selecting only the owner leaves the reading task built against the old content.',
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
    why: 'An edit to the root `package.json` that no task reads, such as its description, changes no input, no dependency and no command. Treating every root manifest edit as a change to everything turns small housekeeping commits into full runs. Inputs are declared, so the tool can tell nothing reads the change.',
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
    why: 'A root input belongs to the task that names it, not to every task in that task’s project. A never-cached `lint` reads its own project, so a root file only the `build` names does not reach it. It must still run when its own project changes, which the case checks after.',
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
    why: 'Each task declares its own root inputs, so a root config file selects only the task that names it. Lumping all of a project’s root inputs together reruns `build` when only the test config changed. A root file no task names, like `other.cfg`, selects nothing.',
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
    why: 'A nested git repository appears in the outer one as a single path, or not at all, so its diff never lists the files inside. A task whose root input reaches into it still reads those files. Trusting the outer diff alone misses the edit and leaves the task built against the old content.',
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
    why: 'A directory link inside a project makes the files it points at part of what an input glob like `src/**/*.txt` reads. git sees an edit there under the link’s target path, not the project’s. Without following the link, the task that reads the edited file is not selected.',
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
    why: 'Following links must stay as precise as the glob itself. `src/*.md` reads only files directly in `src/`, none inside `src/v/`, so an edit behind that link does not reach it. Selecting every task in the project whenever a linked file changes reruns work for no reason.',
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
    why: 'A root input such as `shared/**/*.txt` reads the files behind a directory link under `shared/`. git reports an edit there at the link’s target, outside the glob’s literal path. The link must be followed, or the task that reads the file is not selected.',
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
    why: 'An exclude filter removes what it names and keeps everything else. The workspace-root project is a project like any other, so excluding `c` keeps it. Dropping it silently skips root tasks such as code generation or a lint over shared config.',
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
    why: 'Naming a project and a task is an explicit request. If that project does not declare the task, nothing can satisfy it, and the run must fail. Exiting 0 after running nothing hides a typo in the task or project name, and CI reports a check that never ran.',
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
    why: 'Across several named projects, the task runs where it is declared; one project lacking it is normal in a mixed workspace. Failing the whole run for that forces every project to declare every task. The run fails only when the task exists nowhere in scope.',
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
