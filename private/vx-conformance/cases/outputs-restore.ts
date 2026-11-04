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
    why: 'A cache hit should leave the same tree a fresh run leaves, empty directories included. Later steps often expect those directories to exist, such as a server that writes uploads into `dist/empty` or a packager that copies the tree as is. If a hit drops them, the build passes on the machine that ran it and fails on every machine that replayed it.',
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
    why: 'Removing one empty directory from the outputs changes the tree the task is meant to leave, so the next run must put it back. A tool that compares only files sees nothing missing and reports the task as current. Whatever relies on that directory then fails, though the run said every output was in place.',
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
    why: 'Output patterns say exactly what a task owns, and a hit restores only that. Here the pattern is `dist/*.txt`, which matches files, not the empty directory beside them. A tool that brings back everything the task left on disk restores paths the config never claimed, and can overwrite what another step put there. Explicit config beats what the tool saw on disk.',
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
    why: 'A directory the task left empty is part of its outputs, so a file dropped into it is a stray. If the next run keeps it, the stray ships with the build: a leftover bundle, an old secret, a test fixture. The tree after a run should be the same whether or not someone touched it in between. The empty directory itself stays, since the task made it.',
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
    why: 'A cache entry should hold what the task made, not whatever an older build left in the output folder. These empty directories predate the run, so an entry that holds them recreates them on every hit, on every machine. Old layouts then come back long after the code that made them is gone.',
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
    why: 'A hit should leave the tree exactly as the task makes it, and a stray empty directory is not part of that. Left in place, it changes what a later step sees, such as a packager that ships every folder or a glob that now matches. The directories the task did make stay; only the leftover goes.',
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
    why: 'When something blocks an output path, the run must still end with the file the task makes. Here a directory stands where `dist/real.txt` belongs. A tool that cannot replace it either fails a build that should pass, or keeps the directory and reports success. Either way the tree is not what the task wrote.',
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
    why: 'Directory modes are part of what a task produces, so a hit must bring them back. A `chmod 700 dist/keys` restored as 0755 lets every user on the machine read what the task kept private. A 0555 directory restored writable lets a later step change files meant to stay fixed. A fresh run and a hit should leave the same permissions.',
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
    why: 'Directory modes must come back however big the outputs are. A cache may store small and large files by different paths, for example inline or as a separate blob, and one of those paths can drop the modes. The developer then finds a private directory readable only on builds that hold a large file. The result should not depend on file size.',
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
    why: 'When a restore remakes only part of a tree, the directories it recreates need the same modes a full run gives them. Here `dist/keys` was deleted and must come back as 0700. A tool that recreates it with default permissions exposes the key file inside it. A partial repair should leave the same tree as a full one.',
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
    why: 'An edited output must be put back even when it sits in a directory the task made read-only. Writing there means opening the directory for a moment and closing it again. A tool that skips the file leaves the hand edit in a build marked current; one that leaves the directory writable undoes a mode the task chose. Both the bytes and the mode must end as the task left them.',
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
    why: 'A restore must be able to write into a read-only directory the task made, and leave it read-only after. Failing with a permission error turns a cached build red for no reason. Opening the directory and forgetting to close it changes a mode the task set on purpose. The result should match a fresh run.',
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
    why: 'Every run must check the outputs against what the task makes, even right after a hit judged them current. A file added after that hit is not part of the cache entry. A tool that trusts its last look skips the check and ships the stray with the next build. Checking the tree on each run is what keeps a hit honest.',
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
    why: 'A brace pattern like `{dist,lib/esm}/**` names exactly two trees, and a hit restores those two and nothing else. Missing one leaves half a package behind a green run. Restoring `lib/cjs`, which the pattern does not name, brings back files the config never claimed. The pattern is the contract, read the way a shell reads it.',
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
      [
        'brace-of-dir-names',
        '{dist,lib}',
        'A brace of two directory names restores both trees',
        'A pattern naming a directory means everything under it, and a brace of two names means both trees. A tool that matches only the directory entries, or only the first alternative, restores empty folders or half the outputs. The hit is green while the build is missing files. This short spelling must cache the same as the long form `{dist,lib}/**`.',
      ],
      [
        'brace-with-dot-slash',
        '{./dist,lib}/**',
        'A brace whose alternative starts with ./ restores both trees',
        '`./dist` and `dist` name the same directory, inside a brace as anywhere else. A tool that treats the `./` alternative as a literal name finds nothing and leaves that tree out of the cache. The build then replays with `dist` missing under a green run. A harmless spelling difference should not change what is cached.',
      ],
    ] as const
  ).map(([slug, glob, title, why]) =>
    defineCase({
      id: `outputs/${slug}`,
      category: 'outputs',
      kind: 'correctness',
      title,
      why,
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
    why: 'When two output patterns cover parts of one directory, a hit restores what either one matches. That includes dotfiles and empty directories under `out/d3/**`, which glob code often skips, and excludes `out/d1/.hid/x`, which neither pattern names. Restoring less leaves a broken build behind a green run; restoring more brings back files nobody claimed.',
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
    why: '`**/*.js` means the build’s own JavaScript, not the packages installed beside it. A clean or restore that reaches into node_modules deletes or reverts installed code, here a local patch to a dependency. The next build or test then runs against packages the developer never chose. Installed packages are local state unless a task names them.',
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
    why: 'When a task names node_modules as its output, that is explicit config, and it beats any default that skips the folder. An install task cached this way should get its packages back on a hit. A tool that silently drops the pattern replays a green install with nothing installed, and the next task fails. Skipping node_modules is right only when nobody asked for it.',
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
    why: 'A task that declares no outputs has said it leaves nothing worth keeping, so a hit restores nothing. Here the task writes `dist/out.txt` anyway, and a replay must not bring it back. Storing files the config never named means guessing what a task owns, which can replay stale bytes over files another step wrote. If the file matters, the fix is to declare it.',
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
    why: 'A task with declared inputs and no outputs, such as a lint or a type check, is still worth caching. Its result is its exit code and log, and both are known for an unchanged tree. Running it again spends minutes on every build for an answer already known. Having no outputs means nothing to restore, not nothing to cache.',
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
    why: 'An output edited by hand must be noticed even when the new bytes have the same length. A check of size alone, or an mtime with one-second resolution, sees an unchanged file and keeps the edit. The build then ships content no run of the task produced, under a green result. Comparing content avoids this.',
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
    why: 'Some builds pin every output mtime for reproducible archives, so two different builds can share size and mtime. Going back to earlier sources must restore that earlier build’s bytes. A tool that judges the outputs current from size and mtime keeps the newer build’s output, so the tree no longer matches its sources. Only the bytes tell the two builds apart.',
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
    why: 'File modes are part of the output, so a mode changed by hand must be put back. Here the task makes `dist/out.txt` 0644 and someone marks it executable. A tool that compares only bytes calls the tree current and ships the wrong mode. Packages and deploy steps can act on the executable bit, so the run must leave the mode the task set.',
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
    why: 'Files like `.gitkeep` and `.gitignore` inside the outputs are the task’s own files, and a hit must restore them. A tool that skips git-looking names leaves them out of the cache. The replayed tree then differs from a fresh run: an empty folder drops out of a package, or an ignore rule a later step relied on is gone. The patterns decide what is an output, not the names.',
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
    why: 'Only the workspace’s own `.git` is git’s metadata; a `.git` directory under `dist` is just files the task wrote. A tool that skips every `.git` leaves it out of the cache, so a hit comes back without it. Tasks that build a repo fixture or a checkout then fail after a replay but pass after a run. The output patterns decide what is kept, not the name.',
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
