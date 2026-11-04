import { defineCase, type Case } from '../src/spec.ts'
import { CONCAT, chainProject, fourProjects, one, out } from './shapes.ts'

const cached = { command: CONCAT, inputs: ['src/**'], outputs: ['dist/**'] }

/** Build, then a change, then the build again must run and show the change. */
function rerunsOn(
  id: string,
  title: string,
  from: string[],
  change: Record<string, string | null>,
  want: string,
  files: Record<string, string> = { 'src/a.txt': 'a\n' },
): Case {
  return defineCase({
    id: `inputs/${id}`,
    category: 'inputs',
    kind: 'correctness',
    title,
    from,
    workspace: one(cached, files),
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { write: change },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: want } } },
    ],
  })
}

export default [
  defineCase({
    id: 'inputs/unchanged-replays',
    category: 'inputs',
    kind: 'efficiency',
    title: 'A second run over an unchanged tree replays instead of running',
    from: ['parity-turbo', 'parity-nx-hashing', 'repeated-runs.unsafe'],
    workspace: one(cached),
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'], files: { [out('a')]: 'a\n' } } },
    ],
  }),

  rerunsOn(
    'edit',
    'Editing an input runs the task again',
    ['parity-turbo-hashing', 'inputs'],
    {
      'packages/a/src/a.txt': 'edited\n',
    },
    'edited\n',
  ),

  rerunsOn(
    'same-size-edit',
    'A same-size edit right after a commit runs the task again',
    ['parity-turbo-hashing', 'git-racy-index', 'hash-scenarios'],
    { 'packages/a/src/a.txt': 'b\n' },
    'b\n',
  ),

  rerunsOn(
    'new-file',
    'A new file under an input glob runs the task again',
    ['inputs', 'parity-turbo-hashing'],
    {
      'packages/a/src/b.txt': 'b\n',
    },
    'a\nb\n',
  ),

  rerunsOn(
    'deleted-file',
    'Deleting an input runs the task again',
    ['parity-turbo-hashing', 'absent-input'],
    { 'packages/a/src/b.txt': null },
    'a\n',
    { 'src/a.txt': 'a\n', 'src/b.txt': 'b\n' },
  ),

  rerunsOn(
    'renamed-file',
    'Renaming an input runs the task again',
    ['stale-hit-git', 'inputs-moved'],
    { 'packages/a/src/a.txt': null, 'packages/a/src/c.txt': 'a\n' },
    'b\na\n',
    { 'src/a.txt': 'a\n', 'src/b.txt': 'b\n' },
  ),

  rerunsOn(
    'nested-dir',
    'An edit deep in a nested input directory runs the task again',
    ['parity-turbo-hashing', 'nested-dirs'],
    { 'packages/a/src/deep/er/x.txt': 'deep2\n' },
    'a\n',
    { 'src/a.txt': 'a\n', 'src/deep/er/x.txt': 'deep\n' },
  ),

  rerunsOn(
    'odd-file-name',
    'An edit to an input named with spaces, `$` and quotes runs the task again',
    ['hash-scenarios', 'git-enum-unicode'],
    { "packages/a/src/it's $x y.txt": 'two\n' },
    'a\ntwo\n',
    { 'src/a.txt': 'a\n', "src/it's $x y.txt": 'one\n' },
  ),

  rerunsOn(
    'unicode-file-name',
    'An edit to an input with a non-ASCII name runs the task again',
    ['git-enum-unicode', 'affected-unicode'],
    { 'packages/a/src/żółw.txt': 'two\n' },
    'a\ntwo\n',
    { 'src/a.txt': 'a\n', 'src/żółw.txt': 'one\n' },
  ),

  defineCase({
    id: 'inputs/revert-replays-old',
    category: 'inputs',
    kind: 'correctness',
    title: 'Undoing an edit replays the first run’s outputs, not the edited ones',
    from: ['parity-turbo-hashing', 'hash-scenarios', 'stale-hit'],
    workspace: one(cached),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/a/src/a.txt': 'edited\n' } },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'edited\n' } } },
      { write: { 'packages/a/src/a.txt': 'a\n' } },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'a\n' } } },
    ],
  }),

  defineCase({
    id: 'inputs/outside-inputs-ignored',
    category: 'inputs',
    kind: 'efficiency',
    title: 'A file outside the task’s inputs changes nothing',
    from: ['parity-turbo', 'inputs'],
    workspace: one(cached, { 'src/a.txt': 'a\n', 'README.md': 'one' }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/a/README.md': 'two' } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
    ],
  }),

  defineCase({
    id: 'inputs/negated-glob',
    category: 'inputs',
    kind: 'efficiency',
    title: 'A file a `!` input pattern takes back changes nothing',
    from: ['parity-turbo-hashing', 'patterns-doc-drift'],
    workspace: one(
      { command: CONCAT, inputs: ['src/**', '!src/notes.md'], outputs: ['dist/**'] },
      { 'src/a.txt': 'a\n', 'src/notes.md': 'one' },
    ),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/a/src/notes.md': 'two' } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
    ],
  }),

  defineCase({
    id: 'inputs/gitignored-not-input',
    category: 'inputs',
    kind: 'efficiency',
    title: 'A gitignored file under an input glob changes nothing',
    why: 'Ignored files are local state (logs, caches); keying on them makes every machine miss.',
    from: ['ignored-inputs', 'parity-nx-hashing', 'parity-turbo-hashing'],
    workspace: one(cached),
    steps: [
      { write: { 'packages/a/.gitignore': 'src/*.log\n' } },
      { commit: 'ignore logs' },
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/a/src/debug.log': 'noise' } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
    ],
  }),

  rerunsOn(
    'untracked-file',
    'A new file git does not track yet is an input',
    ['parity-turbo-hashing', 'git-pending-reads'],
    {
      'packages/a/src/z.txt': 'z\n',
    },
    'a\nz\n',
  ),

  defineCase({
    id: 'inputs/executable-bit',
    category: 'inputs',
    kind: 'correctness',
    title: 'Making an input executable runs the task again',
    why: 'The mode is part of what the task reads: a build that copies a script ships it runnable or not.',
    from: ['stale-hit'],
    workspace: one(
      {
        command:
          'mkdir -p dist && cp -p src/run.sh dist/run.sh && (test -x dist/run.sh && echo exec || echo plain) > dist/out.txt',
        inputs: ['src/**'],
        outputs: ['dist/**'],
      },
      { 'src/run.sh': 'echo hi\n' },
    ),
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'plain\n' } } },
      { chmod: { 'packages/a/src/run.sh': 0o755 } },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'exec\n' } } },
    ],
  }),

  defineCase({
    id: 'inputs/executable-bit-behind-link',
    category: 'inputs',
    kind: 'correctness',
    title: 'Making the file an input link points at executable runs the task again',
    why: 'The link is unchanged; only its target’s mode moved, and the task reads that mode.',
    from: ['linked-inputs', 'stale-hit'],
    workspace: one(
      {
        command: 'mkdir -p dist && (test -x src/run.sh && echo exec || echo plain) > dist/out.txt',
        inputs: ['src/**'],
        outputs: ['dist/**'],
      },
      { 'src/a.txt': 'a\n', 'tools/run.sh': 'echo hi\n' },
    ),
    steps: [
      { link: { 'packages/a/src/run.sh': '../tools/run.sh' } },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'plain\n' } } },
      { chmod: { 'packages/a/tools/run.sh': 0o755 } },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'exec\n' } } },
    ],
  }),

  defineCase({
    id: 'inputs/dependencies-swapped-rerun-consumer',
    category: 'inputs',
    kind: 'correctness',
    title:
      'Two dependencies that swap contents, at the same output path, run the project built on them again',
    why: 'Each dependency’s files are a set the other had: a key that folds them without their order replays the old result.',
    from: ['parity-turbo-hashing', 'task-hash-derive'],
    workspace: {
      projects: {
        one: chainProject('one', [], { files: { 'src/a.txt': 'x\n' } }),
        two: chainProject('two', [], { files: { 'src/a.txt': 'y\n' } }),
        app: chainProject('app', ['one', 'two']),
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('app')]: 'x\ny\napp\n' } } },
      { write: { 'packages/one/src/a.txt': 'y\n', 'packages/two/src/a.txt': 'x\n' } },
      { run: 'build', expect: { exit: 0, files: { [out('app')]: 'y\nx\napp\n' } } },
    ],
  }),

  defineCase({
    id: 'inputs/dependency-edit-cascades',
    category: 'inputs',
    kind: 'correctness',
    title: 'Editing a dependency rebuilds the projects that read its output',
    from: ['parity-turbo', 'parity-nx-hashing', 'hash-chain'],
    workspace: fourProjects(),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/lib/src/a.txt': 'LIB\n' } },
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['lib#build', 'ui#build', 'app#build'],
          files: { [out('app')]: 'LIB\nLIB\nui\napp\n', [out('ui')]: 'LIB\nui\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'inputs/sibling-untouched',
    category: 'inputs',
    kind: 'efficiency',
    title: 'Editing one project does not rerun a project that does not depend on it',
    from: ['parity-turbo-hashing-env', 'hash-chain'],
    workspace: fourProjects(),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/ui/src/a.txt': 'UI\n' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['ui#build', 'app#build'], notRan: ['lib#build', 'docs#build'] },
      },
    ],
  }),

  defineCase({
    id: 'inputs/dependency-non-input-edit',
    category: 'inputs',
    kind: 'efficiency',
    title: 'An edit to a file outside a dependency’s build inputs does not rebuild its dependents',
    from: ['parity-nx-hashing'],
    workspace: {
      projects: {
        lib: chainProject('lib', [], { files: { 'src/a.txt': 'lib\n', 'test/a.test.txt': 'one' } }),
        app: chainProject('app', ['lib']),
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/lib/test/a.test.txt': 'two' } },
      { run: 'build', expect: { exit: 0, notRan: ['lib#build', 'app#build'] } },
    ],
  }),

  defineCase({
    id: 'inputs/nested-project-excluded',
    category: 'inputs',
    kind: 'efficiency',
    title: 'A project nested inside another keeps its files out of the outer project’s inputs',
    from: ['nested-boundary', 'parity-nx-hashing'],
    workspace: {
      projects: {
        outer: {
          dir: 'packages/outer',
          tasks: { build: { command: 'echo outer', inputs: ['**'], outputs: [] } },
          files: { 'a.txt': 'o' },
        },
        inner: {
          dir: 'packages/outer/inner',
          tasks: { build: { command: 'echo inner', inputs: ['**'], outputs: [] } },
          files: { 'a.txt': 'i' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/outer/inner/a.txt': 'changed' } },
      { run: 'build', expect: { exit: 0, ran: ['inner#build'], notRan: ['outer#build'] } },
    ],
  }),

  defineCase({
    id: 'inputs/symlink-retarget',
    category: 'inputs',
    kind: 'correctness',
    title: 'Pointing an input symlink at another file runs the task again',
    from: ['stale-hit', 'linked-inputs', 'path-links'],
    workspace: one(
      { command: CONCAT, inputs: ['src/**'], outputs: ['dist/**'] },
      { 'src/a.txt': 'a\n', 'one.txt': '1\n', 'two.txt': '2\n' },
    ),
    steps: [
      { link: { 'packages/a/src/link.txt': '../one.txt' } },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'a\n1\n' } } },
      { link: { 'packages/a/src/link.txt': '../two.txt' } },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'a\n2\n' } } },
    ],
  }),

  defineCase({
    id: 'inputs/unlisted-file-never-stale',
    category: 'inputs',
    kind: 'correctness',
    title: 'A task that lists no inputs never replays a stale result when a file it reads changes',
    why: 'A default guesses what the task reads; a file outside the guess changes and the cache replays the old bytes.',
    from: ['configless-default-build', 'cache-declaration-warnings'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command: 'mkdir -p dist && cat ../../shared.txt > dist/out.txt',
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
      files: { 'shared.txt': 'one\n' },
    },
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'one\n' } } },
      { write: { 'shared.txt': 'two\n' } },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'two\n' } } },
    ],
  }),

  defineCase({
    id: 'inputs/unlisted-env-never-stale',
    category: 'inputs',
    kind: 'correctness',
    title:
      'A task that lists no inputs never replays a stale result when a variable it reads changes',
    why: 'A cache keyed on files alone replays the output of a value the command no longer sees.',
    from: ['configless-default-build', 'env-reads-complete'],
    workspace: one({
      command: 'mkdir -p dist && printf "%s\\n" "${MODE-unset}" > dist/out.txt',
      outputs: ['dist/**'],
    }),
    steps: [
      { run: 'build', env: { MODE: 'dev' }, expect: { exit: 0 } },
      // A tool that hides the variable from the task prints `unset` both times, which is right.
      {
        run: 'build',
        env: { MODE: 'prod' },
        expect: { exit: 0, filesNot: { [out('a')]: 'dev\n' } },
      },
    ],
  }),

  defineCase({
    id: 'inputs/default-inputs-edit',
    category: 'inputs',
    kind: 'correctness',
    title: 'A task that lists no inputs runs again when its project’s sources change',
    from: ['configless-default-build'],
    workspace: one({ command: CONCAT, outputs: ['dist/**'] }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/a/src/a.txt': 'edited\n' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'edited\n' } } },
    ],
  }),
]
