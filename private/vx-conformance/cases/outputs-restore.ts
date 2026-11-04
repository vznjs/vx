// What a hit leaves on disk: empty directories, directory modes, strays,
// brace and multi-root output globs, and rewrites a size-and-mtime probe
// cannot see.
import { defineCase, type TaskSpec } from '../src/spec.ts'
import { CONCAT, one, out } from './shapes.ts'

const cached: TaskSpec = { command: CONCAT, inputs: ['src/**'], outputs: ['dist/**'] }
const A = 'packages/a'

/** A build that leaves two empty directories beside one file. */
const emptyDirs = (outputs: string[]): TaskSpec => ({
  command: 'rm -rf dist && mkdir -p dist/empty dist/a/b && echo real > dist/real.txt',
  inputs: ['src/**'],
  outputs,
})

/** A build that leaves directories 0700 and 0555 under dist. */
const modes = (extra = ''): TaskSpec => ({
  command:
    'mkdir -p dist/keys dist/ro dist/empty dist/open && echo k > dist/keys/id && ' +
    `echo r > dist/ro/f && echo o > dist/open/f${extra} && ` +
    'chmod 700 dist/keys dist/empty && chmod 555 dist/ro',
  inputs: ['src/**'],
  outputs: ['dist/**'],
})
const MODES = { [`${A}/dist/keys`]: 0o700, [`${A}/dist/ro`]: 0o555, [`${A}/dist/empty`]: 0o700 }
/** `dist/ro` is 0555: opened before anything removes the tree under it. */
const openRo = { chmod: { [`${A}/dist/ro`]: 0o755 } }

export const outputsRestore = [
  defineCase({
    id: 'outputs/empty-dirs-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'Empty directories a task leaves under its outputs come back with a hit',
    why: 'A hit must leave the tree a run leaves; a tool that globs for a directory finds none.',
    from: ['output-empty-dir'],
    workspace: one(emptyDirs(['dist/**'])),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/dist`]: null } },
      {
        run: 'build',
        expect: { exit: 0, notRan: ['a#build'], files: { [`${A}/dist/real.txt`]: 'real\n' } },
      },
      { check: { dirs: [`${A}/dist/empty`, `${A}/dist/a/b`] } },
    ],
  }),

  defineCase({
    id: 'outputs/empty-dir-removed-alone-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'An empty output directory removed on its own comes back on the next run',
    from: ['output-empty-dir'],
    workspace: one(emptyDirs(['dist/**'])),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/dist/empty`]: null } },
      { run: 'build', expect: { exit: 0 } },
      { check: { dirs: [`${A}/dist/empty`] } },
    ],
  }),

  defineCase({
    id: 'outputs/empty-dir-outside-glob-not-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'An empty directory no output pattern reaches is not brought back by a hit',
    from: ['output-empty-dir'],
    workspace: one(emptyDirs(['dist/*.txt'])),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/dist`]: null } },
      {
        run: 'build',
        expect: { exit: 0, notRan: ['a#build'], files: { [`${A}/dist/real.txt`]: 'real\n' } },
      },
      { check: { missing: [`${A}/dist/empty`] } },
    ],
  }),

  defineCase({
    id: 'outputs/stale-file-in-empty-output-dir',
    category: 'outputs',
    kind: 'correctness',
    title: 'A file dropped into an output directory the task left empty is gone after the next run',
    from: ['output-empty-dir'],
    workspace: one(emptyDirs(['dist/**'])),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/dist/empty/stale.txt`]: 'x\n' } },
      { run: 'build', expect: { exit: 0, files: { [`${A}/dist/empty/stale.txt`]: null } } },
      { check: { dirs: [`${A}/dist/empty`] } },
    ],
  }),

  defineCase({
    id: 'outputs/old-empty-dirs-not-cached',
    category: 'outputs',
    kind: 'correctness',
    title: 'Empty directories an older build left in the outputs do not come back with a hit',
    why: 'The task did not make them; an entry that holds them recreates them on every hit.',
    from: ['output-empty-dir'],
    workspace: one({
      command: 'mkdir -p dist && cp src/a.txt dist/real.txt',
      inputs: ['src/**'],
      outputs: ['dist/**'],
    }),
    steps: [
      { write: { [`${A}/dist/old/inner/x`]: '', [`${A}/dist/gone/x`]: '' } },
      { write: { [`${A}/dist/old/inner/x`]: null, [`${A}/dist/gone/x`]: null } },
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/dist`]: null } },
      {
        run: 'build',
        expect: { exit: 0, notRan: ['a#build'], files: { [`${A}/dist/real.txt`]: 'a\n' } },
      },
      { check: { missing: [`${A}/dist/old`, `${A}/dist/gone`] } },
    ],
  }),

  defineCase({
    id: 'outputs/stray-empty-dir-removed',
    category: 'outputs',
    kind: 'correctness',
    title: 'A stray empty directory under the outputs is gone after a hit',
    from: ['output-empty-dir'],
    workspace: one(emptyDirs(['dist/**'])),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/dist/stray/inner/x`]: '' } },
      { write: { [`${A}/dist/stray/inner/x`]: null } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
      { check: { missing: [`${A}/dist/stray`], dirs: [`${A}/dist/empty`, `${A}/dist/a/b`] } },
    ],
  }),

  defineCase({
    id: 'outputs/dir-where-file-belongs',
    category: 'outputs',
    kind: 'correctness',
    title: 'A directory standing where an output file belongs is replaced by the file',
    from: ['output-empty-dir', 'restore-dir-target'],
    workspace: one(emptyDirs(['dist/**'])),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/dist/real.txt`]: null } },
      { write: { [`${A}/dist/real.txt/x`]: '' } },
      { write: { [`${A}/dist/real.txt/x`]: null } },
      { run: 'build', expect: { exit: 0, files: { [`${A}/dist/real.txt`]: 'real\n' } } },
    ],
  }),

  defineCase({
    id: 'outputs/dir-modes-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'Output directories come back with the modes the task gave them',
    why: 'A `chmod 700 dist/keys` restored 0755 lets every user read what the task kept private.',
    from: ['restore-dir-mode'],
    workspace: one(modes()),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { check: { modes: MODES } },
      openRo,
      { write: { [`${A}/dist`]: null } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
      { check: { modes: MODES } },
      openRo,
    ],
  }),

  defineCase({
    id: 'outputs/dir-modes-restored-large',
    category: 'outputs',
    kind: 'correctness',
    title: 'Output directory modes come back when the outputs hold a large file too',
    from: ['restore-dir-mode'],
    workspace: one(modes(' && head -c 100000 /dev/zero > dist/open/big')),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      openRo,
      { write: { [`${A}/dist`]: null } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
      { check: { modes: MODES } },
      openRo,
    ],
  }),

  defineCase({
    id: 'outputs/dir-modes-partial-restore',
    category: 'outputs',
    kind: 'correctness',
    title: 'Restoring into a partly deleted tree gives the directories it remakes their modes',
    from: ['restore-dir-mode'],
    workspace: one(modes()),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/dist/keys`]: null, [`${A}/dist/open/f`]: 'changed\n' } },
      {
        run: 'build',
        expect: {
          exit: 0,
          files: { [`${A}/dist/open/f`]: 'o\n', [`${A}/dist/keys/id`]: 'k\n' },
        },
      },
      { check: { modes: MODES } },
      openRo,
    ],
  }),

  defineCase({
    id: 'outputs/file-in-read-only-dir-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'An edited output inside a read-only output directory is put back, and the mode kept',
    from: ['restore-dir-mode'],
    workspace: one(modes()),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/dist/ro/f`]: 'edited\n' } },
      { run: 'build', expect: { exit: 0, files: { [`${A}/dist/ro/f`]: 'r\n' } } },
      { check: { modes: MODES } },
      openRo,
    ],
  }),

  defineCase({
    id: 'outputs/restore-into-read-only-dir',
    category: 'outputs',
    kind: 'correctness',
    title: 'A restore writes into an emptied read-only output directory and leaves it read-only',
    from: ['restore-dir-mode'],
    workspace: one(modes()),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      openRo,
      {
        write: {
          [`${A}/dist/keys`]: null,
          [`${A}/dist/empty`]: null,
          [`${A}/dist/open`]: null,
          [`${A}/dist/ro/f`]: null,
        },
      },
      { chmod: { [`${A}/dist/ro`]: 0o555 } },
      { run: 'build', expect: { exit: 0, files: { [`${A}/dist/ro/f`]: 'r\n' } } },
      { check: { modes: MODES } },
      openRo,
    ],
  }),

  defineCase({
    id: 'outputs/stray-after-hit-removed',
    category: 'outputs',
    kind: 'correctness',
    title: 'A stray file added after a hit is gone after the next hit',
    why: 'A tree judged current once must still be checked again: the stray is not the entry’s.',
    from: ['hit-snapshot-stray'],
    workspace: one(cached),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/dist/stray.txt`]: 'stray' } },
      {
        run: 'build',
        expect: { exit: 0, files: { [out('a')]: 'a\n', [`${A}/dist/stray.txt`]: null } },
      },
    ],
  }),

  defineCase({
    id: 'outputs/brace-over-two-dirs',
    category: 'outputs',
    kind: 'correctness',
    title: 'A brace output pattern over two directories restores both, and nothing beside them',
    from: ['brace-outputs'],
    workspace: one({
      command:
        'mkdir -p dist lib/esm lib/cjs && echo a > dist/a.js && echo b > lib/esm/b.js && echo c > lib/cjs/c.js',
      inputs: ['src/**'],
      outputs: ['{dist,lib/esm}/**'],
    }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/dist`]: null, [`${A}/lib`]: null } },
      {
        run: 'build',
        expect: {
          exit: 0,
          notRan: ['a#build'],
          files: {
            [`${A}/dist/a.js`]: 'a\n',
            [`${A}/lib/esm/b.js`]: 'b\n',
            [`${A}/lib/cjs/c.js`]: null,
          },
        },
      },
    ],
  }),

  ...(
    [
      ['brace-of-dir-names', '{dist,lib}', 'A brace of two directory names restores both trees'],
      [
        'brace-with-dot-slash',
        '{./dist,lib}/**',
        'A brace whose alternative starts with ./ restores both trees',
      ],
    ] as const
  ).map(([slug, glob, title]) =>
    defineCase({
      id: `outputs/${slug}`,
      category: 'outputs',
      kind: 'correctness',
      title,
      from: ['brace-outputs'],
      workspace: one({
        command: 'mkdir -p dist/sub lib && echo a > dist/sub/a.js && echo b > lib/b.js',
        inputs: ['src/**'],
        outputs: [glob],
      }),
      steps: [
        { run: 'build', expect: { exit: 0 } },
        { write: { [`${A}/dist`]: null, [`${A}/lib`]: null } },
        {
          run: 'build',
          expect: {
            exit: 0,
            notRan: ['a#build'],
            files: { [`${A}/dist/sub/a.js`]: 'a\n', [`${A}/lib/b.js`]: 'b\n' },
          },
        },
      ],
    }),
  ),

  defineCase({
    id: 'outputs/two-patterns-one-tree',
    category: 'outputs',
    kind: 'correctness',
    title:
      'Two output patterns under one directory restore what each matches: dotfiles and empty directories too, and nothing else',
    from: ['output-scan-root'],
    workspace: one({
      command:
        'for i in 1 2 3; do mkdir -p out/d$i/.hid && echo v$i > out/d$i/v.js && echo h$i > out/d$i/.hid/x; done && mkdir -p out/d3/empty',
      inputs: ['src/**'],
      outputs: ['out/d3/**', 'out/*/v.js'],
    }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/out`]: null } },
      {
        run: 'build',
        expect: {
          exit: 0,
          notRan: ['a#build'],
          files: {
            [`${A}/out/d1/v.js`]: 'v1\n',
            [`${A}/out/d2/v.js`]: 'v2\n',
            [`${A}/out/d3/v.js`]: 'v3\n',
            [`${A}/out/d3/.hid/x`]: 'h3\n',
            [`${A}/out/d1/.hid/x`]: null,
          },
        },
      },
      { check: { dirs: [`${A}/out/d3/empty`] } },
    ],
  }),

  defineCase({
    id: 'outputs/wide-glob-spares-node-modules',
    category: 'outputs',
    kind: 'correctness',
    title: 'A `**/*.js` output leaves installed packages under node_modules alone',
    why: '`**/*.js` means the build’s files; a clean or restore that reaches node_modules deletes or reverts installed code.',
    from: ['output-reach'],
    workspace: one(
      {
        command: 'mkdir -p dist lib && cat src/a.txt > dist/a.js && echo b > lib/b.js',
        inputs: ['src/*.txt'],
        outputs: ['**/*.js'],
      },
      {
        'src/a.txt': 'a\n',
        'node_modules/dep/index.js': 'dep\n',
        'src/node_modules/x.js': 'x\n',
      },
    ),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/node_modules/dep/index.js`]: 'mine\n', [`${A}/src/a.txt`]: 'b\n' } },
      {
        run: 'build',
        expect: {
          exit: 0,
          files: {
            [`${A}/dist/a.js`]: 'b\n',
            [`${A}/node_modules/dep/index.js`]: 'mine\n',
            [`${A}/src/node_modules/x.js`]: 'x\n',
          },
        },
      },
      { write: { [`${A}/src/a.txt`]: 'a\n' } },
      {
        run: 'build',
        expect: {
          exit: 0,
          files: {
            [`${A}/dist/a.js`]: 'a\n',
            [`${A}/node_modules/dep/index.js`]: 'mine\n',
            [`${A}/src/node_modules/x.js`]: 'x\n',
          },
        },
      },
    ],
  }),

  defineCase({
    id: 'outputs/named-node-modules-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'An install task that names node_modules as its output gets it restored',
    from: ['output-reach', 'output-wipe-guard'],
    workspace: one({
      command: 'mkdir -p node_modules/dep && cat src/a.txt > node_modules/dep/index.js',
      inputs: ['src/**'],
      outputs: ['node_modules/**'],
    }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/node_modules`]: null } },
      {
        run: 'build',
        expect: {
          exit: 0,
          notRan: ['a#build'],
          files: { [`${A}/node_modules/dep/index.js`]: 'a\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'outputs/declared-none-restores-nothing',
    category: 'outputs',
    kind: 'correctness',
    title: 'A replayed task that declares no outputs brings back none of the files it wrote',
    from: ['no-output-hit', 'restore-declared-only'],
    workspace: one({
      command: 'mkdir -p dist && echo built > dist/out.txt',
      inputs: ['src/**'],
      outputs: [],
    }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/dist`]: null } },
      {
        run: 'build',
        expect: { exit: 0, ifReplayed: { task: 'a#build', files: { [out('a')]: null } } },
      },
    ],
  }),

  defineCase({
    id: 'outputs/declared-none-replays',
    category: 'outputs',
    kind: 'efficiency',
    title: 'A task that declares no outputs still replays on an unchanged tree',
    from: ['no-output-hit'],
    workspace: one({ command: 'echo checked', inputs: ['src/**'], outputs: [] }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
    ],
  }),

  defineCase({
    id: 'outputs/same-size-rewrite-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'An output rewritten by hand to bytes of the same length is put back',
    why: 'A size check alone, or a one-second mtime, sees an unchanged file.',
    from: ['cache'],
    workspace: one(cached),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [out('a')]: 'b\n' } },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'a\n' } } },
    ],
  }),

  defineCase({
    id: 'outputs/fixed-mtime-round-trip',
    category: 'outputs',
    kind: 'correctness',
    title:
      'Going back to earlier sources restores that build’s output when the task pins every mtime',
    why: 'Two builds whose outputs share size and mtime are told apart by their bytes, not their stamps.',
    from: ['cache'],
    workspace: one(
      {
        command:
          'mkdir -p dist && cat src/a.txt > dist/out.txt && touch -t 200101010000 dist/out.txt',
        inputs: ['src/**'],
        outputs: ['dist/**'],
      },
      { 'src/a.txt': 'one1\n' },
    ),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/src/a.txt`]: 'two2\n' } },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'two2\n' } } },
      { write: { [`${A}/src/a.txt`]: 'one1\n' } },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'one1\n' } } },
    ],
  }),

  defineCase({
    id: 'outputs/mode-only-change-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'An output made executable by hand comes back with the mode the task gave it',
    from: ['cache'],
    workspace: one({
      command: 'mkdir -p dist && cat src/a.txt > dist/out.txt && chmod 644 dist/out.txt',
      inputs: ['src/**'],
      outputs: ['dist/**'],
    }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { chmod: { [out('a')]: 0o755 } },
      { run: 'build', expect: { exit: 0 } },
      { check: { modes: { [out('a')]: 0o644 } } },
    ],
  }),

  defineCase({
    id: 'outputs/dotfiles-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'Output files named like git’s own (.gitkeep, .gitignore) restore',
    from: ['restore-link-git'],
    workspace: one({
      command:
        'mkdir -p dist/h && cat src/a.txt > dist/a.txt && echo k > dist/.gitkeep && echo i > dist/h/.gitignore',
      inputs: ['src/**'],
      outputs: ['dist/**'],
    }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/dist`]: null } },
      {
        run: 'build',
        expect: {
          exit: 0,
          notRan: ['a#build'],
          files: {
            [`${A}/dist/a.txt`]: 'a\n',
            [`${A}/dist/.gitkeep`]: 'k\n',
            [`${A}/dist/h/.gitignore`]: 'i\n',
          },
        },
      },
    ],
  }),

  defineCase({
    id: 'outputs/nested-dot-git-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'A `.git` directory a task writes inside its outputs restores where it stands',
    why: 'Only the workspace’s own .git is git’s metadata; one under dist is the task’s output.',
    from: ['restore-link-git'],
    workspace: one({
      command:
        'mkdir -p dist/sub/.git && cat src/a.txt > dist/a.txt && echo nested > dist/sub/.git/config',
      inputs: ['src/**'],
      outputs: ['dist/**'],
    }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/dist`]: null } },
      {
        run: 'build',
        expect: {
          exit: 0,
          notRan: ['a#build'],
          files: { [`${A}/dist/a.txt`]: 'a\n', [`${A}/dist/sub/.git/config`]: 'nested\n' },
        },
      },
    ],
  }),
]
