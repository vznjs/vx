// Outcomes drawn from Nix's functional tests (tests/functional) that no
// earlier case carried. The rest of that suite tests Nix's store,
// evaluator, flakes, fetchers, daemon or log, or is a Nix design choice
// (fixed-output early cutoff, read-only and normalised outputs, the
// build-or-cancel policy on a failure), and stays out.
import { defineCase, MEET, type TaskSpec } from '../src/spec.ts'

const A = 'packages/a'

/**
 * Appends `letter` to its dependencies' outputs. Marks itself up in the
 * case's scratch, waits up to 10 s for each of `peers` to be up, and writes
 * whether it saw them all: the scratch, not the project tree, as a build
 * dir of its own still reaches it.
 */
const fanned = (deps: string[], letter: string, peers: string[] = []): TaskSpec => {
  const upstream = deps.map((d) => `../${d}/dist/out.txt`).join(' ')
  const wait = peers.map((p) => `[ -e ../../${MEET}/up-${p} ]`).join(' && ')
  return {
    command: [
      'mkdir -p dist',
      upstream ? `cat ${upstream} > dist/out.txt` : ': > dist/out.txt',
      `printf ${letter} >> dist/out.txt`,
      ...(peers.length
        ? [
            `mkdir -p ../../${MEET}`,
            `touch ../../${MEET}/up-${letter}`,
            `i=0; while ! { ${wait}; } && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done`,
            `if ${wait}; then echo together; else echo alone; fi > dist/met.txt`,
          ]
        : []),
    ].join('; '),
    dependsOn: ['^build'],
    inputs: ['src/**'],
    outputs: ['dist/**'],
  }
}

const TWO_TREES = {
  command:
    'mkdir -p dist types && cat src/a.txt > dist/out.txt && echo "types of $(cat src/a.txt)" > types/out.d.txt',
  inputs: ['src/**'],
  outputs: ['dist/**', 'types/**'],
}

const READS_BOTH = {
  command:
    'mkdir -p dist && cat ../lib/dist/out.txt ../lib/types/out.d.txt src/a.txt > dist/out.txt',
  dependsOn: ['^build'],
  inputs: ['src/**'],
  outputs: ['dist/**'],
}

export default [
  defineCase({
    id: 'graph/fan-out-runs-at-once',
    category: 'graph',
    kind: 'efficiency',
    title:
      'The three tasks one task releases run at the same time, and the task over them reads all three',
    why: 'When a shared dependency finishes, every task waiting only on it is ready at that moment and can start together. Here each of the three waits a while for the other two to start, so run one at a time they each wait out the full delay. A runner that releases ready tasks one by one turns a wide graph into a chain, and the wall time becomes the sum of the branches instead of the longest one.',
    from: ['scheduler', 'run-concurrency'],
    workspace: {
      projects: {
        a: { tasks: { build: fanned([], 'a') }, files: { 'src/a.txt': 'a\n' } },
        b: {
          deps: ['a'],
          tasks: { build: fanned(['a'], 'b', ['b', 'c', 'd']) },
          files: { 'src/a.txt': 'b\n' },
        },
        c: {
          deps: ['a'],
          tasks: { build: fanned(['a'], 'c', ['b', 'c', 'd']) },
          files: { 'src/a.txt': 'c\n' },
        },
        d: {
          deps: ['a'],
          tasks: { build: fanned(['a'], 'd', ['b', 'c', 'd']) },
          files: { 'src/a.txt': 'd\n' },
        },
        e: {
          deps: ['b', 'c', 'd'],
          tasks: { build: fanned(['b', 'c', 'd'], 'e') },
          files: { 'src/a.txt': 'e\n' },
        },
      },
    },
    steps: [
      {
        run: 'build',
        projects: ['e'],
        expect: {
          exit: 0,
          ran: ['a#build', 'b#build', 'c#build', 'd#build', 'e#build'],
          order: [
            ['a#build', 'b#build'],
            ['a#build', 'c#build'],
            ['a#build', 'd#build'],
            ['b#build', 'e#build'],
            ['c#build', 'e#build'],
            ['d#build', 'e#build'],
          ],
          files: {
            'packages/b/dist/met.txt': 'together\n',
            'packages/c/dist/met.txt': 'together\n',
            'packages/d/dist/met.txt': 'together\n',
            'packages/e/dist/out.txt': 'abacade',
          },
        },
      },
    ],
  }),

  defineCase({
    id: 'outputs/one-of-two-trees-deleted-restored-for-dependant',
    category: 'outputs',
    kind: 'correctness',
    title:
      'Either of a dependency’s two output trees, deleted alone, is back before a rebuilding dependant reads it',
    why: 'A task that writes two trees, as a build writing `dist` and `types` does, is only present when both are. Deleting one and keeping the other is what a partial clean or a tool that prunes one directory leaves. A runner that sees one tree on disk and calls the dependency done lets the dependant build against a missing file, and fail or ship without it.',
    from: ['restore-in-place', 'uncached-upstream-key'],
    workspace: {
      projects: {
        lib: { tasks: { build: TWO_TREES }, files: { 'src/a.txt': 'lib\n' } },
        app: { deps: ['lib'], tasks: { build: READS_BOTH }, files: { 'src/a.txt': 'app\n' } },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { 'packages/lib/types': null, 'packages/app/src/a.txt': 'app2\n' } },
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['app#build'],
          files: {
            'packages/lib/types/out.d.txt': 'types of lib\n',
            'packages/app/dist/out.txt': 'lib\ntypes of lib\napp2\n',
          },
        },
      },
      { write: { 'packages/lib/dist': null, 'packages/app/src/a.txt': 'app3\n' } },
      {
        run: 'build',
        expect: {
          exit: 0,
          ran: ['app#build'],
          files: {
            'packages/lib/dist/out.txt': 'lib\n',
            'packages/app/dist/out.txt': 'lib\ntypes of lib\napp3\n',
          },
        },
      },
    ],
  }),

  defineCase({
    id: 'inputs/negated-suffix-keeps-bare-name',
    category: 'inputs',
    kind: 'correctness',
    title: 'A `!**/*.bak` input still keys a file named plain `bak`',
    why: 'An exclusion by suffix means files ending in `.bak`, not every name holding those letters. A file named plain `bak`, with no dot, is a source like any other, and the user never took it back. A tool that matches the suffix loosely replays a stale result when that file changes, under a green run.',
    from: ['parity-turbo-hashing', 'patterns-doc-drift'],
    workspace: {
      projects: {
        a: {
          tasks: {
            build: {
              command: 'mkdir -p dist && cat src/bak src/b > dist/out.txt',
              inputs: ['src/**', '!src/**/*.bak'],
              outputs: ['dist/**'],
            },
          },
          files: { 'src/b': 'b\n', 'src/bak': 'bak\n', 'src/bla.c.bak': 'old\n' },
        },
      },
    },
    steps: [
      { run: 'build', expect: { exit: 0 } },
      { write: { [`${A}/src/bak`]: 'BAK\n' } },
      {
        run: 'build',
        expect: { exit: 0, ran: ['a#build'], files: { [`${A}/dist/out.txt`]: 'BAK\nb\n' } },
      },
    ],
  }),
]
