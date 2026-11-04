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
  why?: string
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
    ...(c.why ? { why: c.why } : {}),
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
    from: ['brace-inputs'],
    task: reads(['{src/**,lib/**}'], 'src/deep/x.txt'),
    files: { 'src/top.txt': 't\n', 'src/deep/x.txt': 'x\n', 'lib/y.txt': 'y\n' },
    changes: [[{ 'src/deep/x.txt': 'x2\n' }, true, 'x2\n']],
  }),

  edits({
    id: 'inputs/brace-of-directories',
    kind: 'correctness',
    title: 'An input `{src,lib}` keys every file under both directories',
    from: ['brace-inputs'],
    task: reads(['{src,lib}'], 'src/deep/a.txt'),
    files: { 'src/deep/a.txt': 'a\n', 'lib/b.txt': 'b\n' },
    changes: [[{ 'src/deep/a.txt': 'a2\n' }, true, 'a2\n']],
  }),

  edits({
    id: 'inputs/brace-dot-slash-alternative',
    kind: 'correctness',
    title: 'An input `{./src,lib}/**` keys files under `src`',
    from: ['brace-inputs', 'dot-slash-globs'],
    task: reads(['{./src,lib}/**'], 'src/deep/a.txt'),
    files: { 'src/deep/a.txt': 'a\n', 'lib/b.txt': 'b\n' },
    changes: [[{ 'src/deep/a.txt': 'a2\n' }, true, 'a2\n']],
  }),

  edits({
    id: 'inputs/brace-dot-alternative',
    kind: 'correctness',
    title: 'An input `{.,src}/*.txt` keys a `.txt` file at the project’s top',
    from: ['brace-inputs'],
    task: reads(['{.,src}/*.txt'], 'a.txt'),
    files: { 'a.txt': 'a\n', 'src/b.txt': 'b\n' },
    changes: [[{ 'a.txt': 'a2\n' }, true, 'a2\n']],
  }),

  edits({
    id: 'inputs/brace-unnamed-file-ignored',
    kind: 'efficiency',
    title: 'A file no brace alternative names changes nothing',
    from: ['brace-inputs'],
    task: reads(['{src,lib}/**'], 'src/a.txt'),
    files: { 'src/a.txt': 'a\n', 'other/z.txt': 'z\n' },
    changes: [[{ 'other/z.txt': 'z2\n' }, false]],
  }),

  edits({
    id: 'inputs/brace-class-comma',
    kind: 'correctness',
    title: 'A `,` inside a class in a brace alternative is part of the name, not a cut',
    from: ['brace-inputs'],
    task: reads(['src/{a[,]b,x}.txt'], '"src/a,b.txt"'),
    files: { 'src/a,b.txt': 'ab\n', 'src/b.txt': 'b\n' },
    changes: [[{ 'src/a,b.txt': 'ab2\n' }, true, 'ab2\n']],
  }),

  edits({
    id: 'inputs/brace-class-open-brace',
    kind: 'correctness',
    title: 'A `{` inside a class in a brace alternative is part of the name',
    from: ['brace-inputs'],
    task: reads(['src/{a[{]b,x}.txt'], '"src/a{b.txt"'),
    files: { 'src/a{b.txt': 'ab\n', 'src/b.txt': 'b\n' },
    changes: [[{ 'src/a{b.txt': 'ab2\n' }, true, 'ab2\n']],
  }),

  edits({
    id: 'inputs/brace-class-comma-negated',
    kind: 'efficiency',
    title: 'A `!` brace alternative with a `,` in a class takes that file back',
    from: ['brace-inputs'],
    task: reads(['src/**', '!src/{a[,]b,x}.txt'], 'src/c.txt'),
    files: { 'src/c.txt': 'c\n', 'src/a,b.txt': 'ab\n' },
    changes: [[{ 'src/a,b.txt': 'ab2\n' }, false]],
  }),

  edits({
    id: 'inputs/escaped-brace-literal',
    kind: 'correctness',
    title: 'An input `src/\\{b\\}.txt` keys the file named with the braces',
    from: ['one-alternative-brace'],
    task: reads(['src/\\{b\\}.txt'], '"src/{b}.txt"'),
    files: { 'src/{b}.txt': 'braces\n', 'src/b.txt': 'b\n' },
    changes: [[{ 'src/{b}.txt': 'braces2\n' }, true, 'braces2\n']],
  }),

  edits({
    id: 'inputs/escaped-brace-not-alternative',
    kind: 'efficiency',
    title: 'An input `src/\\{b\\}.txt` does not key `src/b.txt`',
    from: ['one-alternative-brace'],
    task: reads(['src/\\{b\\}.txt'], '"src/{b}.txt"'),
    files: { 'src/{b}.txt': 'braces\n', 'src/b.txt': 'b\n' },
    changes: [[{ 'src/b.txt': 'b2\n' }, false]],
  }),

  edits({
    id: 'inputs/dot-slash-input',
    kind: 'correctness',
    title: 'An input written `./src/**` keys the files under `src`',
    from: ['dot-slash-globs'],
    task: reads(['./src/**'], 'src/a.txt'),
    files: { 'src/a.txt': 'a\n' },
    changes: [[{ 'src/a.txt': 'a2\n' }, true, 'a2\n']],
  }),

  edits({
    id: 'inputs/dot-slash-negation',
    kind: 'efficiency',
    title: 'A negation written `!./gen/**` takes `gen` back out of the inputs',
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
    from: ['dot-slash-globs'],
    task: reads(['*/.', '!gen/.', '!dist/**'], 'src/a.txt gen/g.txt'),
    files: { 'src/a.txt': 'a\n', 'gen/g.txt': 'g\n' },
    changes: [[{ 'src/a.txt': 'a2\n' }, true, 'a2\ng\n']],
  }),

  edits({
    id: 'inputs/trailing-dot-negation',
    kind: 'efficiency',
    title: 'A negation `!gen/.` takes the whole `gen` tree back',
    from: ['dot-slash-globs'],
    task: reads(['*/.', '!gen/.', '!dist/**'], 'src/a.txt gen/g.txt'),
    files: { 'src/a.txt': 'a\n', 'gen/g.txt': 'g\n' },
    changes: [[{ 'gen/g.txt': 'g2\n' }, false]],
  }),

  edits({
    id: 'inputs/trailing-slash-pattern',
    kind: 'correctness',
    title: 'An input `src/**/` (a trailing slash) keys the files under `src`',
    from: ['dot-slash-globs'],
    task: reads(['src/**/'], 'src/a.txt'),
    files: { 'src/a.txt': 'a\n' },
    changes: [[{ 'src/a.txt': 'a2\n' }, true, 'a2\n']],
  }),

  edits({
    id: 'inputs/literal-directory',
    kind: 'correctness',
    title: 'An input naming a directory, `src`, keys every file in its tree',
    from: ['inputs-resolution'],
    task: reads(['src'], 'src/deep/b.txt'),
    files: { 'src/a.txt': 'a\n', 'src/deep/b.txt': 'b\n' },
    changes: [[{ 'src/deep/b.txt': 'b2\n' }, true, 'b2\n']],
  }),

  edits({
    id: 'inputs/literal-directory-trailing-slash',
    kind: 'correctness',
    title: 'An input naming a directory with a trailing slash, `src/`, keys its tree',
    why: 'The most common Turbo spelling; read as a bare glob it matches no file and the key never moves.',
    from: ['inputs-resolution', 'dot-slash-globs'],
    task: reads(['src/'], 'src/deep/b.txt'),
    files: { 'src/a.txt': 'a\n', 'src/deep/b.txt': 'b\n' },
    changes: [[{ 'src/deep/b.txt': 'b2\n' }, true, 'b2\n']],
  }),

  edits({
    id: 'inputs/negated-literal-directory',
    kind: 'efficiency',
    title: 'A negation naming a directory, `!gen`, takes its whole tree back',
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
    from: ['task-glob-brackets'],
    task: reads(['app/[ab]/*.js'], 'app/b/x.js'),
    files: { 'app/a/x.js': 'a\n', 'app/b/x.js': 'b\n', 'app/c/x.js': 'c\n' },
    changes: [[{ 'app/b/x.js': 'b2\n' }, true, 'b2\n']],
  }),

  edits({
    id: 'inputs/bracket-class-excludes',
    kind: 'efficiency',
    title: 'An input `app/[ab]/*.js` does not key a directory the class leaves out',
    from: ['task-glob-brackets'],
    task: reads(['app/[ab]/*.js'], 'app/b/x.js'),
    files: { 'app/a/x.js': 'a\n', 'app/b/x.js': 'b\n', 'app/c/x.js': 'c\n' },
    changes: [[{ 'app/c/x.js': 'c2\n' }, false]],
  }),

  edits({
    id: 'inputs/escaped-route-directory',
    kind: 'correctness',
    title: 'An input `app/\\[id\\]/**` keys the route directory named `[id]`',
    why: 'Read as a class it matches `app/i/…` and never the route, so an edit to the route replays the old output.',
    from: ['task-glob-brackets', 'inputs-property'],
    task: reads(['app/\\[id\\]/**'], '"app/[id]/page.js"'),
    files: { 'app/[id]/page.js': 'v1\n' },
    changes: [[{ 'app/[id]/page.js': 'v2\n' }, true, 'v2\n']],
  }),

  edits({
    id: 'inputs/escaped-route-not-class',
    kind: 'efficiency',
    title: 'An input `app/\\[id\\]/*.js` does not key the sibling `app/i` a class would match',
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
    why: 'Inputs are a set, not an ordered gitignore: the position of a negation carries no meaning.',
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
    why: 'Keying a task on what it wrote moves its key after every run, so it never replays.',
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
    why: 'An install is untracked; a committed test fixture under `node_modules` is source.',
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
    from: ['inputs-resolution', 'inputs-property'],
    task: reads(['**'], '.github/ci.yml'),
    files: { '.github/ci.yml': 'one\n' },
    changes: [[{ '.github/ci.yml': 'two\n' }, true, 'two\n']],
  }),

  edits({
    id: 'inputs/dotfile-input',
    kind: 'correctness',
    title: 'A dotfile under an input glob (`src/.env`) is an input',
    from: ['inputs-property', 'inputs-resolution'],
    task: reads(['src/**'], 'src/.env'),
    files: { 'src/.env': 'one\n' },
    changes: [[{ 'src/.env': 'two\n' }, true, 'two\n']],
  }),

  edits({
    id: 'inputs/tracked-build-state',
    kind: 'correctness',
    title: 'A committed `tsconfig.tsbuildinfo` is an input of `**`',
    why: 'A build-state file is ignored only when the repository ignores it; committed, it is source.',
    from: ['inputs-resolution'],
    task: reads(['**'], 'tsconfig.tsbuildinfo'),
    files: { 'tsconfig.tsbuildinfo': 'one\n' },
    changes: [[{ 'tsconfig.tsbuildinfo': 'two\n' }, true, 'two\n']],
  }),

  edits({
    id: 'inputs/highest-sorting-name',
    kind: 'correctness',
    title: 'A file whose name sorts after every other is still an input',
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
    why: 'A broad glob skips ignored files; an entry that names one asks for it, and skipping it replays a stale result.',
    from: ['inputs-resolution'],
    task: reads(['src/**', 'generated.txt'], 'generated.txt'),
    files: { 'src/a.txt': 'a\n', 'generated.txt': 'one\n', '.gitignore': 'generated.txt\n' },
    changes: [[{ 'generated.txt': 'two\n' }, true, 'two\n']],
  }),

  edits({
    id: 'inputs/gitignored-directory-named',
    kind: 'correctness',
    title: 'A gitignored directory named outright in the inputs keys every file under it',
    why: 'A broad glob skips ignored files; an entry that names the directory asks for it.',
    from: ['inputs-resolution'],
    task: reads(['src/**', 'gen'], 'gen/out.js'),
    files: { 'src/a.txt': 'a\n', 'gen/out.js': 'one\n', '.gitignore': 'gen/\n' },
    changes: [[{ 'gen/out.js': 'two\n' }, true, 'two\n']],
  }),

  edits({
    id: 'inputs/named-directory-appears',
    kind: 'correctness',
    title: 'A file landing in a named input directory that did not exist runs the task again',
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
    from: ['inputs-resolution'],
    task: reads(['fix*'], 'fix.txt'),
    files: { 'fix.txt': 'f\n', 'fixtures/a.txt': 'a\n' },
    changes: [[{ 'fixtures/a.txt': 'a2\n' }, false]],
  }),

  edits({
    id: 'inputs/two-globstars',
    kind: 'correctness',
    title: 'Each `**` in `src/**/x/**` spans any depth',
    from: ['inputs-resolution'],
    task: reads(['src/**/x/**'], 'src/d1/d2/x/y/f.txt'),
    files: { 'src/d1/d2/x/y/f.txt': 'one\n', 'src/deep/y/f.txt': 'y\n' },
    changes: [[{ 'src/d1/d2/x/y/f.txt': 'two\n' }, true, 'two\n']],
  }),

  edits({
    id: 'inputs/two-globstars-narrow',
    kind: 'efficiency',
    title: 'An input `src/**/x/**` does not key a file with no `x` directory above it',
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
