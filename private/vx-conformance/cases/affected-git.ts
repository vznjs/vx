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
    why: 'The definition is what the task runs: a new command is a change as much as a new source.',
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
    why: 'Their dependency’s build is gone from their inputs: what they built against has changed.',
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
    why: 'Comparing with the merge base is what a pull request means: main’s own later commits are not this branch’s change.',
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
    why: 'A pull request’s merge checkout: HEAD^1 is the base branch, the merge adds the branch’s changes.',
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
    why: 'CI checks out one commit by default; the base it lacks is on origin, and failing or selecting everything is not what was asked.',
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
    why: 'A pull request’s CI job: the base branch and the merge base are on origin, not in the one-commit checkout.',
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
    why: 'GitHub’s pull request checkout is a merge commit fetched alone; its first parent is the base.',
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
    why: 'The flag is a promise to git’s status, not to the build: the file on disk is what a task reads.',
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
    why: 'Not materialised is what a sparse checkout is: nobody changed the file.',
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
    why: 'The task reads the content behind the link, wherever in the workspace it lives.',
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
    why: 'git’s diff cannot see the target, so it cannot say the target did not change.',
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
    why: 'Which projects are in scope depends on what changed: a task only unchanged projects declare is not a typo.',
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
    why: 'A typo that exits 0 is a CI job that silently tests nothing.',
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
    why: '`ignore = all` quiets `git status`; the task still reads the files.',
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
