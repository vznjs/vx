// `affected` against the git shapes a real checkout has: flagged index
// entries, links, branches and tags, merge commits, shallow clones,
// submodules and nested repositories.
import { defineCase, type ProjectSpec, type TaskSpec, type WorkspaceSpec } from '../src/spec.ts'

const BUILD: TaskSpec = {
  command: 'mkdir -p dist && cat src/*.txt > dist/out.txt',
  dependsOn: ['^build'],
  inputs: ['src/**'],
  outputs: ['dist/**'],
}
const TEST: TaskSpec = { command: 'cat src/a.txt', dependsOn: ['build'], inputs: ['src/**'] }

/** lib ← app, and docs on its own; each builds and tests its own sources. */
function workspace(): WorkspaceSpec {
  const project = (name: string, deps: string[] = []): ProjectSpec => ({
    deps,
    tasks: { build: BUILD, test: TEST },
    files: { 'src/a.txt': `${name}\n` },
  })
  return { projects: { lib: project('lib'), app: project('app', ['lib']), docs: project('docs') } }
}

const ALL = ['lib#test', 'app#test', 'docs#test']
const LIB = { ran: ['lib#test'], notRan: ['docs#test'] }
const LIB_AND_DEPENDENT = { ran: ['lib#test', 'app#test'], notRan: ['docs#test'] }

/** `a` and `b`, each a `test` over its own sources. */
function pair(extra: Record<string, string> = {}): WorkspaceSpec {
  const project = (name: string): ProjectSpec => ({
    tasks: { test: { command: `cat src/own.txt`, inputs: ['src/**'] } },
    files: { 'src/own.txt': `${name}\n` },
  })
  return { projects: { a: project('a'), b: project('b') }, files: extra }
}

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

/**
 * What CI's default checkout leaves: origin holds the history, this clone
 * HEAD alone (`git clone --depth 1`), and no branch but the current one.
 */
function depthOne(drop: string[] = []): string {
  return [
    'git clone -q --bare . .home/origin.git',
    'git -C .home/origin.git config uploadpack.allowFilter true',
    'git remote add origin "file://$PWD/.home/origin.git"',
    ...drop.map((b) => `git branch -qD ${b}`),
    'git rev-parse HEAD > .git/shallow',
    'git reflog expire --expire=now --all',
    'git gc -q --prune=now',
    '! git cat-file -e HEAD~1 2>/dev/null',
  ].join(' && ')
}

/** A workspace `a` and `sub`, `sub` a submodule; each tests its own sources. */
function withSubmodule(): WorkspaceSpec {
  const project = (name: string): ProjectSpec => ({
    tasks: { test: { command: 'cat src/a.txt', inputs: ['src/**'] } },
    files: { 'src/a.txt': `${name}\n` },
  })
  return { projects: { a: project('a'), sub: project('sub') } }
}

export default [
  defineCase({
    id: 'affected/uncommitted-reaches-dependents',
    category: 'affected',
    kind: 'correctness',
    title: 'An uncommitted edit selects its project and every project that depends on it',
    why: 'An uncommitted edit changes what dependents build against just as a commit does. A local affected run must reach every dependent, not only the edited project. Otherwise the developer sees a green check while `app`, built on the edited `lib`, was never tested.',
    from: ['affected-dry-reasons'],
    needs: ['affected'],
    workspace: workspace(),
    steps: [
      { write: { 'packages/lib/src/a.txt': 'lib2\n' } },
      { affected: 'test', base: 'HEAD', expect: { exit: 0, ...LIB_AND_DEPENDENT } },
    ],
  }),

  defineCase({
    id: 'affected/changed-task-definition',
    category: 'affected',
    kind: 'correctness',
    title: 'Changing a project’s task definition selects it and its dependents',
    why: 'A task’s definition is what it runs: a new command, flag or dependency is a change as much as a new source. Its project and every dependent must be selected. Comparing only source files misses a config change that breaks the build, and CI stays green.',
    from: ['affected-dry-reasons', 'affected-config-deleted'],
    needs: ['affected'],
    workspace: workspace(),
    steps: [
      {
        configure: (ws) => {
          const lib = ws.projects['lib']!
          const tasks = { ...lib.tasks, build: { ...BUILD, command: `${BUILD.command} && true` } }
          return { ...ws, projects: { ...ws.projects, lib: { ...lib, tasks } } }
        },
      },
      { commit: 'new lib build' },
      { affected: 'test', base: 'HEAD~1', expect: { exit: 0, ran: ['lib#test', 'app#test'] } },
    ],
  }),

  defineCase({
    id: 'affected/removed-tasks-select-dependents',
    category: 'affected',
    kind: 'correctness',
    title: 'Removing every task of a dependency selects the projects depending on it',
    why: 'When a dependency loses its tasks, what its dependents built against has changed: the build they waited on is gone. The dependents must run to show whether they still work. Treating the removed tasks as nothing to select hides a broken dependency chain.',
    from: ['affected-config-deleted'],
    needs: ['affected'],
    workspace: workspace(),
    steps: [
      {
        configure: (ws) => ({
          ...ws,
          projects: { ...ws.projects, lib: { ...ws.projects['lib']!, tasks: {} } },
        }),
      },
      { commit: 'drop lib tasks' },
      {
        affected: 'build',
        base: 'HEAD~1',
        expect: { exit: 0, ran: ['app#build'] },
      },
    ],
  }),

  defineCase({
    id: 'affected/several-commits',
    category: 'affected',
    kind: 'correctness',
    title: 'A base several commits back selects what every commit since changed',
    why: 'A base several commits back must cover every commit since then, not only the latest. Each commit may touch a different project. Comparing only HEAD with its parent leaves earlier changes on the branch untested, so a pull request with many commits passes with gaps.',
    from: ['affected-shallow'],
    needs: ['affected'],
    workspace: workspace(),
    steps: [
      { write: { 'packages/lib/src/a.txt': 'lib2\n' } },
      { commit: 'lib' },
      { write: { 'packages/docs/src/a.txt': 'docs2\n' } },
      { commit: 'docs' },
      { affected: 'test', base: 'HEAD~2', expect: { exit: 0, ran: ALL } },
    ],
  }),

  defineCase({
    id: 'affected/branch-base-is-merge-base',
    category: 'affected',
    kind: 'efficiency',
    title: 'A branch base selects what this branch changed, not what the base branch did since',
    why: 'Comparing against a branch means comparing against where this branch left it, the merge base, as a pull request does. Commits main gained since then are not this branch’s change. Comparing directly with main’s tip selects projects only main touched and reruns their tests on every pull request.',
    from: ['affected-shallow'],
    needs: ['affected'],
    workspace: workspace(),
    steps: [
      { sh: 'git checkout -qb feat' },
      { write: { 'packages/lib/src/a.txt': 'lib2\n' } },
      { commit: 'feat: lib' },
      { sh: 'git checkout -q main' },
      { write: { 'packages/docs/src/a.txt': 'docs2\n' } },
      { commit: 'main: docs' },
      { sh: 'git checkout -q feat' },
      { affected: 'test', base: 'main', expect: { exit: 0, ...LIB } },
    ],
  }),

  defineCase({
    id: 'affected/merge-commit-first-parent',
    category: 'affected',
    kind: 'correctness',
    title: 'On a merge commit, the first parent as base selects what the merge brought in',
    why: 'CI often checks out the merge of a pull request into its base. On that merge commit, the first parent is the base branch, so comparing with `HEAD^1` gives exactly what the merge brought in. Main’s own commits must not be counted, or each pull request reruns unrelated tests.',
    from: ['affected-shallow'],
    needs: ['affected'],
    workspace: workspace(),
    steps: [
      { sh: 'git checkout -qb feat' },
      { write: { 'packages/lib/src/a.txt': 'lib2\n' } },
      { commit: 'feat: lib' },
      { sh: 'git checkout -q main' },
      { write: { 'packages/docs/src/a.txt': 'docs2\n' } },
      { commit: 'main: docs' },
      { sh: 'git merge -q --no-ff -m merge feat' },
      { affected: 'test', base: 'HEAD^1', expect: { exit: 0, ...LIB } },
    ],
  }),

  defineCase({
    id: 'affected/tag-base',
    category: 'affected',
    kind: 'correctness',
    title: 'A tag works as a base, as a branch does',
    why: 'Releases are often compared against the last tag, so a tag must work as a base just as a branch does. Rejecting it, or resolving it to the wrong commit, forces users to look up commit hashes by hand. Selecting everything instead makes every release run a full rebuild.',
    from: ['affected-shallow'],
    needs: ['affected'],
    workspace: workspace(),
    steps: [
      { sh: 'git tag v1' },
      { write: { 'packages/lib/src/a.txt': 'lib2\n' } },
      { commit: 'lib' },
      { affected: 'test', base: 'v1', expect: { exit: 0, ...LIB } },
    ],
  }),

  defineCase({
    id: 'affected/annotated-tag-base',
    category: 'affected',
    kind: 'correctness',
    title: 'An annotated tag works as a base: the commit it points at is compared',
    why: 'An annotated tag points at a tag object, which in turn points at a commit. The comparison must use that commit. Diffing against the tag object fails or resolves to nothing, and the release check either errors or reruns every project.',
    from: ['affected-shallow'],
    needs: ['affected'],
    workspace: workspace(),
    steps: [
      { sh: 'git tag -a -m release v1' },
      { write: { 'packages/lib/src/a.txt': 'lib2\n' } },
      { commit: 'lib' },
      { affected: 'test', base: 'refs/tags/v1', expect: { exit: 0, ...LIB } },
    ],
  }),

  defineCase({
    id: 'affected/shallow-clone',
    category: 'affected',
    kind: 'correctness',
    title: 'In a depth-2 clone, the previous commit as base selects the change and its dependents',
    why: 'CI often fetches only the last few commits. When the base is within that history, the tool can compute the diff normally and must do so. Bailing out because the clone is shallow, or selecting everything, throws away the affected run in exactly the place it saves the most time.',
    from: ['affected-base-notes', 'affected-shallow'],
    needs: ['affected'],
    workspace: workspace(),
    steps: [
      { write: { 'packages/docs/src/a.txt': 'docs2\n' } },
      { commit: 'docs' },
      { write: { 'packages/lib/src/a.txt': 'lib2\n' } },
      { commit: 'lib' },
      // What `git clone --depth 2` leaves: the parent of HEAD~1 is cut off.
      { sh: 'git rev-parse HEAD~1 > .git/shallow' },
      { affected: 'test', base: 'HEAD~1', expect: { exit: 0, ...LIB_AND_DEPENDENT } },
    ],
  }),

  defineCase({
    id: 'affected/depth-1-clone',
    category: 'affected',
    kind: 'correctness',
    title: 'In a depth-1 clone, the previous commit as base is fetched and selects the change',
    why: 'CI checks out a single commit by default, so the previous commit is not on disk but is on origin. The tool should fetch what it needs and select only the change. Failing breaks the default CI setup; selecting everything makes affected runs cost a full run in CI.',
    from: ['affected-base-notes', 'affected-shallow'],
    needs: ['affected'],
    workspace: workspace(),
    steps: [
      { write: { 'packages/lib/src/a.txt': 'lib2\n' } },
      { commit: 'lib' },
      { sh: depthOne() },
      { affected: 'test', base: 'HEAD~1', expect: { exit: 0, ...LIB_AND_DEPENDENT } },
    ],
  }),

  defineCase({
    id: 'affected/depth-1-branch-base',
    category: 'affected',
    kind: 'correctness',
    title:
      'In a depth-1 clone of a branch, the base branch on origin selects what the branch changed',
    why: 'A pull request job usually checks out one commit, with the base branch and merge base only on origin. Comparing with `origin/main` must fetch the history needed to find the merge base. Failing breaks the job; selecting everything turns each pull request into a full run.',
    from: ['affected-shallow'],
    needs: ['affected'],
    workspace: workspace(),
    steps: [
      { sh: 'git checkout -qb feat' },
      { write: { 'packages/lib/src/a.txt': 'lib2\n' } },
      { commit: 'feat: lib' },
      { sh: 'git checkout -q main' },
      { write: { 'packages/docs/src/a.txt': 'docs2\n' } },
      { commit: 'main: docs' },
      { sh: 'git checkout -q feat' },
      { sh: depthOne(['main']) },
      { affected: 'test', base: 'origin/main', expect: { exit: 0, ...LIB } },
    ],
  }),

  defineCase({
    id: 'affected/depth-1-merge-checkout',
    category: 'affected',
    kind: 'correctness',
    title:
      'In a depth-1 merge checkout, the first parent as base selects what the merge brought in',
    why: 'A common pull request checkout is the merge commit fetched alone, with neither parent present. Its first parent is the base, so comparing with `HEAD^1` must fetch it and select what the merge added. Failing or selecting everything loses the affected run on every pull request.',
    from: ['affected-shallow'],
    needs: ['affected'],
    workspace: workspace(),
    steps: [
      { sh: 'git checkout -qb feat' },
      { write: { 'packages/lib/src/a.txt': 'lib2\n' } },
      { commit: 'feat: lib' },
      { sh: 'git checkout -q main' },
      { write: { 'packages/docs/src/a.txt': 'docs2\n' } },
      { commit: 'main: docs' },
      { sh: 'git merge -q --no-ff -m merge feat' },
      { sh: depthOne(['feat']) },
      { affected: 'test', base: 'HEAD^1', expect: { exit: 0, ...LIB } },
    ],
  }),

  defineCase({
    id: 'affected/assume-unchanged-edit',
    category: 'affected',
    kind: 'correctness',
    title: 'An edit to a file marked assume-unchanged in git’s index selects its project',
    why: 'Marking a file assume-unchanged tells `git status` not to look at it; it does not freeze the file for the build. A task reads the file on disk, so an edit there changes its result. Trusting the flag hides the edit, and the project’s tests do not run on code it now reads.',
    from: ['affected-flagged'],
    needs: ['affected'],
    workspace: workspace(),
    steps: [
      { sh: 'git update-index --assume-unchanged packages/lib/src/a.txt' },
      { write: { 'packages/lib/src/a.txt': 'lib2\n' } },
      { affected: 'test', base: 'HEAD', expect: { exit: 0, ...LIB } },
    ],
  }),

  defineCase({
    id: 'affected/skip-worktree-edit',
    category: 'affected',
    kind: 'correctness',
    title: 'An edit to a file marked skip-worktree in git’s index selects its project',
    why: 'Skip-worktree hides a file from git’s view of the working tree, often to keep a local config edit. The task still reads the edited file, so the project must be selected. Trusting the flag means the edit is never tested, though it changes what the task produces.',
    from: ['affected-flagged'],
    needs: ['affected'],
    workspace: workspace(),
    steps: [
      { sh: 'git update-index --skip-worktree packages/lib/src/a.txt' },
      { write: { 'packages/lib/src/a.txt': 'lib2\n' } },
      { affected: 'test', base: 'HEAD', expect: { exit: 0, ...LIB } },
    ],
  }),

  defineCase({
    id: 'affected/assume-unchanged-deleted',
    category: 'affected',
    kind: 'correctness',
    title: 'Deleting a file marked assume-unchanged selects its project',
    why: 'A file marked assume-unchanged can still be deleted from disk, and the task then cannot read it. git’s status does not report the delete, so the tool must check the disk. Missing it leaves a project untested after a source it needs is gone.',
    from: ['affected-flagged'],
    needs: ['affected'],
    workspace: {
      projects: {
        ...workspace().projects,
        lib: { ...workspace().projects['lib']!, files: { 'src/a.txt': 'a\n', 'src/b.txt': 'b\n' } },
      },
    },
    steps: [
      { sh: 'git update-index --assume-unchanged packages/lib/src/b.txt' },
      { write: { 'packages/lib/src/b.txt': null } },
      { affected: 'test', base: 'HEAD', expect: { exit: 0, ...LIB } },
    ],
  }),

  defineCase({
    id: 'affected/sparse-absent-file',
    category: 'affected',
    kind: 'efficiency',
    title: 'A skip-worktree file absent from disk, as a sparse checkout leaves it, selects nothing',
    why: 'A sparse checkout leaves files out of the working tree on purpose and marks them skip-worktree. A file absent for that reason was not deleted by anyone. Counting it as a change would select every project with unmaterialised files on each run in a sparse checkout.',
    from: ['affected-flagged'],
    needs: ['affected'],
    workspace: {
      projects: {
        ...workspace().projects,
        lib: { ...workspace().projects['lib']!, files: { 'src/a.txt': 'a\n', 'src/b.txt': 'b\n' } },
      },
    },
    steps: [
      { sh: 'git update-index --skip-worktree packages/lib/src/b.txt' },
      { write: { 'packages/lib/src/b.txt': null } },
      { affected: 'test', base: 'HEAD', expect: { exit: 0, notRan: ALL } },
    ],
  }),

  defineCase({
    id: 'affected/edit-behind-file-link',
    category: 'affected',
    kind: 'correctness',
    title: 'An edit to the file an input link points at selects the link’s project',
    why: 'A task reads the content behind a file link, wherever in the workspace that content lives. git reports the edit at the target’s path, outside the project holding the link. The link must be followed, or the project that reads the file is not selected.',
    from: ['affected-linked-inputs'],
    needs: ['affected'],
    workspace: pair({ 'shared/x.txt': 'V1\n' }),
    steps: [
      { link: { 'packages/a/src/x.txt': '../../../shared/x.txt' } },
      { commit: 'link' },
      { write: { 'shared/x.txt': 'V2\n' } },
      {
        affected: 'test',
        base: 'HEAD',
        expect: { exit: 0, ran: ['a#test'], notRan: ['b#test'] },
      },
    ],
  }),

  defineCase({
    id: 'affected/edit-behind-dir-link',
    category: 'affected',
    kind: 'correctness',
    title: 'An edit inside the directory an input link points at selects the link’s project',
    why: 'A directory link makes the target directory part of the project that holds the link. git reports an edit there at the target’s path, which belongs to no project. Without following the link, the project that reads the file is skipped and its tests do not run on the new content.',
    from: ['affected-linked-inputs'],
    needs: ['affected'],
    workspace: pair({ 'shared/d/y.txt': 'Y1\n' }),
    steps: [
      { link: { 'packages/a/src/d': '../../../shared/d' } },
      { commit: 'link' },
      { write: { 'shared/d/y.txt': 'Y2\n' } },
      {
        affected: 'test',
        base: 'HEAD',
        expect: { exit: 0, ran: ['a#test'], notRan: ['b#test'] },
      },
    ],
  }),

  defineCase({
    id: 'affected/new-file-behind-dir-link',
    category: 'affected',
    kind: 'correctness',
    title: 'A new file in the directory an input link points at selects the link’s project',
    why: 'A new file in a linked directory is a new input for the project holding the link, as an input glob through the link now matches it. git reports it at the target’s path, not the project’s. Not following the link skips the project that now reads one more file.',
    from: ['affected-linked-inputs'],
    needs: ['affected'],
    workspace: pair({ 'shared/d/y.txt': 'Y1\n' }),
    steps: [
      { link: { 'packages/a/src/d': '../../../shared/d' } },
      { commit: 'link' },
      { write: { 'shared/d/new.txt': 'N\n' } },
      {
        affected: 'test',
        base: 'HEAD',
        expect: { exit: 0, ran: ['a#test'], notRan: ['b#test'] },
      },
    ],
  }),

  defineCase({
    id: 'affected/edit-behind-link-to-ignored',
    category: 'affected',
    kind: 'correctness',
    title: 'An edit to a git-ignored file an input link points at selects the link’s project',
    why: 'A link may point at a file git ignores, such as a local config. git’s diff cannot see that file, so it cannot say the file did not change. The tool must check what the link reads, or the project is skipped after an edit that changes its result.',
    from: ['affected-linked-inputs'],
    needs: ['affected'],
    workspace: pair({ 'shared/.gitignore': 'secret.txt\n', 'shared/secret.txt': 'S1\n' }),
    steps: [
      { link: { 'packages/b/src/s.txt': '../../../shared/secret.txt' } },
      { commit: 'link' },
      { write: { 'shared/secret.txt': 'S2\n' } },
      { affected: 'test', base: 'HEAD', expect: { exit: 0, ran: ['b#test'] } },
    ],
  }),

  defineCase({
    id: 'affected/unchanged-link-target',
    category: 'affected',
    kind: 'efficiency',
    title: 'A dangling link, or a link whose target did not change, selects nothing',
    why: 'Following links must stay precise. A dangling link reads nothing, and a link to an unchanged file reads the same bytes as before. Selecting every project that holds a link whenever anything nearby changes reruns work whose result cannot have changed.',
    from: ['affected-linked-inputs'],
    needs: ['affected'],
    workspace: pair({ 'shared/x.txt': 'V1\n', 'shared/d/y.txt': 'Y1\n' }),
    steps: [
      {
        link: {
          'packages/a/src/gone.txt': '../nowhere.txt',
          'packages/b/src/x.txt': '../../../shared/x.txt',
        },
      },
      { commit: 'links' },
      { write: { 'shared/d/y.txt': 'Y2\n' } },
      { affected: 'test', base: 'HEAD', expect: { exit: 0, notRan: ['a#test', 'b#test'] } },
    ],
  }),

  defineCase({
    id: 'affected/changed-project-lacks-task',
    category: 'affected',
    kind: 'correctness',
    title: 'When only a project without the task changed, the run succeeds and runs nothing',
    why: 'In an affected run, which projects are in scope depends on what changed. If only a project without the requested task changed, the correct result is an empty run that succeeds. The task exists elsewhere, so this is not a typo, and failing would turn a harmless change into a red build.',
    from: ['affected-sparse-tasks'],
    needs: ['affected'],
    workspace: {
      projects: {
        app: {
          tasks: { test: { command: 'cat in.txt', inputs: ['**'] } },
          files: { 'in.txt': 'x\n' },
        },
        docs: {
          tasks: { lint: { command: 'cat in.txt', inputs: ['**'] } },
          files: { 'in.txt': 'x\n' },
        },
      },
    },
    steps: [
      { write: { 'packages/docs/in.txt': 'y\n' } },
      { commit: 'docs only' },
      { affected: 'test', base: 'HEAD~1', expect: { exit: 0, notRan: ['app#test'] } },
      { affected: 'lint', base: 'HEAD~1', expect: { exit: 0, ran: ['docs#lint'] } },
    ],
  }),

  defineCase({
    id: 'affected/changed-dependent-lacks-task',
    category: 'affected',
    kind: 'correctness',
    title:
      'A changed project lacking the task, depending on one that has it, runs nothing and succeeds',
    why: 'A changed project that lacks the requested task has nothing to run, and the change cannot flow back into a project it depends on. The run should succeed and run nothing. Failing makes a change in a project without tests break a test job; running the dependency’s task wastes time.',
    from: ['affected-sparse-tasks'],
    needs: ['affected'],
    workspace: {
      projects: {
        app: {
          tasks: { test: { command: 'cat in.txt', inputs: ['**'] } },
          files: { 'in.txt': 'x\n' },
        },
        docs: {
          deps: ['app'],
          tasks: { lint: { command: 'cat in.txt', inputs: ['**'] } },
          files: { 'in.txt': 'x\n' },
        },
      },
    },
    steps: [
      { write: { 'packages/docs/in.txt': 'y\n' } },
      { commit: 'docs only' },
      { affected: 'test', base: 'HEAD~1', expect: { exit: 0, notRan: ['app#test'] } },
    ],
  }),

  defineCase({
    id: 'affected/changed-project-without-tasks',
    category: 'affected',
    kind: 'correctness',
    title:
      'When only a project declaring no tasks at all changed, the run succeeds and runs nothing',
    why: 'A project may declare no tasks at all, for example a folder of shared assets. A change there selects nothing for a task no project in scope has. The run should succeed with nothing to do; failing turns an edit in a task-less project into a red build.',
    from: ['affected-sparse-tasks'],
    needs: ['affected'],
    workspace: {
      projects: {
        app: {
          tasks: { test: { command: 'cat in.txt', inputs: ['**'] } },
          files: { 'in.txt': 'x\n' },
        },
        docs: { files: { 'in.txt': 'x\n' } },
      },
    },
    steps: [
      { write: { 'packages/docs/in.txt': 'y\n' } },
      { commit: 'docs only' },
      { affected: 'test', base: 'HEAD~1', expect: { exit: 0, notRan: ['app#test'] } },
    ],
  }),

  defineCase({
    id: 'affected/unknown-task-refused',
    category: 'affected',
    kind: 'correctness',
    title: 'An affected run of a task no project declares fails, whatever changed',
    why: 'A task no project declares can never run, whatever changed. The run must fail, so a typo like `tset` is caught at once. Exiting 0 because the change happened to select nothing turns a broken CI step into a green one that silently tests nothing.',
    from: ['affected-sparse-tasks'],
    needs: ['affected'],
    workspace: workspace(),
    steps: [
      { write: { 'packages/docs/src/a.txt': 'docs2\n' } },
      { commit: 'docs' },
      { affected: 'tset', base: 'HEAD~1', expect: { exit: 'fail' } },
      { affected: 'tset', base: 'HEAD', expect: { exit: 'fail' } },
    ],
  }),

  defineCase({
    id: 'affected/clean-submodule',
    category: 'affected',
    kind: 'efficiency',
    title: 'A project that is a clean submodule is not selected',
    why: 'A project can be a git submodule. When the submodule is clean and still on the recorded commit, nothing in it changed. Selecting it just because it is a submodule, or because git reports it as a special entry, reruns its tasks on every affected run for no change.',
    from: ['affected-submodule'],
    needs: ['affected'],
    workspace: withSubmodule(),
    steps: [
      { sh: submodule('sub') },
      { affected: 'test', base: 'HEAD', expect: { exit: 0, notRan: ['a#test', 'sub#test'] } },
    ],
  }),

  defineCase({
    id: 'affected/edit-in-submodule',
    category: 'affected',
    kind: 'correctness',
    title: 'An edit inside a submodule project selects it',
    why: 'A submodule’s files are read by its project’s tasks like any others. git’s diff of the outer repository reports a dirty submodule, not the file inside it. The tool must still map the edit to the project, or the submodule’s tests do not run on the change.',
    from: ['affected-submodule'],
    needs: ['affected'],
    workspace: withSubmodule(),
    steps: [
      { sh: submodule('sub') },
      { write: { 'packages/sub/src/a.txt': 'sub2\n' } },
      {
        affected: 'test',
        base: 'HEAD',
        expect: { exit: 0, ran: ['sub#test'], notRan: ['a#test'] },
      },
    ],
  }),

  defineCase({
    id: 'affected/untracked-in-submodule',
    category: 'affected',
    kind: 'correctness',
    title: 'A new untracked file inside a submodule project selects it',
    why: 'A new file inside a submodule is a new input for the tasks that read that project, even before it is tracked. The outer repository sees only that the submodule is dirty. Not looking inside skips the project and lets the new file go untested.',
    from: ['affected-submodule'],
    needs: ['affected'],
    workspace: withSubmodule(),
    steps: [
      { sh: submodule('sub') },
      { write: { 'packages/sub/src/new.txt': 'n\n' } },
      {
        affected: 'test',
        base: 'HEAD',
        expect: { exit: 0, ran: ['sub#test'], notRan: ['a#test'] },
      },
    ],
  }),

  defineCase({
    id: 'affected/submodule-pointer-moved',
    category: 'affected',
    kind: 'correctness',
    title: 'Moving a submodule to another commit selects it, committed or not',
    why: 'Moving a submodule to another commit swaps every file its project reads. The project must be selected whether the move is still in the working tree or already committed in the outer repository. Once compared against the commit that already holds the move, it must stop being selected.',
    from: ['affected-submodule'],
    needs: ['affected'],
    workspace: withSubmodule(),
    steps: [
      { sh: submodule('sub') },
      { write: { 'packages/sub/src/a.txt': 'sub2\n' } },
      { sh: 'git -C packages/sub commit -qam bump' },
      { affected: 'test', base: 'HEAD', expect: { exit: 0, ran: ['sub#test'] } },
      { commit: 'bump pointer' },
      {
        affected: 'test',
        base: 'HEAD~1',
        expect: { exit: 0, ran: ['sub#test'], notRan: ['a#test'] },
      },
      { affected: 'test', base: 'HEAD', expect: { exit: 0, notRan: ['a#test', 'sub#test'] } },
    ],
  }),

  defineCase({
    id: 'affected/submodule-ignore-all',
    category: 'affected',
    kind: 'correctness',
    title:
      'A submodule `.gitmodules` tells git to ignore still selects its project when it changes',
    why: 'Setting `ignore = all` for a submodule in `.gitmodules` quiets `git status`; it does not stop tasks from reading the files. An edit inside the submodule still changes what its project produces. Trusting the setting hides the change, and the project’s tests do not run.',
    from: ['affected-submodule'],
    needs: ['affected'],
    workspace: withSubmodule(),
    steps: [
      { sh: submodule('sub') },
      {
        sh: 'git config -f .gitmodules submodule.packages/sub.ignore all && git commit -qam ignore',
      },
      { write: { 'packages/sub/src/a.txt': 'sub2\n' } },
      { affected: 'test', base: 'HEAD', expect: { exit: 0, ran: ['sub#test'] } },
    ],
  }),

  defineCase({
    id: 'affected/edit-in-nested-submodule',
    category: 'affected',
    kind: 'correctness',
    title: 'An edit inside a submodule nested in a project selects that project',
    why: 'A submodule can sit inside a project, for example a vendored library. Its files belong to the project that holds it, and an edit there changes what that project’s tasks read. The outer diff only marks the submodule dirty, so the tool must map it to the holding project.',
    from: ['affected-submodule'],
    needs: ['affected'],
    workspace: {
      projects: {
        a: {
          tasks: { test: { command: 'cat vendor/lib/x.txt', inputs: ['**'] } },
          files: { 'vendor/lib/x.txt': '1\n' },
        },
        b: { tasks: { test: { command: 'true', inputs: ['**'] } }, files: { 'x.txt': '1\n' } },
      },
    },
    steps: [
      { sh: submodule('a/vendor/lib') },
      { affected: 'test', base: 'HEAD', expect: { exit: 0, notRan: ['a#test', 'b#test'] } },
      { write: { 'packages/a/vendor/lib/x.txt': '2\n' } },
      { affected: 'test', base: 'HEAD', expect: { exit: 0, ran: ['a#test'], notRan: ['b#test'] } },
    ],
  }),

  defineCase({
    id: 'affected/embedded-repo-in-project',
    category: 'affected',
    kind: 'correctness',
    title: 'A new git repository created inside a project selects that project',
    why: 'A git repository created inside a project, for example by a tool or a clone, is untracked content of that project. Its files are on disk and an input glob over the project reads them. git may hide its contents behind one path, so the project must be selected all the same.',
    from: ['affected-submodule'],
    needs: ['affected'],
    workspace: {
      projects: {
        a: { tasks: { test: { command: 'true', inputs: ['**'] } }, files: { 'x.txt': '1\n' } },
        b: { tasks: { test: { command: 'true', inputs: ['**'] } }, files: { 'x.txt': '1\n' } },
      },
    },
    steps: [
      { write: { 'packages/a/emb/e.txt': 'e\n' } },
      {
        sh: 'git -C packages/a/emb init -q && git -C packages/a/emb add -A && git -C packages/a/emb commit -qm e',
      },
      { affected: 'test', base: 'HEAD', expect: { exit: 0, ran: ['a#test'], notRan: ['b#test'] } },
    ],
  }),
]
