// Input cases mined from the rivals’ hashers and glob walkers (Turborepo’s
// turborepo-scm and globwalk, Nx’s native glob and hasher, moon’s
// task-hasher) and from vx’s own key tests: names a file system tells apart
// that a matcher may fold, git states where the index and the work tree
// disagree, negations, regex characters in globs, root inputs and key
// commands.
import { defineCase, type Case, type Kind, type Step, type TaskSpec } from '../src/spec.ts'
import { out } from './shapes.ts'

/** A cached build over `inputs` that copies `read` (sh words, quoted as needed) into dist/out.txt. */
function reads(inputs: string[], read: string, extra: Partial<TaskSpec> = {}): TaskSpec {
  return {
    command: `mkdir -p dist && cat ${read} > dist/out.txt`,
    inputs,
    outputs: ['dist/**'],
    ...extra,
  }
}

/** Project-relative paths under project `a`, as a step writes them. */
function inA(files: Record<string, string | null>): Record<string, string | null> {
  return Object.fromEntries(Object.entries(files).map(([f, c]) => [`packages/a/${f}`, c]))
}

/** A change: files under project `a` to write (`null` deletes), or a `sh` command at the root. */
type Change = Record<string, string | null> | { sh: string }

function changeSteps(change: Change): Step[] {
  return 'sh' in change && typeof change.sh === 'string'
    ? [{ sh: change.sh }]
    : [{ write: inA(change as Record<string, string | null>) }]
}

/**
 * One project `a`, built once (after `setup`), then each change in turn:
 * `true` must run the build again (and leave `want` in dist/out.txt when
 * given), `false` must not.
 */
function edits(c: {
  id: string
  kind: Kind
  title: string
  why: string
  from: string[]
  task: TaskSpec
  files: Record<string, string>
  rootFiles?: Record<string, string>
  setup?: Step[]
  changes: Array<[Change, boolean, string?]>
}): Case {
  return defineCase({
    id: c.id,
    category: 'inputs',
    kind: c.kind,
    title: c.title,
    why: c.why,
    from: c.from,
    ...(c.task.runtime ? { needs: ['runtime-inputs' as const] } : {}),
    workspace: {
      projects: { a: { tasks: { build: c.task }, files: c.files } },
      ...(c.rootFiles ? { files: c.rootFiles } : {}),
    },
    steps: [
      ...(c.setup ?? []),
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      ...c.changes.flatMap(([change, reruns, want]): Step[] => [
        ...changeSteps(change),
        {
          run: 'build',
          expect: {
            exit: 0 as const,
            ...(reruns ? { ran: ['a#build'] } : { notRan: ['a#build'] }),
            ...(want === undefined ? {} : { files: { [out('a')]: want } }),
          },
        },
      ]),
    ],
  })
}

const GIT = 'git -c user.name=c -c user.email=c@c'
const NFC = 'é'
const NFD = 'é'

/** A build over root inputs that copies `read` (root-relative) into dist/out.txt. */
function readsRoot(rootInputs: string[], read: string): TaskSpec {
  return {
    command: `mkdir -p dist && cat ${read
      .split(' ')
      .map((f) => `../../${f}`)
      .join(' ')} > dist/out.txt`,
    inputs: ['src/**'],
    rootInputs,
    outputs: ['dist/**'],
  }
}

/** One project `a` built over root inputs, then root-level changes in turn. */
function rootEdits(c: {
  id: string
  kind: Kind
  title: string
  why: string
  from: string[]
  task: TaskSpec
  rootFiles: Record<string, string>
  changes: Array<[Record<string, string | null>, boolean, string?]>
}): Case {
  return defineCase({
    id: c.id,
    category: 'inputs',
    kind: c.kind,
    title: c.title,
    why: c.why,
    from: c.from,
    workspace: {
      projects: { a: { tasks: { build: c.task }, files: { 'src/a.txt': 'a\n' } } },
      files: c.rootFiles,
    },
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      ...c.changes.flatMap(([change, reruns, want]): Step[] => [
        { write: change },
        {
          run: 'build',
          expect: {
            exit: 0 as const,
            ...(reruns ? { ran: ['a#build'] } : { notRan: ['a#build'] }),
            ...(want === undefined ? {} : { files: { [out('a')]: want } }),
          },
        },
      ]),
    ],
  })
}

/** Project `a` whose build writes `cmd`’s result to out.txt, keyed by key commands only. */
function probed(
  runtime: string[],
  command: string,
  rootFiles: Record<string, string>,
): Case['workspace'] {
  return {
    projects: {
      a: {
        tasks: { build: { command, inputs: [], runtime, outputs: ['out.txt'] } },
        files: { '.gitignore': 'out.txt\n' },
      },
    },
    files: rootFiles,
  }
}

export default [
  // ---- names a case-sensitive file system tells apart --------------------

  // vx git-ignorecase; turborepo-scm git_index_regression_tests
  // test_untracked_detection_equivalence_comprehensive (case-only names)
  edits({
    id: 'inputs/case-twin-tracked-edit-reruns',
    kind: 'correctness',
    title: 'With `A.txt` and `a.txt` both committed, an edit to `a.txt` runs the task again',
    why: 'On a case-sensitive file system `A.txt` and `a.txt` are two files with their own bytes. A runner that folds case while listing or keying them keeps only one, and an edit to the other changes no key. The task then replays output built from the old `a.txt`. Linux checkouts hold such pairs, often by accident from a rename.',
    from: ['git-ignorecase'],
    task: reads(['src/**'], 'src/*'),
    files: { 'src/A.txt': 'upper\n', 'src/a.txt': 'lower\n' },
    changes: [[{ 'src/a.txt': 'lower2\n' }, true, 'upper\nlower2\n']],
  }),

  // vx git-ignorecase ('a new file differing only in case from a tracked one is enumerated')
  edits({
    id: 'inputs/case-twin-untracked-added-reruns',
    kind: 'correctness',
    title: 'A new `a.txt` beside a committed `A.txt` runs the task again',
    why: 'A new file is a new input even when its name differs from a tracked one only in case. A runner that matches new paths against tracked ones without regard to case takes `a.txt` for `A.txt`, sees nothing new and replays. The output then lacks the new file. On a case-sensitive disk the two names are as different as any others.',
    from: ['git-ignorecase'],
    task: reads(['src/**'], 'src/*'),
    files: { 'src/A.txt': 'upper\n' },
    changes: [[{ 'src/a.txt': 'lower\n' }, true, 'upper\nlower\n']],
  }),

  // vx git-ignorecase (core.ignorecase=true copied onto a case-sensitive disk)
  edits({
    id: 'inputs/case-twin-under-core-ignorecase-reruns',
    kind: 'correctness',
    title:
      'Under `core.ignorecase=true` on Linux, a new `a.txt` beside a committed `A.txt` runs the task again',
    why: 'A `.git` copied from macOS keeps `core.ignorecase=true`, and git then takes a new `a.txt` for the tracked `A.txt` and lists nothing new. The disk still holds two files, and the task reads both. A runner that trusts git’s listing replays output that lacks the new file. What the task reads is on the disk, not in git’s config.',
    from: ['git-ignorecase'],
    task: reads(['src/**'], 'src/*'),
    files: { 'src/A.txt': 'upper\n' },
    setup: [{ sh: 'git config core.ignorecase true' }],
    changes: [[{ 'src/a.txt': 'lower\n' }, true, 'upper\nlower\n']],
  }),

  // nx native/glob glob_files.rs (case-sensitive matching)
  edits({
    id: 'inputs/literal-name-not-its-case-twin',
    kind: 'efficiency',
    title: 'An input `src/A.txt` does not key `src/a.txt`',
    why: 'A literal input names one file, byte for byte. On a case-sensitive disk `a.txt` is another file the task never reads. A matcher that compares names without case keys it anyway, and every edit to it reruns the task for nothing. The narrow input is the user’s way of saying what matters.',
    from: ['inputs-glob-fuzz'],
    task: reads(['src/A.txt'], 'src/A.txt'),
    files: { 'src/A.txt': 'upper\n', 'src/a.txt': 'lower\n' },
    changes: [
      [{ 'src/a.txt': 'lower2\n' }, false],
      [{ 'src/A.txt': 'upper2\n' }, true, 'upper2\n'],
    ],
  }),

  // turborepo-globwalk lib.rs (directory segments match by exact bytes)
  edits({
    id: 'inputs/directory-case-twin-not-keyed',
    kind: 'efficiency',
    title: 'An input `src/**` does not key files under a sibling `Src` directory',
    why: 'Directory names are matched as exactly as file names. `Src` is another directory, maybe old code or a vendored copy, and the task does not read it. A walker that folds case pulls it into the key, so edits there rerun the task. On a case-sensitive file system the user can rely on the case they wrote.',
    from: ['inputs-glob-fuzz'],
    task: reads(['src/**'], 'src/a.txt'),
    files: { 'src/a.txt': 'a\n', 'Src/x.txt': 'x\n' },
    changes: [
      [{ 'Src/x.txt': 'x2\n' }, false],
      [{ 'src/a.txt': 'a2\n' }, true, 'a2\n'],
    ],
  }),

  // nx native/glob glob_files.rs: a class is case-sensitive
  edits({
    id: 'inputs/glob-class-range-case-sensitive',
    kind: 'efficiency',
    title: 'An input `src/[A-Z].txt` keys `B.txt`, and not `b.txt`',
    why: 'A range in a class covers the characters between its ends and no others. `[A-Z]` is the upper-case letters, so `b.txt` lies outside it. A matcher that compiles classes case-insensitively keys files the user left out, rerunning the task on their edits. The upper-case file must still key the task.',
    from: ['inputs-glob-fuzz'],
    task: reads(['src/[A-Z].txt'], 'src/B.txt'),
    files: { 'src/B.txt': 'B\n', 'src/b.txt': 'b\n' },
    changes: [
      [{ 'src/b.txt': 'b2\n' }, false],
      [{ 'src/B.txt': 'B2\n' }, true, 'B2\n'],
    ],
  }),

  // ---- Unicode normal forms -----------------------------------------------

  // vx git-enum-unicode ('an NFD project dir takes its slice of the NFC enumeration')
  edits({
    id: 'inputs/nfd-name-tracked-edit-reruns',
    kind: 'correctness',
    title: 'An edit to a committed file whose name is in decomposed Unicode runs the task again',
    why: 'A name like `é.txt` can be stored as one code point or as `e` plus a combining accent, and files copied from macOS often carry the second form. Linux keeps the bytes as written. A runner that normalises names while listing them then looks up a path that does not exist and drops the file from the key. Its edits replay the old output.',
    from: ['git-enum-unicode'],
    task: reads(['src/**'], `src/${NFD}.txt`),
    files: { [`src/${NFD}.txt`]: 'one\n' },
    changes: [[{ [`src/${NFD}.txt`]: 'two\n' }, true, 'two\n']],
  }),

  // vx git-enum-unicode
  edits({
    id: 'inputs/nfd-name-untracked-added-reruns',
    kind: 'correctness',
    title: 'A new untracked file whose name is in decomposed Unicode runs the task again',
    why: 'Git lists an untracked name by its bytes, and a decomposed `é` is three bytes where the composed one is two. A runner that normalises what git prints, or quotes it and fails to unquote it, never finds the file. The new input then changes no key. The task must rerun and see it.',
    from: ['git-enum-unicode'],
    task: reads(['src/**'], 'src/*'),
    files: { 'src/a.txt': 'a\n' },
    changes: [[{ [`src/${NFD}.txt`]: 'new\n' }, true, 'a\nnew\n']],
  }),

  // vx git-enum-unicode
  edits({
    id: 'inputs/nfc-and-nfd-twins-each-keyed',
    kind: 'correctness',
    title:
      'With composed and decomposed `é.txt` side by side, an edit to either runs the task again',
    why: 'On Linux the two spellings of `é.txt` are two files with their own content. A runner that normalises names folds them into one entry, so an edit to the one it dropped changes no key. The task reads both and its output depends on both. Each must key it.',
    from: ['git-enum-unicode'],
    task: reads(['src/**'], 'src/*'),
    files: { [`src/${NFC}.txt`]: 'nfc\n', [`src/${NFD}.txt`]: 'nfd\n' },
    changes: [
      [{ [`src/${NFD}.txt`]: 'nfd2\n' }, true],
      [{ [`src/${NFC}.txt`]: 'nfc2\n' }, true],
    ],
  }),

  // vx hash-scenarios-names (names taken literally)
  edits({
    id: 'inputs/nfd-literal-input',
    kind: 'correctness',
    title: 'A literal input spelled in decomposed Unicode keys the file of that spelling',
    why: 'A config written on macOS may spell a name in decomposed form, and the file on disk has the same bytes. A runner that normalises the pattern but not the disk, or the other way round, matches nothing. The file then drops out of the key and its edits replay. Bytes that agree must match.',
    from: ['hash-scenarios-names'],
    task: reads([`src/${NFD}.txt`], `src/${NFD}.txt`),
    files: { [`src/${NFD}.txt`]: 'one\n' },
    changes: [[{ [`src/${NFD}.txt`]: 'two\n' }, true, 'two\n']],
  }),

  // turborepo-globwalk lib.rs; JS glob engines step UTF-16 units, not characters
  edits({
    id: 'inputs/glob-question-mark-astral-character',
    kind: 'correctness',
    title: 'An input `src/?.txt` keys a file named with one emoji',
    why: '`?` matches exactly one character, and an emoji outside the Basic Multilingual Plane is one character of four bytes. A matcher that steps through UTF-16 code units sees two halves and fails the match. The file then drops out of the key, and its edits replay a stale result. Emoji names are rare but legal.',
    from: ['inputs-glob-fuzz'],
    task: reads(['src/?.txt'], 'src/\u{1F600}.txt'),
    files: { 'src/\u{1F600}.txt': 'smile\n' },
    changes: [[{ 'src/\u{1F600}.txt': 'grin\n' }, true, 'grin\n']],
  }),

  // turborepo-globwalk lib.rs; nx glob_parser.rs classes
  edits({
    id: 'inputs/glob-class-astral-character',
    kind: 'correctness',
    title: 'An input `src/[😀😁].txt` keys `😁.txt`',
    why: 'A class lists characters, and an emoji is one character even when it takes two UTF-16 units. A matcher that splits it into halves builds a class of four broken units and matches nothing. The emoji file then never keys the task. Its edits must run the task again.',
    from: ['inputs-glob-fuzz'],
    task: reads(['src/[\u{1F600}\u{1F601}].txt'], 'src/\u{1F601}.txt'),
    files: { 'src/\u{1F601}.txt': 'one\n' },
    changes: [[{ 'src/\u{1F601}.txt': 'two\n' }, true, 'two\n']],
  }),

  // ---- names an ignore-file parser would read as syntax -------------------

  // gitignore syntax: `#` starts a comment (turborepo-globwalk / nx glob_transform)
  edits({
    id: 'inputs/hash-leading-name-literal',
    kind: 'correctness',
    title: 'A literal input `src/#notes.txt` keys the file of that name',
    why: 'In an ignore file a line starting with `#` is a comment, but an input pattern is not an ignore file. Emacs lock files and route files often begin with `#`. A runner that passes inputs through gitignore-style parsing drops this one, and its edits replay. The pattern names a file and must key it.',
    from: ['hash-scenarios-names'],
    task: reads(['src/#notes.txt'], "'src/#notes.txt'"),
    files: { 'src/#notes.txt': 'one\n' },
    changes: [[{ 'src/#notes.txt': 'two\n' }, true, 'two\n']],
  }),

  // gitignore syntax: a leading `!` negates
  edits({
    id: 'inputs/bang-leading-name-under-glob',
    kind: 'correctness',
    title: 'An edit to `src/!x.txt` under an input `src/**` runs the task again',
    why: 'A file may begin with `!`; only a pattern starting with `!` is a negation. A runner that turns the files it found back into patterns, or prints and re-reads them, takes this name for a negation and loses it. Its edits then replay output built from the old bytes. File names are data, not syntax.',
    from: ['hash-scenarios-names'],
    task: reads(['src/**'], "'src/!x.txt'"),
    files: { 'src/!x.txt': 'one\n' },
    changes: [[{ 'src/!x.txt': 'two\n' }, true, 'two\n']],
  }),

  // gitignore syntax: trailing spaces are stripped unless escaped
  edits({
    id: 'inputs/trailing-space-name-under-glob',
    kind: 'correctness',
    title: 'An edit to a file whose name ends in a space runs the task again',
    why: 'A name may end in a space, and such files turn up from careless saves on any system. Ignore-file parsing and line trimming both strip it, after which the runner looks up a different name and drops the file. Its edits then change no key. A file the glob matches must stay in the key with its exact name.',
    from: ['hash-scenarios-names'],
    task: reads(['src/**'], "'src/a.txt '"),
    files: { 'src/a.txt ': 'one\n' },
    changes: [[{ 'src/a.txt ': 'two\n' }, true, 'two\n']],
  }),

  // line trimming of git output (turborepo-scm status.rs parsing)
  edits({
    id: 'inputs/leading-space-name-under-glob',
    kind: 'correctness',
    title: 'An edit to a file whose name starts with a space runs the task again',
    why: 'Git prints a name starting with a space as is, right after a status column. A runner that trims each line or splits on runs of white space drops the space and looks up a file that does not exist. The real file then drops out of the key. Its edits must still run the task.',
    from: ['hash-scenarios-names'],
    task: reads(['src/**'], "'src/ a.txt'"),
    files: { 'src/ a.txt': 'one\n' },
    changes: [[{ 'src/ a.txt': 'two\n' }, true, 'two\n']],
  }),

  // turborepo-scm git_index_regression_tests test_mixed_state_comprehensive (untracked names)
  edits({
    id: 'inputs/trailing-space-name-untracked-added',
    kind: 'correctness',
    title: 'A new untracked file whose name ends in a space runs the task again',
    why: 'Untracked files reach a runner through git’s status listing, where a trailing space is easy to lose. A runner that trims the line keys a name that does not exist, or none at all. The new file is a real input the task reads. It must run the task again.',
    from: ['hash-scenarios-names'],
    task: reads(['src/**'], 'src/*'),
    files: { 'src/a.txt': 'a\n' },
    changes: [[{ 'src/b.txt ': 'b\n' }, true, 'a\nb\n']],
  }),

  // ---- regex characters in globs ------------------------------------------

  // nx native/glob glob_transform.rs; matchers built from regexes
  edits({
    id: 'inputs/glob-dot-is-literal',
    kind: 'efficiency',
    title: 'An input `src/a.txt` does not key a file named `src/aXtxt`',
    why: 'In a glob a `.` is a dot. A matcher that builds a regular expression without escaping it lets the dot match any character. Files the user never named then key the task, and their edits rerun it. A literal file input must match only itself.',
    from: ['inputs-glob-fuzz'],
    task: reads(['src/a.txt'], 'src/a.txt'),
    files: { 'src/a.txt': 'a\n', 'src/aXtxt': 'x\n' },
    changes: [
      [{ 'src/aXtxt': 'x2\n' }, false],
      [{ 'src/a.txt': 'a2\n' }, true, 'a2\n'],
    ],
  }),

  // nx native/glob glob_transform.rs
  edits({
    id: 'inputs/glob-plus-is-literal',
    kind: 'efficiency',
    title: 'An input `src/a+.txt` keys `a+.txt`, and not `aa.txt`',
    why: 'Outside extended globs `+` is a plain character. A matcher that leaks it into a regular expression reads `a+` as one or more `a`, keying `aa.txt` too. That reruns the task on files it does not read. The named file must still key it.',
    from: ['inputs-glob-fuzz'],
    task: reads(['src/a+.txt'], "'src/a+.txt'"),
    files: { 'src/a+.txt': 'p\n', 'src/aa.txt': 'aa\n' },
    changes: [
      [{ 'src/aa.txt': 'aa2\n' }, false],
      [{ 'src/a+.txt': 'p2\n' }, true, 'p2\n'],
    ],
  }),

  // nx native/glob glob_transform.rs; turborepo-globwalk lib.rs
  edits({
    id: 'inputs/glob-dollar-caret-literal',
    kind: 'correctness',
    title: 'An input `src/$id^.txt` keys the file with `$` and `^` in its name',
    why: 'Route files such as `$id.tsx` are common, and `^` is a legal name character. In a glob both are plain characters, but in a regular expression they anchor the match, so a leaked pattern matches nothing. The file then drops out of the key. Its edits must run the task.',
    from: ['inputs-glob-fuzz'],
    task: reads(['src/$id^.txt'], "'src/$id^.txt'"),
    files: { 'src/$id^.txt': 'one\n' },
    changes: [[{ 'src/$id^.txt': 'two\n' }, true, 'two\n']],
  }),

  // ---- long and deep paths ------------------------------------------------

  // turborepo-scm hash_object.rs (long paths)
  edits({
    id: 'inputs/long-file-name',
    kind: 'correctness',
    title: 'An edit to an input with a 250-character name runs the task again',
    why: 'File systems allow names up to 255 bytes, and generated files reach that length. A runner that truncates names or builds a fixed-size buffer for them loses the file. Its edits then change no key. A long name is still a name.',
    from: ['inputs'],
    task: reads(['src/**'], 'src/*'),
    files: { [`src/${'n'.repeat(246)}.txt`]: 'one\n' },
    changes: [[{ [`src/${'n'.repeat(246)}.txt`]: 'two\n' }, true, 'two\n']],
  }),

  // turborepo-globwalk lib.rs (deep globstar walks)
  edits({
    id: 'inputs/deep-path-under-globstar',
    kind: 'correctness',
    title: 'An edit forty directories deep under `src/**` runs the task again',
    why: '`**` matches any number of directories, with no depth limit. A walker that caps its recursion stops short and silently leaves deep files out. Their edits then replay a stale result. Generated trees and nested fixtures can be that deep.',
    from: ['inputs'],
    task: reads(['src/**'], `src/${'d/'.repeat(40)}x.txt`),
    files: { [`src/${'d/'.repeat(40)}x.txt`]: 'one\n' },
    changes: [[{ [`src/${'d/'.repeat(40)}x.txt`]: 'two\n' }, true, 'two\n']],
  }),

  // ---- content ------------------------------------------------------------

  // vx absent-input ('folds apart from the file present and from the file never listed')
  edits({
    id: 'inputs/empty-file-deleted-reruns',
    kind: 'correctness',
    title: 'Deleting an empty input file runs the task again',
    why: 'An empty file and no file are different inputs: a task can test whether the file exists. A runner that keys only file contents sees the same nothing before and after, and replays. Marker files such as `.nojekyll` are empty by design. Removing one must run the task.',
    from: ['absent-input'],
    task: { ...reads(['src/**'], ''), command: 'mkdir -p dist && ls -A src > dist/out.txt' },
    files: { 'src/a.txt': 'a\n', 'src/.marker': '' },
    changes: [[{ 'src/.marker': null }, true, 'a.txt\n']],
  }),

  // vx hash-list (each path folds with its content)
  edits({
    id: 'inputs/one-of-two-identical-files-deleted-reruns',
    kind: 'correctness',
    title: 'Deleting one of two inputs with the same content runs the task again',
    why: 'Two files can hold the same bytes. A runner that keys the set of contents rather than each path with its content sees no change when one copy goes. The task, which reads both, would replay output that still includes the deleted copy. Each file is an input of its own.',
    from: ['hash-list'],
    task: reads(['src/**'], 'src/*'),
    files: { 'src/a.txt': 'same\n', 'src/b.txt': 'same\n' },
    changes: [[{ 'src/b.txt': null }, true, 'same\n']],
  }),

  // vx hash-list
  edits({
    id: 'inputs/identical-copy-added-reruns',
    kind: 'correctness',
    title: 'Adding a copy of an input under a new name runs the task again',
    why: 'A new file with the same bytes as an old one is still a new input. A runner that keys only distinct blobs sees nothing new, since git stores both under one object. The task reads both and its output doubles. It must run again.',
    from: ['hash-list'],
    task: reads(['src/**'], 'src/*'),
    files: { 'src/a.txt': 'same\n' },
    changes: [[{ 'src/b.txt': 'same\n' }, true, 'same\nsame\n']],
  }),

  // turborepo-scm package_deps.rs test_git_and_manual_paths_agree_for_lf_files
  edits({
    id: 'inputs/lf-to-crlf-without-attributes-reruns',
    kind: 'correctness',
    title: 'With no line-ending rule, turning LF into CRLF runs the task again',
    why: 'Without a `text` attribute or `core.autocrlf`, git stores bytes as written, and so does the task read them. A runner that normalises line endings before hashing, as some do to agree across platforms, keys both forms the same. The output, which copies the bytes, would then replay with the old endings. Different bytes are different inputs here.',
    from: ['stale-hit-git'],
    task: reads(['src/**'], 'src/a.txt'),
    files: { 'src/a.txt': 'a\nb\n' },
    changes: [[{ 'src/a.txt': 'a\r\nb\r\n' }, true, 'a\r\nb\r\n']],
  }),

  // ---- the index and the work tree disagree -------------------------------

  // turborepo-scm git_index_regression_tests test_modified_then_staged_file_has_working_tree_hash
  defineCase({
    id: 'inputs/staged-edit-undone-builds-disk-bytes',
    category: 'inputs',
    kind: 'correctness',
    title: 'After staging an edit and undoing it on disk, the build holds the bytes on disk',
    why: 'The index can hold bytes the work tree does not. A task reads the work tree, so its key must too. A runner that takes the index’s blob for a staged file replays the output built from the staged edit, though the disk went back to the first state. The output must match the disk.',
    from: ['tree-states-key'],
    workspace: {
      projects: {
        a: { tasks: { build: reads(['src/**'], 'src/a.txt') }, files: { 'src/a.txt': 'one\n' } },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'one\n' } } },
      { write: inA({ 'src/a.txt': 'two\n' }) },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'two\n' } } },
      { sh: 'git add -A' },
      { write: inA({ 'src/a.txt': 'one\n' }) },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'one\n' } } },
    ],
  }),

  // turborepo-scm git_index_regression_tests test_index_equivalence_with_staged_new_file
  defineCase({
    id: 'inputs/staged-new-file-gone-from-disk',
    category: 'inputs',
    kind: 'correctness',
    title: 'A new file staged and then deleted from disk is no input',
    why: 'After `git add` and `rm`, the index lists a file the disk no longer holds. The task cannot read it. A runner that walks the index tries to hash a missing file and fails the run, or keys bytes the task never saw. The run must pass with output built from the files on disk.',
    from: ['absent-input'],
    workspace: {
      projects: {
        a: { tasks: { build: reads(['src/**'], 'src/*') }, files: { 'src/a.txt': 'a\n' } },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: inA({ 'src/b.txt': 'b\n' }) },
      { sh: 'git add -A && rm packages/a/src/b.txt' },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'a\n' } } },
    ],
  }),

  // turborepo-scm git_index_regression_tests test_index_equivalence_with_staged_deletion
  edits({
    id: 'inputs/staged-deletion-recreated-with-new-bytes',
    kind: 'correctness',
    title: 'A file removed with `git rm` and written again with new bytes runs the task again',
    why: 'After `git rm` the file is gone from the index, and writing it again makes it untracked with new content. A runner that reads the deletion from the index and never looks for an untracked file of that name keys the file as absent, or as its old blob. The task reads the new bytes. It must run again.',
    from: ['tree-states-key'],
    task: reads(['src/**'], 'src/*'),
    files: { 'src/a.txt': 'a\n', 'src/b.txt': 'b\n' },
    changes: [
      [{ sh: 'git rm -q packages/a/src/b.txt' }, true, 'a\n'],
      [{ 'src/b.txt': 'b2\n' }, true, 'a\nb2\n'],
    ],
  }),

  // turborepo-scm git_index_regression_tests test_index_equivalence_with_modified_unstaged_files
  edits({
    id: 'inputs/committed-then-reset-soft-keys-disk',
    kind: 'efficiency',
    title:
      'Committing an edit and undoing the commit with `git reset --soft` lets the build replay',
    why: '`git reset --soft` moves HEAD back but keeps the edit staged and on disk. The bytes the task reads are those it was last built from. A runner that keys by HEAD’s tree sees a change and rebuilds for nothing. The disk is unchanged, so the stored result is right.',
    from: ['tree-states-key'],
    task: reads(['src/**'], 'src/a.txt'),
    files: { 'src/a.txt': 'one\n' },
    changes: [
      [{ 'src/a.txt': 'two\n' }, true, 'two\n'],
      [{ sh: `git add -A && ${GIT} commit -qm e && git reset -q --soft HEAD~1` }, false, 'two\n'],
    ],
  }),

  // ---- git filters: the blob is not the bytes on disk ---------------------

  // vx affected-clean-filters; nbstripout-style clean filters
  edits({
    id: 'inputs/clean-filter-hidden-edit-reruns',
    kind: 'correctness',
    title: 'An edit a git clean filter strips from the blob still runs the task again',
    why: 'A clean filter, as nbstripout uses for notebook outputs, rewrites a file on its way into git, so an edit to the stripped part leaves the blob and `git status` unchanged. The task reads the file on disk, stripped part included. A runner that keys clean files by their blob replays output built from the old bytes. The key must follow what the task reads.',
    from: ['affected-clean-filters'],
    task: reads(['src/**'], 'src/a.txt'),
    files: { '.gitattributes': '*.txt filter=strip\n', 'src/a.txt': 'code\nSECRET=1\n' },
    setup: [
      {
        sh: `git config filter.strip.clean "sed '/^SECRET/d'" && git config filter.strip.smudge cat && git add --renormalize . && ${GIT} commit -qm renormalize`,
      },
    ],
    changes: [[{ 'src/a.txt': 'code\nSECRET=2\n' }, true, 'code\nSECRET=2\n']],
  }),

  // vx stale-hit-git (conversion-capable attributes); git `ident`
  edits({
    id: 'inputs/ident-attribute-hidden-edit-reruns',
    kind: 'correctness',
    title: 'Under the `ident` attribute, an edit inside `$Id: … $` runs the task again',
    why: 'The `ident` attribute collapses `$Id: … $` back to `$Id$` when git hashes a file, so an edit inside it leaves the blob unchanged and git calls the file clean. The task reads the full text on disk. A runner keying clean files by blob replays output with the old text. What git stores is not what the task read.',
    from: ['stale-hit-git'],
    task: reads(['src/**'], 'src/a.txt'),
    files: { '.gitattributes': '*.txt ident\n', 'src/a.txt': 'v $Id$\n' },
    changes: [[{ 'src/a.txt': 'v $Id: hand $\n' }, true, 'v $Id: hand $\n']],
  }),

  // ---- git configuration that hides untracked files -----------------------

  // vx stale-hit-git ('repo git config for colour, short status and quoted paths still sees an edit')
  edits({
    id: 'inputs/new-file-under-show-untracked-files-no',
    kind: 'correctness',
    title: 'Under `status.showUntrackedFiles=no`, a new input file runs the task again',
    why: 'Large repos set `status.showUntrackedFiles=no` to speed up `git status`, and plain `git status` then lists no untracked file. The new file is still on disk and the task reads it. A runner that asks status for untracked files without overriding the setting misses it and replays. A user’s status preference must not change what keys a task.',
    from: ['stale-hit-git'],
    task: reads(['src/**'], 'src/*'),
    files: { 'src/a.txt': 'a\n' },
    setup: [{ sh: 'git config status.showUntrackedFiles no' }],
    changes: [[{ 'src/b.txt': 'b\n' }, true, 'a\nb\n']],
  }),

  // vx stale-hit-git
  edits({
    id: 'inputs/new-dir-under-show-untracked-files-normal',
    kind: 'correctness',
    title:
      'Under `status.showUntrackedFiles=normal`, a file in a new directory runs the task again',
    why: 'With `normal`, git lists a new directory as one entry, not the files inside it. A runner that keys the listed entry as if it were a file finds nothing to hash, or hashes the directory name only. Later edits inside then change no key. The files under the new directory are inputs, each with its bytes.',
    from: ['stale-hit-git'],
    task: reads(['src/**'], '/dev/null $(find src -type f -path "*/new/*")'),
    files: { 'src/a.txt': 'a\n' },
    setup: [{ sh: 'git config status.showUntrackedFiles normal' }],
    changes: [
      [{ 'src/new/x.txt': 'x\n' }, true, 'x\n'],
      [{ 'src/new/x.txt': 'x2\n' }, true, 'x2\n'],
    ],
  }),

  // ---- shape changes ------------------------------------------------------

  // turborepo-scm package_deps.rs (directory entries are walked, not hashed)
  edits({
    id: 'inputs/directory-replaced-by-file-reruns',
    kind: 'correctness',
    title: 'Replacing an input directory with a file of the same name runs the task again',
    why: 'The files under the directory are gone and a new file stands in their place. A runner that keyed the directory by the paths git listed, then fails to stat the new file as a file, can key the same before and after. The task now reads one file where it read a tree. It must run again.',
    from: ['inputs-resolution'],
    task: {
      ...reads(['src/**'], ''),
      command: 'mkdir -p dist && find src -type f | sort > dist/out.txt',
    },
    files: { 'src/x/a.txt': 'a\n' },
    changes: [[{ sh: 'rm -r packages/a/src/x && printf x > packages/a/src/x' }, true, 'src/x\n']],
  }),

  // turborepo-scm package_deps.rs (an empty file and a directory)
  edits({
    id: 'inputs/file-moved-into-new-subdirectory-reruns',
    kind: 'correctness',
    title: 'Moving an input into a new subdirectory with the same name runs the task again',
    why: 'A move changes the path while the bytes stay. A runner that keys only file names, not their directories, keys `src/a.txt` and `src/sub/a.txt` alike. A task whose output depends on where files sit then replays the old layout. The path is part of each input.',
    from: ['hash-list'],
    task: {
      ...reads(['src/**'], ''),
      command: 'mkdir -p dist && find src -type f | sort > dist/out.txt',
    },
    files: { 'src/a.txt': 'a\n' },
    changes: [
      [
        { sh: 'mkdir packages/a/src/sub && mv packages/a/src/a.txt packages/a/src/sub/' },
        true,
        'src/sub/a.txt\n',
      ],
    ],
  }),

  // ---- negations ----------------------------------------------------------

  // turborepo-globwalk lib.rs exclusions; nx glob_group.rs
  edits({
    id: 'inputs/negation-single-star-keeps-deeper',
    kind: 'correctness',
    title: 'A negation `!src/*.gen.txt` does not take back `src/deep/x.gen.txt`',
    why: 'A single `*` stays within one directory, in a negation as anywhere. `!src/*.gen.txt` takes back generated files at the top of `src` only. A runner that matches negations at any depth drops the deeper file, and its edits replay stale output. Only `**` reaches down.',
    from: ['inputs-glob-fuzz'],
    task: reads(['src/**', '!src/*.gen.txt'], 'src/deep/x.gen.txt'),
    files: { 'src/top.gen.txt': 't\n', 'src/deep/x.gen.txt': 'x\n' },
    changes: [
      [{ 'src/top.gen.txt': 't2\n' }, false],
      [{ 'src/deep/x.gen.txt': 'x2\n' }, true, 'x2\n'],
    ],
  }),

  // nx native/glob glob_files.rs ("should exclude nested files")
  edits({
    id: 'inputs/negation-globstar-extension-every-depth',
    kind: 'efficiency',
    title: 'A negation `!src/**/*.snap` takes back snapshots at every depth',
    why: '`**` in a negation reaches every level below it, including none. Snapshot files are written by the tests, not read by the build. A runner that applies the negation only at one depth keys the rest, and every snapshot update reruns the build. The user excluded them all.',
    from: ['inputs-glob-fuzz'],
    task: reads(['src/**', '!src/**/*.snap'], 'src/a.txt'),
    files: { 'src/a.txt': 'a\n', 'src/x.snap': 's\n', 'src/d/e/y.snap': 's\n' },
    changes: [
      [{ 'src/x.snap': 's2\n' }, false],
      [{ 'src/d/e/y.snap': 's2\n' }, false],
    ],
  }),

  // turborepo-globwalk lib.rs (exclusion prefixes)
  edits({
    id: 'inputs/negation-prefix-sibling-directory-still-keyed',
    kind: 'correctness',
    title: 'A negation `!src/gen/**` leaves `src/gen2` keyed',
    why: 'A negation of `src/gen/**` takes back the `gen` directory, whose name ends at the slash. A runner that tests negations with a string prefix also drops `gen2`, `generated` and the like. Their edits then replay stale output. Path segments are compared whole.',
    from: ['inputs-glob-fuzz'],
    task: reads(['src/**', '!src/gen/**'], 'src/gen2/x.txt'),
    files: { 'src/gen/a.txt': 'g\n', 'src/gen2/x.txt': 'x\n' },
    changes: [
      [{ 'src/gen/a.txt': 'g2\n' }, false],
      [{ 'src/gen2/x.txt': 'x2\n' }, true, 'x2\n'],
    ],
  }),

  // moon task-hasher (dotfiles); nx glob_files.rs dot handling
  edits({
    id: 'inputs/negation-of-dotfiles',
    kind: 'efficiency',
    title: 'A negation `!src/**/.*` takes back dotfiles and keeps the rest keyed',
    why: 'Editor and tool state such as `.DS_Store` or `.eslintcache` lands beside sources, and users exclude it with a dot pattern. `.*` names files starting with a dot. A runner whose negation never matches dotfiles keys them anyway and reruns on every editor save. Ordinary files must still key the task.',
    from: ['inputs-glob-fuzz'],
    task: reads(['src/**', '!src/**/.*'], 'src/a.txt'),
    files: { 'src/a.txt': 'a\n', 'src/.cache': 'c\n', 'src/d/.state': 's\n' },
    changes: [
      [{ 'src/.cache': 'c2\n' }, false],
      [{ 'src/d/.state': 's2\n' }, false],
      [{ 'src/a.txt': 'a2\n' }, true, 'a2\n'],
    ],
  }),

  // nx native/glob glob_parser.rs (negated classes inside negations)
  edits({
    id: 'inputs/negation-of-class',
    kind: 'efficiency',
    title: 'A negation `!src/[0-9]*.txt` takes back files starting with a digit only',
    why: 'A class in a negation narrows it the same way as in a positive pattern. `[0-9]*.txt` names files starting with a digit, such as numbered migrations a task does not read. A runner that ignores the class keys them, or takes back too much. One must replay and the other run.',
    from: ['inputs-glob-fuzz'],
    task: reads(['src/**', '!src/[0-9]*.txt'], 'src/a.txt'),
    files: { 'src/a.txt': 'a\n', 'src/1.txt': '1\n' },
    changes: [
      [{ 'src/1.txt': '1b\n' }, false],
      [{ 'src/a.txt': 'a2\n' }, true, 'a2\n'],
    ],
  }),

  // turborepo-scm git_index_regression_tests test_index_equivalence_with_deleted_files
  edits({
    id: 'inputs/negated-file-deleted-replays',
    kind: 'efficiency',
    title: 'Deleting a file a negation takes back lets the build replay',
    why: 'A file the inputs take back is not keyed, so its deletion changes nothing the task reads. Deletions often reach a runner by a separate path, git’s list of removed files, and a runner that skips its negations there reruns for nothing. The stored output is still right.',
    from: ['tree-states-key'],
    task: reads(['src/**', '!src/skip.txt'], 'src/a.txt'),
    files: { 'src/a.txt': 'a\n', 'src/skip.txt': 's\n' },
    changes: [[{ 'src/skip.txt': null }, false]],
  }),

  // turborepo-scm git_index_regression_tests test_untracked_detection_equivalence_comprehensive
  edits({
    id: 'inputs/negated-untracked-file-added-replays',
    kind: 'efficiency',
    title: 'A new untracked file that a negation takes back lets the build replay',
    why: 'New files reach a runner through git’s untracked listing, a different path from tracked ones. A runner that applies negations only to tracked files keys the new one, and reruns on every scratch file the user drops in. The negation names it, so nothing the task reads changed.',
    from: ['tree-states-key'],
    task: reads(['src/**', '!src/*.tmp'], 'src/a.txt'),
    files: { 'src/a.txt': 'a\n' },
    changes: [[{ 'src/x.tmp': 't\n' }, false]],
  }),

  // turborepo-scm git_index_regression_tests test_gitignore_negation_patterns
  edits({
    id: 'inputs/negated-directory-new-file-replays',
    kind: 'efficiency',
    title: 'A new file in a new directory under a negated tree lets the build replay',
    why: 'Git lists a new directory as one entry until asked to expand it. A runner that tests the negation against that entry only, not the files inside, may key them. Each new file under `!src/fixtures/**` would then rerun the task. The negation takes the whole tree back, new parts included.',
    from: ['tree-states-key'],
    task: reads(['src/**', '!src/fixtures/**'], 'src/a.txt'),
    files: { 'src/a.txt': 'a\n' },
    changes: [[{ 'src/fixtures/new/x.txt': 'x\n' }, false]],
  }),

  // ---- root inputs --------------------------------------------------------

  // moon task-hasher (workspace-relative `/` inputs, dotfiles)
  rootEdits({
    id: 'inputs/root-input-dotfile-glob',
    kind: 'correctness',
    title: 'A root input `.*rc` keys a dotfile at the workspace root',
    why: 'Tool configs at the root, `.prettierrc` or `.babelrc`, are dotfiles, and a root input names them with a dot pattern. A walker that skips dotfiles at the root matches nothing. Their edits then replay output formatted under the old config. A pattern that starts with a dot must match dotfiles.',
    from: ['workspace-files'],
    task: readsRoot(['.*rc'], '.toolrc'),
    rootFiles: { '.toolrc': 'v1\n' },
    changes: [[{ '.toolrc': 'v2\n' }, true, 'v2\n']],
  }),

  // moon task-hasher (workspace-relative globs)
  rootEdits({
    id: 'inputs/root-input-brace',
    kind: 'correctness',
    title: 'A root input `{a,b}.cfg` keys both root files',
    why: 'A brace in a root input stands for its alternatives, as in a project input. A runner that walks root inputs with a simpler matcher than project inputs may take the braces literally. Edits to `b.cfg` then change no key. Every alternative must key the task.',
    from: ['workspace-files'],
    task: readsRoot(['{a,b}.cfg'], 'a.cfg b.cfg'),
    rootFiles: { 'a.cfg': 'a\n', 'b.cfg': 'b\n', 'c.cfg': 'c\n' },
    changes: [
      [{ 'b.cfg': 'b2\n' }, true, 'a\nb2\n'],
      [{ 'c.cfg': 'c2\n' }, false],
    ],
  }),

  // turborepo-scm package_deps.rs test_repo_wide_inputs
  rootEdits({
    id: 'inputs/root-input-deleted-reruns',
    kind: 'correctness',
    title: 'Deleting a file a root input glob matched runs the task again',
    why: 'A root glob keys every root file it matches, and one going away changes what the task reads. A runner that keys root files only when they exist, without a trace of the list, can key two files and then one file alike only by luck. The task here concatenates the root files, so its output changes. It must run again.',
    from: ['workspace-files'],
    task: {
      ...readsRoot(['shared/*.txt'], ''),
      command: 'mkdir -p dist && cat ../../shared/*.txt > dist/out.txt',
    },
    rootFiles: { 'shared/a.txt': 'a\n', 'shared/b.txt': 'b\n' },
    changes: [[{ 'shared/b.txt': null }, true, 'a\n']],
  }),

  // nx hasher ({workspaceRoot} inputs inside the task's own project)
  rootEdits({
    id: 'inputs/root-input-into-own-project-beyond-inputs',
    kind: 'correctness',
    title: 'A root input naming a file in the task’s own project keys it beyond the project inputs',
    why: 'A root input is a workspace path, and nothing stops it pointing into the task’s own project, at a file its project inputs leave out. A runner that drops root inputs falling inside the project, assuming the project inputs cover them, loses the file. Its edits then replay. Both lists add up.',
    from: ['workspace-files'],
    task: readsRoot(['packages/a/extra/x.txt'], 'packages/a/extra/x.txt'),
    rootFiles: { 'packages/a/extra/x.txt': 'x\n' },
    changes: [[{ 'packages/a/extra/x.txt': 'x2\n' }, true, 'x2\n']],
  }),

  // ---- key commands -------------------------------------------------------

  // nx hasher (runtime inputs, several)
  defineCase({
    id: 'inputs/runtime-second-command-change-reruns',
    category: 'inputs',
    kind: 'correctness',
    needs: ['runtime-inputs'],
    title: 'With two key commands, a change in what the second prints runs the task again',
    why: 'Each key command is its own input. A runner that keys only the first, or keeps one answer for the whole list, misses a change in the second. The task then replays output built for the old answer. Every listed command keys the task.',
    from: ['runtime-inputs'],
    workspace: probed(['cat m1', 'cat m2'], 'cat ../../m1 ../../m2 > out.txt', {
      m1: 'a\n',
      m2: 'b\n',
    }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { m2: 'c\n' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['a#build'], files: { 'packages/a/out.txt': 'a\nc\n' } },
      },
    ],
  }),

  // nx hasher (runtime inputs hashed one by one)
  defineCase({
    id: 'inputs/runtime-answers-not-glued',
    category: 'inputs',
    kind: 'correctness',
    needs: ['runtime-inputs'],
    title: 'Key commands printing `a` and `bc`, then `ab` and `c`, run the task again',
    why: 'Two answers glued together without a separator read the same for `a`+`bc` and `ab`+`c`. The task sees two different values and builds two different outputs. A runner that concatenates answers before hashing replays the first output for the second state. Each answer must be keyed apart.',
    from: ['runtime-inputs'],
    workspace: probed(
      ['cat m1', 'cat m2'],
      `printf '%s|%s\\n' "$(cat ../../m1)" "$(cat ../../m2)" > out.txt`,
      { m1: 'a', m2: 'bc' },
    ),
    steps: [
      { run: 'build', expect: { exit: 0, files: { 'packages/a/out.txt': 'a|bc\n' } } },
      { write: { m1: 'ab', m2: 'c' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['a#build'], files: { 'packages/a/out.txt': 'ab|c\n' } },
      },
    ],
  }),

  // nx hasher (runtime inputs per task)
  defineCase({
    id: 'inputs/runtime-other-task-replays',
    category: 'inputs',
    kind: 'efficiency',
    needs: ['runtime-inputs'],
    title: 'A change in one task’s key command leaves a task with another key command replayed',
    why: 'A key command keys the task that declares it, not the workspace. A runner that pools every key command into one shared value reruns all tasks whenever any answer changes. Here `b` declares a command whose answer stays the same. It must replay.',
    from: ['runtime-inputs'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command: 'cat ../../m1 > out.txt',
              inputs: [],
              runtime: ['cat m1'],
              outputs: ['out.txt'],
            },
          },
          files: { '.gitignore': 'out.txt\n' },
        },
        b: {
          tasks: {
            build: {
              command: 'cat ../../m2 > out.txt',
              inputs: [],
              runtime: ['cat m2'],
              outputs: ['out.txt'],
            },
          },
          files: { '.gitignore': 'out.txt\n' },
        },
      },
      files: { m1: 'a\n', m2: 'b\n' },
    },
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build', 'b#build'] } },
      { write: { m1: 'a2\n' } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], notRan: ['b#build'] } },
    ],
  }),

  // nx hasher (runtime output hashed whole)
  defineCase({
    id: 'inputs/runtime-large-answer-tail-change',
    category: 'inputs',
    kind: 'correctness',
    needs: ['runtime-inputs'],
    title:
      'A key command printing a megabyte that changes only in its last byte runs the task again',
    why: 'A key command may print a long listing, such as every installed package. A runner that keys only a prefix of the answer, or truncates it to fit a buffer, misses a change at its end. The task then replays output built for the old answer. The whole answer is the input.',
    from: ['runtime-inputs'],
    workspace: probed(["head -c 1000000 /dev/zero | tr '\\0' x; cat m"], 'cat ../../m > out.txt', {
      m: 'A\n',
    }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { m: 'B\n' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['a#build'], files: { 'packages/a/out.txt': 'B\n' } },
      },
    ],
  }),

  // nx hasher (a dependency's runtime inputs reach dependants through its hash)
  defineCase({
    id: 'inputs/runtime-dependency-answer-cascades',
    category: 'inputs',
    kind: 'correctness',
    needs: ['runtime-inputs'],
    title: 'A change in a dependency’s key command runs the dependant again',
    why: 'A dependency’s key is part of its dependant’s key, whatever made it change: a file, a variable or a key command’s answer. Here the dependency’s output follows the answer and the dependant copies it. A runner that folds only upstream files replays the dependant with the old copy. The whole upstream key cascades.',
    from: ['runtime-inputs'],
    workspace: {
      projects: {
        lib: {
          tasks: {
            build: {
              command: 'mkdir -p dist && cat ../../m > dist/out.txt',
              inputs: [],
              runtime: ['cat m'],
              outputs: ['dist/**'],
            },
          },
        },
        app: {
          deps: ['lib'],
          tasks: {
            build: {
              command: 'mkdir -p dist && cat ../lib/dist/out.txt > dist/out.txt',
              dependsOn: ['^build'],
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
      files: { m: 'A\n' },
    },
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('app')]: 'A\n' } } },
      { write: { m: 'B\n' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['lib#build', 'app#build'], files: { [out('app')]: 'B\n' } },
      },
    ],
  }),
  // ---- ignore rules a hand-written matcher gets wrong ---------------------

  // turborepo-scm git_index_regression_tests test_gitignore_negation_patterns;
  // gitignore(5): a file cannot be re-included once its parent directory is excluded
  edits({
    id: 'inputs/gitignore-directory-rule-blocks-reinclusion',
    kind: 'efficiency',
    title:
      'Under `gen/` and `!gen/keep.txt` in .gitignore, `keep.txt` stays ignored and its edits replay',
    why: 'Git cannot re-include a file whose parent directory is excluded, so `gen/` followed by `!gen/keep.txt` still ignores `keep.txt`. Git never lists it, and a user sees it ignored in `git status`. A runner with its own ignore matcher applies the negation and keys the file, rerunning on edits nothing tracks. The runner should agree with git.',
    from: ['ignored-inputs'],
    task: reads(['src/**'], 'src/a.txt'),
    files: {
      '.gitignore': 'src/gen/\n!src/gen/keep.txt\n',
      'src/a.txt': 'a\n',
      'src/gen/keep.txt': 'k\n',
    },
    changes: [[{ 'src/gen/keep.txt': 'k2\n' }, false]],
  }),

  // gitignore(5): `dir/*` excludes the files, so a negation re-includes one
  edits({
    id: 'inputs/gitignore-star-rule-allows-reinclusion',
    kind: 'correctness',
    title: 'Under `gen/*` and `!gen/keep.txt` in .gitignore, `keep.txt` is an input',
    why: '`gen/*` excludes the files in `gen`, not the directory, so `!gen/keep.txt` brings that file back. It is committed and the task reads it. A runner that treats `gen/*` like `gen/` drops the file from the key, and its edits replay. One character in the rule decides.',
    from: ['ignored-inputs'],
    task: reads(['src/**'], 'src/gen/keep.txt'),
    files: {
      '.gitignore': 'src/gen/*\n!src/gen/keep.txt\n',
      'src/gen/keep.txt': 'k\n',
      'src/gen/x.txt': 'x\n',
    },
    changes: [
      [{ 'src/gen/x.txt': 'x2\n' }, false],
      [{ 'src/gen/keep.txt': 'k2\n' }, true, 'k2\n'],
    ],
  }),

  // gitignore(5): a slash in the middle anchors the rule to its .gitignore
  edits({
    id: 'inputs/gitignore-middle-slash-rule-is-anchored',
    kind: 'correctness',
    title:
      'A .gitignore rule `deep/x.txt` ignores only that path below it, not a deeper `deep/x.txt`',
    why: 'A rule with a slash in the middle is anchored to the directory of its .gitignore, so `deep/x.txt` in `src/.gitignore` ignores `src/deep/x.txt` and nothing else. `src/more/deep/x.txt` is an input. A runner that matches the rule at any depth drops it from the key, and its edits replay. Only rules without a slash float.',
    from: ['ignored-inputs'],
    task: reads(['src/**'], 'src/more/deep/x.txt'),
    files: {
      'src/.gitignore': 'deep/x.txt\n',
      'src/deep/x.txt': 'i\n',
      'src/more/deep/x.txt': 'x\n',
    },
    changes: [
      [{ 'src/deep/x.txt': 'i2\n' }, false],
      [{ 'src/more/deep/x.txt': 'x2\n' }, true, 'x2\n'],
    ],
  }),

  // gitignore(5): a leading slash anchors the rule
  edits({
    id: 'inputs/gitignore-leading-slash-rule-is-anchored',
    kind: 'correctness',
    title: 'A .gitignore rule `/x.txt` ignores the file beside it, not a deeper `x.txt`',
    why: 'A leading slash anchors a rule to its .gitignore’s directory. `/x.txt` in `src/.gitignore` ignores `src/x.txt` only, and `src/d/x.txt` is an input the task reads. A runner that drops the slash and floats the rule leaves that file out of the key. Its edits then replay.',
    from: ['ignored-inputs'],
    task: reads(['src/**'], 'src/d/x.txt'),
    files: { 'src/.gitignore': '/x.txt\n', 'src/x.txt': 'i\n', 'src/d/x.txt': 'x\n' },
    changes: [
      [{ 'src/x.txt': 'i2\n' }, false],
      [{ 'src/d/x.txt': 'x2\n' }, true, 'x2\n'],
    ],
  }),

  // gitignore(5): trailing spaces are ignored unless quoted with a backslash
  edits({
    id: 'inputs/gitignore-rule-trailing-space-ignored',
    kind: 'efficiency',
    title: 'A .gitignore rule written `x.log ` with a trailing space still ignores `x.log`',
    why: 'Git strips trailing spaces from ignore rules, so `x.log ` ignores `x.log`, and the stray space is a common editor slip. Git never lists the file. A runner reading the rule byte for byte looks for a name ending in a space, keys `x.log`, and reruns on every log write. It should ignore what git ignores.',
    from: ['ignored-inputs'],
    task: reads(['src/**'], 'src/a.txt'),
    files: { 'src/.gitignore': 'x.log \n', 'src/a.txt': 'a\n', 'src/x.log': 'l\n' },
    changes: [[{ 'src/x.log': 'l2\n' }, false]],
  }),

  // gitignore(5): `\#` names a file starting with `#`
  edits({
    id: 'inputs/gitignore-escaped-hash-rule',
    kind: 'efficiency',
    title: 'A .gitignore rule `\\#lock` ignores the file named `#lock`',
    why: 'In .gitignore `#` starts a comment, so a file starting with `#` is ignored by writing `\\#`. Editors leave such lock files beside sources. A runner with its own parser that keeps the backslash matches nothing and keys the lock file, rerunning on every save. Git ignores it, so it is no input.',
    from: ['ignored-inputs'],
    task: reads(['src/**'], 'src/a.txt'),
    files: { 'src/.gitignore': '\\#lock\n', 'src/a.txt': 'a\n', 'src/#lock': 'l\n' },
    changes: [[{ 'src/#lock': 'l2\n' }, false]],
  }),

  // gitignore(5): `\!` names a file starting with `!`
  edits({
    id: 'inputs/gitignore-escaped-bang-rule',
    kind: 'efficiency',
    title: 'A .gitignore rule `\\!scratch` ignores the file named `!scratch`',
    why: 'A rule starting with `!` is a negation, so a file starting with `!` is ignored by writing `\\!`. Git then never lists it. A runner with its own parser that reads the rule as a negation, or keeps the backslash, keys the file and reruns on its edits. Git ignores it, so it is no input.',
    from: ['ignored-inputs'],
    task: reads(['src/**'], 'src/a.txt'),
    files: { 'src/.gitignore': '\\!scratch\n', 'src/a.txt': 'a\n', 'src/!scratch': 's\n' },
    changes: [[{ 'src/!scratch': 's2\n' }, false]],
  }),

  // gitignore(5): a trailing slash matches only a directory
  edits({
    id: 'inputs/gitignore-directory-only-rule-spares-file',
    kind: 'correctness',
    title: 'A .gitignore rule `cache/` leaves a file named `cache` an input',
    why: 'A trailing slash makes a rule match only directories, so `cache/` ignores a `cache` directory and not a file called `cache`. Git lists that file, and the task reads it. A runner whose matcher drops the slash ignores the file too, and its edits replay. The slash is the whole point of the rule.',
    from: ['ignored-inputs'],
    task: reads(['src/**'], 'src/d/cache'),
    files: { 'src/.gitignore': 'cache/\n', 'src/d/cache': 'c\n', 'src/cache/x.txt': 'i\n' },
    changes: [
      [{ 'src/cache/x.txt': 'i2\n' }, false],
      [{ 'src/d/cache': 'c2\n' }, true, 'c2\n'],
    ],
  }),

  // gitignore(5): `a/**/b` matches `b` at any depth below `a`, and only there
  edits({
    id: 'inputs/gitignore-globstar-middle-rule',
    kind: 'correctness',
    title:
      'A .gitignore rule `a/**/t.log` ignores `t.log` deep under `a` and keeps `b/t.log` an input',
    why: 'A `**` between slashes in an ignore rule matches any run of directories, and the rule is anchored where it sits. So `a/**/t.log` ignores `a/x/y/t.log` but not `b/t.log`. A matcher that floats the rule ignores the second, whose edits then replay; one that reads `**` as one level keys the first. Both must follow git.',
    from: ['ignored-inputs'],
    task: reads(['src/**'], 'src/b/t.log'),
    files: { 'src/.gitignore': 'a/**/t.log\n', 'src/a/x/y/t.log': 'i\n', 'src/b/t.log': 'k\n' },
    changes: [
      [{ 'src/a/x/y/t.log': 'i2\n' }, false],
      [{ 'src/b/t.log': 'k2\n' }, true, 'k2\n'],
    ],
  }),

  // gitignore(5): bracket classes
  edits({
    id: 'inputs/gitignore-class-rule',
    kind: 'correctness',
    title: 'A .gitignore rule `[ab].log` ignores `a.log` and keeps `c.log` an input',
    why: 'Ignore rules take bracket classes like globs do. `[ab].log` ignores `a.log` and `b.log` only. A hand-written matcher that takes the brackets literally keys `a.log`, and one that over-matches drops `c.log`, whose edits then replay. Git’s answer is the one to follow.',
    from: ['ignored-inputs'],
    task: reads(['src/**'], 'src/c.log'),
    files: { 'src/.gitignore': '[ab].log\n', 'src/a.log': 'i\n', 'src/c.log': 'k\n' },
    changes: [
      [{ 'src/a.log': 'i2\n' }, false],
      [{ 'src/c.log': 'k2\n' }, true, 'k2\n'],
    ],
  }),

  // turborepo-scm git_index_regression_tests test_gitignore_in_untracked_directory
  edits({
    id: 'inputs/gitignore-rule-ignores-tracked-file-still-keyed',
    kind: 'correctness',
    title: 'A committed file a later .gitignore rule names is still an input',
    why: 'Ignore rules apply only to untracked files: once committed, a file stays tracked whatever .gitignore says later. Git still reports its edits, and the task reads it. A runner that filters every path through the ignore rules drops it from the key, and its edits replay. Tracked beats ignored.',
    from: ['ignored-inputs'],
    task: reads(['src/**'], 'src/gen.txt'),
    files: { 'src/gen.txt': 'g\n' },
    setup: [{ write: { 'packages/a/src/.gitignore': 'gen.txt\n' } }, { commit: 'ignore gen' }],
    changes: [[{ 'src/gen.txt': 'g2\n' }, true, 'g2\n']],
  }),

  // git: .git/info/attributes holds attributes outside the tree
  edits({
    id: 'inputs/ident-under-info-attributes-hidden-edit-reruns',
    kind: 'correctness',
    title:
      'With `ident` set in `.git/info/attributes`, an edit inside `$Id: … $` runs the task again',
    why: 'Attributes can live in `.git/info/attributes`, outside the tree, and git applies them like a committed .gitattributes. There `ident` makes an edit inside `$Id: … $` leave the blob unchanged and the file clean in git’s eyes. A runner that looks for attributes only in the tree trusts the blob and replays. The task reads the edited text.',
    from: ['stale-hit-git'],
    task: reads(['src/**'], 'src/a.txt'),
    files: { 'src/a.txt': 'v $Id$\n' },
    setup: [{ sh: "mkdir -p .git/info && printf '*.txt ident\\n' > .git/info/attributes" }],
    changes: [[{ 'src/a.txt': 'v $Id: hand $\n' }, true, 'v $Id: hand $\n']],
  }),

  // ---- file modes ---------------------------------------------------------

  // turborepo-scm file_hash_mode_tests (only the executable bit is git's mode)
  defineCase({
    id: 'inputs/read-permission-change-replays',
    category: 'inputs',
    kind: 'efficiency',
    title: 'Making an input read-only for others (0644 to 0640) lets the build replay',
    why: 'Git records only whether a file is executable, and a task reading the file sees the same bytes. A umask or a copy tool changes other permission bits all the time. A runner that keys the whole mode reruns after such a copy for nothing. The executable bit is the one mode a build can tell from its output.',
    from: ['cache-hash-files'],
    workspace: {
      projects: {
        a: { tasks: { build: reads(['src/**'], 'src/a.txt') }, files: { 'src/a.txt': 'a\n' } },
      },
    },
    steps: [
      { chmod: { 'packages/a/src/a.txt': 0o644 } },
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      { chmod: { 'packages/a/src/a.txt': 0o640 } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
    ],
  }),

  // ---- dependencies -------------------------------------------------------

  // nx hasher (task hash folds dependency hashes); moon task-hasher
  defineCase({
    id: 'inputs/dependency-edit-reverted-replays-chain',
    category: 'inputs',
    kind: 'efficiency',
    title: 'Undoing an edit to a dependency replays both it and its dependant from the first run',
    why: 'Once the dependency’s files are back as they were, every key in the chain is what the first run computed, and both results are stored. A runner whose dependant key holds something run-specific, such as a dependency’s output timestamps, rebuilds the dependant for nothing. Keys follow inputs, so the revert hits all the way down.',
    from: ['hash-chain'],
    workspace: {
      projects: {
        lib: { tasks: { build: reads(['src/**'], 'src/a.txt') }, files: { 'src/a.txt': 'one\n' } },
        app: {
          deps: ['lib'],
          tasks: {
            build: {
              command: 'mkdir -p dist && cat ../lib/dist/out.txt > dist/out.txt',
              dependsOn: ['^build'],
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('app')]: 'one\n' } } },
      { write: { 'packages/lib/src/a.txt': 'two\n' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['lib#build', 'app#build'], files: { [out('app')]: 'two\n' } },
      },
      { write: { 'packages/lib/src/a.txt': 'one\n' } },
      {
        run: 'build',
        expect: { exit: 0, notRan: ['lib#build', 'app#build'], files: { [out('app')]: 'one\n' } },
      },
    ],
  }),

  // nx hasher (transitive dependency hashes)
  defineCase({
    id: 'inputs/grandparent-edit-reruns-through-unchanged-output',
    category: 'inputs',
    kind: 'correctness',
    title:
      'Editing a dependency two levels down runs the top project again, though the middle one’s output reads the same',
    why: 'Keys cascade by inputs: a change anywhere upstream changes every key below it. Here the middle project’s output does not show the change, but the top project reads the bottom one’s output directly. A runner keying a dependant only by its direct dependencies’ outputs replays it with the old bytes. Folding upstream input keys catches it.',
    from: ['hash-chain'],
    workspace: {
      projects: {
        lib: { tasks: { build: reads(['src/**'], 'src/a.txt') }, files: { 'src/a.txt': 'one\n' } },
        mid: {
          deps: ['lib'],
          tasks: {
            build: {
              command: 'mkdir -p dist && echo mid > dist/out.txt',
              dependsOn: ['^build'],
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'm\n' },
        },
        app: {
          deps: ['mid'],
          tasks: {
            build: {
              command:
                'mkdir -p dist && cat ../mid/dist/out.txt ../lib/dist/out.txt > dist/out.txt',
              dependsOn: ['^build'],
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, files: { [out('app')]: 'mid\none\n' } } },
      { write: { 'packages/lib/src/a.txt': 'two\n' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['app#build'], files: { [out('app')]: 'mid\ntwo\n' } },
      },
    ],
  }),

  // ---- root inputs, more --------------------------------------------------

  // moon task-hasher (`/.config/**` workspace inputs)
  rootEdits({
    id: 'inputs/root-input-dot-directory',
    kind: 'correctness',
    title: 'A root input `.config/**` keys files under a dot directory at the root',
    why: 'Shared tool settings often live in a dot directory at the root, and a root input names it. A walker that skips dot directories at the root keys nothing there. Edits then replay output built under the old settings. A pattern that names the dot directory must walk it.',
    from: ['workspace-files'],
    task: readsRoot(['.config/**'], '.config/tool/cfg.txt'),
    rootFiles: { '.config/tool/cfg.txt': 'v1\n' },
    changes: [[{ '.config/tool/cfg.txt': 'v2\n' }, true, 'v2\n']],
  }),

  // turborepo-scm package_deps.rs test_repo_wide_inputs (untracked root files)
  rootEdits({
    id: 'inputs/root-input-untracked-new-directory',
    kind: 'correctness',
    title: 'A file in a new untracked directory under a root input glob runs the task again',
    why: 'Git lists a new directory as one entry until asked to expand it. A runner that expands untracked directories only inside projects keys nothing for a new root directory. The task reads the new file, so its output changes. It must run again.',
    from: ['workspace-files'],
    task: {
      ...readsRoot(['shared/**'], ''),
      command: 'mkdir -p dist && cat $(find ../../shared -type f | sort) > dist/out.txt',
    },
    rootFiles: { 'shared/a.txt': 'a\n' },
    changes: [[{ 'shared/new/b.txt': 'b\n' }, true, 'a\nb\n']],
  }),
] as Case[]
