// A cached task's inputs against what git and the file system can hide:
// flagged index entries, stat-identical rewrites, an edit while the task
// runs, nested repositories, links in front of committed files.
import { defineCase, type Case, type ProjectSpec, type TaskSpec } from '../src/spec.ts'
import { CONCAT, one, out } from './shapes.ts'

const cached: TaskSpec = { command: CONCAT, inputs: ['src/**'], outputs: ['dist/**'] }

/** Build, flag `packages/a/src/a.txt` in git's index, edit it: the build must run again. */
function flagged(id: string, flag: string, title: string): Case {
  return defineCase({
    id: `inputs/${id}`,
    category: 'inputs',
    kind: 'correctness',
    title,
    why: 'The flag is a promise to git’s status, not to the build: the bytes on disk are what the task reads.',
    from: ['affected-flagged'],
    workspace: one(cached),
    steps: [
      { sh: `git update-index ${flag} packages/a/src/a.txt` },
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { write: { 'packages/a/src/a.txt': 'edited\n' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'edited\n' } } },
    ],
  })
}

/** Turns the committed `<dir>` into a repository of its own, a gitlink in the workspace's index or untracked. */
function nestRepo(dir: string, how: 'gitlink' | 'untracked'): string {
  return [
    `git rm -rq --cached ${dir}`,
    `git -C ${dir} init -q`,
    `git -C ${dir} add -A`,
    `git -C ${dir} commit -qm nested`,
    ...(how === 'gitlink' ? [`git add ${dir}`] : []),
    `git commit -qm nest`,
  ].join(' && ')
}

/** A project `b` in `vendor/nested/b`, inside a repository of its own. */
function projectInNestedRepo(how: 'gitlink' | 'untracked'): Case {
  const project: ProjectSpec = {
    dir: 'vendor/nested/b',
    tasks: { build: cached },
    files: { 'src/a.txt': 'one\n' },
  }
  return defineCase({
    id: `inputs/project-in-${how}-repo`,
    category: 'inputs',
    kind: 'correctness',
    title: `An edit to a project inside a nested repository (${how === 'gitlink' ? 'a submodule' : 'untracked'}) runs its task again`,
    why: 'The outer repository holds the nested one as one entry, or none: none of its files are the outer git’s to list.',
    from: ['nested-repo-inputs'],
    workspace: { projects: { b: project } },
    steps: [
      { sh: nestRepo('vendor/nested', how) },
      { run: 'build', expect: { exit: 0, ran: ['b#build'] } },
      { run: 'build', expect: { exit: 0, notRan: ['b#build'] } },
      { write: { 'vendor/nested/b/src/a.txt': 'two\n' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['b#build'], files: { 'vendor/nested/b/dist/out.txt': 'two\n' } },
      },
    ],
  })
}

/** A project `a` whose build reads `vendor/lib`, a repository of its own. */
function nestedRepoInProject(how: 'gitlink' | 'untracked'): Case {
  return defineCase({
    id: `inputs/${how}-repo-in-project`,
    category: 'inputs',
    kind: 'correctness',
    title: `An edit inside a nested repository (${how === 'gitlink' ? 'a submodule' : 'untracked'}) under a project’s input glob runs its task again`,
    why: 'The outer git holds the nested repository as one path, a directory; its files are still what the task reads.',
    from: ['nested-repo-inputs', 'affected-submodule'],
    workspace: one(
      {
        command: 'mkdir -p dist && cat vendor/lib/x.txt > dist/out.txt',
        inputs: ['vendor/**'],
        outputs: ['dist/**'],
      },
      { 'vendor/lib/x.txt': 'one\n' },
    ),
    steps: [
      { sh: nestRepo('packages/a/vendor/lib', how) },
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
      { write: { 'packages/a/vendor/lib/x.txt': 'two\n' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'two\n' } } },
    ],
  })
}

/** Project `a` reads `gen/d.txt`, where `gen` is a project of its own. */
function inputInNestedProject(id: string, inputs: string[], title: string): Case {
  return defineCase({
    id: `inputs/${id}`,
    category: 'inputs',
    kind: 'correctness',
    title,
    why: 'A tool may refuse the glob (another project’s files are its own) or key on it; replaying the old result is neither.',
    from: ['nested-input'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command: 'mkdir -p dist && cat gen/d.txt > dist/out.txt',
              inputs,
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'a\n' },
        },
        gen: {
          dir: 'packages/a/gen',
          tasks: { x: { command: 'true' } },
          files: { 'd.txt': 'd1\n' },
        },
      },
    },
    steps: [
      { run: 'build', projects: ['a'], expect: {} },
      { write: { 'packages/a/gen/d.txt': 'd2\n' } },
      { run: 'build', projects: ['a'], expect: { filesNot: { [out('a')]: 'd1\n' } } },
    ],
  })
}

export default [
  flagged(
    'assume-unchanged-edit',
    '--assume-unchanged',
    'Editing an input git was told to assume unchanged runs the task again',
  ),
  flagged(
    'skip-worktree-edit',
    '--skip-worktree',
    'Editing an input git was told to skip in the work tree runs the task again',
  ),

  defineCase({
    id: 'inputs/stat-identical-rewrite',
    category: 'inputs',
    kind: 'correctness',
    title: 'A same-size edit that keeps the file’s modification time runs the task again',
    why: 'Size and mtime are a hint, not the content: a file system with whole-second stamps, `cp -p` or `touch -r` leave both as they were.',
    from: ['whole-second-stamps', 'fs-clock-lag'],
    workspace: one(cached),
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      {
        sh: "touch -r packages/a/src/a.txt .home/stamp && printf 'b\\n' > packages/a/src/a.txt && touch -r .home/stamp packages/a/src/a.txt",
      },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'b\n' } } },
    ],
  }),

  defineCase({
    id: 'inputs/whole-second-rewrite',
    category: 'inputs',
    kind: 'correctness',
    title:
      'A same-size edit within the same whole-second stamp as the first write runs the task again',
    why: 'ext3, HFS+, FAT and some network mounts keep whole seconds: two writes in one second carry one stamp.',
    from: ['whole-second-stamps'],
    workspace: one(cached),
    steps: [
      { sh: "touch -d '2001-02-03 04:05:06' packages/a/src/a.txt" },
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      {
        sh: "printf 'b\\n' > packages/a/src/a.txt && touch -d '2001-02-03 04:05:06' packages/a/src/a.txt",
      },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'b\n' } } },
    ],
  }),

  defineCase({
    id: 'inputs/edited-while-running',
    category: 'inputs',
    kind: 'correctness',
    title: 'An input edited while the task runs is not replayed under the key of the bytes before',
    why: 'The output was made from the edited bytes: stored under the first bytes’ key, undoing the edit replays it.',
    from: ['fs-clock-lag'],
    workspace: one({
      command:
        "if [ ! -e ../../.home/edited ]; then touch ../../.home/edited; printf 'EDITED\\n' > src/a.txt; fi; mkdir -p dist && cat src/a.txt > dist/out.txt",
      inputs: ['src/**'],
      outputs: ['dist/**'],
    }),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'EDITED\n' } } },
      { write: { 'packages/a/src/a.txt': 'a\n' } },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'a\n' } } },
    ],
  }),

  projectInNestedRepo('gitlink'),
  projectInNestedRepo('untracked'),
  nestedRepoInProject('gitlink'),
  nestedRepoInProject('untracked'),

  defineCase({
    id: 'inputs/nested-repo-ignored-but-tracked',
    category: 'inputs',
    kind: 'correctness',
    title: 'A file a nested repository tracks despite its own ignore rule is an input',
    why: 'An ignore rule only stops untracked files: one the repository force-added is a source like any other.',
    from: ['nested-repo-inputs'],
    workspace: one(
      {
        command: 'mkdir -p dist && cat vendor/lib/keep.gen > dist/out.txt',
        inputs: ['vendor/**'],
        outputs: ['dist/**'],
      },
      { 'vendor/lib/x.txt': 'x\n', 'vendor/lib/keep.gen': 'one\n' },
    ),
    steps: [
      { sh: nestRepo('packages/a/vendor/lib', 'gitlink') },
      {
        sh: "cd packages/a/vendor/lib && printf '*.gen\\n' > .gitignore && git add .gitignore && git commit -qm ignore && cd - >/dev/null && git add packages/a/vendor/lib && git commit -qm bump",
      },
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { write: { 'packages/a/vendor/lib/keep.gen': 'two\n' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'two\n' } } },
    ],
  }),

  inputInNestedProject(
    'glob-into-nested-project',
    ['src/**', 'gen/**'],
    'An input glob over a nested project never replays a stale result',
  ),
  inputInNestedProject(
    'file-in-nested-project',
    ['src/**', 'gen/d.txt'],
    'An input naming a file of a nested project never replays a stale result',
  ),
  inputInNestedProject(
    'brace-into-nested-project',
    ['{src,gen}/**'],
    'A brace input reaching a nested project never replays a stale result',
  ),

  defineCase({
    id: 'outputs/committed-file-kept-when-git-fails',
    category: 'outputs',
    kind: 'correctness',
    title: 'A committed file in an output directory survives a run when git cannot read its index',
    why: 'A git that lists nothing says nothing is committed: a tool that clears outputs must refuse, not delete the user’s file.',
    from: ['committed-case'],
    workspace: one(
      {
        command: 'mkdir -p out && cp src/a.txt out/a.txt',
        inputs: ['src/**'],
        outputs: ['out/**'],
      },
      { 'src/a.txt': 'a\n', 'out/keep.txt': 'keep\n' },
    ),
    steps: [
      { sh: "printf 'not an index, but long enough to be read' > .git/index" },
      { run: 'build', expect: { files: { 'packages/a/out/keep.txt': 'keep\n' } } },
    ],
  }),

  defineCase({
    id: 'outputs/committed-file-behind-output-link',
    category: 'outputs',
    kind: 'correctness',
    title: 'A committed file reached through a linked output directory is never deleted',
    why: 'The link (`public -> static`, made by a setup script) is the output’s path; the committed file behind it is the user’s source.',
    from: ['committed-through-link'],
    workspace: one(
      { command: 'cp src/a.txt public/a.txt', inputs: ['src/**'], outputs: ['public/**'] },
      { 'src/a.txt': 'v1\n', 'static/logo.txt': 'committed\n', '.gitignore': 'public\n' },
    ),
    steps: [
      { link: { 'packages/a/public': 'static' } },
      {
        run: 'build',
        expect: {
          exit: 0,
          files: { 'packages/a/static/logo.txt': 'committed\n', 'packages/a/public/a.txt': 'v1\n' },
        },
      },
      { write: { 'packages/a/static/a.txt': null } },
      {
        run: 'build',
        expect: {
          exit: 0,
          files: { 'packages/a/static/logo.txt': 'committed\n', 'packages/a/public/a.txt': 'v1\n' },
        },
      },
      { check: { links: { 'packages/a/public': 'static' } } },
    ],
  }),
]
