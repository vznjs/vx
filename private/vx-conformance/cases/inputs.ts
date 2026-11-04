import { defineCase, type Case } from '../src/spec.ts'
import { CONCAT, chainProject, fourProjects, one, out } from './shapes.ts'

const cached = { command: CONCAT, inputs: ['src/**'], outputs: ['dist/**'] }

/** Build, then a change, then the build again must run and show the change. */
function rerunsOn(
  id: string,
  title: string,
  why: string,
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
    why,
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
    why: 'When nothing a task reads has changed, its last result is still right, so replaying it is safe. Running it again spends CI minutes and local time on work whose answer is already known. Across a monorepo of many tasks, this is what lets a run with no changes finish in seconds instead of taking the full build time.',
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
    'A changed input means the stored result was computed from source that no longer exists. Replaying it would ship output built from the old code under a green run. Seeing every edit to a declared input is the most basic promise a cache makes, and every other saving depends on it.',
    ['parity-turbo-hashing', 'inputs'],
    {
      'packages/a/src/a.txt': 'edited\n',
    },
    'edited\n',
  ),

  rerunsOn(
    'same-size-edit',
    'A same-size edit right after a commit runs the task again',
    'Change detection must rest on content, not on size and timestamps alone. An edit that keeps the file’s length and lands in the same second as a commit can look untouched to a check based on file stats. A tool that trusts such a check replays the old output, and the edit never reaches the build.',
    ['parity-turbo-hashing', 'git-racy-index', 'hash-scenarios'],
    { 'packages/a/src/a.txt': 'b\n' },
    'b\n',
  ),

  rerunsOn(
    'new-file',
    'A new file under an input glob runs the task again',
    'A glob names a set of files, and adding a file changes that set. A build that concatenates, bundles or tests everything under `src/` gives different output once a new file exists. Keying only on the files seen before would replay a bundle that is missing the new module.',
    ['inputs', 'parity-turbo-hashing'],
    {
      'packages/a/src/b.txt': 'b\n',
    },
    'a\nb\n',
  ),

  rerunsOn(
    'deleted-file',
    'Deleting an input runs the task again',
    'Removing a file changes the input set just as editing one does. A task that bundles a directory must stop including the deleted file. Replaying the old result would ship code that is gone from the tree, such as a removed module or a test that should no longer run.',
    ['parity-turbo-hashing', 'absent-input'],
    { 'packages/a/src/b.txt': null },
    'a\n',
    { 'src/a.txt': 'a\n', 'src/b.txt': 'b\n' },
  ),

  rerunsOn(
    'renamed-file',
    'Renaming an input runs the task again',
    'A file’s path is part of what a task reads, not only its bytes. A rename can change order, module names or import paths, so the output can differ even when no content changed. A key built only from the set of content hashes sees the same bytes and replays output that still names the old file.',
    ['stale-hit-git', 'inputs-moved'],
    { 'packages/a/src/a.txt': null, 'packages/a/src/c.txt': 'a\n' },
    'b\na\n',
    { 'src/a.txt': 'a\n', 'src/b.txt': 'b\n' },
  ),

  rerunsOn(
    'nested-dir',
    'An edit deep in a nested input directory runs the task again',
    'A recursive glob covers every depth, and a change at any depth counts. A tool that stops walking early, or trusts a directory’s own timestamp, can miss an edit several levels down. Real sources nest deeply, so missing such an edit replays stale output for ordinary work.',
    ['parity-turbo-hashing', 'nested-dirs'],
    { 'packages/a/src/deep/er/x.txt': 'deep2\n' },
    'a\n',
    { 'src/a.txt': 'a\n', 'src/deep/er/x.txt': 'deep\n' },
  ),

  rerunsOn(
    'odd-file-name',
    'An edit to an input named with spaces, `$` and quotes runs the task again',
    'File names with spaces, quotes or `$` are legal and occur in real repos, for example among assets and fixtures. If such a name is mangled when it is listed, quoted or passed through a shell, the file drops out of the key. Edits to it then never rerun the task, and the build ships its old content.',
    ['hash-scenarios', 'git-enum-unicode'],
    { "packages/a/src/it's $x y.txt": 'two\n' },
    'a\ntwo\n',
    { 'src/a.txt': 'a\n', "src/it's $x y.txt": 'one\n' },
  ),

  rerunsOn(
    'unicode-file-name',
    'An edit to an input with a non-ASCII name runs the task again',
    'Non-ASCII file names are ordinary on every current file system and must map to the same path every time. git escapes such names in its plain output; a reader that does not undo the escaping loses the file from the key. Edits to it then replay the old output.',
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
    why: 'A key must depend only on the current inputs, so going back to old inputs must give back the old outputs. After an undo, the tree must hold what the first run produced, not the edited run’s output. A tool that keeps whatever it wrote last leaves output from code that is no longer in the tree, under a green run.',
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
    why: 'Declared inputs are the contract: only those files can change the result. Rerunning a build because a README or another unrelated file changed wastes time on every docs edit. Explicit inputs are what let a cache stay warm across changes that cannot matter to the task.',
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
    why: 'A `!` pattern is the user stating that a file does not affect the task. Notes, another tool’s fixtures or generated docs often sit inside a source folder. Ignoring the exclusion reruns the task on edits the user has said cannot change its output, and the cache loses its value for that folder.',
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
    why: 'Files git ignores are local state such as logs, editor files and caches, not part of the source. They differ between machines and change on their own. Keying on them gives every machine a different key, so the cache misses on every CI runner and laptop even when the committed source is identical.',
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
    'A task reads what is on disk, not what git has recorded. A developer adds a file and builds before committing, and the new file belongs in the output. A tool that keys only on tracked files replays the old result until the next commit, hiding the new file from local builds.',
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
    why: 'The file mode is part of what a task reads: a build that copies a script ships it runnable or not. A key that hashes content alone sees no change after `chmod +x`. The cache then replays an output whose script is not executable, and the failure shows only when someone tries to run it.',
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
    why: 'The link itself is unchanged; only the mode of the file it points to moved. The task reads that mode, so its output can change, as a script that checks whether a file is runnable does. A key that looks only at the link, or ignores modes, replays the old result under the new tree.',
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
    why: 'After the swap each dependency holds what the other had, so the set of files is the same but which name holds which is not. The consumer reads them by name and builds a different result. A key that folds the dependencies without their order sees nothing new and replays the old output.',
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
    why: 'A project built from a dependency’s output must rebuild when that dependency changes. Otherwise the app keeps bundling the old library while the library itself is new, and the two disagree inside one green build. The mismatch is hard to spot because each project looks up to date on its own.',
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
    why: 'A change can only affect projects that read it, directly or through their dependencies. Rebuilding unrelated projects on every edit makes CI time grow with the size of the repo rather than the size of the change. In a large monorepo that is the difference between checking one package and rebuilding everything.',
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
    why: 'A dependant is affected only when something its dependency’s build reads has changed. A test file in a library does not change the built library, so the app built from it stays the same. Rebuilding the whole chain on every test edit throws away cached work whose result is already known.',
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
    why: 'A project nested in another’s folder owns its own files. If the outer project’s `**` also counts them, every edit inside the inner project reruns the outer one too. Project boundaries are what keep one team’s change from invalidating another team’s cache.',
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
    why: 'A task reads the file behind a link, so pointing the link somewhere else changes the input. A key built from the link’s own path, or from what it pointed at once, misses the change. The cache then replays output built from the old target while the tree points at the new one.',
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
    why: 'When a task lists no inputs, any default is a guess at what it reads. Here the command reads a file outside its project; when that file changes, a guessed key does not, and the cache replays the old bytes under a green run. Not caching such a task, or rerunning it, is right. Declaring inputs is how a task earns caching.',
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
    why: 'A task that lists no inputs gives the tool no way to know which variables it reads. A cache keyed on files alone replays the output of a value the command no longer sees: `MODE` moves from dev to prod and a dev build ships as prod. Rerunning the task, or hiding the variable from it, both keep the output true.',
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
    why: 'Whatever a tool does with a task that declares no inputs, it must not miss an edit to the project’s own sources. Running such a task every time is correct, and so is keying it on a default set that covers the edit. Replaying the result from before the edit would ship old code after a plain source change.',
    from: ['configless-default-build'],
    workspace: one({ command: CONCAT, outputs: ['dist/**'] }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/a/src/a.txt': 'edited\n' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'edited\n' } } },
    ],
  }),
]
