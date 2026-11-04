import { defineCase } from '../src/spec.ts'
import { CONCAT, fourProjects, one, out } from './shapes.ts'

const cached = { command: CONCAT, inputs: ['src/**'], outputs: ['dist/**'] }

export default [
  defineCase({
    id: 'outputs/restored-on-hit',
    category: 'outputs',
    kind: 'correctness',
    title: 'Deleted outputs come back from the cache with the same bytes',
    why: 'A cache hit stands in for running the command, so it must leave the files the command would have left. If deleted outputs are not restored, the run is green but `dist` is empty, and the next step, a deploy or a test, reads nothing or fails far from the cause. The bytes must match exactly, or a hit ships something no build produced.',
    from: ['parity-turbo', 'parity-nx', 'restore-in-place'],
    workspace: one(cached),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/a/dist': null } },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'a\n' } } },
    ],
  }),

  defineCase({
    id: 'outputs/restored-on-hit-without-rerun',
    category: 'outputs',
    kind: 'efficiency',
    title: 'Deleted outputs are restored, not rebuilt',
    why: 'Deleted outputs with unchanged inputs are the normal state after a fresh clone or a clean. The cache holds the exact bytes the command made, so restoring them is enough. Rerunning the command instead spends its full time on every fresh CI machine, which is the work a cache exists to save.',
    from: ['parity-turbo', 'restore-in-place'],
    workspace: one(cached),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/a/dist': null } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
    ],
  }),

  defineCase({
    id: 'outputs/edited-output-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'An output edited by hand is put back on the next run',
    why: 'The result of a run is the tree the inputs produce, not whatever is on disk. A hand edit left in an output ships bytes no build made, and the green run says nothing is wrong. Putting the cached bytes back, or rerunning, keeps outputs a function of inputs. An edit meant to last belongs in the sources.',
    from: ['stale-hit', 'restore-keep-rewrite'],
    workspace: one(cached),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/a/dist/out.txt': 'tampered\n' } },
      { run: 'build', expect: { exit: 0, files: { [out('a')]: 'a\n' } } },
    ],
  }),

  defineCase({
    id: 'outputs/stale-output-removed-on-rebuild',
    category: 'outputs',
    kind: 'correctness',
    title: 'A rebuild leaves no output the new inputs no longer produce',
    why: 'Outputs should be exactly what the current inputs produce. When a source is renamed or deleted, the file it used to produce must go too, or it ships from `dist` forever. Such leftovers are easy to miss: tests may even pass because they still import the old file. Clearing declared outputs before the rebuild avoids it.',
    from: ['outputs-clean', 'output-flow'],
    workspace: one(
      { command: 'mkdir -p dist && cp src/*.txt dist/', inputs: ['src/**'], outputs: ['dist/**'] },
      {
        'src/old.txt': 'x\n',
      },
    ),
    steps: [
      { run: 'build', expect: { exit: 0, files: { 'packages/a/dist/old.txt': 'x\n' } } },
      { write: { 'packages/a/src/old.txt': null, 'packages/a/src/new.txt': 'x\n' } },
      {
        run: 'build',
        expect: {
          exit: 0,
          files: { 'packages/a/dist/new.txt': 'x\n', 'packages/a/dist/old.txt': null },
        },
      },
    ],
  }),

  defineCase({
    id: 'outputs/stale-output-removed-on-restore',
    category: 'outputs',
    kind: 'correctness',
    title: 'Restoring an older entry leaves no file a later build added',
    why: 'Restoring a cache entry must give the tree that entry’s inputs produced, not that tree laid over the current one. Here a later build added `b.txt`; once its source is removed, the older entry comes back and `b.txt` must go. Leaving it mixes two builds in one directory, a tree no single run made, and it ships.',
    from: ['outputs-clean', 'restore-staging', 'stale-hit'],
    workspace: one(
      { command: 'mkdir -p dist && cp src/*.txt dist/', inputs: ['src/**'], outputs: ['dist/**'] },
      {
        'src/a.txt': 'a\n',
      },
    ),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/a/src/b.txt': 'b\n' } },
      { run: 'build', expect: { exit: 0, files: { 'packages/a/dist/b.txt': 'b\n' } } },
      { write: { 'packages/a/src/b.txt': null } },
      {
        run: 'build',
        expect: {
          exit: 0,
          files: { 'packages/a/dist/a.txt': 'a\n', 'packages/a/dist/b.txt': null },
        },
      },
    ],
  }),

  defineCase({
    id: 'outputs/stray-file-removed-on-restore',
    category: 'outputs',
    kind: 'correctness',
    title: 'A stray file dropped in an output directory is gone after a restore',
    why: 'Declared outputs are what the task wrote, so a restore leaves exactly that. A stray file dropped into `dist` by hand or by another tool would otherwise ship in the package or the deploy. Declaring `dist/**` makes the whole directory the task’s; a file meant to stay belongs outside it or behind a `!` entry.',
    from: ['stale-hit', 'output-dirs'],
    workspace: one(cached),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/a/dist/out.txt': null, 'packages/a/dist/stray.txt': 'stray' } },
      {
        run: 'build',
        expect: { exit: 0, files: { [out('a')]: 'a\n', 'packages/a/dist/stray.txt': null } },
      },
    ],
  }),

  defineCase({
    id: 'outputs/undeclared-not-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'Only declared outputs are restored',
    why: 'Only declared outputs are stored and restored. Here the command also writes `tmp/scratch.txt`, which no output names, so a replay must not create it. Restoring undeclared files means the cache guesses, and a guess brings temp files or local state from one machine onto another. Explicit config beats inference.',
    from: ['restore-declared-only', 'undeclared-writes'],
    workspace: one({
      command:
        'mkdir -p dist tmp && cat src/a.txt > dist/out.txt && echo scratch > tmp/scratch.txt',
      inputs: ['src/**'],
      outputs: ['dist/**'],
    }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/a/dist': null, 'packages/a/tmp': null } },
      {
        run: 'build',
        expect: {
          exit: 0,
          notRan: ['a#build'],
          files: { [out('a')]: 'a\n', 'packages/a/tmp/scratch.txt': null },
        },
      },
    ],
  }),

  defineCase({
    id: 'outputs/negated-output',
    category: 'outputs',
    kind: 'correctness',
    title: 'A `!` output pattern keeps that file out of the cache',
    why: 'A `!` entry says a path under an output directory is not the task’s output, often local state such as a log or a machine’s settings. It must not be stored, so it is neither shared through a remote cache nor restored on another machine. Restoring it brings back a stale or private file the user excluded on purpose.',
    from: ['negated-outputs'],
    workspace: one({
      command: 'mkdir -p dist && cat src/a.txt > dist/out.txt && echo local > dist/local.txt',
      inputs: ['src/**'],
      outputs: ['dist/**', '!dist/local.txt'],
    }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/a/dist': null } },
      {
        run: 'build',
        expect: {
          exit: 0,
          notRan: ['a#build'],
          files: { [out('a')]: 'a\n', 'packages/a/dist/local.txt': null },
        },
      },
    ],
  }),

  defineCase({
    id: 'outputs/executable-bit-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'An executable output comes back executable',
    why: 'File mode is part of what a build produces. A script or binary that comes back from the cache without its executable bit fails with permission denied, though the same command run fresh works. The failure shows only on cache hits, often only in CI, which makes it slow to trace.',
    from: ['restore-umask', 'artifact-roundtrip'],
    workspace: one({
      command:
        "mkdir -p dist && printf '#!/bin/sh\\necho ran\\n' > dist/bin.sh && chmod 755 dist/bin.sh",
      inputs: ['src/**'],
      outputs: ['dist/**'],
    }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/a/dist': null } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
      { check: { executable: ['packages/a/dist/bin.sh'] } },
    ],
  }),

  defineCase({
    id: 'outputs/symlink-restored',
    category: 'outputs',
    kind: 'correctness',
    title: 'A symlink output comes back as the same link',
    why: 'A symlink in the outputs is part of the tree, not a copy of its target. Restored as a regular file, `latest.txt` stops following `out.txt`, and anything that relies on the link breaks or reads old bytes after the next build. Restored as nothing, the path is simply missing. A hit must give the tree the command made.',
    from: ['output-links', 'restore-link-out'],
    workspace: one({
      command: 'mkdir -p dist && cat src/a.txt > dist/out.txt && ln -s out.txt dist/latest.txt',
      inputs: ['src/**'],
      outputs: ['dist/**'],
    }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/a/dist': null } },
      { run: 'build', expect: { exit: 0, notRan: ['a#build'] } },
      { check: { links: { 'packages/a/dist/latest.txt': 'out.txt' } } },
    ],
  }),

  defineCase({
    id: 'outputs/nested-and-binary',
    category: 'outputs',
    kind: 'correctness',
    title: 'Nested output directories and binary bytes restore intact',
    why: 'Outputs are bytes, not text. Images, wasm and compiled files hold null bytes, high bytes and carriage returns that must come back unchanged, and deep directories must keep their full paths. A restore that converts line endings, stops at a null byte or drops nested files gives a broken artifact under a green run.',
    from: ['artifact-roundtrip', 'png-intact.unsafe', 'archive-restore-fuzz'],
    workspace: one({
      command:
        "mkdir -p dist/a/b/c && printf '\\000\\001\\377\\r\\n' > dist/a/b/c/bin && cat src/a.txt > dist/out.txt",
      inputs: ['src/**'],
      outputs: ['dist/**'],
    }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/a/dist': null } },
      {
        run: 'build',
        expect: {
          exit: 0,
          files: { 'packages/a/dist/a/b/c/bin': '\u0000\u0001�\r\n', [out('a')]: 'a\n' },
        },
      },
    ],
  }),

  defineCase({
    id: 'outputs/dependency-restored-for-dependent',
    category: 'outputs',
    kind: 'correctness',
    title: 'A dependency’s deleted outputs are back before a rebuilding dependent reads them',
    why: 'When a dependant rebuilds, its dependencies’ outputs must be on disk first, even if those dependencies hit the cache. Here `lib/dist` was deleted and `app` changed; `app` reads `lib`’s output while it builds. Skipping `lib`’s restore because `lib` has nothing to do makes `app` fail, or build against files that are not there.',
    from: ['parity-turbo', 'uncached-upstream-key'],
    workspace: fourProjects(),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/lib/dist': null, 'packages/app/src/a.txt': 'APP\n' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['app#build'], files: { [out('app')]: 'lib\nlib\nui\nAPP\n' } },
      },
    ],
  }),

  defineCase({
    id: 'outputs/same-command-two-projects',
    category: 'outputs',
    kind: 'correctness',
    title: 'Two projects with the same command and the same sources keep their own outputs',
    why: 'The cache key must include which project a task belongs to. The same command over the same sources runs in a different directory and can produce different files, here each project’s own name. A key shared across projects restores one project’s bytes into the other: a wrong tree under a green run.',
    from: ['parity-nx', 'keyed-projects'],
    needs: ['filter'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command: 'mkdir -p dist && basename "$PWD" > dist/out.txt',
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'same\n' },
        },
        b: {
          tasks: {
            build: {
              command: 'mkdir -p dist && basename "$PWD" > dist/out.txt',
              inputs: ['src/**'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/a.txt': 'same\n' },
        },
      },
    },
    steps: [
      { run: 'build', projects: ['a'], expect: { exit: 0 } },
      { run: 'build', projects: ['b'], expect: { exit: 0, files: { [out('b')]: 'b\n' } } },
    ],
  }),

  defineCase({
    id: 'outputs/unlisted-not-clobbered',
    category: 'outputs',
    kind: 'correctness',
    title:
      'A replayed task that lists no outputs leaves a file it wrote, and the user then edited, alone',
    why: 'A task that declares no outputs restores nothing on a replay. Any default would guess what the task writes, and restoring a guessed file overwrites the user’s later edit with an old copy. Here the user changed `dist/report.txt` after the run, so a replay leaves it alone. Running the command again may rewrite it; that is what the command does.',
    from: ['restore-declared-only', 'undeclared-writes'],
    workspace: one({
      command: 'mkdir -p dist && echo report > dist/report.txt',
      inputs: ['src/**'],
    }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/a/dist/report.txt': 'mine\n' } },
      // Running the command again writes it fresh, which is right; a replay must not touch it.
      {
        run: 'build',
        expect: {
          exit: 0,
          ifReplayed: { task: 'a#build', files: { 'packages/a/dist/report.txt': 'mine\n' } },
        },
      },
    ],
  }),

  defineCase({
    id: 'outputs/unlisted-not-conjured',
    category: 'outputs',
    kind: 'correctness',
    title: 'A replayed task that lists no outputs does not bring back a file the user deleted',
    why: 'A task that declares no outputs restores nothing on a replay. The user deleted `report.txt`, and nothing declared it an output, so a replay that recreates it puts back bytes the user removed on purpose. A task that wants the file restored declares it, and then the cache knows the file is the task’s.',
    from: ['restore-declared-only', 'undeclared-writes'],
    workspace: one({ command: 'echo report > report.txt', inputs: ['src/**'] }),
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/a/report.txt': null } },
      {
        run: 'build',
        expect: {
          exit: 0,
          ifReplayed: { task: 'a#build', files: { 'packages/a/report.txt': null } },
        },
      },
    ],
  }),
]
