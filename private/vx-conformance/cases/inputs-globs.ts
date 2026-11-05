// How an input or output glob is spelled: braces, classes, `./`, literal
// directories, negations, dotfiles. Each spelling must key exactly the files
// it names, so an edit there runs the task and an edit elsewhere does not.
import { defineCase, type Case, type Kind, type TaskSpec } from '../src/spec.ts'
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

/**
 * One project `a`, built once, then each change in turn: `true` must run the
 * build again (and leave `want` in dist/out.txt when given), `false` must not.
 */
function edits(c: {
  id: string
  kind: Kind
  title: string
  why: string
  from: string[]
  task: TaskSpec
  files: Record<string, string>
  changes: Array<[Record<string, string | null>, boolean, string?]>
}): Case {
  return defineCase({
    id: c.id,
    category: c.id.startsWith('outputs/') ? 'outputs' : 'inputs',
    kind: c.kind,
    title: c.title,
    why: c.why,
    from: c.from,
    workspace: { projects: { a: { tasks: { build: c.task }, files: c.files } } },
    steps: [
      { run: 'build', expect: { exit: 0, ran: ['a#build'] } },
      ...c.changes.flatMap(([change, reruns, want]) => [
        { write: inA(change) },
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

export default [
  edits({
    id: 'inputs/brace-globstar-alternative',
    kind: 'correctness',
    title: 'An edit deep under a brace alternative ending in `**` runs the task again',
    why: 'A brace stands for its alternatives, so `{src/**,lib/**}` means `src/**` and `lib/**`, each at full depth. A tool that matches `**` inside a brace only one level deep misses nested files. An edit deep under `src` then replays output built from the old file.',
    from: ['brace-inputs'],
    task: reads(['{src/**,lib/**}'], 'src/deep/x.txt'),
    files: { 'src/top.txt': 't\n', 'src/deep/x.txt': 'x\n', 'lib/y.txt': 'y\n' },
    changes: [[{ 'src/deep/x.txt': 'x2\n' }, true, 'x2\n']],
  }),

  edits({
    id: 'inputs/brace-of-directories',
    kind: 'correctness',
    title: 'An input `{src,lib}` keys every file under both directories',
    why: 'Each brace alternative here names a directory, and a directory input keys its whole tree. `{src,lib}` should mean the same as listing `src` and `lib`. A tool that matches only the directory entries keys nothing inside, and edits under them replay stale output.',
    from: ['brace-inputs'],
    task: reads(['{src,lib}'], 'src/deep/a.txt'),
    files: { 'src/deep/a.txt': 'a\n', 'lib/b.txt': 'b\n' },
    changes: [[{ 'src/deep/a.txt': 'a2\n' }, true, 'a2\n']],
  }),

  edits({
    id: 'inputs/brace-dot-slash-alternative',
    kind: 'correctness',
    title: 'An input `{./src,lib}/**` keys files under `src`',
    why: '`./src` and `src` name the same directory, inside a brace or not. A tool that compares the alternative to paths without dropping the `./` matches nothing. Edits under `src` then change no key, and the old output replays. Writing `./` is a style choice and must not change which files are keyed.',
    from: ['brace-inputs', 'dot-slash-globs'],
    task: reads(['{./src,lib}/**'], 'src/deep/a.txt'),
    files: { 'src/deep/a.txt': 'a\n', 'lib/b.txt': 'b\n' },
    changes: [[{ 'src/deep/a.txt': 'a2\n' }, true, 'a2\n']],
  }),

  edits({
    id: 'inputs/brace-dot-alternative',
    kind: 'correctness',
    title: 'An input `{.,src}/*.txt` keys a `.txt` file at the project’s top',
    why: '`.` is the project directory, so `{.,src}/*.txt` covers `.txt` files at the project’s top and in `src`. A tool that drops or mismatches the `.` alternative misses the top-level file. Edits to it then replay a stale result. The pattern is valid and common in shell-style globs.',
    from: ['brace-inputs'],
    task: reads(['{.,src}/*.txt'], 'a.txt'),
    files: { 'a.txt': 'a\n', 'src/b.txt': 'b\n' },
    changes: [[{ 'a.txt': 'a2\n' }, true, 'a2\n']],
  }),

  edits({
    id: 'inputs/brace-unnamed-file-ignored',
    kind: 'efficiency',
    title: 'A file no brace alternative names changes nothing',
    why: 'A brace limits the inputs to the paths its alternatives name. A file in a directory no alternative names is not what the task reads. Keying it anyway reruns the task on unrelated edits, wasting work on every developer machine and in CI. The brace is how the user narrows the set.',
    from: ['brace-inputs'],
    task: reads(['{src,lib}/**'], 'src/a.txt'),
    files: { 'src/a.txt': 'a\n', 'other/z.txt': 'z\n' },
    changes: [[{ 'other/z.txt': 'z2\n' }, false]],
  }),

  edits({
    id: 'inputs/brace-class-comma',
    kind: 'correctness',
    title: 'A `,` inside a class in a brace alternative is part of the name, not a cut',
    why: 'Inside a character class, a `,` is a character to match, not a brace separator. A parser that splits on it first breaks `a[,]b` into two broken alternatives. The file `a,b.txt` then matches nothing, and edits to it replay stale output. Classes are parsed before alternatives are cut.',
    from: ['brace-inputs'],
    task: reads(['src/{a[,]b,x}.txt'], '"src/a,b.txt"'),
    files: { 'src/a,b.txt': 'ab\n', 'src/b.txt': 'b\n' },
    changes: [[{ 'src/a,b.txt': 'ab2\n' }, true, 'ab2\n']],
  }),

  edits({
    id: 'inputs/brace-class-open-brace',
    kind: 'correctness',
    title: 'A `{` inside a class in a brace alternative is part of the name',
    why: 'Inside a character class, `{` is a character to match, not the start of a nested brace. A parser that reads it as syntax mangles the pattern. The file `a{b.txt` drops out of the key, and its edits replay a stale result. Classes are parsed before braces, so their contents are plain characters.',
    from: ['brace-inputs'],
    task: reads(['src/{a[{]b,x}.txt'], '"src/a{b.txt"'),
    files: { 'src/a{b.txt': 'ab\n', 'src/b.txt': 'b\n' },
    changes: [[{ 'src/a{b.txt': 'ab2\n' }, true, 'ab2\n']],
  }),

  edits({
    id: 'inputs/brace-class-comma-negated',
    kind: 'efficiency',
    title: 'A `!` brace alternative with a `,` in a class takes that file back',
    why: 'A negation is parsed the same way as a positive glob, so `a[,]b` still names `a,b.txt`. If the negation is split at the comma, it matches nothing and the file stays an input. Every edit to it then reruns a task the user said it does not affect. Negations follow the same grammar as the globs they narrow.',
    from: ['brace-inputs'],
    task: reads(['src/**', '!src/{a[,]b,x}.txt'], 'src/c.txt'),
    files: { 'src/c.txt': 'c\n', 'src/a,b.txt': 'ab\n' },
    changes: [[{ 'src/a,b.txt': 'ab2\n' }, false]],
  }),

  edits({
    id: 'inputs/escaped-brace-literal',
    kind: 'correctness',
    title: 'An input `src/\\{b\\}.txt` keys the file named with the braces',
    why: 'A backslash escapes a brace, so `src/\\{b\\}.txt` names the file `{b}.txt` literally. Braces in file names are rare but legal. A tool that drops the escapes keys `b.txt` instead, and edits to the real file replay a stale result. The escape is the only way to name such a file in a glob.',
    from: ['one-alternative-brace'],
    task: reads(['src/\\{b\\}.txt'], '"src/{b}.txt"'),
    files: { 'src/{b}.txt': 'braces\n', 'src/b.txt': 'b\n' },
    changes: [[{ 'src/{b}.txt': 'braces2\n' }, true, 'braces2\n']],
  }),

  edits({
    id: 'inputs/escaped-brace-not-alternative',
    kind: 'efficiency',
    title: 'An input `src/\\{b\\}.txt` does not key `src/b.txt`',
    why: 'An escaped brace is literal text, not an alternative, so `src/\\{b\\}.txt` does not name `src/b.txt`. The escape is how the user says exactly which file they mean. Keying the other file reruns the task when nothing it reads changed. Reading it as a brace undoes the escape.',
    from: ['one-alternative-brace'],
    task: reads(['src/\\{b\\}.txt'], '"src/{b}.txt"'),
    files: { 'src/{b}.txt': 'braces\n', 'src/b.txt': 'b\n' },
    changes: [[{ 'src/b.txt': 'b2\n' }, false]],
  }),

  edits({
    id: 'inputs/dot-slash-input',
    kind: 'correctness',
    title: 'An input written `./src/**` keys the files under `src`',
    why: '`./src/**` and `src/**` name the same files; the `./` prefix is a common way to write a relative path. A tool that matches the glob against paths without `./` finds nothing. The key then never moves, and every edit under `src` replays the old output.',
    from: ['dot-slash-globs'],
    task: reads(['./src/**'], 'src/a.txt'),
    files: { 'src/a.txt': 'a\n' },
    changes: [[{ 'src/a.txt': 'a2\n' }, true, 'a2\n']],
  }),

  edits({
    id: 'inputs/dot-slash-negation',
    kind: 'efficiency',
    title: 'A negation written `!./gen/**` takes `gen` back out of the inputs',
    why: 'A negation written `!./gen/**` takes back the same files as `!gen/**`. If the `./` makes it match nothing, `gen` stays in the inputs. Every regeneration then reruns a task the user said does not read it. Generated files are often the very thing such a negation is written to exclude, so the rerun repeats on every generator run.',
    from: ['dot-slash-globs'],
    task: reads(['**', '!./gen/**', '!dist/**'], 'src/a.txt'),
    files: { 'src/a.txt': 'a\n', 'gen/g.txt': 'g\n' },
    changes: [[{ 'gen/g.txt': 'g2\n' }, false]],
  }),

  defineCase({
    id: 'outputs/dot-slash-output',
    category: 'outputs',
    kind: 'efficiency',
    title: 'Outputs written `./dist/**` are stored and restored',
    why: 'Output globs are project-relative paths, and `./dist/**` names the same files as `dist/**`. If the `./` makes the glob match nothing, the cache stores an empty entry. A later replay then counts as a hit and restores nothing, leaving `dist` missing for the next step.',
    from: ['dot-slash-globs'],
    workspace: {
      projects: {
        a: {
          tasks: { build: reads(['src/**'], 'src/a.txt', { outputs: ['./dist/**'] }) },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/a/dist': null } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'], files: { [out('a')]: 'a\n' } } },
    ],
  }),

  edits({
    id: 'inputs/trailing-dot-directory',
    kind: 'correctness',
    title: 'An input `*/.` names each top directory’s whole tree',
    why: '`src/.` is the directory `src` itself, so `*/.` names each top directory and its whole tree. A tool that treats the trailing `.` as a literal file name matches nothing. The task’s key then ignores every source edit and replays the old output. `.` means the directory in any path.',
    from: ['dot-slash-globs'],
    task: reads(['*/.', '!gen/.', '!dist/**'], 'src/a.txt gen/g.txt'),
    files: { 'src/a.txt': 'a\n', 'gen/g.txt': 'g\n' },
    changes: [[{ 'src/a.txt': 'a2\n' }, true, 'a2\ng\n']],
  }),

  edits({
    id: 'inputs/trailing-dot-negation',
    kind: 'efficiency',
    title: 'A negation `!gen/.` takes the whole `gen` tree back',
    why: 'A negation `!gen/.` names the directory `gen` and takes its whole tree back. If the trailing `.` makes the negation match nothing, generated files stay in the key. Every regeneration then reruns a task the user excluded them from. Its positive form keys the whole tree, so its negation takes the whole tree back.',
    from: ['dot-slash-globs'],
    task: reads(['*/.', '!gen/.', '!dist/**'], 'src/a.txt gen/g.txt'),
    files: { 'src/a.txt': 'a\n', 'gen/g.txt': 'g\n' },
    changes: [[{ 'gen/g.txt': 'g2\n' }, false]],
  }),

  edits({
    id: 'inputs/trailing-slash-pattern',
    kind: 'correctness',
    title: 'An input `src/**/` (a trailing slash) keys the files under `src`',
    why: 'A trailing slash marks a pattern as a directory, so `src/**/` covers the directories under `src` and the files in them. A tool that matches only directory entries keys no file. The key never moves, and edits under `src` replay stale output. The slash narrows the match to directories; it does not empty it.',
    from: ['dot-slash-globs'],
    task: reads(['src/**/'], 'src/a.txt'),
    files: { 'src/a.txt': 'a\n' },
    changes: [[{ 'src/a.txt': 'a2\n' }, true, 'a2\n']],
  }),

  edits({
    id: 'inputs/literal-directory',
    kind: 'correctness',
    title: 'An input naming a directory, `src`, keys every file in its tree',
    why: 'A user who names a directory, `src`, means the files in it. A tool that treats the name as a glob matching only the directory entry keys nothing inside. Every edit under `src` then replays the old output, with no warning. Naming a directory is the simplest input there is, so it must mean its contents.',
    from: ['inputs-resolution'],
    task: reads(['src'], 'src/deep/b.txt'),
    files: { 'src/a.txt': 'a\n', 'src/deep/b.txt': 'b\n' },
    changes: [[{ 'src/deep/b.txt': 'b2\n' }, true, 'b2\n']],
  }),

  edits({
    id: 'inputs/literal-directory-trailing-slash',
    kind: 'correctness',
    title: 'An input naming a directory with a trailing slash, `src/`, keys its tree',
    why: '`src/` is a common way to name a directory, and it means every file in its tree. Read as a bare glob, it matches no file and the key never moves. Every edit under `src` then replays the old output under a green run. The slash only says the path is a directory; it does not change which files are in it.',
    from: ['inputs-resolution', 'dot-slash-globs'],
    task: reads(['src/'], 'src/deep/b.txt'),
    files: { 'src/a.txt': 'a\n', 'src/deep/b.txt': 'b\n' },
    changes: [[{ 'src/deep/b.txt': 'b2\n' }, true, 'b2\n']],
  }),

  edits({
    id: 'inputs/negated-literal-directory',
    kind: 'efficiency',
    title: 'A negation naming a directory, `!gen`, takes its whole tree back',
    why: 'A negation naming a directory, `!gen`, takes back every file in that tree, just as the positive form keys it. If it only removed the directory entry, the generated files would stay in the key. Each regeneration would then rerun a task the user excluded them from.',
    from: ['inputs-resolution'],
    task: reads(['**', '!gen', '!dist/**'], 'src/a.txt'),
    files: { 'src/a.txt': 'a\n', 'gen/deep/g.txt': 'g\n' },
    changes: [[{ 'gen/deep/g.txt': 'g2\n' }, false]],
  }),

  defineCase({
    id: 'outputs/literal-directory-output',
    category: 'outputs',
    kind: 'correctness',
    title: 'An output naming a directory, `dist`, stores and restores its whole tree',
    why: 'An output naming a directory, `dist`, means everything the task wrote there. A tool that stores only the directory entry restores an empty `dist` on a replay. The next step then finds no build output, though the run reported a cache hit. A hit that restores nothing is worse than a miss, because nothing looks wrong.',
    from: ['inputs-resolution'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command:
                'mkdir -p dist/deep && cat src/a.txt > dist/a.txt && echo b > dist/deep/b.txt',
              inputs: ['src/**'],
              outputs: ['dist'],
            },
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/a/dist': null } },
      {
        run: 'build',
        expect: {
          exit: 0,
          files: { 'packages/a/dist/a.txt': 'a\n', 'packages/a/dist/deep/b.txt': 'b\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'outputs/dotfile-output',
    category: 'outputs',
    kind: 'correctness',
    title: 'A dotfile under an output glob is restored with the rest',
    why: 'An output glob covers every file the task wrote under it, dotfiles included. Dotfiles in build output often carry metadata, manifests or config. Leaving them out of the stored entry restores a tree that differs from a fresh build. A replay must leave the same tree a fresh run does.',
    from: ['inputs-resolution'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command: 'mkdir -p dist && cat src/a.txt > dist/out.txt && echo meta > dist/.meta',
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/a/dist': null } },
      {
        run: 'build',
        expect: { exit: 0, files: { [out('a')]: 'a\n', 'packages/a/dist/.meta': 'meta\n' } },
      },
    ],
  }),

  edits({
    id: 'inputs/bracket-class',
    kind: 'correctness',
    title: 'An input `app/[ab]/*.js` keys the directories the class names',
    why: 'A character class `[ab]` matches one of the listed characters, as in any glob. `app/[ab]/*.js` therefore covers `app/a` and `app/b`. A tool that reads the brackets literally keys nothing, and edits to those files replay stale output. Classes are part of every common glob syntax.',
    from: ['task-glob-brackets'],
    task: reads(['app/[ab]/*.js'], 'app/b/x.js'),
    files: { 'app/a/x.js': 'a\n', 'app/b/x.js': 'b\n', 'app/c/x.js': 'c\n' },
    changes: [[{ 'app/b/x.js': 'b2\n' }, true, 'b2\n']],
  }),

  edits({
    id: 'inputs/bracket-class-excludes',
    kind: 'efficiency',
    title: 'An input `app/[ab]/*.js` does not key a directory the class leaves out',
    why: 'A character class matches only the characters it lists, so `app/[ab]/` leaves `app/c` out. A file outside the class is not what the task reads. Keying it reruns the task on edits that cannot change its output. The class is how the user narrows the set, and the cache should honour it.',
    from: ['task-glob-brackets'],
    task: reads(['app/[ab]/*.js'], 'app/b/x.js'),
    files: { 'app/a/x.js': 'a\n', 'app/b/x.js': 'b\n', 'app/c/x.js': 'c\n' },
    changes: [[{ 'app/c/x.js': 'c2\n' }, false]],
  }),

  edits({
    id: 'inputs/escaped-route-directory',
    kind: 'correctness',
    title: 'An input `app/\\[id\\]/**` keys the route directory named `[id]`',
    why: 'File-system routers name directories with brackets, such as `app/[id]`, and an escaped `\\[id\\]` names that directory literally. Read as a class, the pattern matches `app/i/…` and never the route. An edit to the route then replays the old output. Without the escape, a bracketed route cannot be named at all.',
    from: ['task-glob-brackets', 'inputs-property'],
    task: reads(['app/\\[id\\]/**'], '"app/[id]/page.js"'),
    files: { 'app/[id]/page.js': 'v1\n' },
    changes: [[{ 'app/[id]/page.js': 'v2\n' }, true, 'v2\n']],
  }),

  edits({
    id: 'inputs/escaped-route-not-class',
    kind: 'efficiency',
    title: 'An input `app/\\[id\\]/*.js` does not key the sibling `app/i` a class would match',
    why: 'An escaped `\\[id\\]` names the literal directory `[id]`, not a class of the letters i and d. A sibling `app/i` is not what the task reads. Keying it reruns the task on edits that cannot change its output. The escape is how the user says the brackets are part of the name, and the match should honour that.',
    from: ['task-glob-brackets'],
    task: reads(['app/\\[id\\]/*.js'], '"app/[id]/x.js"'),
    files: { 'app/[id]/x.js': 'route\n', 'app/i/x.js': 'sibling\n' },
    changes: [[{ 'app/i/x.js': 'sibling2\n' }, false]],
  }),

  defineCase({
    id: 'outputs/escaped-route-output',
    category: 'outputs',
    kind: 'correctness',
    title:
      'An output `app/\\[id\\]/page.js` restores the route and leaves the sibling `app/i` alone',
    why: 'An escaped output `app/\\[id\\]/page.js` names the route file literally. Read as a class, it matches `app/i/page.js` instead, so a restore can overwrite or delete that sibling and miss the route. A replay must bring back the route and leave unrelated files alone.',
    from: ['task-glob-brackets'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command: 'mkdir -p "app/[id]" && cat src/in.txt > "app/[id]/page.js"',
              inputs: ['src/**'],
              outputs: ['app/\\[id\\]/page.js'],
            },
          },
          files: { 'src/in.txt': 'v1\n', 'app/i/page.js': 'SIBLING\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0, files: { 'packages/a/app/i/page.js': 'SIBLING\n' } } },
      { write: { 'packages/a/app/[id]/page.js': null } },
      {
        run: 'build',
        expect: {
          exit: 0,
          files: {
            'packages/a/app/[id]/page.js': 'v1\n',
            'packages/a/app/i/page.js': 'SIBLING\n',
          },
        },
      },
    ],
  }),

  edits({
    id: 'inputs/negation-listed-first',
    kind: 'efficiency',
    title: 'A `!` input listed before the glob it narrows still takes its file back',
    why: 'Inputs are a set, not an ordered ignore file: the position of a negation in the list carries no meaning. A tool that applies a negation only to globs listed before it ignores this one. The excluded file then keys the task, and edits to it rerun the task for nothing.',
    from: ['inputs-resolution'],
    task: reads(['!src/notes.md', 'src/**'], 'src/a.txt'),
    files: { 'src/a.txt': 'a\n', 'src/notes.md': 'one\n' },
    changes: [[{ 'src/notes.md': 'two\n' }, false]],
  }),

  defineCase({
    id: 'inputs/own-outputs-not-inputs',
    category: 'inputs',
    kind: 'efficiency',
    title: 'A task whose inputs cover its own outputs still replays on the next run',
    why: 'A broad input such as `**` often covers the task’s own output directory. Keying a task on what it wrote moves its key after every run, so it never replays. The cache then fills with entries nothing uses, and every run does the full work. Declared outputs are what the task makes, never what it reads.',
    from: ['inputs-resolution'],
    workspace: {
      projects: {
        a: {
          tasks: { build: reads(['**'], 'src/a.txt') },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'], files: { [out('a')]: 'a\n' } } },
    ],
  }),

  defineCase({
    id: 'inputs/tracked-node-modules',
    category: 'inputs',
    kind: 'correctness',
    title: 'A committed file under a nested `node_modules` is an input like any other',
    why: 'Ignored files are local state, but a file committed to the repository is source, whatever directory it sits in. An install under `node_modules` is untracked; a committed test fixture there is not. Skipping it by directory name replays tests against the old fixture.',
    from: ['inputs-resolution', 'inputs-property'],
    workspace: {
      files: {
        '.gitignore': [
          '/node_modules',
          '.home',
          '.ran',
          '.turbo',
          '.nx',
          '.vx/cache',
          'dist',
          '',
        ].join('\n'),
      },
      projects: {
        a: {
          tasks: { build: reads(['src/**', 'fixtures/**'], 'fixtures/node_modules/dep/index.js') },
          files: { 'src/a.txt': 'a\n', 'fixtures/node_modules/dep/index.js': 'one\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/a/fixtures/node_modules/dep/index.js': 'two\n' } },
      { commit: 'fixture' },
      { run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'two\n' } } },
    ],
  }),

  edits({
    id: 'inputs/dot-directory-input',
    kind: 'correctness',
    title: 'A committed file under a dot directory (`.github`) is an input of `**`',
    why: 'A committed file under a dot directory like `.github` is part of the repository, and `**` covers it. Shell-style globbing skips dot directories unless asked. A task that reads such a file would then replay stale output after it changes. `**` in an input means every file under it.',
    from: ['inputs-resolution', 'inputs-property'],
    task: reads(['**'], '.github/ci.yml'),
    files: { '.github/ci.yml': 'one\n' },
    changes: [[{ '.github/ci.yml': 'two\n' }, true, 'two\n']],
  }),

  edits({
    id: 'inputs/dotfile-input',
    kind: 'correctness',
    title: 'A dotfile under an input glob (`src/.env`) is an input',
    why: 'A dotfile such as `src/.env` under an input glob is a file the task can read. Shell-style globbing skips dotfiles by default, and a tool that copies that rule drops it from the key. Editing it then replays output built from the old values. Dotfiles are often config, the files most likely to change the output.',
    from: ['inputs-property', 'inputs-resolution'],
    task: reads(['src/**'], 'src/.env'),
    files: { 'src/.env': 'one\n' },
    changes: [[{ 'src/.env': 'two\n' }, true, 'two\n']],
  }),

  edits({
    id: 'inputs/tracked-build-state',
    kind: 'correctness',
    title: 'A committed `tsconfig.tsbuildinfo` is an input of `**`',
    why: 'A build-state file like `tsconfig.tsbuildinfo` is ignored only when the repository ignores it; committed, it is source. A tool that skips it by name second-guesses the repository. Edits to it then replay a stale result, and nothing says the file was skipped.',
    from: ['inputs-resolution'],
    task: reads(['**'], 'tsconfig.tsbuildinfo'),
    files: { 'tsconfig.tsbuildinfo': 'one\n' },
    changes: [[{ 'tsconfig.tsbuildinfo': 'two\n' }, true, 'two\n']],
  }),

  edits({
    id: 'inputs/highest-sorting-name',
    kind: 'correctness',
    title: 'A file whose name sorts after every other is still an input',
    why: 'A file name can be any valid string, including one that sorts after every other. A scan that lists a directory as a sorted range with a fixed upper bound can stop just before it. The file drops out of the key, and its edits replay stale output. Names like that are rare, but a key must cover every name.',
    from: ['inputs-property'],
    task: reads(['src/**'], '"src/￿.txt"'),
    files: { 'src/￿.txt': 'one\n' },
    changes: [[{ 'src/￿.txt': 'two\n' }, true, 'two\n']],
  }),

  defineCase({
    id: 'inputs/prefix-named-siblings',
    category: 'inputs',
    kind: 'efficiency',
    title: 'Projects named like `pkg-b`, `pkg.c` and `pkg0` keep their files out of `pkg`’s inputs',
    why: 'A project’s inputs stop at its own directory, and `pkg-b`, `pkg.c` and `pkg0` are other directories that only share a name prefix. A prefix match on paths pulls their files into `pkg`’s key. Edits in those projects then rerun `pkg` for nothing. Paths must be compared by whole segments, not by string prefix.',
    from: ['inputs-property', 'inputs-resolution'],
    workspace: {
      projects: {
        pkg: {
          tasks: { build: reads(['**'], 'src/a.txt') },
          files: { 'src/a.txt': 'a\n' },
        },
        'pkg-b': { files: { 'src/a.txt': 'b\n' } },
        'pkg.c': { files: { 'src/a.txt': 'c\n' } },
        pkg0: { files: { 'src/a.txt': '0\n' } },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      {
        write: {
          'packages/pkg-b/src/a.txt': 'b2\n',
          'packages/pkg.c/src/a.txt': 'c2\n',
          'packages/pkg0/src/a.txt': '02\n',
        },
      },
      { run: 'build', expect: { exit: 0, notRan: ['pkg#build'] } },
    ],
  }),

  defineCase({
    id: 'inputs/nested-project-prefix-sibling',
    category: 'inputs',
    kind: 'correctness',
    title:
      'A directory beside a nested project whose name extends the nested one’s stays the outer project’s input',
    why: 'Only a nested project’s own directory is cut out of the outer project. `inner-extra` merely starts with the nested project’s name, so it stays the outer project’s input. A prefix match cuts it out too, and edits there replay the outer task’s stale output.',
    from: ['inputs-resolution', 'inputs-property'],
    workspace: {
      projects: {
        outer: {
          dir: 'packages/outer',
          tasks: { build: reads(['**'], 'inner-extra/a.txt') },
          files: { 'inner-extra/a.txt': 'one\n' },
        },
        inner: {
          dir: 'packages/outer/inner',
          tasks: { build: { command: 'true', inputs: ['**'], outputs: [] } },
          files: { 'a.txt': 'i\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/outer/inner-extra/a.txt': 'two\n' } },
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['outer#build'],
          files: { 'packages/outer/dist/out.txt': 'two\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'inputs/nested-project-same-depth',
    category: 'inputs',
    kind: 'correctness',
    title: 'The outer project’s own directory beside a nested project stays its input',
    why: 'Cutting a nested project out of its parent must remove only that directory. `lib` sits at the same depth as `inner` and belongs to the outer project. A tool that drops more than the nested directory loses it from the key, and edits there replay stale output.',
    from: ['inputs-resolution'],
    workspace: {
      projects: {
        outer: {
          dir: 'packages/outer',
          tasks: { build: reads(['**'], 'lib/src/parent.txt') },
          files: { 'lib/src/parent.txt': 'one\n' },
        },
        inner: {
          dir: 'packages/outer/inner',
          tasks: { build: { command: 'true', inputs: ['**'], outputs: [] } },
          files: { 'src/nested.txt': 'i\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/outer/lib/src/parent.txt': 'two\n' } },
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['outer#build'],
          files: { 'packages/outer/dist/out.txt': 'two\n' },
        },
      },
    ],
  }),

  edits({
    id: 'inputs/gitignored-file-named',
    kind: 'correctness',
    title: 'A gitignored file named outright in the inputs is an input',
    why: 'A broad glob skips ignored files, but an entry that names one asks for it outright, and explicit config beats the default. Generated files are often both ignored and read by a build. Skipping a named file replays a result built from its old content. The user said the task reads it.',
    from: ['inputs-resolution'],
    task: reads(['src/**', 'generated.txt'], 'generated.txt'),
    files: { 'src/a.txt': 'a\n', 'generated.txt': 'one\n', '.gitignore': 'generated.txt\n' },
    changes: [[{ 'generated.txt': 'two\n' }, true, 'two\n']],
  }),

  edits({
    id: 'inputs/gitignored-directory-named',
    kind: 'correctness',
    title: 'A gitignored directory named outright in the inputs keys every file under it',
    why: 'A broad glob skips ignored files, but an entry that names an ignored directory asks for it and its whole tree. Generated output is often both ignored and read by the next task. Skipping it replays a result built from the old generated files. Explicit config beats the default.',
    from: ['inputs-resolution'],
    task: reads(['src/**', 'gen'], 'gen/out.js'),
    files: { 'src/a.txt': 'a\n', 'gen/out.js': 'one\n', '.gitignore': 'gen/\n' },
    changes: [[{ 'gen/out.js': 'two\n' }, true, 'two\n']],
  }),

  edits({
    id: 'inputs/named-directory-appears',
    kind: 'correctness',
    title: 'A file landing in a named input directory that did not exist runs the task again',
    why: 'A named input directory that does not exist yet is keyed as absent. A file landing in it changes what the task reads. A tool that keys a missing directory as nothing at all, the same before and after, replays output built without the new file. Absence is a fact the key must hold.',
    from: ['inputs-resolution'],
    task: {
      command: 'mkdir -p dist && (cat src/a.txt data/*.txt 2>/dev/null || true) > dist/out.txt',
      inputs: ['src/**', 'data'],
      outputs: ['dist/**'],
    },
    files: { 'src/a.txt': 'a\n' },
    changes: [[{ 'data/x.txt': 'x\n' }, true, 'a\nx\n']],
  }),

  edits({
    id: 'inputs/named-file-appears',
    kind: 'correctness',
    title: 'Creating a named input file that did not exist runs the task again',
    why: 'A named input file that does not exist is keyed as absent, not left out. Creating it changes what the task reads. If a missing file left no trace in the key, the new file would change nothing and the old output would replay. Optional config files, such as a local override, start absent like this.',
    from: ['inputs-resolution'],
    task: {
      command: 'mkdir -p dist && (cat src/a.txt extra.txt 2>/dev/null || true) > dist/out.txt',
      inputs: ['src/**', 'extra.txt'],
      outputs: ['dist/**'],
    },
    files: { 'src/a.txt': 'a\n' },
    changes: [[{ 'extra.txt': 'e\n' }, true, 'a\ne\n']],
  }),

  defineCase({
    id: 'inputs/glob-into-missing-directory',
    category: 'inputs',
    kind: 'correctness',
    title: 'Input globs into directories that do not exist are no error',
    why: 'Inputs describe what a task may read; a directory that does not exist yet, or a glob through a file, simply matches nothing. Optional and generated paths are common in real configs. Failing the run over them would break builds on a clean checkout for no gain.',
    from: ['inputs-resolution'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: reads(['src/**', 'gone/**', 'nonexistent/*/x.txt', 'src/a.txt/**'], 'src/a.txt'),
          },
          files: { 'src/a.txt': 'a\n' },
        },
      },
    },
    steps: [{ run: 'build', expect: { exit: 0, ran: ['a#build'], files: { [out('a')]: 'a\n' } } }],
  }),

  edits({
    id: 'inputs/glob-matching-directory',
    kind: 'efficiency',
    title: 'An input `fix*` keys the files it matches, not the tree of a directory it matches',
    why: 'A glob like `fix*` matches names; a directory it happens to match is not an input of its whole tree, unlike a directory named outright. The task reads `fix.txt`, not the fixtures beside it. Keying that tree reruns the task on fixture edits it never reads.',
    from: ['inputs-resolution'],
    task: reads(['fix*'], 'fix.txt'),
    files: { 'fix.txt': 'f\n', 'fixtures/a.txt': 'a\n' },
    changes: [[{ 'fixtures/a.txt': 'a2\n' }, false]],
  }),

  edits({
    id: 'inputs/two-globstars',
    kind: 'correctness',
    title: 'Each `**` in `src/**/x/**` spans any depth',
    why: 'Each `**` in a pattern matches any number of directories. `src/**/x/**` must reach a file under `src/d1/d2/x/y`. A tool that limits one of the globstars to a single level misses deep files, and edits there replay stale output. Deep source trees are common, so the match must not stop early.',
    from: ['inputs-resolution'],
    task: reads(['src/**/x/**'], 'src/d1/d2/x/y/f.txt'),
    files: { 'src/d1/d2/x/y/f.txt': 'one\n', 'src/deep/y/f.txt': 'y\n' },
    changes: [[{ 'src/d1/d2/x/y/f.txt': 'two\n' }, true, 'two\n']],
  }),

  edits({
    id: 'inputs/two-globstars-narrow',
    kind: 'efficiency',
    title: 'An input `src/**/x/**` does not key a file with no `x` directory above it',
    why: 'A pattern `src/**/x/**` requires an `x` directory somewhere in the path. A file with no `x` above it is not what the task reads. Matching it anyway, for example by collapsing the pattern to `src/**`, reruns the task on unrelated edits. The middle segment is what the user wrote to narrow the set.',
    from: ['inputs-resolution'],
    task: reads(['src/**/x/**'], 'src/d1/d2/x/y/f.txt'),
    files: { 'src/d1/d2/x/y/f.txt': 'one\n', 'src/deep/y/f.txt': 'y\n' },
    changes: [[{ 'src/deep/y/f.txt': 'y2\n' }, false]],
  }),

  defineCase({
    id: 'inputs/sibling-tasks-different-negations',
    category: 'inputs',
    kind: 'correctness',
    title: 'Two tasks of one project with different negations each key their own set',
    why: 'Inputs belong to a task, not a project: two tasks of one project can read different files. Here `lint` reads notes that `build` excludes. A tool that shares one task’s file set with the other leaves `lint` replaying output built from the old notes. Each task’s inputs are resolved on their own.',
    from: ['inputs-resolution'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: reads(['src/**', '!src/notes.md'], 'src/a.txt'),
            lint: {
              command: 'mkdir -p lint && cat src/notes.md > lint/out.txt',
              inputs: ['src/**'],
              outputs: ['lint/**'],
            },
          },
          files: { 'src/a.txt': 'a\n', 'src/notes.md': 'one\n', '.gitignore': 'lint/\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { run: 'lint', expect: { exit: 0 } },
      { write: { 'packages/a/src/notes.md': 'two\n' } },
      {
        run: 'lint',
        expect: { exit: 0, ran: ['a#lint'], files: { 'packages/a/lint/out.txt': 'two\n' } },
      },
    ],
  }),

  defineCase({
    id: 'inputs/sibling-task-negation-holds',
    category: 'inputs',
    kind: 'efficiency',
    title: 'A sibling task keying a file does not pull it into a task that takes it back',
    why: 'Inputs belong to a task, so a file one task reads does not become another’s input. `build` excludes the notes that `lint` reads. If file sets leaked between sibling tasks, every notes edit would rerun the build for nothing. The order the tasks run in must not matter either.',
    from: ['inputs-resolution'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: reads(['src/**', '!src/notes.md'], 'src/a.txt'),
            lint: {
              command: 'mkdir -p lint && cat src/notes.md > lint/out.txt',
              inputs: ['src/**'],
              outputs: ['lint/**'],
            },
          },
          files: { 'src/a.txt': 'a\n', 'src/notes.md': 'one\n', '.gitignore': 'lint/\n' },
        },
      },
    },
    steps: [
      { run: 'lint', expect: { exit: 0 } },
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/a/src/notes.md': 'two\n' } },
      { run: 'lint', expect: { exit: 0 } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
    ],
  }),
]
