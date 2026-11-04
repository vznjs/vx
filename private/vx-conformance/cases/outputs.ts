import { defineCase } from '../src/spec.ts'
import { CONCAT, fourProjects, one, out } from './shapes.ts'

const cached = { command: CONCAT, inputs: ['src/**'], outputs: ['dist/**'] }

export default [
  defineCase({
    id: 'outputs/restored-on-hit',
    category: 'outputs',
    kind: 'correctness',
    title: 'Deleted outputs come back from the cache with the same bytes',
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
    why: 'The run’s result is the tree the inputs produce; a hand edit left in place ships bytes no build made.',
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
    why: 'A file a renamed source used to produce would otherwise ship from dist forever.',
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
    why: 'The restored tree must be the one that entry’s inputs produce.',
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
    why: 'Outputs are what the task wrote; a leftover file in dist ships in the package.',
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
    why: 'The command runs in each project’s own directory; one project’s bytes restored into the other is a wrong tree.',
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
]
